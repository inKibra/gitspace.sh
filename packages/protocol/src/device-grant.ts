import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

/**
 * Device grants: the single authority model for every caller of a GitSpace
 * machine (browsers, API clients, later deployments).
 *
 * Trust chain:
 *   root key  ──signs──▶  invite (one-time, capabilities + scope + TTL)
 *   device key ──signs──▶ binding (invite id + device public key)
 *
 * The vault records the first binding per invite (first bind wins) and every
 * machine mirrors the records, so a request signed by the device key verifies
 * offline: root signature over the invite, device signature over the binding,
 * device signature over the request. The worker in the middle can withhold a
 * revocation from an offline machine, which is why grants carry a TTL.
 */

const idSchema = z.string().min(1).max(160);
const keySchema = z.string().min(40).max(64);

export const deviceCapabilitySchema = z.enum([
  /** Queries and subscriptions. */
  'rpc.read',
  /** Mutations that change projects, workspaces, settings, or crons. */
  'rpc.write',
  /** Talk to agents: prompt, steer, answer questions. */
  'session.prompt',
  /** Create, sleep, resume, destroy machines. */
  'fleet.control',
  /** Enroll and revoke devices. */
  'devices.manage',
  /** Launch GitSpace itself from a workspace, or revert to the channel build. */
  'deployment.control',
]);
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;

export const deviceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('project'), projectId: idSchema }),
  z.object({ kind: z.literal('workspace'), workspaceId: idSchema }),
]);
export type DeviceScope = z.infer<typeof deviceScopeSchema>;

export const deviceKindSchema = z.enum(['browser', 'client']);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const deviceInviteSchema = z.object({
  version: z.literal(1),
  userId: idSchema,
  inviteId: z.uuid(),
  kind: deviceKindSchema,
  label: z.string().max(160).nullable(),
  scope: deviceScopeSchema,
  capabilities: z.array(deviceCapabilitySchema).min(1),
  canDelegate: z.boolean(),
  issuedAt: z.number().int().nonnegative(),
  /** The invite itself must be redeemed before this instant. */
  expiresAt: z.number().int().positive(),
  /** Lifetime of the grant after binding; null means until revoked. */
  grantTtlMs: z.number().int().positive().nullable(),
  /** Deployment that records the binding; root-signed so an invite cannot be redirected. */
  enrollUrl: z.string().url().max(2_048),
});
export type DeviceInvite = z.infer<typeof deviceInviteSchema>;

/** Who signed an invite: the root key, or a device whose grant allows delegation. */
export const deviceInviteIssuerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }),
  z.object({ kind: z.literal('device'), deviceId: z.uuid() }),
]);
export type DeviceInviteIssuer = z.infer<typeof deviceInviteIssuerSchema>;

export const signedDeviceInviteSchema = z.object({
  invite: deviceInviteSchema,
  signature: z.string().min(64).max(128),
  issuer: deviceInviteIssuerSchema.default({ kind: 'root' }),
});
export type SignedDeviceInvite = z.infer<typeof signedDeviceInviteSchema>;

/** Delegation chains are short by construction: root → browser → client is the whole story today. */
export const MAX_DELEGATION_DEPTH = 4;

export const deviceBindingSchema = z.object({
  version: z.literal(1),
  inviteId: z.uuid(),
  deviceId: z.uuid(),
  signingPublicKey: keySchema,
  label: z.string().max(160),
  boundAt: z.number().int().nonnegative(),
  signature: z.string().min(64).max(128),
});
export type DeviceBinding = z.infer<typeof deviceBindingSchema>;

/** What the vault stores and machines mirror, one row per device. */
export const deviceGrantRecordSchema = z.object({
  invite: signedDeviceInviteSchema,
  binding: deviceBindingSchema,
  generation: z.number().int().positive(),
  revokedAt: z.number().int().positive().nullable(),
});
export type DeviceGrantRecord = z.infer<typeof deviceGrantRecordSchema>;

/** A verified, currently valid grant - the shape authorization runs on. */
export interface VerifiedDevice {
  deviceId: string;
  kind: DeviceKind;
  label: string;
  scope: DeviceScope;
  capabilities: readonly DeviceCapability[];
  canDelegate: boolean;
  signingPublicKey: Uint8Array;
  generation: number;
  boundAt: number;
  expiresAt: number | null;
}

/** Header carrying the request signature; the body hash is recomputed by the verifier. */
export const RPC_DEVICE_HEADER = 'x-gitspace-device';
export const signedRpcHeaderSchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  timestamp: z.number().int().nonnegative(),
  nonce: z.uuid(),
  signature: z.string().min(64).max(128),
});
export type SignedRpcHeader = z.infer<typeof signedRpcHeaderSchema>;
export const RPC_SIGNATURE_MAX_SKEW_MS = 2 * 60_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function payload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonical(value)));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64Url(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return fromBase64(padded);
}

export const deviceProtocolBase64 = { encode: toBase64, decode: fromBase64 } as const;

/** Bytes an issuer signs over an invite; exported so WebCrypto (browser) issuers can sign them. */
export function deviceInvitePayload(invite: DeviceInvite): Uint8Array {
  return payload(deviceInviteSchema.parse(invite));
}

export function signDeviceInvite(invite: DeviceInvite, signingPrivateKey: Uint8Array, issuer: DeviceInviteIssuer = { kind: 'root' }): SignedDeviceInvite {
  const parsed = deviceInviteSchema.parse(invite);
  return { invite: parsed, signature: toBase64(ed25519.sign(payload(parsed), signingPrivateKey)), issuer };
}

/** Signature check only; chain, delegation rights, and containment live in `verifyDeviceGrantRecord`. */
export function verifyDeviceInvite(input: SignedDeviceInvite, issuerSigningPublicKey: Uint8Array): DeviceInvite | null {
  const parsed = signedDeviceInviteSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    return ed25519.verify(fromBase64(parsed.data.signature), payload(parsed.data.invite), issuerSigningPublicKey) ? parsed.data.invite : null;
  } catch {
    return null;
  }
}

/** A parent may only hand out what it holds: user ⊇ same project ⊇ same workspace. */
export function scopeContains(parent: DeviceScope, child: DeviceScope): boolean {
  if (parent.kind === 'user') return true;
  if (parent.kind === 'project') return child.kind === 'project' && child.projectId === parent.projectId;
  return child.kind === 'workspace' && child.workspaceId === parent.workspaceId;
}

/** URL-safe token form of a signed invite, for `?enroll=<token>` and pasted client keys. */
export function encodeDeviceInviteToken(invite: SignedDeviceInvite): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(invite)));
}

export function decodeDeviceInviteToken(token: string): SignedDeviceInvite | null {
  try {
    const parsed = signedDeviceInviteSchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64Url(token))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Bytes a device signs to bind its key to an invite; exported so WebCrypto callers can sign it. */
export function deviceBindingPayload(binding: Omit<DeviceBinding, 'signature'>): Uint8Array {
  return payload(binding);
}

export function createDeviceBinding(input: Omit<DeviceBinding, 'signature' | 'version'> & { signingPrivateKey: Uint8Array }): DeviceBinding {
  const { signingPrivateKey, ...rest } = input;
  const unsigned = { version: 1 as const, ...rest };
  return deviceBindingSchema.parse({ ...unsigned, signature: toBase64(ed25519.sign(deviceBindingPayload(unsigned), signingPrivateKey)) });
}

export function verifyDeviceBinding(input: DeviceBinding): boolean {
  const parsed = deviceBindingSchema.safeParse(input);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  try {
    return ed25519.verify(fromBase64(signature), deviceBindingPayload(unsigned), fromBase64(parsed.data.signingPublicKey));
  } catch {
    return false;
  }
}

export function deviceGrantExpiresAt(record: Pick<DeviceGrantRecord, 'invite' | 'binding'>): number | null {
  return record.invite.invite.grantTtlMs === null ? null : record.binding.boundAt + record.invite.invite.grantTtlMs;
}

/**
 * Full verification of a mirrored record: root signature on the invite, the
 * binding's own signature, invite/binding agreement, and currency at `now`.
 * Returns null for anything that must not be trusted - including revoked and
 * expired grants, which callers list separately from the raw records.
 */
export type DeviceGrantResolver = (deviceId: string) => DeviceGrantRecord | null;

export function verifyDeviceGrantRecord(record: DeviceGrantRecord, rootSigningPublicKey: Uint8Array, now = Date.now(), resolveIssuer?: DeviceGrantResolver, depth = 0): VerifiedDevice | null {
  const parsed = deviceGrantRecordSchema.safeParse(record);
  if (!parsed.success || depth >= MAX_DELEGATION_DEPTH) return null;
  let issuerKey = rootSigningPublicKey;
  if (parsed.data.invite.issuer.kind === 'device') {
    // A delegated grant is only as good as its issuer right now: revoking the
    // browser that minted an API key invalidates the key on the next check.
    const issuerRecord = resolveIssuer?.(parsed.data.invite.issuer.deviceId) ?? null;
    const issuer = issuerRecord ? verifyDeviceGrantRecord(issuerRecord, rootSigningPublicKey, now, resolveIssuer, depth + 1) : null;
    if (issuerRecord?.invite.invite.userId !== parsed.data.invite.invite.userId) return null;
    if (!issuer || !issuer.canDelegate || issuer.deviceId !== parsed.data.invite.issuer.deviceId) return null;
    if (!scopeContains(issuer.scope, parsed.data.invite.invite.scope)) return null;
    if (!parsed.data.invite.invite.capabilities.every((capability) => issuer.capabilities.includes(capability))) return null;
    issuerKey = issuer.signingPublicKey;
  }
  const invite = verifyDeviceInvite(parsed.data.invite, issuerKey);
  if (!invite || !verifyDeviceBinding(parsed.data.binding)) return null;
  const { binding } = parsed.data;
  if (binding.inviteId !== invite.inviteId || binding.boundAt > invite.expiresAt) return null;
  if (parsed.data.revokedAt !== null && parsed.data.revokedAt <= now) return null;
  const expiresAt = deviceGrantExpiresAt(parsed.data);
  if (expiresAt !== null && expiresAt <= now) return null;
  return {
    deviceId: binding.deviceId,
    kind: invite.kind,
    label: binding.label,
    scope: invite.scope,
    capabilities: invite.capabilities,
    canDelegate: invite.canDelegate,
    signingPublicKey: fromBase64(binding.signingPublicKey),
    generation: parsed.data.generation,
    boundAt: binding.boundAt,
    expiresAt,
  };
}

export interface RpcSignatureInput {
  deviceId: string;
  timestamp: number;
  nonce: string;
  method: string;
  /** Pathname plus search, as the machine sees it after any proxy. */
  path: string;
  body: Uint8Array;
}

/** Bytes signed per request; exported so WebCrypto callers can sign them. */
export function rpcSignaturePayload(input: RpcSignatureInput): Uint8Array {
  return payload({
    version: 1,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    method: input.method.toUpperCase(),
    path: input.path,
    bodySha256: toBase64(sha256(input.body)),
  });
}

export function encodeSignedRpcHeader(header: SignedRpcHeader): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(signedRpcHeaderSchema.parse(header))));
}

export function decodeSignedRpcHeader(value: string): SignedRpcHeader | null {
  try {
    const parsed = signedRpcHeaderSchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64Url(value))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Sign with a raw Ed25519 private key (Node/Bun clients); browsers use WebCrypto over `rpcSignaturePayload`. */
export function signRpcRequest(input: Omit<RpcSignatureInput, 'timestamp' | 'nonce'> & { signingPrivateKey: Uint8Array; timestamp?: number; nonce?: string }): string {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? crypto.randomUUID();
  const signature = toBase64(ed25519.sign(rpcSignaturePayload({ ...input, timestamp, nonce }), input.signingPrivateKey));
  return encodeSignedRpcHeader({ version: 1, deviceId: input.deviceId, timestamp, nonce, signature });
}

export function verifyRpcSignature(header: SignedRpcHeader, input: Omit<RpcSignatureInput, 'deviceId' | 'timestamp' | 'nonce'>, signingPublicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(fromBase64(header.signature), rpcSignaturePayload({ ...input, deviceId: header.deviceId, timestamp: header.timestamp, nonce: header.nonce }), signingPublicKey);
  } catch {
    return false;
  }
}

/** The capability a procedure needs, derived from its kind unless the path is special-cased. */
export function requiredCapability(procedurePath: string, kind: 'query' | 'mutation' | 'subscription'): DeviceCapability {
  if (procedurePath === 'session.prompt' || procedurePath.startsWith('session.answer') || procedurePath === 'session.steer') return 'session.prompt';
  if (procedurePath.startsWith('machine.') && kind === 'mutation') return 'fleet.control';
  if (procedurePath.startsWith('devices.') && kind === 'mutation') return 'devices.manage';
  if (procedurePath.startsWith('deployment.') && kind === 'mutation') return 'deployment.control';
  return kind === 'mutation' ? 'rpc.write' : 'rpc.read';
}

/** Scope check on a procedure input: a scoped grant may only name its own project/workspace. */
export function inputWithinScope(scope: DeviceScope, input: unknown, workspaceProject?: (workspaceId: string) => string | null): boolean {
  if (scope.kind === 'user') return true;
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const workspaceId = [record.workspaceId, record.spaceId].find((value): value is string => typeof value === 'string') ?? null;
  const projectId = typeof record.projectId === 'string' ? record.projectId : null;
  if (scope.kind === 'workspace') return workspaceId === scope.workspaceId && (projectId === null || workspaceProject?.(workspaceId) === projectId);
  if (projectId !== null) return projectId === scope.projectId && (workspaceId === null || workspaceProject?.(workspaceId) === projectId);
  return workspaceId !== null && workspaceProject?.(workspaceId) === scope.projectId;
}

/** Fetch wrapper that signs every request with a raw Ed25519 device key (Bun/Node clients and tests). */
export function createSignedRpcFetch(options: { deviceId: string; signingPrivateKey: Uint8Array; fetch?: typeof globalThis.fetch }): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const signedFetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const original = new Request(input, init);
    const body = new Uint8Array(await original.arrayBuffer());
    const url = new URL(original.url);
    const headers = new Headers(original.headers);
    headers.set(RPC_DEVICE_HEADER, signRpcRequest({ deviceId: options.deviceId, method: original.method, path: `${url.pathname}${url.search}`, body, signingPrivateKey: options.signingPrivateKey }));
    return baseFetch(new Request(original.url, { method: original.method, headers, body: body.length > 0 ? body : null, signal: original.signal }));
  };
  // Bun's fetch type carries `preconnect`; the wrapper is only ever called.
  return signedFetch as typeof globalThis.fetch;
}

/**
 * An API key is a fully enrolled `client` device folded into one string:
 * where to call, who it is, and the private key. Shown once; revocable from
 * Settings → Devices like any other device.
 */
export const apiKeySchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  signingPrivateKey: keySchema,
  rpcUrl: z.string().url().max(2_048),
  enrollUrl: z.string().url().max(2_048),
});
export type ApiKey = z.infer<typeof apiKeySchema>;
export const API_KEY_PREFIX = 'gsk_';

export function encodeApiKey(key: ApiKey): string {
  return `${API_KEY_PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(apiKeySchema.parse(key))))}`;
}

export function decodeApiKey(value: string): ApiKey | null {
  if (!value.startsWith(API_KEY_PREFIX)) return null;
  try {
    const parsed = apiKeySchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64Url(value.slice(API_KEY_PREFIX.length)))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
