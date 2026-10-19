import { CompactionEntry, type Conversation, type ConversationId, type Cursor, type EntryRecord, type Storage, type TaskQuery } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { TranscriptProjector, previewTranscriptItem, transcriptContentRequestSchema, transcriptPageRequestSchema, TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_ROWS, type TranscriptContentPage, type TranscriptContentRequest, type TranscriptEventInput, type TranscriptItem, type TranscriptPage, type TranscriptPageRequest, type TranscriptRow } from '@gitspace/blocks';
import type { RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';
import type { RuntimeTranscriptRange } from '@gitspace/runtime-core/history';

export type RuntimeTranscriptEvent = TranscriptEvent & { sessionId: string };
export type RuntimeTranscriptFormat = 'json' | 'ndjson';
export type ExecutorResultReader = (reference: { attemptId: string; sha256: string }, conversationId: string) => RuntimeToolResult | undefined;

const ctx = BACKGROUND_CONTEXT;
/** Event and row ordinals are `entryId * 1024 + n`; ordinals of one entry never collide with the next. */
const ENTRY_ORDINALS = 1024;
const SCAN_ENTRIES = 64;
/** A page window holds at least this many entries before it extends back to a turn start. */
const WINDOW_ENTRIES = 32;
/** Hard bounds on one request: a window never reads more entries, a lookup never visits more windows. */
const WINDOW_LIMIT = 512;
const FORWARD_IDS = 256;
const FORWARD_STEPS = 16;
const SEARCH_WINDOWS = 16;
const LIVE_STATUSES = ['pending', 'running', 'waiting', 'completing'] as const;

const entryOf = (ordinal: number) => Math.floor(ordinal / ENTRY_ORDINALS);
/** Machine notices withdrawn from a conversation: its chat and history skip them, and a `gitspace.notices-withdrawn`
 * entry omits them from the model's context. Entries are immutable, so withdrawal is recorded beside them. */
export interface WithdrawnNotices {
  has(entryId: string): boolean;
  add(entryIds: readonly string[]): void;
}
/** Machine notices reach the agent as context but show as notices: they neither open a turn nor read as the user's. */
const MACHINE_NOTICE = 'gitspace.machine-notice';
/** A compaction summary is context the model reads as a user message; it shows as the compaction, not as the user's. */
const COMPACTION = CompactionEntry.kind;
const opensTurn = (entry: EntryRecord) => entry.kind !== MACHINE_NOTICE && entry.kind !== COMPACTION && entry.model?.[0]?.role === 'user';

/** One Pi entry as transcript events. Tool results recorded by reference show the executor's stored result. */
export function entryEvents(entry: EntryRecord, executorResult?: ExecutorResultReader, withdrawn?: WithdrawnNotices): TranscriptEvent[] {
  if (withdrawn?.has(String(entry.id))) return [];
  const base = Number(entry.id) * ENTRY_ORDINALS;
  return (entry.model ?? []).map((source, index) => {
    if (entry.kind === MACHINE_NOTICE) {
      const title = typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data) && typeof entry.data.source === 'string' ? entry.data.source : 'Machine';
      return { ordinal: base + index, kind: 'message_end', payload: { message: { role: 'custom', customType: MACHINE_NOTICE, display: true, title, content: source.content }, entryId: String(entry.id) }, createdAt: new Date(source.timestamp).toISOString() };
    }
    if (entry.kind === COMPACTION) return { ordinal: base + index, kind: 'compaction', payload: { entryId: String(entry.id) }, createdAt: new Date(source.timestamp).toISOString() };
    let message = source;
    if (source.role === 'toolResult' && source.details && typeof source.details === 'object' && 'executorResultReference' in source.details) {
      const reference = source.details.executorResultReference;
      if (reference && typeof reference === 'object' && 'attemptId' in reference && typeof reference.attemptId === 'string' && 'sha256' in reference && typeof reference.sha256 === 'string') {
        const result = executorResult?.({ attemptId: reference.attemptId, sha256: reference.sha256 }, String(entry.conversationId));
        if (result) message = { ...source, content: result.content, isError: result.status !== 'completed' };
      }
    }
    return { ordinal: base + index, kind: 'message_end', payload: { message, entryId: String(entry.id) }, createdAt: new Date(message.timestamp).toISOString() };
  });
}

/** Display-only Gitspace entries rendered as custom transcript messages. */
function noticeEvent(entry: EntryRecord): TranscriptEventInput | undefined {
  const data = typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data) ? entry.data : undefined;
  const text = entry.kind === 'gitspace.model-fallback' ? data?.message : entry.kind === 'gitspace.cron-overdue' ? data?.text : undefined;
  if (text === undefined) return undefined;
  return { sessionId: '', ordinal: Number(entry.id) * ENTRY_ORDINALS + (entry.model?.length ?? 0), kind: 'message_end', payload: { message: { role: 'custom', customType: entry.kind, display: true, content: typeof text === 'string' ? text : '' } } };
}

/** Newest-first entries at or below `maxEntry` (inclusive), one bounded page at a time. */
async function* entriesBackward(storage: Storage, conversationId: ConversationId, maxEntry: number | null): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined = maxEntry === null ? undefined : { after: maxEntry + 1 };
  do {
    const page = await storage.scanEntries({ conversationId }, SCAN_ENTRIES, cursor, ctx);
    yield* page.items;
    cursor = page.next;
  } while (cursor);
}

/** Oldest-first entries strictly after `after` (null: from the start) through `highWater`, scanning
 * bounded ID ranges. Pi only scans newest-first, so each range is read whole and reversed. */
async function* entriesForward(storage: Storage, conversationId: ConversationId, after: EntryRecord | null, highWater: number, steps = Number.POSITIVE_INFINITY): AsyncGenerator<EntryRecord> {
  let minimum = after;
  let upper = after === null ? 0 : Number(after.id) + 1;
  for (let step = 0; step < steps && upper <= highWater; step++) {
    upper += FORWARD_IDS;
    const page = await storage.scanEntries(minimum === null ? { conversationId } : { conversationId, minEntryId: minimum.id }, FORWARD_IDS + 1, { after: upper }, ctx);
    const newer = page.items.filter(entry => Number(entry.id) <= highWater && (minimum === null || Number(entry.id) > Number(minimum.id))).reverse();
    yield* newer;
    minimum = newer.at(-1) ?? minimum;
  }
}

async function newestEntry(storage: Storage, conversationId: ConversationId): Promise<EntryRecord | undefined> {
  return (await storage.scanEntries({ conversationId }, 1, undefined, ctx)).items[0];
}

/** Streams a bounded ordinal range of transcript events. The high-water entry is fixed before streaming. */
export async function transcriptResponse(storage: Storage, target: Conversation, withdrawn: WithdrawnNotices, format: RuntimeTranscriptFormat = 'json', range: RuntimeTranscriptRange = {}): Promise<Response> {
  const sessionId = String(target.id);
  const newest = await newestEntry(storage, target.id);
  const from = range.from ?? 0;
  const before = range.before ?? Number.MAX_SAFE_INTEGER;
  async function* events(): AsyncGenerator<RuntimeTranscriptEvent> {
    if (!newest || before <= from) return;
    if (range.newestFirst) {
      for await (const entry of entriesBackward(storage, target.id, Math.min(Number(newest.id), entryOf(before - 1)))) {
        if (Number(entry.id) < entryOf(from)) return;
        const values = entryEvents(entry, undefined, withdrawn);
        for (let index = values.length - 1; index >= 0; index--) if (values[index]!.ordinal >= from && values[index]!.ordinal < before) yield { ...values[index]!, sessionId };
      }
      return;
    }
    const start = from === 0 ? null : (await storage.scanEntries({ conversationId: target.id }, 1, { after: entryOf(from) }, ctx)).items[0] ?? null;
    for await (const entry of entriesForward(storage, target.id, start, Number(newest.id))) {
      if (Number(entry.id) > entryOf(before - 1)) return;
      for (const event of entryEvents(entry, undefined, withdrawn)) if (event.ordinal >= from && event.ordinal < before) yield { ...event, sessionId };
    }
  }
  const iterator = events();
  const encoder = new TextEncoder();
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (format === 'json') controller.enqueue(encoder.encode(first ? '[]' : ']'));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(format === 'ndjson' ? `${JSON.stringify(next.value)}\n` : `${first ? '[' : ','}${JSON.stringify(next.value)}`));
        first = false;
      } catch (error) {
        await iterator.return(undefined);
        controller.error(error);
      }
    },
    async cancel() { await iterator.return(undefined); },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { 'content-type': format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8' } });
}

type ProjectedRow = { item: TranscriptItem; turn: string; ordinal: number; revision: number };
type Projection = { rows: Map<string, ProjectedRow>; turns: Map<string, TranscriptRow['turnStatus']>; hidden: Set<string>; executions: Map<string, Set<string>> };
/** A turn-aligned run of entries: `entries[0]` opens a turn unless `complete` is false at the start. */
type Window = { entries: EntryRecord[]; hasOlder: boolean; newest: boolean; nextTurn?: EntryRecord };

/** Transcript pages are projected per request from a bounded, turn-aligned window of Pi entries.
 * Nothing is persisted: Pi's entries are the only transcript storage. */
export function createTranscriptReader(storage: Storage, withdrawn: WithdrawnNotices, executorResult?: ExecutorResultReader) {
  async function live(conversationId: ConversationId): Promise<boolean> {
    for (const status of LIVE_STATUSES) {
      const query: TaskQuery = { conversationId, status, background: false };
      if ((await storage.scanTasks(query, 1, undefined, ctx)).items.length) return true;
    }
    return false;
  }

  /** Entries at or below `maxEntry`, extended back to the turn that contains them and forward to that turn's end. */
  async function window(conversationId: ConversationId, maxEntry: number | null, highWater: number): Promise<Window> {
    const entries: EntryRecord[] = [];
    let hasOlder = false;
    for await (const entry of entriesBackward(storage, conversationId, maxEntry)) {
      if (entries.length >= WINDOW_LIMIT || (entries.length >= WINDOW_ENTRIES && opensTurn(entries.at(-1)!))) { hasOlder = true; break; }
      entries.push(entry);
    }
    entries.reverse();
    let newest = maxEntry === null || maxEntry >= highWater;
    let nextTurn: EntryRecord | undefined;
    const last = entries.at(-1);
    if (!newest && last) {
      // Finish the turn so its calls show their results and its status is final.
      for await (const entry of entriesForward(storage, conversationId, last, highWater, FORWARD_STEPS)) {
        if (opensTurn(entry)) { nextTurn = entry; break; }
        entries.push(entry);
      }
      if (!nextTurn && Number(entries.at(-1)!.id) >= highWater) newest = true;
    }
    return { entries, hasOlder, newest, nextTurn };
  }

  async function project(conversationId: ConversationId, view: Window): Promise<Projection> {
    const sessionId = `pi:${conversationId}`;
    const projection: Projection = { rows: new Map(), turns: new Map(), hidden: new Set(), executions: new Map() };
    const bindings = new Map<string, string>();
    let entryId = 0;
    let written = 0;
    const projector = new TranscriptProjector(sessionId, {
      read: id => projection.rows.get(id)?.item,
      owner: id => projection.rows.get(id)?.turn,
      write(turn, item) {
        const previous = projection.rows.get(item.id);
        projection.rows.set(item.id, { item, turn: previous?.turn ?? turn, ordinal: previous?.ordinal ?? entryId * ENTRY_ORDINALS + Math.min(written++, ENTRY_ORDINALS - 1), revision: entryId });
      },
      turn(turn, status) { projection.turns.set(turn, status); },
      linkExecution(execution, row, hide) {
        const members = projection.executions.get(execution) ?? new Set<string>();
        projection.executions.set(execution, members);
        const inserted = !members.has(row);
        members.add(row);
        if (hide) projection.hidden.add(row);
        return inserted;
      },
      executionRun(identity, row) {
        for (const [execution, members] of projection.executions) if (members.has(row)) return execution;
        return bindings.get(identity);
      },
      bindExecutionRun(identity, execution) { bindings.set(identity, execution); },
    });
    for (const entry of view.entries) {
      entryId = Number(entry.id);
      written = 0;
      for (const event of entryEvents(entry, executorResult, withdrawn)) projector.apply({ ...event, sessionId });
      const notice = noticeEvent(entry);
      if (notice) projector.apply({ ...notice, sessionId });
    }
    projector.flush();
    const lastTurn = [...projection.turns.keys()].at(-1);
    const running = view.newest && await live(conversationId);
    if (lastTurn !== undefined && projection.turns.get(lastTurn) !== 'error') projection.turns.set(lastTurn, running ? 'running' : 'done');
    return projection;
  }

  function scoped(projection: Projection, executionId: string | null | undefined): [string, ProjectedRow][] {
    const members = executionId ? projection.executions.get(executionId) ?? new Set<string>() : undefined;
    return [...projection.rows].filter(([id]) => members ? members.has(id) : !projection.hidden.has(id)).sort((left, right) => left[1].ordinal - right[1].ordinal);
  }

  function row(projection: Projection, id: string, value: ProjectedRow): TranscriptRow {
    return { id, ordinal: value.ordinal, turnId: value.turn, turnStatus: projection.turns.get(value.turn) ?? 'done', contentRevision: value.revision, ...previewTranscriptItem(value.item) };
  }

  /** Newest windows first until `found` matches; bounded by SEARCH_WINDOWS. */
  async function locate(conversationId: ConversationId, highWater: number, rowId: string): Promise<{ projection: Projection; view: Window } | undefined> {
    // Turn-owned rows name their turn's first ordinal; jump straight to it.
    const turn = /^pi:\d+:turn:(\d+):/u.exec(rowId);
    let maxEntry: number | null = turn ? entryOf(Number(turn[1])) : null;
    for (let visited = 0; visited < SEARCH_WINDOWS; visited++) {
      const view = await window(conversationId, maxEntry, highWater);
      if (!view.entries.length) return undefined;
      const projection = await project(conversationId, view);
      if (projection.rows.has(rowId)) return { projection, view };
      if (turn || !view.hasOlder) return undefined;
      maxEntry = Number(view.entries[0]!.id) - 1;
    }
    return undefined;
  }

  function fit(selected: [string, ProjectedRow][], projection: Projection): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    let bytes = 2;
    for (const [id, value] of selected) {
      const next = row(projection, id, value);
      const size = new TextEncoder().encode(JSON.stringify(next)).byteLength + 1;
      if (rows.length >= TRANSCRIPT_PAGE_ROWS || bytes + size > TRANSCRIPT_PAGE_BYTES) break;
      rows.push(next);
      bytes += size;
    }
    return rows;
  }

  return {
    async page(conversationId: ConversationId, raw: TranscriptPageRequest): Promise<TranscriptPage> {
      let request = transcriptPageRequestSchema.parse(raw);
      const generation = `pi-transcript-v1:${conversationId}`;
      if (request.generation !== null && request.generation !== generation) request = { generation: null, before: null, after: null, around: null, executionId: request.executionId };
      const newest = await newestEntry(storage, conversationId);
      if (!newest) return { generation, revision: 0, rows: [], total: 0, hasBefore: false, hasAfter: false };
      const highWater = Number(newest.id);
      // Monotonic activity counters: the newest entry only ever grows within a generation.
      const envelope = { generation, revision: highWater, total: highWater + 1 };
      if (request.around !== null || request.after !== null) {
        let projection: Projection, view: Window, start: number;
        if (request.around !== null) {
          const found = await locate(conversationId, highWater, request.around);
          if (!found) throw new Error('Transcript row not found');
          ({ projection, view } = found);
          start = projection.rows.get(request.around)!.ordinal;
        } else {
          start = request.after! + 1;
          view = await window(conversationId, entryOf(start), highWater);
          projection = await project(conversationId, view);
        }
        let selected = scoped(projection, request.executionId).filter(([, value]) => value.ordinal >= start);
        // Ascending reads continue into the next turn when this one has nothing newer.
        if (!selected.length && view.nextTurn) {
          const next = await window(conversationId, Number(view.nextTurn.id), highWater);
          view = { ...next, hasOlder: true };
          projection = await project(conversationId, next);
          selected = scoped(projection, request.executionId).filter(([, value]) => value.ordinal >= start);
        }
        const rows = fit(selected, projection);
        return { ...envelope, rows, hasBefore: view.hasOlder || scoped(projection, request.executionId).some(([, value]) => value.ordinal < start), hasAfter: rows.length < selected.length || !view.newest };
      }
      let maxEntry = request.before === null ? null : request.before === 0 ? -1 : entryOf(request.before - 1);
      for (let visited = 0; visited < SEARCH_WINDOWS && maxEntry !== -1; visited++) {
        const view = await window(conversationId, maxEntry, highWater);
        if (!view.entries.length) break;
        const projection = await project(conversationId, view);
        const selected = scoped(projection, request.executionId).filter(([, value]) => request.before === null || value.ordinal < request.before).reverse();
        // Execution scopes may be sparse; skip older windows that hold none of their rows.
        if (selected.length || !view.hasOlder) {
          const rows = fit(selected, projection).reverse();
          return { ...envelope, rows, hasBefore: rows.length < selected.length || view.hasOlder, hasAfter: request.before !== null };
        }
        maxEntry = Number(view.entries[0]!.id) - 1;
      }
      return { ...envelope, rows: [], hasBefore: maxEntry !== -1, hasAfter: request.before !== null };
    },
    async content(conversationId: ConversationId, raw: TranscriptContentRequest): Promise<TranscriptContentPage> {
      const request = transcriptContentRequestSchema.parse(raw);
      if (request.generation !== `pi-transcript-v1:${conversationId}`) throw new Error('Transcript generation changed');
      const newest = await newestEntry(storage, conversationId);
      const found = newest ? await locate(conversationId, Number(newest.id), request.rowId) : undefined;
      const value = found?.projection.rows.get(request.rowId);
      if (!value) throw new Error('Transcript row not found');
      const text = JSON.stringify(value.item);
      if (request.offset > text.length) throw new Error('Transcript content offset is out of range');
      const end = Math.min(text.length, request.offset + TRANSCRIPT_CONTENT_CHARACTERS);
      return { text: text.slice(request.offset, end), offset: request.offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length, contentRevision: value.revision };
    },
  };
}
