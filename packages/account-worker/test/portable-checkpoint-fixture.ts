import { env } from 'cloudflare:test';
import { credentialProtocolBase64, encryptArtifactBytes } from '@gitspace/protocol';
import { spaceCheckpointManifestKey, spaceGitCheckpointRef, type GitLfsSnapshot, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';

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
  const key = credentialProtocolBase64.decode(await vault.artifactKey(env.ACCOUNT_ID));
  const sealed = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify(manifest)), key);
  const manifestHash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(sealed))), byte => byte.toString(16).padStart(2, '0')).join('')}` as const;
  const manifestKey = spaceCheckpointManifestKey(projectId, spaceId, revision);
  await env.DATA.put(`users/${env.ACCOUNT_ID}/${manifestKey}`, sealed, { customMetadata: { sha256: manifestHash } });
  return { manifestKey, manifestHash };
}
