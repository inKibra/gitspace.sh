import { z } from 'zod';
import type { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { IMAGE_UPLOAD_TYPES, RuntimeImageUploadReplySchema } from '@gitspace/protocol-runtime/session-controls';
import { linkRequest } from './artifact-upload-rpc.js';
import { rpcClient } from './rpc-client.js';

/**
 * Stores a prompt's images in its workspace before the prompt names them (`runtime.imageUpload`, then the image's bytes
 * to its upload link), so the prompt carries each image's reference, never its bytes.
 */
export async function uploadPromptImages(identity: z.infer<typeof RuntimeIdentitySchema>, images: readonly { data: string; mimeType: string }[], send: typeof globalThis.fetch = globalThis.fetch): Promise<{ type: 'image'; data: string; mimeType: string }[]> {
  return Promise.all(images.map(async image => {
    const mimeType = z.enum(IMAGE_UPLOAD_TYPES).parse(image.mimeType);
    const bytes = Uint8Array.from(atob(image.data), character => character.charCodeAt(0));
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const begun = await rpcClient.runtime.imageUpload({ ...identity, sha256, size: bytes.byteLength, mimeType });
    if (begun.status === 'error') throw begun.error;
    const stored = await linkRequest(send, `${begun.value.link}/parts/1`, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } }, RuntimeImageUploadReplySchema, 'The image was refused');
    return { type: 'image' as const, data: stored.reference, mimeType };
  }));
}
