import { DurableObject } from 'cloudflare:workers';

export type SpaceAuthorityState = 'open' | 'closing' | 'closed' | 'opening';

export interface SpaceAuthorityRecord {
  projectId: string;
  spaceId: string;
  state: SpaceAuthorityState;
  machineId: string | null;
  generation: number;
  checkpointRevision: number;
  manifestKey: string | null;
  manifestHash: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

interface SpaceRow extends Record<string, SqlStorageValue> {
  project_id: string;
  space_id: string;
  state: SpaceAuthorityState;
  machine_id: string | null;
  generation: number;
  checkpoint_revision: number;
  manifest_key: string | null;
  manifest_hash: string | null;
  error_message: string | null;
  updated_at: string;
}

export class SpaceAuthorityDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS space_authority (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          project_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('open', 'closing', 'closed', 'opening')),
          machine_id TEXT,
          generation INTEGER NOT NULL CHECK (generation > 0),
          checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
          manifest_key TEXT,
          manifest_hash TEXT,
          error_message TEXT,
          updated_at TEXT NOT NULL,
          CHECK ((state = 'closed' AND machine_id IS NULL) OR (state != 'closed' AND machine_id IS NOT NULL))
        );
      `);
    });
  }

  bootstrap(input: { projectId: string; spaceId: string; machineId: string }): SpaceAuthorityRecord {
    validateId(input.projectId);
    validateId(input.spaceId);
    validateId(input.machineId);
    const existing = this.row();
    if (existing) {
      if (existing.project_id !== input.projectId || existing.space_id !== input.spaceId) throw new Error('Space authority identity is immutable');
      return record(existing);
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO space_authority (id, project_id, space_id, state, machine_id, generation, checkpoint_revision, updated_at) VALUES (1, ?, ?, ?, ?, 1, 0, ?)',
      input.projectId,
      input.spaceId,
      'open',
      input.machineId,
      new Date().toISOString(),
    );
    return record(this.row()!);
  }

  beginClose(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number }): { revision: number; previousRevision: number | null } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.requireIdentity(input);
      requireState(row, 'open', input.machineId, input.expectedGeneration);
      const revision = row.checkpoint_revision + 1;
      this.ctx.storage.sql.exec(
        'UPDATE space_authority SET state = ?, checkpoint_revision = ?, error_message = NULL, updated_at = ? WHERE id = 1',
        'closing',
        revision,
        new Date().toISOString(),
      );
      return { revision, previousRevision: row.checkpoint_revision === 0 ? null : row.checkpoint_revision };
    });
  }

  commitClosed(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; manifestKey: string; manifestHash: string }): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.requireIdentity(input);
      requireState(row, 'closing', input.machineId, input.expectedGeneration);
      if (row.checkpoint_revision !== input.revision) throw new Error('Checkpoint revision changed');
      validateManifest(input.manifestKey, input.manifestHash);
      this.ctx.storage.sql.exec(
        'UPDATE space_authority SET state = ?, machine_id = NULL, generation = generation + 1, manifest_key = ?, manifest_hash = ?, error_message = NULL, updated_at = ? WHERE id = 1',
        'closed',
        input.manifestKey,
        input.manifestHash,
        new Date().toISOString(),
      );
    });
  }

  abortClose(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; message: string }): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.requireIdentity(input);
      requireState(row, 'closing', input.machineId, input.expectedGeneration);
      if (row.checkpoint_revision !== input.revision) throw new Error('Checkpoint revision changed');
      this.ctx.storage.sql.exec(
        'UPDATE space_authority SET state = ?, error_message = ?, updated_at = ? WHERE id = 1',
        'open',
        input.message.slice(0, 2_048),
        new Date().toISOString(),
      );
    });
  }

  beginOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number }): { revision: number; manifestKey: string; manifestHash: `sha256:${string}` } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.requireIdentity(input);
      if (row.state !== 'closed' || row.machine_id !== null || row.generation !== input.expectedGeneration) throw new Error('Space is not closed at the expected generation');
      if (!row.manifest_key || !row.manifest_hash || !/^sha256:[a-f0-9]{64}$/u.test(row.manifest_hash)) throw new Error('Closed space has no valid checkpoint manifest');
      this.ctx.storage.sql.exec(
        'UPDATE space_authority SET state = ?, machine_id = ?, generation = generation + 1, error_message = NULL, updated_at = ? WHERE id = 1',
        'opening',
        input.machineId,
        new Date().toISOString(),
      );
      return { revision: row.checkpoint_revision, manifestKey: row.manifest_key, manifestHash: row.manifest_hash as `sha256:${string}` };
    });
  }

  commitOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number }): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.requireIdentity(input);
      requireState(row, 'opening', input.machineId, input.expectedGeneration + 1);
      if (row.checkpoint_revision !== input.revision) throw new Error('Checkpoint revision changed');
      this.ctx.storage.sql.exec('UPDATE space_authority SET state = ?, error_message = NULL, updated_at = ? WHERE id = 1', 'open', new Date().toISOString());
    });
  }

  failOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; message: string }): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.requireIdentity(input);
      requireState(row, 'opening', input.machineId, input.expectedGeneration + 1);
      if (row.checkpoint_revision !== input.revision) throw new Error('Checkpoint revision changed');
      this.ctx.storage.sql.exec(
        'UPDATE space_authority SET state = ?, machine_id = NULL, error_message = ?, updated_at = ? WHERE id = 1',
        'closed',
        input.message.slice(0, 2_048),
        new Date().toISOString(),
      );
    });
  }

  get(): SpaceAuthorityRecord | null {
    const row = this.row();
    return row ? record(row) : null;
  }

  private row(): SpaceRow | undefined {
    return this.ctx.storage.sql.exec<SpaceRow>('SELECT project_id, space_id, state, machine_id, generation, checkpoint_revision, manifest_key, manifest_hash, error_message, updated_at FROM space_authority WHERE id = 1').toArray()[0];
  }

  private requireIdentity(input: { projectId: string; spaceId: string }): SpaceRow {
    const row = this.row();
    if (!row || row.project_id !== input.projectId || row.space_id !== input.spaceId) throw new Error('Space authority identity does not match');
    return row;
  }
}

function requireState(row: SpaceRow, state: SpaceAuthorityState, machineId: string, generation: number): void {
  if (row.state !== state || row.machine_id !== machineId || row.generation !== generation) throw new Error(`Space is not ${state} on the expected machine generation`);
}

function record(row: SpaceRow): SpaceAuthorityRecord {
  return {
    projectId: row.project_id,
    spaceId: row.space_id,
    state: row.state,
    machineId: row.machine_id,
    generation: row.generation,
    checkpointRevision: row.checkpoint_revision,
    manifestKey: row.manifest_key,
    manifestHash: row.manifest_hash,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

function validateId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error('Authority id is invalid');
}

function validateManifest(key: string, hash: string): void {
  if (!key || key.startsWith('/') || key.includes('..')) throw new Error('Manifest key is invalid');
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) throw new Error('Manifest hash is invalid');
}
