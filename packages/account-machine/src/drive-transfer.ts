import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { artifactObjectKey, decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes } from '@gitspace/protocol';
import { ARTIFACT_UPLOAD_MAX_BYTES } from '@gitspace/protocol/rpc-contract';
import { RuntimeDriveTransferArgumentsSchema } from '@gitspace/protocol-runtime';
import { machineFilePath, type ExecutorOperationHandler } from '@gitspace/runtime-machine';
import type { CheckpointBlobStore } from './checkpoint-blobs.js';

/** AES-GCM envelope: version byte, nonce and tag. */
const SEALED_OVERHEAD = 29;
const limit = `Drive files are limited to ${ARTIFACT_UPLOAD_MAX_BYTES / 1024 / 1024} MiB`;

/**
 * Moves one drive file between the account's storage and this machine. Drive objects are single envelopes sealed with
 * the scope's key (derived from the account artifact key this machine holds) and stored under the hash of the sealed
 * bytes, so the machine reads and writes them as the worker does.
 */
export function driveTransferOperation(options: { blobs: CheckpointBlobStore; artifactKey: Uint8Array; accountId: string }): ExecutorOperationHandler {
  return async (dispatch, local) => {
    const args = RuntimeDriveTransferArgumentsSchema.parse(dispatch.args);
    const path = await machineFilePath(local.rootPath, args.path);
    const scopeKey = await deriveArtifactScopeKey(options.artifactKey, args.scopeId);
    if (args.direction === 'toMachine') {
      if (args.size > ARTIFACT_UPLOAD_MAX_BYTES) throw new Error(limit);
      const sealed = await options.blobs.get(artifactObjectKey(options.accountId, args.blobHash), args.blobHash, args.size + SEALED_OVERHEAD);
      if (!sealed) throw new Error('The drive file is missing from storage');
      const bytes = await decryptArtifactBytes(sealed, scopeKey);
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
    const sealed = await encryptArtifactBytes(bytes, scopeKey);
    const blobHash = `sha256:${new Bun.CryptoHasher('sha256').update(sealed).digest('hex')}`;
    await options.blobs.put(artifactObjectKey(options.accountId, blobHash), sealed);
    return [{ type: 'text', text: JSON.stringify({ blobHash, size: bytes.byteLength }) }];
  };
}
