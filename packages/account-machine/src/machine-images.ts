import { createHash } from 'node:crypto';
import { artifactObjectKey } from '@gitspace/protocol';
import { imageReference, parseImageReference } from '@gitspace/protocol-runtime/image-reference';
import type { MachineExecutorOptions } from '@gitspace/runtime-machine';
import type { CheckpointBlobStore } from './checkpoint-blobs.js';

/**
 * Stores an image a tool returned (a screenshot, an image file read) in its workspace's images, the attached workspace's
 * drive scope `space:<workspace>` under its SHA-256, and answers it named by reference: the result reaches the workspace
 * without the image's bytes, and the workspace measures the image itself when it admits the reference.
 */
export function machineImageStore(options: { blobs: CheckpointBlobStore; accountId: string }): NonNullable<MachineExecutorOptions['storeImage']> {
  return async (dispatch, image) => {
    if (parseImageReference(image.data)) return image;
    const bytes = Buffer.from(image.data, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await options.blobs.put(artifactObjectKey(options.accountId, `space:${dispatch.workspaceId}`, `sha256:${sha256}`), bytes, { projectId: dispatch.projectId, workspaceId: dispatch.workspaceId });
    return { ...image, data: imageReference({ workspaceId: dispatch.workspaceId, size: bytes.byteLength, width: 0, height: 0, sha256 }) };
  };
}
