import { DurableObject } from 'cloudflare:workers';
import { createModels, createAssistantMessageEventStream, type Model, type AssistantMessage, type StreamFunction } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { RuntimeAttachResultSchema, RuntimeIdentitySchema, RuntimeJobObservationSchema, RuntimeJsonSchema, RuntimeMachineIdSchema, RuntimeReceiptTransportSchema, RuntimeToolDispatchSchema, canonicalJson, receiptDigest, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { DurableJobsDoc } from '../../runtime-core/src/jobs.js';
import { WorkspaceDoc, TodosDoc } from '../../runtime-core/src/documents.js';
import { SessionControlsDoc } from '../../runtime-core/src/session-controls.js';
import type { OperationalServices } from '../../runtime-core/src/tasks.js';
import { createWorkspaceRuntime } from '../src/runtime.js';
import { z } from 'zod';

const identity = RuntimeIdentitySchema.parse({ projectId: 'execution-proof', workspaceId: 'execution-proof' });
const reference = { provider: 'fixture', modelId: 'execution' };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model: Model<'fixture'> = { provider: reference.provider, id: reference.modelId, name: 'Execution proof', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost, reasoning: false, contextWindow: 8192, maxTokens: 1024 };
const unsupported = async (): Promise<never> => { throw new Error('Unexpected external execution-proof operation'); };
let finishForeground: (() => void) | null = null;
const stream: StreamFunction = (_model, context, options) => {
  const output = createAssistantMessageEventStream();
  const last = context.messages.findLast(message => message.role !== 'system');
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
  const notification = (() => {
    if (last?.role !== 'user' || !text.includes('{')) return null;
    try { return RuntimeJobObservationSchema.safeParse(JSON.parse(text.slice(text.indexOf('{')))); }
    catch { return null; }
  })();
  let content: AssistantMessage['content'];
  if (last?.role === 'user' && text === 'run background job') content = [{ type: 'toolCall', id: 'reused-provider-call', name: 'bash', arguments: { background: true, command: 'printf "launch\\n" >> launches; printf "job-live-log-marker\\n"; while [ ! -f release ]; do sleep 0.05; done; printf "finished\\n"' } }];
  else if (last?.role === 'user' && text === 'spawn three blocked children') content = [1, 2, 3].map(index => ({ type: 'toolCall', id: `spawn-child-${index}`, name: 'agents', arguments: { op: 'spawn', role: 'fixture', name: `Child${index}`, task: 'hold child', background: true } }));
  else if (last?.role === 'user' && text === 'hold child') content = [{ type: 'toolCall', id: 'child-ready', name: 'agents', arguments: { op: 'send', to: 'parent', message: 'Ready; waiting for Stop.' } }];
  else if (last?.role === 'user' && text === 'foreground probe') content = [{ type: 'toolCall', id: crypto.randomUUID(), name: 'todo', arguments: { items: [{ id: 'probe', text: 'Foreground remains available', status: 'completed' }] } }];
  else if (last?.role === 'user' && text === 'read large tool result') content = [{ type: 'toolCall', id: 'large-read', name: 'read', arguments: { path: 'large-output' } }];
  else if (last?.role === 'user' && text.startsWith('job-control:')) content = [{ type: 'toolCall', id: crypto.randomUUID(), name: 'bash', arguments: JSON.parse(text.slice('job-control:'.length)) }];
  else if (notification?.success) content = [{ type: 'text', text: `Consumed job receipt ${notification.data.job.jobId}` }];
  else content = [{ type: 'text', text: 'execution fixture foreground complete' }];
  const usesTool = content.some(part => part.type === 'toolCall');
  const message: AssistantMessage = { role: 'assistant', api: 'fixture', provider: 'fixture', model: reference.modelId, content, stopReason: usesTool ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } } };
  output.push({ type: 'start', partial: message });
  if (last?.role === 'user' && text === 'hold child') {
    const offered = context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded ?? [] : []);
    const names = offered.map(tool => tool.name);
    if (!names.includes('agents') || names.some(name => !['read', 'find', 'grep', 'ast_grep', 'history_search', 'history_read', 'web_search', 'todo', 'web_browser', 'agents'].includes(name))) throw new Error(`Child received invalid tool registration: ${JSON.stringify(names)}`);
    const messaging = offered.findLast(tool => tool.name === 'agents');
    if (!messaging || JSON.stringify(messaging.parameters).includes('"spawn"')) throw new Error('Child was offered nested spawn');
    const browser = offered.findLast(tool => tool.name === 'web_browser');
    if (!browser || JSON.stringify(browser.parameters).includes('"relay"')) throw new Error('Child was offered the user relay browser');
  }
  if (last?.role === 'toolResult' && last.toolCallId === 'child-ready') {
    if (last.isError) throw new Error(`Child messaging failed: ${text}`);
    const finish = () => {
      options?.signal?.removeEventListener('abort', finish);
      const stopped = { ...message, stopReason: 'aborted' as const };
      output.push({ type: 'error', reason: 'aborted', error: stopped });
      output.end(stopped);
    };
    options?.signal?.addEventListener('abort', finish, { once: true });
    if (options?.signal?.aborted) finish();
    return output;
  }
  if (last?.role === 'user' && text === 'hold foreground') {
    const finish = () => {
      finishForeground = null;
      options?.signal?.removeEventListener('abort', finish);
      output.push({ type: 'done', reason: 'stop', message });
      output.end(message);
    };
    finishForeground = finish;
    options?.signal?.addEventListener('abort', finish, { once: true });
    return output;
  }
  output.push({ type: 'done', reason: usesTool ? 'toolUse' : 'stop', message });
  output.end(message);
  return output;
};
type Environment = { EXECUTOR: { fetch(request: Request): Promise<Response> } };

/** Real cloud SQLite + Pi tasks. Only provider text and the machine network binding are fixture-controlled. */
export class ExecutionSmoke extends DurableObject<Environment> {
  private readonly runtime;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof_dispatches(id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    const models = createModels();
    models.setProvider({ id: 'fixture', name: 'Local execution proof', auth: { apiKey: { name: 'Fixture only', async resolve() { return { auth: { apiKey: 'fixture-only' } }; } } }, getModels: () => [model], stream, streamSimple: stream });
    const saved = (id: string) => {
      const row = ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM proof_dispatches WHERE id=?', id).toArray()[0];
      return row ? RuntimeToolDispatchSchema.parse(JSON.parse(row.payload)) : null;
    };
    const save = (dispatch: RuntimeToolDispatch) => {
      const prior = saved(dispatch.attemptId);
      if (prior && canonicalJson(prior) !== canonicalJson(dispatch)) throw new Error('Proof dispatch identity changed');
      ctx.storage.sql.exec('INSERT INTO proof_dispatches(id,payload) VALUES(?,?) ON CONFLICT(id) DO NOTHING', dispatch.attemptId, JSON.stringify(dispatch));
    };
    const operations: OperationalServices = {
      jobScope: () => identity,
      observeProcess: unsupported,
      stopProcess: unsupported,
      controlJob: async input => {
        const original = saved(input.attemptId);
        if (!original) throw new Error('Job has no admitted executor');
        if (input.op === 'cancel') throw new Error('Cancellation uses the admitted receipt control');
        const id = `logs:${crypto.randomUUID()}`;
        return (await this.runtime).attachments.execute({ ...original, requestId: id, attemptId: id, args: { op: 'logs', attemptId: original.attemptId, ...(input.lines !== undefined ? { lines: input.lines } : {}), ...(input.head !== undefined ? { head: input.head } : {}), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) }, deadlineAt: new Date(Date.now() + 5_000).toISOString() }, AbortSignal.timeout(5_000));
      },
      wakeAt: timestamp => ctx.storage.setAlarm(timestamp),
      reconcile: async id => { const dispatch = saved(id); return dispatch ? (await this.runtime).attachments.reconcile(dispatch) : null; },
      cancel: async id => { const dispatch = saved(id); if (dispatch) await (await this.runtime).attachments.cancel(dispatch); },
      execute: async input => {
        if (input.kind !== 'Job') throw new Error('Unexpected operational kind');
        const grant = RuntimeAttachResultSchema.parse(await ctx.storage.get('proof-grant'));
        const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, ...identity, conversationId: input.conversationId, taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId, args: input.args, deadlineAt: input.deadlineAt, replay: input.replay, tool: 'bash', machineId: grant.attachment.machineId, attachmentId: grant.attachment.attachmentId, generation: grant.attachment.generation });
        save(dispatch);
        return (await this.runtime).attachments.execute(dispatch, input.signal);
      },
    };
    this.runtime = createWorkspaceRuntime({
      storage: ctx.storage, identity, models, model: reference,
      code: { readFile: unsupported, writeSnapshot: unsupported, mergeSnapshot: unsupported, listSnapshotPaths: unsupported, listSnapshotEntries: unsupported, readBlob: unsupported },
      lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: unsupported,
      tools: { prepareBrowser: unsupported, approvalDefault: async () => 'yolo', preflight: async () => {}, invoke: async input => {
        if (input.tool === 'agents') return (await this.runtime).invokeConversationTool(input);
        if (input.tool !== 'read') return unsupported();
        const grant = RuntimeAttachResultSchema.parse(await ctx.storage.get('proof-grant'));
        const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, ...identity, conversationId: input.conversationId, taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId, args: input.args, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: input.replay, tool: input.tool, machineId: grant.attachment.machineId, attachmentId: grant.attachment.attachmentId, generation: grant.attachment.generation });
        save(dispatch);
        return (await this.runtime).attachments.execute(dispatch, input.signal ?? AbortSignal.timeout(30_000));
      }, instructions: async () => 'Offline execution proof', authorizeCronTool: unsupported },
      operations, retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit',
      onReport: error => console.error('EXECUTION_PROOF_REPORT', String(error)),
      admitInference: async input => { await ctx.storage.put(`admission:${input.requestId}`, input.conversationId); return reference; },
      bindInferenceConversation: async (conversationId, _signal, _submissions, requests) => { for (const requestId of requests) if (await ctx.storage.get(`admission:${requestId}`) !== conversationId) throw new Error('Missing durable inference admission'); },
      session: { catalog: async () => ({ models: [{ provider: 'fixture', id: reference.modelId, name: 'Proof', contextWindow: 8192 }], roles: [{ id: 'fixture', label: 'Proof child', provider: 'fixture', model: reference.modelId, thinking: null, current: false }] }), reload: unsupported },
      qa: { list: async () => [], act: unsupported },
      attachments: {
        // The isolated fixture does not exercise vault wrapping; actual receipt encryption/authentication remains enabled.
        seal: async secret => secret, open: async secret => secret,
        dispatch: async input => {
          const response = await env.EXECUTOR.fetch(new Request(`http://executor${input.path}`, { method: 'POST', body: input.body, headers: { 'x-gitspace-execution-signature': input.signature }, signal: input.signal }));
          if (!response.ok) throw new Error(`Executor rejected request: ${response.status} ${await response.text()}`);
          return RuntimeReceiptTransportSchema.parse(await response.json());
        },
      },
      waitUntil: promise => ctx.waitUntil(promise), schedule: timestamp => ctx.storage.setAlarm(timestamp),
    });
  }
  async alarm() { await (await this.runtime).wake(); }
  async fetch(request: Request): Promise<Response> {
    try {
      const runtime = await this.runtime;
      const root = await runtime.harness.root(BACKGROUND_CONTEXT);
      const path = new URL(request.url).pathname;
      if (path === '/root') return Response.json({ conversationId: String(root.id) });
      if (path === '/tool-dispatch') {
        const rows = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM proof_dispatches').toArray();
        return Response.json(rows.map(row => RuntimeToolDispatchSchema.parse(JSON.parse(row.payload))).find(dispatch => dispatch.tool === 'read') ?? null);
      }
      if (path === '/reject-mismatched-result') {
        const input = z.object({ attemptId: z.string() }).parse(await request.json());
        const result = runtime.attachments.getAttempt(input.attemptId)?.result;
        if (!result) throw new Error('Missing result for materialization mismatch proof');
        try {
          runtime.attachments.materialized({ ...result, content: [{ type: 'text', text: 'not the executor result' }] });
          return Response.json({ rejected: false });
        } catch { return Response.json({ rejected: true }); }
      }
      if (path === '/simulate-materialization-commit-gap') {
        const input = z.object({ attemptId: z.string() }).parse(await request.json());
        await runtime.wake();
        // Failure injection: retain the committed Pi entry and original receipt,
        // but model a crash before its post-commit materialization bookkeeping.
        const receipt = this.ctx.storage.sql.exec<{ acknowledged: number }>('SELECT acknowledged FROM runtime_executor_receipts WHERE id=?', input.attemptId).toArray()[0];
        if (!receipt || receipt.acknowledged) throw new Error('Commit-gap injection requires an unacknowledged retained receipt');
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM runtime_materialized_attempts WHERE id=?', input.attemptId);
          this.ctx.storage.sql.exec('DELETE FROM runtime_history_result_chunks WHERE id=?', input.attemptId);
          this.ctx.storage.sql.exec('DELETE FROM runtime_history_result_payloads WHERE id=?', input.attemptId);
        });
        return Response.json({ committedHistoryRetained: true });
      }
      if (path === '/materialize') {
        const input = z.object({ attemptId: z.string() }).parse(await request.json());
        const attempt = runtime.attachments.getAttempt(input.attemptId);
        if (!attempt?.result || attempt.dispatch.conversationId !== String(root.id)) throw new Error('Missing result owned by this conversation');
        const reference = { attemptId: input.attemptId, sha256: await receiptDigest(attempt.result) };
        await root.commit(async tx => {
          await tx.appendEntry(root.id, { kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: attempt.dispatch.requestId, toolName: attempt.dispatch.tool, content: [{ type: 'text', text: 'Large executor result retained by durable reference' }], details: { executorResultReference: reference }, isError: attempt.result!.status !== 'completed', timestamp: Date.now() }] });
        }, BACKGROUND_CONTEXT);
        return Response.json(reference);
      }
      if (path === '/receipt-storage') {
        const input = z.object({ attemptId: z.string() }).parse(await request.json());
        await runtime.wake();
        const id = input.attemptId;
        const marker = this.ctx.storage.sql.exec<{ collected: number; bytes: number }>('SELECT collected,length(receipt) AS bytes FROM runtime_materialized_attempts WHERE id=?', id).toArray()[0];
        return Response.json({
          materialized: marker !== undefined, collected: marker?.collected === 1, tombstoneBytes: marker?.bytes ?? 0,
          receipts: this.ctx.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM runtime_executor_receipts WHERE id=?', id).toArray()[0]!.count,
          payloads: this.ctx.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM runtime_terminal_payloads WHERE id=?', id).toArray()[0]!.count,
          terminalBytes: this.ctx.storage.sql.exec<{ bytes: number }>('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM runtime_terminal_chunks WHERE id=?', id).toArray()[0]!.bytes,
          historyBytes: this.ctx.storage.sql.exec<{ bytes: number }>('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM runtime_history_result_chunks WHERE id=?', id).toArray()[0]!.bytes,
        });
      }
      if (path === '/setup') {
        const grant = await runtime.attachments.attach({ ...identity, machineId: RuntimeMachineIdSchema.parse('proof-machine'), generation: 7, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash', 'write', 'read', 'proc'] });
        if (grant.attachment.state === 'attaching') grant.attachment = runtime.attachments.ready({ ...grant.attachment, commit: 'a'.repeat(40), prerequisitesComplete: true }, 'a'.repeat(40)).attachment;
        await this.ctx.storage.put('proof-grant', grant);
        await root.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; (await tx.doc(SessionControlsDoc, root.id)).approvalMode = 'yolo'; }, BACKGROUND_CONTEXT);
        return Response.json(grant);
      }
      if (path === '/execute' || path === '/observe' || path === '/cancel') {
        const dispatch = RuntimeToolDispatchSchema.parse(await request.json());
        if (path === '/execute') return Response.json(await runtime.attachments.execute(dispatch, AbortSignal.timeout(15_000)));
        return Response.json(await (path === '/cancel' ? runtime.attachments.cancel(dispatch) : runtime.attachments.reconcile(dispatch)));
      }
      if (path === '/release-foreground') {
        finishForeground?.();
        return Response.json({ released: true });
      }
      if (path === '/submit') {
        const input = z.object({ text: z.string(), requestId: z.string() }).parse(await request.json());
        return Response.json(await runtime.submit({ ...identity, ...input }));
      }
      if (path === '/foreground-idle') { await root.waitForIdle(BACKGROUND_CONTEXT); return Response.json({ idle: true }); }
      if (path === '/abort') return Response.json(await runtime.cancel({ ...identity, conversationId: String(root.id) }));
      if (path === '/task-failures') return Response.json(this.ctx.storage.sql.exec("SELECT * FROM tasks WHERE status='terminal' AND json_extract(record,'$.state.outcome.status')='failed' ORDER BY id DESC LIMIT 5").toArray());
      if (path === '/state') {
        runtime.harness.resume();
        const jobs = await runtime.harness.snapshot(DurableJobsDoc, root.id, BACKGROUND_CONTEXT);
        const todos = await runtime.harness.snapshot(TodosDoc, root.id, BACKGROUND_CONTEXT);
        const transcript = await runtime.transcript(String(root.id));
        const entries = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
        const completions = entries.flatMap(entry => (entry.model ?? []).flatMap(message => {
          if (message.role !== 'user' || typeof message.content !== 'string') return [];
          const start = message.content.indexOf('{');
          if (start < 0) return [];
          try {
            const parsed = RuntimeJobObservationSchema.safeParse(JSON.parse(message.content.slice(start)));
            return parsed.success ? [parsed.data.job.jobId] : [];
          } catch { return []; }
        }));
        const toolResults = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult');
        const toolErrors = toolResults.filter(message => message.isError).length;
        return Response.json({ jobs: RuntimeJsonSchema.parse(jobs ?? { records: {} }), todos: todos ?? null, transcript, completions, toolErrors, toolResults: toolResults.map(message => message.content), holding: finishForeground !== null, snapshot: await runtime.snapshot() });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  }
}
export default { fetch(request: Request, env: { EXECUTION: DurableObjectNamespace<ExecutionSmoke> }) { return env.EXECUTION.getByName('execution').fetch(request); } };
