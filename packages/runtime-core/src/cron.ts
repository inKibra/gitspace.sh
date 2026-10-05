import type { Harness, Storage, Cursor, Conversation } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CronRequestsDoc, CronScopeDoc } from './documents.js';
import type { RuntimeHarnessOptions } from './harness.js';
export type RuntimeCronInput = { requestId: string; text: string; readScopes: string[]; writeScopes: string[] };
export type RuntimeRequestStatus = { state: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted'; conversationId: string | null; message: string | null };
export function createCronRuntime(options: Pick<RuntimeHarnessOptions, 'admitInference'> & { harness: Harness; storage: Storage; wake(): Promise<void> }) {
  const context = BACKGROUND_CONTEXT;
  async function conversation(id: string): Promise<Conversation> {
    let cursor: Cursor | undefined;
    do { const page = await options.storage.scanConversations({}, 128, cursor, context); const record = page.items.find(item => String(item.id) === id); if (record) { const target = await options.harness.conversation(record.id, context); if (target) return target; } cursor = page.next; } while (cursor);
    throw new Error('Cron conversation missing');
  }
  return {
    async submit(input: RuntimeCronInput): Promise<{ conversationId: string }> {
      const id = await options.harness.commit(async tx => {
        const requests = await tx.doc(CronRequestsDoc);
        const prior = requests.requests[input.requestId];
        if (prior) {
          if (prior.text !== input.text || JSON.stringify(prior.readScopes) !== JSON.stringify(input.readScopes) || JSON.stringify(prior.writeScopes) !== JSON.stringify(input.writeScopes)) throw new Error('Cron request identity changed');
          return prior.conversationId;
        }
        const created = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        const scope = await tx.doc(CronScopeDoc, created.id); scope.constrained = true; scope.readScopes = input.readScopes; scope.writeScopes = input.writeScopes;
        requests.requests[input.requestId] = { conversationId: String(created.id), text: input.text, readScopes: input.readScopes, writeScopes: input.writeScopes };
        return String(created.id);
      }, context);
      const target = await conversation(id);
      const model = await options.admitInference({ conversationId: id, requestId: input.requestId });
      await target.configure({ model }, context);
      await target.submit({ type: 'input', content: input.text, requestId: input.requestId }, context);
      await options.wake();
      return { conversationId: id };
    },
    async status(requestId: string): Promise<RuntimeRequestStatus> {
      const requests = await options.harness.snapshot(CronRequestsDoc, context);
      const record = requests?.requests[requestId];
      if (!record) return { state: 'pending', conversationId: null, message: null };
      const target = await conversation(record.conversationId);
      const submission = await target.commit(tx => tx.submissionByRequest(target.id, requestId), context);
      if (!submission) return { state: 'pending', conversationId: record.conversationId, message: null };
      return { state: submission.status === 'done' ? 'succeeded' : submission.status === 'unanswered' ? 'failed' : submission.status === 'placed' ? 'running' : 'pending', conversationId: record.conversationId, message: submission.status === 'unanswered' ? submission.reason : null };
    },
  };
}
