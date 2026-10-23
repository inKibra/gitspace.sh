import { lfsBytes, readLfs } from './git-lfs-fixture.js';
import { env } from 'cloudflare:test';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { describe, expect, it } from 'vitest';
import { AccountGitLfsStore, gitLfsObjectKey } from '../src/git-lfs-store.js';
import { TenantObjectIntegrityError, TenantStore, tenantObjectKey } from '../src/tenant-store.js';
import { ssecBucket } from './tenant-store-fixture.js';

async function objectFor(bytes: Uint8Array) {
  const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
  return GitLfsObjectSchema.parse({ oid, size: bytes.byteLength });
}

async function fixture() {
  const projectId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'LFS retention', repositoryReference: 'https://origin.invalid/repo.git', baseBranch: 'main', createdBy: 'user' });
  const bucket = ssecBucket(env.DATA);
  const scopeKey = crypto.getRandomValues(new Uint8Array(32));
  const tenant = new TenantStore(bucket, env.ACCOUNT_ID, async () => scopeKey);
  const publicationId = crypto.randomUUID();
  const store = new AccountGitLfsStore(tenant, projectId, object => authority.lfsPin({ publicationId, objects: [object] }));
  return { projectId, bucket, tenant, store };
}

describe('account LFS objects in the tenant store', () => {
  it('stores one object per oid, deduplicates it, and verifies plaintext identity on every read', async () => {
    const { store, tenant, projectId, bucket } = await fixture();
    const bytes = new TextEncoder().encode('private binary payload\u0000with bytes');
    const object = await objectFor(bytes);
    await store.put(object, lfsBytes(bytes));
    const key = tenantObjectKey(env.ACCOUNT_ID, gitLfsObjectKey(projectId, object.oid));
    const first = await env.DATA.head(key);
    expect(first?.customMetadata).toEqual({ scope: `lfs:${projectId}`, sha256: `sha256:${object.oid}`, size: String(bytes.byteLength) });
    expect(await readLfs(store, object)).toEqual(bytes);
    expect(await store.has(object)).toBe(true);
    await store.put(object, lfsBytes(bytes));
    expect((await env.DATA.head(key))!.etag).toBe(first!.etag);
    await expect(store.put({ ...object, size: object.size + 1 }, lfsBytes(bytes))).rejects.toThrow();
    const other = await objectFor(new Uint8Array(bytes.length).fill(1));
    await expect(store.put(other, lfsBytes(new Uint8Array(bytes.length)))).rejects.toThrow(TenantObjectIntegrityError);
    expect(await store.has(other)).toBe(false);
    await expect(readLfs(store, { ...object, size: object.size + 1 })).rejects.toThrow('oid/size');
    expect(await new AccountGitLfsStore(tenant, crypto.randomUUID(), async () => {}).get(object)).toBeNull();
    // Another scope's key does not open the object.
    const foreign = new AccountGitLfsStore(new TenantStore(bucket, env.ACCOUNT_ID, async () => new Uint8Array(32)), projectId, async () => {});
    await expect(foreign.get(object)).rejects.toThrow('SSE-C');
  });
});
