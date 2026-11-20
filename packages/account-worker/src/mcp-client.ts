import { Client, SSEClientTransport, StreamableHTTPClientTransport, isJSONRPCErrorResponse, isJSONRPCResultResponse, type FetchLike, type JSONRPCMessage, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import type { DispatchOptions, JsonRpcResponse, SerializedTaskReference } from '@modelcontextprotocol/ext-tasks/client';
import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core';
import { MCP_ELICITATION_WINDOW_MS, MCP_TASK_FOLLOW_MS, RuntimeJsonSchema, RuntimeMcpElicitationRequestSchema, type RuntimeMcpElicit, type RuntimeMcpElicitationSource, type RuntimeMcpElicitResult, type RuntimeMcpTaskReference } from '@gitspace/protocol-runtime';
import { z } from 'zod';

type Json = z.infer<typeof RuntimeJsonSchema>;
const CLIENT_INFO = { name: 'gitspace-cloud', version: '1.0.0' };
/** What GitSpace's clients take from a server: forms and links to open, answered by the workspace (`elicit`). */
const CLIENT_CAPABILITIES = { elicitation: { form: {}, url: {} } };

/** A connected client to a person's server. `raw` sends a JSON-RPC request the SDK's own codecs would reject (MCP Tasks
 * on 2026-07-28: `tools/call` answered with a task, `tasks/*`) over the client's transport and matches its response;
 * null on HTTP+SSE, which predates 2026-07-28. */
export type McpConnection = { client: Client; raw: ((request: JsonValue, options?: DispatchOptions) => Promise<JsonRpcResponse>) | null };

/**
 * A cloud agent's connection to a person's network MCP server, opened for one call. Streamable HTTP probes
 * `server/discover` and speaks 2026-07-28 to a server that answers it, else falls back to the 2025 `initialize`
 * handshake; HTTP+SSE predates the 2026-07-28 revision, so it always opens with `initialize`. Redirects are followed
 * only within the server's origin (the transports' default `same-origin` policy), so headers and tokens never leave it.
 * The client declares form and URL elicitation, and hands `input_required` results back to the caller (ext-tasks drives
 * them, `callMcpTool`). `fetch` replaces the global fetch (tests serve a server in-process).
 */
export async function connectMcp(input: { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; authProvider?: OAuthClientProvider; timeout: number; signal?: AbortSignal; fetch?: FetchLike }): Promise<McpConnection> {
  const headers = input.headers ?? {};
  const send = input.fetch ?? fetch;
  const options = { redirectPolicy: 'same-origin' as const, requestInit: { headers }, ...(input.authProvider ? { authProvider: input.authProvider } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) };
  const transport = input.type === 'http'
    ? new StreamableHTTPClientTransport(new URL(input.url), options)
    : new SSEClientTransport(new URL(input.url), { ...options, eventSourceInit: { fetch: (url, init) => send(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }) } });
  const client = new Client(CLIENT_INFO, { capabilities: CLIENT_CAPABILITIES, inputRequired: { autoFulfill: false }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator(), ...(input.type === 'http' ? { versionNegotiation: { mode: 'auto' } } : {}) });
  try {
    await client.connect(transport, { timeout: input.timeout, ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    await client.close();
    throw error;
  }
  if (input.type !== 'http') return { client, raw: null };
  // Raw requests carry ids of their own; their responses are taken from the transport before the client sees them.
  const pending = new Map<string, (message: JSONRPCMessage) => void>();
  const deliver = transport.onmessage;
  transport.onmessage = message => {
    const resolve = 'id' in message && typeof message.id === 'string' ? pending.get(message.id) : undefined;
    if (resolve) resolve(message);
    else deliver?.(message);
  };
  async function raw(request: JsonValue, dispatch?: DispatchOptions): Promise<JsonRpcResponse> {
    const envelope = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() }).parse(request);
    const id = `gitspace-raw:${crypto.randomUUID()}`;
    const answered = Promise.withResolvers<JSONRPCMessage>();
    pending.set(id, answered.resolve);
    const timeout = AbortSignal.timeout(dispatch?.context?.requestTimeoutMs ?? input.timeout);
    const signal = dispatch?.signal ? AbortSignal.any([dispatch.signal, timeout]) : timeout;
    const abort = () => answered.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await transport.send({ jsonrpc: '2.0', id, method: envelope.method, ...(envelope.params ? { params: envelope.params } : {}) });
      const message = await answered.promise;
      if (isJSONRPCErrorResponse(message)) return { kind: 'error', error: { code: message.error.code, message: message.error.message, ...(message.error.data === undefined ? {} : { data: RuntimeJsonSchema.parse(message.error.data) }) } };
      if (isJSONRPCResultResponse(message)) return { kind: 'result', result: RuntimeJsonSchema.parse(message.result) };
      throw new Error('The server answered a request with something other than a response');
    } finally {
      pending.delete(id);
      signal.removeEventListener('abort', abort);
    }
  }
  return { client, raw };
}

/** The server identity a connection status records (`serverVersion`): its name and version as it reports them, and the
 * protocol revision and era the connection negotiated. */
export function mcpServerIdentity(client: Client): string {
  const server = client.getServerVersion();
  return `${server ? `${server.name} ${server.version}` : 'unnamed server'} · MCP ${client.getNegotiatedProtocolVersion() ?? 'unknown'} (${client.getProtocolEra() ?? 'legacy'} era)`;
}

/** How a tool call ends: with the server's result, or handed off while the server's task runs on (`reference`). */
export type McpCallOutcome = { kind: 'result'; result: Json } | { kind: 'handoff'; reference: SerializedTaskReference; status: string | null };

/**
 * Calls tool `name` on `connection` (or resumes the server's task `task`) through ext-tasks, which drives every form of a
 * server asking for input: a 2025 `elicitation/create` and a 2026-07-28 `input_required` retry continue the call
 * (request-scoped), an `input_required` task is answered with `tasks/update` (task-scoped). Each request goes to
 * `elicit` (null: decline), the workspace's side (`RuntimeMcpElicit`); a request GitSpace cannot show (a link that is not
 * https, a form outside MCP's restricted schema) is declined. Unanswered in time, a request-scoped one is answered
 * `cancel`, and a task-scoped one hands the task off. A task still running after MCP_TASK_FOLLOW_MS, with no request
 * waiting on an answer, is handed off too. `endpoint` names the connection the task belongs to (`createTaskSessionEndpointId`).
 * ext-tasks loads here, on a call's path, never at module scope.
 */
export async function callMcpTool(connection: McpConnection, input: { endpoint: Record<string, string>; name: string; arguments: Record<string, Json>; task: RuntimeMcpTaskReference | null; timeout: number; signal?: AbortSignal; source: RuntimeMcpElicitationSource; elicit: RuntimeMcpElicit | null }): Promise<McpCallOutcome> {
  // Loaded on a call's path: Worker startup stays near Cloudflare's 1 s limit, and most requests never call a tool.
  const [{ createApplicationInputHandler, createTaskSessionEndpointId, createTaskSessionFromClient, resultFromTaskOutcome }, { taskId }] = await Promise.all([import('@modelcontextprotocol/ext-tasks/client'), import('@modelcontextprotocol/ext-tasks/core')]);
  const endpointId = await createTaskSessionEndpointId('gitspace-mcp', input.endpoint);
  const task: SerializedTaskReference | null = !input.task ? null : input.task.generation === 'v1'
    ? { endpointId: input.task.endpointId, generation: 'v1', taskId: taskId(input.task.taskId), originalOperation: input.task.originalOperation }
    : { endpointId: input.task.endpointId, generation: 'v2', taskId: taskId(input.task.taskId), originalOperation: input.task.originalOperation };
  const handoff = Promise.withResolvers<void>();
  // Requests for input waiting on the workspace now: a task is handed off on time only when none is.
  let asking = 0;
  let idle = Promise.withResolvers<void>();
  idle.resolve();
  const errors: Error[] = [];
  const onInputRequest = createApplicationInputHandler<void>({
    async elicitation(request, context) {
      const params = request.params;
      const mode = params.mode === 'url' ? 'url' : 'form';
      const parsed = RuntimeMcpElicitationRequestSchema.safeParse(mode === 'url'
        ? { mode, message: params.message, url: params.url, ...(typeof params.elicitationId === 'string' ? { elicitationId: params.elicitationId } : {}) }
        : { mode, message: params.message, requestedSchema: params.requestedSchema });
      if (!parsed.success || !input.elicit) return { action: 'decline' };
      if (asking++ === 0) idle = Promise.withResolvers();
      let answer: RuntimeMcpElicitResult | null;
      try { answer = await input.elicit({ request: parsed.data, source: input.source, scope: context.scope, taskId: context.taskId ?? null, inputId: context.inputId ?? null }); }
      finally { if (--asking === 0) idle.resolve(); }
      if (answer) return answer;
      if (context.scope === 'request') return { action: 'cancel' };
      // The task waits on a person: it is handed off, which ends this request's input lifetime unanswered.
      handoff.resolve();
      throw new Error('The task is handed off until a person answers');
    },
    sampling() { throw new Error('GitSpace does not provide sampling'); },
    roots() { throw new Error('GitSpace does not provide roots'); },
  });
  const modern = connection.raw && connection.client.getProtocolEra() === 'modern' ? { rawDispatch: connection.raw, v2RequestFraming: { protocolVersion: connection.client.getNegotiatedProtocolVersion() ?? '2026-07-28', clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPABILITIES } } : {};
  const session = createTaskSessionFromClient<void>(connection.client, { endpointId, onInputRequest, onError: error => { errors.push(error); }, ...modern });
  try {
    // A request-scoped request holds the call while it waits on its question.
    const wire = { requestTimeoutMs: input.timeout + MCP_ELICITATION_WINDOW_MS, ...(input.signal ? { signal: input.signal } : {}) };
    const execution = task ? await session.resumeTask(task, wire) : await session.callTool(input.name, input.arguments, wire);
    if (execution.kind === 'immediate') return { kind: 'result', result: RuntimeJsonSchema.parse(resultFromTaskOutcome(await execution.result())) };
    let status: string | null = null;
    const stop = new AbortController();
    const settled = execution.settle({ signal: stop.signal, close: false, onEvent(event) { if (event.type === 'task') status = event.task.statusMessage ?? null; } });
    type Next = 'settled' | 'handoff' | 'follow' | 'idle';
    const ended = settled.then((): Next => 'settled');
    const handed = handoff.promise.then((): Next => 'handoff');
    const followed = Promise.withResolvers<Next>();
    const timer = setTimeout(() => followed.resolve('follow'), MCP_TASK_FOLLOW_MS);
    let next = await Promise.race([ended, handed, followed.promise]);
    clearTimeout(timer);
    // A task that runs past MCP_TASK_FOLLOW_MS is handed off once no request waits on an answer.
    while (next === 'follow') next = await Promise.race([ended, handed, idle.promise.then((): Next => asking === 0 ? 'idle' : 'follow')]);
    if (next === 'settled') return { kind: 'result', result: RuntimeJsonSchema.parse(resultFromTaskOutcome((await settled).outcome)) };
    stop.abort();
    let reference: SerializedTaskReference | undefined;
    await execution.handoff(value => { reference = value; });
    if (!reference) throw new Error('The server\'s task could not be handed off');
    return { kind: 'handoff', reference, status };
  } finally {
    await session.close();
    for (const error of errors) console.warn(JSON.stringify({ event: 'mcp_input_failed', error: error.message }));
  }
}
