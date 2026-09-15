import type { SessionHistoryEntry, SessionHistoryPage, SessionHistoryPageRequest } from './history-contract.js';
import { agentHistoryError } from './errors.js';
const historyEncoder = new TextEncoder();
const historyDecoder = new TextDecoder('utf-8', { fatal: true });

const HISTORY_ROWS = 64;
const PROMPT_CHARACTERS = 4096;
const PROMPT_CACHE_CHARACTERS = 32 * 1024;
export const SESSION_HISTORY_SIDE_ROWS = 200;
export const SESSION_HISTORY_RAW_STEPS = 2000;
export const SESSION_HISTORY_PAGE_BYTES = 256 * 1024;
export const SESSION_HISTORY_PREVIEW_CHARACTERS = 1024;
// Includes both opaque cursors and the anchor even for maximally escaped IDs.
const PAGE_CONTENT_BYTES = SESSION_HISTORY_PAGE_BYTES - 64 * 1024;

/** Prompt recall must never silently substitute truncated text for the original. */
export function boundSessionControl<T extends { history: Array<{ entryId: string; text: string }> }>(control: T): T {
  const history: T['history'] = [];
  let characters = 0;
  for (let index = control.history.length - 1; index >= 0 && history.length < HISTORY_ROWS && control.history.length - index <= 256; index--) {
    const entry = control.history[index]!;
    if (entry.text.length > PROMPT_CHARACTERS || characters + entry.text.length > PROMPT_CACHE_CHARACTERS) continue;
    history.push(entry);
    characters += entry.text.length;
  }
  history.reverse();
  return { ...control, history };
}

export interface HistorySourceEntry {
  id: string;
  parentId: string | null;
  sequence: number;
  role: 'user' | 'assistant' | null;
  preview: string;
  tools: number;
  childCount: number;
}

/** All lookups are indexed; implementations must not read the source event body. */
export interface SessionHistorySource {
  entry(id: string): HistorySourceEntry | null;
  children(parentId: string | null, sequence: number | null, direction: 'before' | 'after', limit: number): HistorySourceEntry[];
}

type Direction = 'before' | 'after';
interface HistoryCursor {
  v: 1;
  anchorId: string | null;
  kind: 'path' | 'children';
  direction: Direction;
  nextId: string;
  backId: string | null;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function encodeCursor(anchorId: string | null, kind: HistoryCursor['kind'], direction: Direction, nextId: string | null, backId: string | null = null): string | null {
  if (nextId === null) return null;
  const bytes = historyEncoder.encode(JSON.stringify({ v: 1, anchorId, kind, direction, nextId, backId } satisfies HistoryCursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor(request: SessionHistoryPageRequest): HistoryCursor | null {
  if (request.anchorId !== null && !validId(request.anchorId)) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history anchor');
  if (!['around', 'before', 'after', 'children'].includes(request.direction)) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history direction');
  if (request.cursor === null) {
    if (request.direction === 'before' || request.direction === 'after') throw agentHistoryError('AGENT_HISTORY_INVALID', 'Session history cursor is required');
    return null;
  }
  if (request.direction === 'around' || typeof request.cursor !== 'string' || request.cursor.length > 32 * 1024 || !/^[A-Za-z0-9_-]+$/u.test(request.cursor)) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history cursor');
  let cursor: HistoryCursor;
  try { cursor = JSON.parse(historyDecoder.decode(Uint8Array.from(atob(request.cursor.replace(/-/gu, '+').replace(/_/gu, '/')), (character) => character.charCodeAt(0)))) as HistoryCursor; } catch { throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history cursor'); }
  if (!cursor || cursor.v !== 1 || cursor.anchorId !== request.anchorId
    || !['path', 'children'].includes(cursor.kind) || !['before', 'after'].includes(cursor.direction)
    || !validId(cursor.nextId) || (cursor.backId !== null && !validId(cursor.backId))
    || (request.direction === 'children' ? cursor.kind !== 'children' : cursor.direction !== request.direction)) {
    throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history cursor');
  }
  return cursor;
}

function historyEntry(row: HistorySourceEntry, currentLeaf: string | null): SessionHistoryEntry {
  if (!validId(row.id) || (row.parentId !== null && !validId(row.parentId))) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history entry ID');
  return { ...row, role: row.role ?? 'branch', current: row.id === currentLeaf };
}

/** Bounds previews once during source ingestion, never by decoding full events on page reads. */
export function sourceHistoryMetadata(message: unknown): Pick<HistorySourceEntry, 'role' | 'preview' | 'tools'> {
  if (!message || typeof message !== 'object' || !('role' in message) || (message.role !== 'user' && message.role !== 'assistant')) {
    return { role: null, preview: '', tools: 0 };
  }
  const content = 'content' in message ? message.content : undefined;
  let preview = '';
  let tools = 0;
  if (typeof content === 'string') preview = content.slice(0, SESSION_HISTORY_PREVIEW_CHARACTERS);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'toolCall') tools++;
      if (part.type === 'text' && typeof part.text === 'string' && preview.length < SESSION_HISTORY_PREVIEW_CHARACTERS) {
        preview += `${preview ? '\n' : ''}${part.text.slice(0, SESSION_HISTORY_PREVIEW_CHARACTERS - preview.length)}`;
        preview = preview.slice(0, SESSION_HISTORY_PREVIEW_CHARACTERS);
      }
    }
  }
  return { role: message.role, preview, tools };
}

/** Around a raw SDK entry: ancestry before it, unambiguous continuation after it. */
export function pageSessionHistory(source: SessionHistorySource, request: SessionHistoryPageRequest, currentLeaf: string | null): SessionHistoryPage {
  const cursor = decodeCursor(request);
  const anchor = request.anchorId === null ? null : source.entry(request.anchorId);
  if (request.anchorId !== null && !anchor) throw agentHistoryError('AGENT_HISTORY_UNAVAILABLE', 'Session history anchor is unavailable', { anchorId: request.anchorId });
  const page = (entries: SessionHistoryEntry[], beforeCursor: string | null, afterCursor: string | null): SessionHistoryPage => ({ entries, anchorId: request.anchorId, beforeCursor, afterCursor });
  const requireEntry = (id: string): HistorySourceEntry => {
    const row = source.entry(id);
    if (!row) throw agentHistoryError('AGENT_HISTORY_UNAVAILABLE', 'Session history cursor is unavailable', { entryId: id });
    return row;
  };
  const next = (row: HistorySourceEntry, direction: Direction): HistorySourceEntry | null => {
    if (direction === 'before') {
      const parent = row.parentId === null ? null : source.entry(row.parentId);
      // A malformed source must not turn a bounded page into an ancestry cycle.
      if (parent && parent.sequence >= row.sequence) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history ancestry');
      return parent;
    }
    return row.childCount === 1 ? source.children(row.id, null, 'after', 1)[0] ?? null : null;
  };

  if (request.direction === 'children' || (request.anchorId === null && request.direction === 'around') || cursor?.kind === 'children') {
    const direction = cursor?.direction ?? 'after';
    const start = cursor ? requireEntry(cursor.nextId) : null;
    if (start && start.parentId !== request.anchorId) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Session history cursor belongs to another branch');
    const candidates = source.children(request.anchorId, start ? start.sequence + (direction === 'after' ? -1 : 1) : null, direction, SESSION_HISTORY_SIDE_ROWS + 1);
    const entries: SessionHistoryEntry[] = [];
    let bytes = 0;
    for (const row of candidates) {
      const entry = historyEntry(row, currentLeaf);
      const size = historyEncoder.encode(JSON.stringify(entry)).byteLength + 1;
      if (entries.length >= SESSION_HISTORY_SIDE_ROWS || bytes + size > PAGE_CONTENT_BYTES) break;
      entries.push(entry);
      bytes += size;
    }
    if (!entries.length) {
      if (candidates.length) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Session history entry exceeds the page byte limit');
      return page([], null, null);
    }
    if (direction === 'before') entries.reverse();
    const first = entries[0]!;
    const last = entries.at(-1)!;
    const before = source.children(request.anchorId, first.sequence, 'before', 1)[0];
    const after = source.children(request.anchorId, last.sequence, 'after', 1)[0];
    return page(entries,
      encodeCursor(request.anchorId, 'children', 'before', before?.id ?? null),
      encodeCursor(request.anchorId, 'children', 'after', after?.id ?? null));
  }

  const walk = (start: HistorySourceEntry | null, direction: Direction, byteLimit: number, rawLimit: number) => {
    const entries: SessionHistoryEntry[] = [];
    let row = start;
    let last: HistorySourceEntry | null = null;
    let bytes = 0;
    let work = 0;
    while (row && work < rawLimit && entries.length < SESSION_HISTORY_SIDE_ROWS) {
      const visible = row.role !== null || row.childCount > 1 || row.id === currentLeaf || row.id === request.anchorId;
      if (visible) {
        const entry = historyEntry(row, currentLeaf);
        const size = historyEncoder.encode(JSON.stringify(entry)).byteLength + 1;
        if (bytes + size > byteLimit) break;
        entries.push(entry);
        bytes += size;
      }
      work++;
      last = row;
      row = next(row, direction);
    }
    if (direction === 'before') entries.reverse();
    return { entries, next: row, last, first: last ? start : null };
  };

  if (!cursor) {
    if (!anchor) return page([], null, null);
    const center = historyEntry(anchor, currentLeaf);
    const halfBytes = Math.floor((PAGE_CONTENT_BYTES - historyEncoder.encode(JSON.stringify(center)).byteLength) / 2);
    const before = walk(next(anchor, 'before'), 'before', halfBytes, SESSION_HISTORY_RAW_STEPS / 2);
    const after = walk(next(anchor, 'after'), 'after', halfBytes, SESSION_HISTORY_RAW_STEPS / 2);
    return page([...before.entries, center, ...after.entries],
      encodeCursor(request.anchorId, 'path', 'before', before.next?.id ?? null, before.last?.id ?? anchor.id),
      encodeCursor(request.anchorId, 'path', 'after', after.next?.id ?? null, after.last?.id ?? anchor.id));
  }

  const start = requireEntry(cursor.nextId);
  const reverse = cursor.backId === null ? null : requireEntry(cursor.backId);
  if (reverse && (cursor.direction === 'before' ? reverse.parentId !== start.id : start.parentId !== reverse.id)) {
    throw agentHistoryError('AGENT_HISTORY_INVALID', 'Invalid session history cursor boundary');
  }
  const window = walk(start, cursor.direction, PAGE_CONTENT_BYTES, SESSION_HISTORY_RAW_STEPS);
  if (!window.last) throw agentHistoryError('AGENT_HISTORY_INVALID', 'Session history entry exceeds the page byte limit');
  const ahead = encodeCursor(request.anchorId, 'path', cursor.direction, window.next?.id ?? null, window.last.id);
  const behind = encodeCursor(request.anchorId, 'path', cursor.direction === 'before' ? 'after' : 'before', reverse?.id ?? null, window.first!.id);
  return cursor.direction === 'before' ? page(window.entries, ahead, behind) : page(window.entries, behind, ahead);
}
