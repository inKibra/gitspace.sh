import { createHash } from 'node:crypto';
import { artifactManifestSchema, artifactObjectKey } from '@gitspace/protocol';
import type { ArtifactManifest } from '@gitspace/protocol';
import { streamBytes } from '@gitspace/protocol-workspace';
import type { StorageMigrationClass, StorageMigrationInventory, StorageMigrationStatus } from '@gitspace/protocol/storage-migration';
import { BudgetedDurableObject } from './storage-quarantine.js';
import {
  LEGACY_CHUNKED, LEGACY_OVERHEAD, LEGACY_SINGLE, LegacyKeyMismatch, legacyDriveName, legacyScopeKey, openLegacyEnvelope, openLegacyInventory, sha256Hex, streamLegacyEnvelope,
} from './storage-migration-envelope.js';
import type { LegacyInventory } from './storage-migration-envelope.js';
import { tenantNamespace, tenantStore } from './tenant-store.js';
import type { Sha256 } from './tenant-store.js';

/** Objects whose sealed bytes are read whole; only a few old single drive envelopes are larger, and are streamed. */
const IN_MEMORY_BYTES = 64 * 1024 * 1024;
/** A chunked root lists 128 bytes or less per 32 MiB chunk, so one this size describes 256 GiB. */
const ROOT_BYTES = 1024 * 1024;
/** Objects at most this size are converted and verified in parallel groups. */
const SMALL_BYTES = 1024 * 1024;
const PARALLEL = 8;
/** One alarm step stops after about this many plaintext bytes or these many rows, within an invocation's CPU and
 * subrequest limits. */
const STEP_BYTES = 1024 * 1024 * 1024;
const STEP_ROWS = 96;
const SCAN_ROWS = 256;
const LIST_PAGES = 10;
const DELETE_BATCHES = 10;
const RETRIES = 5;
const RETRY_MS = 30_000;
const PROBLEMS = 100;
/** An object whose work was started this often without finishing stopped the step each time (CPU or memory limit):
 * it is reported and skipped rather than stopping the job. */
const INTERRUPTIONS = 3;

type Phase = StorageMigrationStatus['phase'];
type State = 'pending' | 'converted' | 'joined' | 'chunk' | 'part' | 'orphan' | 'failed' | 'skipped';
/** SQL rows: type aliases, as the cursor's row type must be indexable. */
type JobRow = { phase: Phase; list_cursor: string | null; cursor: string | null; started_at: string | null; updated_at: string | null; error: string | null; attempts: number };
type ObjectRow = { key: string; class: StorageMigrationClass; size: number; scope: string | null; name: string | null; sha256: string | null; plain_size: number | null; attempts: number };
type Tally = { count: number; bytes: number };
interface Candidate { scope: string; key: Uint8Array }
/** A converted object's plaintext: whole, or a source that can be read again for a second pass. */
type Plaintext =
  | { kind: 'bytes'; scope: string; bytes: Uint8Array; joined: string[] }
  | { kind: 'stream'; scope: string; size: number; sha256: string | null; read: () => AsyncIterable<Uint8Array>; joined: string[] };

/** The phase each phase moves to once it has nothing left; null for phases at rest. */
const NEXT_PHASE: Record<Phase, Phase | null> = {
  idle: null, inventory: 'references', references: 'scan', scan: 'convert', convert: 'converted', converted: null,
  verify: 'verified', verified: null, purge: 'purged', purged: null,
};
const INITIAL_STATE: Record<StorageMigrationClass, State> = {
  drive: 'pending', lfs: 'pending', checkpoint: 'pending', omp: 'pending', lfsChunk: 'chunk', checkpointChunk: 'chunk', other: 'skipped',
};
const DRIVE_NAME = /^accounts\/([^/]+)\/artifacts\/sha256\/([a-f0-9]{64})$/u;
const LFS_NAME = /^lfs\/projects\/([^/]+)\/objects\/([a-f0-9]{64})(\.chunks\/[a-f0-9]{64})?$/u;
const CHECKPOINT_NAME = /^projects\/([^/]+)\/spaces\/([^/]+)\/(checkpoints\/\d+\/manifest|artifacts\/manifests\/\d+\/\d+|agent\/omp\/\d+)\.enc(\.chunks\/[a-f0-9]{64})?$/u;
const SPACE_NAME = /^(?:lfs\/)?projects\/([^/]+)\/(?:spaces\/([^/]+)\/)?/u;

/** Which old-format namespace an account-relative name belongs to. */
function classifyLegacyName(name: string, userId: string): StorageMigrationClass {
  const drive = DRIVE_NAME.exec(name);
  if (drive) return name === legacyDriveName(userId, `sha256:${drive[2]}`) ? 'drive' : 'other';
  const lfs = LFS_NAME.exec(name);
  if (lfs) return lfs[3] ? 'lfsChunk' : 'lfs';
  const checkpoint = CHECKPOINT_NAME.exec(name);
  if (checkpoint) return checkpoint[4] ? 'checkpointChunk' : checkpoint[3]!.startsWith('agent/') ? 'omp' : 'checkpoint';
  return 'other';
}

/** An `other` name's namespace with its ids replaced by `*`. */
function otherPrefix(name: string): string {
  const parts = name.split('/');
  if (parts[0] === 'projects') return parts[2] === 'spaces' ? `projects/*/spaces/*/${parts[4] ?? ''}` : `projects/*/${parts[2] ?? ''}`;
  if (parts[0] === 'lfs') return `lfs/${parts[1] ?? ''}/*/${parts[3] ?? ''}`;
  if (parts[0] === 'accounts') return `accounts/*/${parts[2] ?? ''}`;
  return parts.length > 1 ? parts[0]! : '(root)';
}

function emptyInventory(): StorageMigrationInventory {
  return {
    objects: { count: 0, bytes: 0 },
    classes: { drive: { count: 0, bytes: 0 }, lfs: { count: 0, bytes: 0 }, lfsChunk: { count: 0, bytes: 0 }, checkpoint: { count: 0, bytes: 0 }, checkpointChunk: { count: 0, bytes: 0 }, omp: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } },
    otherPrefixes: {},
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A pull stream over `source`, so a failing source fails the upload reading it. */
function readable(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await iterator.return?.(); },
  }, { highWaterMark: 0 });
}

/**
 * Moves the tenant's objects from the old envelope format to `sse/` objects in the tenant store, by hand: inventory,
 * scope references, a scan for chunked drive roots, conversion; then on request verification, and purge of the old
 * objects. Each step is an alarm resuming from the stored cursor. Old objects are only read, until `purge`.
 * Deleted with the migration, with `CredentialVaultDO.legacyArtifactKey`.
 */
export class StorageMigrationDO extends BudgetedDurableObject {
  private readonly prefix: string;
  private legacyKey: Promise<Uint8Array> | undefined;
  private readonly oldScopeKeys = new Map<string, Promise<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.prefix = `users/${env.ACCOUNT_ID}/`;
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS job(
        id INTEGER PRIMARY KEY CHECK (id = 1),
        phase TEXT NOT NULL,
        list_cursor TEXT,
        cursor TEXT,
        started_at TEXT,
        updated_at TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO job(id, phase) VALUES (1, 'idle');
      CREATE TABLE IF NOT EXISTS objects(
        key TEXT PRIMARY KEY,
        class TEXT NOT NULL,
        size INTEGER NOT NULL,
        state TEXT NOT NULL,
        scanned INTEGER NOT NULL DEFAULT 0,
        scope TEXT,
        root TEXT,
        name TEXT,
        sha256 TEXT,
        plain_size INTEGER,
        error TEXT,
        verified TEXT,
        verify_error TEXT,
        purged INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS objects_state ON objects(state, key);
      CREATE TABLE IF NOT EXISTS scopes(scope TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS refs(hash TEXT PRIMARY KEY, scope TEXT NOT NULL);
    `);
  }

  private job(): JobRow {
    return this.ctx.storage.sql.exec<JobRow>('SELECT phase, list_cursor, cursor, started_at, updated_at, error, attempts FROM job WHERE id = 1').one();
  }

  /** Lists and classifies the tenant's objects now, storing nothing. */
  async inventory(): Promise<StorageMigrationInventory> {
    const inventory = emptyInventory();
    let cursor: string | undefined;
    do {
      const page = await this.env.DATA.list({ prefix: this.prefix, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) {
        const name = object.key.slice(this.prefix.length);
        const objectClass = classifyLegacyName(name, this.env.ACCOUNT_ID);
        inventory.objects.count++;
        inventory.objects.bytes += object.size;
        inventory.classes[objectClass].count++;
        inventory.classes[objectClass].bytes += object.size;
        if (objectClass !== 'other') continue;
        const tally = inventory.otherPrefixes[otherPrefix(name)] ??= { count: 0, bytes: 0 };
        tally.count++;
        tally.bytes += object.size;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return inventory;
  }

  async status(): Promise<StorageMigrationStatus> {
    const sql = this.ctx.storage.sql;
    const job = this.job();
    const inventory = emptyInventory();
    for (const row of sql.exec<{ class: StorageMigrationClass; count: number; bytes: number }>('SELECT class, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM objects GROUP BY class')) {
      inventory.classes[row.class] = { count: row.count, bytes: row.bytes };
      inventory.objects.count += row.count;
      inventory.objects.bytes += row.bytes;
    }
    for (const row of sql.exec<{ key: string; size: number }>("SELECT key, size FROM objects WHERE class = 'other'")) {
      const tally = inventory.otherPrefixes[otherPrefix(row.key.slice(this.prefix.length))] ??= { count: 0, bytes: 0 };
      tally.count++;
      tally.bytes += row.size;
    }
    const states: Record<string, Tally> = {};
    for (const row of sql.exec<{ state: string; count: number; bytes: number }>('SELECT state, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM objects GROUP BY state')) {
      states[row.state] = { count: row.count, bytes: row.bytes };
    }
    const problems = (where: string, error: string) => sql.exec<{ key: string; class: StorageMigrationClass; size: number; error: string | null }>(
      `SELECT key, class, size, ${error} AS error FROM objects WHERE ${where} ORDER BY key LIMIT ${PROBLEMS}`,
    ).toArray();
    return {
      phase: job.phase,
      running: await this.ctx.storage.getAlarm() !== null,
      cursor: job.cursor,
      startedAt: job.started_at,
      updatedAt: job.updated_at,
      error: job.error,
      inventory,
      states,
      verify: sql.exec<{ ok: number; mismatch: number; unverified: number }>(`
        SELECT COALESCE(SUM(verified = 'ok'), 0) AS ok, COALESCE(SUM(verified = 'mismatch'), 0) AS mismatch, COALESCE(SUM(verified IS NULL), 0) AS unverified
        FROM objects WHERE state = 'converted'`).one(),
      purged: sql.exec<Tally>('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM objects WHERE purged = 1').one(),
      orphans: problems("state = 'orphan'", 'error'),
      failures: problems("state = 'failed'", 'error'),
      mismatches: problems("verified = 'mismatch'", 'verify_error'),
    };
  }

  /** Starts conversion, or resumes it from its cursor. After a finished run it lists again, converting what is new and
   * retrying what failed or was orphaned. */
  async start(): Promise<StorageMigrationStatus> {
    const phase = this.job().phase;
    if (phase === 'verify' || phase === 'purge') throw new Error(`Storage migration is running its ${phase} phase`);
    if (NEXT_PHASE[phase] !== null) this.ctx.storage.sql.exec('UPDATE job SET error = NULL, attempts = 0');
    else {
      const now = new Date().toISOString();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE objects SET state = 'pending', error = NULL, scanned = 0, attempts = 0 WHERE state IN ('failed', 'orphan')");
        this.ctx.storage.sql.exec("UPDATE job SET phase = 'inventory', list_cursor = NULL, cursor = NULL, started_at = ?, updated_at = ?, error = NULL, attempts = 0", now, now);
      });
    }
    await this.ctx.storage.setAlarm(Date.now());
    return this.status();
  }

  /** Reads every converted object back through the tenant store and compares it with what conversion wrote; resumes
   * a verify that stopped. */
  async verify(): Promise<StorageMigrationStatus> {
    const phase = this.job().phase;
    if (phase === 'verify') this.ctx.storage.sql.exec('UPDATE job SET error = NULL, attempts = 0');
    else if (phase !== 'converted' && phase !== 'verified' && phase !== 'purged') throw new Error('Storage migration verifies only after conversion has finished');
    else this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE objects SET verified = NULL, verify_error = NULL, attempts = 0 WHERE state = 'converted'");
      this.ctx.storage.sql.exec("UPDATE job SET phase = 'verify', cursor = NULL, updated_at = ?, error = NULL, attempts = 0", new Date().toISOString());
    });
    await this.ctx.storage.setAlarm(Date.now());
    return this.status();
  }

  /** Deletes the old objects of converted and verified objects, with the chunks and parts joined into them; resumes a
   * purge that stopped. */
  async purge(): Promise<StorageMigrationStatus> {
    const phase = this.job().phase;
    if (phase === 'purge') this.ctx.storage.sql.exec('UPDATE job SET error = NULL, attempts = 0');
    else if (phase !== 'verified') throw new Error('Storage migration purges only after a finished verify');
    else this.ctx.storage.sql.exec("UPDATE job SET phase = 'purge', cursor = NULL, updated_at = ?, error = NULL, attempts = 0", new Date().toISOString());
    await this.ctx.storage.setAlarm(Date.now());
    return this.status();
  }

  async alarm(): Promise<void> {
    const job = this.job();
    const next = NEXT_PHASE[job.phase];
    if (next === null) return;
    try {
      const done = await this.step(job);
      const now = new Date().toISOString();
      if (done) this.ctx.storage.sql.exec('UPDATE job SET phase = ?, list_cursor = NULL, cursor = NULL, updated_at = ?, error = NULL, attempts = 0', next, now);
      else this.ctx.storage.sql.exec('UPDATE job SET updated_at = ?, error = NULL, attempts = 0', now);
      if (!done || NEXT_PHASE[next] !== null) await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      const attempts = job.attempts + 1;
      console.error(JSON.stringify({ event: 'storage_migration_step_failed', phase: job.phase, cursor: job.cursor, attempts, error: message(error) }));
      this.ctx.storage.sql.exec('UPDATE job SET error = ?, attempts = ?, updated_at = ?', message(error), attempts, new Date().toISOString());
      if (attempts < RETRIES) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS * attempts);
    }
  }

  /** One bounded piece of the current phase; true once the phase has nothing left. */
  private step(job: JobRow): Promise<boolean> {
    switch (job.phase) {
      case 'inventory': return this.inventoryStep(job.list_cursor);
      case 'references': return this.referencesStep();
      case 'scan': return this.scanStep(job.cursor ?? '');
      case 'convert': return this.rowsStep(job.cursor ?? '', "state = 'pending' AND class IN ('drive', 'lfs', 'checkpoint', 'omp')", row => this.convert(row),
        "UPDATE objects SET state = 'failed', error = 'Converting it stopped the step 3 times (CPU or memory limit)' WHERE key = ?");
      case 'verify': return this.rowsStep(job.cursor ?? '', "state = 'converted' AND verified IS NULL", row => this.check(row),
        "UPDATE objects SET verified = 'mismatch', verify_error = 'Reading it back stopped the step 3 times (CPU or memory limit)' WHERE key = ?");
      case 'purge': return this.purgeStep(job.cursor ?? '');
      default: return Promise.resolve(true);
    }
  }

  private async inventoryStep(listCursor: string | null): Promise<boolean> {
    let cursor = listCursor ?? undefined;
    for (let page = 0; page < LIST_PAGES; page++) {
      const listed = await this.env.DATA.list({ prefix: this.prefix, ...(cursor ? { cursor } : {}) });
      cursor = listed.truncated ? listed.cursor : undefined;
      this.ctx.storage.transactionSync(() => {
        for (const object of listed.objects) {
          const name = object.key.slice(this.prefix.length);
          const objectClass = classifyLegacyName(name, this.env.ACCOUNT_ID);
          const root = objectClass === 'lfsChunk' || objectClass === 'checkpointChunk' ? object.key.slice(0, object.key.lastIndexOf('.chunks/')) : null;
          this.ctx.storage.sql.exec('INSERT INTO objects(key, class, size, state, root) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING', object.key, objectClass, object.size, INITIAL_STATE[objectClass], root);
          // Workspaces named in storage paths may be gone from every authority; their drive keys are still candidates.
          const space = SPACE_NAME.exec(name);
          if (space) this.addScopes([`space:${space[1]}`, ...(space[2] ? [`space:${space[2]}`] : [])]);
        }
        this.ctx.storage.sql.exec('UPDATE job SET list_cursor = ?', cursor ?? null);
      });
      if (!cursor) return true;
    }
    return false;
  }

  private addScopes(scopes: readonly string[]): void {
    for (const scope of scopes) this.ctx.storage.sql.exec('INSERT INTO scopes(scope) VALUES (?) ON CONFLICT(scope) DO NOTHING', scope);
  }

  private addRef(hash: string, scope: string): void {
    this.ctx.storage.sql.exec('INSERT INTO refs(hash, scope) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING', hash, scope);
  }

  /** A drive object carries no scope of its own: the account's drive manifests and copy records name it. */
  private async referencesStep(): Promise<boolean> {
    const userId = this.env.ACCOUNT_ID;
    for (const project of await this.env.USER_PROJECTS.getByName(userId).list()) {
      const authority = this.env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`);
      const [scopes, copies, workspaces] = await Promise.all([authority.listArtifactScopes(), authority.listArtifactCopies(), authority.listWorkspaces()]);
      this.addScopes([`space:${project.id}`, ...workspaces.map(workspace => `space:${workspace.id}`), ...scopes.map(scope => scope.id)]);
      for (const copy of copies) {
        this.addScopes([copy.sourceScopeId, copy.destinationScopeId]);
        this.addRef(copy.sourceHash, copy.sourceScopeId);
        this.addRef(copy.destinationHash, copy.destinationScopeId);
      }
      for (const scope of scopes) {
        if (!scope.manifestHash) continue;
        this.addRef(scope.manifestHash, scope.id);
        const stored = await this.env.DATA.get(`${this.prefix}${legacyDriveName(userId, scope.manifestHash)}`);
        if (!stored || stored.size > IN_MEMORY_BYTES) continue;
        const sealed = new Uint8Array(await stored.arrayBuffer());
        let entries: ArtifactManifest['entries'] = [];
        try {
          if (`sha256:${sha256Hex(sealed)}` !== scope.manifestHash) throw new Error('Manifest does not match its name');
          const manifest = artifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(await openLegacyEnvelope(sealed, await this.oldScopeKey(scope.id)))));
          if (manifest.scopeId === scope.id) entries = manifest.entries;
        } catch {
          // References only spare trial decryption: an unreadable manifest's entries are still found by it.
        }
        for (const entry of entries) this.addRef(entry.blobHash, scope.id);
      }
    }
    return true;
  }

  /** Finds chunked drive roots before conversion, so their parts are joined into them, not converted alone. */
  private async scanStep(cursor: string): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec<ObjectRow>(
      "SELECT key, class, size, scope, name, sha256, plain_size, attempts FROM objects WHERE class = 'drive' AND state = 'pending' AND scanned = 0 AND key > ? ORDER BY key LIMIT ?", cursor, SCAN_ROWS,
    ).toArray();
    if (!rows.length) return true;
    for (let index = 0; index < rows.length; index += PARALLEL * 2) {
      const group = rows.slice(index, index + PARALLEL * 2);
      await Promise.all(group.map(row => this.scan(row)));
      this.ctx.storage.sql.exec('UPDATE job SET cursor = ?', group.at(-1)!.key);
    }
    return false;
  }

  private async scan(row: ObjectRow): Promise<void> {
    try {
      const stored = row.size <= ROOT_BYTES ? await this.env.DATA.get(row.key) : null;
      const sealed = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
      if (sealed?.[0] === LEGACY_CHUNKED) {
        if (sha256Hex(sealed) !== row.key.slice(-64)) throw new Error('Drive object does not match its name');
        const opened = await this.trial(row, key => openLegacyInventory(sealed, key));
        this.ctx.storage.transactionSync(() => {
          if (!opened) {
            this.ctx.storage.sql.exec("UPDATE objects SET state = 'orphan', error = 'No known drive scope opens this object' WHERE key = ?", row.key);
            return;
          }
          this.ctx.storage.sql.exec('UPDATE objects SET scope = ? WHERE key = ?', opened.scope, row.key);
          for (const chunk of opened.value.chunks) {
            this.ctx.storage.sql.exec("UPDATE objects SET state = 'part', root = ?, scope = ? WHERE key = ? AND class = 'drive' AND state = 'pending'", row.key, opened.scope, `${this.prefix}${legacyDriveName(this.env.ACCOUNT_ID, chunk.hash)}`);
          }
        });
      }
      this.ctx.storage.sql.exec('UPDATE objects SET scanned = 1 WHERE key = ?', row.key);
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE objects SET state = 'failed', error = ?, scanned = 1 WHERE key = ?", message(error), row.key);
    }
  }

  /** Runs `work` over the next rows in name order, small objects in parallel groups, within one step's budget. A row
   * whose work was started `INTERRUPTIONS` times without finishing is given up with `abandon` (an UPDATE by key). */
  private async rowsStep(cursor: string, where: string, work: (row: ObjectRow) => Promise<number>, abandon: string): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec<ObjectRow>(
      `SELECT key, class, size, scope, name, sha256, plain_size, attempts FROM objects WHERE ${where} AND key > ? ORDER BY key LIMIT ?`, cursor, STEP_ROWS,
    ).toArray();
    if (!rows.length) return true;
    let bytes = 0;
    let index = 0;
    while (index < rows.length && bytes < STEP_BYTES) {
      let end = index + 1;
      if (rows[index]!.size <= SMALL_BYTES) while (end < rows.length && end - index < PARALLEL && rows[end]!.size <= SMALL_BYTES) end++;
      const group = rows.slice(index, end);
      const live = group.filter(row => row.attempts < INTERRUPTIONS);
      this.ctx.storage.transactionSync(() => {
        for (const row of group) this.ctx.storage.sql.exec(row.attempts < INTERRUPTIONS ? 'UPDATE objects SET attempts = attempts + 1 WHERE key = ?' : abandon, row.key);
      });
      for (const moved of await Promise.all(live.map(work))) bytes += moved;
      index = end;
      this.ctx.storage.transactionSync(() => {
        for (const row of live) this.ctx.storage.sql.exec('UPDATE objects SET attempts = 0 WHERE key = ?', row.key);
        this.ctx.storage.sql.exec('UPDATE job SET cursor = ?', group.at(-1)!.key);
      });
    }
    return false;
  }

  private async purgeStep(cursor: string): Promise<boolean> {
    for (let batch = 0; batch < DELETE_BATCHES; batch++) {
      const keys = this.ctx.storage.sql.exec<{ key: string }>(`
        SELECT o.key FROM objects o
        WHERE o.purged = 0 AND o.key > ? AND (
          (o.state = 'converted' AND o.verified = 'ok')
          OR (o.state = 'joined' AND EXISTS (SELECT 1 FROM objects r WHERE r.key = o.root AND r.state = 'converted' AND r.verified = 'ok'))
        ) ORDER BY o.key LIMIT 1000`, cursor).toArray().map(row => row.key);
      if (!keys.length) return true;
      await this.env.DATA.delete(keys);
      cursor = keys.at(-1)!;
      this.ctx.storage.transactionSync(() => {
        for (const key of keys) this.ctx.storage.sql.exec('UPDATE objects SET purged = 1 WHERE key = ?', key);
        this.ctx.storage.sql.exec('UPDATE job SET cursor = ?', cursor);
      });
    }
    return false;
  }

  /** The tenant key the old format used directly for checkpoint objects, and derived drive and LFS keys from. */
  private oldKey(): Promise<Uint8Array> {
    this.legacyKey ??= this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).legacyArtifactKey(this.env.ACCOUNT_ID);
    return this.legacyKey;
  }

  private oldScopeKey(scope: string): Promise<Uint8Array> {
    let key = this.oldScopeKeys.get(scope);
    if (!key) {
      key = this.oldKey().then(artifactKey => legacyScopeKey(artifactKey, scope));
      this.oldScopeKeys.set(scope, key);
    }
    return key;
  }

  /** The scopes an object may belong to, each with the old key it was sealed with there. A drive object's referenced
   * scope comes first, then every drive scope the account is known to have had; other objects have one, from their
   * name. */
  private async *candidates(row: ObjectRow): AsyncGenerator<Candidate> {
    const name = row.key.slice(this.prefix.length);
    if (row.class !== 'drive') {
      const scope = tenantNamespace(name)?.scope;
      if (!scope) throw new Error('Object name has no tenant scope');
      yield { scope, key: row.class === 'lfs' ? await this.oldScopeKey(scope) : await this.oldKey() };
      return;
    }
    const referenced = this.ctx.storage.sql.exec<{ scope: string }>('SELECT scope FROM refs WHERE hash = ?', `sha256:${row.key.slice(-64)}`).toArray()[0]?.scope;
    const known = this.ctx.storage.sql.exec<{ scope: string }>('SELECT scope FROM scopes ORDER BY scope').toArray().map(candidate => candidate.scope);
    for (const scope of new Set([row.scope, referenced, ...known])) if (scope) yield { scope, key: await this.oldScopeKey(scope) };
  }

  /** Opens an object with the first candidate key that authenticates it; GCM fails under any other. */
  private async trial<T>(row: ObjectRow, open: (key: Uint8Array) => Promise<T>): Promise<{ scope: string; key: Uint8Array; value: T } | null> {
    for await (const candidate of this.candidates(row)) {
      try {
        return { ...candidate, value: await open(candidate.key) };
      } catch (error) {
        if (!(error instanceof LegacyKeyMismatch)) throw error;
      }
    }
    return null;
  }

  private async convert(row: ObjectRow): Promise<number> {
    try {
      const plaintext = await this.open(row);
      if (!plaintext) {
        const state = row.class === 'drive' ? 'orphan' : 'failed';
        this.ctx.storage.sql.exec('UPDATE objects SET state = ?, error = ? WHERE key = ?', state, row.class === 'drive' ? 'No known drive scope opens this object' : 'The old tenant key does not open this object', row.key);
        return row.size;
      }
      const written = await this.publish(row, plaintext);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE objects SET state = 'converted', scope = ?, name = ?, sha256 = ?, plain_size = ?, error = NULL WHERE key = ?", plaintext.scope, written.name, written.sha256, written.size, row.key);
        for (const key of plaintext.joined) this.ctx.storage.sql.exec("UPDATE objects SET state = 'joined', root = ?, scope = ? WHERE key = ?", row.key, plaintext.scope, key);
      });
      return written.size;
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE objects SET state = 'failed', error = ? WHERE key = ?", message(error), row.key);
      return row.size;
    }
  }

  /** Authenticates an old object under its old key; its plaintext, joined from chunks or parts. */
  private async open(row: ObjectRow): Promise<Plaintext | null> {
    const stored = await this.env.DATA.get(row.key);
    if (!stored) throw new Error('Object is missing');
    // Drive objects are named by their sealed bytes; the others recorded that hash when they were written.
    const sealedHash = row.class === 'drive' ? `sha256:${row.key.slice(-64)}` : stored.customMetadata?.sha256;
    if (stored.size > IN_MEMORY_BYTES) {
      // Only an old single envelope is this large: a chunked root lists its chunks in far less.
      await stored.body.cancel();
      const opened = await this.trial(row, async key => {
        const sealed = createHash('sha256');
        const plain = createHash('sha256');
        let size = 0;
        for await (const bytes of streamLegacyEnvelope(this.env.DATA, row.key, stored.etag, stored.size, key, sealed)) {
          plain.update(bytes);
          size += bytes.byteLength;
        }
        if (sealedHash && `sha256:${sealed.digest('hex')}` !== sealedHash) throw new Error('Object does not match its recorded hash');
        return { size, sha256: plain.digest('hex') };
      });
      if (!opened) return null;
      return {
        kind: 'stream', scope: opened.scope, size: opened.value.size, sha256: opened.value.sha256, joined: [],
        read: () => streamLegacyEnvelope(this.env.DATA, row.key, stored.etag, stored.size, opened.key),
      };
    }
    const sealed = new Uint8Array(await stored.arrayBuffer());
    if (sealedHash && `sha256:${sha256Hex(sealed)}` !== sealedHash) throw new Error('Object does not match its recorded hash');
    if (sealed[0] === LEGACY_SINGLE) {
      const opened = await this.trial(row, key => openLegacyEnvelope(sealed, key));
      return opened && { kind: 'bytes', scope: opened.scope, bytes: opened.value, joined: [] };
    }
    if (sealed[0] !== LEGACY_CHUNKED) throw new Error('Object is in neither old format');
    const opened = await this.trial(row, key => openLegacyInventory(sealed, key));
    if (!opened) return null;
    // Drive parts are flat drive objects of their own; other chunks sit beside their root.
    const chunkKey = (hash: string) => row.class === 'drive' ? `${this.prefix}${legacyDriveName(this.env.ACCOUNT_ID, hash)}` : `${row.key}.chunks/${hash.slice('sha256:'.length)}`;
    return {
      kind: 'stream', scope: opened.scope, size: opened.value.size, sha256: null,
      read: () => this.chunks(opened.value, chunkKey, opened.key),
      joined: opened.value.chunks.map(chunk => chunkKey(chunk.hash)),
    };
  }

  private async *chunks(inventory: LegacyInventory, chunkKey: (hash: string) => string, key: Uint8Array): AsyncGenerator<Uint8Array> {
    for (const chunk of inventory.chunks) yield await this.chunk(chunkKey(chunk.hash), chunk, key);
  }

  /** One chunk's plaintext; its sealed bytes are garbage once this returns, so only one copy is held while joining. */
  private async chunk(name: string, chunk: LegacyInventory['chunks'][number], key: Uint8Array): Promise<Uint8Array> {
    const stored = await this.env.DATA.get(name);
    if (!stored) throw new Error(`Chunk ${name} is missing`);
    if (stored.size !== chunk.size + LEGACY_OVERHEAD) {
      await stored.body.cancel();
      throw new Error(`Chunk ${name} has the wrong size`);
    }
    const sealed = new Uint8Array(await stored.arrayBuffer());
    if (`sha256:${sha256Hex(sealed)}` !== chunk.hash) throw new Error(`Chunk ${name} does not match its name`);
    const plaintext = await openLegacyEnvelope(sealed, key);
    if (plaintext.byteLength !== chunk.size) throw new Error(`Chunk ${name} has the wrong size`);
    return plaintext;
  }

  /** Writes the plaintext as one tenant-store object, or accepts an identical one already there; never replaces one. */
  private async publish(row: ObjectRow, plaintext: Plaintext): Promise<{ name: string; sha256: Sha256; size: number }> {
    const oldName = row.key.slice(this.prefix.length);
    // Drive references keep the old hash; the object moves under its scope.
    const name = row.class === 'drive' ? artifactObjectKey(this.env.ACCOUNT_ID, plaintext.scope, `sha256:${oldName.slice(-64)}`) : oldName;
    const lfsOid = row.class === 'lfs' ? oldName.slice(-64) : null;
    let hex: string;
    let size: number;
    if (plaintext.kind === 'bytes') {
      hex = sha256Hex(plaintext.bytes);
      size = plaintext.bytes.byteLength;
    } else if (plaintext.sha256 ?? lfsOid) {
      hex = plaintext.sha256 ?? lfsOid!;
      size = plaintext.size;
    } else {
      // A joined object's hash is known only after reading it all, and its write must carry it: read twice.
      const digest = createHash('sha256');
      size = 0;
      for await (const bytes of plaintext.read()) {
        digest.update(bytes);
        size += bytes.byteLength;
      }
      if (size !== plaintext.size) throw new Error('Joined object size does not match its inventory');
      hex = digest.digest('hex');
    }
    if (lfsOid && hex !== lfsOid) throw new Error('LFS object does not match its oid');
    const sha256: Sha256 = `sha256:${hex}`;
    const store = tenantStore(this.env);
    const existing = await store.head(name, plaintext.scope);
    if (!existing) {
      const body = plaintext.kind === 'bytes' ? plaintext.bytes : { stream: readable(plaintext.read()), size, sha256 };
      if (await store.put(name, plaintext.scope, body, { onlyIfAbsent: true })) return { name, sha256, size };
    }
    const current = existing ?? await store.head(name, plaintext.scope);
    if (current?.sha256 !== sha256 || current.size !== size) throw new Error('A different object already exists at its new name');
    return { name, sha256, size };
  }

  /** Reads a converted object back in full and compares it with what conversion recorded. */
  private async check(row: ObjectRow): Promise<number> {
    try {
      if (!row.scope || !row.name || !row.sha256 || row.plain_size === null) throw new Error('Converted object has no recorded name, scope or hash');
      const stored = await tenantStore(this.env).get(row.name, row.scope);
      if (!stored) throw new Error('Converted object is missing');
      const digest = createHash('sha256');
      let size = 0;
      for await (const bytes of streamBytes(stored.body)) {
        digest.update(bytes);
        size += bytes.byteLength;
      }
      const sha256 = `sha256:${digest.digest('hex')}`;
      if (sha256 !== row.sha256 || size !== row.plain_size) throw new Error(`Read ${size} bytes with ${sha256}; converted ${row.plain_size} bytes with ${row.sha256}`);
      this.ctx.storage.sql.exec("UPDATE objects SET verified = 'ok', verify_error = NULL WHERE key = ?", row.key);
      return size;
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE objects SET verified = 'mismatch', verify_error = ? WHERE key = ?", message(error), row.key);
      return row.plain_size ?? row.size;
    }
  }
}
