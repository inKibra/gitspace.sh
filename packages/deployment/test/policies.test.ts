import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(calls).not.toContain('release-checkpoint');
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
