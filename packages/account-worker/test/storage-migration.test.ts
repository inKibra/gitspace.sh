import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createCipheriv, createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { artifactObjectKey, credentialProtocolBase64 } from '@gitspace/protocol';
import type { ArtifactManifest } from '@gitspace/protocol';
import type { StorageMigrationStatus } from '@gitspace/protocol/storage-migration';
import { describe, expect, it } from 'vitest';
import { legacyDriveName, legacyScopeKey } from '../src/storage-migration-envelope.js';
import { StorageMigrationDO } from '../src/storage-migration.js';
import { tenantStore } from '../src/tenant-store.js';
import { tenantRootPrivateKey } from './setup.js';

const CHUNK_BYTES = 32 * 1024 * 1024;
const userId = env.ACCOUNT_ID;
const prefix = `users/${userId}/`;
const projectId = 'project-a';
const workspaceId = 'workspace-a';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The retired envelope: `[1][nonce][AES-GCM ciphertext + tag]`. */
function seal(plaintext: Uint8Array, key: Uint8Array): Uint8Array<ArrayBuffer> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = cipher.update(plaintext);
  cipher.final();
  const sealed = new Uint8Array(29 + plaintext.byteLength);
  sealed[0] = 1;
  sealed.set(nonce, 1);
  sealed.set(body, 13);
  sealed.set(cipher.getAuthTag(), 13 + body.byteLength);
  return sealed;
}

/** A plaintext above one 32 MiB chunk, generated in place. */
function large(extra: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(CHUNK_BYTES + extra);
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) bytes[offset] = (offset / 4096 + fill) % 251;
  return bytes;
}

/** Writes a chunked old object: sealed 32 MiB chunks at `chunkKey(hash)` and a `[2][sealed inventory]` root. */
async function storeChunked(rootKey: string, plaintext: Uint8Array, key: Uint8Array, chunkKey: (hash: string) => string): Promise<string[]> {
  const chunks: Array<{ hash: string; size: number }> = [];
  const keys: string[] = [];
  for (let offset = 0; offset < plaintext.byteLength; offset += CHUNK_BYTES) {
    const sealed = seal(plaintext.subarray(offset, offset + CHUNK_BYTES), key);
    const hash = `sha256:${sha256(sealed)}`;
    keys.push(chunkKey(hash));
    await env.DATA.put(chunkKey(hash), sealed, { customMetadata: { sha256: hash } });
    chunks.push({ hash, size: Math.min(CHUNK_BYTES, plaintext.byteLength - offset) });
  }
  const inventory = seal(new TextEncoder().encode(JSON.stringify({ version: 1, size: plaintext.byteLength, chunks })), key);
  const root = new Uint8Array(1 + inventory.byteLength);
  root[0] = 2;
  root.set(inventory, 1);
  await env.DATA.put(rootKey, root, { customMetadata: { sha256: `sha256:${sha256(root)}` } });
  return keys;
}

/** A tenant as the old format left it: drive files with their manifest, an unreferenced drive file and one no known
 * scope opens, a chunked LFS object (plus a stray chunk), a small LFS object, a chunked checkpoint manifest, and a
 * name outside every namespace. */
async function legacyTenant(driveFiles = 1) {
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Migration', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const index = env.USER_PROJECTS.getByName(userId);
  await index.put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  const oldKey = await vault.legacyArtifactKey(userId);
  const storeDrive = async (plaintext: Uint8Array, scope: string) => {
    const sealed = seal(plaintext, await legacyScopeKey(oldKey, scope));
    const hash = `sha256:${sha256(sealed)}`;
    await env.DATA.put(`${prefix}${legacyDriveName(userId, hash)}`, sealed);
    return hash;
  };

  const driveScope = `space:${workspaceId}`;
  const files: Array<{ hash: string; bytes: Uint8Array }> = [];
  for (let index = 0; index < driveFiles; index++) {
    const bytes = new TextEncoder().encode(`drive file ${index}`);
    files.push({ hash: await storeDrive(bytes, driveScope), bytes });
  }
  const entries: ArtifactManifest['entries'] = files.map((file, index) => ({ path: `file-${index}.txt`, blobHash: file.hash, size: file.bytes.byteLength, mediaType: 'text/plain' }));
  const manifestHash = await storeDrive(new TextEncoder().encode(JSON.stringify({ version: 1, scopeId: driveScope, generation: 1, entries })), driveScope);
  await authority.putArtifactScope({ id: driveScope, workspaceId, generation: 1, expectedGeneration: 0, manifestHash });

  // An earlier version in the base drive: no manifest names it, but the base scope's key opens it.
  const unreferenced = { bytes: new TextEncoder().encode('an earlier base drive version'), hash: '' };
  unreferenced.hash = await storeDrive(unreferenced.bytes, `space:${projectId}`);
  // Sealed for a workspace no authority or storage path remembers.
  const orphanHash = await storeDrive(new TextEncoder().encode('from a forgotten workspace'), 'space:forgotten');

  const lfsBytes = large(17, 3);
  const lfsOid = sha256(lfsBytes);
  const lfsName = `lfs/projects/${projectId}/objects/${lfsOid}`;
  const lfsKey = await legacyScopeKey(oldKey, `lfs:${projectId}`);
  const lfsChunks = await storeChunked(`${prefix}${lfsName}`, lfsBytes, lfsKey, hash => `${prefix}${lfsName}.chunks/${hash.slice(7)}`);
  const strayChunk = `${prefix}${lfsName}.chunks/${'e'.repeat(64)}`;
  await env.DATA.put(strayChunk, seal(new Uint8Array(40), lfsKey));
  const smallLfs = new TextEncoder().encode('small lfs object');
  const smallLfsName = `lfs/projects/${projectId}/objects/${sha256(smallLfs)}`;
  const smallLfsSealed = seal(smallLfs, lfsKey);
  await env.DATA.put(`${prefix}${smallLfsName}`, smallLfsSealed, { customMetadata: { sha256: `sha256:${sha256(smallLfsSealed)}` } });

  // Checkpoint objects were sealed with the tenant key itself.
  const checkpointBytes = large(5, 9);
  const checkpointName = `projects/${projectId}/spaces/${workspaceId}/checkpoints/1/manifest.enc`;
  const checkpointChunks = await storeChunked(`${prefix}${checkpointName}`, checkpointBytes, oldKey, hash => `${prefix}${checkpointName}.chunks/${hash.slice(7)}`);

  const otherKey = `${prefix}releases/abc/worker.js`;
  await env.DATA.put(otherKey, 'plain release bytes');

  return {
    driveScope, files, manifestHash, unreferenced, orphanHash, lfsBytes, lfsOid, lfsName, lfsChunks, strayChunk, smallLfs, smallLfsName,
    checkpointBytes, checkpointName, checkpointChunks, otherKey,
    driveKey: (hash: string) => `${prefix}${legacyDriveName(userId, hash)}`,
  };
}

const migration = () => env.STORAGE_MIGRATION.getByName(userId);

/** Drives alarms until the job rests in `phase` (alarms may also fire on their own). */
async function settle(phase: StorageMigrationStatus['phase']): Promise<StorageMigrationStatus> {
  for (let step = 0; step < 500; step++) {
    const status = await migration().status();
    if (status.phase === phase && !status.running) return status;
    if (status.error) throw new Error(`Storage migration step failed: ${status.error}`);
    await runDurableObjectAlarm(migration());
  }
  throw new Error(`Storage migration did not reach ${phase}`);
}

async function oldObjects(): Promise<Map<string, string>> {
  const objects = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) objects.set(object.key, object.etag);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function plaintext(name: string, scope: string): Promise<{ bytes: Uint8Array; sha256: string; size: number }> {
  const object = await tenantStore(env).get(name, scope);
  if (!object) throw new Error(`${name} was not converted`);
  return { bytes: new Uint8Array(await new Response(object.body).arrayBuffer()), sha256: object.sha256, size: object.size };
}

describe('storage migration', () => {
  it('dry-run inventories old objects by namespace without storing or writing anything', async () => {
    const tenant = await legacyTenant();
    const inventory = await migration().inventory();
    expect(inventory.classes.drive.count).toBe(4);
    expect(inventory.classes.lfs.count).toBe(2);
    expect(inventory.classes.lfsChunk.count).toBe(3);
    expect(inventory.classes.checkpoint.count).toBe(1);
    expect(inventory.classes.checkpointChunk.count).toBe(2);
    expect(inventory.classes.other).toEqual({ count: 1, bytes: 'plain release bytes'.length });
    expect(inventory.otherPrefixes).toEqual({ releases: { count: 1, bytes: 'plain release bytes'.length } });
    expect(inventory.classes.lfsChunk.bytes).toBe(tenant.lfsBytes.byteLength + 2 * 29 + 40 + 29);
    const listed = await oldObjects();
    expect(inventory.objects.count).toBe(listed.size);
    const status = await migration().status();
    expect(status.phase).toBe('idle');
    expect(status.inventory.objects.count).toBe(0);
    expect((await env.DATA.list({ prefix: 'sse/' })).objects).toEqual([]);
  }, 30_000);

  it('converts every old object to one sse object readable through the tenant store, leaving old objects untouched', async () => {
    const tenant = await legacyTenant();
    const before = await oldObjects();
    await migration().start();
    const status = await settle('converted');
    expect(status.error).toBeNull();
    expect(status.failures).toEqual([]);

    const file = await plaintext(artifactObjectKey(userId, tenant.driveScope, tenant.files[0]!.hash), tenant.driveScope);
    expect(new TextDecoder().decode(file.bytes)).toBe('drive file 0');
    expect(file).toMatchObject({ sha256: `sha256:${sha256(tenant.files[0]!.bytes)}`, size: tenant.files[0]!.bytes.byteLength });
    const manifest = await plaintext(artifactObjectKey(userId, tenant.driveScope, tenant.manifestHash), tenant.driveScope);
    expect(JSON.parse(new TextDecoder().decode(manifest.bytes))).toMatchObject({ scopeId: tenant.driveScope, entries: [{ blobHash: tenant.files[0]!.hash }] });
    const earlier = await plaintext(artifactObjectKey(userId, `space:${projectId}`, tenant.unreferenced.hash), `space:${projectId}`);
    expect(earlier.bytes).toEqual(tenant.unreferenced.bytes);

    const lfs = await plaintext(tenant.lfsName, `lfs:${projectId}`);
    expect(lfs.sha256).toBe(`sha256:${tenant.lfsOid}`);
    expect(lfs.size).toBe(tenant.lfsBytes.byteLength);
    expect(sha256(lfs.bytes)).toBe(tenant.lfsOid);
    expect((await plaintext(tenant.smallLfsName, `lfs:${projectId}`)).bytes).toEqual(tenant.smallLfs);
    const checkpoint = await plaintext(tenant.checkpointName, `space:${workspaceId}`);
    expect(checkpoint).toMatchObject({ sha256: `sha256:${sha256(tenant.checkpointBytes)}`, size: tenant.checkpointBytes.byteLength });
    expect(sha256(checkpoint.bytes)).toBe(sha256(tenant.checkpointBytes));

    // Chunks are joined, never stored alone; the orphan, the stray chunk and the unknown name are reported only.
    const written = (await env.DATA.list({ prefix: 'sse/' })).objects.map(object => object.key).sort();
    expect(written).toHaveLength(6);
    expect(status.orphans.map(orphan => orphan.key)).toEqual([tenant.driveKey(tenant.orphanHash)]);
    expect(status.states).toMatchObject({ converted: { count: 6 }, joined: { count: 4 }, chunk: { count: 1 }, orphan: { count: 1 }, skipped: { count: 1 } });
    expect(await oldObjects()).toEqual(before);
  }, 30_000);

  it('resumes from its cursor after an interruption without rewriting what it converted', async () => {
    // More drive files than one step converts.
    const tenant = await legacyTenant(100);
    // Steps run by hand, each cancelling the alarm it set, so no step runs unobserved; `restarted` steps run on a new
    // instance over the same storage, as after an eviction.
    const step = (restarted: boolean) => runInDurableObject(migration(), async (live, state) => {
      const job = restarted ? new StorageMigrationDO(state, env) : live;
      await job.alarm();
      await state.storage.deleteAlarm();
      return job.status();
    });
    let status = await runInDurableObject(migration(), async (job, state) => {
      await job.start();
      await state.storage.deleteAlarm();
      return job.status();
    });
    for (let count = 0; count < 20 && !(status.phase === 'convert' && status.cursor !== null); count++) status = await step(false);
    expect(status.phase).toBe('convert');
    const firstStep = new Map((await env.DATA.list({ prefix: 'sse/' })).objects.map(object => [object.key, object.etag]));
    expect(firstStep.size).toBe(status.states.converted?.count);
    expect(firstStep.size).toBeLessThan(105);
    // The step that was interrupted had written a drive file it had not recorded: the next must accept it, not fail.
    const pending = new Set(await runInDurableObject(migration(), (_live, state) => state.storage.sql.exec<{ key: string }>(
      "SELECT key FROM objects WHERE state = 'pending' AND class = 'drive' AND key > ?", status.cursor,
    ).toArray().map(row => row.key)));
    const interrupted = tenant.files.find(file => pending.has(tenant.driveKey(file.hash)));
    if (!interrupted) throw new Error('The first step converted every drive file');
    await tenantStore(env).put(artifactObjectKey(userId, tenant.driveScope, interrupted.hash), tenant.driveScope, interrupted.bytes);

    // A restarted object continues from the stored cursor.
    for (let count = 0; count < 20 && status.phase !== 'converted'; count++) status = await step(true);
    expect(status.phase).toBe('converted');
    expect(status.failures).toEqual([]);
    expect(status.states.converted?.count).toBe(100 + 1 + 1 + 2 + 1);
    const after = new Map((await env.DATA.list({ prefix: 'sse/', limit: 1000 })).objects.map(object => [object.key, object.etag]));
    for (const [key, etag] of firstStep) expect(after.get(key)).toBe(etag);
    for (const file of tenant.files) expect((await plaintext(artifactObjectKey(userId, tenant.driveScope, file.hash), tenant.driveScope)).bytes).toEqual(file.bytes);
  }, 30_000);

  it('verify reports a planted mismatch, and purge deletes only the old objects of verified conversions', async () => {
    const tenant = await legacyTenant();
    await migration().start();
    await settle('converted');
    expect(await migration().purge().then(() => 'purged', (error: unknown) => String(error))).toMatch(/after a finished verify/u);

    const planted = artifactObjectKey(userId, tenant.driveScope, tenant.files[0]!.hash);
    await tenantStore(env).delete([planted]);
    await tenantStore(env).put(planted, tenant.driveScope, new TextEncoder().encode('drive file X'));
    await migration().verify();
    let status = await settle('verified');
    expect(status.verify).toEqual({ ok: 5, mismatch: 1, unverified: 0 });
    expect(status.mismatches.map(mismatch => mismatch.key)).toEqual([tenant.driveKey(tenant.files[0]!.hash)]);

    await migration().purge();
    status = await settle('purged');
    const remaining = [...(await oldObjects()).keys()].sort();
    expect(remaining).toEqual([
      tenant.driveKey(tenant.files[0]!.hash), tenant.driveKey(tenant.orphanHash), tenant.strayChunk, tenant.otherKey,
    ].sort());
    expect(status.purged.count).toBe(5 + 4);
    expect((await env.DATA.list({ prefix: 'sse/' })).objects).toHaveLength(6);
  }, 30_000);
});
