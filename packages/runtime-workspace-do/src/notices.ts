import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AssistantEntry, defineDoc, type ConversationId, type EntryRecord, type Harness } from '@earendil-works/pi-durable';
import { boundedReplay, invalidBlocksNotice } from '@gitspace/runtime-core';

// Retain the persisted document kind so acknowledged cache notices are not emitted again.
export const CacheNoticesDoc = defineDoc<{ seen: Record<string, boolean> }>({ kind: 'gitspace.replica-notices', version: 1, scope: 'session', initial: () => ({ seen: {} }), checkpointWhen: boundedReplay });

/** Appends a line to a conversation that its agent reads on its next turn; it starts none. A `key` appends it at most
 * once, across restarts too. `source` labels it. */
export async function appendNotice(harness: Harness, conversationId: ConversationId, text: string, key?: string, source = 'Machine'): Promise<void> {
  await harness.commit(async tx => {
    if (key) {
      const seen = await tx.doc(CacheNoticesDoc);
      if (seen.seen[key]) return;
      seen.seen[key] = true;
    }
    await tx.appendEntry(conversationId, { kind: 'gitspace.machine-notice', data: { source }, model: [{ role: 'user', content: text, timestamp: Date.now() }] });
  }, BACKGROUND_CONTEXT);
}

/** An assistant message whose blocks do not validate: its agent gets a "Blocks" notice naming them, once per message
 * (keyed by the message's entry), so it can send corrected blocks. Any other entry posts nothing. */
export async function noticeInvalidBlocks(harness: Harness, entry: EntryRecord): Promise<void> {
  const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
  if (message?.role !== 'assistant') return;
  const text = invalidBlocksNotice(message.content);
  if (text !== null) await appendNotice(harness, entry.conversationId, text, `blocks:${String(entry.conversationId)}:${String(entry.id)}`, 'Blocks');
}
