import type { ConversationId, EntryId, Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { TranscriptProjector, previewTranscriptItem, transcriptPageRequestSchema, transcriptContentRequestSchema, TRANSCRIPT_PAGE_ROWS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_CONTENT_CHUNK_CHARACTERS, type TranscriptItem, type TranscriptRow, type TranscriptPageRequest, type TranscriptPage, type TranscriptContentRequest, type TranscriptContentPage } from '@gitspace/blocks';
import type { RuntimeToolResult } from '@gitspace/protocol-runtime';

/** Disposable SQLite projection of immutable Pi entries. Cold builds stream ancestry;
 * warm reads visit only appended entries and bounded preview/content windows. */
export function createTranscriptIndex(durable: DurableObjectStorage, storage: Storage, getExecutorResult?: (reference: { attemptId: string; sha256: string }, conversationId: string) => RuntimeToolResult | undefined) {
  const sql = durable.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_state(conversation INTEGER PRIMARY KEY,leaf TEXT,checkpoint TEXT NOT NULL,revision INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_rows(conversation INTEGER NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,turn TEXT NOT NULL,status TEXT NOT NULL,preview TEXT NOT NULL,characters INTEGER NOT NULL,revision INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversation,id),UNIQUE(conversation,ordinal))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_content(conversation INTEGER NOT NULL,id TEXT NOT NULL,chunk INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(conversation,id,chunk))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_execution(conversation INTEGER NOT NULL,execution TEXT NOT NULL,row TEXT NOT NULL,PRIMARY KEY(conversation,execution,row))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_binding(conversation INTEGER NOT NULL,identity TEXT NOT NULL,execution TEXT NOT NULL,PRIMARY KEY(conversation,identity))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_pending(conversation INTEGER NOT NULL,entry INTEGER NOT NULL,PRIMARY KEY(conversation,entry))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_scopes(conversation INTEGER NOT NULL,scope TEXT NOT NULL,ordinal INTEGER NOT NULL,row TEXT NOT NULL,PRIMARY KEY(conversation,scope,ordinal),UNIQUE(conversation,scope,row))');
  sql.exec('CREATE INDEX IF NOT EXISTS runtime_transcript_turn ON runtime_transcript_rows(conversation,turn)');
  sql.exec('CREATE INDEX IF NOT EXISTS runtime_transcript_membership ON runtime_transcript_execution(conversation,row)');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_transcript_counts(conversation INTEGER NOT NULL,scope TEXT NOT NULL,total INTEGER NOT NULL,PRIMARY KEY(conversation,scope))');
  type Row = { id: string; ordinal: number; turn: string; status: TranscriptRow['turnStatus']; preview: string; characters: number; revision: number };
  const columns = 'r.id,r.ordinal,r.turn,r.status,r.preview,r.characters,r.revision';
  function content(id: number, rowId: string): string { return sql.exec<{text:string}>('SELECT text FROM runtime_transcript_content WHERE conversation=? AND id=? ORDER BY chunk', id, rowId).toArray().map(row => row.text).join(''); }
  async function refresh(target: ConversationId) {
    const id = Number(target);
    const leaf = sql.exec<{leaf:string|null}>('SELECT leaf FROM runtime_history_branches WHERE id=?', id).toArray()[0]?.leaf ?? null;
    const state = sql.exec<{leaf:string|null;checkpoint:string;revision:number}>('SELECT leaf,checkpoint,revision FROM runtime_transcript_state WHERE conversation=?', id).toArray()[0];
    if (state && state.leaf === leaf) return;
    const revision = (state?.revision ?? 0) + 1;
    sql.exec(`WITH RECURSIVE path(id,parentId) AS (SELECT id,parentId FROM runtime_history_entries WHERE id=? UNION ALL SELECT e.id,e.parentId FROM runtime_history_entries e JOIN path p ON e.id=p.parentId WHERE p.id IS NOT ?) INSERT OR IGNORE INTO runtime_transcript_pending SELECT ?,CAST(id AS INTEGER) FROM path WHERE id IS NOT ?`, leaf, state?.leaf ?? null, id, state?.leaf ?? null);
    const projector = new TranscriptProjector(`pi:${id}`, {
      read(rowId) { const text = content(id, rowId); return text ? JSON.parse(text) as TranscriptItem : undefined; },
      owner(rowId) { return sql.exec<{turn:string}>('SELECT turn FROM runtime_transcript_rows WHERE conversation=? AND id=?', id, rowId).toArray()[0]?.turn; },
      write(turn, item) {
        const previous = sql.exec<{ordinal:number;turn:string;status:string}>('SELECT ordinal,turn,status FROM runtime_transcript_rows WHERE conversation=? AND id=?', id, item.id).toArray()[0];
        const ordinal = previous?.ordinal ?? sql.exec<{n:number}>('SELECT COALESCE(MAX(ordinal)+1,0) AS n FROM runtime_transcript_rows WHERE conversation=?', id).toArray()[0]!.n;
        const text = JSON.stringify(item);
        sql.exec('INSERT INTO runtime_transcript_rows(conversation,id,ordinal,turn,status,preview,characters,revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation,id) DO UPDATE SET preview=excluded.preview,characters=excluded.characters,revision=excluded.revision', id, item.id, ordinal, previous?.turn ?? turn, previous?.status ?? 'running', JSON.stringify(previewTranscriptItem(item)), text.length, revision);
        if (!previous) {
          sql.exec("INSERT INTO runtime_transcript_counts VALUES(?,'',1) ON CONFLICT(conversation,scope) DO UPDATE SET total=total+1", id);
          sql.exec("INSERT INTO runtime_transcript_scopes VALUES(?,'',?,?)", id, ordinal, item.id);
        }
        sql.exec('DELETE FROM runtime_transcript_content WHERE conversation=? AND id=?', id, item.id);
        for (let offset = 0; offset < text.length; offset += TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) sql.exec('INSERT INTO runtime_transcript_content VALUES(?,?,?,?)', id, item.id, offset / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS, text.slice(offset, offset + TRANSCRIPT_CONTENT_CHUNK_CHARACTERS));
      },
      turn(turn, status) { sql.exec('UPDATE runtime_transcript_rows SET status=? WHERE conversation=? AND turn=?', status, id, turn); },
      linkExecution(execution, row, hide) {
        const exists = sql.exec('SELECT 1 FROM runtime_transcript_execution WHERE conversation=? AND execution=? AND row=?', id, execution, row).toArray().length > 0;
        sql.exec('INSERT OR IGNORE INTO runtime_transcript_execution VALUES(?,?,?)', id, execution, row);
        if (!exists) sql.exec('INSERT INTO runtime_transcript_counts VALUES(?,?,1) ON CONFLICT(conversation,scope) DO UPDATE SET total=total+1', id, execution);
        sql.exec('INSERT OR IGNORE INTO runtime_transcript_scopes SELECT conversation,?,ordinal,id FROM runtime_transcript_rows WHERE conversation=? AND id=?', execution, id, row);
        if (hide && sql.exec('SELECT 1 FROM runtime_transcript_rows WHERE conversation=? AND id=? AND hidden=0', id, row).toArray().length) {
          sql.exec('UPDATE runtime_transcript_rows SET hidden=1 WHERE conversation=? AND id=?', id, row);
          sql.exec("UPDATE runtime_transcript_counts SET total=total-1 WHERE conversation=? AND scope=''", id);
          sql.exec("DELETE FROM runtime_transcript_scopes WHERE conversation=? AND scope='' AND row=?", id, row);
        }
        return !exists;
      },
      executionRun(identity, row) { return sql.exec<{execution:string}>('SELECT execution FROM runtime_transcript_execution WHERE conversation=? AND row=? LIMIT 1', id, row).toArray()[0]?.execution ?? sql.exec<{execution:string}>('SELECT execution FROM runtime_transcript_binding WHERE conversation=? AND identity=?', id, identity).toArray()[0]?.execution; },
      bindExecutionRun(identity, execution) { sql.exec('INSERT OR REPLACE INTO runtime_transcript_binding VALUES(?,?,?)', id, identity, execution); },
    });
    if (state) projector.restore(state.checkpoint);
    for (;;) {
      const batch = sql.exec<{entry:number}>('SELECT entry FROM runtime_transcript_pending WHERE conversation=? ORDER BY entry LIMIT 64', id).toArray();
      if (!batch.length) break;
      for (const next of batch) {
        const found = await storage.entry(next.entry as EntryId, BACKGROUND_CONTEXT);
        if (!found) throw new Error('Transcript source entry unavailable');
        const entry = found.entry;
        durable.transactionSync(() => {
          let ordinal = Number(entry.id) * 1024;
          for (const source of entry.model ?? []) {
            let message = source;
            if (source.role === 'toolResult' && source.details && typeof source.details === 'object' && 'executorResultReference' in source.details) {
              const reference = source.details.executorResultReference;
              if (reference && typeof reference === 'object' && 'attemptId' in reference && typeof reference.attemptId === 'string' && 'sha256' in reference && typeof reference.sha256 === 'string') {
                const result = getExecutorResult?.({ attemptId: reference.attemptId, sha256: reference.sha256 }, String(entry.conversationId));
                if (result) message = { ...source, content: result.content, isError: result.status !== 'completed' };
              }
            }
            projector.apply({ sessionId: `pi:${id}`, ordinal: ordinal++, kind: 'message_end', payload: { message } });
          }
          if (entry.kind === 'gitspace.model-fallback') projector.apply({ sessionId: `pi:${id}`, ordinal, kind: 'message_end', payload: { message: { role: 'custom', customType: 'gitspace.model-fallback', display: true, content: typeof entry.data === 'object' && entry.data !== null && 'message' in entry.data ? String(entry.data.message) : '' } } });
          projector.flush();
          sql.exec('INSERT OR REPLACE INTO runtime_transcript_state VALUES(?,?,?,?)', id, String(entry.id), projector.checkpoint(), revision);
          sql.exec('DELETE FROM runtime_transcript_pending WHERE conversation=? AND entry=?', id, next.entry);
        });
      }
    }
    if (!state && leaf === null) sql.exec('INSERT OR IGNORE INTO runtime_transcript_state VALUES(?,?,?,?)', id, null, projector.checkpoint(), revision);
  }
  let pending = Promise.resolve();
  function ready(target: ConversationId) { pending = pending.catch(() => {}).then(() => refresh(target)); return pending; }
  return {
    async page(target: ConversationId, request: TranscriptPageRequest): Promise<TranscriptPage> {
      request = transcriptPageRequestSchema.parse(request);
      await ready(target);
      const id = Number(target), generation = `pi-transcript-v1:${id}`;
      if (request.generation !== null && request.generation !== generation) request = { generation: null, before: null, after: null, around: null, executionId: request.executionId };
      const args = [id, request.executionId ?? ''];
      const total = sql.exec<{total:number}>('SELECT total FROM runtime_transcript_counts WHERE conversation=? AND scope=?', id, request.executionId ?? '').toArray()[0]?.total ?? 0;
      const around = request.around ? sql.exec<{ordinal:number}>('SELECT ordinal FROM runtime_transcript_scopes WHERE conversation=? AND scope=? AND row=?', ...args, request.around).toArray()[0]?.ordinal : undefined;
      if (request.around && around === undefined) throw new Error('Transcript row not found');
      const ascending = request.after !== null || around !== undefined;
      const boundary = around !== undefined ? around - 1 : request.after ?? request.before ?? Number.MAX_SAFE_INTEGER;
      const selected = sql.exec<Row>(`SELECT ${columns} FROM runtime_transcript_scopes s JOIN runtime_transcript_rows r ON r.conversation=s.conversation AND r.id=s.row WHERE s.conversation=? AND s.scope=? AND s.ordinal ${ascending ? '>' : '<'} ? ORDER BY s.ordinal ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, ...args, boundary, TRANSCRIPT_PAGE_ROWS).toArray();
      const rows: TranscriptRow[] = []; let bytes = 2;
      for (const row of selected) { const value: TranscriptRow = { id: row.id, ordinal: row.ordinal, turnId: row.turn, turnStatus: row.status, contentRevision: row.revision, ...JSON.parse(row.preview) }; const size = new TextEncoder().encode(JSON.stringify(value)).byteLength + 1; if (bytes + size > TRANSCRIPT_PAGE_BYTES) break; rows.push(value); bytes += size; }
      if (!ascending) rows.reverse();
      const first = rows[0]?.ordinal, last = rows.at(-1)?.ordinal;
      const has = (comparison: string, ordinal: number | undefined) => ordinal !== undefined && sql.exec(`SELECT 1 FROM runtime_transcript_scopes WHERE conversation=? AND scope=? AND ordinal ${comparison} ? LIMIT 1`, ...args, ordinal).toArray().length > 0;
      const revision = sql.exec<{revision:number}>('SELECT revision FROM runtime_transcript_state WHERE conversation=?', id).toArray()[0]!.revision;
      return { generation, revision, rows, total, hasBefore: has('<', first), hasAfter: has('>', last) };
    },
    async content(target: ConversationId, request: TranscriptContentRequest): Promise<TranscriptContentPage> {
      request = transcriptContentRequestSchema.parse(request); await ready(target);
      const id = Number(target);
      if (request.generation !== `pi-transcript-v1:${id}`) throw new Error('Transcript generation changed');
      const row = sql.exec<{characters:number;revision:number}>('SELECT characters,revision FROM runtime_transcript_rows WHERE conversation=? AND id=?', id, request.rowId).toArray()[0];
      if (!row) throw new Error('Transcript row not found');
      if (request.offset > row.characters) throw new Error('Transcript content offset is out of range');
      const end = Math.min(row.characters, request.offset + TRANSCRIPT_CONTENT_CHARACTERS);
      const first = Math.floor(request.offset / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
      const text = sql.exec<{text:string}>('SELECT text FROM runtime_transcript_content WHERE conversation=? AND id=? AND chunk>=? AND chunk<? ORDER BY chunk', id, request.rowId, first, Math.ceil(end / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS)).toArray().map(value => value.text).join('').slice(request.offset - first * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS, end - first * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
      return { text, offset: request.offset, nextOffset: end < row.characters ? end : null, totalCharacters: row.characters, contentRevision: row.revision };
    },
  };
}
