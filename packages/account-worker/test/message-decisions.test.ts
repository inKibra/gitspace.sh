import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, createModels, type AssistantMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { RuntimeGitCheckpointSchema, RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createWorkspaceRuntime, type SentDecisions } from '@gitspace/runtime-workspace-do';
import { journalMessageDecisions } from '../src/message-decisions.js';
import { createWorkspaceMetadataTables } from '../src/workspace-metadata.js';
import type { SpaceContextDO } from '../src/space-context.js';

const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A workspace runtime with real pi and a model that answers "Noted.", journaling a person's decisions into the
 * workspace's journal as the account host does. `failFirst`: the first journaling writes the first decision, then fails. */
async function decisionsFixture(ctx: DurableObjectState, failFirst = false) {
  const identity = RuntimeIdentitySchema.parse({ projectId: 'decisions-project', workspaceId: `decisions-${crypto.randomUUID()}` });
  createWorkspaceMetadataTables(ctx.storage);
  const stream = () => {
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }], api: 'fixture', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage };
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => { events.push({ type: 'done', reason: 'stop', message }); events.end(message); });
    return events;
  };
  const models = createModels();
  models.setProvider({ id: 'fixture', name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture' } }) } }, getModels: () => [{ id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 200000, maxTokens: 1024 }], stream, streamSimple: stream });
  const waits: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const sent: SentDecisions[] = [];
  const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoints', headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'b'.repeat(40), trackedWorktreeCommit: 'c'.repeat(40), worktreeCommit: 'c'.repeat(40), indexTree: 'd'.repeat(40), worktreeTree: 'e'.repeat(40) });
  const runtime = await createWorkspaceRuntime({
    storage: ctx.storage, identity, models, model: { provider: 'fixture', modelId: 'fixture' },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unsupported, prepareBrowser: unsupported, takeoverTab: unsupported, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {} },
    operations: { execute: unsupported, reconcile: async () => null, cancel: unsupported, jobScope: () => identity, controlJob: unsupported, observeProcess: unsupported, stopProcess: unsupported, wakeAt: async () => {} },
    code: { readFile: async () => null, listSnapshotPaths: async () => [], changedSnapshotPaths: unsupported, mergeSnapshot: unsupported, writeSnapshot: unsupported, reader: () => ({ readTree: async () => [], readBlob: async () => null, close: async () => {} }) },
    initialCheckpoint: async () => checkpoint,
    lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {},
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    admitInference: async () => ({ provider: 'fixture', modelId: 'fixture', thinking: 'high' }), bindInferenceConversation: async () => undefined, refuseRequest: () => {},
    session: { catalog: async () => ({ models: [], roles: [] }), reload: async () => {} }, qa: { list: async () => [], act: unsupported },
    attachments: { seal: async value => value, open: async value => value, dispatch: unsupported },
    onReport: error => { failures.push(error); }, waitUntil: promise => { waits.push(promise); }, schedule: async () => {},
    recordMessageDecisions: async message => {
      sent.push(message);
      if (failFirst && sent.length === 1) {
        await journalMessageDecisions(env, identity, 'code', { ...message, decisions: message.decisions.slice(0, 1) });
        throw new Error('The journal is unavailable');
      }
      await journalMessageDecisions(env, identity, 'code', message);
    },
  });
  const root = await runtime.harness.root(BACKGROUND_CONTEXT);
  /** The turn done and every recording it set off delivered. */
  const settle = async () => {
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(10_000), BACKGROUND_CONTEXT));
    while (waits.length) await Promise.all(waits.splice(0));
    if (failures.length) throw new AggregateError(failures, 'The runtime reported failures');
  };
  const journal = () => runInDurableObject(env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, identity.projectId, identity.workspaceId])), (context: SpaceContextDO) => context.listJournal({ projectId: identity.projectId, spaceId: identity.workspaceId }));
  /** The entry id the session's history lists for a message. */
  const messageId = async (text: string) => (await runtime.session(undefined, { type: 'control' })).control.history.find(entry => entry.text === text)?.entryId;
  /** How many prompts' decisions the runtime still holds. */
  const held = () => ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM runtime_message_decisions').one().count;
  return { identity, runtime, root, sent, settle, journal, messageId, held };
}

const room = () => env.SPACE_AUTHORITY.getByName(`message-decisions:${crypto.randomUUID()}`);

test('a person\'s message journals each decision it carried once, citing the message; a message without decisions journals none', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await decisionsFixture(ctx);
    try {
      const text = 'Postgres already runs in production.\n\nDecided: Postgres (Storage engine)\nDecided: No cache\n~~~json\n{\n  "reason": "small data"\n}\n~~~';
      await f.runtime.session(undefined, { type: 'prompt', text, decisions: [{ title: 'Storage engine', choice: 'Postgres', sectionId: 'storage' }, { title: 'No cache', payload: { reason: 'small data' } }] }, false, 'device-a');
      await f.settle();
      const messageId = await f.messageId(text);
      expect(messageId).toBeDefined();
      // The entries quote the message as people read it: the staged choice's data, sent for the agent, is left out.
      const shown = 'Postgres already runs in production.\n\nDecided: Postgres (Storage engine)\nDecided: No cache';
      const citation = { conversationId: String(f.root.id), messageId, who: 'A person', at: expect.any(String), quote: shown };
      expect(await f.journal()).toEqual([
        expect.objectContaining({ id: `message-decision:${String(f.root.id)}:${messageId}:0`, kind: 'decision', phase: 'code', title: 'Storage engine', body: shown, decisions: ['Decided: Postgres (Storage engine)'], createdBy: 'device-a', sectionId: 'storage', citations: [citation] }),
        expect.objectContaining({ id: `message-decision:${String(f.root.id)}:${messageId}:1`, kind: 'decision', title: 'No cache', decisions: ['Decided: No cache'], createdBy: 'device-a', citations: [citation] }),
      ]);
      expect(f.sent).toHaveLength(1);

      await f.runtime.session(undefined, { type: 'prompt', text: 'Carry on.' }, false, 'device-a');
      await f.settle();
      expect(await f.journal()).toHaveLength(2);

      // The same message's decisions journaled again add nothing.
      await journalMessageDecisions(env, f.identity, 'code', f.sent[0]!);
      expect(await f.journal()).toHaveLength(2);
    } finally { await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('a failed journal write keeps the decisions; a later pass writes each entry exactly once and lets them go', async () => {
  await runInDurableObject(room(), async (_instance, ctx) => {
    const f = await decisionsFixture(ctx, true);
    try {
      const text = 'Ship it behind a flag.\n\nDecided: Flag (Rollout)\nDecided: Weekly (Cadence)';
      await f.runtime.session(undefined, { type: 'prompt', text, decisions: [{ title: 'Rollout', choice: 'Flag' }, { title: 'Cadence', choice: 'Weekly' }] }, false, 'device-a');
      await f.settle();
      // A later message's pass retries what is still held.
      await f.runtime.session(undefined, { type: 'prompt', text: 'Carry on.' }, false, 'device-a');
      await f.settle();
      const messageId = await f.messageId(text);
      const prefix = `message-decision:${String(f.root.id)}:${messageId}`;
      expect((await f.journal()).map(entry => entry.id)).toEqual([`${prefix}:0`, `${prefix}:1`]);
      expect(f.sent.length).toBeGreaterThan(1);
      expect(f.held()).toBe(0);
    } finally { await f.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
