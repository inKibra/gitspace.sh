import { env } from 'cloudflare:test';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { spaceCheckpointManifestKey, spaceGitCheckpointRef, type GitLfsSnapshot, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import { tenantStore } from '../src/tenant-store.js';

export async function persistPortableCheckpoint(projectId: string, spaceId: string, revision: number, lfs?: GitLfsSnapshot) {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(41)) });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  if (!await authority.getProject()) await authority.bootstrap({ id: projectId, name: 'Portable fixture', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  const manifest: SpaceCheckpointManifest = {
    version: 1, projectId, spaceId, revision, previousRevision: null,
    repository: { checkpointRef: spaceGitCheckpointRef(spaceId, revision), headCommit: 'a'.repeat(40), indexCommit: 'a'.repeat(40), worktreeCommit: 'a'.repeat(40), branch: 'main', ...(lfs ? { lfs } : {}) },
    agent: { kind: 'cloud', sessionId: 'session-a', conversationId: 'conversation-a', cursor: 0, resumePending: false },
    artifacts: { manifestHash: `sha256:${'a'.repeat(64)}`, generation: 0 },
    createdAt: new Date().toISOString(),
  };
  const manifestKey = spaceCheckpointManifestKey(projectId, spaceId, revision);
  const stored = await tenantStore(env).put(manifestKey, `space:${spaceId}`, new TextEncoder().encode(JSON.stringify(manifest)));
  if (!stored) throw new Error('The checkpoint manifest was not stored');
  return { manifestKey, manifestHash: stored.sha256 };
}
