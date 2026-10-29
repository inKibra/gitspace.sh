/**
 * A workspace's images in conversation history are drive blobs in its own scope (`space:<workspaceId>`), named in each
 * image block by a reference (`gs-image:v1:…`, `@gitspace/runtime-core/image-requests`). Content-addressed: the same
 * image stored twice is one object. They are never collected while the workspace lives and are shredded with it.
 *
 * - `store` writes an admitted image and returns its block naming the stored bytes; `load` returns a stored image's
 *   block with its bytes again, for a codemode script.
 * - Model requests read images through `ImageReader` in the inference worker (`inference-runner.ts`), never here.
 * - `url` resolves a transcript row's stored image to `/images/…`, a URL signed for a window of whole hours: the same
 *   for one image all hour, so transcript content read in parts stays one text, and valid two to three hours.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ImageContent } from '@earendil-works/pi-ai';
import { imageReference, parseImageReference } from '@gitspace/runtime-core/image-requests';
import { imageDimensions } from '@gitspace/runtime-core/inference';
import { DriveFiles } from './drive-files.js';
import { serveArtifactGrant } from './artifact-file-url.js';
import { tenantStore } from './tenant-store.js';

const URL_KEY_SCOPE = 'image-url:v1';
const HOUR_MS = 60 * 60_000;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_PATH = /^\/images\/([A-Za-z0-9._-]{1,128})\/([a-f0-9]{64})\/(0|[1-9][0-9]{0,11})\/(png|jpeg|webp)\/([1-9][0-9]{12})\/([A-Za-z0-9_-]{43})$/u;

export async function createRuntimeImages(env: Env, workspaceId: string) {
  const files = new DriveFiles(tenantStore(env), env.ACCOUNT_ID);
  const scopeId = `space:${workspaceId}`;
  const urlKey = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).scopeKey(URL_KEY_SCOPE);
  return {
    async store(image: ImageContent): Promise<ImageContent> {
      if (parseImageReference(image.data)) return image;
      const bytes = Buffer.from(image.data, 'base64');
      const { width, height } = imageDimensions(image) ?? { width: 0, height: 0 };
      const stored = await files.put(scopeId, bytes);
      return { ...image, data: imageReference({ workspaceId, size: stored.size, width, height, sha256: stored.blobHash.slice('sha256:'.length) }) };
    },
    async load(image: ImageContent): Promise<ImageContent> {
      const stored = parseImageReference(image.data);
      if (!stored) return image;
      if (stored.workspaceId !== workspaceId) throw new Error(`Image ${image.data} is not this workspace's`);
      const bytes = await files.bytes(scopeId, { blobHash: `sha256:${stored.sha256}`, size: stored.size }, stored.size);
      if (!bytes) throw new Error(`Image ${image.data} is not stored`);
      return { ...image, data: Buffer.from(bytes).toString('base64') };
    },
    /** `stored` is `<reference>;<mimeType>`, as a transcript row names a stored image; one this workspace cannot
     * serve stays as it is. */
    url(stored: string): string {
      const separator = stored.lastIndexOf(';');
      const image = parseImageReference(stored.slice(0, separator));
      const mimeType = stored.slice(separator + 1);
      if (!image || image.workspaceId !== workspaceId || !IMAGE_TYPES[mimeType]) return stored;
      const expiresAt = (Math.floor(Date.now() / HOUR_MS) + 3) * HOUR_MS;
      const path = `/images/${workspaceId}/${image.sha256}/${image.size}/${mimeType.slice('image/'.length)}/${expiresAt}`;
      return `${path}/${createHmac('sha256', urlKey).update(path).digest('base64url')}`;
    },
  };
}

/** `GET /images/<workspace>/<sha256>/<size>/<type>/<expiresAt>/<signature>`: a stored conversation image. */
export async function serveRuntimeImage(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const match = IMAGE_PATH.exec(pathname);
  if (!match) return new Response('Not found', { status: 404 });
  const [, workspaceId, sha256, size, type, expires, mac] = match;
  const key = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).scopeKey(URL_KEY_SCOPE);
  const expected = createHmac('sha256', key).update(pathname.slice(0, pathname.lastIndexOf('/'))).digest();
  const given = Buffer.from(mac!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) return new Response('Not found', { status: 404 });
  const expiresAt = Number(expires);
  if (expiresAt <= Date.now()) return new Response('This image link expired; reload the conversation', { status: 404 });
  const mediaType = `image/${type}`;
  return serveArtifactGrant(request, env, { scopeId: `space:${workspaceId}`, hash: `sha256:${sha256}`, size: Number(size), mediaType, name: `image.${IMAGE_TYPES[mediaType]}` }, expiresAt);
}
