import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from 'better-result';
import {
  createDeploymentPlan,
  DeploymentEngine,
  DeploymentJournal,
  FrontendReplacementDriver,
  MachineReplacementDriver,
  OmpBrokerReplacementDriver,
  OmpWorkerReplacementDriver,
  hashArtifactPath,
  type DeploymentPlan,
  type EntrypointId,
  type MachineGenerationPointer,
  type OmpGenerationPointer,
  type ReplacementDriver,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `gitspace-${label}-`));
  roots.push(root);
  return root;
}

async function oneArtifactPlan(input: {
  entrypoint: EntrypointId;
  artifactPath: string;
  currentHash?: string;
  revision: string;
}): Promise<DeploymentPlan> {
  const hash = await hashArtifactPath(input.artifactPath);
  const result = await createDeploymentPlan({
    source: { projectId: 'gitspace', revision: input.revision, dirty: true },
    target: { environmentId: 'sandbox-b', kind: 'sandbox', expectedGeneration: 'gen-a' },
    candidateArtifacts: [{ entrypoint: input.entrypoint, hash, path: input.artifactPath, dependsOn: [] }],
    currentHashes: input.currentHash ? { [input.entrypoint]: input.currentHash } : {},
    authority: { kind: 'sandbox', environmentId: 'sandbox-b' },
    createdAt: `2026-08-27T00:00:0${input.revision}.000Z`,
  });
  if (result.status === 'error') throw result.error;
  return result.value;
}

async function combinedPolicyTransaction() {
  const environment = tempRoot('combined-policies');
  const frontendSource = join(environment, 'web');
  const workerSource = join(environment, 'worker.bundle');
  const brokerSource = join(environment, 'broker.bundle');
  const previousHash = `sha256:${'a'.repeat(64)}`;
  mkdirSync(frontendSource);
  mkdirSync(join(environment, 'frontend'));
  writeFileSync(join(frontendSource, 'index.html'), '<h1>successor</h1>');
  writeFileSync(workerSource, 'worker successor');
  writeFileSync(brokerSource, 'broker successor');
  writeFileSync(join(environment, 'frontend', 'current.json'), JSON.stringify({
    hash: previousHash, generationPath: '/old/frontend',
  }));
  const previousWorker: OmpGenerationPointer = { hash: previousHash, artifactPath: '/old/worker' };
  const previousBroker: OmpGenerationPointer = { hash: previousHash, artifactPath: '/old/broker' };
  const state = {
    frontend: previousHash,
    worker: previousWorker as OmpGenerationPointer | null,
    broker: previousBroker as OmpGenerationPointer | null,
    workerAccepting: true,
    brokerAccepting: true,
    sessionsOpen: true,
    failCommit: false,
    reopenFailures: 0,
    workerRunning: new Set([previousHash]),
    brokerRunning: new Set([previousHash]),
  };
  const frontend = new FrontendReplacementDriver(environment, {
    checkpointClients: async () => {},
    publishGeneration: async (hash) => { state.frontend = hash; },
    probeGeneration: async (_path, hash) => {
      if (state.frontend !== hash) throw new Error('Frontend is not serving the candidate');
    },
  });
  const worker = new OmpWorkerReplacementDriver(environment, {
    stopAdmissions: async () => { state.workerAccepting = false; },
    pauseAgentTree: async () => { state.sessionsOpen = false; },
    awaitAgentTreeSettled: async () => {},
    persistSessions: async () => {},
    currentWorkerGeneration: async () => state.worker,
    startProbe: async (next) => { state.workerRunning.add(next.hash); },
    probeWorker: async (next) => {
      if (!state.workerRunning.has(next.hash)) throw new Error('Worker probe is not running');
    },
    activateWorkerGeneration: async (next) => {
      state.workerRunning.clear();
      state.workerRunning.add(next.hash);
      state.worker = next;
    },
    restoreWorkerGeneration: async (previous) => {
      state.workerRunning.clear();
      if (previous) state.workerRunning.add(previous.hash);
      state.worker = previous;
    },
    reopenDrainedSessions: async () => {
      if (state.reopenFailures > 0) {
        state.reopenFailures -= 1;
        throw new Error('Sessions cannot reopen yet');
      }
      state.sessionsOpen = true;
    },
    stopProbe: async (next) => { state.workerRunning.delete(next.hash); },
    resumeAdmissions: async () => { state.workerAccepting = true; },
  });
  const broker = new OmpBrokerReplacementDriver(environment, {
    stopAdmissions: async () => { state.brokerAccepting = false; },
    listInteractivePtys: async () => [],
    persistMetadata: async () => {},
    currentBrokerGeneration: async () => state.broker,
    stopBroker: async (generation) => { if (generation) state.brokerRunning.delete(generation.hash); },
    startBroker: async (next) => { state.brokerRunning.add(next.hash); },
    reAdoptDetached: async () => {},
    probeBroker: async (next) => {
      if (!state.brokerRunning.has(next.hash)) throw new Error('Broker is not running');
    },
    activateBrokerGeneration: async (next) => { state.broker = next; },
    restoreBrokerGeneration: async (previous) => {
      if (previous) state.brokerRunning.add(previous.hash);
      state.broker = previous;
    },
    resumeAdmissions: async () => { state.brokerAccepting = true; },
  });
  const result = await createDeploymentPlan({
    source: { projectId: 'gitspace', revision: 'combined-policies', dirty: true },
    target: { environmentId: 'sandbox-b', kind: 'sandbox', expectedGeneration: 'gen-a' },
    candidateArtifacts: [
      { entrypoint: 'frontend', hash: await hashArtifactPath(frontendSource), path: frontendSource, dependsOn: [] },
      { entrypoint: 'omp-worker', hash: await hashArtifactPath(workerSource), path: workerSource, dependsOn: ['frontend'] },
      { entrypoint: 'omp-broker', hash: await hashArtifactPath(brokerSource), path: brokerSource, dependsOn: ['omp-worker'] },
      { entrypoint: 'offload-worker', hash: `sha256:${'b'.repeat(64)}`, path: '/offload', dependsOn: ['omp-broker'] },
    ],
    currentHashes: { frontend: previousHash, 'omp-worker': previousHash, 'omp-broker': previousHash },
    authority: { kind: 'sandbox', environmentId: 'sandbox-b' },
  });
  if (result.status === 'error') throw result.error;
  const plan = result.value;
  const rollbackPaths = [
    join(environment, 'frontend', `rollback-${plan.id}-1.json`),
    join(environment, 'omp', 'omp-worker', `rollback-${plan.id}-1.json`),
    join(environment, 'omp', 'omp-broker', `rollback-${plan.id}-1.json`),
  ];
  const observations: Array<{ retained: boolean[]; workerAccepting: boolean; brokerAccepting: boolean; sessionsOpen: boolean }> = [];
  const lastTarget: ReplacementDriver = {
    entrypoint: 'offload-worker',
    drain: async () => Result.ok(undefined),
    stage: async () => Result.ok(undefined),
    activate: async () => Result.ok(undefined),
    health: async () => Result.ok(undefined),
    commit: async () => {
      observations.push({
        retained: rollbackPaths.map((path) => existsSync(path)),
        workerAccepting: state.workerAccepting,
        brokerAccepting: state.brokerAccepting,
        sessionsOpen: state.sessionsOpen,
      });
      if (state.failCommit) throw new Error('Last target commit failed');
      return Result.ok(undefined);
    },
    rollback: async () => Result.ok(undefined),
  };
  const journal = new DeploymentJournal(join(environment, 'deployment.db'));
  const drivers = [frontend, worker, broker, lastTarget];
  return {
    environment, previousHash, plan, state, rollbackPaths, observations, journal, drivers,
    sources: [frontendSource, workerSource, brokerSource],
    engine: new DeploymentEngine(journal, drivers),
  };
}

describe('frontend replacement', () => {
  it('atomically switches generations and restores the prior pointer on failed health', async () => {
    const environment = tempRoot('frontend-policy');
    const sourceV1 = join(environment, 'source-v1');
    const sourceV2 = join(environment, 'source-v2');
    mkdirSync(sourceV1, { recursive: true });
    mkdirSync(sourceV2, { recursive: true });
    writeFileSync(join(sourceV1, 'index.html'), '<h1>v1</h1>');
    writeFileSync(join(sourceV2, 'index.html'), '<h1>v2</h1>');
    const calls: string[] = [];
    let rejectedHash: string | undefined;
    const host = {
      checkpointClients: async (hash: string) => { calls.push(`checkpoint:${hash}`); },
      publishGeneration: async (hash: string) => { calls.push(`publish:${hash}`); },
      probeGeneration: async (_path: string, hash: string) => {
        calls.push(`probe:${hash}`);
        if (hash === rejectedHash) throw new Error('bad frontend');
      },
    };
    const journal = new DeploymentJournal(join(environment, 'gitspace.db'));
    const engine = new DeploymentEngine(journal, [new FrontendReplacementDriver(environment, host)]);

    const v1 = await oneArtifactPlan({ entrypoint: 'frontend', artifactPath: sourceV1, revision: '1' });
    expect((await engine.execute(v1)).status).toBe('ok');
    const currentPath = join(environment, 'frontend', 'current.json');
    const currentV1 = JSON.parse(readFileSync(currentPath, 'utf8')) as { hash: string };
    expect(currentV1.hash).toBe(v1.artifacts[0]!.hash);

    const v2 = await oneArtifactPlan({
      entrypoint: 'frontend',
      artifactPath: sourceV2,
      currentHash: currentV1.hash,
      revision: '2',
    });
    rejectedHash = v2.artifacts[0]!.hash;
    expect((await engine.execute(v2)).status).toBe('error');
    const restored = JSON.parse(readFileSync(currentPath, 'utf8')) as { hash: string };
    expect(restored.hash).toBe(currentV1.hash);
    expect(calls).toContain(`publish:${currentV1.hash}`);
    journal.close();
  });
});

describe('machine replacement', () => {
  it('drains admissions/RPC/workers before successor health and socket handoff', async () => {
    const environment = tempRoot('machine-policy');
    const artifact = join(environment, 'machine.bundle');
    writeFileSync(artifact, 'machine-v2');
    const calls: string[] = [];
    const previous: MachineGenerationPointer = {
      hash: `sha256:${'a'.repeat(64)}`,
      artifactPath: '/old/machine',
      socketPath: '/old/machine.sock',
    };
    const host = {
      stopAdmissions: async () => { calls.push('stop-admissions'); },
      drainRpc: async () => { calls.push('drain-rpc'); },
      drainWorkers: async () => { calls.push('drain-workers'); },
      currentGeneration: async () => previous,
      checkpointDatabase: async () => { calls.push('checkpoint-db'); return 'checkpoint-1'; },
      migrateDatabase: async () => { calls.push('migrate-db'); },
      restoreDatabase: async () => { calls.push('restore-db'); },
      releaseDatabaseCheckpoint: async () => { calls.push('release-checkpoint'); },
      startSuccessor: async () => { calls.push('start-successor'); },
      probeSuccessor: async () => { calls.push('probe-successor'); },
      switchActiveSocket: async () => { calls.push('switch-socket'); },
      stopGeneration: async (generation: MachineGenerationPointer) => { calls.push(`stop:${generation.hash}`); },
      resumeAdmissions: async () => { calls.push('resume-admissions'); },
    };
    const plan = await oneArtifactPlan({ entrypoint: 'machine-daemon', artifactPath: artifact, currentHash: previous.hash, revision: '3' });
    const journal = new DeploymentJournal(join(environment, 'gitspace.db'));
    const engine = new DeploymentEngine(journal, [new MachineReplacementDriver(environment, host)]);
    expect((await engine.execute(plan)).status).toBe('ok');
    expect(calls).toEqual([
      'stop-admissions', 'drain-rpc', 'drain-workers',
      'checkpoint-db', 'migrate-db', 'start-successor', 'probe-successor',
      'switch-socket', `stop:${previous.hash}`, 'release-checkpoint',
      'resume-admissions',
    ]);
    journal.close();
  });

  it('restores the database checkpoint when successor health fails', async () => {
    const environment = tempRoot('machine-db-rollback');
    const artifact = join(environment, 'machine.bundle');
    writeFileSync(artifact, 'machine-bad');
    const calls: string[] = [];
    const previous: MachineGenerationPointer = {
      hash: `sha256:${'d'.repeat(64)}`,
      artifactPath: '/old/machine',
      socketPath: '/old/machine.sock',
    };
    const host = {
      stopAdmissions: async () => { calls.push('stop-admissions'); },
      drainRpc: async () => { calls.push('drain-rpc'); },
      drainWorkers: async () => { calls.push('drain-workers'); },
      currentGeneration: async () => previous,
      checkpointDatabase: async () => { calls.push('checkpoint-db'); return 'checkpoint-bad'; },
      migrateDatabase: async () => { calls.push('migrate-db'); },
      restoreDatabase: async (checkpoint: string) => { calls.push(`restore-db:${checkpoint}`); },
      releaseDatabaseCheckpoint: async () => { calls.push('release-checkpoint'); },
      startSuccessor: async () => { calls.push('start-successor'); },
      probeSuccessor: async () => { calls.push('probe-successor'); throw new Error('probe failed'); },
      switchActiveSocket: async () => { calls.push('switch-socket'); },
      stopGeneration: async () => { calls.push('stop-generation'); },
      resumeAdmissions: async () => { calls.push('resume-admissions'); },
    };
    const plan = await oneArtifactPlan({ entrypoint: 'machine-daemon', artifactPath: artifact, currentHash: previous.hash, revision: '6' });
    const journal = new DeploymentJournal(join(environment, 'gitspace.db'));
    const engine = new DeploymentEngine(journal, [new MachineReplacementDriver(environment, host)]);
    expect((await engine.execute(plan)).status).toBe('error');
    expect(calls).toContain('restore-db:checkpoint-bad');
    expect(calls.at(-1)).toBe('resume-admissions');
    journal.close();
  });
});

describe('OMP replacement', () => {
  it('drains the complete agent tree before activating a probed worker generation', async () => {
    const environment = tempRoot('omp-worker-policy');
    const artifact = join(environment, 'worker.bundle');
    writeFileSync(artifact, 'omp-worker-v2');
    const calls: string[] = [];
    const previous: OmpGenerationPointer = { hash: `sha256:${'a'.repeat(64)}`, artifactPath: '/old/worker' };
    const host = {
      stopAdmissions: async () => { calls.push('stop-admissions'); },
      pauseAgentTree: async () => { calls.push('pause-tree'); },
      awaitAgentTreeSettled: async () => { calls.push('settle-tree'); },
      persistSessions: async () => { calls.push('persist-sessions'); },
      currentWorkerGeneration: async () => previous,
      startProbe: async () => { calls.push('start-probe'); },
      probeWorker: async () => { calls.push('probe-worker'); },
      activateWorkerGeneration: async () => { calls.push('activate-worker'); },
      restoreWorkerGeneration: async () => { calls.push('restore-worker'); },
      reopenDrainedSessions: async () => { calls.push('reopen-sessions'); },
      stopProbe: async () => { calls.push('stop-probe'); },
      resumeAdmissions: async () => { calls.push('resume-admissions'); },
    };
    const plan = await oneArtifactPlan({ entrypoint: 'omp-worker', artifactPath: artifact, currentHash: previous.hash, revision: '4' });
    const journal = new DeploymentJournal(join(environment, 'gitspace.db'));
    const engine = new DeploymentEngine(journal, [new OmpWorkerReplacementDriver(environment, host)]);
    expect((await engine.execute(plan)).status).toBe('ok');
    expect(calls).toEqual([
      'stop-admissions', 'pause-tree', 'settle-tree', 'persist-sessions',
      'start-probe', 'probe-worker', 'activate-worker', 'reopen-sessions', 'resume-admissions',
    ]);
    journal.close();
  });

  it('refuses broker replacement while interactive PTYs lack external holders', async () => {
    const environment = tempRoot('omp-broker-policy');
    const artifact = join(environment, 'broker.bundle');
    writeFileSync(artifact, 'omp-broker-v2');
    const calls: string[] = [];
    const previous: OmpGenerationPointer = { hash: `sha256:${'a'.repeat(64)}`, artifactPath: '/old/broker' };
    const host = {
      stopAdmissions: async () => { calls.push('stop-admissions'); },
      listInteractivePtys: async () => ['pty-1'],
      persistMetadata: async () => { calls.push('persist-metadata'); },
      currentBrokerGeneration: async () => previous,
      stopBroker: async () => { calls.push('stop-broker'); },
      startBroker: async () => { calls.push('start-broker'); },
      reAdoptDetached: async () => { calls.push('readopt'); },
      probeBroker: async () => { calls.push('probe-broker'); },
      activateBrokerGeneration: async () => { calls.push('activate-broker'); },
      restoreBrokerGeneration: async () => { calls.push('restore-broker'); },
      resumeAdmissions: async () => { calls.push('resume-admissions'); },
    };
    const plan = await oneArtifactPlan({ entrypoint: 'omp-broker', artifactPath: artifact, currentHash: previous.hash, revision: '5' });
    const journal = new DeploymentJournal(join(environment, 'gitspace.db'));
    const engine = new DeploymentEngine(journal, [new OmpBrokerReplacementDriver(environment, host)]);
    const result = await engine.execute(plan);
    expect(result.status).toBe('error');
    expect(calls).toEqual(['stop-admissions']);
    expect(journal.load(plan.id)?.state).toBe('rolled-back');
    journal.close();
  });
});

describe('combined policy transactions', () => {
  it('restores frontend, worker and broker after a later target commit fails', async () => {
    const fixture = await combinedPolicyTransaction();
    fixture.state.failCommit = true;
    const result = await fixture.engine.execute(fixture.plan);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.phase).toBe('commit');
    expect(fixture.observations).toEqual([{
      retained: [true, true, true], workerAccepting: false, brokerAccepting: false, sessionsOpen: false,
    }]);
    expect(fixture.journal.load(fixture.plan.id)?.state).toBe('rolled-back');
    expect(fixture.state.frontend).toBe(fixture.previousHash);
    expect(fixture.state.worker?.hash).toBe(fixture.previousHash);
    expect(fixture.state.broker?.hash).toBe(fixture.previousHash);
    expect([...fixture.state.workerRunning]).toEqual([fixture.previousHash]);
    expect([...fixture.state.brokerRunning]).toEqual([fixture.previousHash]);
    expect(fixture.state.sessionsOpen).toBe(true);
    expect(fixture.state.workerAccepting).toBe(true);
    expect(fixture.state.brokerAccepting).toBe(true);
    expect(fixture.rollbackPaths.map((path) => existsSync(path))).toEqual([false, false, false]);
    const pointerPath = join(fixture.environment, 'frontend', 'current.json');
    expect(JSON.parse(readFileSync(pointerPath, 'utf8')).hash).toBe(fixture.previousHash);

    for (const source of fixture.sources) rmSync(source, { recursive: true });
    for (const [ordinal, artifact] of fixture.plan.artifacts.entries()) {
      const driver = fixture.drivers.find((candidate) => candidate.entrypoint === artifact.entrypoint)!;
      expect((await driver.rollback({ plan: fixture.plan, artifact, ordinal, attempt: 1 })).status).toBe('ok');
    }
    expect(fixture.state.worker?.hash).toBe(fixture.previousHash);
    expect(fixture.state.broker?.hash).toBe(fixture.previousHash);
    expect(JSON.parse(readFileSync(pointerPath, 'utf8')).hash).toBe(fixture.previousHash);
    fixture.journal.close();
  });

  it('reopens sessions and removes rollback records only after the whole plan commits', async () => {
    const fixture = await combinedPolicyTransaction();
    expect((await fixture.engine.execute(fixture.plan)).status).toBe('ok');
    expect(fixture.observations).toEqual([{
      retained: [true, true, true], workerAccepting: false, brokerAccepting: false, sessionsOpen: false,
    }]);
    expect(fixture.state.frontend).toBe(fixture.plan.artifacts[0]!.hash);
    expect(fixture.state.worker?.hash).toBe(fixture.plan.artifacts[1]!.hash);
    expect(fixture.state.broker?.hash).toBe(fixture.plan.artifacts[2]!.hash);
    expect([...fixture.state.workerRunning]).toEqual([fixture.plan.artifacts[1]!.hash]);
    expect([...fixture.state.brokerRunning]).toEqual([fixture.plan.artifacts[2]!.hash]);
    expect(fixture.state.sessionsOpen).toBe(true);
    expect(fixture.state.workerAccepting).toBe(true);
    expect(fixture.state.brokerAccepting).toBe(true);
    expect(fixture.rollbackPaths.map((path) => existsSync(path))).toEqual([false, false, false]);
    fixture.journal.close();
  });

  it('retries OMP finalization without undoing an already finalized frontend', async () => {
    const fixture = await combinedPolicyTransaction();
    fixture.state.reopenFailures = 1;
    const result = await fixture.engine.execute(fixture.plan);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.phase).toBe('finalize');
    expect(fixture.journal.load(fixture.plan.id)?.state).toBe('finalizing');
    expect(fixture.rollbackPaths.map((path) => existsSync(path))).toEqual([false, true, true]);

    expect((await fixture.engine.execute(fixture.plan)).status).toBe('ok');
    expect(fixture.journal.load(fixture.plan.id)?.attempt).toBe(1);
    expect(fixture.state.frontend).toBe(fixture.plan.artifacts[0]!.hash);
    expect(fixture.state.worker?.hash).toBe(fixture.plan.artifacts[1]!.hash);
    expect(fixture.state.broker?.hash).toBe(fixture.plan.artifacts[2]!.hash);
    expect(fixture.state.sessionsOpen).toBe(true);
    expect(fixture.state.workerAccepting).toBe(true);
    expect(fixture.state.brokerAccepting).toBe(true);
    expect(fixture.rollbackPaths.map((path) => existsSync(path))).toEqual([false, false, false]);
    fixture.journal.close();
  });
});
