import { expect, it } from 'bun:test';
import { collectBytes } from '@gitspace/protocol-workspace';
import { CloudDataCheckpointBlobStore } from '../src/cloud-space-authority.js';
import { fakeDataEndpoint } from './data-endpoint-fake.js';

const PART = 32 * 1024 * 1024;
const sha256 = (bytes: Uint8Array): `sha256:${string}` => `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;

it('stores checkpoint blobs as plaintext bound to their SHA-256 in one request and reads them back verified', async () => {
  const data = fakeDataEndpoint();
  const bytes = new TextEncoder().encode('persisted complete OMP checkpoint\n');
  const key = 'projects/project-a/spaces/space-a/omp/1.enc';
  expect(await data.store.putStream(key, (async function* () { yield bytes.subarray(0, 9); yield bytes.subarray(9); })(), { size: bytes.byteLength, hash: sha256(bytes) })).toBe(sha256(bytes));
  expect(data.objects.get(key)?.bytes).toEqual(bytes);
  expect(data.requests.filter(request => request.operation !== 'data.head').map(request => request.payload)).toEqual([{ key, hash: sha256(bytes), size: bytes.byteLength }]);
  const source = await data.store.getStream(key, { hash: sha256(bytes), size: bytes.byteLength });
  expect(await collectBytes(source!, bytes.byteLength)).toEqual(bytes);
  expect(await data.store.get(key)).toEqual(bytes);
});

it('refuses a body that does not match its recorded SHA-256, with or without an expected hash', async () => {
  const data = fakeDataEndpoint();
  const bytes = new TextEncoder().encode('release manifest');
  await data.store.put('releases/a/manifest.json', bytes);
  data.tamper('releases/a/manifest.json', new TextEncoder().encode('release manifesT'));
  await expect(data.store.get('releases/a/manifest.json')).rejects.toThrow('failed integrity verification');
  await expect(data.store.get('releases/a/manifest.json', sha256(bytes))).rejects.toThrow('failed integrity verification');
});

it('refuses an intact object that is not the one the caller named, before reading its body', async () => {
  const served = new TextEncoder().encode('another release manifest');
  let pulled = false;
  const fetcher = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled = true; controller.enqueue(served); controller.close(); },
  }, { highWaterMark: 0 }), { headers: { 'x-gitspace-sha256': sha256(served), 'content-length': String(served.byteLength) } }), { preconnect: fetch.preconnect });
  const store = new CloudDataCheckpointBlobStore({ ...fakeDataEndpoint().options, fetcher });
  const named = new TextEncoder().encode('release manifest');
  await expect(store.get('releases/a/manifest.json', sha256(named))).rejects.toMatchObject({ code: 'DATA_INTEGRITY_FAILED' });
  await expect(store.getStream('lfs/projects/p/objects/x', { hash: sha256(served), size: served.byteLength + 1 })).rejects.toMatchObject({ code: 'DATA_INTEGRITY_FAILED' });
  expect(pulled).toBe(false);
});

it('uploads a blob above one request as uniform multipart parts and streams it back verified', async () => {
  const data = fakeDataEndpoint();
  const size = PART + 17;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 4096) bytes[index] = index % 251;
  const key = 'lfs/projects/project-a/objects/large';
  const hash = await data.store.putStream(key, (async function* () {
    // Arbitrary source boundaries: parts are cut by the store, not by the source.
    yield bytes.subarray(0, 13);
    yield bytes.subarray(13, PART + 5);
    yield bytes.subarray(PART + 5);
  })(), { size, hash: sha256(bytes) });
  expect(hash).toBe(sha256(bytes));
  const parts = data.requests.filter(request => request.operation === 'data.multipart.part').map(request => request.payload.size);
  expect(parts).toEqual([PART, 17]);
  expect(data.requests.map(request => request.operation).filter(operation => operation.startsWith('data.multipart.') && operation !== 'data.multipart.part'))
    .toEqual(['data.multipart.create', 'data.multipart.complete']);
  expect(data.requests.some(request => request.operation === 'data.put')).toBe(false);
  const source = await data.store.getStream(key, { hash, size });
  expect(source).not.toBeNull();
  expect(sha256(await collectBytes(source!, size))).toBe(hash);
});

it('aborts a multipart upload whose source does not match its declared hash', async () => {
  const data = fakeDataEndpoint();
  const size = PART + 1;
  await expect(data.store.putStream('lfs/projects/project-a/objects/wrong', (async function* () { yield new Uint8Array(size); })(), { size, hash: `sha256:${'0'.repeat(64)}` }))
    .rejects.toThrow('failed integrity verification');
  expect(data.requests.map(request => request.operation).filter(operation => operation !== 'data.multipart.part'))
    .toEqual(['data.multipart.create', 'data.multipart.abort']);
  expect(data.objects.size).toBe(0);
});
