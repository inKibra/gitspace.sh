import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactObjectKey } from '@gitspace/protocol';
import { RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import { driveTransferOperation } from '../src/drive-transfer.js';
import { fakeDataEndpoint } from './data-endpoint-fake.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const sha256 = (bytes: Uint8Array): `sha256:${string}` => `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;

async function fixture() {
  const checkout = await mkdtemp('/tmp/drive-transfer-checkout-');
  const scratch = await mkdtemp('/tmp/drive-transfer-scratch-');
  roots.push(checkout, scratch);
  const data = fakeDataEndpoint();
  const accountId = 'account-1';
  const scopeId = 'space:workspace-1';
  const operation = driveTransferOperation({ blobs: data.store, accountId });
  const local = { rootPath: checkout } as LocalAttachment;
  const run = (args: Record<string, unknown>) => operation(RuntimeToolDispatchSchema.parse({
    version: 1, projectId: 'project-1', workspaceId: 'workspace-1', machineId: 'm-1', attachmentId: 'a-1', generation: 1,
    conversationId: 'c-1', conversationKind: 'main', taskId: 't-1', requestId: 'r-1', attemptId: 'tool:1', tool: 'drive_transfer', args,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe',
  }), local, new AbortController().signal);
  /** Stores a drive file as the account does: its plaintext, named in its drive scope by a reference hash. */
  const storeAsAccount = (bytes: Uint8Array, blobHash = sha256(bytes)) => {
    data.objects.set(artifactObjectKey(accountId, scopeId, blobHash), { bytes, workspaceId: null });
    return blobHash;
  };
  return { run, storeAsAccount, data, accountId, checkout, scratch, scopeId };
}

const zip = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 31) % 256);

test('a drive file lands byte for byte under /tmp or the checkout, read for the attached workspace without any key', async () => {
  const { run, storeAsAccount, data, accountId, checkout, scratch, scopeId } = await fixture();
  const blobHash = storeAsAccount(zip);
  const target = join(scratch, 'fonts', 'Timeless.zip');
  expect(await run({ direction: 'toMachine', path: target, scopeId, blobHash, size: zip.byteLength })).toEqual([{ type: 'text', text: JSON.stringify({ path: target, size: zip.byteLength }) }]);
  expect(new Uint8Array(await readFile(target))).toEqual(zip);
  expect(data.requests.at(-1)?.payload).toEqual({ key: artifactObjectKey(accountId, scopeId, blobHash), projectId: 'project-1', workspaceId: 'workspace-1' });
  await run({ direction: 'toMachine', path: 'vendor/Timeless.zip', scopeId, blobHash, size: zip.byteLength });
  expect(new Uint8Array(await readFile(join(checkout, 'vendor/Timeless.zip')))).toEqual(zip);
  // A recorded size the object does not have, or bytes that do not match the object's recorded hash, write nothing.
  await expect(run({ direction: 'toMachine', path: join(scratch, 'short.zip'), scopeId, blobHash, size: zip.byteLength - 1 })).rejects.toThrow();
  await expect(readFile(join(scratch, 'short.zip'))).rejects.toThrow();
  data.tamper(artifactObjectKey(accountId, scopeId, blobHash), zip.toReversed());
  await expect(run({ direction: 'toMachine', path: join(scratch, 'tampered.zip'), scopeId, blobHash, size: zip.byteLength })).rejects.toThrow('integrity');
  await expect(readFile(join(scratch, 'tampered.zip'))).rejects.toThrow();
});

test('a drive file stored under an older reference hash still lands, verified by its recorded plaintext hash', async () => {
  const { run, storeAsAccount, scratch, scopeId } = await fixture();
  const legacyReference: `sha256:${string}` = `sha256:${'c'.repeat(64)}`;
  storeAsAccount(zip, legacyReference);
  const target = join(scratch, 'legacy.zip');
  await run({ direction: 'toMachine', path: target, scopeId, blobHash: legacyReference, size: zip.byteLength });
  expect(new Uint8Array(await readFile(target))).toEqual(zip);
});

test('a machine file is stored as plaintext named by its SHA-256 in the named drive scope', async () => {
  const { run, data, accountId, scratch, scopeId } = await fixture();
  const source = join(scratch, 'build.zip');
  await writeFile(source, zip);
  const [result] = await run({ direction: 'fromMachine', path: source, scopeId });
  expect(JSON.parse(result!.type === 'text' ? result!.text : '')).toEqual({ blobHash: sha256(zip), size: zip.byteLength });
  expect(data.objects.get(artifactObjectKey(accountId, scopeId, sha256(zip)))).toEqual({ bytes: zip, workspaceId: 'workspace-1' });
  expect(data.requests.find(request => request.operation === 'data.put')?.payload).toEqual({
    key: artifactObjectKey(accountId, scopeId, sha256(zip)), hash: sha256(zip), size: zip.byteLength, projectId: 'project-1', workspaceId: 'workspace-1',
  });
});

test('paths outside the checkout and /tmp are refused both ways', async () => {
  const { run, storeAsAccount, scopeId } = await fixture();
  const blobHash = storeAsAccount(zip);
  await expect(run({ direction: 'toMachine', path: '/etc/gitspace-planted.zip', scopeId, blobHash, size: zip.byteLength })).rejects.toThrow('Absolute paths must be inside /tmp');
  await expect(run({ direction: 'toMachine', path: '../escape.zip', scopeId, blobHash, size: zip.byteLength })).rejects.toThrow('Path leaves authorized checkout');
  await expect(run({ direction: 'fromMachine', path: '/etc/hostname', scopeId })).rejects.toThrow('Absolute paths must be inside /tmp');
});
