import { createHash } from 'node:crypto';
import { TaggedError } from 'better-result';
import { signedRpcHeaderSchema } from '@gitspace/protocol/device-grant';
import { z } from 'zod';
import { stripGitSpaceCredentials } from '@gitspace/protocol/service-access';
export const INTERNAL_NONCE = 'x-gitspace-auth-nonce';
export const INTERNAL_TIMESTAMP = 'x-gitspace-auth-timestamp';
export const INTERNAL_TUNNEL_MACHINE = 'x-gitspace-tunnel-machine';
export const INTERNAL_TUNNEL_PATH = 'x-gitspace-tunnel-path';
export const INTERNAL_SIGNED_TARGET = 'x-gitspace-signed-target';
export const INTERNAL_SERVICE_SESSION = 'x-gitspace-service-session';
export const INTERNAL_TUNNEL_BODY_PROOF = 'x-gitspace-tunnel-body-proof';

export const TUNNEL_MAX_BODY_BYTES = 64 * 1024 * 1024;
export const TunnelBodyProofSchema = z.object({ bodySha256: signedRpcHeaderSchema.shape.bodySha256, length: z.number().int().nonnegative().max(TUNNEL_MAX_BODY_BYTES) });
class TunnelBodyError extends TaggedError('TunnelBodyError')<{ message: string }> {}

/** Backpressure preserves streaming; no tee may queue an unread copy of the upload. */
export function verifiedTunnelBody(body: ReadableStream<Uint8Array>, proof: z.infer<typeof TunnelBodyProofSchema>): ReadableStream<Uint8Array> {
  const reader = body.getReader(), hash = createHash('sha256');
  let size = 0, released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          if (size !== proof.length || hash.digest('base64') !== proof.bodySha256) throw new TunnelBodyError({ message: 'Tunnel body does not match its signed digest and declared length' });
          controller.close(); release();
          return;
        }
        size += part.value.byteLength;
        if (size > proof.length || size > TUNNEL_MAX_BODY_BYTES) throw new TunnelBodyError({ message: 'Tunnel body exceeds its declared length or size limit' });
        hash.update(part.value);
        controller.enqueue(part.value);
      } catch (error) {
        if (!released) await reader.cancel(error).catch(() => {});
        release();
        throw error;
      }
    },
    async cancel(reason) {
      if (released) return;
      try { await reader.cancel(reason); } finally { release(); }
    },
  }, { highWaterMark: 0 });
}

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
  stripGitSpaceCredentials(headers);
  return new Request(request, { headers });
}

/** Tenant-owned tunnels go directly to their relay, never back through public dispatch. */
export async function forwardTunnelRequest(request: Request, env: Env, target: { machineId: string; path: string }, bodyProof?: z.infer<typeof TunnelBodyProofSchema>): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_TUNNEL_BODY_PROOF);
  if (bodyProof) headers.set(INTERNAL_TUNNEL_BODY_PROOF, JSON.stringify(bodyProof));
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
      if (cancelled) return;
      cancelled = true;
      await upload.cancel();
    },
  });
  try {
    return await stub.fetch(new Request(forwarded, { body }));
  } finally {
    cancelled = true;
    await upload.cancel().catch(() => {});
    upload.releaseLock();
  }
}
