import type { Context } from '@earendil-works/chord/context';
import type { ConversationId, ConversationRecord, Cursor, Storage } from '@earendil-works/pi-durable';

/** Submissions one scan reads. */
const SCAN_SUBMISSIONS = 64;
/** Request ids of block fix steps (`block-fixes.ts`) start with this: a fix step's input opens no turn. */
export const BLOCK_FIX_REQUEST = 'block-fix:';

/**
 * Where a conversation's inputs were placed, ascending, and its fork ancestors' through the fork: `openers`, where its
 * transcript turns open, and `fixes`, where its block fix steps start. The transcript reader names turns after the
 * openers (`turnRowId`) and shows nothing of a fix step: the entries from its start to the next opener that it made
 * (its input, replies and tool results). A block ask's question names the message row (`piMessageRowId`) after the
 * opener at or below the message (`openerAt`).
 */
export async function transcriptInputs(storage: Storage, conversationId: ConversationId, context: Context): Promise<{ openers: number[]; fixes: number[] }> {
  const openers: number[] = [];
  const fixes: number[] = [];
  let current: ConversationId | undefined = conversationId;
  let through = Number.POSITIVE_INFINITY;
  while (current !== undefined) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ conversationId: current }, SCAN_SUBMISSIONS, cursor, context);
      for (const record of page.items) {
        if (record.type !== 'input' || record.entry === undefined || Number(record.entry) > through) continue;
        (record.requestId?.startsWith(BLOCK_FIX_REQUEST) ? fixes : openers).push(Number(record.entry));
      }
      cursor = page.next;
    } while (cursor);
    const parent: ConversationRecord['parent'] = (await storage.conversation(current, context))?.parent;
    if (!parent) break;
    through = Math.min(through, Number(parent.at));
    current = parent.conversationId;
  }
  return { openers: openers.sort((left, right) => left - right), fixes: fixes.sort((left, right) => left - right) };
}

/** Where a conversation's transcript turns open, ascending (`transcriptInputs`). */
export async function turnOpeners(storage: Storage, conversationId: ConversationId, context: Context): Promise<number[]> {
  return (await transcriptInputs(storage, conversationId, context)).openers;
}
