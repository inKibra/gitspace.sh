import type { StreamEvent } from '@gitspace/protocol-sync';
import { streamCursorSchema } from '@gitspace/protocol-sync';
import type { WorkspaceTerminalView, WorkspaceTerminalOutput } from './workspace-hub.js';

export interface TerminalSnapshot { terminals: WorkspaceTerminalView[]; output: WorkspaceTerminalOutput | null }
interface Change { cursor: number; previous: number; value: TerminalSnapshot }
interface Head { cursor: number; body: string; value: TerminalSnapshot }
const RETAINED_SNAPSHOTS = 16;

/** In-process observations of supervisor output; full values and replay revisions commit together.
 * Revisions restart with the process, so clients resuming from an earlier process resync as cursor-ahead. */
export class TerminalSnapshotJournal {
  readonly listeners = new Set<(resource: string) => void>();
  private readonly heads = new Map<string, Head>();
  private readonly changes = new Map<string, Change[]>();
  private revision = 0;
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
    for (const listener of this.listeners) listener(resource);
  }
  replay(resource: string, after: number | null, initial: boolean): StreamEvent<TerminalSnapshot>[] {
    const head = this.heads.get(resource);
    if (!head) return [];
    const snapshot = (): StreamEvent<TerminalSnapshot> => ({ type: 'snapshot', resource, cursor: head.cursor, revision: head.cursor, previous: null, value: head.value });
    if (after === null) return [snapshot()];
    const rows = (this.changes.get(resource) ?? []).filter((row) => row.cursor > after);
    if (after > head.cursor || (after < head.cursor && rows[0]?.previous !== after)) return [
      { type: 'resync', resource, cursor: head.cursor, revision: head.cursor, reason: after > head.cursor ? 'cursor-ahead' : 'cursor-expired' }, snapshot(),
    ];
    if (rows.length) return rows.map((row) => ({ type: 'change', resource, cursor: row.cursor, revision: row.cursor, previous: row.previous, value: row.value }));
    return initial ? [snapshot()] : [];
  }
}
