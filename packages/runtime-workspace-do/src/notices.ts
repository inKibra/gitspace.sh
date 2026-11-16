import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import { boundedReplay } from '@gitspace/runtime-core';

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
