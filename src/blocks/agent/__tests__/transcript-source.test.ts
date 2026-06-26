import { describe, expect, it } from 'bun:test';
import type { Message } from '@oh-my-pi/pi-ai';

import { validateBlock } from '../../index.js';
import { entriesToBlocks, getTranscriptRange, type TranscriptEntry, type TranscriptSource } from '../transcript-source.js';

function msgEntry(id: string, parentId: string | null, message: unknown): TranscriptEntry {
  return { id, parentId, type: 'message', message: message as Message };
}

// A linear branch: root e0 → e1 → e2 → e3 (leaf).
const ENTRIES: TranscriptEntry[] = [
  msgEntry('e0', null, { role: 'user', content: 'hello', timestamp: 0 }),
  msgEntry('e1', 'e0', { role: 'assistant', content: [{ type: 'text', text: 'hi there' }], timestamp: 0 }),
  { id: 'e2', parentId: 'e1', type: 'compaction', summary: 'earlier stuff', shortSummary: 'compacted' },
  msgEntry('e3', 'e2', { role: 'user', content: 'continue', timestamp: 0 }),
];

function source(entries: TranscriptEntry[], leafId: string | null): TranscriptSource {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return { getLeafId: () => leafId, getEntry: (id) => byId.get(id) };
}

describe('entriesToBlocks', () => {
  it('maps message entries and renders compaction as a marker', () => {
    const blocks = entriesToBlocks(ENTRIES);
    const types = blocks.map((b) => b.type);
    expect(types).toContain('message');
    expect(types).toContain('callout'); // the compaction marker
    for (const b of blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('keys message block ids by entry id (stable across pages)', () => {
    const blocks = entriesToBlocks([ENTRIES[0]]);
    expect(blocks[0].id).toContain('e0');
  });
});

describe('getTranscriptRange', () => {
  const src = source(ENTRIES, 'e3');

  it('tail: returns the newest page in display order with a cursor', () => {
    const page = getTranscriptRange(src, { limit: 2 });
    // newest two entries: e3 (user) + e2 (compaction), display order e2 → e3
    expect(page.oldestCursor).toBe('e2');
    expect(page.hasMore).toBe(true);
    expect(page.blocks.length).toBeGreaterThan(0);
    for (const b of page.blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('older: paginates before a cursor and reports end of history', () => {
    const older = getTranscriptRange(src, { before: 'e2', limit: 10 });
    // entries before e2: e1 then e0 (root)
    expect(older.oldestCursor).toBe('e0');
    expect(older.hasMore).toBe(false); // e0 has no parent
    expect(older.blocks.some((b) => b.type === 'message')).toBe(true);
  });

  it('returns an empty page past the root', () => {
    const page = getTranscriptRange(src, { before: 'e0', limit: 5 });
    expect(page.blocks).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.oldestCursor).toBeNull();
  });

  it('handles an empty session (no leaf)', () => {
    const page = getTranscriptRange(source([], null), { limit: 5 });
    expect(page.blocks).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});
