import type { GitSpaceDatabase } from '@gitspace/core';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { streamCursorSchema } from '@gitspace/protocol-sync';
import { sql } from 'drizzle-orm';
import type { WorkspaceTerminalView, WorkspaceTerminalOutput } from './workspace-hub.js';

export interface TerminalSnapshot { terminals: WorkspaceTerminalView[]; output: WorkspaceTerminalOutput | null }
interface Row { cursor: number; previous: number; body: string }
const RETAINED_SNAPSHOTS = 16;

/** App-owned observations of Hub's durable logs. A revision commits its full value and replay entry together. */
export class TerminalSnapshotJournal {
  readonly listeners = new Set<(resource: string) => void>();
  constructor(private readonly database: GitSpaceDatabase) {
    database.orm.run(sql`CREATE TABLE IF NOT EXISTS terminal_stream_changes(cursor INTEGER PRIMARY KEY AUTOINCREMENT,resource TEXT NOT NULL,previous INTEGER NOT NULL,body TEXT NOT NULL)`);
    database.orm.run(sql`CREATE INDEX IF NOT EXISTS terminal_stream_resource ON terminal_stream_changes(resource,cursor)`);
    database.orm.run(sql`CREATE TABLE IF NOT EXISTS terminal_stream_heads(resource TEXT PRIMARY KEY,cursor INTEGER NOT NULL,body TEXT NOT NULL)`);
  }
  commit(resource: string, value: TerminalSnapshot): void {
    const body = JSON.stringify(value);
    const changed = this.database.orm.transaction((tx) => {
      const prior = tx.get<{ cursor: number; body: string }>(sql`SELECT cursor,body FROM terminal_stream_heads WHERE resource=${resource}`);
      if (prior?.body === body) return false;
      const row = tx.get<{ cursor: number }>(sql`INSERT INTO terminal_stream_changes(resource,previous,body) VALUES(${resource},${prior?.cursor ?? 0},${body}) RETURNING cursor`);
      if (!row) throw new Error('Terminal snapshot commit did not allocate a revision');
      streamCursorSchema.parse(row.cursor);
      tx.run(sql`INSERT INTO terminal_stream_heads(resource,cursor,body) VALUES(${resource},${row.cursor},${body}) ON CONFLICT(resource) DO UPDATE SET cursor=excluded.cursor,body=excluded.body`);
      tx.run(sql`DELETE FROM terminal_stream_changes WHERE resource=${resource} AND cursor < COALESCE((SELECT cursor FROM terminal_stream_changes WHERE resource=${resource} ORDER BY cursor DESC LIMIT 1 OFFSET ${RETAINED_SNAPSHOTS - 1}),0)`);
      return true;
    });
    if (changed) for (const listener of this.listeners) listener(resource);
  }
  replay(resource: string, after: number | null, initial: boolean): StreamEvent<TerminalSnapshot>[] {
    const head = this.database.orm.get<{ cursor: number; body: string }>(sql`SELECT cursor,body FROM terminal_stream_heads WHERE resource=${resource}`);
    if (!head) return [];
    const snapshot = (): StreamEvent<TerminalSnapshot> => ({ type: 'snapshot', resource, cursor: head.cursor, revision: head.cursor, previous: null, value: decode(head.body) });
    if (after === null) return [snapshot()];
    const rows = this.database.orm.all<Row>(sql`SELECT cursor,previous,body FROM terminal_stream_changes WHERE resource=${resource} AND cursor>${after} ORDER BY cursor`);
    if (after > head.cursor || (after < head.cursor && rows[0]?.previous !== after)) return [
      { type: 'resync', resource, cursor: head.cursor, revision: head.cursor, reason: after > head.cursor ? 'cursor-ahead' : 'cursor-expired' }, snapshot(),
    ];
    if (rows.length) return rows.map((row) => ({ type: 'change', resource, cursor: row.cursor, revision: row.cursor, previous: row.previous, value: decode(row.body) }));
    return initial ? [snapshot()] : [];
  }
}
function decode(body: string): TerminalSnapshot {
  const value = JSON.parse(body) as TerminalSnapshot;
  return { ...value, terminals: value.terminals.map((terminal) => ({ ...terminal, createdAt: new Date(terminal.createdAt) })) };
}
