import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  previewTranscriptItem, transcriptPageRequestSchema, transcriptContentRequestSchema,
  TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_CONTENT_CHUNK_CHARACTERS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_ROWS,
  type TranscriptContentPage, type TranscriptContentRequest, type TranscriptItem, type TranscriptPage,
  type TranscriptPageRequest, type TranscriptProjectionStore, type TranscriptRow, type TurnBlock,
} from '@gitspace/blocks';

interface StoredRow extends Record<string, SqlStorageValue> {
  id: string; ordinal: number; turnId: string; turnStatus: TurnBlock['status'];
  preview: ArrayBuffer; truncated: number; contentBytes: number;
}

/** Rebuildable private SQLite state: full items exist only as bounded chunks. */
export class SavedTranscriptProjection implements TranscriptProjectionStore {
  constructor(private readonly sql: SqlStorage, readonly generation: string, private readonly key: Uint8Array | null) {
    if (key !== null && key.byteLength !== 32) throw new Error('Saved transcript encryption key must be 32 bytes');
  }

  static initialize(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation TEXT NOT NULL, complete INTEGER NOT NULL, proof BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (
        id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, turnId TEXT NOT NULL, preview BLOB NOT NULL,
        truncated INTEGER NOT NULL, contentBytes INTEGER NOT NULL, characters INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rows_visibility ON rows(hidden, ordinal);
      CREATE TABLE IF NOT EXISTS content_chunks (id TEXT NOT NULL, position INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY(id, position));
      CREATE TABLE IF NOT EXISTS execution_links (executionId TEXT NOT NULL, rowId TEXT NOT NULL, hide INTEGER NOT NULL, PRIMARY KEY(executionId, rowId));
      CREATE INDEX IF NOT EXISTS execution_links_row ON execution_links(rowId, hide);
      CREATE TABLE IF NOT EXISTS execution_runs (identity TEXT PRIMARY KEY, executionId TEXT NOT NULL);
    `);
  }

  private seal(text: string, address: string): ArrayBuffer {
    const plain = Buffer.from(text);
    if (!this.key) return Uint8Array.from(plain).buffer;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.generation}:${address}`));
    const ciphertext = cipher.update(plain);
    const final = cipher.final();
    const bytes = new Uint8Array(12 + ciphertext.length + final.length + 16);
    bytes.set(nonce);
    bytes.set(ciphertext, 12);
    bytes.set(final, 12 + ciphertext.length);
    bytes.set(cipher.getAuthTag(), bytes.length - 16);
    return bytes.buffer;
  }

  private unseal(value: ArrayBuffer, address: string): string {
    const bytes = Buffer.from(value);
    if (!this.key) return bytes.toString('utf8');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${this.generation}:${address}`));
    cipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = cipher.update(bytes.subarray(12, bytes.length - 16));
    const final = cipher.final();
    return final.length ? Buffer.concat([plain, final]).toString('utf8') : Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength).toString('utf8');
  }

  ready(): boolean {
    const state = this.sql.exec<{ generation: string; complete: number; proof: ArrayBuffer }>('SELECT generation, complete, proof FROM state').toArray()[0];
    if (!state) return false;
    if (state.generation !== this.generation || this.unseal(state.proof, 'proof') !== this.generation) throw new Error('Saved transcript index identity changed');
    return state.complete === 1;
  }

  reset(): void {
    this.sql.exec('DELETE FROM rows; DELETE FROM turns; DELETE FROM content_chunks; DELETE FROM execution_links; DELETE FROM execution_runs; DELETE FROM state;');
    this.sql.exec('INSERT INTO state VALUES (1, ?, 0, ?)', this.generation, this.seal(this.generation, 'proof'));
  }

  complete(): void { this.sql.exec('UPDATE state SET complete = 1 WHERE singleton = 1'); }

  read(id: string): TranscriptItem | undefined {
    const parts: string[] = [];
    for (const chunk of this.sql.exec<{ position: number; content: ArrayBuffer }>('SELECT position, content FROM content_chunks WHERE id = ? ORDER BY position', id)) {
      parts.push(JSON.parse(this.unseal(chunk.content, `content:${id}:${chunk.position}`)) as string);
    }
    return parts.length ? JSON.parse(parts.join('')) as TranscriptItem : undefined;
  }

  owner(id: string): string | undefined {
    return this.sql.exec<{ turnId: string }>('SELECT turnId FROM rows WHERE id = ?', id).toArray()[0]?.turnId;
  }

  write(turnId: string, item: TranscriptItem): void {
    const preview = previewTranscriptItem(item);
    const content = JSON.stringify(item);
    this.sql.exec(`INSERT INTO rows (id, ordinal, turnId, preview, truncated, contentBytes, characters, hidden)
      VALUES (?, (SELECT coalesce(max(ordinal) + 1, 0) FROM rows), ?, ?, ?, ?, ?, EXISTS (SELECT 1 FROM execution_links WHERE rowId = ? AND hide = 1))
      ON CONFLICT(id) DO UPDATE SET preview=excluded.preview, truncated=excluded.truncated, contentBytes=excluded.contentBytes, characters=excluded.characters`,
    item.id, turnId, this.seal(JSON.stringify(preview.item), `preview:${item.id}`), Number(preview.truncated), preview.contentBytes, content.length, item.id);
    this.sql.exec('DELETE FROM content_chunks WHERE id = ?', item.id);
    for (let position = 0; position < content.length; position += TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) {
      // JSON encoding preserves a surrogate pair split across independent chunks.
      this.sql.exec('INSERT INTO content_chunks VALUES (?, ?, ?)', item.id, position,
        this.seal(JSON.stringify(content.slice(position, position + TRANSCRIPT_CONTENT_CHUNK_CHARACTERS)), `content:${item.id}:${position}`));
    }
  }

  turn(id: string, status: TurnBlock['status']): void {
    this.sql.exec('INSERT INTO turns VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status', id, status);
  }

  linkExecution(executionId: string, rowId: string, hide: boolean): boolean {
    const previous = this.sql.exec<{ hide: number }>('SELECT hide FROM execution_links WHERE executionId = ? AND rowId = ?', executionId, rowId).toArray()[0];
    if (previous && (previous.hide === 1 || !hide)) return false;
    this.sql.exec('INSERT INTO execution_links VALUES (?, ?, ?) ON CONFLICT(executionId, rowId) DO UPDATE SET hide=max(hide, excluded.hide)', executionId, rowId, Number(hide));
    if (hide) this.sql.exec('UPDATE rows SET hidden = 1 WHERE id = ?', rowId);
    return previous === undefined;
  }

  executionRun(identity: string, rowId: string): string | undefined {
    const membership = this.sql.exec<{ executionId: string }>(`SELECT executionId FROM execution_links WHERE rowId = ?
      AND (executionId = ? OR substr(executionId, 1, ?) = ?) LIMIT 1`, rowId, identity, identity.length + 1, `${identity}:`).toArray()[0];
    return membership?.executionId ?? this.sql.exec<{ executionId: string }>('SELECT executionId FROM execution_runs WHERE identity = ?', identity).toArray()[0]?.executionId;
  }

  bindExecutionRun(identity: string, executionId: string): void {
    this.sql.exec('INSERT INTO execution_runs VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET executionId=excluded.executionId', identity, executionId);
  }

  page(request: TranscriptPageRequest): TranscriptPage {
    request = transcriptPageRequestSchema.parse(request);
    const current = request.generation === null || request.generation === this.generation;
    const before = current ? request.before : null;
    const after = current ? request.after : null;
    const around = current ? request.around : null;
    const executionId = request.executionId ?? null;
    const scope = executionId === null ? 'rows.hidden = 0' : 'EXISTS (SELECT 1 FROM execution_links WHERE rowId = rows.id AND executionId = ?)';
    const args = executionId === null ? [] : [executionId];
    const total = this.sql.exec<{ count: number }>(`SELECT count(*) AS count FROM rows WHERE ${scope}`, ...args).one().count;
    if (!total) return { generation: this.generation, revision: 1, rows: [], total: 0, hasBefore: false, hasAfter: false };
    const columns = "rows.id, ordinal, turnId, coalesce(turns.status, 'done') AS turnStatus, preview, truncated, contentBytes";
    const select = (comparison: '<' | '>' | '>=', cursor: number, direction: 'ASC' | 'DESC', limit: number) => this.sql.exec<StoredRow>(
      `SELECT ${columns} FROM rows LEFT JOIN turns ON turns.id = rows.turnId WHERE ${scope} AND ordinal ${comparison} ? ORDER BY ordinal ${direction} LIMIT ?`,
      ...args, cursor, limit).toArray();
    let candidates: StoredRow[];
    if (around !== null) {
      const anchor = this.sql.exec<{ ordinal: number }>(`SELECT ordinal FROM rows WHERE ${scope} AND id = ?`, ...args, around).toArray()[0];
      if (!anchor) throw new Error('Saved transcript row is not in this history');
      const older = select('<', anchor.ordinal, 'DESC', TRANSCRIPT_PAGE_ROWS - 1);
      const newer = select('>=', anchor.ordinal, 'ASC', TRANSCRIPT_PAGE_ROWS);
      candidates = [];
      for (let index = 0; candidates.length < TRANSCRIPT_PAGE_ROWS && (index < older.length || index < newer.length); index++) {
        if (newer[index]) candidates.push(newer[index]!);
        if (older[index] && candidates.length < TRANSCRIPT_PAGE_ROWS) candidates.push(older[index]!);
      }
    } else candidates = after !== null ? select('>', after, 'ASC', TRANSCRIPT_PAGE_ROWS) : select('<', before ?? Number.MAX_SAFE_INTEGER, 'DESC', TRANSCRIPT_PAGE_ROWS);
    const rows: TranscriptRow[] = [];
    let bytes = 2;
    for (const candidate of candidates) {
      const { preview, truncated, ...metadata } = candidate;
      const row: TranscriptRow = { ...metadata, contentRevision: 0, item: JSON.parse(this.unseal(preview, `preview:${candidate.id}`)) as TranscriptItem, truncated: Boolean(truncated) };
      const size = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
      if (bytes + size > TRANSCRIPT_PAGE_BYTES) break;
      rows.push(row);
      bytes += size;
    }
    rows.sort((left, right) => left.ordinal - right.ordinal);
    const first = rows[0]?.ordinal ?? after ?? before ?? Number.MAX_SAFE_INTEGER;
    const last = rows.at(-1)?.ordinal ?? after ?? before ?? -1;
    const hasBefore = this.sql.exec<{ found: number }>(`SELECT EXISTS (SELECT 1 FROM rows WHERE ${scope} AND ordinal < ?) AS found`, ...args, first).one().found;
    const hasAfter = this.sql.exec<{ found: number }>(`SELECT EXISTS (SELECT 1 FROM rows WHERE ${scope} AND ordinal > ?) AS found`, ...args, last).one().found;
    return { generation: this.generation, revision: 1, rows, total, hasBefore: Boolean(hasBefore), hasAfter: Boolean(hasAfter) };
  }

  content(request: TranscriptContentRequest): TranscriptContentPage {
    request = transcriptContentRequestSchema.parse(request);
    if (request.generation !== this.generation) throw new Error('Saved transcript generation changed');
    const row = this.sql.exec<{ characters: number }>('SELECT characters FROM rows WHERE id = ?', request.rowId).toArray()[0];
    if (!row) throw new Error('Saved transcript row does not exist');
    if (request.offset > row.characters) throw new Error('Saved transcript content offset is invalid');
    const end = Math.min(row.characters, request.offset + TRANSCRIPT_CONTENT_CHARACTERS);
    let text = '';
    if (end > request.offset) {
      const start = Math.floor(request.offset / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS;
      for (const chunk of this.sql.exec<{ position: number; content: ArrayBuffer }>('SELECT position, content FROM content_chunks WHERE id = ? AND position >= ? AND position < ? ORDER BY position', request.rowId, start, end)) {
        const part = JSON.parse(this.unseal(chunk.content, `content:${request.rowId}:${chunk.position}`)) as string;
        text += part.slice(Math.max(0, request.offset - chunk.position), end - chunk.position);
      }
      if (text.length !== end - request.offset) throw new Error('Saved transcript content is incomplete');
    }
    return { text, offset: request.offset, nextOffset: end < row.characters ? end : null, totalCharacters: row.characters, contentRevision: 0 };
  }
}
