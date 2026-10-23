import { expect, it } from 'bun:test';
import { collectBytes, GitLfsObjectSchema, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';
import { createCloudGitLfsPublisher, createCloudGitLfsStore } from '../src/cloud-lfs-store.js';
import { CloudDataCheckpointBlobStore } from '../src/cloud-space-authority.js';
import { fakeDataEndpoint } from './data-endpoint-fake.js';

const PART = 32 * 1024 * 1024;

async function* source(bytes: Uint8Array) { yield bytes; }
async function downloaded(store: Pick<GitLfsStore, 'get'>, object: GitLfsObject) {
  const stream = await store.get(object);
  return stream === null ? null : collectBytes(stream, object.size);
}
function lfsObject(...parts: Uint8Array[]) {
  const hash = new Bun.CryptoHasher('sha256');
  for (const part of parts) hash.update(part);
  return GitLfsObjectSchema.parse({ oid: hash.digest('hex'), size: parts.reduce((total, part) => total + part.byteLength, 0) });
}
function controlOptions(pin: (operation: string) => Response = () => Response.json({ status: 'ok', value: { objects: [] } })) {
  const fetcher = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const operation = String(JSON.parse(String(init?.body)).operation);
    return operation === 'lfs.pin' ? pin(operation) : Response.json({ status: 'ok', value: null });
  }, { preconnect: fetch.preconnect });
  return { userId: 'account-a', machineId: 'machine-a', baseUrl: 'https://account.invalid', signingPrivateKey: new Uint8Array(32).fill(21), fetcher };
}

it('pins before upload, stores the plaintext under its oid, deduplicates, and rejects a wrong plaintext oid', async () => {
  const data = fakeDataEndpoint();
  const bytes = new TextEncoder().encode('machine LFS payload');
  const object = lfsObject(bytes);
  const key = `lfs/projects/project-a/objects/${object.oid}`;
  let rejectPin = true;
  const options = { projectId: 'project-a', blobs: data.store, publicationId: 'capture-a', controlOptions: controlOptions(() => rejectPin ? Response.json({ status: 'error' }, { status: 403 }) : Response.json({ status: 'ok', value: { objects: [] } })) };
  const store = createCloudGitLfsPublisher(options);
  await expect(store.put(object, source(bytes))).rejects.toThrow('403');
  expect(await store.get(object)).toBeNull();
  rejectPin = false;
  await store.put(object, source(bytes));
  expect(data.objects.get(key)?.bytes).toEqual(bytes);
  expect(data.requests.find(request => request.operation === 'data.put')?.payload).toEqual({ key, hash: `sha256:${object.oid}`, size: object.size });
  expect(await downloaded(store, object)).toEqual(bytes);
  const puts = data.requests.filter(request => request.operation === 'data.put').length;
  await store.put(object, source(bytes));
  expect(data.requests.filter(request => request.operation === 'data.put').length).toBe(puts);
  await expect(store.put(object, source(new Uint8Array(bytes.length)))).rejects.toThrow('failed integrity verification');
  expect(await createCloudGitLfsStore({ ...options, projectId: 'other-project' }).get(object)).toBeNull();
  await store.releasePublication();
});

it('uploads an object above one request in parts across arbitrary source boundaries and verifies it on read', async () => {
  const data = fakeDataEndpoint();
  const first = new Uint8Array(PART).fill(37);
  const last = new Uint8Array([9, 8, 7]);
  const object = lfsObject(first, last);
  const store = createCloudGitLfsPublisher({ projectId: 'stream', publicationId: 'upload', blobs: data.store, controlOptions: controlOptions() });
  await store.put(object, (async function* () {
    yield first.subarray(0, 13);
    yield first.subarray(13);
    yield last;
  })());
  expect(data.requests.filter(request => request.operation === 'data.multipart.part').map(request => request.payload.size)).toEqual([PART, 3]);
  const result = await store.get(object);
  if (!result) throw new Error('Missing object');
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of result) hash.update(chunk);
  expect(hash.digest('hex')).toBe(object.oid);
  expect(await store.has(object)).toBe(true);
});

it('refuses served bytes that are not the oid even when the account vouches for them', async () => {
  const data = fakeDataEndpoint();
  const bytes = new TextEncoder().encode('payload');
  const object = lfsObject(bytes);
  const key = `lfs/projects/stream/objects/${object.oid}`;
  data.objects.set(key, { bytes, workspaceId: null });
  data.tamper(key, new TextEncoder().encode('paYload'));
  const store = createCloudGitLfsStore({ projectId: 'stream', blobs: data.store, controlOptions: controlOptions() });
  await expect(downloaded(store, object)).rejects.toThrow('failed integrity verification');
  expect(await store.has(object).catch(() => 'refused')).toBe('refused');
});

it('cancels an oversized HTTP body without reading the remainder', async () => {
  let pulls = 0;
  let canceled = false;
  const fetcher = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32)); if (pulls === 4) controller.close(); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { headers: { 'x-gitspace-sha256': `sha256:${'a'.repeat(64)}`, 'content-length': '128' } }), { preconnect: fetch.preconnect });
  const store = new CloudDataCheckpointBlobStore({ userId: 'a', machineId: 'b', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21), fetcher });
  await expect(store.get('lfs/projects/a/objects/test', undefined, 16)).rejects.toThrow('exceeds 16 bytes');
  expect(canceled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(1);
});

it('does not publish a mismatched streaming source and closes it on overflow', async () => {
  const data = fakeDataEndpoint();
  const bytes = new Uint8Array([1, 2, 3]);
  const object = lfsObject(bytes);
  const store = createCloudGitLfsPublisher({ projectId: 'stream', publicationId: 'upload', blobs: data.store, controlOptions: controlOptions() });
  let closed = false;
  await expect(store.put(object, (async function* () {
    try { yield new Uint8Array(4); throw new Error('Read past overflow'); }
    finally { closed = true; }
  })())).rejects.toThrow('exceeds its recorded size');
  expect(closed).toBe(true);
  expect(await store.get(object)).toBeNull();
  await expect(store.put(object, source(new Uint8Array(3)))).rejects.toThrow('failed integrity verification');
  expect(await store.get(object)).toBeNull();
});
