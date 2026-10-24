import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { artifactObjectKey, DRIVE_FILE_MAX_BYTES, driveUploadObjectKey } from '@gitspace/protocol';
import { RuntimeDriveTransferArgumentsSchema } from '@gitspace/protocol-runtime';
import { machineFilePath, type ExecutorOperationHandler } from '@gitspace/runtime-machine';
import type { BlobHash, StreamingBlobStore } from './checkpoint-blobs.js';

const limit = `Drive files are limited to ${DRIVE_FILE_MAX_BYTES / 1024 / 1024 / 1024} GiB`;
/** Bytes read from a local file at a time. */
const FILE_READ_BYTES = 4 * 1024 * 1024;

/** The first `size` bytes of an open file; a file that became shorter fails rather than sending fewer bytes. */
async function* fileBytes(file: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  for (let position = 0; position < size;) {
    const buffer = new Uint8Array(Math.min(FILE_READ_BYTES, size - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) throw new Error('The file became shorter while it was read');
    yield buffer.subarray(0, bytesRead);
    position += bytesRead;
  }
}

/**
 * Moves one drive file between the account's storage and this machine, streaming either way (up to
 * `DRIVE_FILE_MAX_BYTES`). A drive object is the file's plaintext, named within its drive scope by its SHA-256; the
 * account encrypts it at rest and authorizes the scope from the attached workspace the request names, so the machine
 * holds no key. The recorded `blobHash` may name an object stored before plaintext naming, so reads verify the bytes
 * against the object's recorded hash and the drive's recorded size; the file appears at `path` only once they did.
 */
export function driveTransferOperation(options: { blobs: StreamingBlobStore; accountId: string }): ExecutorOperationHandler {
  return async (dispatch, local) => {
    const args = RuntimeDriveTransferArgumentsSchema.parse(dispatch.args);
    const path = await machineFilePath(local.rootPath, args.path);
    const workspace = { projectId: dispatch.projectId, workspaceId: dispatch.workspaceId };
    if (args.direction === 'toMachine') {
      if (args.size > DRIVE_FILE_MAX_BYTES) throw new Error(limit);
      // A file streamed before its digest was known is its own object, read against the digest its manifest names.
      const source = args.object
        ? await options.blobs.getStream(driveUploadObjectKey(options.accountId, args.scopeId, args.object), { hash: args.blobHash, size: args.size }, workspace)
        : await options.blobs.getStream(artifactObjectKey(options.accountId, args.scopeId, args.blobHash), { size: args.size }, workspace);
      if (!source) throw new Error('The drive file is missing from storage');
      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.${randomUUID()}.partial`;
      const file = await open(partial, 'wx');
      try {
        for await (const chunk of source) {
          for (let offset = 0; offset < chunk.byteLength;) offset += (await file.write(chunk, offset)).bytesWritten;
        }
        await file.close();
        await rename(partial, path);
      } catch (error) {
        await file.close().catch(() => undefined);
        await rm(partial, { force: true });
        throw error;
      }
      return [{ type: 'text', text: JSON.stringify({ path: args.path, size: args.size }) }];
    }
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`${args.path} is not a file`);
      if (stat.size > DRIVE_FILE_MAX_BYTES) throw new Error(limit);
      // The account names the object by its digest before the first byte arrives: hash the file, then send it.
      const hasher = new Bun.CryptoHasher('sha256');
      for await (const chunk of fileBytes(file, stat.size)) hasher.update(chunk);
      const blobHash: BlobHash = `sha256:${hasher.digest('hex')}`;
      await options.blobs.putStream(artifactObjectKey(options.accountId, args.scopeId, blobHash), fileBytes(file, stat.size), { size: stat.size, hash: blobHash }, workspace);
      return [{ type: 'text', text: JSON.stringify({ blobHash, size: stat.size }) }];
    } finally { await file.close(); }
  };
}
