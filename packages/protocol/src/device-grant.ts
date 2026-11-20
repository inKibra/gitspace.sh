import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { base64UrlSchema, passkeyAlgorithmSchema, verifyWebAuthnAssertion, webAuthnAssertionSchema } from './passkey.js';
import { createServerClock, sendSigned } from './server-clock.js';

/**
 * Device grants: the single authority model for every caller of a GitSpace
 * machine (browsers, API clients, later deployments).
 *
 * Trust chain:
 *   root key  ──signs──▶  invite (one-time, capabilities + scope + TTL)
 *   device key ──signs──▶ binding (invite id + device public key)
 *
 * An invite's issuer is the root key, a delegating device, or a passkey. A passkey's registration is signed by the
 * browser that enrolled it, and the passkey signs an invite with a WebAuthn assertion over the invite's hash; both
 * travel inside the invite, so every verifier checks them offline (docs/PASSKEYS-DESIGN.md).
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
  /** Mutations that change projects, workspaces, settings, or automations. */
  'rpc.write',
  /** Talk to agents: prompt and steer. Answering their questions also needs `operator.decide`. */
  'session.prompt',
  /** Create, sleep, resume, destroy machines. */
  'fleet.control',
  /** Enroll and revoke devices. */
  'devices.manage',
  /** Launch GitSpace itself from a workspace, or revert to the channel build. */
  'deployment.control',
  /** Explicit API-client authority for account credentials, inference, approval policy and review decisions. */
  'account.admin',
  /** Explicit API-client authority for execution and browser-origin approval, lifecycle recovery, cancellation and retirement. */
  'lifecycle.control',
  /** Decide as the person: answer agents, approve and accept, act on their Chrome and its shares, comment as them, file
   * and share QA reports, decide the GitHub accounts the App serves, pause or resume storage. Browsers hold it; a
   * client only when granted it. */
  'operator.decide',
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
  /** The device key the invite certifies, when the issuer named it (passkey sign-in); the binding must carry it. */
  deviceSigningPublicKey: keySchema.optional(),
});
export type DeviceInvite = z.infer<typeof deviceInviteSchema>;

/** Grant a full-access browser holds: what browser invitations, recovery and passkey sign-in hand out. */
export const BROWSER_GRANT_CAPABILITIES: readonly DeviceCapability[] = ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'];

/** A passkey enrolled on the account, as the enrolling browser signed it. */
export const passkeyRegistrationSchema = z.object({
  version: z.literal(1),
  userId: idSchema,
  credentialId: base64UrlSchema.min(16).max(1_366),
  /** COSE_Key bytes, base64url. */
  publicKey: base64UrlSchema.min(40).max(2_048),
  algorithm: passkeyAlgorithmSchema,
  label: z.string().min(1).max(160),
  /** The account host the passkey is bound to, and the page origin its ceremonies run on. */
  rpId: z.string().min(1).max(253),
  origin: z.string().url().max(2_048),
  /** Synced passkey (iCloud Keychain, Google Password Manager) rather than one bound to a single authenticator. */
  backupEligible: z.boolean(),
  /** How the browser reaches the authenticator (`internal`, `hybrid`, `usb`, `nfc`, `ble`), as it reported them. */
  transports: z.array(z.string().min(1).max(32)).max(8),
  createdAt: z.number().int().nonnegative(),
});
export type PasskeyRegistration = z.infer<typeof passkeyRegistrationSchema>;

export const signedPasskeyRegistrationSchema = z.object({
  registration: passkeyRegistrationSchema,
  /** The full-access browser that enrolled the passkey; its device key signed `registration`. */
  signer: z.object({ kind: z.literal('device'), deviceId: z.uuid() }),
  signature: z.string().min(64).max(128),
});
export type SignedPasskeyRegistration = z.infer<typeof signedPasskeyRegistrationSchema>;

/** Who signed an invite: the root key, a device whose grant allows delegation, or a registered passkey. A passkey's
 * issuer carries its registration and the assertion's authenticator and client data; the invite's `signature` is the
 * assertion signature, base64url. */
export const deviceInviteIssuerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }),
  z.object({ kind: z.literal('device'), deviceId: z.uuid() }),
  z.object({
    kind: z.literal('passkey'),
    credentialId: base64UrlSchema.min(16).max(1_366),
    registration: signedPasskeyRegistrationSchema,
    authenticatorData: webAuthnAssertionSchema.shape.authenticatorData,
    clientDataJSON: webAuthnAssertionSchema.shape.clientDataJSON,
  }),
]);
export type DeviceInviteIssuer = z.infer<typeof deviceInviteIssuerSchema>;

export const signedDeviceInviteSchema = z.object({
  invite: deviceInviteSchema,
  /** Ed25519 (root, device) base64, or a passkey's WebAuthn signature base64url, up to RSA-4096. */
  signature: z.string().min(64).max(1_024),
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

/** Signed digest admits streaming requests before reading bytes; receivers still verify the body. */
export const RPC_DEVICE_HEADER = 'x-gitspace-device';
export const signedRpcHeaderSchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  timestamp: z.number().int().nonnegative(),
  nonce: z.uuid(),
  bodySha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
  signature: z.string().min(64).max(128),
});
export type SignedRpcHeader = z.infer<typeof signedRpcHeaderSchema>;

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
  const { issuer } = parsed.data.invite;
  let invite: DeviceInvite | null;
  if (issuer.kind === 'passkey') {
    // The passkey signed this invite's hash. Its registration is judged as of its enrollment, so a passkey outlives the
    // browser that enrolled it; and nothing here reads the passkey's revocation, so devices it certified outlive it.
    // The vault refuses a revoked passkey's new certifications.
    const candidate = parsed.data.invite.invite;
    const registration = verifyPasskeyRegistration(issuer.registration, rootSigningPublicKey, resolveIssuer, depth + 1);
    const asserted = registration !== null && registration.credentialId === issuer.credentialId && registration.userId === candidate.userId
      && candidate.issuedAt >= registration.createdAt && candidate.deviceSigningPublicKey !== undefined
      && verifyWebAuthnAssertion(registration, { authenticatorData: issuer.authenticatorData, clientDataJSON: issuer.clientDataJSON, signature: parsed.data.invite.signature }, sha256(deviceInvitePayload(candidate))) !== null;
    invite = asserted ? candidate : null;
  } else {
    let issuerKey = rootSigningPublicKey;
    if (issuer.kind === 'device') {
      // A delegated grant is only as good as its issuer right now: revoking the
      // browser that minted an API key invalidates the key on the next check.
      const issuerRecord = resolveIssuer?.(issuer.deviceId) ?? null;
      const verifiedIssuer = issuerRecord ? verifyDeviceGrantRecord(issuerRecord, rootSigningPublicKey, now, resolveIssuer, depth + 1) : null;
      if (issuerRecord?.invite.invite.userId !== parsed.data.invite.invite.userId) return null;
      if (!verifiedIssuer || !verifiedIssuer.canDelegate || verifiedIssuer.deviceId !== issuer.deviceId) return null;
      if (!scopeContains(verifiedIssuer.scope, parsed.data.invite.invite.scope)) return null;
      if (!parsed.data.invite.invite.capabilities.every((capability) => deviceHasCapability(verifiedIssuer, capability))) return null;
      issuerKey = verifiedIssuer.signingPublicKey;
    }
    invite = verifyDeviceInvite(parsed.data.invite, issuerKey);
  }
  if (!invite || !verifyDeviceBinding(parsed.data.binding)) return null;
  const { binding } = parsed.data;
  if (binding.inviteId !== invite.inviteId || binding.boundAt > invite.expiresAt) return null;
  if (invite.deviceSigningPublicKey !== undefined && invite.deviceSigningPublicKey !== binding.signingPublicKey) return null;
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

/** Bytes the enrolling browser signs over a passkey registration; exported so WebCrypto callers can sign them. */
export function passkeyRegistrationPayload(registration: PasskeyRegistration): Uint8Array {
  return payload(passkeyRegistrationSchema.parse(registration));
}

/**
 * A passkey registration is trusted when its signer was a full-access, account-wide browser of the same account at the
 * registration's `createdAt`, and that browser's key signed it. Later revocation of the signer leaves the passkey: it is
 * how you get back in after losing that browser. Answers the registration, or null.
 */
export function verifyPasskeyRegistration(input: SignedPasskeyRegistration, rootSigningPublicKey: Uint8Array, resolveIssuer?: DeviceGrantResolver, depth = 0): PasskeyRegistration | null {
  const parsed = signedPasskeyRegistrationSchema.safeParse(input);
  if (!parsed.success) return null;
  const { registration, signer, signature } = parsed.data;
  const record = resolveIssuer?.(signer.deviceId) ?? null;
  const device = record?.invite.invite.userId === registration.userId ? verifyDeviceGrantRecord(record, rootSigningPublicKey, registration.createdAt, resolveIssuer, depth) : null;
  if (!device || device.deviceId !== signer.deviceId || device.kind !== 'browser' || device.scope.kind !== 'user'
    || !device.canDelegate || !deviceHasCapability(device, 'devices.manage') || device.boundAt > registration.createdAt) return null;
  try {
    return ed25519.verify(fromBase64(signature), passkeyRegistrationPayload(registration), device.signingPublicKey) ? registration : null;
  } catch {
    return null;
  }
}

/** The other record a grant's verification reads: its delegating device, or the browser that enrolled its passkey. */
export function deviceGrantDependency(record: DeviceGrantRecord): string | null {
  const { issuer } = record.invite;
  return issuer.kind === 'device' ? issuer.deviceId : issuer.kind === 'passkey' ? issuer.registration.signer.deviceId : null;
}

/**
 * Step-up (docs/PASSKEYS-DESIGN.md): a passkey assertion over a one-time challenge the vault issues for one action,
 * named by its purpose and target ids, for one signed-in browser, expiring two minutes after issue. The recovery
 * (root) key may sign the same challenge instead. `passkey.register` names the challenge of a passkey registration
 * itself, never a step-up.
 */
export const passkeyCeremonyPurposeSchema = z.enum([
  'passkey.register',
  /** Enroll another passkey; target: the registration challenge id. */
  'passkey.enroll',
  /** Revoke a passkey; target: its credential id. */
  'passkey.revoke',
  /** Register a browser invitation link; target: the invite id. */
  'browser-invitation.create',
  /** Read a secure-input request; target: the request id. */
  'secure-input.open',
  /** Answer a secure-input request with a typed or saved value; target: the request id. */
  'secure-input.answer',
]);
export type PasskeyCeremonyPurpose = z.infer<typeof passkeyCeremonyPurposeSchema>;
export type StepUpPurpose = Exclude<PasskeyCeremonyPurpose, 'passkey.register'>;

export const STEP_UP_TTL_MS = 2 * 60_000;
export const STEP_UP_HEADER = 'x-gitspace-step-up';

export const stepUpActionSchema = z.object({
  purpose: passkeyCeremonyPurposeSchema.exclude(['passkey.register']),
  targets: z.array(z.string().min(1).max(1_400)).max(4),
});
export type StepUpAction = z.infer<typeof stepUpActionSchema>;

/** What a ceremony's challenge commits to; the WebAuthn challenge is the SHA-256 of its canonical JSON. */
export const passkeyChallengeSchema = z.object({
  version: z.literal(1),
  userId: idSchema,
  challengeId: z.uuid(),
  /** The signed-in browser the challenge was issued to; only its requests may spend it. */
  deviceId: z.uuid(),
  purpose: passkeyCeremonyPurposeSchema,
  targets: stepUpActionSchema.shape.targets,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: base64UrlSchema.length(43),
});
export type PasskeyChallenge = z.infer<typeof passkeyChallengeSchema>;

/** Bytes the recovery key signs for a step-up; their SHA-256 is the WebAuthn challenge. */
export function passkeyChallengePayload(challenge: PasskeyChallenge): Uint8Array {
  return payload(passkeyChallengeSchema.parse(challenge));
}

/** `x-gitspace-step-up`: the challenge spent and its proof, base64url JSON. */
export const stepUpProofSchema = z.object({
  challengeId: z.uuid(),
  proof: z.discriminatedUnion('kind', [
    webAuthnAssertionSchema.extend({ kind: z.literal('passkey'), credentialId: base64UrlSchema.min(16).max(1_366) }),
    z.object({ kind: z.literal('root'), signature: z.string().min(64).max(128) }),
  ]),
});
export type StepUpProof = z.infer<typeof stepUpProofSchema>;

export function encodeStepUpProof(proof: StepUpProof): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(stepUpProofSchema.parse(proof))));
}

export function decodeStepUpProof(value: string): StepUpProof | null {
  try {
    const parsed = stepUpProofSchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64Url(value))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type RpcSignatureInput = Pick<SignedRpcHeader, 'deviceId' | 'timestamp' | 'nonce' | 'bodySha256'> & {
  method: string;
  /** Pathname plus search, as the machine sees it after any proxy. */
  path: string;
};

export function rpcBodySha256(body: Uint8Array): string {
  return toBase64(sha256(body));
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
    bodySha256: input.bodySha256,
  });
}

export function encodeSignedRpcHeader(header: SignedRpcHeader): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(signedRpcHeaderSchema.parse(header))));
}

export function decodeSignedRpcHeader(value: string): SignedRpcHeader | null {
  try {
    if (value.length > 2048) return null;
    const parsed = signedRpcHeaderSchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64Url(value))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Sign with a raw Ed25519 private key (Node/Bun clients); browsers use WebCrypto over `rpcSignaturePayload`. */
export function signRpcRequest(input: Omit<RpcSignatureInput, 'timestamp' | 'nonce' | 'bodySha256'> & { body: Uint8Array; signingPrivateKey: Uint8Array; timestamp?: number; nonce?: string }): string {
  return signRpcDigestRequest({ ...input, bodySha256: rpcBodySha256(input.body) });
}

/** Streaming callers compute this digest incrementally rather than collecting the body. */
export function signRpcDigestRequest(input: Omit<RpcSignatureInput, 'timestamp' | 'nonce'> & { signingPrivateKey: Uint8Array; timestamp?: number; nonce?: string }): string {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? crypto.randomUUID();
  const signature = toBase64(ed25519.sign(rpcSignaturePayload({ ...input, timestamp, nonce }), input.signingPrivateKey));
  return encodeSignedRpcHeader({ version: 1, deviceId: input.deviceId, timestamp, nonce, bodySha256: input.bodySha256, signature });
}

export function verifyRpcSignature(header: SignedRpcHeader, input: Pick<RpcSignatureInput, 'method' | 'path'> & { body: Uint8Array }, signingPublicKey: Uint8Array): boolean {
  return rpcBodySha256(input.body) === header.bodySha256 && verifyRpcDigestSignature(header, input, signingPublicKey);
}

/** Authenticate only the claimed digest. Stream receivers must check it before normal EOF. */
export function verifyRpcDigestSignature(header: SignedRpcHeader, input: Pick<RpcSignatureInput, 'method' | 'path'>, signingPublicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(fromBase64(header.signature), rpcSignaturePayload({ ...input, deviceId: header.deviceId, timestamp: header.timestamp, nonce: header.nonce, bodySha256: header.bodySha256 }), signingPublicKey);
  } catch {
    return false;
  }
}

/** The capability a procedure needs, derived from its kind unless the path is special-cased. */
export function requiredCapability(procedurePath: string, kind: 'query' | 'mutation' | 'subscription'): DeviceCapability {
  if (procedurePath === 'runtime.submit' || procedurePath === 'runtime.cancel' || procedurePath === 'runtime.answer') return 'session.prompt';
  // The command handler checks the stronger capability for each mutation.
  if (procedurePath === 'runtime.session' || procedurePath === 'runtime.services') return 'rpc.read';
  if (procedurePath.startsWith('machine.image.') && kind === 'mutation') return 'deployment.control';
  if (procedurePath.startsWith('machine.') && kind === 'mutation') return 'fleet.control';
  if (procedurePath.startsWith('devices.') && kind === 'mutation') return 'devices.manage';
  if (procedurePath.startsWith('deployment.') && kind === 'mutation') return 'deployment.control';
  return kind === 'mutation' ? 'rpc.write' : 'rpc.read';
}

/** Browsers retain their existing administrative authority and decide as the person; clients must be explicitly granted
 * either. */
export function deviceHasCapability(device: { kind: DeviceKind; scope: DeviceScope; capabilities: readonly string[] }, capability: DeviceCapability): boolean {
  return device.capabilities.includes(capability)
    || (capability === 'operator.decide' && device.kind === 'browser')
    || ((capability === 'account.admin' || capability === 'lifecycle.control')
      && device.kind === 'browser' && device.scope.kind === 'user' && device.capabilities.includes('rpc.write'));
}

export function deviceCanAdminister(device: { kind: DeviceKind; scope: DeviceScope; capabilities: readonly string[] } | undefined | null, capability: 'account.admin' | 'lifecycle.control'): boolean {
  return !!device && device.scope.kind === 'user' && device.capabilities.includes('rpc.write') && deviceHasCapability(device, capability);
}

/** Authentication adapters use this before accepting approval decisions or policy changes. */
export function requireDeviceAdministration<T extends { deviceId: string; kind: DeviceKind; scope: DeviceScope; capabilities: readonly string[] }>(device: T | undefined | null): T {
  if (!device || !deviceCanAdminister(device, 'account.admin')) throw new Error('Account administration requires account scope, rpc.write and account.admin authorization');
  return device;
}

/** Additional authorization; ordinary mutation capability is still required. */
export function requiredAdministrativeCapability(path: string, input?: unknown): 'account.admin' | 'lifecycle.control' | null {
  if (['providers.apiKey.set', 'providers.logout', 'providers.account.disable', 'providers.account.enable', 'providers.account.remove', 'providers.login.start', 'providers.login.respond', 'providers.login.cancel', 'inference.create', 'inference.update', 'inference.delete', 'inference.assign', 'inspector.workflow.waiveGate', 'inspector.guide.setApproval', 'inspector.rubric.appendJudgment'].includes(path)) return 'account.admin';
  if (['environment.approve', 'environment.revokeApproval', 'environment.cancelRun'].includes(path)) return 'lifecycle.control';
  if (path === 'environment.runPhase' && input && typeof input === 'object' && (input as Record<string, unknown>).phase === 'cloud/destroy') return 'lifecycle.control';
  return null;
}

/** Procedures and session commands that decide as the person (`operator.decide`). */
const OPERATOR_PROCEDURES: Readonly<Record<string, true>> = {
  'runtime.answer': true, 'inspector.guide.setApproval': true, 'inspector.requirement.setAcceptance': true,
  'github.request.cancel': true, 'github.installation.confirm': true, 'github.installation.uninstall': true,
  'github.uninstalled.dismiss': true, 'github.removed.clear': true, 'github.person.set': true,
  'storageIncidents.resume': true, 'storageIncidents.pause': true, 'storageIncidents.inspect': true,
};
export const OPERATOR_SESSION_COMMANDS = [
  'answerAsk', 'stageAnswer', 'browserEverything', 'browserTakeOver', 'browserResume', 'browserTabGroup', 'browserShareCreate', 'browserShareConnect',
  'browserCaptureShareCreate', 'browserCommentAdd', 'browserCommentReply', 'browserCommentResolve',
] as const;
export const OPERATOR_QA_ACTIONS = ['file', 'share'] as const;
/** Whether a call decides as the person: then the caller needs `operator.decide` beside its ordinary capability. */
export function requiresOperatorDecision(path: string, input?: unknown): boolean {
  if (OPERATOR_PROCEDURES[path]) return true;
  if (!input || typeof input !== 'object') return false;
  if (path === 'runtime.session') {
    const command = Reflect.get(input, 'command');
    const type = command && typeof command === 'object' ? Reflect.get(command, 'type') : undefined;
    return OPERATOR_SESSION_COMMANDS.some(name => name === type);
  }
  if (path === 'runtime.qa') {
    const action = Reflect.get(input, 'action');
    const kind = action && typeof action === 'object' ? Reflect.get(action, 'kind') : undefined;
    return OPERATOR_QA_ACTIONS.some(name => name === kind);
  }
  return false;
}

/** An explicit boot image changes executable deployment content, even when selecting the platform default. */
export function requiresImageSelectionControl(procedurePath: string, input: unknown): boolean {
  return procedurePath === 'machine.createSandbox' && input !== null && typeof input === 'object'
    && (input as Record<string, unknown>).image !== undefined;
}

/** Check every named target, including nested scopes, against resolved ownership. */
export function inputWithinScope(scope: DeviceScope, input: unknown, workspaceProject?: (workspaceId: string) => string | null, sessionTarget?: (sessionId: string) => { projectId: string; workspaceId: string } | null): boolean {
  if (scope.kind === 'user') return true;
  let targetFound = false;
  const projectAllowed = (projectId: string) => scope.kind === 'project' ? projectId === scope.projectId : workspaceProject?.(scope.workspaceId) === projectId;
  const workspaceAllowed = (workspaceId: string) => {
    const projectId = workspaceProject?.(workspaceId);
    return !!projectId && projectAllowed(projectId) && (scope.kind !== 'workspace' || workspaceId === scope.workspaceId);
  };
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(visit);
    const record = value as Record<string, unknown>;
    for (const [name, target] of Object.entries(record)) {
      if (typeof target === 'string' && (name === 'projectId' || name === 'workspaceId' || name === 'spaceId' || name === 'sessionId')) {
        if (name === 'projectId') {
          if (!projectAllowed(target)) return false;
          if (scope.kind === 'project') targetFound = true;
        } else if (name === 'sessionId') {
          const resolved = sessionTarget?.(target);
          if (!resolved || !projectAllowed(resolved.projectId) || !workspaceAllowed(resolved.workspaceId)) return false;
          targetFound = true;
        } else {
          if (!workspaceAllowed(target)) return false;
          targetFound = true;
        }
      } else if (!visit(target)) return false;
    }
    return true;
  };
  return visit(input) && targetFound;
}

/**
 * Signs device requests; account RPCs also require the account identity used for grant lookup.
 * Each fetch keeps one server clock so its timestamps track the account.
 */
export function createSignedRpcFetch(options: { deviceId: string; userId?: string; signingPrivateKey: Uint8Array; fetch?: typeof globalThis.fetch }): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const clock = createServerClock();
  const signedFetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const original = new Request(input, init);
    const body = new Uint8Array(await original.arrayBuffer());
    const url = new URL(original.url);
    return sendSigned(clock, (timestamp) => {
      const headers = new Headers(original.headers);
      headers.set(RPC_DEVICE_HEADER, signRpcRequest({ deviceId: options.deviceId, method: original.method, path: `${url.pathname}${url.search}`, body, signingPrivateKey: options.signingPrivateKey, timestamp }));
      if (options.userId) headers.set('x-gitspace-user', options.userId);
      return baseFetch(new Request(original.url, { method: original.method, headers, body: body.length > 0 ? body : null, signal: original.signal }));
    });
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
  version: z.literal(2),
  userId: idSchema,
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
