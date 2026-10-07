import { createRelayAuthorization } from '@gitspace/protocol';
import { SERVICE_FORWARD_ORIGIN_HEADER } from '@gitspace/protocol/service-access';
import { z } from 'zod';

export type ServiceForward = { url: string; headers: Record<string, string>; close(): Promise<void> };
const FORWARD_TOKEN_HEADER = 'x-gitspace-forward-token';

function upstreamHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim());
  for (const name of ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', FORWARD_TOKEN_HEADER, SERVICE_FORWARD_ORIGIN_HEADER]) headers.delete(name);
  return headers;
}

export async function openServiceForward(options: { hostname: string; fetch(request: Request): Promise<Response>; websocket?(url: URL, headers: Headers): WebSocket }): Promise<ServiceForward> {
  if (!/^[a-z0-9.-]+$/u.test(options.hostname)) throw new Error('Invalid service hostname');
  const upstreams = new Set<WebSocket>();
  const token = crypto.randomUUID() + crypto.randomUUID();
  const server = Bun.serve<{ upstream: WebSocket }>({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    const url = new URL(request.url);
    const expectedHost = `127.0.0.1:${server.port}`;
    if (request.headers.get('host') !== expectedHost || request.headers.get(FORWARD_TOKEN_HEADER) !== token) return new Response('Forward authorization required', { status: 403 });
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== `http://${expectedHost}`) return new Response('Forward Origin rejected', { status: 403 });
    const browserOrigin = request.headers.get(SERVICE_FORWARD_ORIGIN_HEADER);
    if (browserOrigin !== null) {
      const parsed = URL.parse(browserOrigin);
      if (origin === null || !parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== browserOrigin) return new Response('Forward browser Origin rejected', { status: 403 });
    }
    const headers = upstreamHeaders(request.headers);
    if (origin !== null) headers.set('origin', browserOrigin ?? `https://${options.hostname}`);
    url.protocol = 'https:'; url.hostname = options.hostname; url.port = '';
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!options.websocket) return new Response('WebSocket forwarding unavailable', { status: 400 });
      const upstream = options.websocket(url, headers);
      upstreams.add(upstream);
      upstream.binaryType = 'arraybuffer';
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { upstream.close(); reject(new Error('Service WebSocket timed out')); }, 15_000);
          upstream.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
          upstream.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Service WebSocket rejected')); }, { once: true });
        });
        if (server.upgrade(request, { data: { upstream } })) return;
      } catch { upstream.close(); upstreams.delete(upstream); return new Response('Service WebSocket rejected', { status: 502 }); }
      upstream.close(); upstreams.delete(upstream);
      return new Response('Upgrade failed', { status: 400 });
    }
    return options.fetch(new Request(url, { method: request.method, headers, body: request.body, signal: request.signal }));
  }, websocket: {
    open(socket) {
      socket.data.upstream.addEventListener('message', event => socket.send(event.data));
      socket.data.upstream.addEventListener('close', () => socket.close());
    },
    message(socket, data) { socket.data.upstream.send(typeof data === 'string' ? data : Uint8Array.from(data)); },
    close(socket) { socket.data.upstream.close(); upstreams.delete(socket.data.upstream); },
  } });
  return { url: `http://127.0.0.1:${server.port}`, headers: { [FORWARD_TOKEN_HEADER]: token }, async close() { for (const upstream of upstreams) upstream.close(); await server.stop(true); } };
}

export function createServiceAccessClient(options: { baseUrl: string; userId: string; machineId: string; signingPrivateKey: Uint8Array }) {
  async function authenticated(path: string, request?: Request): Promise<Response> {
    const url = new URL(path, options.baseUrl);
    const method = request?.method ?? 'GET';
    const headers = new Headers(request?.headers);
    headers.delete('x-gitspace-service-authorization');
    const applicationAuthorization = headers.get('authorization');
    if (applicationAuthorization) headers.set('x-gitspace-service-authorization', applicationAuthorization);
    headers.set('x-gitspace-machine', options.machineId);
    headers.set('authorization', createRelayAuthorization(options.signingPrivateKey, `${method}\n${url.pathname}${url.search}`));
    return fetch(new Request(url, { method, headers, body: request?.body, redirect: 'manual', signal: request?.signal }));
  }
  return {
    async trust() {
      const response = await authenticated('/api/services/trust');
      if (!response.ok) throw new Error(`Service trust rejected (${response.status})`);
      const trust = z.object({ accountId: z.string(), publicKey: z.string() }).parse(await response.json());
      if (trust.accountId !== options.userId) throw new Error('Service trust account mismatch');
      return trust;
    },
    async forward(hostname: string) {
      return openServiceForward({ hostname, fetch: request => authenticated(`/api/services/fetch?url=${encodeURIComponent(request.url)}`, request), websocket(service, headers) {
        const url = new URL(`/api/services/fetch?url=${encodeURIComponent(service.href)}`, options.baseUrl);
        const target = `GET\n${url.pathname}${url.search}`;
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        headers.delete('x-gitspace-service-authorization');
        const applicationAuthorization = headers.get('authorization');
        if (applicationAuthorization) headers.set('x-gitspace-service-authorization', applicationAuthorization);
        headers.set('x-gitspace-machine', options.machineId);
        headers.set('authorization', createRelayAuthorization(options.signingPrivateKey, target));
        // DOM declarations omit Bun's documented header-bearing constructor overload.
        const socket: unknown = Reflect.construct(WebSocket, [url, { headers: Object.fromEntries(headers) } satisfies Bun.WebSocketOptions]);
        if (!(socket instanceof WebSocket)) throw new Error('Bun WebSocket construction failed');
        return socket;
      } });
    },
  };
}
