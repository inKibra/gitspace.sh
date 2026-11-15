// Transcript row ids: the reducer names turns and message rows with these, the workspace's transcript reader names a pi
// conversation's session and event ordinals with them, and a block ask's question names the message row it is in.

/** A pi entry's event and row ordinals are `entryId * PI_ENTRY_ORDINALS + n`; one entry's never collide with the next. */
export const PI_ENTRY_ORDINALS = 1024;

/** The transcript session of one pi conversation. */
export function piSessionId(conversationId: string): string {
  return `pi:${conversationId}`;
}

/** A turn's id: its session and the ordinal of the event that opened it. */
export function turnRowId(sessionId: string, ordinal: number): string {
  return `${sessionId}:turn:${ordinal}`;
}

/** The row of one content part of a message: its turn, the message's ordinal and the part's index. */
export function messageRowId(turnId: string, messageOrdinal: number, part: number): string {
  return `${turnId}:message:${messageOrdinal}:${part}`;
}

/** The newest turn opener (ascending entry ids where inputs were placed) at or below `entry`; undefined before the first. */
export function openerAt(openers: readonly number[], entry: number): number | undefined {
  let low = 0;
  let high = openers.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = openers[middle];
    if (value === undefined) break;
    if (value <= entry) { found = value; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

/** The row the transcript reader shows content part `part` of model message `message` of pi entry `entry` as, in the
 * turn its input at entry `opener` opened. */
export function piMessageRowId(conversationId: string, opener: number, entry: number, message: number, part: number): string {
  return messageRowId(turnRowId(piSessionId(conversationId), opener * PI_ENTRY_ORDINALS), entry * PI_ENTRY_ORDINALS + message, part);
}
