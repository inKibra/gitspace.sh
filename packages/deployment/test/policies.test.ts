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
  hashArtifactPath,
  type DeploymentPlan,
  type EntrypointId,
  type MachineGenerationPointer,
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
    expect(calls.at(-1)).toBe('resume-admissions');
    journal.close();
  });
});

