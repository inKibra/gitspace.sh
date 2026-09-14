export const INTERNAL_NONCE = 'x-gitspace-auth-nonce';
export const INTERNAL_TIMESTAMP = 'x-gitspace-auth-timestamp';
export const INTERNAL_TUNNEL_MACHINE = 'x-gitspace-tunnel-machine';
export const INTERNAL_TUNNEL_PATH = 'x-gitspace-tunnel-path';
export const INTERNAL_SIGNED_TARGET = 'x-gitspace-signed-target';

const ENDPOINT_ID = /^[A-Za-z0-9._-]{1,128}$/u;

export function tunnelTarget(url: URL): { machineId: string; path: string } | null {
  const match = /^\/tunnel\/([^/]+)(\/.*)?$/u.exec(url.pathname);
  if (!match) return null;
  const machineId = decodeURIComponent(match[1]!);
  if (!ENDPOINT_ID.test(machineId)) return null;
  return { machineId, path: `${match[2] ?? '/'}${url.search}` };
}

export function relayRequest(request: Request, authorization: { nonce: string; timestamp: number }, headers: Headers): Request {
  headers.set(INTERNAL_NONCE, authorization.nonce);
  headers.set(INTERNAL_TIMESTAMP, String(authorization.timestamp));
  headers.delete('authorization');
  return new Request(request, { headers });
}

/** Tenant-owned tunnels go directly to their relay, never back through public dispatch. */
export async function forwardTunnelRequest(request: Request, env: Env, target: { machineId: string; path: string }): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_TUNNEL_MACHINE, target.machineId);
  headers.set(INTERNAL_TUNNEL_PATH, target.path);
  headers.set(INTERNAL_SIGNED_TARGET, request.headers.get(INTERNAL_SIGNED_TARGET) ?? `${url.pathname}${url.search}`);
  const forwarded = relayRequest(request, { nonce: crypto.randomUUID(), timestamp: Date.now() }, headers);
  const stub = env.RELAY.getByName(env.RELAY_NAME);
  if (!forwarded.body) return stub.fetch(forwarded);
  // DO request cancellation does not propagate through a service binding's upload.
  // Retain the incoming reader so an early relay response also stops the caller's upload.
  const upload = forwarded.body.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await upload.read();
      if (cancelled) return;
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel() {
      cancelled = true;
      await upload.cancel();
    },
  });
  try {
    return await stub.fetch(new Request(forwarded, { body }));
  } finally {
    await upload.cancel().catch(() => {});
    upload.releaseLock();
  }
}
