import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactObjectKey, decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes } from '@gitspace/protocol';
import { RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import { FileCheckpointBlobStore } from '../src/checkpoint-blobs.js';
import { driveTransferOperation } from '../src/drive-transfer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const storage = await mkdtemp('/tmp/drive-transfer-storage-');
  const checkout = await mkdtemp('/tmp/drive-transfer-checkout-');
  const scratch = await mkdtemp('/tmp/drive-transfer-scratch-');
  roots.push(storage, checkout, scratch);
  const blobs = new FileCheckpointBlobStore(storage);
  const artifactKey = crypto.getRandomValues(new Uint8Array(32));
  const accountId = 'account-1';
  const scopeId = 'space:workspace-1';
  const operation = driveTransferOperation({ blobs, artifactKey, accountId });
  const local = { rootPath: checkout } as LocalAttachment;
  const run = (args: Record<string, unknown>) => operation(RuntimeToolDispatchSchema.parse({
    version: 1, projectId: 'project-1', workspaceId: 'workspace-1', machineId: 'm-1', attachmentId: 'a-1', generation: 1,
    conversationId: 'c-1', conversationKind: 'main', taskId: 't-1', requestId: 'r-1', attemptId: 'tool:1', tool: 'drive_transfer', args,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe',
  }), local, new AbortController().signal);
  /** Seals and stores bytes as the worker does for a drive file: one envelope under the scope key, keyed by its hash. */
  const storeAsWorker = async (bytes: Uint8Array) => {
    const sealed = await encryptArtifactBytes(bytes, await deriveArtifactScopeKey(artifactKey, scopeId));
    const blobHash = `sha256:${new Bun.CryptoHasher('sha256').update(sealed).digest('hex')}`;
    await blobs.put(artifactObjectKey(accountId, blobHash), sealed);
    return blobHash;
  };
  const openAsWorker = async (blobHash: string, scope = scopeId) => {
    const sealed = await blobs.get(artifactObjectKey(accountId, blobHash), blobHash);
    if (!sealed) throw new Error('missing');
    return decryptArtifactBytes(sealed, await deriveArtifactScopeKey(artifactKey, scope));
  };
  return { run, storeAsWorker, openAsWorker, checkout, scratch, scopeId };
}

const zip = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 31) % 256);

test('a drive file lands byte for byte under /tmp or the checkout', async () => {
  const { run, storeAsWorker, checkout, scratch, scopeId } = await fixture();
  const blobHash = await storeAsWorker(zip);
  const target = join(scratch, 'fonts', 'Timeless.zip');
  expect(await run({ direction: 'toMachine', path: target, scopeId, blobHash, size: zip.byteLength })).toEqual([{ type: 'text', text: JSON.stringify({ path: target, size: zip.byteLength }) }]);
  expect(new Uint8Array(await readFile(target))).toEqual(zip);
  await run({ direction: 'toMachine', path: 'vendor/Timeless.zip', scopeId, blobHash, size: zip.byteLength });
  expect(new Uint8Array(await readFile(join(checkout, 'vendor/Timeless.zip')))).toEqual(zip);
  // A recorded size the object does not have, or another scope's key, writes nothing.
  await expect(run({ direction: 'toMachine', path: join(scratch, 'short.zip'), scopeId, blobHash, size: zip.byteLength - 1 })).rejects.toThrow();
  await expect(run({ direction: 'toMachine', path: join(scratch, 'other.zip'), scopeId: 'space:other', blobHash, size: zip.byteLength })).rejects.toThrow();
  await expect(readFile(join(scratch, 'other.zip'))).rejects.toThrow();
});

test('a machine file is stored sealed under the scope key the worker opens', async () => {
  const { run, openAsWorker, scratch, scopeId } = await fixture();
  const source = join(scratch, 'build.zip');
  await writeFile(source, zip);
  const [result] = await run({ direction: 'fromMachine', path: source, scopeId });
  const stored = JSON.parse(result!.type === 'text' ? result!.text : '');
  expect(stored.size).toBe(zip.byteLength);
  expect(await openAsWorker(stored.blobHash)).toEqual(zip);
  await expect(openAsWorker(stored.blobHash, 'space:other')).rejects.toThrow();
});

test('paths outside the checkout and /tmp are refused both ways', async () => {
  const { run, storeAsWorker, scopeId } = await fixture();
  const blobHash = await storeAsWorker(zip);
  await expect(run({ direction: 'toMachine', path: '/etc/gitspace-planted.zip', scopeId, blobHash, size: zip.byteLength })).rejects.toThrow('Absolute paths must be inside /tmp');
  await expect(run({ direction: 'toMachine', path: '../escape.zip', scopeId, blobHash, size: zip.byteLength })).rejects.toThrow('Path leaves authorized checkout');
  await expect(run({ direction: 'fromMachine', path: '/etc/hostname', scopeId })).rejects.toThrow('Absolute paths must be inside /tmp');
});
