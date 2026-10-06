import { InboxDoc, LiveDoc, type Harness, type Storage, type Cursor, type Conversation, type ConversationId, type ModelRef, type ToolExecutionApi, type Tx, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import { CronRequestsDoc, CronScopeDoc, type CronScope } from './documents.js';
import { SessionControlsDoc } from './session-controls.js';
import type { RuntimeHarnessOptions } from './harness.js';
import { PROJECT_CRON_OVERDUE_MS } from '@gitspace/protocol/cron-contract';
export type RuntimeCronInput = { requestId: string; text: string; readScopes: string[]; writeScopes: string[] };
export type RuntimeRequestStatus = { state: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'withdrawn'; conversationId: string | null; message: string | null; startedAt?: number };
type CronApi = Pick<ToolExecutionApi, 'commit' | 'conversationId' | 'taskId'>;

export async function cronHasOutstanding(tx: Tx, conversationId: ConversationId): Promise<boolean> {
  const requests = await tx.doc(CronRequestsDoc);
  for (const [requestId, request] of Object.entries(requests.requests)) {
    if (request.conversationId !== String(conversationId) || request.withdrawn || requests.withdrawnRequests?.includes(requestId)) continue;
    const submission = await tx.submissionByRequest(conversationId, requestId);
    if (!submission || (submission.status !== 'done' && submission.status !== 'unanswered')) return true;
  }
  return false;
}
/** Capture each request's constraints on the generation that actually consumes its durable submission. */
export async function bindCronGeneration(harness: Harness, api: Pick<CronApi, 'conversationId' | 'taskId'>, context: Context): Promise<void> {
  await harness.commit(async tx => {
    const live = await tx.doc(LiveDoc, api.conversationId);
    if (live.run?.taskId !== api.taskId) throw new Error('Cron scope requires the current generation');
    const scopes = await tx.doc(CronScopeDoc, api.conversationId);
    const requests = await tx.doc(CronRequestsDoc);
    const active: CronScope[] = scopes.inherited.map(scope => ({ readScopes: [...scope.readScopes], writeScopes: [...scope.writeScopes] }));
    for (const [requestId, request] of Object.entries(requests.requests)) {
      if (request.conversationId !== String(api.conversationId)) continue;
      const submission = await tx.submissionByRequest(api.conversationId, requestId);
      if (submission && live.run.inputs.includes(submission.id)) {
        request.startedAt ??= Date.now();
        active.push({ readScopes: [...request.readScopes], writeScopes: [...request.writeScopes] });
      }
    }
    if (active.length > scopes.inherited.length && live.run.inputs.length !== 1) throw new Error('Cron submission must have an isolated generation');
    scopes.generations[String(api.taskId)] = active;
  }, context);
}

/** Follow immutable task ownership, never the mutable conversation's currently running input. */
export async function cronTaskScopes(tx: Tx, conversationId: ConversationId, taskId: TaskId): Promise<CronScope[]> {
  const scopes = await tx.doc(CronScopeDoc, conversationId);
  let task = await tx.task(taskId);
  while (task) {
    const active = scopes.generations[String(task.id)];
    if (active) return active.map(scope => ({ readScopes: [...scope.readScopes], writeScopes: [...scope.writeScopes] }));
    if (task.owner === undefined) break;
    task = await tx.task(task.owner);
  }
  return scopes.inherited.map(scope => ({ readScopes: [...scope.readScopes], writeScopes: [...scope.writeScopes] }));
}
export async function cronToolScopes(api: CronApi, context: Context): Promise<CronScope[]> {
  return api.commit(tx => cronTaskScopes(tx, api.conversationId, api.taskId), context);
}

export function createCronRuntime(options: Pick<RuntimeHarnessOptions, 'admitInference'> & { harness: Harness; storage: Storage; configureModel(conversationId: ConversationId, model: ModelRef): Promise<void>; wake(): Promise<void>; stop?(conversationId: string): Promise<void> }) {
  const context = BACKGROUND_CONTEXT;
  let line: Promise<void> = Promise.resolve();
  async function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = line;
    const released = Promise.withResolvers<void>();
    line = released.promise;
    await previous;
    try { return await operation(); } finally { released.resolve(); }
  }
  async function conversation(id: string): Promise<Conversation> {
    let cursor: Cursor | undefined;
    do { const page = await options.storage.scanConversations({}, 128, cursor, context); const record = page.items.find(item => String(item.id) === id); if (record) { const target = await options.harness.conversation(record.id, context); if (target) return target; } cursor = page.next; } while (cursor);
    throw new Error('Cron conversation missing');
  }
  const api = {
    submit(input: RuntimeCronInput): Promise<{ conversationId: string }> { return serialized(async () => {
      const root = await options.harness.root(context);
      const id = await options.harness.commit(async tx => {
        const requests = await tx.doc(CronRequestsDoc);
        const prior = requests.requests[input.requestId];
        if (prior) {
          if (prior.text !== input.text || JSON.stringify(prior.readScopes) !== JSON.stringify(input.readScopes) || JSON.stringify(prior.writeScopes) !== JSON.stringify(input.writeScopes)) throw new Error('Cron request identity changed');
          return prior.conversationId;
        }
        if (await tx.submissionByRequest(root.id, input.requestId)) throw new Error('Cron request identity conflicts with an existing submission');
        const inbox = await tx.doc(InboxDoc, root.id);
        for (const item of inbox.items) if (item.mode === 'steer') item.mode = 'followUp';
        await tx.appendEntry(root.id, { kind: 'gitspace.cron-start', data: { requestId: input.requestId } });
        requests.requests[input.requestId] = { conversationId: String(root.id), text: input.text, readScopes: [...input.readScopes], writeScopes: [...input.writeScopes] };
        return String(root.id);
      }, context);
      const target = await conversation(id);
      const saved = await options.harness.snapshot(CronRequestsDoc, context);
      if (saved?.requests[input.requestId]?.withdrawn || saved?.withdrawnRequests?.includes(input.requestId)) return { conversationId: id };
      const existing = await target.commit(tx => tx.submissionByRequest(target.id, input.requestId), context);
      if (!existing) {
        const selection = (await options.harness.snapshot(SessionControlsDoc, target.id, context))?.selection ?? { kind: 'default' as const };
        const model = await options.admitInference({ conversationId: id, requestId: input.requestId, selection });
        await options.configureModel(target.id, model);
        await target.submit({ type: 'input', content: `[Scheduled cron: ${input.requestId}]\n${input.text}`, requestId: input.requestId, whenBusy: 'followUp' }, context);
      }
      await options.wake();
      return { conversationId: id };
    }); },
    async status(requestId: string): Promise<RuntimeRequestStatus> {
      const requests = await options.harness.snapshot(CronRequestsDoc, context);
      const record = requests?.requests[requestId];
      if (!record) return { state: requests?.withdrawnRequests?.includes(requestId) ? 'withdrawn' : 'pending', conversationId: null, message: null };
      const target = await conversation(record.conversationId);
      return target.commit(async tx => {
        const submission = await tx.submissionByRequest(target.id, requestId);
        if (record.withdrawn || requests?.withdrawnRequests?.includes(requestId)) return { state: 'withdrawn', conversationId: record.conversationId, message: 'Withdrawn before execution' };
        if (!submission) return { state: 'pending', conversationId: record.conversationId, message: null };
        const current = (await tx.doc(CronRequestsDoc)).requests[requestId]!;
        if (submission.status === 'placed') current.startedAt ??= Date.now();
        return { state: submission.status === 'done' ? 'succeeded' : submission.status === 'unanswered' ? submission.reason === 'withdrawn' ? 'withdrawn' : 'failed' : submission.status === 'placed' ? 'running' : 'queued', conversationId: record.conversationId, message: submission.status === 'unanswered' ? submission.reason : null, ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt }) };
      }, context);
    },
    withdraw(requestId: string): Promise<RuntimeRequestStatus> { return serialized(async () => {
      const requests = await options.harness.snapshot(CronRequestsDoc, context);
      const record = requests?.requests[requestId];
      if (!record) {
        await options.harness.commit(async tx => {
          const requests = await tx.doc(CronRequestsDoc);
          requests.withdrawnRequests ??= [];
          if (!requests.withdrawnRequests.includes(requestId)) requests.withdrawnRequests.push(requestId);
        }, context);
        return api.status(requestId);
      }
      const target = await conversation(record.conversationId);
      await target.commit(async tx => {
        const submission = await tx.submissionByRequest(target.id, requestId);
        if (submission && submission.status !== 'queued') return;
        const current = (await tx.doc(CronRequestsDoc)).requests[requestId]!;
        current.withdrawn = true;
        if (submission) {
          tx.settleSubmission(submission.id, { status: 'unanswered', reason: 'withdrawn' });
          const inbox = await tx.doc(InboxDoc, target.id);
          inbox.items = inbox.items.filter(item => item.id !== submission.id);
        }
      }, context);
      return api.status(requestId);
    }); },
    async cancel(requestId: string, confirmStopWorkspaceAgent: boolean): Promise<RuntimeRequestStatus> {
      const receipt = await api.withdraw(requestId);
      if (receipt.state !== 'running') return receipt;
      if (confirmStopWorkspaceAgent !== true) throw new Error('Running cron requires explicit confirmation to Stop workspace agent');
      if (!options.stop || receipt.conversationId === null) throw new Error('Workspace Stop is unavailable');
      // Only this explicit user action can stop the shared agent; scheduler uses withdraw.
      await options.stop(receipt.conversationId);
      return api.status(requestId);
    },
    async notifyOverdue(requestId: string): Promise<void> {
      const receipt = await api.status(requestId);
      if (receipt.state !== 'running' || receipt.conversationId === null || receipt.startedAt === undefined || Date.now() - receipt.startedAt < PROJECT_CRON_OVERDUE_MS) return;
      const target = await conversation(receipt.conversationId);
      await target.commit(async tx => {
        const record = (await tx.doc(CronRequestsDoc)).requests[requestId];
        const submission = await tx.submissionByRequest(target.id, requestId);
        if (!record || record.overdueNotified || submission?.status !== 'placed') return;
        record.overdueNotified = true;
        await tx.appendEntry(target.id, { kind: 'gitspace.cron-overdue', data: { requestId, text: 'Scheduled cron is overdue after one hour of execution. The workspace agent has not been stopped.' } });
      }, context);
    },
  };
  return api;
}
