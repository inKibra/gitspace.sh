import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeploymentPlan, verifyDeploymentPlan, type DeploymentArtifact } from '../src/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
const publicKey = Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64');
const source = { projectId: 'gitspace', revision: 'abc123', dirty: false };

function artifacts(): DeploymentArtifact[] {
  return [
    { entrypoint: 'omp-worker', hash: hash('b'), path: '/artifacts/worker', dependsOn: [] },
    { entrypoint: 'frontend', hash: hash('c'), path: '/artifacts/web', dependsOn: ['omp-worker'] },
  ];
}

describe('deployment plans', () => {
  it('expands changed dependencies and orders them before dependents', async () => {
    const result = await createDeploymentPlan({
      source,
      target: { environmentId: 'sandbox-b', kind: 'sandbox', expectedGeneration: 'gen-a' },
      candidateArtifacts: artifacts(),
      currentHashes: { 'omp-worker': hash('a'), frontend: hash('c') },
      authority: { kind: 'sandbox', environmentId: 'sandbox-b' },
      createdAt: '2026-08-27T00:00:00.000Z',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'error') throw result.error;
    expect(result.value.artifacts.map((artifact) => artifact.entrypoint)).toEqual(['omp-worker', 'frontend']);
    expect((await verifyDeploymentPlan(result.value)).status).toBe('ok');
  });

  it('requires a signed promotion for the current environment and detects tampering', async () => {
    const result = await createDeploymentPlan({
      source,
      target: { environmentId: 'current-a', kind: 'current', expectedGeneration: 'gen-a' },
      candidateArtifacts: artifacts(),
      currentHashes: { 'omp-worker': hash('a'), frontend: hash('a') },
      authority: { kind: 'promotion', rootPublicKey: publicKey, signingPrivateKey: privateKey },
      createdAt: '2026-08-27T00:00:00.000Z',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'error') throw result.error;
    expect(result.value.authority.kind).toBe('promotion');
    expect((await verifyDeploymentPlan(result.value)).status).toBe('ok');
    expect((await verifyDeploymentPlan({
      ...result.value,
      source: { ...result.value.source, revision: 'tampered' },
    })).status).toBe('error');
  });

  it('rejects sandbox authority aimed at another environment', async () => {
    const result = await createDeploymentPlan({
      source,
      target: { environmentId: 'sandbox-b', kind: 'sandbox', expectedGeneration: 'gen-a' },
      candidateArtifacts: artifacts(),
      currentHashes: {},
      authority: { kind: 'sandbox', environmentId: 'sandbox-c' },
    });
    expect(result.status).toBe('error');
  });
});
