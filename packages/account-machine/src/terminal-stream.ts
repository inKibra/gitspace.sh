import type { ProtectedTerminalBatch, ProtectedTerminalEvent } from '@gitspace/protocol';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { streamCursorSchema } from '@gitspace/protocol-sync';
import type { WorkspaceTerminalView, WorkspaceTerminalOutput } from './workspace-hub.js';

export interface TerminalSnapshot { terminals: WorkspaceTerminalView[]; output: WorkspaceTerminalOutput | null }
interface Change { cursor: number; previous: number; value: TerminalSnapshot }
interface Head { cursor: number; body: string; value: TerminalSnapshot }
const RETAINED_SNAPSHOTS = 16;
/** Protected output characters kept per attached terminal, newest first; older output is dropped. */
const RETAINED_PROTECTED_OUTPUT = 256 * 1024;

/** In-process observations of supervisor output; full values and replay revisions commit together.
 * Revisions restart with the process, so clients resuming from an earlier process resync as cursor-ahead. */
export class TerminalSnapshotJournal {
  private readonly heads = new Map<string, Head>();
  private readonly changes = new Map<string, Change[]>();
  private revision = 0;
  constructor(private readonly committed: (resource: string, cursor: number) => void) {}
  commit(resource: string, value: TerminalSnapshot): void {
    const body = JSON.stringify(value);
    const prior = this.heads.get(resource);
    if (prior?.body === body) return;
    const cursor = streamCursorSchema.parse(++this.revision);
    const retained = this.changes.get(resource) ?? [];
    retained.push({ cursor, previous: prior?.cursor ?? 0, value });
    if (retained.length > RETAINED_SNAPSHOTS) retained.splice(0, retained.length - RETAINED_SNAPSHOTS);
    this.changes.set(resource, retained);
    this.heads.set(resource, { cursor, body, value });
    this.committed(resource, cursor);
  }
  /** The resource's head cursor; 0 before its first commit. */
  cursor(resource: string): number {
    return this.heads.get(resource)?.cursor ?? 0;
  }
  /** null → [snapshot]; the head → []; else the changes after `after`, or [resync, snapshot] across a gap. */
  replay(resource: string, after: number | null): StreamEvent<TerminalSnapshot>[] {
    const head = this.heads.get(resource);
    if (!head) return [];
    const snapshot = (): StreamEvent<TerminalSnapshot> => ({ type: 'snapshot', resource, cursor: head.cursor, revision: head.cursor, previous: null, value: head.value });
    if (after === null) return [snapshot()];
    const rows = (this.changes.get(resource) ?? []).filter((row) => row.cursor > after);
    if (after > head.cursor || (after < head.cursor && rows[0]?.previous !== after)) return [
      { type: 'resync', resource, cursor: head.cursor, revision: head.cursor, reason: after > head.cursor ? 'cursor-ahead' : 'cursor-expired' }, snapshot(),
    ];
    return rows.map((row) => ({ type: 'change', resource, cursor: row.cursor, revision: row.cursor, previous: row.previous, value: row.value }));
  }
}

/** One protected terminal's live events since this machine attached, in order and in memory only: at most
 * RETAINED_PROTECTED_OUTPUT characters of output, the oldest events dropped first, plus its latest `state`. */
export class ProtectedTerminalTail {
  private state: { cursor: number; event: ProtectedTerminalEvent } | null = null;
  private readonly events: { cursor: number; event: ProtectedTerminalEvent; size: number }[] = [];
  private retained = 0;
  /** Events at or before this cursor are no longer retained. */
  private dropped: number;
  /** The cursor of the latest event; the allocator's value at attach before the first. */
  head: number;
  /** `next` allocates cursors from a sequence shared by every tail of the process, so a cursor never names an event of
   * another attachment. */
  constructor(private readonly next: () => number, start: number) {
    this.head = start;
    this.dropped = start;
  }
  append(event: ProtectedTerminalEvent): number {
    const cursor = streamCursorSchema.parse(this.next());
    this.head = cursor;
    if (event.type === 'state') this.state = { cursor, event };
    const size = event.type === 'output' ? event.data.length : 0;
    this.events.push({ cursor, event, size });
    this.retained += size;
    while (this.retained > RETAINED_PROTECTED_OUTPUT && this.events.length > 1) {
      const first = this.events.shift();
      if (!first) break;
      this.retained -= first.size;
      this.dropped = first.cursor;
    }
    return cursor;
  }
  /** after=null, or a cursor of an earlier process, attaches: the current state and completion, never earlier output.
   * Otherwise the retained events after `after`, led by the current state when a gap dropped it. */
  read(after: number | null): ProtectedTerminalBatch {
    const state = this.state ? [this.state.event] : [];
    if (after === null || after > this.head) {
      const last = this.events.at(-1);
      return { cursor: this.head, events: [...state, ...(last?.event.type === 'complete' ? [last.event] : [])] };
    }
    const missed = after < this.dropped && this.state !== null && this.state.cursor <= this.dropped ? state : [];
    return { cursor: this.head, events: [...missed, ...this.events.filter((entry) => entry.cursor > after).map((entry) => entry.event)] };
  }
}
