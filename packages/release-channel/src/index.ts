import { CHANNEL_CATALOG, CHANNEL_RELEASES_PREFIX } from '@gitspace/protocol/release-channel';

/**
 * GitSpace's published releases, read only (docs/TENANT-RELEASES-DESIGN.md §3). Every account Worker binds this Worker
 * as a service rather than the bucket: an R2 binding can also write and delete, and an account may run a Worker it built
 * itself. Serves `catalog.json` and the files under `defaults/releases/`, by key.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('The release channel is read only', { status: 405, headers: { allow: 'GET, HEAD' } });
    let key: string;
    try { key = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return new Response('Not found', { status: 404 }); }
    if (key !== CHANNEL_CATALOG && !key.startsWith(CHANNEL_RELEASES_PREFIX)) return new Response('Not found', { status: 404 });
    const object = request.method === 'HEAD' ? await env.CHANNEL.head(key) : await env.CHANNEL.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers({ etag: object.httpEtag, 'content-length': String(object.size) });
    return new Response('body' in object && object.body instanceof ReadableStream ? object.body : null, { headers });
  },
} satisfies ExportedHandler<Env>;
