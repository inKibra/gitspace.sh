import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq } from 'drizzle-orm';
import {
  ArtifactConflict,
  ArtifactStorageError,
  GitSpaceDatabase,
  LocalArtifactResolver,
  artifactScopes,
} from '@gitspace/core';
import { signedControlRequestSchema, verifySignedControlRequest } from '@gitspace/protocol';
import { CloudArtifactObjectStore } from '../src/cloud-artifact-object-store.js';
import { CloudDataCheckpointBlobStore } from '../src/cloud-space-authority.js';

const roots: string[] = [];
const databases: GitSpaceDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const capability = { kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' } as const;
const artifactUrl = 'local://workspace/private.txt';
const encryptionKey = new Uint8Array(32).fill(19);
const signingKey = new Uint8Array(32).fill(5);
const publicSigningKey = ed25519.getPublicKey(signingKey);

class CloudObjects {
  readonly objects = new Map<string, Uint8Array>();
  putsUntilFailure: number | null = null;

  readonly fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const encoded = new Headers(init?.headers).get('x-gitspace-control')!;
    const signed = signedControlRequestSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
    if (!verifySignedControlRequest(signed, publicSigningKey)) return new Response(null, { status: 401 });
    const key = new URL(String(input)).pathname.slice('/v1/data/'.length).split('/').map(decodeURIComponent).join('/');
    if (signed.payload.key !== key) return new Response(null, { status: 403 });
    const accountKey = `${signed.userId}/${key}`;
    if (init?.method === 'PUT') {
      if (signed.operation !== 'data.put') return new Response(null, { status: 403 });
      if (this.putsUntilFailure !== null) {
        if (this.putsUntilFailure === 0) return new Response(null, { status: 503 });
        this.putsUntilFailure -= 1;
      }
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const hash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
      if (signed.payload.hash !== hash || signed.payload.size !== bytes.byteLength) return new Response(null, { status: 400 });
      this.objects.set(accountKey, bytes);
      return new Response(null, { status: 201 });
    }
    if (signed.operation !== 'data.get') return new Response(null, { status: 403 });
    const bytes = this.objects.get(accountKey);
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  }) as typeof fetch;

  store(accountId = 'account-a', machineId = 'machine-a'): CloudArtifactObjectStore {
    return new CloudArtifactObjectStore(accountId, new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: accountId, machineId, signingPrivateKey: signingKey, fetcher: this.fetcher,
    }));
  }

  corrupt(hash: string): void {
    const entry = [...this.objects].find(([key]) => key.endsWith(hash.slice('sha256:'.length)));
    if (!entry) throw new Error(`No uploaded object for ${hash}`);
    entry[1][entry[1].length - 1] ^= 1;
  }
}

interface ArtifactFixture {
  root: string;
  database: GitSpaceDatabase;
  resolver: LocalArtifactResolver;
}

function fixture(cloud: CloudObjects, accountId = 'account-a', machineId = 'machine-a'): ArtifactFixture {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-cloud-artifacts-'));
  roots.push(root);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  databases.push(database);
  database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' }).unwrap();
  database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'A', branch: 'a', rootPath: '/repo/a/workspaces/a' }).unwrap();
  const resolver = new LocalArtifactResolver(database, cloud.store(accountId, machineId), join(root, 'cache'), encryptionKey);
  return { root, database, resolver };
}

function replaceDisk(original: ArtifactFixture): void {
  databases.splice(databases.indexOf(original.database), 1);
  original.database.close();
  rmSync(original.root, { recursive: true, force: true });
}

describe('cloud artifact object storage', () => {
  it('recovers acknowledged encrypted objects and their canonical manifest on an empty replacement disk', async () => {
    const cloud = new CloudObjects();
    const original = fixture(cloud);
    const contents = new TextEncoder().encode('private durable account artifact');
    const written = (await original.resolver.write(capability, artifactUrl, contents, 'text/plain')).unwrap();
    const canonical = (await original.resolver.commit(capability, 'local://workspace/')).unwrap();
    const ciphertext = await cloud.store().get(written.hash as `sha256:${string}`);
    expect(ciphertext).not.toBeNull();
    expect(new TextDecoder().decode(ciphertext!)).not.toContain('private durable account artifact');
    replaceDisk(original);

    const replacement = fixture(cloud, 'account-a', 'replacement-machine');
    expect((await replacement.resolver.read(capability, artifactUrl)).status).toBe('error');
    const restored = (await replacement.resolver.restoreScope(canonical)).unwrap();
    expect(restored.generation).toBe(canonical.generation);
    expect(restored.manifestHash).toBe(canonical.manifestHash);
    expect((await replacement.resolver.read(capability, artifactUrl)).unwrap()).toEqual(contents);
    expect(replacement.resolver.list(capability, 'local://workspace/').unwrap()).toEqual([written]);

    const otherAccount = fixture(cloud, 'account-b', 'other-machine');
    expect(await cloud.store('account-b').get(written.hash as `sha256:${string}`)).toBeNull();
    expect((await otherAccount.resolver.restoreScope(canonical)).status).toBe('error');
    expect((await otherAccount.resolver.read(capability, artifactUrl)).status).toBe('error');
  });

  it.each(['missing', 'corrupt'] as const)('rejects a checkpoint with %s remote ciphertext even while local cached reads succeed', async (failure) => {
    const cloud = new CloudObjects();
    const original = fixture(cloud);
    const contents = new TextEncoder().encode('cached but not durable');
    const written = (await original.resolver.write(capability, artifactUrl, contents)).unwrap();
    const canonical = (await original.resolver.commit(capability, 'local://workspace/')).unwrap();
    expect((await original.resolver.verifyScope(canonical)).status).toBe('ok');
    if (failure === 'missing') {
      const key = [...cloud.objects.keys()].find((key) => key.endsWith(written.hash.slice('sha256:'.length)))!;
      cloud.objects.delete(key);
    } else {
      cloud.corrupt(written.hash);
    }
    expect((await original.resolver.read(capability, artifactUrl)).unwrap()).toEqual(contents);
    const verified = await original.resolver.verifyScope(canonical);
    expect(verified.status).toBe('error');
    if (verified.status === 'error') expect(verified.error).toBeInstanceOf(ArtifactStorageError);
    expect((await original.resolver.read(capability, artifactUrl)).unwrap()).toEqual(contents);
  });

  it('accepts a pristine empty checkpoint but rejects a committed generation without its manifest', async () => {
    const original = fixture(new CloudObjects());
    const empty = original.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, 'workspace-a')).get()!;
    expect((await original.resolver.verifyScope(empty)).status).toBe('ok');
    expect((await original.resolver.verifyScope({ ...empty, generation: 1 })).status).toBe('error');
  });

  it('rejects ciphertext corruption before exposing restored bytes', async () => {
    const cloud = new CloudObjects();
    const original = fixture(cloud);
    const written = (await original.resolver.write(capability, artifactUrl, new TextEncoder().encode('intact'))).unwrap();
    const canonical = (await original.resolver.commit(capability, 'local://workspace/')).unwrap();
    replaceDisk(original);
    const replacement = fixture(cloud);
    (await replacement.resolver.restoreScope(canonical)).unwrap();
    cloud.corrupt(written.hash);
    const read = await replacement.resolver.read(capability, artifactUrl);
    expect(read.status).toBe('error');
    if (read.status === 'error') expect(read.error).toBeInstanceOf(ArtifactStorageError);
  });

  it('rejects corrupt manifests and generation mismatches without publishing restored state', async () => {
    const cloud = new CloudObjects();
    const original = fixture(cloud);
    (await original.resolver.write(capability, artifactUrl, new TextEncoder().encode('intact'))).unwrap();
    const canonical = (await original.resolver.commit(capability, 'local://workspace/')).unwrap();
    replaceDisk(original);
    const replacement = fixture(cloud);
    expect((await replacement.resolver.restoreScope({ ...canonical, generation: canonical.generation + 1 })).status).toBe('error');
    expect(replacement.resolver.list(capability, 'local://workspace/').unwrap()).toEqual([]);
    cloud.corrupt(canonical.manifestHash!);
    expect((await replacement.resolver.restoreScope(canonical)).status).toBe('error');
    expect(replacement.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, 'workspace-a')).get()).toMatchObject({
      generation: 0, manifestHash: null, dirty: false,
    });
  });

  it.each([
    { boundary: 'ciphertext', uploads: 0 },
    { boundary: 'manifest', uploads: 1 },
  ])('does not publish a successful generation when $boundary persistence fails', async ({ uploads }) => {
    const cloud = new CloudObjects();
    const original = fixture(cloud);
    const previousBytes = new TextEncoder().encode('previous acknowledged contents');
    (await original.resolver.write(capability, artifactUrl, previousBytes)).unwrap();
    const canonical = (await original.resolver.commit(capability, 'local://workspace/')).unwrap();
    const nextBytes = new TextEncoder().encode('not yet acknowledged');
    (await original.resolver.write(capability, artifactUrl, nextBytes)).unwrap();
    cloud.putsUntilFailure = uploads;
    const failed = await original.resolver.commit(capability, 'local://workspace/');
    expect(failed.status).toBe('error');
    if (failed.status === 'error') expect(failed.error).toBeInstanceOf(ArtifactStorageError);
    expect(original.database.orm.select().from(artifactScopes).where(eq(artifactScopes.id, canonical.id)).get()).toMatchObject({
      generation: canonical.generation, manifestHash: canonical.manifestHash, dirty: true,
    });
    const replacement = fixture(cloud);
    (await replacement.resolver.restoreScope(canonical)).unwrap();
    expect((await replacement.resolver.read(capability, artifactUrl)).unwrap()).toEqual(previousBytes);

    cloud.putsUntilFailure = null;
    const retried = (await original.resolver.commit(capability, 'local://workspace/')).unwrap();
    expect(retried.generation).toBe(canonical.generation + 1);
    (await replacement.resolver.restoreScope(retried)).unwrap();
    expect((await replacement.resolver.read(capability, artifactUrl)).unwrap()).toEqual(nextBytes);
    const stale = await replacement.resolver.restoreScope(canonical);
    expect(stale.status).toBe('error');
    if (stale.status === 'error') expect(stale.error).toBeInstanceOf(ArtifactConflict);
    expect((await replacement.resolver.read(capability, artifactUrl)).unwrap()).toEqual(nextBytes);
  });

  it('refuses a content-addressed upload with a different complete hash', async () => {
    const cloud = new CloudObjects();
    const bytes = new TextEncoder().encode('sealed contents');
    const hash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}` as const;
    const wrongHash = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}` as `sha256:${string}`;
    await expect(cloud.store().put(wrongHash, bytes)).rejects.toThrow('content verification');
    expect(await cloud.store().get(wrongHash)).toBeNull();
    await cloud.store().put(hash, bytes);
    expect(await cloud.store().get(hash)).toEqual(bytes);
  });
});
