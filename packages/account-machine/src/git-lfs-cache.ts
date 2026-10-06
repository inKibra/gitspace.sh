import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { GitLfsObjectSchema, type GitLfsObject } from '@gitspace/protocol-workspace';

/** Consumers must exhaust the source before publishing any bytes as an object. */
export async function* verifiedLfsSource(object: GitLfsObject, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  GitLfsObjectSchema.parse(object);
  const hash = createHash('sha256');
  let received = 0;
  for await (const chunk of source) {
    signal?.throwIfAborted();
    if (chunk.byteLength > object.size - received) throw new Error(`Git LFS object ${object.oid} exceeds declared size`);
    received += chunk.byteLength;
    hash.update(chunk);
    yield chunk;
  }
  signal?.throwIfAborted();
  if (received !== object.size || hash.digest('hex') !== object.oid) throw new Error(`Git LFS object ${object.oid} failed integrity verification`);
}

export async function cachedLfsObject(path: string, object: GitLfsObject): Promise<boolean> {
  try {
    if ((await stat(path)).size !== object.size) throw new Error(`Git LFS object ${object.oid} failed integrity verification`);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  for await (const _chunk of verifiedLfsSource(object, createReadStream(path))) { /* Verify without retaining the payload. */ }
  return true;
}

/** A sibling temporary directory keeps rename atomic and incomplete content invisible. */
export async function installLfsObject(path: string, object: GitLfsObject, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(`${path}.tmp-`);
  try {
    const pending = join(temporary, 'object');
    const file = await open(pending, 'wx', 0o600);
    try {
      for await (const chunk of verifiedLfsSource(object, source, signal)) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal?.throwIfAborted();
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (!bytesWritten) throw new Error('LFS cache write made no progress');
          offset += bytesWritten;
        }
      }
    } finally { await file.close(); }
    signal?.throwIfAborted();
    await rename(pending, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
