import type { TranscriptEvent } from '@gitspace/protocol/transcript';

export interface LegacySessionTree {
  leafEntryId: string | null;
  entries: number;
  messages: number;
  branchEntries: number;
  branchMessages: number;
  leaves: number;
}

type Entry = Record<string, unknown> & { id: string; parentId: string | null };
type Source = () => AsyncIterable<Uint8Array>;

/** Decode bounded fragments: a chunk can split a UTF-8 character or a JSONL record. */
async function* records(source: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fragments: string[] = [];
  function parse(text: string): Record<string, unknown> | null {
    if (!text.trim()) return null;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved session record is invalid');
    return value as Record<string, unknown>;
  }
  function* accept(text: string): Generator<Record<string, unknown>> {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end === -1) break;
      fragments.push(text.slice(start, end));
      const value = parse(fragments.join(''));
      fragments.length = 0;
      if (value) yield value;
      start = end + 1;
    }
    const remaining = text.slice(start);
    // Indentation before a record is insignificant; do not retain huge blank padding.
    if (fragments.length || remaining.trim()) fragments.push(remaining);
  }
  for await (const bytes of source) {
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      yield* accept(decoder.decode(bytes.subarray(offset, offset + 64 * 1024), { stream: true }));
    }
  }
  yield* accept(decoder.decode());
  const value = parse(fragments.join(''));
  if (value) yield value;
}

async function* entries(source: Source, ompSessionId: string): AsyncGenerator<Entry> {
  let header = false;
  let first = true;
  for await (const record of records(source())) {
    if (first && record.type === 'title' && record.v === 1) { first = false; continue; }
    first = false;
    if (!header) {
      if (record.type !== 'session' || record.version !== 3 || record.id !== ompSessionId) throw new Error('Saved session needs an OMP-compatible reader for its format');
      header = true;
      continue;
    }
    if (typeof record.id !== 'string' || (record.parentId !== null && typeof record.parentId !== 'string')) throw new Error('Saved session tree is invalid');
    if (record.type === 'message' || record.type === 'custom' || record.type === 'custom_message') {
      if (typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp))) throw new Error('Saved session timestamp is invalid');
      if (record.type === 'message' && (!record.message || typeof record.message !== 'object' || Array.isArray(record.message))) throw new Error('Saved message is invalid');
      if ((record.type === 'custom' || record.type === 'custom_message') && typeof record.customType !== 'string') throw new Error('Saved custom event is invalid');
    }
    yield record as Entry;
  }
  if (!header) throw new Error('Saved session needs an OMP-compatible reader for its format');
}

/** First retain only tree links, then re-read immutable bytes to project the selected branch.
 * OMP JSONL is append-only: parents precede children. No message bodies survive the scan. */
export async function openLegacySession(source: Source, sessionId: string, ompSessionId: string): Promise<{ tree: LegacySessionTree; events: AsyncIterable<TranscriptEvent> }> {
  const parents = new Map<string, string | null>();
  const messages = new Set<string>();
  const leaves = new Set<string>();
  let leaf: string | null = null;
  for await (const entry of entries(source, ompSessionId)) {
    if (parents.has(entry.id)) throw new Error('Saved session tree is invalid');
    if (entry.parentId !== null && !parents.has(entry.parentId)) throw new Error('Saved session branch is incomplete');
    parents.set(entry.id, entry.parentId);
    if (entry.type === 'message') messages.add(entry.id);
    if (entry.parentId !== null) leaves.delete(entry.parentId);
    leaves.add(entry.id);
    leaf = entry.id;
  }
  const branch = new Set<string>();
  let branchMessages = 0;
  for (let id = leaf; id !== null; id = parents.get(id)!) {
    branch.add(id);
    if (messages.has(id)) branchMessages++;
  }
  const tree: LegacySessionTree = { leafEntryId: leaf, entries: parents.size, messages: messages.size, branchEntries: branch.size, branchMessages, leaves: leaves.size };
  async function* events(): AsyncGenerator<TranscriptEvent> {
    let ordinal = 0;
    for await (const entry of entries(source, ompSessionId)) {
      if (!branch.has(entry.id) || (entry.type !== 'message' && entry.type !== 'custom' && entry.type !== 'custom_message')) continue;
      let payload: Record<string, unknown>;
      if (entry.type === 'message') payload = { message: entry.message };
      else if (entry.type === 'custom_message') {
        const { type: _type, id: _id, parentId: _parentId, timestamp: _timestamp, ...message } = entry;
        payload = { message: { ...message, role: 'custom' } };
      } else payload = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data as Record<string, unknown> : { value: entry.data };
      yield { sessionId, ordinal: ++ordinal, kind: entry.type === 'custom' ? entry.customType as string : 'message_end', payload, createdAt: new Date(entry.timestamp as string) };
    }
  }
  return { tree, events: events() };
}
