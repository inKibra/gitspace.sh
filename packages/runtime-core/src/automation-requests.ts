import { InboxDoc, type Harness, type Storage, type Cursor, type Conversation, type ConversationId, type ModelRef } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AutomationRequestsDoc } from './documents.js';
import { applyInferenceThinking, selectRole, SessionControlsDoc } from './session-controls.js';
import type { RuntimeHarnessOptions } from './harness.js';

/** An automation run's instruction to the main conversation; its request id makes a retried submission deliver it once.
 * `role` (a workspace an automation started) becomes the conversation's model role with this first run. */
export type RuntimeAutomationInput = { requestId: string; text: string; role?: string };
export type RuntimeRequestStatus = { state: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'withdrawn'; conversationId: string | null; message: string | null };

/** Request tracking for automation runs: idempotent submission by request id, status, withdraw and cancel. */
export function createAutomationRequests(options: Pick<RuntimeHarnessOptions, 'admitInference'> & { harness: Harness; storage: Storage; configureModel(conversationId: ConversationId, model: ModelRef): Promise<void>; wake(): Promise<void>; stop?(conversationId: string): Promise<void> }) {
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
    throw new Error('Automation conversation missing');
  }
  const api = {
    submit(input: RuntimeAutomationInput): Promise<{ conversationId: string }> { return serialized(async () => {
      const root = await options.harness.root(context);
      const id = await options.harness.commit(async tx => {
        const requests = await tx.doc(AutomationRequestsDoc);
        const prior = requests.requests[input.requestId];
        if (prior) {
          if (prior.text !== input.text) throw new Error('Automation request identity changed');
          return prior.conversationId;
        }
        if (await tx.submissionByRequest(root.id, input.requestId)) throw new Error('Automation request identity conflicts with an existing submission');
        requests.requests[input.requestId] = { conversationId: String(root.id), text: input.text };
        return String(root.id);
      }, context);
      const target = await conversation(id);
      const saved = await options.harness.snapshot(AutomationRequestsDoc, context);
      if (saved?.requests[input.requestId]?.withdrawn || saved?.withdrawnRequests?.includes(input.requestId)) return { conversationId: id };
      const existing = await target.commit(tx => tx.submissionByRequest(target.id, input.requestId), context);
      if (!existing) {
        const { role } = input;
        // The role is admitted before it is selected: one the profile no longer has refuses the run and changes nothing.
        const selection = role === undefined ? (await options.harness.snapshot(SessionControlsDoc, target.id, context))?.selection ?? { kind: 'default' as const } : { kind: 'role' as const, role };
        const model = await options.admitInference({ conversationId: id, requestId: input.requestId, selection });
        if (role !== undefined) await target.commit(async tx => { const controls = await tx.doc(SessionControlsDoc, target.id); selectRole(controls, role); controls.revision++; }, context);
        await options.configureModel(target.id, model);
        await applyInferenceThinking(target, model);
        await target.submit({ type: 'input', content: input.text, requestId: input.requestId, whenBusy: 'followUp' }, context);
      }
      await options.wake();
      return { conversationId: id };
    }); },
    async status(requestId: string): Promise<RuntimeRequestStatus> {
      const requests = await options.harness.snapshot(AutomationRequestsDoc, context);
      const record = requests?.requests[requestId];
      if (!record) return { state: requests?.withdrawnRequests?.includes(requestId) ? 'withdrawn' : 'pending', conversationId: null, message: null };
      const target = await conversation(record.conversationId);
      return target.commit(async tx => {
        const submission = await tx.submissionByRequest(target.id, requestId);
        if (record.withdrawn || requests?.withdrawnRequests?.includes(requestId)) return { state: 'withdrawn', conversationId: record.conversationId, message: 'Withdrawn before execution' };
        if (!submission) return { state: 'pending', conversationId: record.conversationId, message: null };
        return { state: submission.status === 'done' ? 'succeeded' : submission.status === 'unanswered' ? submission.reason === 'withdrawn' ? 'withdrawn' : 'failed' : submission.status === 'placed' ? 'running' : 'queued', conversationId: record.conversationId, message: submission.status === 'unanswered' ? submission.reason : null };
      }, context);
    },
    withdraw(requestId: string): Promise<RuntimeRequestStatus> { return serialized(async () => {
      const requests = await options.harness.snapshot(AutomationRequestsDoc, context);
      const record = requests?.requests[requestId];
      if (!record) {
        await options.harness.commit(async tx => {
          const requests = await tx.doc(AutomationRequestsDoc);
          requests.withdrawnRequests ??= [];
          if (!requests.withdrawnRequests.includes(requestId)) requests.withdrawnRequests.push(requestId);
        }, context);
        return api.status(requestId);
      }
      const target = await conversation(record.conversationId);
      await target.commit(async tx => {
        const submission = await tx.submissionByRequest(target.id, requestId);
        if (submission && submission.status !== 'queued') return;
        const current = (await tx.doc(AutomationRequestsDoc)).requests[requestId]!;
        current.withdrawn = true;
        if (submission) {
          tx.settleSubmission(submission.id, { status: 'unanswered', reason: 'withdrawn' });
          const inbox = await tx.doc(InboxDoc, target.id);
          inbox.items = inbox.items.filter(item => item.id !== submission.id);
        }
      }, context);
      return api.status(requestId);
    }); },
    async cancel(requestId: string): Promise<RuntimeRequestStatus> {
      const receipt = await api.withdraw(requestId);
      if (receipt.state !== 'running') return receipt;
      if (!options.stop || receipt.conversationId === null) throw new Error('Workspace Stop is unavailable');
      // Only a person's cancel stops the shared agent; an expired queue withdraws.
      await options.stop(receipt.conversationId);
      return api.status(requestId);
    },
  };
  return api;
}
