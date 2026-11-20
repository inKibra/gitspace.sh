import { describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';
import { contractDigest, ok } from 'result-rpc';
import { createFetchHandler, serverRpc } from 'result-rpc/server';
import { z } from 'zod';
import { deviceProtocolBase64, encodeApiKey } from '@gitspace/protocol/device-grant';
import { gitspaceContract, runtimeCancelContract, runtimeSessionContract, runtimeSubmitContract, type GitSpaceRpcContext } from '@gitspace/protocol/rpc-contract';
import type { RuntimeRun, SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { createGitSpaceMcpHandler } from '../src/index.js';

const TASKS = 'io.modelcontextprotocol/tasks';
const keyFor = (userId: string) => encodeApiKey({
  version: 2, userId, deviceId: crypto.randomUUID(), signingPrivateKey: deviceProtocolBase64.encode(new Uint8Array(32).fill(9)),
  rpcUrl: 'https://account.test/rpc', enrollUrl: 'https://account.test/v1/devices/enroll',
});
const capabilities = ['rpc.read', 'rpc.write', 'session.prompt', 'operator.decide'];
const identity = { projectId: 'project', workspaceId: 'workspace' };
const question = { id: 'q-cache', conversationId: 'conversation', kind: 'ask' as const, prompt: 'Which cache?', choices: ['Workers KV', 'Durable Object'], answer: null };
const SECURE_URL = 'https://owner.gitspace.test/secure-input/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
/** An ask_secure_input request as its question shows it: the password for accounts.example.com on the user's Chrome. */
const secureQuestion = {
  id: 'q-secret', conversationId: 'conversation', kind: 'secure-input' as const, prompt: 'Sign in to GitHub as octocat', choices: ['Decline'], answer: null,
  secureInput: {
    requestId: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde', url: SECURE_URL, source: 'chrome' as const, pairingId: crypto.randomUUID(), browser: 'Work Chrome',
    groupId: crypto.randomUUID(), targetId: 'tab-7', title: 'Sign in', workspace: 'workspace', origin: 'https://accounts.example.com', selector: '#password', kind: 'password' as const,
    purpose: 'Sign in to GitHub as octocat', expiresAt: new Date(Date.now() + 900_000).toISOString(), callId: 'call-1', askedAt: new Date().toISOString(),
  },
};
const SERVER_URL = 'https://billing.example.com/authorize?session=abc';
const FORM = { type: 'object' as const, properties: { region: { type: 'string' as const, title: 'Region', enum: ['eu', 'us'] }, seats: { type: 'integer' as const, minimum: 1 } }, required: ['region'] };
/** An `mcp-elicitation` question: the Billing connection's server, called by the agent in workspace "workspace", asks `request`. */
const mcpQuestion = (id: string, request: { mode: 'form'; message: string; requestedSchema: typeof FORM } | { mode: 'url'; message: string; url: string }, secretLooking = false) => ({
  id, conversationId: 'conversation', kind: 'mcp-elicitation' as const, prompt: `Billing asks: ${request.message}`, choices: request.mode === 'url' ? ['Done', 'Decline', 'Cancel'] : ['Decline', 'Cancel'], answer: null,
  mcpElicitation: {
    connectionId: 'conn-billing', connection: 'Billing', server: 'billing-server 1.0', workspace: 'workspace', tool: 'create_invoice', request, host: request.mode === 'url' ? 'billing.example.com' : null,
    secretLooking, scope: 'request' as const, taskId: null, callId: 'call-9', askedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(),
  },
});
const formQuestion = mcpQuestion('q-form', { mode: 'form', message: 'Which region and how many seats?', requestedSchema: FORM });
const PREFIX = 'Billing (an MCP server in workspace workspace) asks';

/** An MCP endpoint as the account worker serves it. */
interface McpEndpoint { fetch(request: Request): Promise<Response> }
/** The account's runtime over a fake workspace (`workspace()`): its fetch, the RPC calls it took, and its runs. */
interface FakeWorkspace { fetch: typeof globalThis.fetch; calls: Array<{ path: string; input: unknown }>; runs: Map<string, RuntimeRun>; move(started: string, next: Partial<RuntimeRun>): void }

/** The account's runtime procedures over a fake workspace: each input taken with a request id is one run, keyed by that
 * id, whose state a test moves the way the workspace would. Prompts and submits sent again with a taken request id add
 * nothing. */
function workspace(): FakeWorkspace {
  const runs = new Map<string, RuntimeRun>();
  const calls: Array<{ path: string; input: unknown }> = [];
  const control: SessionControlView = {
    sessionId: 'conversation', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false,
    context: null, cost: 0, todos: [{ name: 'main', tasks: [{ content: 'Read the cache code', status: 'in_progress', blocker: null }] }],
    queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null,
  };
  const take = (requestId: string) => { if (!runs.has(requestId)) runs.set(requestId, { conversationId: 'conversation', requestId, state: 'running', text: null, question: null }); };
  const server = serverRpc.context<GitSpaceRpcContext>();
  const session = server.implement(runtimeSessionContract).handler(async ({ input }) => {
    calls.push({ path: 'runtime.session', input });
    const { command } = input;
    if (command.type === 'prompt') take(command.requestId ?? crypto.randomUUID());
    if (command.type === 'answerAsk') {
      const asked = [...runs.entries()].find(([, item]) => item.question?.id === command.id);
      if (asked) runs.set(asked[0], { ...asked[1], requestId: `question-closed:${command.id}`, state: 'running', question: null });
    }
    if (command.type === 'run') return ok({ control, run: runs.get(command.requestId) ?? { conversationId: 'conversation', requestId: command.requestId, state: 'missing', text: null, question: null } });
    return ok({ control });
  });
  const submit = server.implement(runtimeSubmitContract).handler(async ({ input }) => {
    calls.push({ path: 'runtime.submit', input });
    take(input.requestId);
    return ok({ accepted: true as const, cursor: 7, conversationId: 'conversation' });
  });
  const cancel = server.implement(runtimeCancelContract).handler(async ({ input }) => {
    calls.push({ path: 'runtime.cancel', input });
    for (const [started, run] of runs) if (run.state !== 'finished') runs.set(started, { ...run, state: 'stopped', text: 'it was stopped before it finished' });
    return ok({ accepted: true as const, cursor: 8 });
  });
  const rpc = createFetchHandler({ router: server.router({ runtime: { session, submit, cancel } }), endpoint: '/rpc', contractVersion: contractDigest(gitspaceContract), createContext: () => ({}) });
  const fetch: typeof globalThis.fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => rpc(new Request(input, init)), { preconnect: globalThis.fetch.preconnect });
  const move = (started: string, next: Partial<RuntimeRun>) => {
    const run = runs.get(started);
    if (!run) throw new Error(`No run ${started}`);
    runs.set(started, { ...run, ...next });
  };
  return { fetch, calls, runs, move };
}

function mcp(backend: FakeWorkspace, key = keyFor('owner'), granted = capabilities): McpEndpoint {
  return createGitSpaceMcpHandler({ key, capabilities: granted, scope: { kind: 'user' }, fetch: backend.fetch });
}

async function connect(handler: McpEndpoint, options: ClientOptions = {}) {
  const client = new Client({ name: 'gitspace-mcp-tasks-test', version: '1.0.0' }, options);
  await client.connect(new StreamableHTTPClientTransport(new URL('https://account.test/mcp'), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  return client;
}

/** A 2026-07-28 client that declares the Tasks extension, and the elicitation capability `elicitation` (form unless
 * given; none when null). */
function tasksClient(handler: McpEndpoint, elicitation: { form?: Record<string, never>; url?: Record<string, never> } | null = { form: {} }) {
  return connect(handler, { versionNegotiation: { mode: 'auto' }, capabilities: { extensions: { [TASKS]: {} }, ...(elicitation ? { elicitation } : {}) } });
}
/** The `answerAsk` commands the workspace took. */
const answers = (backend: FakeWorkspace) => backend.calls.flatMap(call => {
  const parsed = z.object({ command: z.looseObject({ type: z.literal('answerAsk') }) }).safeParse(call.input);
  return parsed.success ? [parsed.data.command] : [];
});

const TaskSchema = z.looseObject({ taskId: z.string(), status: z.string(), statusMessage: z.string().optional(), createdAt: z.string(), lastUpdatedAt: z.string(), ttlMs: z.number().nullable(), pollIntervalMs: z.number().optional() });
const getTask = (client: Client, taskId: string) => client.request({ method: 'tasks/get', params: { taskId } }, TaskSchema);

/**
 * `tools/call` as a 2026-07-28 Tasks client sends it, on the wire: the SDK's `Client` takes only complete results, and a
 * task handle (`resultType: "task"`) is the extension's.
 */
async function startTask(handler: McpEndpoint, name: string, args: Record<string, unknown>, declared: Record<string, unknown> = { extensions: { [TASKS]: {} } }) {
  const response = await handler.fetch(new Request('https://account.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw-tasks-client', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': declared,
    } } }),
  }));
  expect(response.status).toBe(200);
  return z.object({ result: z.looseObject({}) }).parse(await response.json()).result;
}

describe('GitSpace MCP server on SDK v2', () => {
  test('a 2025-era client lists and calls tools as before, and a prompt answers its ordinary result', async () => {
    const backend = workspace();
    const client = await connect(mcp(backend));
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getServerCapabilities()?.extensions).toBeUndefined();
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('gitspace_runtime_session');
      const result = await client.callTool({ name: 'gitspace_runtime_session', arguments: { ...identity, command: { type: 'prompt', text: 'Pick a cache' } } });
      expect(result.structuredContent).toMatchObject({ result: { control: { sessionId: 'conversation' } } });
      // Tasks are 2026-07-28's: a 2025-era connection has no tasks methods.
      expect(await client.request({ method: 'tasks/get', params: { taskId: 'any' } }, TaskSchema).catch((failure: unknown) => failure)).toMatchObject({ code: -32601 });
    } finally { await client.close(); }
  });

  test('a 2026-era client negotiates 2026-07-28, sees Tasks advertised, and without declaring Tasks gets the ordinary result', async () => {
    const backend = workspace();
    const client = await connect(mcp(backend), { versionNegotiation: { mode: 'auto' } });
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerCapabilities()?.extensions).toEqual({ [TASKS]: {} });
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('gitspace_runtime_submit');
      const result = await client.callTool({ name: 'gitspace_runtime_submit', arguments: { ...identity, requestId: 'plain', text: 'Pick a cache' } });
      expect(result.structuredContent).toEqual({ result: { accepted: true, cursor: 7, conversationId: 'conversation' } });
      // A call that starts no run is ordinary for a Tasks client too.
      const raw = await startTask(mcp(backend), 'gitspace_runtime_session', { ...identity, command: { type: 'control' } });
      expect(raw).toMatchObject({ resultType: 'complete', structuredContent: { result: { control: { sessionId: 'conversation' } } } });
    } finally { await client.close(); }
  });

  test('a Tasks client follows a prompt to its question, answers it, and reads the result; the task survives a new connection', async () => {
    const backend = workspace();
    const key = keyFor('owner');
    const handler = mcp(backend, key);
    const started = await startTask(handler, 'gitspace_runtime_session', { ...identity, command: { type: 'prompt', text: 'Pick a cache' } });
    expect(started).toMatchObject({ resultType: 'task', status: 'working', ttlMs: expect.any(Number), pollIntervalMs: expect.any(Number) });
    const taskId = z.string().parse(started.taskId);
    // The prompt went to the workspace with a request id the task names.
    const prompt = z.object({ command: z.object({ requestId: z.string() }) }).parse(backend.calls.find(call => call.path === 'runtime.session')?.input);
    const requestId = prompt.command.requestId;

    const client = await tasksClient(handler);
    try {
      expect(await getTask(client, taskId)).toMatchObject({ taskId, status: 'working', statusMessage: 'The agent is working: Read the cache code', createdAt: started.createdAt });

      backend.move(requestId, { state: 'waiting', text: 'Pick one:', question });
      const asking = await getTask(client, taskId);
      expect(asking).toMatchObject({ status: 'input_required', inputRequests: { [question.id]: { method: 'elicitation/create', params: { mode: 'form', message: 'Which cache?', requestedSchema: { properties: { choice: { enum: question.choices } } } } } } });

      // A response to any other key is ignored; the one the task waits on answers its question as an MCP client.
      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { 'q-other': { action: 'accept', content: { choice: 'Workers KV' } } } } }, z.looseObject({}));
      expect(backend.calls.some(call => call.path === 'runtime.session' && z.object({ command: z.object({ type: z.literal('answerAsk') }) }).safeParse(call.input).success)).toBe(false);
      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [question.id]: { action: 'accept', content: { choice: 'Durable Object' } } } } }, z.looseObject({}));
      const answer = backend.calls.map(call => z.object({ command: z.object({ type: z.literal('answerAsk') }).loose() }).safeParse(call.input)).find(parsed => parsed.success);
      expect(answer?.data?.command).toEqual({ type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Durable Object'], customInput: null }], answeredBy: 'mcp-client' });
      expect(await getTask(client, taskId)).toMatchObject({ status: 'working' });

      backend.move(requestId, { state: 'finished', text: 'Durable Object it is.' });
      const done = await getTask(client, taskId);
      expect(done).toMatchObject({ status: 'completed', result: {
        content: [{ type: 'text', text: 'Durable Object it is.' }],
        structuredContent: { result: { control: { sessionId: 'conversation' } } },
        _meta: { 'sh.gitspace/run': { ...identity, conversationId: 'conversation', requestId, finalRequestId: `question-closed:${question.id}`, state: 'finished' } },
      } });
    } finally { await client.close(); }

    // Another connection, another transport, the same caller: the task reads back the same.
    const again = await tasksClient(mcp(backend, key));
    try { expect(await getTask(again, taskId)).toMatchObject({ taskId, status: 'completed', result: { content: [{ type: 'text', text: 'Durable Object it is.' }] } }); }
    finally { await again.close(); }
  });

  test('cancel stops the run through the interrupt path, and another caller cannot read, update or cancel the task', async () => {
    const backend = workspace();
    const key = keyFor('owner');
    const owner = mcp(backend, key);
    const started = await startTask(owner, 'gitspace_runtime_submit', { ...identity, requestId: 'deploy-1', text: 'Ship it' });
    const taskId = z.string().parse(started.taskId);
    const stranger = await tasksClient(mcp(backend, keyFor('stranger')));
    try {
      for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel'] as const) {
        const error = await stranger.request({ method, params: { taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}) } }, z.looseObject({})).catch((failure: unknown) => failure);
        expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('Task not found') });
      }
    } finally { await stranger.close(); }
    expect(backend.calls.filter(call => call.path === 'runtime.cancel')).toEqual([]);

    const client = await tasksClient(mcp(backend, key));
    try {
      await client.request({ method: 'tasks/cancel', params: { taskId } }, z.looseObject({}));
      expect(backend.calls.filter(call => call.path === 'runtime.cancel').map(call => call.input)).toEqual([{ ...identity, conversationId: 'conversation' }]);
      expect(await getTask(client, taskId)).toMatchObject({ status: 'cancelled', statusMessage: 'Stopped: it was stopped before it finished.' });
      // A run that ended is not stopped again: that would stop whatever the conversation runs next.
      await client.request({ method: 'tasks/cancel', params: { taskId } }, z.looseObject({}));
      expect(backend.calls.filter(call => call.path === 'runtime.cancel')).toHaveLength(1);
    } finally { await client.close(); }
  });

  test('a start sent again with the same request id follows the same run; a client without elicitation hears the question waits in GitSpace', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const first = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'retry-1', text: 'Pick a cache' });
    const second = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'retry-1', text: 'Pick a cache' });
    expect(backend.runs.size).toBe(1);
    backend.move('retry-1', { state: 'waiting', question });
    const client = await tasksClient(handler, null);
    try {
      for (const started of [first, second]) {
        expect(await getTask(client, z.string().parse(started.taskId))).toMatchObject({ status: 'working', statusMessage: 'Waiting in GitSpace for a person to answer "Which cache?" (question q-cache); this client did not declare form elicitation.' });
      }
    } finally { await client.close(); }
  });

  test('a plain question goes to a client that declared form elicitation (a bare `{}` is form), not to one that declared only URL elicitation', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const started = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'cache-1', text: 'Pick a cache' });
    const taskId = z.string().parse(started.taskId);
    backend.move('cache-1', { state: 'waiting', question });
    const bare = await tasksClient(handler, {});
    try { expect(await getTask(bare, taskId)).toMatchObject({ status: 'input_required', inputRequests: { [question.id]: { params: { mode: 'form' } } } }); }
    finally { await bare.close(); }
    const linkOnly = await tasksClient(handler, { url: {} });
    try { expect(await getTask(linkOnly, taskId)).toMatchObject({ status: 'working', statusMessage: 'Waiting in GitSpace for a person to answer "Which cache?" (question q-cache); this client did not declare form elicitation.' }); }
    finally { await linkOnly.close(); }
  });

  test('a client that declared URL elicitation gets a secure-input request as its page link; declining it declines the request, and accepting forwards nothing', async () => {
    const backend = workspace();
    const key = keyFor('owner');
    const handler = mcp(backend, key);
    const started = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'sign-in', text: 'Sign in to GitHub' });
    const taskId = z.string().parse(started.taskId);
    backend.move('sign-in', { state: 'waiting', question: secureQuestion });
    const client = await tasksClient(handler, { form: {}, url: {} });
    try {
      const asking = await getTask(client, taskId);
      expect(asking).toMatchObject({ status: 'input_required', inputRequests: { [secureQuestion.id]: { method: 'elicitation/create', params: {
        mode: 'url', url: SECURE_URL,
        message: 'Sign in to GitHub as octocat: enter the password for https://accounts.example.com in GitSpace (secure input; the value never reaches the agent or this client)',
      } } } });
      expect(JSON.stringify(asking)).not.toContain('requestedSchema');

      // The value arrives only through the page: an accept carrying content reaches no runtime call.
      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secureQuestion.id]: { action: 'accept', content: { password: 'hunter2-secret' } } } } }, z.looseObject({}));
      expect(JSON.stringify(backend.calls)).not.toContain('hunter2-secret');
      expect(answers(backend)).toEqual([]);
      expect(await getTask(client, taskId)).toMatchObject({ status: 'input_required' });

      // A grant without operator.decide declines nothing.
      const undecided = await tasksClient(mcp(backend, key, capabilities.filter(capability => capability !== 'operator.decide')), { url: {} });
      try { await undecided.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secureQuestion.id]: { action: 'cancel' } } } }, z.looseObject({})); }
      finally { await undecided.close(); }
      expect(answers(backend)).toEqual([]);

      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secureQuestion.id]: { action: 'decline' } } } }, z.looseObject({}));
      expect(answers(backend)).toEqual([{ type: 'answerAsk', id: secureQuestion.id, answers: [{ id: secureQuestion.id, selectedOptions: ['Decline'], customInput: null }], answeredBy: 'mcp-client' }]);
      expect(await getTask(client, taskId)).toMatchObject({ status: 'working' });
    } finally { await client.close(); }
  });

  test('a client without URL elicitation hears a secure-input request waits in GitSpace with its link, and never gets a form for it', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const started = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'sign-in', text: 'Sign in to GitHub' });
    const taskId = z.string().parse(started.taskId);
    backend.move('sign-in', { state: 'waiting', question: secureQuestion });
    // The grant has operator.decide, and each client takes form elicitations (a bare `{}` is form) or none.
    for (const elicitation of [{ form: {} }, {}, null]) {
      const client = await tasksClient(handler, elicitation);
      try {
        const waiting = await getTask(client, taskId);
        expect(waiting).toMatchObject({ status: 'working', statusMessage: `Waiting in GitSpace for a person to enter the password for https://accounts.example.com (secure-input request q-secret: Sign in to GitHub as octocat) at ${SECURE_URL}; this client did not declare URL elicitation.` });
        expect(waiting.inputRequests).toBeUndefined();
        // Without the link it was never shown, a form answer or a decline changes nothing.
        await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secureQuestion.id]: { action: 'accept', content: { choice: 'Decline' } } } } }, z.looseObject({}));
        await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secureQuestion.id]: { action: 'decline' } } } }, z.looseObject({}));
        expect(answers(backend)).toEqual([]);
      } finally { await client.close(); }
    }
  });

  test('a non-secret server form passes through to a deciding form client; a valid answer is sent as its JSON, and the task follows the retry to the final reply', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const started = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'invoice', text: 'Make an invoice' });
    const taskId = z.string().parse(started.taskId);
    backend.move('invoice', { state: 'waiting', question: formQuestion });
    const client = await tasksClient(handler);
    try {
      expect(await getTask(client, taskId)).toMatchObject({ status: 'input_required', inputRequests: { [formQuestion.id]: { method: 'elicitation/create', params: { mode: 'form', message: `${PREFIX}: Which region and how many seats?`, requestedSchema: FORM } } } });

      // Content outside the server's form is refused and nothing reaches the workspace.
      const error = await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [formQuestion.id]: { action: 'accept', content: { seats: 3, color: 'red' } } } } }, z.looseObject({})).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('region is required') });
      expect(answers(backend)).toEqual([]);

      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [formQuestion.id]: { action: 'accept', content: { region: 'eu', seats: 3 } } } } }, z.looseObject({}));
      expect(answers(backend)).toEqual([{ type: 'answerAsk', id: formQuestion.id, answers: [{ id: formQuestion.id, selectedOptions: [], customInput: JSON.stringify({ region: 'eu', seats: 3 }) }], answeredBy: 'mcp-client' }]);
      // The host retries the server call: the run reads running, then finishes with the agent's reply.
      expect(await getTask(client, taskId)).toMatchObject({ status: 'working' });
      backend.move('invoice', { state: 'finished', text: 'Invoice created in eu for 3 seats.' });
      expect(await getTask(client, taskId)).toMatchObject({ status: 'completed', result: { content: [{ type: 'text', text: 'Invoice created in eu for 3 seats.' }] } });
    } finally { await client.close(); }
  });

  test('a secret-looking server form stays in GitSpace even for a deciding form client, and an answer to it is ignored', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const started = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'key', text: 'Connect billing' });
    const taskId = z.string().parse(started.taskId);
    const secret = mcpQuestion('q-key', { mode: 'form', message: 'Your API key?', requestedSchema: FORM }, true);
    backend.move('key', { state: 'waiting', question: secret });
    const client = await tasksClient(handler, { form: {}, url: {} });
    try {
      const waiting = await getTask(client, taskId);
      expect(waiting).toMatchObject({ status: 'working', statusMessage: 'Waiting in GitSpace for a person to answer Billing\'s question "Your API key?" (question q-key); it looks like it asks for a secret, so only a person answers it in GitSpace.' });
      expect(waiting.inputRequests).toBeUndefined();
      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secret.id]: { action: 'accept', content: { region: 'eu' } } } } }, z.looseObject({}));
      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [secret.id]: { action: 'decline' } } } }, z.looseObject({}));
      expect(answers(backend)).toEqual([]);
    } finally { await client.close(); }
  });

  test('a server link passes through as the server\'s own URL to a URL client; accept is Done and decline is Decline', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const link = mcpQuestion('q-link', { mode: 'url', message: 'Authorize billing', url: SERVER_URL });
    const client = await tasksClient(handler, { url: {} });
    try {
      for (const [requestId, action, choice] of [['link-1', 'accept', 'Done'], ['link-2', 'decline', 'Decline']] as const) {
        const taskId = z.string().parse((await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId, text: 'Bill' })).taskId);
        backend.move(requestId, { state: 'waiting', question: { ...link, id: `${link.id}-${requestId}` } });
        const id = `${link.id}-${requestId}`;
        expect(await getTask(client, taskId)).toMatchObject({ status: 'input_required', inputRequests: { [id]: { method: 'elicitation/create', params: { mode: 'url', url: SERVER_URL, message: `${PREFIX}: Authorize billing (this page belongs to Billing, not GitSpace)` } } } });
        await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [id]: { action } } } }, z.looseObject({}));
        expect(answers(backend).at(-1)).toEqual({ type: 'answerAsk', id, answers: [{ id, selectedOptions: [choice], customInput: null }], answeredBy: 'mcp-client' });
      }
    } finally { await client.close(); }
  });

  test('a server question waits in GitSpace, named, for a client without decide, without form elicitation, or without URL elicitation', async () => {
    const backend = workspace();
    const key = keyFor('owner');
    const started = await startTask(mcp(backend, key), 'gitspace_runtime_submit', { ...identity, requestId: 'invoice', text: 'Make an invoice' });
    const taskId = z.string().parse(started.taskId);
    backend.move('invoice', { state: 'waiting', question: formQuestion });
    const cases = [
      { handler: mcp(backend, key, capabilities.filter(capability => capability !== 'operator.decide')), elicitation: { form: {} }, why: 'this MCP access is not granted operator.decide' },
      { handler: mcp(backend, key), elicitation: { url: {} }, why: 'this client did not declare form elicitation' },
    ];
    for (const { handler, elicitation, why } of cases) {
      const client = await tasksClient(handler, elicitation);
      try {
        expect(await getTask(client, taskId)).toMatchObject({ status: 'working', statusMessage: `Waiting in GitSpace for a person to answer Billing's question "Which region and how many seats?" (question q-form); ${why}.` });
        await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { [formQuestion.id]: { action: 'accept', content: { region: 'eu' } } } } }, z.looseObject({}));
        expect(answers(backend)).toEqual([]);
      } finally { await client.close(); }
    }
    backend.move('invoice', { question: mcpQuestion('q-link', { mode: 'url', message: 'Authorize billing', url: SERVER_URL }) });
    const client = await tasksClient(mcp(backend, key));
    try {
      expect(await getTask(client, taskId)).toMatchObject({ status: 'working', statusMessage: `Waiting in GitSpace for a person to answer Billing's question "Authorize billing" (question q-link) at ${SERVER_URL}; this client did not declare URL elicitation.` });
      await client.request({ method: 'tasks/update', params: { taskId, inputResponses: { 'q-link': { action: 'accept' } } } }, z.looseObject({}));
      expect(answers(backend)).toEqual([]);
    } finally { await client.close(); }
  });

  test('tasks methods from a client that did not declare Tasks are refused as a missing capability', async () => {
    const backend = workspace();
    const handler = mcp(backend);
    const started = await startTask(handler, 'gitspace_runtime_submit', { ...identity, requestId: 'r', text: 'Go' });
    const client = await connect(handler, { versionNegotiation: { mode: 'auto' } });
    try {
      const error = await getTask(client, z.string().parse(started.taskId)).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: -32021 });
    } finally { await client.close(); }
  });
});
