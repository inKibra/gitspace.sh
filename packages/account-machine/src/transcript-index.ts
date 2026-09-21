import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseTitleSlotLine } from '@oh-my-pi/pi-coding-agent/session/session-title-slot';
import {
  TranscriptProjector,
  previewTranscriptItem,
  transcriptPageRequestSchema,
  transcriptContentRequestSchema,
  TRANSCRIPT_PAGE_ROWS,
  TRANSCRIPT_PAGE_BYTES,
  TRANSCRIPT_CONTENT_CHARACTERS,
  TRANSCRIPT_CONTENT_CHUNK_CHARACTERS,
  type TranscriptItem,
  type TranscriptProjectionStore,
  type TranscriptRow,
  type TranscriptPage,
  type TranscriptPageRequest,
  type TranscriptContentPage,
  type TranscriptContentRequest,
  type TurnBlock,
} from '@gitspace/blocks';
import type { OmpTranscriptEvent } from './omp-runtime.js';
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@gitspace/protocol-agent'
import { pageSessionHistory, sourceHistoryMetadata, type HistorySourceEntry, type SessionHistorySource } from '@gitspace/protocol-agent'

interface StoredRow {
  id: string;
  ordinal: number;
  turnId: string;
  turnStatus: TurnBlock['status'];
  preview: string;
  truncated: number;
  contentBytes: number;
  contentRevision: number;
}

const PROJECTION_VERSION = '2';


async function* journalLines(path: string, start: number, end: number): AsyncGenerator<{ line: string; bytes: number }> {
  const stream = createReadStream(path, { start, end });
  let parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    let offset = 0;
    for (;;) {
      const newline = buffer.indexOf(10, offset);
      if (newline < 0) break;
      const part = buffer.subarray(offset, newline);
      parts.push(part);
      bytes += part.length;
      yield { line: Buffer.concat(parts, bytes).toString('utf8'), bytes: bytes + 1 };
      parts = [];
      bytes = 0;
      offset = newline + 1;
    }
    if (offset < buffer.length) {
      const part = buffer.subarray(offset);
      parts.push(part);
      bytes += part.length;
    }
  }
  // A final partial record is retried only after the writer completes its newline.
}
/** A private, rebuildable disk journal and render index. No transcript-sized JS cache. */
export class TranscriptIndex implements TranscriptProjectionStore {
  private readonly db: Database;
  private projector: TranscriptProjector | null = null;
  private syncing: Promise<void> | null = null;
  private recovering = false;

  constructor(path: string, private readonly sessionId: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA cache_size = -2048;
      PRAGMA temp_store = FILE;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (
        id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, turnId TEXT NOT NULL,
        preview TEXT NOT NULL,
        truncated INTEGER NOT NULL, contentBytes INTEGER NOT NULL,
        contentRevision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rows_turn ON rows(turnId);
      CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, characters INTEGER NOT NULL, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_chunks (id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(id, position));
      CREATE TABLE IF NOT EXISTS journal (
        ordinal INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL,
        pendingKey TEXT, visible INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS journal_pending ON journal(pendingKey) WHERE pendingKey IS NOT NULL;
      CREATE INDEX IF NOT EXISTS journal_kind ON journal(kind, ordinal);
      CREATE TABLE IF NOT EXISTS source_entries (id TEXT PRIMARY KEY, parentId TEXT, sequence INTEGER NOT NULL UNIQUE, event TEXT);
      CREATE INDEX IF NOT EXISTS source_entries_parent ON source_entries(parentId, sequence);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_links (
        executionId TEXT NOT NULL, rowId TEXT NOT NULL, hide INTEGER NOT NULL,
        PRIMARY KEY(executionId, rowId)
      );
      CREATE INDEX IF NOT EXISTS execution_links_row ON execution_links(rowId, hide);
      CREATE TABLE IF NOT EXISTS execution_runs (identity TEXT PRIMARY KEY, executionId TEXT NOT NULL);
    `);
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(rows)').all();
    if (!columns.some((column) => column.name === 'contentRevision')) {
      // Existing rows retain a stable revision without rebuilding their generation or chunks.
      this.db.exec('ALTER TABLE rows ADD COLUMN contentRevision INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'hidden')) this.db.exec('ALTER TABLE rows ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS rows_visibility ON rows(hidden, ordinal)');
    const sourceColumns = this.db.query<{ name: string }, []>('PRAGMA table_info(source_entries)').all();
    if (!sourceColumns.some((column) => column.name === 'historyRole')) {
      this.db.exec(`
        ALTER TABLE source_entries ADD COLUMN historyRole TEXT;
        ALTER TABLE source_entries ADD COLUMN historyPreview TEXT NOT NULL DEFAULT '';
        ALTER TABLE source_entries ADD COLUMN historyTools INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE source_entries ADD COLUMN childCount INTEGER NOT NULL DEFAULT 0;
      `);
    }
    if (!this.meta('generation')) this.reset();
    if (this.meta('projectionVersion') !== PROJECTION_VERSION) {
      // The source journal is authoritative; invalidate only the rebuildable projection.
      this.db.transaction(() => {
        this.db.exec('DELETE FROM rows; DELETE FROM turns; DELETE FROM contents; DELETE FROM content_chunks; DELETE FROM execution_links; DELETE FROM execution_runs;');
        this.setMeta('nextRow', 1);
        this.renewGeneration();
        this.projector = new TranscriptProjector(this.sessionId, this);
        for (const event of this.journal(false)) {
          this.projector.apply({ ...event, sessionId: this.sessionId, createdAt: new Date(event.createdAt) });
          this.projector.flush();
        }
        this.setMeta('projectionVersion', PROJECTION_VERSION);
      })();
    }
  }

  close(): void { this.db.close(); }
  get generation(): string { return this.meta('generation')!; }
  get initialized(): boolean { return this.meta('initialized') === '1'; }
  get eventCount(): number { return Number(this.meta('eventCount') ?? 0); }
  get hasUnpersistedBranch(): boolean { return this.meta('unpersistedBranch') === '1'; }
  get historyAnchorId(): string | null { return this.meta(this.hasUnpersistedBranch ? 'navigationLeaf' : 'fileLeaf') || null; }

  private meta(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key = ?').get(key)?.value;
  }
  private setMeta(key: string, value: string | number): void {
    this.db.query('INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
  private bump(): void { this.setMeta('revision', Number(this.meta('revision') ?? 0) + 1); }

  reset(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM rows; DELETE FROM turns; DELETE FROM contents; DELETE FROM content_chunks; DELETE FROM execution_links; DELETE FROM execution_runs; DELETE FROM journal;');
      this.setMeta('generation', randomUUID());
      this.setMeta('revision', 0);
      this.setMeta('nextRow', 1);
      this.setMeta('nextEvent', 1);
      this.setMeta('eventCount', 0);
      this.setMeta('initialized', 0);
      this.setMeta('unpersistedBranch', 0);
    })();
    this.projector = new TranscriptProjector(this.sessionId, this);
  }

  renewGeneration(): void {
    this.setMeta('generation', randomUUID());
    this.bump();
  }

  seed(events: Iterable<OmpTranscriptEvent>): void {
    this.db.transaction(() => {
      this.reset();
      for (const event of events) this.append(event.kind, event.payload, event.createdAt, false);
      this.setMeta('initialized', 1);
    })();
  }

  read(id: string): TranscriptItem | undefined {
    const row = this.db.query<{ content: string }, [string]>(`SELECT content FROM ${this.recovering ? 'recovery_items' : 'contents'} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.content) as TranscriptItem : undefined;
  }

  owner(id: string): string | undefined {
    return this.db.query<{ turnId: string }, [string]>(`SELECT turnId FROM ${this.recovering ? 'recovery_items' : 'rows'} WHERE id = ?`).get(id)?.turnId;
  }

  executionRun(identity: string, rowId: string): string | undefined {
    const links = this.recovering ? 'recovery_execution_links' : 'execution_links';
    const membership = this.db.query<{ executionId: string }, [string, string, number, string]>(
      `SELECT executionId FROM ${links} WHERE rowId = ? AND (executionId = ? OR substr(executionId, 1, ?) = ?) LIMIT 1`)
      .get(rowId, identity, identity.length + 1, `${identity}:`);
    if (membership) return membership.executionId;
    return this.db.query<{ executionId: string }, [string]>(
      `SELECT executionId FROM ${this.recovering ? 'recovery_execution_runs' : 'execution_runs'} WHERE identity = ?`)
      .get(identity)?.executionId;
  }

  bindExecutionRun(identity: string, executionId: string): void {
    this.db.query(`INSERT INTO ${this.recovering ? 'recovery_execution_runs' : 'execution_runs'} VALUES (?, ?)
      ON CONFLICT(identity) DO UPDATE SET executionId = excluded.executionId`).run(identity, executionId);
  }

  write(turnId: string, item: TranscriptItem): void {
    const content = JSON.stringify(item);
    if (this.recovering) {
      this.db.query('INSERT INTO recovery_items VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content').run(item.id, content, turnId);
      return;
    }
    const preview = previewTranscriptItem(item);
    const existing = this.db.query<{ ordinal: number }, [string]>('SELECT ordinal FROM rows WHERE id = ?').get(item.id);
    const ordinal = existing?.ordinal ?? Number(this.meta('nextRow'));
    this.db.query(`INSERT INTO rows (id, ordinal, turnId, preview, truncated, contentBytes, contentRevision) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET preview=excluded.preview,
      truncated=excluded.truncated, contentBytes=excluded.contentBytes, contentRevision=rows.contentRevision + 1`)
      .run(item.id, ordinal, turnId, JSON.stringify(preview.item), Number(preview.truncated), preview.contentBytes);
    this.db.query('INSERT INTO contents VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET characters=excluded.characters, content=excluded.content')
      .run(item.id, content.length, content);
    this.db.query('DELETE FROM content_chunks WHERE id = ?').run(item.id);
    const insert = this.db.query('INSERT INTO content_chunks VALUES (?, ?, ?)');
    for (let offset = 0; offset < content.length; offset += TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) {
      // JSON encoding preserves a surrogate pair split across independently stored chunks.
      insert.run(item.id, offset, JSON.stringify(content.slice(offset, offset + TRANSCRIPT_CONTENT_CHUNK_CHARACTERS)));
    }
    if (!existing) this.setMeta('nextRow', ordinal + 1);
    this.bump();
  }

  linkExecution(executionId: string, rowId: string, hide: boolean): boolean {
    const table = this.recovering ? 'recovery_execution_links' : 'execution_links';
    const previous = this.db.query<{ hide: number }, [string, string]>(`SELECT hide FROM ${table} WHERE executionId = ? AND rowId = ?`).get(executionId, rowId);
    if (previous && (previous.hide === 1 || !hide)) return false;
    this.db.query(`INSERT INTO ${table} VALUES (?, ?, ?) ON CONFLICT(executionId, rowId) DO UPDATE SET hide=max(hide, excluded.hide)`)
      .run(executionId, rowId, Number(hide));
    if (!this.recovering) {
      this.db.query('UPDATE rows SET hidden = EXISTS (SELECT 1 FROM execution_links WHERE rowId = rows.id AND hide = 1) WHERE id = ?').run(rowId);
      this.bump();
    }
    return previous === null;
  }

  turn(id: string, status: TurnBlock['status']): void {
    if (this.recovering) return;
    const prior = this.db.query<{ status: string }, [string]>('SELECT status FROM turns WHERE id = ?').get(id);
    if (prior?.status === status) return;
    this.db.query('INSERT INTO turns VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status').run(id, status);
    this.bump();
  }

  private currentProjector(): TranscriptProjector {
    if (!this.projector) {
      // Rebuild only projector metadata once after restart. Replaying against final
      // rows would miscount pending tools, while rewriting rows could reorder parts
      // first introduced by a later update. A disk-backed scratch store avoids both.
      this.db.exec('CREATE TEMP TABLE recovery_items (id TEXT PRIMARY KEY, content TEXT NOT NULL, turnId TEXT NOT NULL)');
      this.db.exec('CREATE TEMP TABLE recovery_execution_links (executionId TEXT NOT NULL, rowId TEXT NOT NULL, hide INTEGER NOT NULL, PRIMARY KEY(executionId, rowId))');
      this.db.exec('CREATE TEMP TABLE recovery_execution_runs (identity TEXT PRIMARY KEY, executionId TEXT NOT NULL)');
      this.recovering = true;
      try {
        this.projector = new TranscriptProjector(this.sessionId, this);
        for (const event of this.journal(false)) this.projector.apply({ ...event, sessionId: this.sessionId, createdAt: new Date(event.createdAt) });
        this.projector.flush();
      } catch (error) {
        this.projector = null;
        throw error;
      } finally {
        this.recovering = false;
        this.db.exec('DROP TABLE recovery_items; DROP TABLE recovery_execution_links; DROP TABLE recovery_execution_runs');
      }
    }
    return this.projector;
  }

  append(kind: string, payload: Record<string, unknown>, createdAt = new Date().toISOString(), coalesce = true): number {
    return this.db.transaction(() => {
      const projector = this.currentProjector();
      const toolId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
      const pendingKey = !coalesce ? null : kind === 'message_update' ? 'message' : kind === 'tool_execution_update' ? `tool:${toolId}` : null;
      const existing = pendingKey ? this.db.query<{ ordinal: number }, [string]>('SELECT ordinal FROM journal WHERE pendingKey = ?').get(pendingKey) : null;
      const ordinal = existing?.ordinal ?? Number(this.meta('nextEvent'));
      let removed = 0;
      if (coalesce && (kind === 'message_end' || kind === 'tool_execution_end')) {
        removed = this.db.query('UPDATE journal SET visible = 0, pendingKey = NULL WHERE pendingKey = ?').run(kind === 'message_end' ? 'message' : `tool:${toolId}`).changes;
      }
      this.db.query(`INSERT INTO journal (ordinal, kind, payload, createdAt, pendingKey) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ordinal) DO UPDATE SET payload=excluded.payload, createdAt=excluded.createdAt`)
        .run(ordinal, kind, JSON.stringify(payload), createdAt, pendingKey);
      if (!existing) this.setMeta('nextEvent', ordinal + 1);
      this.setMeta('eventCount', this.eventCount + (existing ? 0 : 1) - removed);
      projector.apply({ sessionId: this.sessionId, ordinal, kind, payload, createdAt: new Date(createdAt) });
      projector.flush();
      this.setMeta('initialized', 1);
      if (coalesce && kind === 'message_end') this.setMeta('unpersistedBranch', 0);
      this.bump();
      return ordinal;
    })();
  }

  private *journal(visible = true, after = 0): Generator<OmpTranscriptEvent> {
    const query = this.db.query<{ ordinal: number; kind: string; payload: string; createdAt: string }, [number]>(
      `SELECT ordinal, kind, payload, createdAt FROM journal WHERE ordinal > ? ${visible ? 'AND visible = 1' : ''} ORDER BY ordinal`);
    for (const row of query.iterate(after)) yield { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  /** Explicit lossless snapshot API; only this consumer allocates the complete event array. */
  snapshot(): OmpTranscriptEvent[] {
    return Array.from(this.journal(), (event, index) => ({ ...event, ordinal: index + 1 }));
  }

  *eventsAfter(ordinal: number): Generator<OmpTranscriptEvent> { yield* this.journal(true, ordinal); }

  lastMessage(): unknown {
    const event = this.db.query<{ payload: string }, []>("SELECT payload FROM journal WHERE kind = 'message_end' ORDER BY ordinal DESC LIMIT 1").get();
    return event ? (JSON.parse(event.payload) as Record<string, unknown>).message : undefined;
  }

  historyPage(request: SessionHistoryPageRequest, currentLeaf: string | null = this.historyAnchorId): SessionHistoryPage {
    const columns = 'id, parentId, sequence, historyRole AS role, historyPreview AS preview, historyTools AS tools, childCount';
    const source: SessionHistorySource = {
      entry: (id) => this.db.query<HistorySourceEntry, [string]>(`SELECT ${columns} FROM source_entries WHERE id = ?`).get(id),
      children: (parentId, sequence, direction, limit) => {
        const comparison = direction === 'before' ? '<' : '>';
        const order = direction === 'before' ? 'DESC' : 'ASC';
        return this.db.query<HistorySourceEntry, [string | null, number, number]>(
          `SELECT ${columns} FROM source_entries WHERE parentId IS ? AND sequence ${comparison} ? ORDER BY sequence ${order} LIMIT ?`)
          .all(parentId, sequence ?? (direction === 'before' ? Number.MAX_SAFE_INTEGER : 0), limit);
      },
    };
    return pageSessionHistory(source, request, currentLeaf);
  }

  page(request: TranscriptPageRequest): TranscriptPage {
    request = transcriptPageRequestSchema.parse(request);
    const generation = this.generation;
    const reset = request.generation !== null && request.generation !== generation;
    const before = reset ? null : request.before;
    const after = reset ? null : request.after;
    const around = reset ? null : request.around;
    const executionId = request.executionId ?? null;
    const scope = executionId === null
      ? 'rows.hidden = 0'
      : 'EXISTS (SELECT 1 FROM execution_links WHERE execution_links.rowId = rows.id AND executionId = $executionId)';
    const parameters: Record<string, string> = executionId === null ? {} : { executionId };
    const columns = 'rows.id, ordinal, turnId, coalesce(turns.status, \'done\') AS turnStatus, preview, truncated, contentBytes, contentRevision';
    const select = (where: string, cursor: number, direction: 'ASC' | 'DESC', limit: number) => this.db.query<StoredRow, Record<string, string | number>>(
      `SELECT ${columns} FROM rows LEFT JOIN turns ON turns.id = rows.turnId WHERE ${scope} AND ordinal ${where} $cursor ORDER BY ordinal ${direction} LIMIT $limit`)
      .all({ ...parameters, cursor, limit });
    let candidates: StoredRow[];
    let reverse = false;
    if (around) {
      const anchor = this.db.query<{ ordinal: number }, Record<string, string>>(`SELECT ordinal FROM rows WHERE id = $id AND ${scope}`).get({ ...parameters, id: around });
      if (!anchor) throw new Error('Transcript row is not available in this generation');
      const older = select('<', anchor.ordinal, 'DESC', TRANSCRIPT_PAGE_ROWS - 1);
      const newer = select('>=', anchor.ordinal, 'ASC', TRANSCRIPT_PAGE_ROWS);
      candidates = [];
      for (let index = 0; candidates.length < TRANSCRIPT_PAGE_ROWS && (index < older.length || index < newer.length); index++) {
        if (newer[index]) candidates.push(newer[index]!);
        if (older[index] && candidates.length < TRANSCRIPT_PAGE_ROWS) candidates.push(older[index]!);
      }
    } else if (after !== null && after !== undefined) {
      candidates = select('>', after, 'ASC', TRANSCRIPT_PAGE_ROWS);
    } else {
      candidates = select('<', before ?? Number.MAX_SAFE_INTEGER, 'DESC', TRANSCRIPT_PAGE_ROWS);
      reverse = true;
    }
    const rows: TranscriptRow[] = [];
    let bytes = 2;
    for (const candidate of candidates) {
      const { preview, truncated, ...metadata } = candidate;
      const row: TranscriptRow = { ...metadata, item: JSON.parse(preview) as TranscriptItem, truncated: Boolean(truncated) };
      const size = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
      if (bytes + size > TRANSCRIPT_PAGE_BYTES) break;
      rows.push(row);
      bytes += size;
    }
    if (around) rows.sort((left, right) => left.ordinal - right.ordinal);
    else if (reverse) rows.reverse();
    const total = this.db.query<{ count: number }, Record<string, string>>(`SELECT count(*) AS count FROM rows WHERE ${scope}`).get(parameters)!.count;
    const boundaries = this.db.query<{ hasBefore: number; hasAfter: number }, Record<string, string | number>>(`
      SELECT EXISTS (SELECT 1 FROM rows WHERE ${scope} AND ordinal < $first) AS hasBefore,
             EXISTS (SELECT 1 FROM rows WHERE ${scope} AND ordinal > $last) AS hasAfter`)
      .get({ ...parameters, first: rows[0]?.ordinal ?? after ?? before ?? Number.MAX_SAFE_INTEGER, last: rows[rows.length - 1]?.ordinal ?? after ?? before ?? 0 })!;
    return {
      generation, revision: Number(this.meta('revision')), rows, total,
      hasBefore: Boolean(boundaries.hasBefore),
      hasAfter: Boolean(boundaries.hasAfter),
    };
  }

  content(request: TranscriptContentRequest): TranscriptContentPage {
    request = transcriptContentRequestSchema.parse(request);
    return this.db.transaction(() => {
      if (request.generation !== this.generation) throw new Error('Transcript generation has changed');
      const row = this.db.query<{ characters: number; contentRevision: number }, [string]>(
        'SELECT characters, contentRevision FROM contents JOIN rows ON rows.id = contents.id WHERE contents.id = ?').get(request.rowId);
      if (!row) throw new Error('Transcript row is not available in this generation');
      if (request.offset > row.characters) throw new Error('Invalid transcript content offset');
      const start = Math.floor(request.offset / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS;
      const end = Math.min(request.offset + TRANSCRIPT_CONTENT_CHARACTERS, row.characters);
      const chunks = this.db.query<{ text: string }, [string, number, number]>(
        'SELECT text FROM content_chunks WHERE id = ? AND position >= ? AND position < ? ORDER BY position').all(request.rowId, start, end);
      const text = chunks.map((chunk) => JSON.parse(chunk.text) as string).join('').slice(request.offset - start, end - start);
      return { text, offset: request.offset, nextOffset: end < row.characters ? end : null, totalCharacters: row.characters, contentRevision: row.contentRevision };
    })();
  }

  /** Index persisted navigation metadata without touching live or pending transcript rows. */
  syncSourceFile(path: string): Promise<void> { return this.syncFile(path, false, true); }

  syncFile(path: string, reproject = false, sourceOnly = false): Promise<void> {
    if (this.syncing) return this.syncing.then(() => this.syncFile(path, reproject, sourceOnly));
    const task = this.readFileChanges(path, reproject, sourceOnly).catch((error) => {
      this.setMeta('fileIdentity', '');
      throw error;
    });
    this.syncing = task;
    void task.finally(() => { if (this.syncing === task) this.syncing = null; }).catch(() => undefined);
    return task;
  }

  /** The caller supplies the SDK's actual post-navigation leaf, including an empty branch. */
  navigateBranch(leaf: string | null): void {
    if (leaf !== null && !this.db.query('SELECT 1 FROM source_entries WHERE id = ?').get(leaf)) {
      throw new Error('Session tree entry is unavailable in the durable transcript');
    }
    this.projectBranch(leaf);
    this.setMeta('navigationLeaf', leaf ?? '');
    this.setMeta('sourceProjectionDirty', 0);
    this.setMeta('projectionSequence', this.meta('fileSequence') ?? 0);
    this.setMeta('projectionLeaf', leaf ?? '');
    this.setMeta('unpersistedBranch', 1);
  }

  private projectBranch(leaf: string | null): void {
    this.db.transaction(() => {
      this.reset();
      if (leaf !== null) {
        const branch = this.db.query<{ event: string | null }, [string]>(`WITH RECURSIVE branch(id, parentId, sequence, event) AS (
          SELECT id, parentId, sequence, event FROM source_entries WHERE id = ?
          UNION ALL SELECT source_entries.id, source_entries.parentId, source_entries.sequence, source_entries.event
          FROM source_entries JOIN branch ON source_entries.id = branch.parentId WHERE source_entries.sequence < branch.sequence
        ) SELECT event FROM branch ORDER BY sequence`);
        for (const row of branch.iterate(leaf)) {
          if (!row.event) continue;
          const event = JSON.parse(row.event) as OmpTranscriptEvent;
          this.append(event.kind, event.payload, event.createdAt, false);
        }
      }
      this.setMeta('initialized', 1);
    })();
  }

  private async boundaryHash(path: string, offset: number): Promise<string> {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(offset, 4096));
      const read = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
      return createHash('sha256').update(buffer.subarray(0, read.bytesRead)).digest('hex');
    } finally { await handle.close(); }
  }

  private async readFileChanges(path: string, reproject: boolean, sourceOnly: boolean): Promise<void> {
    const info = await stat(path);
    const identity = `${path}:${info.dev}:${info.ino}`;
    let offset = Number(this.meta('fileOffset') ?? 0);
    // Source ingestion and transcript projection have independent cursors: an
    // explorer read may discover persisted events before transcript sync does.
    let projectedSequence = Number(this.meta('projectionSequence') ?? this.meta('fileSequence') ?? 0);
    let projectedLeaf = this.meta('projectionLeaf') ?? this.meta('fileLeaf') ?? '';
    if (this.meta('projectionSequence') === undefined) {
      this.setMeta('projectionSequence', projectedSequence);
      this.setMeta('projectionLeaf', projectedLeaf);
    }
    const changed = this.meta('sourceHistoryVersion') !== '1' || this.meta('fileIdentity') !== identity || info.size < offset
      || (info.size === offset && this.meta('fileMtime') !== String(info.mtimeMs))
      || (offset > 0 && this.meta('fileBoundary') !== await this.boundaryHash(path, offset));
    if (changed) {
      if (!sourceOnly) {
        this.reset();
        projectedSequence = 0;
        projectedLeaf = '';
        this.setMeta('sourceProjectionDirty', 0);
      }
      else this.setMeta('sourceProjectionDirty', 1);
      this.db.exec('DELETE FROM source_entries');
      for (const key of ['fileHeader', 'fileLeaf', 'fileSequence']) this.setMeta(key, '');
      offset = 0;
    }
    if (offset === info.size && this.initialized && !reproject
      && (sourceOnly || (this.meta('sourceProjectionDirty') !== '1' && projectedSequence === Number(this.meta('fileSequence') ?? 0)))) return;
    let sequence = Number(this.meta('fileSequence') ?? 0);
    let leaf = this.meta('fileLeaf') || null;
    let header = this.meta('fileHeader') || null;
    let rebuild = !sourceOnly && (reproject || this.meta('sourceProjectionDirty') === '1');
    const projectEntry = (id: string, parentId: string | null, event: OmpTranscriptEvent | null) => {
      if (parentId !== (projectedLeaf || null)) rebuild = true;
      if (!rebuild && event) this.append(event.kind, event.payload, event.createdAt, event.kind === 'message_end' || event.kind === 'tool_execution_end');
      projectedLeaf = id;
    };
    if (!sourceOnly && !rebuild && projectedSequence < sequence) {
      const unprojected = this.db.query<{ id: string; parentId: string | null; event: string | null }, [number]>(
        'SELECT id, parentId, event FROM source_entries WHERE sequence > ? ORDER BY sequence');
      for (const entry of unprojected.iterate(projectedSequence)) {
        projectEntry(entry.id, entry.parentId, entry.event ? JSON.parse(entry.event) as OmpTranscriptEvent : null);
      }
    }
    this.setMeta('fileIdentity', '');
    if (offset < info.size) {
      for await (const { line, bytes } of journalLines(path, offset, info.size - 1)) {
          offset += bytes;
          if (!line.trim() || (!header && parseTitleSlotLine(line))) continue;
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (!header) {
            if (entry.type !== 'session' || typeof entry.id !== 'string') throw new Error('Invalid OMP session header');
            header = entry.id;
            continue;
          }
          sequence++;
          const id = typeof entry.id === 'string' ? entry.id : `legacy:${sequence}`;
          const parentId = entry.parentId === null || typeof entry.parentId === 'string' ? entry.parentId : leaf;
          if (parentId !== null && !this.db.query('SELECT 1 FROM source_entries WHERE id = ?').get(parentId)) {
            throw new Error('OMP transcript branch references a missing parent');
          }
          const createdAt = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString();
          const event: OmpTranscriptEvent | null = entry.type === 'message'
            ? { ordinal: sequence, kind: 'message_end', payload: { message: entry.message }, createdAt }
            : entry.type === 'custom' && typeof entry.customType === 'string'
              ? { ordinal: sequence, kind: entry.customType, payload: entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : { value: entry.data }, createdAt }
              : null;
          const history = sourceHistoryMetadata(entry.type === 'message' ? entry.message : null);
          this.db.query(`INSERT INTO source_entries (id, parentId, sequence, event, historyRole, historyPreview, historyTools)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, parentId, sequence, event ? JSON.stringify(event) : null, history.role, history.preview, history.tools);
          if (parentId !== null) this.db.query('UPDATE source_entries SET childCount = childCount + 1 WHERE id = ?').run(parentId);
          if (!sourceOnly) projectEntry(id, parentId, event);
          leaf = id;
      }
    }
    if (!header && info.size > 0) throw new Error('OMP session header is missing');
    if (rebuild) {
      const retainedNavigation = !reproject && this.hasUnpersistedBranch && projectedSequence === sequence;
      const projectionLeaf = retainedNavigation ? this.meta('navigationLeaf') || null : leaf;
      this.projectBranch(projectionLeaf);
      projectedLeaf = projectionLeaf ?? '';
      if (retainedNavigation) this.setMeta('unpersistedBranch', 1);
      this.setMeta('sourceProjectionDirty', 0);
    }
    if (!sourceOnly) {
      this.setMeta('projectionSequence', sequence);
      this.setMeta('projectionLeaf', projectedLeaf);
      if (sequence > projectedSequence) this.setMeta('unpersistedBranch', 0);
    }
    this.setMeta('fileIdentity', identity);
    this.setMeta('fileOffset', offset);
    this.setMeta('fileMtime', info.mtimeMs);
    this.setMeta('fileBoundary', await this.boundaryHash(path, offset));
    this.setMeta('fileSequence', sequence);
    this.setMeta('fileLeaf', leaf ?? '');
    this.setMeta('fileHeader', header ?? '');
    this.setMeta('sourceHistoryVersion', 1);
    this.setMeta('initialized', 1);
  }
}
