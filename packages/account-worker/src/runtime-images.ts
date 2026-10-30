/**
 * A workspace's images in conversation history are drive blobs in its own scope (`space:<workspaceId>`), named in each
 * image block by a reference (`gs-image:v1:…`, `@gitspace/runtime-core/image-requests`). Content-addressed: the same
 * image stored twice is one object. They are never collected while the workspace lives and are shredded with it.
 *
 * - Clients store images before naming them (`@gitspace/protocol-runtime/image-reference`): the browser through an image
 *   upload link (`upload`), a machine through its blob store, a browser session as it saves a capture. `store` admits a
 *   reference only once it found the bytes in this workspace's scope, and measures its width and height from its header;
 *   it stores an inline image (an older client's, a cloud file read here) and returns its reference.
 * - `load` returns a stored image's block with its bytes again, for `generate_image`.
 * - Model requests and codemode scripts read images through `ImageReader` (`image-reader.ts`), never here.
 * - `url` resolves a transcript row's stored image to `/images/…`, a URL signed for a window of whole hours: the same
 *   for one image all hour, so transcript content read in parts stays one text, and valid two to three hours.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ImageContent } from '@earendil-works/pi-ai';
import { imageReference, parseImageReference } from '@gitspace/protocol-runtime/image-reference';
import { imageDimensions } from '@gitspace/runtime-core/inference';
import { DriveFiles } from './drive-files.js';
import { serveArtifactGrant } from './artifact-file-url.js';
import { tenantStore } from './tenant-store.js';

const URL_KEY_SCOPE = 'image-url:v1';
const HOUR_MS = 60 * 60_000;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_PATH = /^\/images\/([A-Za-z0-9._-]{1,128})\/([a-f0-9]{64})\/(0|[1-9][0-9]{0,11})\/(png|jpeg|webp)\/([1-9][0-9]{12})\/([A-Za-z0-9_-]{43})$/u;

/** Enough of an image to find its width and height: a JPEG's frame header can follow its metadata. */
const HEADER_BYTES = 256 * 1024;

/** The reference to a stored image, its width and height read from `header`, its first bytes. */
function measured(workspaceId: string, stored: { sha256: string; size: number }, mimeType: string, header: Uint8Array): string {
  const { width, height } = imageDimensions({ mimeType, data: Buffer.from(header).toString('base64') }) ?? { width: 0, height: 0 };
  return imageReference({ workspaceId, size: stored.size, width, height, sha256: stored.sha256 });
}

export interface StoredImages {
  /** Stores an image a client declared (`runtime.imageUpload`) and answers its reference. */
  upload(declared: { sha256: string; size: number; mimeType: string }, bytes: Uint8Array): Promise<string>;
  store(image: ImageContent): Promise<ImageContent>;
  load(image: ImageContent): Promise<ImageContent>;
}

/** One workspace's stored images; see the module comment. */
export function storedImages(env: Env, workspaceId: string): StoredImages {
  const files = new DriveFiles(tenantStore(env), env.ACCOUNT_ID);
  const scopeId = `space:${workspaceId}`;
  return {
    async upload(declared, bytes) {
      if (bytes.byteLength !== declared.size) throw new Error(`The image is ${bytes.byteLength} bytes, not the ${declared.size} declared`);
      const stored = await files.put(scopeId, bytes);
      const sha256 = stored.blobHash.slice('sha256:'.length);
      if (sha256 !== declared.sha256) throw new Error('The image does not match its declared SHA-256');
      return measured(workspaceId, { sha256, size: stored.size }, declared.mimeType, bytes.subarray(0, HEADER_BYTES));
    },
    async store(image) {
      const named = parseImageReference(image.data);
      if (named) {
        if (named.workspaceId !== workspaceId) throw new Error(`Image ${image.data} is not this workspace's`);
        const header = await files.get(scopeId, { blobHash: `sha256:${named.sha256}`, size: named.size }, { offset: 0, length: Math.min(named.size, HEADER_BYTES) });
        if (!header || header.size !== named.size) {
          await header?.body.cancel();
          throw new Error(`Image ${image.data} is not stored`);
        }
        return { ...image, data: measured(workspaceId, named, image.mimeType, await new Response(header.body).bytes()) };
      }
      const bytes = Buffer.from(image.data, 'base64');
      const stored = await files.put(scopeId, bytes);
      return { ...image, data: measured(workspaceId, { sha256: stored.blobHash.slice('sha256:'.length), size: stored.size }, image.mimeType, bytes.subarray(0, HEADER_BYTES)) };
    },
    async load(image) {
      const stored = parseImageReference(image.data);
      if (!stored) return image;
      if (stored.workspaceId !== workspaceId) throw new Error(`Image ${image.data} is not this workspace's`);
      const bytes = await files.bytes(scopeId, { blobHash: `sha256:${stored.sha256}`, size: stored.size }, stored.size);
      if (!bytes) throw new Error(`Image ${image.data} is not stored`);
      return { ...image, data: Buffer.from(bytes).toString('base64') };
    },
  };
}

export async function createRuntimeImages(env: Env, workspaceId: string) {
  const urlKey = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).scopeKey(URL_KEY_SCOPE);
  return {
    ...storedImages(env, workspaceId),
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
