import { lfsBytes, readLfs } from './git-lfs-fixture.js';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64 } from '@gitspace/protocol';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { describe, expect, it } from 'vitest';
import { AccountGitLfsStore } from '../src/git-lfs-store.js';
import { tenantStore } from '../src/tenant-store.js';

async function fixture() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  const signingPrivateKey = new Uint8Array(32).fill(53);
  for (const machineId of ['writer', 'other-writer', 'storage-only']) await vault.registerManagedDevice({ userId, machineId, signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(9))), capabilities: machineId === 'storage-only' ? ['storage.access'] : ['space.control', 'storage.access'] });
  const projectId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'LFS control', repositoryReference: 'https://origin.invalid/repo.git', baseBranch: 'main', createdBy: 'writer' });
  const request = (machineId: string, operation: 'lfs.pin' | 'lfs.release', payload: Record<string, unknown>) => SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createSignedControlRequest({ userId, machineId, operation, payload, signingPrivateKey })) });
  return { userId, signingPrivateKey, projectId, authority, request };
}

describe('authenticated LFS publication controls', () => {
  it('requires project authority and space-control capability, and isolates publisher release identities', async () => {
    const { userId, projectId, authority, request } = await fixture();
    const bytes = new TextEncoder().encode('publisher scoped payload');
    const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const object = GitLfsObjectSchema.parse({ oid, size: bytes.length });
    const pin = { projectId, publicationId: 'capture', objects: [object] };
    expect((await request('storage-only', 'lfs.pin', pin)).ok).toBe(false);
    expect((await request('writer', 'lfs.pin', { ...pin, projectId: 'missing-project' })).ok).toBe(false);
    expect((await request('writer', 'lfs.pin', pin)).ok).toBe(true);
    const store = new AccountGitLfsStore(tenantStore(env), projectId, object => authority.lfsPin({ publicationId: 'writer:capture', objects: [object] }));
    await store.put(object, lfsBytes(bytes));
    expect((await request('other-writer', 'lfs.release', { projectId, publicationId: 'capture' })).ok).toBe(true);
    expect(await readLfs(store, object)).toEqual(bytes);
    expect((await request('writer', 'lfs.release', { projectId, publicationId: 'capture' })).ok).toBe(true);
  });

  it('rejects uploads without a prior durable publication pin or under another digest, and cross-project reads', async () => {
    const { userId, signingPrivateKey, projectId } = await fixture();
    const oid = 'a'.repeat(64);
    const key = `lfs/projects/${projectId}/objects/${oid}`;
    const upload = (hash: string) => {
      const put = createSignedControlRequest({ userId, machineId: 'writer', operation: 'data.put', payload: { key, hash, size: 1 }, signingPrivateKey });
      return SELF.fetch(`https://auth.test/v1/data/${key}`, { method: 'PUT', headers: { 'x-gitspace-control': btoa(JSON.stringify(put)), 'content-length': '1' }, body: new Uint8Array([1]) });
    };
    const unpinned = await upload(`sha256:${oid}`);
    expect(unpinned.status).toBe(409);
    expect(await unpinned.json()).toMatchObject({ error: { code: 'LFS_PUBLICATION_REQUIRED' } });
    expect(await (await upload(`sha256:${'b'.repeat(64)}`)).json()).toMatchObject({ error: { code: 'INVALID_OBJECT_METADATA' } });
    const missingKey = `lfs/projects/missing-project/objects/${oid}`;
    const get = createSignedControlRequest({ userId, machineId: 'writer', operation: 'data.get', payload: { key: missingKey }, signingPrivateKey });
    expect((await SELF.fetch(`https://auth.test/v1/data/${missingKey}`, { headers: { 'x-gitspace-control': btoa(JSON.stringify(get)) } })).status).toBe(403);
  });
});
