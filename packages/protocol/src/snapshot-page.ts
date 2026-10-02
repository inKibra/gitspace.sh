export interface SnapshotPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Page a finite source snapshot without replaying its RPC stream. The cursor binds
 * both the resource identity and every frame, so a changed working tree/resource
 * cannot silently splice content from different reads into one result.
 */
export async function snapshotPage<T>(
  source: Iterable<T>,
  input: { identity: unknown; cursor: string | null; limit: number },
): Promise<SnapshotPage<T>> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 16) throw new Error('Snapshot page limit must be between 1 and 16');
  const values: readonly T[] = Array.isArray(source) ? source : Array.from(source);
  const bytes = new TextEncoder().encode(JSON.stringify([input.identity, values]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  let offset = 0;
  if (input.cursor !== null) {
    const match = /^([a-f0-9]{64}):([0-9]{1,16})$/u.exec(input.cursor);
    if (!match || match[1] !== hash) throw new Error('Snapshot changed or cursor belongs to another resource; restart with cursor null');
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset > values.length) throw new Error('Snapshot cursor is outside this resource');
  }
  // Leave room for result-rpc framing, the cursor, and MCP's result envelope.
  const maxBytes = 900 * 1024;
  const encoder = new TextEncoder();
  let end = offset;
  let pageBytes = 0;
  while (end < values.length && end - offset < input.limit) {
    const frameBytes = encoder.encode(JSON.stringify(values[end])).byteLength;
    if (frameBytes > maxBytes) throw new Error('A source frame exceeds the page limit; read a narrower resource selection');
    if (pageBytes + frameBytes > maxBytes) break;
    pageBytes += frameBytes;
    end++;
  }
  return { items: values.slice(offset, end), nextCursor: end < values.length ? `${hash}:${end}` : null };
}
