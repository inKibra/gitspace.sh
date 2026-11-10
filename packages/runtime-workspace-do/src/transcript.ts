import { CompactionEntry, ToolTask, type Conversation, type ConversationId, type ConversationRecord, type Cursor, type EntryRecord, type Storage, type TaskQuery } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { TranscriptProjector, WORKSPACE_REPORT_ENTRY, previewTranscriptItem, transcriptContentRequestSchema, transcriptPageRequestSchema, TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_ROWS, type TranscriptContentPage, type TranscriptContentRequest, type TranscriptEventInput, type TranscriptItem, type TranscriptPage, type TranscriptPageRequest, type TranscriptRow } from '@gitspace/blocks';
import type { RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';
import type { RuntimeTranscriptRange } from '@gitspace/runtime-core/history';
import { z } from 'zod';

export type RuntimeTranscriptEvent = TranscriptEvent & { sessionId: string };
export type RuntimeTranscriptFormat = 'json' | 'ndjson';
export type ExecutorResultReader = (reference: { attemptId: string; sha256: string }, conversationId: string) => RuntimeToolResult | undefined;

const ctx = BACKGROUND_CONTEXT;
/** Event and row ordinals are `entryId * 1024 + n`; ordinals of one entry never collide with the next. */
const ENTRY_ORDINALS = 1024;
const SCAN_ENTRIES = 64;
/** Transcript generation; v2 names every turn by the input that opened it, so a row's ID is the same in every window
 * (v1 named a turn after the first entry a window happened to start with). */
const GENERATION = 'pi-transcript-v2';
/** Entries one window projects; a window inside a turn is told the turn's name, so it needs no more. */
const WINDOW_ENTRIES = 32;
/** Entries a window reads past its own so the tool calls it makes show their results. */
const FORWARD_ENTRIES = 64;
const FORWARD_IDS = 256;
/** A page reads earlier (or later) windows until it has this many rows, visiting at most `PAGE_WINDOWS`; a page of one
 * execution's rows, which may be sparse, stops at its first window that has any within `SCOPED_WINDOWS`. */
const PAGE_FILL_ROWS = 24;
const PAGE_WINDOWS = 8;
const SCOPED_WINDOWS = 128;
/** Entries a lookup by a tool row's ID scans for its call, when the request does not give the row's ordinal. */
const SEARCH_ENTRIES = 4096;
const LIVE_STATUSES = ['pending', 'running', 'waiting', 'completing'] as const;
/** States of a tool task that has started executing and has no result yet. */
const EXECUTING_STATUSES: readonly NonNullable<TaskQuery['status']>[] = ['running', 'waiting'];
const modelToolTaskInput = z.object({ kind: z.literal('model'), assistant: z.number(), callId: z.string() });

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
/** The project agent's workspace board reaches it as context but shows as one quiet row, the board under a fold. */
const WORKSPACE_BOARD = 'gitspace.workspace-board';
/** Titles of user-role entries no input placed (a retained rule's instruction, a rewind's report, a restore notice):
 * they belong to the turn they land in and show there as notices. */
const IN_TURN_TITLE: Readonly<Record<string, string>> = { 'pi.user': 'Instruction', 'gitspace.rewind': 'Context rewound', 'gitspace.lfs-restored': 'Files restored' };

/** `event` as part of the turn it lands in: a user message no input placed shows as a notice instead of opening a turn. */
function inTurn(event: TranscriptEvent, entry: EntryRecord): TranscriptEvent {
  const message = event.payload.message;
  if (event.kind !== 'message_end' || typeof message !== 'object' || message === null || !('role' in message) || message.role !== 'user') return event;
  const content = 'content' in message ? message.content : '';
  return { ...event, payload: { ...event.payload, message: { role: 'custom', customType: MACHINE_NOTICE, display: true, title: IN_TURN_TITLE[entry.kind] ?? 'Note', content } } };
}

/** The entries that open the conversation's turns (where its inputs were placed), ascending, and the same as a set. */
type Openers = { readonly ids: readonly number[]; readonly set: ReadonlySet<number> };

/** The newest opener at or below `entry`; undefined before the first. */
function openerAt(openers: readonly number[], entry: number): number | undefined {
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

/** The position a turn row's ID names: the event it came from, or its turn's input for the turn's user message. */
function positionOf(rowId: string): number | undefined {
  const event = /^pi:\d+:turn:\d+:[a-z-]+:(\d+)/u.exec(rowId);
  if (event) return Number(event[1]);
  const user = /^pi:\d+:turn:(\d+):user$/u.exec(rowId);
  return user ? Number(user[1]) : undefined;
}

/** One Pi entry as transcript events. Tool results recorded by reference show the executor's stored result. */
export function entryEvents(entry: EntryRecord, executorResult?: ExecutorResultReader, withdrawn?: WithdrawnNotices): TranscriptEvent[] {
  if (withdrawn?.has(String(entry.id))) return [];
  const base = Number(entry.id) * ENTRY_ORDINALS;
  return (entry.model ?? []).map((source, index) => {
    if (entry.kind === MACHINE_NOTICE) {
      const title = typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data) && typeof entry.data.source === 'string' ? entry.data.source : 'Machine';
      return { ordinal: base + index, kind: 'message_end', payload: { message: { role: 'custom', customType: MACHINE_NOTICE, display: true, title, content: source.content }, entryId: String(entry.id) }, createdAt: new Date(source.timestamp).toISOString() };
    }
    if (entry.kind === WORKSPACE_BOARD) return { ordinal: base + index, kind: 'message_end', payload: { message: { role: 'custom', customType: WORKSPACE_BOARD, display: true, title: 'Workspace board', content: source.content }, entryId: String(entry.id) }, createdAt: new Date(source.timestamp).toISOString() };
    if (entry.kind === WORKSPACE_REPORT_ENTRY) return { ordinal: base + index, kind: 'message_end', payload: { message: workspaceReportMessage(entry), entryId: String(entry.id) }, createdAt: new Date(source.timestamp).toISOString() };
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

/** A workspace turn report as the custom message the transcript draws as a row; its data carries the report. */
function workspaceReportMessage(entry: EntryRecord) {
  const data = typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data) ? entry.data : undefined;
  return { role: 'custom', customType: WORKSPACE_REPORT_ENTRY, display: true, content: typeof data?.text === 'string' ? data.text : '', details: data?.payload ?? null };
}

/** Display-only Gitspace entries rendered as custom transcript messages. A workspace report delivered as an event
 * (it starts a turn) is display-only: the event's own input carries it to the model. */
function noticeEvent(entry: EntryRecord): TranscriptEventInput | undefined {
  const ordinal = Number(entry.id) * ENTRY_ORDINALS + (entry.model?.length ?? 0);
  if (entry.kind === WORKSPACE_REPORT_ENTRY) return entry.model?.length ? undefined : { sessionId: '', ordinal, kind: 'message_end', payload: { message: workspaceReportMessage(entry) } };
  const data = typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data) ? entry.data : undefined;
  const text = entry.kind === 'gitspace.model-fallback' ? data?.message : undefined;
  if (text === undefined) return undefined;
  return { sessionId: '', ordinal, kind: 'message_end', payload: { message: { role: 'custom', customType: entry.kind, display: true, content: typeof text === 'string' ? text : '' } } };
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
/** Entries projected together, oldest first: the window's own (`first` through `last`), then any read past them so
 * the tool calls they make show their results. `older` and `newer`: the conversation has entries before `first` and
 * after `last`. */
type Window = { entries: EntryRecord[]; first: number; last: number; older: boolean; newer: boolean };

/** A browser-loadable URL for a stored image a transcript row names (`gs-image:…;<mimeType>`); the same for the same
 * image within its validity window, so content read in parts stays one text. */
export type TranscriptImageUrl = (stored: string) => string;

/** `item` with each stored image's URL resolved. */
function withImageUrls<T>(item: T, imageUrl: TranscriptImageUrl | undefined): T {
  if (!imageUrl) return item;
  const text = JSON.stringify(item);
  if (!text.includes('"gs-image:v1:')) return item;
  return JSON.parse(text, (key, value: unknown) => key === 'url' && typeof value === 'string' && value.startsWith('gs-image:v1:') ? imageUrl(value) : value);
}

/** Transcript pages are projected per request from small windows of Pi entries, each told the name of the turn it
 * starts in. Nothing is persisted: Pi's entries and submissions are the only transcript storage. */
export function createTranscriptReader(storage: Storage, withdrawn: WithdrawnNotices, executorResult?: ExecutorResultReader, imageUrl?: TranscriptImageUrl) {
  async function live(conversationId: ConversationId): Promise<boolean> {
    for (const status of LIVE_STATUSES) {
      const query: TaskQuery = { conversationId, status, background: false };
      if ((await storage.scanTasks(query, 1, undefined, ctx)).items.length) return true;
    }
    return false;
  }

  /** Model-issued tool calls of `entries` executing now, as the events that start them. Pi records a call's start only
   * on its task; its result entry records how long it ran. */
  async function executing(conversationId: ConversationId, sessionId: string, entries: readonly EntryRecord[]): Promise<TranscriptEventInput[]> {
    const names = new Map<string, string>();
    for (const entry of entries) for (const message of entry.model ?? []) {
      if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') names.set(`${Number(entry.id)}:${part.id}`, part.name);
    }
    const events: TranscriptEventInput[] = [];
    for (const status of EXECUTING_STATUSES) {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({ conversationId, kind: ToolTask.definition.name, status }, 64, cursor, ctx);
        for (const task of page.items) {
          const input = modelToolTaskInput.safeParse(task.input);
          const toolName = input.success ? names.get(`${input.data.assistant}:${input.data.callId}`) : undefined;
          if (!input.success || toolName === undefined || task.startedAt === undefined) continue;
          events.push({ sessionId, ordinal: input.data.assistant * ENTRY_ORDINALS, kind: 'tool_execution_start', payload: { toolCallId: input.data.callId, toolName }, createdAt: new Date(task.startedAt).toISOString() });
        }
        cursor = page.next;
      } while (cursor);
    }
    return events;
  }

  /** At most `limit` of the conversation's entries, newest first, below `below` (all of them when null). */
  async function entriesBelow(conversationId: ConversationId, below: number | null, limit: number): Promise<EntryRecord[]> {
    const found: EntryRecord[] = [];
    let cursor: Cursor | undefined = below === null ? undefined : { after: below };
    while (found.length < limit) {
      const page = await storage.scanEntries({ conversationId }, Math.min(SCAN_ENTRIES, limit - found.length), cursor, ctx);
      found.push(...page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    return found;
  }

  /** At most `limit` of the conversation's entries, oldest first, from `from` on. */
  async function entriesFrom(conversationId: ConversationId, from: number, limit: number): Promise<EntryRecord[]> {
    const found: EntryRecord[] = [];
    let cursor: Cursor | undefined = { after: from - 1, order: 'ascending' };
    while (found.length < limit) {
      const page = await storage.scanEntries({ conversationId, order: 'ascending' }, Math.min(SCAN_ENTRIES, limit - found.length), cursor, ctx);
      found.push(...page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    return found;
  }

  /** Where each of the conversation's turns opens: the entries its inputs were placed at, and its fork ancestors'
   * through the fork. */
  async function openersOf(conversationId: ConversationId): Promise<Openers> {
    const ids: number[] = [];
    let current: ConversationId | undefined = conversationId;
    let through = Number.POSITIVE_INFINITY;
    while (current !== undefined) {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanSubmissions({ conversationId: current }, SCAN_ENTRIES, cursor, ctx);
        for (const record of page.items) if (record.type === 'input' && record.entry !== undefined && Number(record.entry) <= through) ids.push(Number(record.entry));
        cursor = page.next;
      } while (cursor);
      const parent: ConversationRecord['parent'] = (await storage.conversation(current, ctx))?.parent;
      if (!parent) break;
      through = Math.min(through, Number(parent.at));
      current = parent.conversationId;
    }
    ids.sort((left, right) => left - right);
    return { ids, set: new Set(ids) };
  }

  /** `own` (oldest first) as a window, with the entries past it its tool calls need for their results. */
  async function windowOf(conversationId: ConversationId, own: EntryRecord[], older: boolean, highWater: number): Promise<Window> {
    const head = own[0];
    const tail = own.at(-1);
    if (!head || !tail) return { entries: [], first: 0, last: -1, older: false, newer: false };
    const last = Number(tail.id);
    const entries = [...own];
    const pending = new Set<string>();
    for (const entry of own) for (const message of entry.model ?? []) {
      if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') pending.add(part.id);
      if (message.role === 'toolResult') pending.delete(message.toolCallId);
    }
    if (pending.size && last < highWater) {
      for (const entry of await entriesFrom(conversationId, last + 1, FORWARD_ENTRIES)) {
        entries.push(entry);
        for (const message of entry.model ?? []) if (message.role === 'toolResult') pending.delete(message.toolCallId);
        if (!pending.size) break;
      }
    }
    return { entries, first: Number(head.id), last, older, newer: last < highWater };
  }

  /** The window whose own entries end at `maxEntry` (the newest when null). */
  async function windowEnding(conversationId: ConversationId, maxEntry: number | null, highWater: number): Promise<Window> {
    const found = await entriesBelow(conversationId, maxEntry === null ? null : maxEntry + 1, WINDOW_ENTRIES + 1);
    return windowOf(conversationId, found.slice(0, WINDOW_ENTRIES).reverse(), found.length > WINDOW_ENTRIES, highWater);
  }

  /** The window whose own entries start at `from`. */
  async function windowStarting(conversationId: ConversationId, from: number, highWater: number): Promise<Window> {
    const own = await entriesFrom(conversationId, from, WINDOW_ENTRIES);
    const head = own[0];
    const older = head !== undefined && (await entriesBelow(conversationId, Number(head.id), 1)).length > 0;
    return windowOf(conversationId, own, older, highWater);
  }

  /** Projects `view`; `running`: the conversation is working, so its newest input's turn runs. */
  async function project(conversationId: ConversationId, view: Window, openers: Openers, running: boolean): Promise<Projection> {
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
    // A window inside a turn names it as a window starting at its input would, so a row has one ID in every window.
    const opener = openerAt(openers.ids, view.first);
    if (opener !== undefined && opener !== view.first) projector.apply({ sessionId, ordinal: opener * ENTRY_ORDINALS, kind: 'turn_start', payload: {} });
    for (const entry of view.entries) {
      entryId = Number(entry.id);
      written = 0;
      const opens = openers.set.has(entryId);
      if (opens) projector.apply({ sessionId, ordinal: entryId * ENTRY_ORDINALS, kind: 'turn_start', payload: {} });
      for (const event of entryEvents(entry, executorResult, withdrawn)) projector.apply({ ...(opens ? event : inTurn(event, entry)), sessionId });
      const notice = noticeEvent(entry);
      if (notice) projector.apply({ ...notice, sessionId });
    }
    if (!view.newer) for (const event of await executing(conversationId, sessionId, view.entries)) projector.apply(event);
    projector.flush();
    // Only the newest input's turn can be running; a turn a later input followed is done.
    const lastTurn = [...projection.turns.keys()].at(-1);
    const newest = openers.ids.at(-1);
    if (lastTurn !== undefined && projection.turns.get(lastTurn) !== 'error') {
      projection.turns.set(lastTurn, running && newest !== undefined && lastTurn === `${sessionId}:turn:${newest * ENTRY_ORDINALS}` ? 'running' : 'done');
    }
    return projection;
  }

  function scoped(projection: Projection, executionId: string | null | undefined): [string, ProjectedRow][] {
    const members = executionId ? projection.executions.get(executionId) ?? new Set<string>() : undefined;
    return [...projection.rows].filter(([id]) => members ? members.has(id) : !projection.hidden.has(id)).sort((left, right) => left[1].ordinal - right[1].ordinal);
  }

  /** The window's rows that start in its own entries; rows its read-ahead starts belong to the next window. */
  function own(projection: Projection, view: Window, executionId: string | null | undefined): [string, ProjectedRow][] {
    return scoped(projection, executionId).filter(([, value]) => entryOf(value.ordinal) >= view.first && entryOf(value.ordinal) <= view.last);
  }

  function row(projection: Projection, id: string, value: ProjectedRow): TranscriptRow {
    return { id, ordinal: value.ordinal, turnId: value.turn, turnStatus: projection.turns.get(value.turn) ?? 'done', contentRevision: value.revision, ...previewTranscriptItem(withImageUrls(value.item, imageUrl)) };
  }

  /** The leading rows of `rows` that fit one page. */
  function fit(rows: readonly TranscriptRow[]): TranscriptRow[] {
    const kept: TranscriptRow[] = [];
    let bytes = 2;
    for (const next of rows) {
      const size = new TextEncoder().encode(JSON.stringify(next)).byteLength + 1;
      if (kept.length >= TRANSCRIPT_PAGE_ROWS || bytes + size > TRANSCRIPT_PAGE_BYTES) break;
      kept.push(next);
      bytes += size;
    }
    return kept;
  }

  /** Where the call a tool row's ID names was made, scanning back from the newest entry. */
  async function callPosition(conversationId: ConversationId, rowId: string): Promise<number | undefined> {
    const call = /^pi:\d+:[a-z-]+:(.+)$/u.exec(rowId)?.[1];
    if (!call) return undefined;
    let cursor: Cursor | undefined;
    for (let seen = 0; seen < SEARCH_ENTRIES;) {
      const page = await storage.scanEntries({ conversationId }, SCAN_ENTRIES, cursor, ctx);
      for (const entry of page.items) for (const message of entry.model ?? []) {
        if (message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.id === call)) return Number(entry.id) * ENTRY_ORDINALS;
      }
      seen += page.items.length;
      if (!page.next) return undefined;
      cursor = page.next;
    }
    return undefined;
  }

  /** The row `rowId` and the projection of the window it starts in: read at its ordinal when the reader gives it, else
   * at the position its ID names (a turn's rows name their entry), else where its tool call was made. */
  async function find(conversationId: ConversationId, rowId: string, ordinal: number | undefined, openers: Openers, running: boolean, highWater: number): Promise<{ projection: Projection; value: ProjectedRow }> {
    const at = ordinal ?? positionOf(rowId) ?? await callPosition(conversationId, rowId);
    if (at === undefined) throw new Error('Transcript row not found');
    const projection = await project(conversationId, await windowStarting(conversationId, entryOf(at), highWater), openers, running);
    const value = projection.rows.get(rowId);
    if (!value) throw new Error('Transcript row not found');
    return { projection, value };
  }

  return {
    async page(conversationId: ConversationId, raw: TranscriptPageRequest): Promise<TranscriptPage> {
      let request = transcriptPageRequestSchema.parse(raw);
      const generation = `${GENERATION}:${conversationId}`;
      if (request.generation !== null && request.generation !== generation) request = { generation: null, before: null, after: null, around: null, executionId: request.executionId };
      const newest = await newestEntry(storage, conversationId);
      if (!newest) return { generation, revision: 0, rows: [], total: 0, hasBefore: false, hasAfter: false };
      const highWater = Number(newest.id);
      // Monotonic activity counters: the newest entry only ever grows within a generation.
      const envelope = { generation, revision: highWater, total: highWater + 1 };
      const openers = await openersOf(conversationId);
      const running = await live(conversationId);
      const windows = request.executionId ? SCOPED_WINDOWS : PAGE_WINDOWS;
      const enough = request.executionId ? 1 : PAGE_FILL_ROWS;
      const start = request.around !== null ? (await find(conversationId, request.around, request.aroundOrdinal, openers, running, highWater)).value.ordinal
        : request.after === null ? null : request.after + 1;
      if (start !== null) {
        // Ascending: from the row asked around (or after), reading later windows until the page is full.
        const rows: TranscriptRow[] = [];
        let hasBefore = false;
        let newer = false;
        let from = entryOf(start);
        for (let visited = 0; visited < windows; visited++) {
          const view = await windowStarting(conversationId, from, highWater);
          if (!view.entries.length) break;
          const projection = await project(conversationId, view, openers, running);
          const rowsOf = own(projection, view, request.executionId);
          if (visited === 0) hasBefore = view.older || rowsOf.some(([, value]) => value.ordinal < start);
          rows.push(...rowsOf.filter(([, value]) => value.ordinal >= start).map(([id, value]) => row(projection, id, value)));
          newer = view.newer;
          if (rows.length >= enough || !view.newer) break;
          from = view.last + 1;
        }
        const fitted = fit(rows);
        return { ...envelope, rows: fitted, hasBefore, hasAfter: fitted.length < rows.length || newer };
      }
      // Descending: the latest rows, or those before `before`, reading earlier windows until the page is full.
      const before = request.before;
      const collected: TranscriptRow[] = [];
      let older = false;
      let maxEntry = before === null ? null : before === 0 ? -1 : entryOf(before - 1);
      for (let visited = 0; visited < windows && maxEntry !== -1; visited++) {
        const view = await windowEnding(conversationId, maxEntry, highWater);
        if (!view.entries.length) { older = false; break; }
        const projection = await project(conversationId, view, openers, running);
        collected.unshift(...own(projection, view, request.executionId).filter(([, value]) => before === null || value.ordinal < before).map(([id, value]) => row(projection, id, value)));
        older = view.older;
        if (collected.length >= enough || !view.older) break;
        maxEntry = view.first - 1;
      }
      const fitted = fit([...collected].reverse()).reverse();
      return { ...envelope, rows: fitted, hasBefore: fitted.length < collected.length || older, hasAfter: before !== null && entryOf(before - 1) < highWater };
    },
    async content(conversationId: ConversationId, raw: TranscriptContentRequest): Promise<TranscriptContentPage> {
      const request = transcriptContentRequestSchema.parse(raw);
      if (request.generation !== `${GENERATION}:${conversationId}`) throw new Error('Transcript generation changed');
      const newest = await newestEntry(storage, conversationId);
      if (!newest) throw new Error('Transcript row not found');
      const { value } = await find(conversationId, request.rowId, request.ordinal, await openersOf(conversationId), false, Number(newest.id));
      const text = JSON.stringify(withImageUrls(value.item, imageUrl));
      if (request.offset > text.length) throw new Error('Transcript content offset is out of range');
      const end = Math.min(text.length, request.offset + TRANSCRIPT_CONTENT_CHARACTERS);
      return { text: text.slice(request.offset, end), offset: request.offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length, contentRevision: value.revision };
    },
  };
}
