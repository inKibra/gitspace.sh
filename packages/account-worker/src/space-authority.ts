import { DurableObject } from 'cloudflare:workers';
import { abortSpaceClose, beginSpaceClose, beginSpaceOpen, bootstrapSpaceAuthority, commitSpaceClosed, commitSpaceOpen, failSpaceOpen, SpaceAuthorityRecordSchema, WorkspaceDomainError, type SpaceAuthorityMutation, type SpaceAuthorityRecord, type SpaceAuthorityResult, type VerifiedSpaceAuthorityIdentity } from '@gitspace/protocol-workspace';
import { DurableChangeLog } from './durable-stream.js';

export class SpaceAuthorityDO extends DurableObject<Env> {
  private readonly changes: DurableChangeLog;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new DurableChangeLog(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS space_authority (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        resume_machine_id TEXT,
        record_json TEXT NOT NULL
      )`);
    });
  }

  watch(spaceId: string, after: number | null): ReadableStream<Uint8Array> {
    const state = this.get();
    if (state && state.spaceId !== spaceId) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_IDENTITY_MISMATCH', message: 'Space authority identity mismatch', context: { spaceId } });
    return this.changes.watch(`space:${spaceId}`, after, () => this.get());
  }

  private commit<T>(mutate: () => T): SpaceAuthorityResult<T> {
    try {
      const value = this.ctx.storage.transactionSync(() => {
        const value = mutate();
        const state = this.get();
        if (state) this.changes.append(`space:${state.spaceId}`, state);
        return value;
      });
      this.changes.wake();
      return { status: 'ok', value };
    } catch (error) {
      if (error instanceof WorkspaceDomainError) return { status: 'error', failure: error.toJSON() };
      throw error;
    }
  }

  bootstrap(input: VerifiedSpaceAuthorityIdentity): SpaceAuthorityResult<SpaceAuthorityRecord> {
    return this.commit(() => {
      const state = bootstrapSpaceAuthority(this.get(), input, new Date().toISOString());
      this.save(state);
      return state;
    });
  }

  beginClose(input: SpaceAuthorityMutation): SpaceAuthorityResult<{ revision: number; previousRevision: number | null }> {
    return this.commit(() => {
      const next = beginSpaceClose(this.get(), input, new Date().toISOString());
      this.save(next.state);
      return { revision: next.revision, previousRevision: next.previousRevision };
    });
  }

  commitClosed(input: SpaceAuthorityMutation & { revision: number; manifestKey: string; manifestHash: string; resumeOnMachineRestart?: boolean }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(commitSpaceClosed(this.get(), input, new Date().toISOString())));
  }

  abortClose(input: SpaceAuthorityMutation & { revision: number; message: string }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(abortSpaceClose(this.get(), input, new Date().toISOString())));
  }

  beginOpen(input: SpaceAuthorityMutation & { resumeOnMachineRestart?: boolean }): SpaceAuthorityResult<{ revision: number; manifestKey: string; manifestHash: `sha256:${string}` }> {
    return this.commit(() => {
      const next = beginSpaceOpen(this.get(), input, new Date().toISOString());
      this.save(next.state);
      return { revision: next.revision, manifestKey: next.manifestKey, manifestHash: next.manifestHash };
    });
  }

  commitOpen(input: SpaceAuthorityMutation & { revision: number }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(commitSpaceOpen(this.get(), input, new Date().toISOString())));
  }

  failOpen(input: SpaceAuthorityMutation & { revision: number; message: string }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(failSpaceOpen(this.get(), input, new Date().toISOString())));
  }

  get(): SpaceAuthorityRecord | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM space_authority WHERE id = 1').toArray()[0];
    return row ? SpaceAuthorityRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  private save(state: SpaceAuthorityRecord): void {
    this.ctx.storage.sql.exec('INSERT INTO space_authority (id, project_id, space_id, resume_machine_id, record_json) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET resume_machine_id = excluded.resume_machine_id, record_json = excluded.record_json', state.projectId, state.spaceId, state.resumeMachineId, JSON.stringify(state));
  }
}
