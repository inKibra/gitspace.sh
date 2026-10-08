import { loadPinnedDefaultRelease, verifyDefaultObject, type DefaultReleaseReader } from '@gitspace/protocol/default-release';

export function defaultReleaseReader(bucket: R2Bucket): DefaultReleaseReader {
  return { async get(key) { const object = await bucket.get(key); return object ? { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag } : null; } };
}
/** Public immutable UI assets contain no tenant data; version selection is always explicit. */
export async function defaultFrontendResponse(request: Request, bucket: R2Bucket): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/v1\/default-releases\/([a-f0-9]{40})\/frontend\/(.*)$/u.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  try {
    const reader = defaultReleaseReader(bucket);
    const manifest = await loadPinnedDefaultRelease(reader, match[1]!);
    const path = decodeURIComponent(match[2]!) || 'index.html';
    if (path.split('/').some(part => part === '..' || part === '.')) return new Response('Not found', { status: 404 });
    const file = manifest.frontend.files.find(file => file.path === path) ?? (!/\.[a-z0-9]+$/iu.test(path) ? manifest.frontend.files.find(file => file.path === 'index.html') : undefined);
    if (!file) return new Response('Not found', { status: 404 });
    const bytes = await verifyDefaultObject(reader, file);
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { 'content-type': file.contentType, 'cache-control': 'public, max-age=31536000, immutable', 'x-gitspace-frontend-release': manifest.commit } });
  } catch { return new Response('Pinned account frontend unavailable', { status: 503 }); }
}
