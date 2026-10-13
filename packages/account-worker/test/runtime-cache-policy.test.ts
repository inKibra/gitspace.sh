import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { ArtifactsCodeStore, ArtifactsSnapshotError } from '@gitspace/runtime-workspace-do';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { Result } from 'better-result';
import { afterEach, expect, it, vi } from 'vitest';
import { tenantRootPrivateKey } from './setup.js';

afterEach(() => vi.restoreAllMocks());

async function cacheFixture() {
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
  const { attachment } = await authority.runtimeCacheAttachmentRequest({ projectId, workspaceId, machineId, requestId: 'attach-cache' });
  return { userId, projectId, workspaceId, machineId, authority, attachment };
}

it('delivers a changed account cache setting to an existing workspace cache assignment', async () => {
  const { userId, projectId, workspaceId, machineId, authority } = await cacheFixture();
  const policies = async () => (await authority.runtimeAssignments({ projectId, workspaceId, machineId })).assignments.map(assignment => assignment.cachePolicy);
  expect(await policies()).toEqual([{ idleGraceSeconds: 900, reclaimSeconds: 86400 }]);

  const settings = env.USER_SETTINGS.getByName(userId);
  const current = await settings.get('browser');
  expect(await settings.update('browser', { expectedRevision: current.revision, onboardingComplete: current.onboardingComplete, profile: current.profile, git: current.git, defaults: current.defaults, machines: { cacheReclaimSeconds: 3600 } })).toMatchObject({ status: 'ok' });
  expect(await policies()).toEqual([{ idleGraceSeconds: 900, reclaimSeconds: 3600 }]);
});

it('lists an existing cache while a failed publication stays fenced against readiness', async () => {
  const { projectId, workspaceId, machineId, authority, attachment } = await cacheFixture();
  const checkpoint = RuntimeGitCheckpointSchema.parse({
    checkpointRef: 'refs/gitspace/spaces/cache-policy-workspace/native/1', branch: 'main',
    headCommit: '1'.repeat(40), indexCommit: '1'.repeat(40), trackedWorktreeCommit: '1'.repeat(40),
    worktreeCommit: '1'.repeat(40), indexTree: '2'.repeat(40), worktreeTree: '2'.repeat(40),
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockResolvedValue({
    hash: checkpoint.worktreeCommit, treeHash: checkpoint.worktreeTree, parents: [], message: 'Initial cache',
    author: { name: 'Fixture', email: 'fixture@example.invalid' }, committer: { name: 'Fixture', email: 'fixture@example.invalid' }, authoredAt: 0, committedAt: 0,
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'mergeSnapshot').mockResolvedValue(Result.err(new ArtifactsSnapshotError({
    operation: 'writeSnapshot', certainty: 'not-published', message: 'Snapshot provider unavailable',
  })));
  await runInDurableObject(authority, async instance => {
    await expect(instance.runtimeSnapshotCommit({ projectId, workspaceId, attachmentId: attachment.attachmentId, generation: attachment.generation, checkpoint, previousWorktreeCommit: null })).rejects.toThrow('Snapshot provider unavailable');
  });
  const assignments = await authority.runtimeAssignments({ projectId, workspaceId, machineId });
  expect(assignments.assignments.map(item => item.grant.attachment.attachmentId)).toEqual([attachment.attachmentId]);
  await runInDurableObject(authority, async instance => {
    await expect(instance.runtimeAttachmentReady({ projectId, workspaceId, machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, commit: checkpoint.worktreeCommit, prerequisitesComplete: true, capabilities: attachment.capabilities })).rejects.toThrow('Snapshot provider unavailable');
  });
});
