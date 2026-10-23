import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, createModels, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { JsonObject } from '@earendil-works/pi-durable';
import { RuntimeGitCheckpointSchema, RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createWorkspaceRuntime, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { WorkspaceTurnReport } from '@gitspace/blocks';
import { projectProgress, projectWatchHooks, startFromProject } from '../src/project-watch.js';
import { createWorkspaceMetadataTables } from '../src/workspace-metadata.js';

const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** One scripted model answer; `gate` holds it back, `requested` resolves when the model is asked for it. */
type Reply = { content: AssistantMessage['content']; gate?: Promise<void>; requested: PromiseWithResolvers<void> };

/** A workspace runtime with real pi and a scripted model, its watch hooks recording what reaches the project. */
async function watchFixture(ctx: DurableObjectState) {
  const identity = RuntimeIdentitySchema.parse({ projectId: 'watch-project', workspaceId: 'watch-workspace' });
  createWorkspaceMetadataTables(ctx.storage);
  const script: Reply[] = [];
  const reply = (text: string, gate?: Promise<void>) => { const next: Reply = { content: [{ type: 'text', text }], gate, requested: Promise.withResolvers() }; script.push(next); return next; };
  const call = (name: string, args: JsonObject, gate?: Promise<void>) => { const next: Reply = { content: [{ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args }], gate, requested: Promise.withResolvers() }; script.push(next); return next; };
  /** The text of the newest user message of each model request. */
  const requests: string[] = [];
  const stream = (_model: unknown, context: Context) => {
    const user = context.messages.findLast(message => message.role === 'user');
    requests.push(typeof user?.content === 'string' ? user.content : (user?.content ?? []).flatMap(part => part.type === 'text' ? [part.text] : []).join(''));
    const next = script.shift();
    if (!next) throw new Error('The model was asked for an unscripted answer');
    next.requested.resolve();
    const toolUse = next.content.some(part => part.type === 'toolCall');
    const message: AssistantMessage = { role: 'assistant', content: next.content, api: 'fixture', provider: 'fixture', model: 'fixture', stopReason: toolUse ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const events = createAssistantMessageEventStream();
    void (next.gate ?? Promise.resolve()).then(() => { events.push({ type: 'done', reason: toolUse ? 'toolUse' : 'stop', message }); events.end(message); });
    return events;
  };
  const models = createModels();
  models.setProvider({ id: 'fixture', name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture' } }) } }, getModels: () => [{ id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 200000, maxTokens: 1024 }], stream, streamSimple: stream });
  const reports: Array<{ report: WorkspaceTurnReport; onDone: string }> = [];
  let reported = Promise.withResolvers<void>();
  const hooks = projectWatchHooks(ctx.storage, identity, (report, onDone) => { reports.push({ report, onDone }); reported.resolve(); reported = Promise.withResolvers(); });
  const waits: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoints', headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'b'.repeat(40), trackedWorktreeCommit: 'c'.repeat(40), worktreeCommit: 'c'.repeat(40), indexTree: 'd'.repeat(40), worktreeTree: 'e'.repeat(40) });
  const runtime: WorkspaceRuntime = await createWorkspaceRuntime({
    storage: ctx.storage, identity, models, model: { provider: 'fixture', modelId: 'fixture' },
    tools: { invoke: async input => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: `${input.tool} ran` }] }), prepareBrowser: unsupported, instructions: async () => '', authorizeCronTool: async () => {}, preflight: async () => {} },
    operations: { execute: unsupported, reconcile: async () => null, cancel: unsupported, jobScope: () => identity, controlJob: unsupported, observeProcess: unsupported, stopProcess: unsupported, wakeAt: async () => {} },
    code: { readFile: async () => null, listSnapshotPaths: async () => [], changedSnapshotPaths: unsupported, mergeSnapshot: unsupported, writeSnapshot: unsupported, reader: () => ({ readTree: async () => [], readBlob: async () => null, close: async () => {} }) },
    initialCheckpoint: async () => checkpoint,
    lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {},
    retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit',
    admitInference: async () => ({ provider: 'fixture', modelId: 'fixture' }), bindInferenceConversation: async () => undefined, refuseRequest: () => {},
    session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported }, qa: { list: async () => [], act: unsupported },
    attachments: { seal: async value => value, open: async value => value, dispatch: unsupported },
    onReport: error => { failures.push(error); }, waitUntil: promise => { waits.push(promise); }, schedule: async () => {},
    published: (_snapshot, report) => hooks.published(report), turnChanged: hooks.turnChanged, personPrompted: hooks.personPrompted,
  });
  const root = await runtime.harness.root(BACKGROUND_CONTEXT);
  /** Every turn done and every hook it set off delivered. */
  const settle = async () => {
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(10_000), BACKGROUND_CONTEXT));
    while (waits.length) await Promise.all(waits.splice(0));
    if (failures.length) throw new AggregateError(failures, 'The runtime reported failures');
  };
  const start = (requestId: string, text: string, onDone: 'quiet' | 'wake' = 'quiet') => startFromProject(ctx.storage, runtime, { ...identity, requestId, text: `Instruction from the project agent:\n\n${text}` }, { name: 'FEAT-33', onDone });
  const submit = (requestId: string, text: string, deviceId?: string) => runtime.submit({ ...identity, requestId, text }, deviceId);
  return { identity, runtime, root, reply, call, requests, reports, reported: () => reported.promise, settle, start, submit, progress: () => projectProgress(ctx.storage, async () => runtime) };
}

const room = () => env.SPACE_AUTHORITY.getByName(`project-watch:${crypto.randomUUID()}`);

test('only the turn the project agent started reports, once; later turns, a person\'s included, never do', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await watchFixture(ctx);
    try {
      f.reply('Plan drafted.');
      await f.start('start:one', 'Draft the plan.');
      await f.settle();
      expect(f.reports).toEqual([{ onDone: 'quiet', report: { projectId: f.identity.projectId, workspaceId: f.identity.workspaceId, name: 'FEAT-33', requestId: 'start:one', outcome: 'finished', excerpt: 'Plan drafted.' } }]);
      // The watch is gone with its report: the project agent sees no watched turn.
      expect((await f.progress()).turn).toBeNull();
      f.reply('Done with your edit.');
      await f.submit('person', 'Rename the bucket too.', 'device-1');
      await f.settle();
      f.reply('Synced.');
      await f.submit('machine', 'Sync finished on Darktop.');
      await f.settle();
      expect(f.reports).toHaveLength(1);
    } finally { await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('a person prompting in the workspace ends the watch before the turn ends: nothing reports', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await watchFixture(ctx);
    const held = Promise.withResolvers<void>();
    const again = Promise.withResolvers<void>();
    try {
      const working = f.reply('Half the plan.', held.promise);
      await f.start('start:submit', 'Draft the plan.');
      await working.requested.promise;
      expect((await f.progress()).turn).toMatchObject({ requestId: 'start:submit', state: 'running' });
      f.reply('Taking your direction.');
      await f.submit('person', 'Stop, I will steer this.', 'device-1');
      expect((await f.progress()).turn).toBeNull();
      held.resolve();
      await f.settle();

      // The same through a session prompt, the browser's composer path.
      const busy = f.reply('Second plan, half done.', again.promise);
      await f.start('start:session', 'Draft another plan.');
      await busy.requested.promise;
      f.reply('Understood.');
      await f.runtime.session(undefined, { type: 'prompt', text: 'Let me drive.' }, false, 'device-2');
      again.resolve();
      await f.settle();
      expect(f.reports).toEqual([]);
    } finally { held.resolve(); again.resolve(); await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('an instruction queued behind a running turn reports its own turn, not the one it waited for', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await watchFixture(ctx);
    const held = Promise.withResolvers<void>();
    try {
      const earlier = f.reply('Earlier work done.', held.promise);
      await f.submit('cron', 'Nightly cleanup.');
      await earlier.requested.promise;
      f.reply('Queued work done.');
      await f.start('start:queued', 'Then write the tests.');
      // Waiting behind the running turn: nothing to show yet, and the runtime is not opened for it.
      expect((await projectProgress(ctx.storage, unsupported)).turn).toMatchObject({ requestId: 'start:queued', state: 'queued', startedAt: null });
      held.resolve();
      await f.settle();
      expect(f.reports.map(({ report }) => [report.outcome, report.excerpt])).toEqual([['finished', 'Queued work done.']]);
    } finally { held.resolve(); await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('progress shows the running turn\'s newest messages; a question in it reports once as asked', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await watchFixture(ctx);
    const held = Promise.withResolvers<void>();
    try {
      f.call('workspace_status', {});
      const asking = f.call('ask', { prompt: 'Which bucket?', choices: ['assets', 'uploads'] }, held.promise);
      await f.start('start:progress', 'Move the uploads.');
      await asking.requested.promise;
      const progress = await f.progress();
      expect(progress.turn).toMatchObject({ requestId: 'start:progress', state: 'running', onDone: 'quiet' });
      expect(progress.turn?.startedAt).not.toBeNull();
      expect(progress.items).toEqual([
        { role: 'user', text: 'Instruction from the project agent:\n\nMove the uploads.' },
        { role: 'assistant', text: '[workspace_status {}]' },
        { role: 'tool', text: 'workspace_status: workspace_status ran' },
      ]);
      const reported = f.reported();
      held.resolve();
      await reported;
      expect(f.reports.map(({ report }) => [report.outcome, report.excerpt])).toEqual([['asked', 'Which bucket?']]);
      expect((await f.progress()).turn).toBeNull();
      // The person answering finishes the turn; it already reported.
      f.reply('Moved to uploads.');
      const question = (await f.runtime.snapshot()).questions.find(item => item.answer === null);
      if (!question) throw new Error('The ask left no open question');
      await f.runtime.answer({ ...f.identity, questionId: question.id, answer: 'uploads' }, { deviceId: 'device-1', canApprove: false });
      await f.settle();
      expect(f.reports).toHaveLength(1);
    } finally { held.resolve(); await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('a wake report starts the project agent\'s turn with a workspace event; a quiet one does not', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await watchFixture(ctx);
    try {
      const report: WorkspaceTurnReport = { projectId: 'watch-project', workspaceId: 'feat-33', name: 'FEAT-33', requestId: 'start:a', outcome: 'finished', excerpt: 'Plan drafted.' };
      await f.runtime.workspaceReport(report, 'quiet');
      await f.settle();
      expect(f.requests).toEqual([]);
      const context = (await f.root.context(BACKGROUND_CONTEXT)).messages;
      expect(context.map(message => message.role === 'user' ? message.content : null)).toContain('Workspace FEAT-33 finished: Plan drafted.');

      const answered = f.reply('I will review FEAT-33 next.');
      await f.runtime.workspaceReport({ ...report, requestId: 'start:b', outcome: 'failed', excerpt: 'Model request failed' }, 'wake');
      await answered.requested.promise;
      await f.settle();
      expect(f.requests).toEqual(['<gitspace-event kind="workspace" source="FEAT-33">\nWorkspace FEAT-33 failed: Model request failed\n</gitspace-event>']);
    } finally { await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
