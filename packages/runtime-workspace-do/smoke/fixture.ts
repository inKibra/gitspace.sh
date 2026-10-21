import { DurableObject } from 'cloudflare:workers';
import { createModels, createAssistantMessageEventStream, type Model, type StreamFunction, type AssistantMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createOperationalTasks, type OperationalServices } from '../../runtime-core/src/tasks.js';
import { RuntimeAnswerInputSchema, RuntimeIdentitySchema, RuntimeSessionInputSchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { WorkspaceDraftSaveSchema } from '@gitspace/protocol-runtime/draft';
import { createWorkspaceRuntime } from '../src/runtime.js';
import { createReplicaStore } from '../src/replica-store.js';
import { QuestionsDoc } from '../../runtime-core/src/documents.js';
import { AgentDefinitionContextDoc } from '../../runtime-core/src/subagent-state.js';
import { BackgroundAgentsDoc, createBackgroundAgentTask } from '../../runtime-core/src/background-agents.js';

const identity = RuntimeIdentitySchema.parse({ projectId: 'smoke-project', workspaceId: 'smoke-workspace' });
const modelRef = { provider: 'fixture', modelId: 'fixture' };
const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const model: Model<'fixture'> = { id: 'fixture', name: 'Local deterministic provider', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost, reasoning: false, contextWindow: 8192, maxTokens: 1024 };
const unsupported = async (): Promise<never> => { throw new Error('Smoke unexpectedly invoked an external service'); };
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const receiptText = 'full durable receipt '.repeat(1000);
const repositoryDefinition = '---\nname: Repository Scout\nmodel: pi/scout\ntools: read, grep\n---\nInspect the committed workspace source.';
const definitionCheckpoint = { checkpointRef: 'refs/gitspace/spaces/smoke/checkpoints', branch: 'main', headCommit: '1'.repeat(40), indexCommit: '2'.repeat(40), trackedWorktreeCommit: '3'.repeat(40), worktreeCommit: '4'.repeat(40), indexTree: '5'.repeat(40), worktreeTree: '6'.repeat(40) };
const entry = (name: string, hash: string, type: ArtifactsTreeEntry['type']): ArtifactsTreeEntry => ({ name, hash, mode: type === 'tree' ? '40000' : '100644', type });
const definitionTrees = new Map<string, ArtifactsTreeEntry[]>([
  [definitionCheckpoint.worktreeTree, [entry('.agents', 'a'.repeat(40), 'tree'), entry('README.md', 'd'.repeat(40), 'blob')]],
  ['a'.repeat(40), [entry('agents', 'b'.repeat(40), 'tree')]],
  ['b'.repeat(40), [entry('repository.md', 'c'.repeat(40), 'blob')]],
]);
const stream: StreamFunction = (_model, context) => {
  const result = createAssistantMessageEventStream();
  const last = context.messages.findLast(message => message.role !== 'system');
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const ask = last?.role === 'user' && text === 'ask for a color';
  if (last?.role === 'user' && text === 'fail the model') {
    const failure: AssistantMessage = { role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture', content: [], stopReason: 'error', errorMessage: 'fixture provider rejected the request', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000003 } } };
    result.push({ type: 'error', reason: 'error', error: failure });
    result.end();
    return result;
  }
  const plan = last?.role === 'user' && text === 'propose a plan';
  const output: AssistantMessage = { role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture', content: ask || plan ? [{ type: 'toolCall', id: crypto.randomUUID(), name: plan ? 'propose_plan' : 'ask', arguments: { prompt: plan ? 'Approve this deterministic smoke plan?' : 'Choose a color', choices: plan ? ['Misleading model choice', 'Another model choice'] : ['blue', 'green'] } }] : [{ type: 'text', text: `fixture reply: ${text}` }], stopReason: ask || plan ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000003 } } };
  result.push({ type: 'start', partial: output });
  result.push({ type: 'done', reason: ask || plan ? 'toolUse' : 'stop', message: output });
  result.end();
  return result;
};

export class RuntimeSmoke extends DurableObject<unknown> {
  protected readonly runtime;
  private readonly operations: OperationalServices;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const models = createModels();
    models.setProvider({ id: 'fixture', name: 'Smoke fixture', auth: { apiKey: { name: 'Fixture only', async resolve() { return { auth: { apiKey: 'not-a-real-key' } }; } } }, getModels: () => [model], stream, streamSimple: stream });
    this.operations = { execute: async input => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: receiptText }] }), reconcile: async () => null, cancel: unsupported, jobScope: () => identity, controlJob: unsupported, observeProcess: unsupported, stopProcess: unsupported, wakeAt: timestamp => ctx.storage.setAlarm(timestamp) };
    this.runtime = createWorkspaceRuntime({
      storage: ctx.storage, identity, models, model: modelRef,
      code: { readFile: unsupported, writeSnapshot: unsupported, mergeSnapshot: unsupported, listSnapshotPaths: async () => ['.agents/agents/repository.md'], changedSnapshotPaths: unsupported, reader: () => ({ readTree: async oid => definitionTrees.get(oid) ?? null, readBlob: async oid => oid === 'c'.repeat(40) ? new Blob([repositoryDefinition]) : null, close: async () => {} }) },
      initialCheckpoint: async () => await ctx.storage.get('definitions-enabled') ? definitionCheckpoint : null,
      lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {},
      tools: { invoke: unsupported, prepareBrowser: unsupported, instructions: async () => 'Deterministic local-only smoke. No external services or machine.', authorizeCronTool: unsupported, preflight: async () => {} },
      operations: this.operations, retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit',
      onReport: error => console.error('RUNTIME_REPORT', String(error)),
      admitInference: async input => { await ctx.storage.put(`admission:${input.requestId}`, input.conversationId); return modelRef; },
      bindInferenceConversation: async (conversationId, _signal, _submissions, requests) => {
        if (await ctx.storage.get('fail-binding')) throw new Error('fixture inference binding failed');
        for (const id of requests) check(await ctx.storage.get(`admission:${id}`) === conversationId, 'Missing durable admission');
      },
      session: { catalog: async () => ({ inference: { profileId: 'fixture-profile', profileName: 'Fixture', profileRevision: 1, assignmentRevision: 1 }, models: [{ provider: 'fixture', id: 'fixture', name: 'Smoke', contextWindow: 8192 }], roles: [{ id: 'scout', label: 'Scout', provider: 'fixture', model: 'fixture', thinking: null, current: false }] }), reload: unsupported },
      qa: { list: async () => [], act: unsupported },
      attachments: { seal: unsupported, open: unsupported, dispatch: unsupported },
      waitUntil: promise => ctx.waitUntil(promise), schedule: timestamp => ctx.storage.setAlarm(timestamp),
    });
  }
  async alarm() { await (await this.runtime).wake(); }
  async fetch(request: Request): Promise<Response> {
    try {
      const runtime = await this.runtime;
      const url = new URL(request.url);
      if (url.pathname === '/fail-binding') { await this.ctx.storage.put('fail-binding', url.searchParams.get('on') !== 'false'); return Response.json({ armed: url.searchParams.get('on') !== 'false' }); }
      if (url.pathname === '/enable-definitions') { await this.ctx.storage.put('definitions-enabled', true); return Response.json({ enabled: true }); }
      if (url.pathname === '/draft') return Response.json(await runtime.saveDraft(WorkspaceDraftSaveSchema.parse(await request.json()), request.headers.get('x-fixture-device') ?? 'fixture-browser'));
      if (url.pathname === '/events') {
        const after = url.searchParams.get('after');
        return Response.json(await runtime.events(after === null ? null : Number(after)));
      }
      if (url.pathname === '/session') {
        const body: unknown = await request.json();
        const input = RuntimeSessionInputSchema.parse(body);
        const canApprove = typeof body === 'object' && body !== null && 'canApprove' in body && body.canApprove === true;
        return Response.json(await runtime.session(input.conversationId, input.command, canApprove, 'fixture-browser'));
      }
      if (url.pathname === '/answer') {
        const input = RuntimeAnswerInputSchema.parse(await request.json());
        return Response.json(await runtime.answer(input, { deviceId: 'fixture-browser', canApprove: true }));
      }
      if (url.pathname === '/scoped-stop-seed') {
        const root = await runtime.harness.root(BACKGROUND_CONTEXT);
        await this.ctx.storage.put('definitions-enabled', true);
        const definition = (await runtime.session(String(root.id), { type: 'agentSetup' })).setup?.agents.find(agent => agent.path === '.agents/agents/repository.md');
        check(definition, 'Repository definition was not available for the retained child selection');
        const anchor = await root.commit(tx => tx.appendEntry(root.id, { kind: 'smoke.scope' }), BACKGROUND_CONTEXT);
        const child = await root.fork(anchor.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
        const sibling = await root.fork(anchor.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
        const grandchild = await root.fork(anchor.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
        for (const [target, parent, name] of [[child, root, 'child'], [sibling, root, 'sibling'], [grandchild, child, 'grandchild']] as const) {
          await target.commit(async tx => { (await tx.doc(AgentDefinitionContextDoc, target.id)).child = { parentId: String(parent.id), name, attemptId: `scope-${name}`, definition, selection: { kind: 'role', role: 'scout' }, role: 'scout', thinking: null, tools: definition.tools, model: modelRef }; }, BACKGROUND_CONTEXT);
        }
        for (const target of [root, child, sibling, grandchild]) {
          const requestId = `scope-${target.id}`;
          await this.ctx.storage.put(`admission:${requestId}`, String(target.id));
          await target.submit({ type: 'input', requestId, content: 'ask for a color' }, BACKGROUND_CONTEXT);
        }
        runtime.harness.resume();
        const operation = createOperationalTasks(this.operations).find(task => task.definition.name === 'gitspace.Checkpoint');
        check(operation, 'Missing checkpoint task');
        const spawningTask = await root.commit(tx => tx.createTask(operation, { args: {}, deadlineAt: new Date(Date.now() + 120_000).toISOString(), replay: 'safe' }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          for (const target of [child, sibling]) {
            const attemptId = `background-scope-${target.id}`;
            const owner = await tx.createTask(createBackgroundAgentTask(unsupported), { spawningTask, attemptId }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true });
            (await tx.doc(BackgroundAgentsDoc, root.id)).children[attemptId] = { conversationId: target.id, owner };
          }
        }, BACKGROUND_CONTEXT);
        runtime.harness.resume();
        return Response.json({ root: String(root.id), child: String(child.id), sibling: String(sibling.id), grandchild: String(grandchild.id) });
      }
      if (url.pathname === '/live-tasks') {
        const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
        return Response.json(inspection.tasks.map(task => ({ id: String(task.record.id), conversationId: String(task.record.conversationId), kind: task.record.kind, state: task.record.state.status })));
      }
      if (url.pathname === '/submit') {
        await runtime.submit({ ...identity, requestId: url.searchParams.get('requestId') ?? crypto.randomUUID(), text: url.searchParams.get('text') ?? '', conversationId: url.searchParams.get('conversationId') ?? undefined, ...(url.searchParams.has('draftRevision') ? { draftRevision: Number(url.searchParams.get('draftRevision')) } : {}), draftText: url.searchParams.get('draftText') ?? undefined }, 'fixture-browser');
      }
      if (url.pathname === '/burst') {
        const root = await runtime.harness.root(BACKGROUND_CONTEXT);
        const operation = createOperationalTasks(this.operations).find(task => task.definition.name === 'gitspace.Checkpoint');
        check(operation, 'Missing checkpoint task definition');
        const ids = await root.commit(async tx => {
          const ids = [];
          for (let i = 0; i < 140; i++) ids.push(await tx.createTask(operation, { args: { i }, deadlineAt: new Date(Date.now() + 120_000).toISOString(), replay: 'safe' }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }));
          return ids;
        }, BACKGROUND_CONTEXT);
        runtime.harness.resume();
        const results = await Promise.all(ids.map(id => runtime.harness.waitForTask(id, BACKGROUND_CONTEXT)));
        for (const result of results) check(JSON.stringify(result).includes(receiptText), 'Durable operation result was truncated');
        const snapshot = await runtime.snapshot();
        const terminal = snapshot.tasks.filter(task => task.state === 'completed');
        check(terminal.length === 128, 'Terminal projection must retain the newest 128 tasks');
        check(terminal.every(task => !JSON.stringify(task.result).includes(receiptText)), 'Projection retained unbounded results');
        check(terminal.some(task => task.id === String(ids.at(-1))), 'Newest terminal receipt missing');
        check(!terminal.some(task => task.id === String(ids[0])), 'Old terminal projection was not evicted');
        // Read again after projection to defend against pruning the durable receipts themselves.
        check(JSON.stringify(await runtime.harness.waitForTask(ids[0]!, BACKGROUND_CONTEXT)).includes(receiptText), 'Projection deleted full old receipt');
        return Response.json({ tasks: ids.length, projected: terminal.length, receiptCharacters: receiptText.length });
      }
      if (url.pathname === '/history-seed') {
        const root = await runtime.harness.root(BACKGROUND_CONTEXT);
        const ids = await root.commit(async tx => {
          const ids = [];
          for (let i = 0; i < 620; i++) ids.push((await tx.appendEntry(root.id, { kind: 'smoke.history', model: [{ role: 'user', content: `history-${i} ${'x'.repeat(i === 619 ? 600000 : i % 2 ? 6000 : 800)}`, timestamp: Date.now() }] })).id);
          return ids;
        }, BACKGROUND_CONTEXT);
        const pivot = ids[20]!;
        const branches: string[] = [];
        for (let i = 0; i < 205; i++) {
          const branch = await root.fork(pivot, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
          const entry = await branch.commit(tx => tx.appendEntry(branch.id, { kind: 'smoke.branch', model: [{ role: 'user', content: `branch-${i}`, timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
          branches.push(String(entry.id));
        }
        return Response.json({ conversationId: String(root.id), ids: ids.map(String), pivot: String(pivot), branches });
      }
      if (url.pathname === '/sync-notices-seed') {
        // Notices as the flood left them, in a runtime from before their withdrawal ran: more than a snapshot window of
        // them after the last other entry.
        const root = await runtime.harness.root(BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          for (const text of ['Machine Darktop went offline.', ...Array.from({ length: 300 }, (_, index) => `Sync with Darktop failed: internal error; reference = ${index}`)]) {
            await tx.appendEntry(root.id, { kind: 'gitspace.machine-notice', data: { source: 'Machine' }, model: [{ role: 'user', content: text, timestamp: Date.now() }] });
          }
        }, BACKGROUND_CONTEXT);
        this.ctx.storage.sql.exec("DELETE FROM runtime_one_time_steps WHERE name='withdraw-sync-failure-notices'");
        return Response.json({ conversationId: String(root.id) });
      }
      if (url.pathname === '/transcript') return runtime.transcript();
      return Response.json(await runtime.snapshot());
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  }
}
export class ReplicaSmoke extends DurableObject {
  async fetch(): Promise<Response> {
    const sql = this.ctx.storage.sql;
    // A store written by the previous release: snapshot and delta parts at cursor 7, and a draft.
    sql.exec('CREATE TABLE runtime_replica(kind TEXT NOT NULL,cursor INTEGER NOT NULL,part INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,cursor,part))');
    const legacy: Array<[string, number, number]> = [['snapshot', 7, 0], ['snapshot', 7, 1], ['event', 6, 0], ['event', 7, 0], ['draft', 3, 0]];
    for (const [kind, cursor, part] of legacy) sql.exec('INSERT INTO runtime_replica VALUES(?,?,?,?)', kind, cursor, part, '{}');
    const store = createReplicaStore(this.ctx.storage);
    const kinds = () => sql.exec<{ kind: string }>('SELECT kind FROM runtime_replica ORDER BY kind').toArray().map(row => row.kind);
    check(store.cursor() === 7 && JSON.stringify(kinds()) === '["draft"]', 'Migration kept snapshot parts or lost the cursor');
    // A publish stores its cursor only, however large the snapshot and its delta.
    const delta = (base: number, cursor: number, text = '') => JSON.stringify({ type: 'delta', baseCursor: base, cursor, ops: text ? [['s', ['documents', 'text'], text]] : [] });
    store.commit(8, delta(7, 8, 'x'.repeat(200_000)));
    check(store.cursor() === 8 && JSON.stringify(kinds()) === '["draft"]', 'A publish stored more than its cursor');
    check(store.events(7)?.length === 1, 'A delta was not replayed from memory');
    store.commit(9, delta(8, 9, 'y'.repeat(1_100_000)));
    check(store.events(7) === null, 'Oversized replay must request a lossless reset');
    store.commit(10, null);
    check(store.events(9)?.length === 0, 'A placeholder publish offered a delta');
    // Reopened, the cursor holds and no delta survives: readers behind it get a reset.
    const reopened = createReplicaStore(this.ctx.storage);
    check(reopened.cursor() === 10 && reopened.events(9)?.length === 0, 'Reopened store lost its cursor or kept deltas');
    const text = 'x' + '\u{1d11e}'.repeat(1_100_000);
    reopened.commitDraft(4, text);
    check(createReplicaStore(this.ctx.storage).draft() === text, 'Large Unicode draft was corrupted');
    return Response.json({ cursor: reopened.cursor() });
  }
}
export default { fetch(request: Request, env: { SMOKE: DurableObjectNamespace<RuntimeSmoke>; REPLICA: DurableObjectNamespace<ReplicaSmoke> }) {
  return new URL(request.url).pathname === '/replica-proof' ? env.REPLICA.getByName('replica').fetch(request) : env.SMOKE.getByName('runtime-regressions').fetch(request);
} };
