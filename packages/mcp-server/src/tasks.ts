import { CLIENT_CAPABILITIES_META_KEY, ProtocolError, ProtocolErrorCode, inputRequired, inputResponse, type CallToolResult, type Server, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { decodeApiKey, deviceProtocolBase64 } from '@gitspace/protocol/device-grant';
import { RuntimeRunSchema, type RuntimeRun } from '@gitspace/protocol-runtime/session-controls';
import { SECURE_INPUT_CHOICES, type RuntimeSecureInputKind } from '@gitspace/protocol-runtime/secure-input';
import { MCP_ELICITATION_CHOICES, RuntimeMcpElicitationContentSchema, mcpElicitationIssues, type RuntimeMcpElicitationQuestion } from '@gitspace/protocol-runtime/mcp-elicitation';

/** The MCP Tasks extension (https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks). */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** Where a task's result names the GitSpace run it reports. */
export const RUN_META_KEY = 'sh.gitspace/run';
/** A task handle verifies for this long after its task was created; after that `tasks/*` answers that it expired. */
export const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_WORKING_MS = 5_000;
/** Polling while a person answers in GitSpace: people answer in minutes, not seconds. */
const POLL_PERSON_MS = 15_000;

/** The tool calls that start agent work a task can follow: a prompt, and `runtime.submit`. */
export type RunStart = 'runtime.session' | 'runtime.submit';
type Execute = (path: string, raw: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;
export interface GitSpaceTasks {
  /** Whether this tool call starts a run a task follows. */
  starts(path: string, raw: unknown): path is RunStart;
  /** Starts the run, as the ordinary call would, and returns its task (`CreateTaskResult`). */
  start(path: RunStart, raw: unknown, signal: AbortSignal): Promise<CallToolResult>;
  /** Registers `tasks/get`, `tasks/update` and `tasks/cancel` on a 2026-07-28 request's server. */
  register(server: Server): void;
}

/**
 * What a task id carries, signed with the caller's MCP access key so only that caller's later requests verify it: the
 * account and device it belongs to, the workspace conversation, and the request id of the input the run started with.
 * The workspace's submissions stay the record of the run (`runtime.session` command `run`); the handle only names it.
 * `cursor`: the runtime cursor a `runtime.submit` start answered, repeated in its completed result.
 */
const HandleSchema = z.object({
  v: z.literal(1), user: z.string(), device: z.string(), tool: z.enum(['runtime.session', 'runtime.submit']),
  projectId: z.string(), workspaceId: z.string(), conversationId: z.string(), requestId: z.string(), createdAt: z.iso.datetime(), cursor: z.number().int().nonnegative().optional(),
}).strict();
type Handle = z.infer<typeof HandleSchema>;
const StartSchema = z.object({ projectId: z.string(), workspaceId: z.string() });
const PromptSchema = z.object({ command: z.looseObject({ type: z.literal('prompt'), requestId: z.string().optional() }) });
const SubmittedSchema = z.object({ result: z.object({ cursor: z.number().int().nonnegative(), conversationId: z.string() }) });
const PromptedSchema = z.object({ result: z.object({ control: z.object({ sessionId: z.string() }) }) });
const RunReadSchema = z.object({ result: z.object({ run: RuntimeRunSchema, control: z.object({ todos: z.array(z.object({ tasks: z.array(z.object({ content: z.string(), status: z.string() })) })) }) }) });
/** The form a plain question asks through: one of its choices, or a written answer. */
const AnswerSchema = z.object({ choice: z.string().optional(), answer: z.string().optional() });
const TaskIdSchema = z.object({ taskId: z.string().min(1).max(4096) }).loose();
const EmptySchema = z.object({}).loose();
const NOT_FOUND = 'Failed to retrieve task: Task not found';

/** The part of a request's declared client capabilities Tasks reads. */
const DeclaredSchema = z.object({ extensions: z.record(z.string(), z.unknown()).optional(), elicitation: z.unknown().optional() });
/** The capabilities a 2026-07-28 request declares in its `_meta` envelope (the SDK's published `RequestMetaEnvelope`
 * type lost its keys in bundling, so the value is parsed). */
export function declaredCapabilities(ctx: ServerContext): z.infer<typeof DeclaredSchema> | undefined {
  const parsed = DeclaredSchema.safeParse(ctx.mcpReq.envelope && Reflect.get(ctx.mcpReq.envelope, CLIENT_CAPABILITIES_META_KEY));
  return parsed.success ? parsed.data : undefined;
}
/** The elicitation modes a request's client declared (`elicitation.form`, `elicitation.url`); a bare `elicitation: {}`
 * is form, as the 2025-06-18 revision declared it. */
const ElicitationSchema = z.object({ form: z.unknown().optional(), url: z.unknown().optional() });
function elicitationModes(ctx: ServerContext): { form: boolean; url: boolean } {
  const modes = ElicitationSchema.safeParse(declaredCapabilities(ctx)?.elicitation);
  if (!modes.success) return { form: false, url: false };
  const url = modes.data.url !== undefined;
  return { form: modes.data.form !== undefined || !url, url };
}
/** What a secure-input request asks for, as its elicitation and status name it. */
const SECURE_INPUT_KIND_NAMES: Record<RuntimeSecureInputKind, string> = { password: 'password', otp: 'one-time code', text: 'text' };

export function createGitSpaceTasks(options: { key: string; capabilities: readonly string[]; execute: Execute }): GitSpaceTasks {
  const caller = decodeApiKey(options.key);
  const encoder = new TextEncoder();
  const signingKey = crypto.subtle.importKey('raw', encoder.encode(options.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  async function mint(handle: Handle): Promise<string> {
    const payload = deviceProtocolBase64.encode(encoder.encode(JSON.stringify(handle)));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey, encoder.encode(payload)));
    return `${payload}.${deviceProtocolBase64.encode(signature)}`;
  }
  /** The handle a task id names, when this caller minted it: the signature verifies only under the key that minted it,
   * so another caller's id, or a forged one, is not found. */
  async function verify(taskId: string): Promise<Handle> {
    const [payload, signature, extra] = taskId.split('.');
    let handle: Handle | undefined;
    try {
      if (payload && signature && extra === undefined && await crypto.subtle.verify('HMAC', await signingKey, new Uint8Array(deviceProtocolBase64.decode(signature)), encoder.encode(payload))) {
        handle = HandleSchema.parse(JSON.parse(new TextDecoder().decode(deviceProtocolBase64.decode(payload))));
      }
    } catch { handle = undefined; }
    if (!handle) throw new ProtocolError(ProtocolErrorCode.InvalidParams, NOT_FOUND);
    if (Date.now() > Date.parse(handle.createdAt) + TASK_TTL_MS) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task has expired');
    return handle;
  }
  /** `tasks/*` from a client that did not declare the extension on that request is refused (`-32021`). */
  function requireTasks(ctx: ServerContext): void {
    if (declaredCapabilities(ctx)?.extensions?.[TASKS_EXTENSION] === undefined) {
      throw new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, 'Missing required client capability', { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
    }
  }
  async function readRun(handle: Handle, signal: AbortSignal) {
    let value: Record<string, unknown>;
    try {
      value = await options.execute('runtime.session', { projectId: handle.projectId, workspaceId: handle.workspaceId, conversationId: handle.conversationId, command: { type: 'run', requestId: handle.requestId } }, signal);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'GitSpace could not read the run this task follows');
    }
    const read = RunReadSchema.parse(value);
    if (read.result.run.state === 'missing') throw new ProtocolError(ProtocolErrorCode.InvalidParams, NOT_FOUND);
    return { value, run: read.result.run, working: read.result.control.todos.flatMap(list => list.tasks).find(task => task.status === 'in_progress')?.content };
  }
  /** Whether this caller may answer `run`'s question through a form: a plain question, a grant that decides as the
   * person, and a client that takes form elicitations on this request. A secure-input request never is: its value is
   * typed only on GitSpace's secure-input page. An `mcp-elicitation` question follows `passesThrough` instead. */
  function answerable(run: RuntimeRun, ctx: ServerContext): boolean {
    return run.question?.kind === 'ask' && options.capabilities.includes('operator.decide') && elicitationModes(ctx).form;
  }
  /** Whether an `mcp-elicitation` question goes to this client as its own elicitation: a grant with operator.decide
   * (answering decides as the person; GitSpace's RPC refuses `answerAsk` without it) and, for a form that does not look
   * like it asks for a secret, a client that takes form elicitations; for a link, one that takes URL elicitations. A
   * secret-looking form is answered only by a person in GitSpace. */
  function passesThrough(card: RuntimeMcpElicitationQuestion, ctx: ServerContext): boolean {
    if (!options.capabilities.includes('operator.decide')) return false;
    return card.request.mode === 'url' ? elicitationModes(ctx).url : !card.secretLooking && elicitationModes(ctx).form;
  }
  function inputRequest(question: NonNullable<RuntimeRun['question']>) {
    const properties = {
      ...(question.choices.length > 0 ? { choice: { type: 'string', title: 'Choice', enum: question.choices } } : {}),
      answer: { type: 'string', title: 'Written answer', description: question.choices.length > 0 ? 'Instead of, or beside, a choice.' : 'Your answer.' },
    };
    return { method: 'elicitation/create', params: { mode: 'form', message: question.prompt, requestedSchema: { type: 'object', properties, required: question.choices.length > 0 ? [] : ['answer'] } } };
  }
  /** Answers question `questionId` as an MCP client (`answerAsk`, `answeredBy: 'mcp-client'`). One answered or closed in
   * the meantime takes no other answer; the next tasks/get shows what followed. */
  async function answerAsk(handle: Handle, questionId: string, selectedOptions: string[], customInput: string | null, signal: AbortSignal): Promise<void> {
    try {
      await options.execute('runtime.session', { projectId: handle.projectId, workspaceId: handle.workspaceId, conversationId: handle.conversationId, command: { type: 'answerAsk', id: questionId, answers: [{ id: questionId, selectedOptions, customInput }], answeredBy: 'mcp-client' } }, signal);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      const latest = await readRun(handle, signal);
      if (latest.run.state !== 'waiting' || latest.run.question?.id !== questionId) return;
      throw new ProtocolError(ProtocolErrorCode.InternalError, `GitSpace could not answer question ${questionId}`);
    }
  }

  /** The `DetailedTask` for `handle`'s run (GITSPACE-MCP-CAPABILITY-MATRIX.md, MCP Tasks). */
  async function detailed(taskId: string, handle: Handle, ctx: ServerContext): Promise<Record<string, unknown>> {
    const { value, run, working } = await readRun(handle, ctx.mcpReq.signal);
    const task = { taskId, createdAt: handle.createdAt, lastUpdatedAt: new Date().toISOString(), ttlMs: TASK_TTL_MS, pollIntervalMs: POLL_WORKING_MS };
    switch (run.state) {
      case 'queued': return { ...task, status: 'working', statusMessage: 'Queued: the agent takes it when the conversation\'s current turn ends.' };
      case 'running': return { ...task, status: 'working', statusMessage: working ? `The agent is working: ${working}` : 'The agent is working.' };
      case 'waiting': {
        const question = run.question;
        if (!question) throw new ProtocolError(ProtocolErrorCode.InternalError, 'GitSpace reported a waiting run without its question');
        const secure = question.kind === 'secure-input' ? question.secureInput : undefined;
        if (secure) {
          // The page takes the value from a signed-in person; a client only ever gets its link, never a form.
          const asked = `the ${SECURE_INPUT_KIND_NAMES[secure.kind]} for ${secure.origin}`;
          if (elicitationModes(ctx).url) {
            const message = `${secure.purpose}: enter ${asked} in GitSpace (secure input; the value never reaches the agent or this client)`;
            return { ...task, pollIntervalMs: POLL_PERSON_MS, status: 'input_required', statusMessage: `The agent asks for ${asked}: ${secure.purpose}`, inputRequests: { [question.id]: inputRequired.elicitUrl({ message, url: secure.url }) } };
          }
          return { ...task, pollIntervalMs: POLL_PERSON_MS, status: 'working', statusMessage: `Waiting in GitSpace for a person to enter ${asked} (secure-input request ${question.id}: ${secure.purpose}) at ${secure.url}; this client did not declare URL elicitation.` };
        }
        const card = question.kind === 'mcp-elicitation' ? question.mcpElicitation : undefined;
        if (card) {
          // The server's own request, passed through unchanged but for the message naming who asks.
          const prefix = `${card.connection} (an MCP server in workspace ${card.workspace}) asks`;
          if (passesThrough(card, ctx)) {
            const request = card.request.mode === 'url'
              ? inputRequired.elicitUrl({ message: `${prefix}: ${card.request.message} (this page belongs to ${card.connection}, not GitSpace)`, url: card.request.url })
              : { method: 'elicitation/create', params: { mode: 'form', message: `${prefix}: ${card.request.message}`, requestedSchema: card.request.requestedSchema } };
            return { ...task, pollIntervalMs: POLL_PERSON_MS, status: 'input_required', statusMessage: `${prefix}: ${card.request.message}`, inputRequests: { [question.id]: request } };
          }
          const at = card.request.mode === 'url' ? ` at ${card.request.url}` : '';
          const why = card.request.mode === 'form' && card.secretLooking ? 'it looks like it asks for a secret, so only a person answers it in GitSpace'
            : !options.capabilities.includes('operator.decide') ? 'this MCP access is not granted operator.decide'
            : card.request.mode === 'url' ? 'this client did not declare URL elicitation' : 'this client did not declare form elicitation';
          return { ...task, pollIntervalMs: POLL_PERSON_MS, status: 'working', statusMessage: `Waiting in GitSpace for a person to answer ${card.connection}'s question "${card.request.message}" (question ${question.id})${at}; ${why}.` };
        }
        if (answerable(run, ctx)) return { ...task, pollIntervalMs: POLL_PERSON_MS, status: 'input_required', statusMessage: `The agent asks: ${question.prompt}`, inputRequests: { [question.id]: inputRequest(question) } };
        const why = question.kind !== 'ask' ? 'only a person answers it in GitSpace' : !options.capabilities.includes('operator.decide') ? 'this MCP access is not granted operator.decide' : 'this client did not declare form elicitation';
        return { ...task, pollIntervalMs: POLL_PERSON_MS, status: 'working', statusMessage: `Waiting in GitSpace for a person to answer "${question.prompt}" (question ${question.id}); ${why}.` };
      }
      case 'stopped': return { ...task, status: 'cancelled', statusMessage: `Stopped: ${run.text ?? 'a person stopped it'}.` };
      case 'failed': {
        const result: CallToolResult = { isError: true, content: [{ type: 'text', text: `The agent's turn failed: ${run.text ?? 'no reason was recorded'}.` }] };
        return { ...task, status: 'completed', statusMessage: 'The agent\'s turn failed.', result };
      }
      case 'finished': {
        const reference = { projectId: handle.projectId, workspaceId: handle.workspaceId, conversationId: run.conversationId, requestId: handle.requestId, finalRequestId: run.requestId, state: run.state };
        // The tool's own result shape (its outputSchema): the run read itself for a prompt, the start's answer for a submit.
        const structured = handle.tool === 'runtime.session' ? value : { result: { accepted: true, cursor: handle.cursor ?? 0, conversationId: handle.conversationId } };
        const result: CallToolResult = { content: [{ type: 'text', text: run.text ?? 'The agent finished without a reply.' }], structuredContent: structured, _meta: { [RUN_META_KEY]: reference } };
        return { ...task, status: 'completed', statusMessage: 'The agent finished.', result };
      }
      case 'missing': throw new ProtocolError(ProtocolErrorCode.InvalidParams, NOT_FOUND);
    }
  }

  return {
    starts(path, raw): path is RunStart {
      return path === 'runtime.submit' || (path === 'runtime.session' && PromptSchema.safeParse(raw).success);
    },
    async start(path, raw, signal) {
      const identity = StartSchema.parse(raw);
      if (!caller) throw new Error('The MCP access key cannot be read');
      let requestId: string;
      let input: unknown = raw;
      if (path === 'runtime.session') {
        const prompt = PromptSchema.parse(raw);
        // A prompt without a request id gets one, so the run it starts can be read back.
        requestId = prompt.command.requestId ?? `mcp-task:${crypto.randomUUID()}`;
        input = { ...z.looseObject({}).parse(raw), command: { ...prompt.command, requestId } };
      } else requestId = z.object({ requestId: z.string() }).parse(raw).requestId;
      const value = await options.execute(path, input, signal);
      const createdAt = new Date().toISOString();
      const started = path === 'runtime.session'
        ? { conversationId: PromptedSchema.parse(value).result.control.sessionId }
        : SubmittedSchema.parse(value).result;
      const handle: Handle = { v: 1, user: caller.userId, device: caller.deviceId, tool: path, projectId: identity.projectId, workspaceId: identity.workspaceId, requestId, createdAt, ...started };
      // `content` is required of a tools/call result's type; the task handle's fields ride beside it.
      return { content: [], resultType: 'task', taskId: await mint(handle), status: 'working', statusMessage: 'GitSpace took the input; the agent runs it.', createdAt, lastUpdatedAt: createdAt, ttlMs: TASK_TTL_MS, pollIntervalMs: POLL_WORKING_MS };
    },
    register(server) {
      server.setRequestHandler('tasks/get', { params: TaskIdSchema, result: EmptySchema }, async (params, ctx) => {
        requireTasks(ctx);
        return detailed(params.taskId, await verify(params.taskId), ctx);
      });
      // `inputResponses` arrive lifted out of the params (`ctx.mcpReq.inputResponses`).
      server.setRequestHandler('tasks/update', { params: TaskIdSchema, result: EmptySchema }, async (params, ctx) => {
        requireTasks(ctx);
        const handle = await verify(params.taskId);
        const { run } = await readRun(handle, ctx.mcpReq.signal);
        const question = run.state === 'waiting' ? run.question : null;
        if (!question) return {};
        // Only the question the task waits on takes an answer; responses to any other key are ignored.
        if (question.kind === 'secure-input') {
          // The value arrives only through the page, so an accept does nothing and no content is read; a decline or cancel
          // of the link declines the request.
          const response = elicitationModes(ctx).url && question.secureInput ? inputResponse(ctx.mcpReq.inputResponses, question.id) : null;
          if (response?.kind !== 'elicit' || response.action === 'accept' || !options.capabilities.includes('operator.decide')) return {};
          await answerAsk(handle, question.id, [SECURE_INPUT_CHOICES.decline], null, ctx.mcpReq.signal);
          return {};
        }
        const card = question.kind === 'mcp-elicitation' ? question.mcpElicitation : undefined;
        if (card) {
          // Answered only where it was passed through: never a secret-looking form, never a link to a client without URL elicitation.
          const response = passesThrough(card, ctx) ? inputResponse(ctx.mcpReq.inputResponses, question.id) : null;
          if (response?.kind !== 'elicit') return {};
          if (response.action === 'decline') await answerAsk(handle, question.id, [MCP_ELICITATION_CHOICES.decline], null, ctx.mcpReq.signal);
          else if (response.action === 'cancel') await answerAsk(handle, question.id, [MCP_ELICITATION_CHOICES.cancel], null, ctx.mcpReq.signal);
          else if (card.request.mode === 'url') await answerAsk(handle, question.id, [MCP_ELICITATION_CHOICES.done], null, ctx.mcpReq.signal);
          else {
            const content = RuntimeMcpElicitationContentSchema.safeParse(response.content ?? {});
            const issues = content.success ? mcpElicitationIssues(card.request.requestedSchema, content.data) : ['the content is not an object of strings, numbers, booleans or string lists'];
            if (!content.success || issues.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `The answer to question ${question.id} does not fit ${card.connection}'s form: ${issues.join('; ')}`);
            await answerAsk(handle, question.id, [], JSON.stringify(content.data), ctx.mcpReq.signal);
          }
          return {};
        }
        const response = answerable(run, ctx) ? inputResponse(ctx.mcpReq.inputResponses, question.id) : null;
        if (response?.kind !== 'elicit' || response.action !== 'accept') return {};
        const parsed = AnswerSchema.safeParse(response.content ?? {});
        const choice = parsed.success ? parsed.data.choice : undefined;
        const written = parsed.success ? parsed.data.answer?.trim() : undefined;
        if (!parsed.success || (choice !== undefined && !question.choices.includes(choice)) || (choice === undefined && !written)) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `An answer to question ${question.id} picks one of its choices (${question.choices.join(', ') || 'none'}) or writes an answer`);
        }
        await answerAsk(handle, question.id, choice === undefined ? [] : [choice], written || null, ctx.mcpReq.signal);
        return {};
      });
      server.setRequestHandler('tasks/cancel', { params: TaskIdSchema, result: EmptySchema }, async (params, ctx) => {
        requireTasks(ctx);
        const handle = await verify(params.taskId);
        const { run } = await readRun(handle, ctx.mcpReq.signal);
        // A run that ended is left alone: stopping now would stop whatever the conversation runs next.
        if (run.state !== 'queued' && run.state !== 'running' && run.state !== 'waiting') return {};
        try {
          await options.execute('runtime.cancel', { projectId: handle.projectId, workspaceId: handle.workspaceId, conversationId: handle.conversationId }, ctx.mcpReq.signal);
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          throw new ProtocolError(ProtocolErrorCode.InternalError, 'GitSpace could not stop the run this task follows');
        }
        return {};
      });
    },
  };
}
