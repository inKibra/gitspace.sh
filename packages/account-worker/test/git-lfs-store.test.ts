import { env, runInDurableObject } from 'cloudflare:test';
import { deriveArtifactScopeKey } from '@gitspace/protocol';
import { CHECKPOINT_CHUNK_BYTES, GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { describe, expect, it, vi } from 'vitest';
import { AccountGitLfsStore, gitLfsObjectKey } from '../src/git-lfs-store.js';
import { GitLfsRetention } from '../src/git-lfs-retention.js';
import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';
import { ProjectAuthorityDO } from '../src/project-authority.js';

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
    await store.put(object, bytes);
    const path = `users/${env.ACCOUNT_ID}/${gitLfsObjectKey(projectId, object.oid)}`;
    const first = await env.DATA.get(path);
    expect(new Uint8Array(await first!.arrayBuffer())).not.toEqual(bytes);
    expect(await store.get(object)).toEqual(bytes);
    await store.put(object, bytes);
    expect((await env.DATA.head(path))!.etag).toBe(first!.etag);
    await expect(store.put({ ...object, size: object.size + 1 }, bytes)).rejects.toThrow('oid/size');
    await expect(store.put(object, new Uint8Array(bytes.length))).rejects.toThrow('oid/size');
    await expect(store.get({ ...object, size: object.size + 1 })).rejects.toThrow('oid/size');
    const noPin = async () => {};
    expect(await new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, crypto.randomUUID(), key, noPin).get(object)).toBeNull();
    expect(await new AccountGitLfsStore(env.DATA, 'another-account', projectId, key, noPin).get(object)).toBeNull();
    await expect(new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, projectId, new Uint8Array(32), noPin).get(object)).rejects.toThrow();
    await authority.lfsOriginConfirmed({ origin: 'https://origin.invalid/repo.git', endpoint: 'https://origin.invalid/repo.git/info/lfs', objects: [object] });
    await authority.lfsReleasePublication(publicationId);
    expect(await store.get(object)).toBeNull();
  });

  it('keeps unconfirmed objects when historical snapshot owners are released', async () => {
    const { store, authority, publicationId } = await fixture();
    const bytes = new TextEncoder().encode('same object in two retained snapshots');
    const object = await objectFor(bytes);
    await store.put(object, bytes);
    await authority.lfsRetain({ snapshotId: 'runtime:workspace:old-commit', workspaceId: 'workspace', kind: 'runtime', objects: [{ ...object, source: 'r2' }] });
    await authority.lfsRetain({ snapshotId: 'portable:workspace:1', workspaceId: 'workspace', kind: 'portable', objects: [{ ...object, source: 'r2' }] });
    await authority.lfsReleasePublication(publicationId);
    await authority.lfsPin({ publicationId: 'new-publication', objects: [object] });
    await authority.lfsReleasePublication('new-publication');
    expect(await store.get(object)).toEqual(bytes);
    // Publication release never shares the snapshot namespace, even with a forged name.
    await authority.lfsReleasePublication('snapshot:runtime:workspace:old-commit');
    expect(await store.get(object)).toEqual(bytes);
    const location = { origin: 'https://origin.invalid/repo.git', endpoint: 'https://origin.invalid/repo.git/info/lfs' };
    await authority.lfsOriginConfirmed({ ...location, objects: [object] });
    await authority.lfsCollect();
    expect(await store.get(object)).toBeNull();
    expect(await authority.lfsResolveSources([{ ...object, source: 'r2' }])).toEqual([{ ...object, source: 'origin', location }]);
    await runInDurableObject(authority, (_instance, state) => {
      const recovered = new GitLfsRetention(state.storage);
      expect(recovered.snapshots().every(snapshot => snapshot.objects.every(item => item.source === 'origin'))).toBe(true);
      expect(recovered.candidates()).toEqual([]);
    });
  });

  it('preserves interrupted publication pins while collecting abandoned unreferenced objects', async () => {
    const { store, authority, publicationId } = await fixture();
    const bytes = new TextEncoder().encode('upload finished, snapshot commit interrupted');
    const object = await objectFor(bytes);
    await store.put(object, bytes);
    await authority.lfsReleasePublication('unrelated-failed-publication');
    expect(await store.get(object)).toEqual(bytes);
    await authority.lfsOriginConfirmed({ origin: 'https://origin.invalid/repo.git', endpoint: 'https://origin.invalid/repo.git/info/lfs', objects: [object] });
    await authority.lfsReleasePublication(publicationId);

    expect(await store.get(object)).toBeNull();
  });
  it('retains the portable manifest inventory before releasing the actual capture publication', async () => {
    const { store, authority, projectId, publicationId } = await fixture();
    const bytes = new TextEncoder().encode('portable only object');
    const object = await objectFor(bytes);
    await store.put(object, bytes);
    const identity = { projectId, spaceId: crypto.randomUUID(), machineId: 'portable-machine' };
    const placement = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.spaceId}`);
    await placement.bootstrap(identity);
    await placement.beginClose({ ...identity, expectedGeneration: 1 });
    const manifest = await persistPortableCheckpoint(projectId, identity.spaceId, 1, { objects: [{ ...object, source: 'r2' }], heldBack: [] });
    expect(await placement.commitClosed({ ...identity, expectedGeneration: 1, revision: 1, ...manifest })).toEqual({ status: 'ok', value: undefined });
    await authority.lfsReleasePublication(publicationId);
    expect(await store.get(object)).toEqual(bytes);
  });

  it('fences interrupted collection until deletion is retried, before admitting another publisher', async () => {
    const { store, authority, publicationId } = await fixture();
    const bytes = new TextEncoder().encode('interrupted delete');
    const object = await objectFor(bytes);
    await store.put(object, bytes);
    await runInDurableObject(authority, (_instance, state) => {
      const ledger = new GitLfsRetention(state.storage);
      ledger.release(`publication:${publicationId}`);
      ledger.beginDelete(object);
    });
    await runInDurableObject(authority, instance => {
      expect(() => instance.lfsPin({ publicationId: 'racing-publisher', objects: [object] })).toThrow('deletion');
    });
    await authority.lfsOriginConfirmed({ origin: 'https://origin.invalid/repo.git', endpoint: 'https://origin.invalid/repo.git/info/lfs', objects: [object] });
    await authority.lfsReleasePublication(publicationId);
    expect(await store.get(object)).toBeNull();
    await authority.lfsPin({ publicationId: 'racing-publisher', objects: [object] });
  });

  it('roundtrips chunked ciphertext and collects the inventory and every chunk only after lease release', async () => {
    const { store, authority, publicationId, projectId } = await fixture();
    const bytes = new Uint8Array(CHECKPOINT_CHUNK_BYTES + 17).fill(39);
    const object = await objectFor(bytes);
    await store.put(object, bytes);
    const restored = await store.get(object);
    if (!restored) throw new Error('Chunked LFS object is missing');
    expect(await objectFor(restored)).toEqual(object);
    const path = `users/${env.ACCOUNT_ID}/${gitLfsObjectKey(projectId, object.oid)}`;
    const chunks = await env.DATA.list({ prefix: `${path}.chunks/` });
    expect(chunks.objects).toHaveLength(2);
    const first = chunks.objects[0]!;
    await env.DATA.put(first.key, new Uint8Array(first.size));
    await expect(store.get(object)).rejects.toThrow('integrity');
    await authority.lfsOriginConfirmed({ origin: 'https://origin.invalid/repo.git', endpoint: 'https://origin.invalid/repo.git/info/lfs', objects: [object] });
    await authority.lfsReleasePublication(publicationId);
    expect(await env.DATA.head(path)).toBeNull();
    expect((await env.DATA.list({ prefix: `${path}.chunks/` })).objects).toEqual([]);
  });

  it('keeps canonical branch and tag objects but collects archived-only objects without an origin', async () => {
    const projectId = crypto.randomUUID();
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await authority.bootstrap({ id: projectId, name: 'No origin', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
    const key = await deriveArtifactScopeKey(new Uint8Array(32).fill(31), `lfs:${projectId}`);
    const store = new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, projectId, key, object => authority.lfsPin({ publicationId: 'upload', objects: [object] }));
    const branchBytes = new TextEncoder().encode('branch payload');
    const tagBytes = new TextEncoder().encode('tag payload');
    const archivedBytes = new TextEncoder().encode('archived private checkpoint payload');
    const branch = await objectFor(branchBytes), tag = await objectFor(tagBytes), archived = await objectFor(archivedBytes);
    for (const [object, bytes] of [[branch, branchBytes], [tag, tagBytes], [archived, archivedBytes]] as const) await store.put(object, bytes);
    await authority.lfsRetain({ snapshotId: 'runtime:archived:old', workspaceId: 'archived', kind: 'runtime', objects: [branch, tag, archived].map(object => ({ ...object, source: 'r2' })) });
    const branchCommit = '1'.repeat(40), tagCommit = '2'.repeat(40);
    const unsupported = async (): Promise<never> => { throw new Error('Unexpected canonical binding operation'); };
    const repo: ArtifactsRepo = {
      [Symbol.dispose]() {},
      info: async () => ({ id: 'canonical', name: 'canonical', remote: 'https://canonical.invalid/repo.git', description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false }),
      createToken: async () => ({ id: 'read', plaintext: 'token', scope: 'read', expiresAt: '' }), revokeToken: async () => true,
      readCommit: async hash => ({ hash, treeHash: hash, parents: [], message: '', author: { name: 'f', email: 'f@invalid' }, committer: { name: 'f', email: 'f@invalid' }, authoredAt: 0, committedAt: 0 }),
      readTree: async hash => [{ name: 'asset', hash, mode: '100644', type: 'blob' }],
      readBlob: async hash => { const object = hash === branchCommit ? branch : tag; return new Blob([`version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`]); },
      listTokens: unsupported, readFile: unsupported, fork: unsupported, log: unsupported,
    };
    const binding: Artifacts = { get: async () => repo, create: unsupported, delete: unsupported, import: unsupported, list: unsupported };
    const packet = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    const advertisement = packet('# service=git-upload-pack\n') + '0000' + packet(`${branchCommit} refs/heads/topic\0multi_ack\n`) + packet(`${tagCommit} refs/tags/release\n`) + '0000';
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(advertisement));
    try {
      await runInDurableObject(authority, async (_instance, state) => {
        const ledger = new GitLfsRetention(state.storage);
        ledger.release('publication:upload');
        await new ProjectAuthorityDO(state, { ...env, ARTIFACTS: binding }).lfsCollect();
      });
    } finally { request.mockRestore(); }
    expect(await store.get(branch)).toEqual(branchBytes);
    expect(await store.get(tag)).toEqual(tagBytes);
    expect(await store.get(archived)).toBeNull();
  });
});
