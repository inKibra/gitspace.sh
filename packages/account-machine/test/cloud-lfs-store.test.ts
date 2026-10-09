import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, collectBytes, GitLfsObjectSchema, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';
import { createCloudGitLfsPublisher, createCloudGitLfsStore } from '../src/cloud-lfs-store.js';
import { FileCheckpointBlobStore } from '../src/portable-space-lifecycle.js';
import { deriveArtifactScopeKey, encryptArtifactBytes } from '@gitspace/protocol';
import { CloudDataCheckpointBlobStore } from '../src/cloud-space-authority.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function* source(bytes: Uint8Array) { yield bytes; }
async function downloaded(store: Pick<GitLfsStore, 'get'>, object: GitLfsObject) {
  const stream = await store.get(object);
  return stream === null ? null : collectBytes(stream, object.size);
}

it('pins before upload, roundtrips encrypted payloads, deduplicates, and rejects a wrong plaintext oid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-lfs-adapter-'));
  roots.push(root);
  const bytes = new TextEncoder().encode('machine LFS payload');
  const object = GitLfsObjectSchema.parse({ oid: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: bytes.byteLength });
  let rejectPin = true;
  const fetcher = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init?.body));
    return rejectPin && request.operation === 'lfs.pin' ? Response.json({ status: 'error' }, { status: 403 }) : Response.json({ status: 'ok', value: request.operation === 'lfs.pin' ? { objects: [] } : null });
  }, { preconnect: fetch.preconnect });
  const options = { projectId: 'project-a', blobs: new FileCheckpointBlobStore(root), encryptionKey: new Uint8Array(32).fill(11), publicationId: 'capture-a', controlOptions: { userId: 'account-a', machineId: 'machine-a', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21), fetcher } };
  const store = await createCloudGitLfsPublisher(options);
  await expect(store.put(object, source(bytes))).rejects.toThrow('403');
  expect(await store.get(object)).toBeNull();
  rejectPin = false;
  await store.put(object, source(bytes));
  expect(await downloaded(store, object)).toEqual(bytes);
  const path = join(root, `lfs/projects/project-a/objects/${object.oid}`);
  const ciphertext = await readFile(path);
  expect(ciphertext).not.toEqual(Buffer.from(bytes));
  await store.put(object, source(bytes));
  expect(await readFile(path)).toEqual(ciphertext);
  await expect(store.put(object, source(new Uint8Array(bytes.length)))).rejects.toThrow('oid/size');
  expect(await (await createCloudGitLfsStore({ ...options, projectId: 'other-project' })).get(object)).toBeNull();
  await store.releasePublication();
});

it('streams a multi-chunk object across arbitrary upload boundaries and verifies completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-lfs-stream-'));
  roots.push(root);
  const first = new Uint8Array(CHECKPOINT_CHUNK_BYTES).fill(37);
  const last = new Uint8Array([9, 8, 7]);
  const object = GitLfsObjectSchema.parse({ oid: new Bun.CryptoHasher('sha256').update(first).update(last).digest('hex'), size: first.length + last.length });
  const fetcher = Object.assign(async () => Response.json({ status: 'ok', value: { objects: [] } }), { preconnect: fetch.preconnect });
  const store = await createCloudGitLfsPublisher({ projectId: 'stream', publicationId: 'upload', blobs: new FileCheckpointBlobStore(root), encryptionKey: new Uint8Array(32).fill(11), controlOptions: { userId: 'a', machineId: 'b', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21), fetcher } });
  await store.put(object, (async function* () {
    yield first.subarray(0, 13);
    yield first.subarray(13);
    yield last;
  })());
  const result = await store.get(object);
  if (!result) throw new Error('Missing object');
  const sizes: number[] = [];
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of result) { sizes.push(chunk.length); hash.update(chunk); }
  expect(sizes).toEqual([first.length, last.length]);
  expect(hash.digest('hex')).toBe(object.oid);
  expect(await store.has(object)).toBe(true);
});

it('rejects an authenticated oversized inventory before requesting its chunks', async () => {
  const key = new Uint8Array(32).fill(11);
  const size = CHECKPOINT_CHUNK_BYTES + 1;
  const forged = new TextEncoder().encode(JSON.stringify({ version: 1, size: Number.MAX_SAFE_INTEGER, chunks: [] }));
  const sealed = await encryptArtifactBytes(forged, await deriveArtifactScopeKey(key, 'lfs:stream'));
  const envelope = new Uint8Array(sealed.length + 1);
  envelope[0] = CHUNKED_CHECKPOINT_VERSION;
  envelope.set(sealed, 1);
  let reads = 0;
  const store = await createCloudGitLfsStore({ projectId: 'stream', blobs: {
    async get() { reads++; if (reads > 1) throw new Error('Unexpected chunk read'); return envelope; },
    async put() { throw new Error('Unexpected upload'); },
  }, encryptionKey: key, controlOptions: { userId: 'a', machineId: 'b', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21) } });
  await expect(downloaded(store, GitLfsObjectSchema.parse({ oid: 'a'.repeat(64), size }))).rejects.toThrow();
  expect(reads).toBe(1);
});

it('cancels an oversized HTTP ciphertext without reading the remainder', async () => {
  let pulls = 0;
  let canceled = false;
  const fetcher = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32)); if (pulls === 4) controller.close(); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 })), { preconnect: fetch.preconnect });
  const store = new CloudDataCheckpointBlobStore({ userId: 'a', machineId: 'b', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21), fetcher });
  await expect(store.get('lfs/projects/a/objects/test', undefined, 16)).rejects.toThrow();
  expect(canceled).toBe(true);
  expect(pulls).toBe(1);
});

it('does not publish a mismatched streaming source and closes it on overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-lfs-source-'));
  roots.push(root);
  const bytes = new Uint8Array([1, 2, 3]);
  const object = GitLfsObjectSchema.parse({ oid: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: bytes.length });
  const fetcher = Object.assign(async () => Response.json({ status: 'ok', value: { objects: [] } }), { preconnect: fetch.preconnect });
  const store = await createCloudGitLfsPublisher({ projectId: 'stream', publicationId: 'upload', blobs: new FileCheckpointBlobStore(root), encryptionKey: new Uint8Array(32).fill(11), controlOptions: { userId: 'a', machineId: 'b', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21), fetcher } });
  let closed = false;
  await expect(store.put(object, (async function* () {
    try { yield new Uint8Array(4); throw new Error('Read past overflow'); }
    finally { closed = true; }
  })())).rejects.toThrow('oid/size');
  expect(closed).toBe(true);
  expect(await store.get(object)).toBeNull();
  await expect(store.put(object, source(new Uint8Array(3)))).rejects.toThrow('oid/size');
  expect(await store.get(object)).toBeNull();
});
