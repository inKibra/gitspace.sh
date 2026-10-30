import { WorkerEntrypoint } from 'cloudflare:workers';
import { parseImageReference } from '@gitspace/protocol-runtime/image-reference';
import { DriveFiles } from './drive-files.js';
import { tenantStore } from './tenant-store.js';

export interface ImageReaderProps { workspaceId: string }

/**
 * A workspace's stored images for its inference worker, read straight from the account's storage with the account key,
 * so the bytes never pass through the workspace object. Made per workspace (`ctx.exports.ImageReader({ props })`): it
 * serves only references that name the workspace its props name, and the worker it is handed to cannot change them.
 */
export class ImageReader extends WorkerEntrypoint<Env, ImageReaderProps> {
  read(reference: string): Promise<ReadableStream<Uint8Array>> {
    return readWorkspaceImage(this.env, this.ctx.props.workspaceId, reference);
  }
}

/** One stored image of `workspaceId`; a reference naming any other workspace is refused. */
export async function readWorkspaceImage(env: Env, workspaceId: string, reference: string): Promise<ReadableStream<Uint8Array>> {
  const image = parseImageReference(reference);
  if (!image || image.workspaceId !== workspaceId) throw new Error(`Image ${reference} is not this workspace's`);
  const object = await new DriveFiles(tenantStore(env), env.ACCOUNT_ID).get(`space:${image.workspaceId}`, { blobHash: `sha256:${image.sha256}`, size: image.size });
  if (!object) throw new Error(`Image ${reference} is not stored`);
  return object.body;
}
