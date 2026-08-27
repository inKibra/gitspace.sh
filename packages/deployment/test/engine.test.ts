import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import {
  createDeploymentPlan,
  DeploymentEngine,
  DeploymentJournal,
  ReplacementActionError,
  type DeploymentPlan,
  type EntrypointId,
  type ReplacementContext,
  type ReplacementDriver,
  type ReplacementPhase,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;

async function sandboxPlan(): Promise<DeploymentPlan> {
  const result = await createDeploymentPlan({
    source: { projectId: 'gitspace', revision: 'abc123', dirty: true },
    target: { environmentId: 'sandbox-b', kind: 'sandbox', expectedGeneration: 'gen-a' },
    candidateArtifacts: [
      { entrypoint: 'machine-daemon', hash: hash('b'), path: '/candidate/machine', dependsOn: [] },
      { entrypoint: 'frontend', hash: hash('c'), path: '/candidate/web', dependsOn: ['machine-daemon'] },
    ],
    currentHashes: { 'machine-daemon': hash('a'), frontend: hash('a') },
    authority: { kind: 'sandbox', environmentId: 'sandbox-b' },
    createdAt: '2026-08-27T00:00:00.000Z',
  });
  if (result.status === 'error') throw result.error;
  return result.value;
}

class RecordingDriver implements ReplacementDriver {
  constructor(
    readonly entrypoint: EntrypointId,
    private readonly calls: string[],
    private readonly fail?: { phase: ReplacementPhase; message: string },
  ) {}

  drain(context: ReplacementContext) { return this.run('drain', context); }
  stage(context: ReplacementContext) { return this.run('stage', context); }
  activate(context: ReplacementContext) { return this.run('activate', context); }
  health(context: ReplacementContext) { return this.run('health', context); }
  commit(context: ReplacementContext) { return this.run('commit', context); }
  rollback(context: ReplacementContext) { return this.run('rollback', context); }

  private async run(
    phase: ReplacementPhase,
    _context: ReplacementContext,
  ): Promise<ResultType<void, ReplacementActionError>> {
    this.calls.push(`${this.entrypoint}:${phase}`);
    return this.fail?.phase === phase
      ? Result.err(new ReplacementActionError({ entrypoint: this.entrypoint, phase, message: this.fail.message }))
      : Result.ok(undefined);
  }
}

function journalPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-deployment-engine-'));
  roots.push(root);
  return join(root, 'gitspace.db');
}

describe('DeploymentEngine', () => {
  it('drains every affected entrypoint before staging and commits after health', async () => {
    const plan = await sandboxPlan();
    const calls: string[] = [];
    const journal = new DeploymentJournal(journalPath());
    const engine = new DeploymentEngine(journal, [
      new RecordingDriver('machine-daemon', calls),
      new RecordingDriver('frontend', calls),
    ]);

    const result = await engine.execute(plan);
    expect(result.status).toBe('ok');
    expect(calls).toEqual([
      'machine-daemon:drain', 'frontend:drain',
      'machine-daemon:stage', 'frontend:stage',
      'machine-daemon:activate', 'frontend:activate',
      'machine-daemon:health', 'frontend:health',
      'machine-daemon:commit', 'frontend:commit',
    ]);
    expect(journal.load(plan.id)?.state).toBe('committed');
    expect(journal.steps(plan.id).map((step) => step.state)).toEqual(['committed', 'committed']);
    journal.close();
  });

  it('rolls back staged generations in reverse order after failed health', async () => {
    const plan = await sandboxPlan();
    const calls: string[] = [];
    const journal = new DeploymentJournal(journalPath());
    const engine = new DeploymentEngine(journal, [
      new RecordingDriver('machine-daemon', calls),
      new RecordingDriver('frontend', calls, { phase: 'health', message: 'frontend unhealthy' }),
    ]);

    const result = await engine.execute(plan);
    expect(result.status).toBe('error');
    expect(calls.slice(-2)).toEqual(['frontend:rollback', 'machine-daemon:rollback']);
    expect(journal.load(plan.id)?.state).toBe('rolled-back');
    expect(journal.steps(plan.id).map((step) => step.state)).toEqual(['rolled-back', 'rolled-back']);
    journal.close();
  });

  it('recovers an interrupted attempt by rolling it back before a fresh attempt', async () => {
    const plan = await sandboxPlan();
    const calls: string[] = [];
    const path = journalPath();
    const firstJournal = new DeploymentJournal(path);
    firstJournal.begin(plan);
    firstJournal.recordStep(plan.id, 'machine-daemon', 0, 'staged');
    firstJournal.recordStep(plan.id, 'frontend', 1, 'drained');
    firstJournal.transition(plan.id, 'activating');
    firstJournal.close();

    const recoveredJournal = new DeploymentJournal(path);
    const engine = new DeploymentEngine(recoveredJournal, [
      new RecordingDriver('machine-daemon', calls),
      new RecordingDriver('frontend', calls),
    ]);
    const result = await engine.execute(plan);
    expect(result.status).toBe('ok');
    expect(calls[0]).toBe('machine-daemon:rollback');
    expect(recoveredJournal.load(plan.id)?.attempt).toBe(2);
    expect(recoveredJournal.load(plan.id)?.state).toBe('committed');
    recoveredJournal.close();
  });
});
