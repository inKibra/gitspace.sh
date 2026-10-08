import { env } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { afterEach, expect, it, vi } from 'vitest';
import { tenantRootPrivateKey } from './setup.js';

afterEach(() => vi.restoreAllMocks());

it('delivers a changed account cache setting to an existing workspace cache assignment', async () => {
  const userId = env.ACCOUNT_ID;
  const projectId = 'cache-policy-project';
  const workspaceId = 'cache-policy-workspace';
  const machineId = 'cache-machine';
  const repository = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.test/workspace.git' };
  // Only the external Artifacts service is replaced; the workspace has not published code yet.
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'initialCheckpoint').mockResolvedValue(null);
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId, generation: 1, capabilities: ['space.control'],
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(new Uint8Array(32).fill(41))),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(37))),
  }, tenantRootPrivateKey));
  await env.FLEET_CATALOG.getByName(userId).putMachine({ id: machineId, label: 'Cache machine', kind: 'physical', provider: 'physical', state: 'online', desiredState: 'online', rpcEndpoint: null, notes: '', lifecycleRevision: 1, operationId: null, error: null });
  const project = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: 'Cache policy', repositoryReference: null, baseBranch: 'main', createdBy: machineId });
  await project.setProjectLifecycle(created.revision, 'active');
  await project.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Cached', branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  await authority.runtimeCacheAttachmentRequest({ projectId, workspaceId, machineId, requestId: 'attach-cache' });
  const policies = async () => (await authority.runtimeAssignments({ projectId, workspaceId, machineId })).assignments.map(assignment => assignment.cachePolicy);
  expect(await policies()).toEqual([{ idleGraceSeconds: 900, reclaimSeconds: 86400 }]);

  const settings = env.USER_SETTINGS.getByName(userId);
  const current = await settings.get('browser');
  expect(await settings.update('browser', { expectedRevision: current.revision, onboardingComplete: current.onboardingComplete, profile: current.profile, git: current.git, defaults: current.defaults, machines: { cacheReclaimSeconds: 3600 } })).toMatchObject({ status: 'ok' });
  expect(await policies()).toEqual([{ idleGraceSeconds: 900, reclaimSeconds: 3600 }]);
});
