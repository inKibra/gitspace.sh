import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import {
  createDeploymentPlan,
  DeploymentEngine,
  DeploymentJournal,
  ReplacementActionError,
  MachineReplacementDriver,
  hashArtifactPath,
  type DeploymentPlan,
  type EntrypointId,
  type MachineGenerationPointer,
  type ReplacementContext,
  type ReplacementDriver,
  type ReplacementPhase,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;

async function sandboxPlan(
  machine = { hash: hash('b') as string, path: '/candidate/machine' },
  currentMachineHash: string | null = hash('a'),
): Promise<DeploymentPlan> {
  const result = await createDeploymentPlan({
    source: { projectId: 'gitspace', revision: 'abc123', dirty: true },
    target: { environmentId: 'sandbox-b', kind: 'sandbox', expectedGeneration: 'gen-a' },
    candidateArtifacts: [
      { entrypoint: 'machine-daemon', ...machine, dependsOn: [] },
      { entrypoint: 'frontend', hash: hash('c'), path: '/candidate/web', dependsOn: ['machine-daemon'] },
    ],
    currentHashes: { ...(currentMachineHash ? { 'machine-daemon': currentMachineHash } : {}), frontend: hash('a') },
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
  finalize(context: ReplacementContext) { return this.run('finalize', context); }
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

interface MachineObservation {
  pointerHash: string;
  database: string;
  checkpoint: boolean;
  accepting: boolean;
  running: string[];
}

async function machineTransaction(sameArtifact = false) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-machine-transaction-'));
  roots.push(root);
  const artifactPath = join(root, 'machine.bundle');
  const databasePath = join(root, 'application.db');
  const checkpointPath = join(root, 'checkpoint.db');
  const pointerPath = join(root, 'machine', 'current.json');
  const previous: MachineGenerationPointer = {
    hash: hash('a'), artifactPath: '/old/machine', socketPath: '/old/machine.sock',
  };
  mkdirSync(join(root, 'machine'), { recursive: true });
  writeFileSync(artifactPath, 'successor executable');
  const artifactHash = await hashArtifactPath(artifactPath);
  if (sameArtifact) {
    previous.hash = artifactHash;
    previous.artifactPath = join(root, 'machine', 'generations', artifactHash.slice('sha256:'.length), 'machine.bundle');
    previous.socketPath = join(root, 'machine', 'sockets', `machine-${artifactHash.slice('sha256:'.length)}.sock`);
    mkdirSync(join(root, 'machine', 'generations', artifactHash.slice('sha256:'.length)), { recursive: true });
    writeFileSync(previous.artifactPath, readFileSync(artifactPath));
  }
  writeFileSync(databasePath, 'original database');
  writeFileSync(pointerPath, JSON.stringify(previous));
  const state = {
    active: previous,
    running: new Map([[previous.socketPath, previous]]),
    accepting: true,
    resumeFailures: 0,
    restores: 0,
  };
  const machine = new MachineReplacementDriver(root, {
    stopAdmissions: async () => { state.accepting = false; },
    drainRpc: async () => {},
    drainWorkers: async () => { state.running.delete(state.active.socketPath); },
    currentGeneration: async () => state.active,
    checkpointDatabase: async () => {
      writeFileSync(checkpointPath, readFileSync(databasePath));
      return checkpointPath;
    },
    migrateDatabase: async () => { writeFileSync(databasePath, 'successor database'); },
    restoreDatabase: async (checkpoint) => {
      writeFileSync(databasePath, readFileSync(checkpoint));
      state.restores += 1;
    },
    releaseDatabaseCheckpoint: async (checkpoint) => { rmSync(checkpoint, { force: true }); },
    startSuccessor: async (next) => { state.running.set(next.socketPath, next); },
    probeSuccessor: async (next) => {
      if (!state.running.has(next.socketPath)) throw new Error('Successor is not running');
    },
    switchActiveSocket: async (next) => {
      state.running.set(next.socketPath, next);
      state.active = next;
    },
    stopGeneration: async (generation) => { state.running.delete(generation.socketPath); },
    resumeAdmissions: async () => {
      if (state.resumeFailures > 0) {
        state.resumeFailures -= 1;
        throw new Error('Admissions unavailable');
      }
      state.accepting = true;
    },
  });
  // Channel/custom identity changes can force replacement without changing artifact bytes.
  const plan = await sandboxPlan({ hash: artifactHash, path: artifactPath }, sameArtifact ? null : previous.hash);
  const rollbackPath = join(root, 'machine', `rollback-${plan.id}-1.json`);
  return {
    root, plan, machine, state, previous, artifactPath, checkpointPath, rollbackPath,
    observe: (): MachineObservation => ({
      pointerHash: (JSON.parse(readFileSync(pointerPath, 'utf8')) as MachineGenerationPointer).hash,
      database: readFileSync(databasePath, 'utf8'),
      checkpoint: existsSync(checkpointPath),
      accepting: state.accepting,
      running: [...state.running.values()].map((generation) => generation.hash),
    }),
  };
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
      'machine-daemon:finalize', 'frontend:finalize',
    ]);
    expect(journal.load(plan.id)?.state).toBe('committed');
    expect(journal.steps(plan.id).map((step) => step.state)).toEqual(['finalized', 'finalized']);
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

  it('restores the original machine when a later target throws during commit', async () => {
    const fixture = await machineTransaction();
    const journal = new DeploymentJournal(join(fixture.root, 'deployment.db'));
    const frontend = new RecordingDriver('frontend', []);
    let duringCommit: MachineObservation | undefined;
    frontend.commit = async () => {
      duringCommit = fixture.observe();
      throw new Error('Frontend commit failed');
    };
    const result = await new DeploymentEngine(journal, [fixture.machine, frontend]).execute(fixture.plan);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.phase).toBe('commit');
    expect(duringCommit).toEqual({
      pointerHash: fixture.plan.artifacts[0]!.hash,
      database: 'successor database',
      checkpoint: true,
      accepting: false,
      running: [fixture.plan.artifacts[0]!.hash],
    });
    const restored = {
      pointerHash: fixture.previous.hash,
      database: 'original database',
      checkpoint: false,
      accepting: true,
      running: [fixture.previous.hash],
    };
    expect(fixture.observe()).toEqual(restored);
    expect(journal.load(fixture.plan.id)?.state).toBe('rolled-back');
    expect(existsSync(fixture.rollbackPath)).toBe(false);

    // A duplicate rollback must not erase the restored pointer or require the candidate source.
    rmSync(fixture.artifactPath);
    expect((await fixture.machine.rollback({
      plan: fixture.plan, artifact: fixture.plan.artifacts[0]!, ordinal: 0, attempt: 1,
    })).status).toBe('ok');
    expect(fixture.observe()).toEqual(restored);
    journal.close();
  });

  it('discards machine rollback resources only after every target commits', async () => {
    const fixture = await machineTransaction();
    const journal = new DeploymentJournal(join(fixture.root, 'deployment.db'));
    const frontend = new RecordingDriver('frontend', []);
    let duringCommit: MachineObservation | undefined;
    frontend.commit = async () => {
      duringCommit = fixture.observe();
      return Result.ok(undefined);
    };
    expect((await new DeploymentEngine(journal, [fixture.machine, frontend]).execute(fixture.plan)).status).toBe('ok');
    expect(duringCommit?.checkpoint).toBe(true);
    expect(duringCommit?.accepting).toBe(false);
    expect(fixture.observe()).toEqual({
      pointerHash: fixture.plan.artifacts[0]!.hash,
      database: 'successor database',
      checkpoint: false,
      accepting: true,
      running: [fixture.plan.artifacts[0]!.hash],
    });
    expect(existsSync(fixture.rollbackPath)).toBe(false);
    expect(journal.load(fixture.plan.id)?.state).toBe('committed');
    journal.close();
  });

  it('resumes finalization without rolling back an already committed plan', async () => {
    const fixture = await machineTransaction();
    fixture.state.resumeFailures = 1;
    const path = join(fixture.root, 'deployment.db');
    const journal = new DeploymentJournal(path);
    const frontendCalls: string[] = [];
    const frontend = new RecordingDriver('frontend', frontendCalls);
    const result = await new DeploymentEngine(journal, [fixture.machine, frontend]).execute(fixture.plan);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.phase).toBe('finalize');
    expect(journal.load(fixture.plan.id)?.state).toBe('finalizing');
    expect(existsSync(fixture.checkpointPath)).toBe(false);
    expect(existsSync(fixture.rollbackPath)).toBe(true);
    journal.close();

    frontendCalls.length = 0;
    const recoveredJournal = new DeploymentJournal(path);
    expect((await new DeploymentEngine(recoveredJournal, [fixture.machine, frontend]).execute(fixture.plan)).status).toBe('ok');
    expect(frontendCalls).toEqual(['frontend:finalize']);
    expect(fixture.observe()).toEqual({
      pointerHash: fixture.plan.artifacts[0]!.hash,
      database: 'successor database',
      checkpoint: false,
      accepting: true,
      running: [fixture.plan.artifacts[0]!.hash],
    });
    expect(existsSync(fixture.rollbackPath)).toBe(false);
    expect(fixture.state.restores).toBe(0);
    expect(recoveredJournal.load(fixture.plan.id)?.attempt).toBe(1);
    recoveredJournal.close();
  });

  it('finishes failed rollback cleanup before starting a new deployment attempt', async () => {
    const fixture = await machineTransaction();
    fixture.state.resumeFailures = 2;
    const journal = new DeploymentJournal(join(fixture.root, 'deployment.db'));
    const frontend = new RecordingDriver('frontend', []);
    let failCommit = true;
    frontend.commit = async () => {
      if (failCommit) {
        failCommit = false;
        throw new Error('Frontend commit failed');
      }
      return Result.ok(undefined);
    };
    const engine = new DeploymentEngine(journal, [fixture.machine, frontend]);
    expect((await engine.execute(fixture.plan)).status).toBe('error');
    expect(journal.load(fixture.plan.id)?.state).toBe('failed');
    expect(fixture.state.restores).toBe(1);
    expect(existsSync(fixture.checkpointPath)).toBe(false);
    expect(existsSync(fixture.rollbackPath)).toBe(true);

    const retry = await engine.execute(fixture.plan);
    expect(retry.status).toBe('error');
    if (retry.status === 'error') expect(retry.error.phase).toBe('rollback');
    expect(journal.load(fixture.plan.id)?.attempt).toBe(1);
    expect(fixture.state.restores).toBe(1);
    expect((await engine.execute(fixture.plan)).status).toBe('ok');
    expect(journal.load(fixture.plan.id)?.attempt).toBe(2);
    expect(fixture.state.restores).toBe(1);
    expect(existsSync(fixture.rollbackPath)).toBe(false);
    expect(fixture.observe()).toEqual({
      pointerHash: fixture.plan.artifacts[0]!.hash,
      database: 'successor database',
      checkpoint: false,
      accepting: true,
      running: [fixture.plan.artifacts[0]!.hash],
    });
    journal.close();
  });

  it('keeps the replacement instance running when its artifact matches the retired machine', async () => {
    const fixture = await machineTransaction(true);
    const journal = new DeploymentJournal(join(fixture.root, 'deployment.db'));
    const engine = new DeploymentEngine(journal, [fixture.machine, new RecordingDriver('frontend', [])]);
    expect((await engine.execute(fixture.plan)).status).toBe('ok');
    expect(fixture.state.active.hash).toBe(fixture.previous.hash);
    expect(fixture.state.active.socketPath).not.toBe(fixture.previous.socketPath);
    expect([...fixture.state.running.keys()]).toEqual([fixture.state.active.socketPath]);
    expect(fixture.state.accepting).toBe(true);
    expect(existsSync(fixture.checkpointPath)).toBe(false);
    expect(existsSync(fixture.rollbackPath)).toBe(false);
    journal.close();
  });

  it('restores the previous instance after an equal-artifact replacement fails later in the plan', async () => {
    const fixture = await machineTransaction(true);
    const journal = new DeploymentJournal(join(fixture.root, 'deployment.db'));
    const frontend = new RecordingDriver('frontend', [], { phase: 'commit', message: 'Frontend commit failed' });
    expect((await new DeploymentEngine(journal, [fixture.machine, frontend]).execute(fixture.plan)).status).toBe('error');
    expect(journal.load(fixture.plan.id)?.state).toBe('rolled-back');
    expect(fixture.state.active).toEqual(fixture.previous);
    expect([...fixture.state.running.keys()]).toEqual([fixture.previous.socketPath]);
    expect(fixture.observe()).toEqual({
      pointerHash: fixture.previous.hash,
      database: 'original database',
      checkpoint: false,
      accepting: true,
      running: [fixture.previous.hash],
    });
    expect(existsSync(fixture.rollbackPath)).toBe(false);
    journal.close();
  });
});
