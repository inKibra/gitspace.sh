import type { Context } from '@earendil-works/chord/context';
import type { ConversationId, ConversationRecord, Cursor, Storage } from '@earendil-works/pi-durable';

/** Submissions one scan reads. */
const SCAN_SUBMISSIONS = 64;

/**
 * Where a conversation's transcript turns open, ascending: the entries its inputs were placed at, and its fork
 * ancestors' through the fork. The transcript reader names turns after them (`turnRowId`), and a block ask's question
 * names the message row (`piMessageRowId`) after the one at or below the message (`openerAt`).
 */
export async function turnOpeners(storage: Storage, conversationId: ConversationId, context: Context): Promise<number[]> {
  const ids: number[] = [];
  let current: ConversationId | undefined = conversationId;
  let through = Number.POSITIVE_INFINITY;
  while (current !== undefined) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ conversationId: current }, SCAN_SUBMISSIONS, cursor, context);
      for (const record of page.items) if (record.type === 'input' && record.entry !== undefined && Number(record.entry) <= through) ids.push(Number(record.entry));
      cursor = page.next;
    } while (cursor);
    const parent: ConversationRecord['parent'] = (await storage.conversation(current, context))?.parent;
    if (!parent) break;
    through = Math.min(through, Number(parent.at));
    current = parent.conversationId;
  }
  return ids.sort((left, right) => left - right);
}
