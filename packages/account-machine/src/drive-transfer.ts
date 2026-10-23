import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { artifactObjectKey } from '@gitspace/protocol';
import { ARTIFACT_UPLOAD_MAX_BYTES } from '@gitspace/protocol/rpc-contract';
import { RuntimeDriveTransferArgumentsSchema } from '@gitspace/protocol-runtime';
import { machineFilePath, type ExecutorOperationHandler } from '@gitspace/runtime-machine';
import { hashBytes, type CheckpointBlobStore } from './checkpoint-blobs.js';

const limit = `Drive files are limited to ${ARTIFACT_UPLOAD_MAX_BYTES / 1024 / 1024} MiB`;

/**
 * Moves one drive file between the account's storage and this machine. A drive object is the file's plaintext, named
 * within its drive scope by its SHA-256; the account encrypts it at rest and authorizes the scope from the attached
 * workspace the request names, so the machine holds no key. The recorded `blobHash` may name an object stored before
 * plaintext naming, so reads verify the bytes against the object's recorded hash and the drive's recorded size.
 */
export function driveTransferOperation(options: { blobs: CheckpointBlobStore; accountId: string }): ExecutorOperationHandler {
  return async (dispatch, local) => {
    const args = RuntimeDriveTransferArgumentsSchema.parse(dispatch.args);
    const path = await machineFilePath(local.rootPath, args.path);
    const workspace = { projectId: dispatch.projectId, workspaceId: dispatch.workspaceId };
    if (args.direction === 'toMachine') {
      if (args.size > ARTIFACT_UPLOAD_MAX_BYTES) throw new Error(limit);
      const bytes = await options.blobs.get(artifactObjectKey(options.accountId, args.scopeId, args.blobHash), undefined, args.size, workspace);
      if (!bytes) throw new Error('The drive file is missing from storage');
      if (bytes.byteLength !== args.size) throw new Error('The drive file does not match its recorded size');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return [{ type: 'text', text: JSON.stringify({ path: args.path, size: bytes.byteLength }) }];
    }
    const file = await open(path, 'r');
    let bytes: Uint8Array;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`${args.path} is not a file`);
      if (stat.size > ARTIFACT_UPLOAD_MAX_BYTES) throw new Error(limit);
      bytes = await file.readFile();
    } finally { await file.close(); }
    if (bytes.byteLength > ARTIFACT_UPLOAD_MAX_BYTES) throw new Error(limit);
    const blobHash = hashBytes(bytes);
    await options.blobs.put(artifactObjectKey(options.accountId, args.scopeId, blobHash), bytes, workspace);
    return [{ type: 'text', text: JSON.stringify({ blobHash, size: bytes.byteLength }) }];
  };
}
