import { Database } from 'bun:sqlite';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { deploymentPlanSchema, type DeploymentPlan, type EntrypointId } from './contracts.js';

export const deploymentRunStates = [
  'planned',
  'draining',
  'staging',
  'activating',
  'health-checking',
  'committed',
  'rolling-back',
  'rolled-back',
  'failed',
] as const;
export type DeploymentRunState = typeof deploymentRunStates[number];

export const deploymentStepStates = [
  'pending',
  'drained',
  'staged',
  'activated',
  'healthy',
  'committed',
  'rolled-back',
] as const;
export type DeploymentStepState = typeof deploymentStepStates[number];

export interface DeploymentRunRecord {
  id: string;
  planHash: string;
  plan: DeploymentPlan;
  state: DeploymentRunState;
  attempt: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentStepRecord {
  runId: string;
  attempt: number;
  entrypoint: EntrypointId;
  ordinal: number;
  state: DeploymentStepState;
  detail?: string;
  updatedAt: string;
}

interface RunRow extends Record<string, string | number | null> {
  id: string;
  plan_hash: string;
  plan_json: string;
  state: string;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow extends Record<string, string | number | null> {
  run_id: string;
  attempt: number;
  entrypoint: EntrypointId;
  ordinal: number;
  state: string;
  detail: string | null;
  updated_at: string;
}

export class DeploymentJournalConflict extends TaggedError('DeploymentJournalConflict')<{
  deploymentId: string;
  message: string;
}> {}

export class DeploymentJournal {
  private readonly database: Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath, { create: true, strict: true });
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS deployment_runs (
        id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployment_steps (
        run_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        entrypoint TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, attempt, entrypoint),
        FOREIGN KEY(run_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  begin(plan: DeploymentPlan): ResultType<DeploymentRunRecord, DeploymentJournalConflict> {
    const existing = this.load(plan.id);
    if (existing) {
      return existing.planHash === plan.planHash
        ? Result.ok(existing)
        : Result.err(new DeploymentJournalConflict({
            deploymentId: plan.id,
            message: 'Deployment id already belongs to a different plan hash',
          }));
    }
    const now = new Date().toISOString();
    this.database.query(`
      INSERT INTO deployment_runs(id, plan_hash, plan_json, state, attempt, created_at, updated_at)
      VALUES (?, ?, ?, 'planned', 1, ?, ?)
    `).run(plan.id, plan.planHash, JSON.stringify(plan), now, now);
    return Result.ok(this.load(plan.id)!);
  }

  load(id: string): DeploymentRunRecord | null {
    const row = this.database.query<RunRow, [string]>(
      'SELECT * FROM deployment_runs WHERE id = ?',
    ).get(id);
    if (!row) return null;
    const plan = deploymentPlanSchema.parse(JSON.parse(row.plan_json));
    if (!deploymentRunStates.includes(row.state as DeploymentRunState)) throw new Error(`Unknown deployment state ${row.state}`);
    return {
      id: row.id,
      planHash: row.plan_hash,
      plan,
      state: row.state as DeploymentRunState,
      attempt: row.attempt,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  transition(id: string, state: DeploymentRunState, error?: string): DeploymentRunRecord {
    const now = new Date().toISOString();
    const result = this.database.query(
      'UPDATE deployment_runs SET state = ?, error = ?, updated_at = ? WHERE id = ?',
    ).run(state, error ?? null, now, id);
    if (result.changes !== 1) throw new Error(`Deployment ${id} does not exist`);
    return this.load(id)!;
  }

  recordStep(
    id: string,
    entrypoint: EntrypointId,
    ordinal: number,
    state: DeploymentStepState,
    detail?: string,
  ): DeploymentStepRecord {
    const run = this.load(id);
    if (!run) throw new Error(`Deployment ${id} does not exist`);
    const now = new Date().toISOString();
    this.database.query(`
      INSERT INTO deployment_steps(run_id, attempt, entrypoint, ordinal, state, detail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, attempt, entrypoint) DO UPDATE SET
        ordinal = excluded.ordinal,
        state = excluded.state,
        detail = excluded.detail,
        updated_at = excluded.updated_at
    `).run(id, run.attempt, entrypoint, ordinal, state, detail ?? null, now);
    return this.steps(id).find((step) => step.entrypoint === entrypoint)!;
  }

  steps(id: string): DeploymentStepRecord[] {
    const run = this.load(id);
    if (!run) return [];
    return this.database.query<StepRow, [string, number]>(`
      SELECT * FROM deployment_steps WHERE run_id = ? AND attempt = ? ORDER BY ordinal
    `).all(id, run.attempt).map((row) => ({
      runId: row.run_id,
      attempt: row.attempt,
      entrypoint: row.entrypoint,
      ordinal: row.ordinal,
      state: row.state as DeploymentStepState,
      ...(row.detail ? { detail: row.detail } : {}),
      updatedAt: row.updated_at,
    }));
  }

  restart(id: string): DeploymentRunRecord {
    const run = this.load(id);
    if (!run) throw new Error(`Deployment ${id} does not exist`);
    const now = new Date().toISOString();
    this.database.query(`
      UPDATE deployment_runs SET state = 'planned', attempt = attempt + 1, error = NULL, updated_at = ? WHERE id = ?
    `).run(now, id);
    return this.load(id)!;
  }
}
