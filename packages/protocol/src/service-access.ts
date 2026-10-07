import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64 } from './credential-vault.js';
import { API_KEY_PREFIX } from './device-grant.js';
const GITSPACE_BEARER = new RegExp(`^Bearer\\s+${API_KEY_PREFIX}`, 'iu');

/** Remove platform credentials without destroying the service application's login. */
export function stripGitSpaceCredentials(headers: Headers): void {
  const authorization = headers.get('authorization');
  if (authorization && (/^GitSpace(?:\s|$)/iu.test(authorization) || GITSPACE_BEARER.test(authorization))) headers.delete('authorization');
  const cookies = headers.get('cookie');
  if (cookies === null) return;
  const retained = cookies.split(';').filter(cookie => {
    const name = cookie.trim().split('=', 1)[0];
    return name !== '__Host-gitspace-service' && name !== '__Host-gitspace-service-state';
  }).map(cookie => cookie.trim()).filter(Boolean);
  if (retained.length) headers.set('cookie', retained.join('; '));
  else headers.delete('cookie');
}

export const SERVICE_ASSERTION_HEADER = 'x-gitspace-service-assertion';
/** Authenticated loopback transport metadata; never forwarded to the application. */
export const SERVICE_FORWARD_ORIGIN_HEADER = 'x-gitspace-forward-origin';
export const ServiceCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), accountId: z.string().min(1), projectId: z.string().min(1), workspaceId: z.string().min(1) }),
  z.object({ kind: z.literal('device'), accountId: z.string().min(1), deviceId: z.string().min(1) }),
]);
export type ServiceCaller = z.infer<typeof ServiceCallerSchema>;
export const ServiceAssertionBodySchema = z.object({
  version: z.literal(1), accountId: z.string().min(1), hostname: z.string().min(1), machineId: z.string().min(1),
  caller: ServiceCallerSchema, method: z.string().min(1), target: z.string().startsWith('/'),
  issuedAt: z.number().int(), expiresAt: z.number().int(), nonce: z.string().uuid(),
});
export type ServiceAssertionBody = z.infer<typeof ServiceAssertionBodySchema>;
const AssertionSchema = z.object({ body: ServiceAssertionBodySchema, signature: z.string() });
export function serviceAssertionPayload(body: ServiceAssertionBody): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ServiceAssertionBodySchema.parse(body)));
}
export async function signServiceAssertion(body: ServiceAssertionBody, key: CryptoKey): Promise<string> {
  const parsed = ServiceAssertionBodySchema.parse(body);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, Uint8Array.from(serviceAssertionPayload(parsed))));
  return credentialProtocolBase64.encode(new TextEncoder().encode(JSON.stringify({ body: parsed, signature: credentialProtocolBase64.encode(signature) })));
}
export function verifyServiceAssertion(input: { header: string | null; publicKey: string; accountId: string; machineId: string; hostname: string; method: string; target: string; now?: number }): ServiceAssertionBody | null {
  try {
    if (!input.header) return null;
    const parsed = AssertionSchema.safeParse(JSON.parse(new TextDecoder().decode(credentialProtocolBase64.decode(input.header))));
    if (!parsed.success) return null;
    const { body, signature } = parsed.data;
    const now = input.now ?? Date.now();
    if (body.accountId !== input.accountId || body.caller.accountId !== input.accountId || body.machineId !== input.machineId || body.hostname !== input.hostname || body.method !== input.method || body.target !== input.target || body.issuedAt > now + 5000 || body.expiresAt <= now || body.expiresAt - body.issuedAt > 60_000) return null;
    return ed25519.verify(credentialProtocolBase64.decode(signature), serviceAssertionPayload(body), credentialProtocolBase64.decode(input.publicKey)) ? body : null;
  } catch { return null; }
}
