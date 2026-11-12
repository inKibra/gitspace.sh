import { InboxDoc, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';

/**
 * Watches the conversation's inbox for a message waiting to steer it. pi places a steer after the tool round, so a call
 * that waits on something else (a command, a process, a person) holds the steer back for as long as it waits: such a
 * call stops waiting once `steered` resolves. `steered` rejects if the watch fails; `stop` ends the watch.
 */
export async function watchSteer(api: Pick<ToolExecutionApi, 'conversationId' | 'watchDoc'>, context: Context): Promise<{ steered: Promise<void>; stop(): Promise<void> }> {
  const steered = Promise.withResolvers<void>();
  // A failure after the caller stopped waiting has no one to tell.
  steered.promise.catch(() => {});
  const inbox = await api.watchDoc(InboxDoc, api.conversationId, context);
  if (!inbox) return { steered: steered.promise, stop: async () => {} };
  const check = (value: typeof inbox.value) => { if (value?.items.some(item => item.mode === 'steer')) steered.resolve(); };
  check(inbox.value);
  inbox.start(async call => { if (call.kind === 'value') check(call.value); });
  void inbox.closed.then(end => {
    if (end.kind === 'listener_error' || end.kind === 'failed') steered.reject(end.error);
    else if (end.kind !== 'stopped') steered.reject(new Error(`Inbox watch ${end.kind}`));
  });
  return { steered: steered.promise, stop: async () => { await inbox.stop(); } };
}
