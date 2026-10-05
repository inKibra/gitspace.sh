import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { createCloudGitLfsStore } from '../src/cloud-lfs-store.js';
import { FileCheckpointBlobStore } from '../src/portable-space-lifecycle.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

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
  const store = await createCloudGitLfsStore(options);
  await expect(store.put(object, bytes)).rejects.toThrow('403');
  expect(await store.get(object)).toBeNull();
  rejectPin = false;
  await store.put(object, bytes);
  expect(await store.get(object)).toEqual(bytes);
  const path = join(root, `lfs/projects/project-a/objects/${object.oid}`);
  const ciphertext = await readFile(path);
  expect(ciphertext).not.toEqual(Buffer.from(bytes));
  await store.put(object, bytes);
  expect(await readFile(path)).toEqual(ciphertext);
  await expect(store.put(object, new Uint8Array(bytes.length))).rejects.toThrow('oid/size');
  expect(await (await createCloudGitLfsStore({ ...options, projectId: 'other-project' })).get(object)).toBeNull();
  await store.releasePublication();
});

it('does not allow a read-only restore adapter to upload unpinned objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-lfs-restore-'));
  roots.push(root);
  const bytes = new Uint8Array([1, 2, 3]);
  const object = GitLfsObjectSchema.parse({ oid: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: bytes.length });
  const store = await createCloudGitLfsStore({ projectId: 'project-a', blobs: new FileCheckpointBlobStore(root), encryptionKey: new Uint8Array(32).fill(11), controlOptions: { userId: 'account-a', machineId: 'machine-a', baseUrl: 'https://offline.invalid', signingPrivateKey: new Uint8Array(32).fill(21) } });
  await expect(store.put(object, bytes)).rejects.toThrow('publication identity');
  expect(await store.get(object)).toBeNull();
});
