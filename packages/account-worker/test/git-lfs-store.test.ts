import { lfsBytes, readLfs } from './git-lfs-fixture.js';
import { env } from 'cloudflare:test';
import { deriveArtifactScopeKey } from '@gitspace/protocol';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { describe, expect, it } from 'vitest';
import { AccountGitLfsStore, gitLfsObjectKey } from '../src/git-lfs-store.js';

async function objectFor(bytes: Uint8Array) {
  const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
  return GitLfsObjectSchema.parse({ oid, size: bytes.byteLength });
}

async function fixture() {
  const projectId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'LFS retention', repositoryReference: 'https://origin.invalid/repo.git', baseBranch: 'main', createdBy: 'user' });
  const key = await deriveArtifactScopeKey(new Uint8Array(32).fill(31), `lfs:${projectId}`);
  const publicationId = crypto.randomUUID();
  const store = new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, projectId, key, object => authority.lfsPin({ publicationId, objects: [object] }));
  return { projectId, authority, key, publicationId, store };
}

describe('account encrypted LFS ownership', () => {
  it('roundtrips real ciphertext, deduplicates an oid, and verifies plaintext identity and scope', async () => {
    const { store, projectId, key, authority, publicationId } = await fixture();
    const bytes = new TextEncoder().encode('private binary payload\u0000with bytes');
    const object = await objectFor(bytes);
    await store.put(object, lfsBytes(bytes));
    const path = `users/${env.ACCOUNT_ID}/${gitLfsObjectKey(projectId, object.oid)}`;
    const first = await env.DATA.get(path);
    expect(new Uint8Array(await first!.arrayBuffer())).not.toEqual(bytes);
    expect(await readLfs(store, object)).toEqual(bytes);
    await store.put(object, lfsBytes(bytes));
    expect((await env.DATA.head(path))!.etag).toBe(first!.etag);
    await expect(store.put({ ...object, size: object.size + 1 }, lfsBytes(bytes))).rejects.toThrow();
    await expect(store.put(object, lfsBytes(new Uint8Array(bytes.length)))).rejects.toThrow('oid/size');
    await expect(readLfs(store, { ...object, size: object.size + 1 })).rejects.toThrow('oid/size');
    const noPin = async () => {};
    expect(await new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, crypto.randomUUID(), key, noPin).get(object)).toBeNull();
    expect(await new AccountGitLfsStore(env.DATA, 'another-account', projectId, key, noPin).get(object)).toBeNull();
    await expect(new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, projectId, new Uint8Array(32), noPin).get(object)).rejects.toThrow();
  });

});
