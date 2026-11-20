import {
  createDeviceBinding,
  decodeDeviceInviteToken,
  deviceBindingPayload,
  deviceInvitePayload,
  deviceProtocolBase64,
  encodeApiKey,
  encodeSignedRpcHeader,
  RPC_DEVICE_HEADER,
  rpcSignaturePayload,
  rpcBodySha256,
  type DeviceBinding,
  type DeviceCapability,
  type DeviceInvite,
  type DeviceScope,
  type SignedDeviceInvite,
} from '@gitspace/protocol/device-grant';
import { createServerClock, sendSigned } from '@gitspace/protocol/server-clock';
import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';

/** This page's view of the account's clock; every browser signature is stamped with it. */
export const accountClock = createServerClock();

/**
 * This browser's device identity: a non-extractable Ed25519 key pair in
 * IndexedDB plus the id the vault knows it by. Enrolment redeems a root-signed
 * invite; afterwards every RPC request is signed with the private key and the
 * machine verifies it against its mirror of the vault.
 */
export interface BrowserDevice {
  deviceId: string;
  label: string;
  publicKey: string;
  keyPair: CryptoKeyPair;
  enrolledAt: number;
  /** From the invite: needed again when this browser delegates API clients. */
  userId: string;
  enrollUrl: string;
  canDelegate: boolean;
}

/** WebCrypto wants an ArrayBuffer it owns; noble hands back views over shared memory. */
function owned(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const DB_NAME = 'gitspace-device';
const STORE = 'device';
const KEY = 'current';

/** How long IndexedDB may take to open and answer before this browser's identity counts as unreadable for now. */
export const DEVICE_STORAGE_TIMEOUT_MS = 5_000;

/** IndexedDB did not open or did not answer in time: whether this browser holds an identity is unknown, not "no". */
export class DeviceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceStorageError';
  }
}

const STORAGE_UNAVAILABLE = 'This browser does not let GitSpace store its sign-in key. Allow website data for this site, then try again.';
const STORAGE_TIMED_OUT = 'This browser’s storage did not answer. Close other GitSpace tabs and try again; if it keeps happening, clear this site’s website data in your browser settings.';

/** Runs one request on the device store. Opening fails or stalls past DEVICE_STORAGE_TIMEOUT_MS as DeviceStorageError;
 * a failed request rejects with its own error. */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  if (typeof indexedDB === 'undefined') throw new DeviceStorageError(STORAGE_UNAVAILABLE);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const opened: { database?: IDBDatabase } = {};
  let finished = false;
  const timer = setTimeout(() => reject(new DeviceStorageError(STORAGE_TIMED_OUT)), DEVICE_STORAGE_TIMEOUT_MS);
  try {
    const openRequest = indexedDB.open(DB_NAME, 1);
    openRequest.onupgradeneeded = () => openRequest.result.createObjectStore(STORE);
    openRequest.onerror = () => reject(new DeviceStorageError(STORAGE_UNAVAILABLE));
    openRequest.onsuccess = () => {
      // An open that answers after the deadline is closed unused.
      if (finished) { openRequest.result.close(); return; }
      const database = openRequest.result;
      opened.database = database;
      try {
        const request = run(database.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) {
        reject(error);
      }
    };
  } catch {
    reject(new DeviceStorageError(STORAGE_UNAVAILABLE));
  }
  try {
    return await promise;
  } finally {
    finished = true;
    clearTimeout(timer);
    opened.database?.close();
  }
}

const storedDeviceSchema = z.object({
  deviceId: z.string().min(1), label: z.string(), publicKey: z.string(), enrolledAt: z.number(),
  userId: z.string().min(1), enrollUrl: z.string().min(1), canDelegate: z.boolean(),
  keyPair: z.object({ privateKey: z.instanceof(CryptoKey), publicKey: z.instanceof(CryptoKey) }),
});

/**
 * This browser's enrolled device, or null when it holds none. A record that does not read back as a whole device
 * with its keys is erased and answers null. Rejects with DeviceStorageError when IndexedDB does not open or answer.
 */
export async function loadDevice(): Promise<BrowserDevice | null> {
  let stored: unknown;
  try {
    stored = await withStore<unknown>('readonly', (store) => store.get(KEY));
  } catch (error) {
    if (error instanceof DeviceStorageError) throw error;
    stored = null;
  }
  if (stored === undefined) return null;
  const device = storedDeviceSchema.safeParse(stored);
  if (device.success) return device.data;
  // A record left behind is read and erased again on the next load.
  await clearDevice().catch(() => undefined);
  return null;
}

export function clearDevice(): Promise<void> {
  return withStore('readwrite', (store) => store.delete(KEY)).then(() => undefined);
}

function deviceLabel(): string {
  const hints = 'userAgentData' in navigator ? navigator.userAgentData as { brands?: Array<{ brand: string }>; platform?: string } | undefined : undefined;
  const hinted = hints?.brands?.map((entry) => entry.brand).find((name) => !/not.?a.?brand|chromium/iu.test(name));
  const sniffed = /firefox/iu.test(navigator.userAgent) ? 'Firefox' : /safari/iu.test(navigator.userAgent) && !/chrome/iu.test(navigator.userAgent) ? 'Safari' : 'Chrome';
  return `${hinted ?? sniffed} on ${hints?.platform || navigator.platform || 'unknown'}`;
}

export class DeviceEnrollmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeviceEnrollmentError';
  }
}

const enrollmentResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/** A new device identity: a non-extractable Ed25519 key pair and its public key, base64. */
export async function generateDeviceKey(): Promise<{ keyPair: CryptoKeyPair; publicKey: string }> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  return { keyPair, publicKey: deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))) };
}

/**
 * Signs a binding of `key` to `invite`, has `register` record it with the account, and keeps the enrolled device in
 * this browser. The private key never leaves WebCrypto.
 */
export async function bindDevice(key: { keyPair: CryptoKeyPair; publicKey: string }, invite: DeviceInvite, register: (binding: DeviceBinding) => Promise<Response>): Promise<BrowserDevice> {
  const unsigned = { version: 1 as const, inviteId: invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: key.publicKey, label: deviceLabel(), boundAt: Date.now() };
  const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, owned(deviceBindingPayload(unsigned)))));
  const result = enrollmentResultSchema.safeParse(await (await register({ ...unsigned, signature })).json().catch(() => null));
  if (!result.success) throw new DeviceEnrollmentError('ENROLLMENT_FAILED', 'GitSpace did not answer the enrollment');
  if (result.data.status === 'error') throw new DeviceEnrollmentError(result.data.error.code, result.data.error.message);
  const device: BrowserDevice = { deviceId: unsigned.deviceId, label: unsigned.label, publicKey: key.publicKey, keyPair: key.keyPair, enrolledAt: unsigned.boundAt, userId: invite.userId, enrollUrl: invite.enrollUrl, canDelegate: invite.canDelegate };
  await withStore('readwrite', (store) => store.put(device, KEY));
  return device;
}

/** Redeem an enrollment token: a new device key, bound to the invite and registered with the deployment it names. */
export async function enrollDevice(token: string, accountOrigin?: string): Promise<BrowserDevice> {
  const invite = decodeDeviceInviteToken(token);
  if (!invite) throw new DeviceEnrollmentError('INVALID_TOKEN', 'The enrollment link is not valid');
  if (invite.invite.expiresAt <= Date.now()) throw new DeviceEnrollmentError('EXPIRED', 'The enrollment link has expired');
  return bindDevice(await generateDeviceKey(), invite.invite, (binding) => fetch(new URL('/v1/devices/enroll', accountOrigin ?? invite.invite.enrollUrl), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite, binding } satisfies { invite: SignedDeviceInvite; binding: DeviceBinding }),
  }));
}

export interface ApiClientDraft {
  label: string;
  scope: DeviceScope;
  capabilities: DeviceCapability[];
  /** null = until revoked. */
  ttlMs: number | null;
  /** RPC endpoint baked into the key; the app's own by default. */
  rpcUrl: string;
}

/** Prepare a delegated invite without creating or enrolling a client key. */
export async function prepareApiClientInvite(device: BrowserDevice, draft: Pick<ApiClientDraft, 'label' | 'scope' | 'capabilities' | 'ttlMs'>): Promise<SignedDeviceInvite> {
  if (!device.canDelegate || !device.userId) throw new DeviceEnrollmentError('CANNOT_DELEGATE', 'This browser cannot create API clients; re-enroll it with a delegating link');
  const invite: DeviceInvite = {
    version: 1, userId: device.userId, inviteId: crypto.randomUUID(), kind: 'client', label: draft.label, scope: draft.scope, capabilities: draft.capabilities,
    canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 5 * 60_000, grantTtlMs: draft.ttlMs, enrollUrl: device.enrollUrl,
  };
  const inviteSignature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, owned(deviceInvitePayload(invite)))));
  return { invite, signature: inviteSignature, issuer: { kind: 'device', deviceId: device.deviceId } };
}

/** Mint and enroll an API client, returning its private key exactly once. */
export async function createApiClient(device: BrowserDevice, draft: ApiClientDraft, accountOrigin?: string): Promise<string> {
  const signed = await prepareApiClientInvite(device, draft);
  const { invite } = signed;
  const clientPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const binding = createDeviceBinding({
    inviteId: invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(clientPrivateKey)),
    label: draft.label, boundAt: Date.now(), signingPrivateKey: clientPrivateKey,
  });
  const response = await fetch(new URL('/v1/devices/enroll', accountOrigin ?? device.enrollUrl), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: signed, binding }) });
  const result = await response.json() as { status: 'ok' } | { status: 'error'; error: { code: string; message: string } };
  if (result.status !== 'ok') throw new DeviceEnrollmentError(result.error.code, result.error.message);
  return encodeApiKey({ version: 2, userId: device.userId, deviceId: binding.deviceId, signingPrivateKey: deviceProtocolBase64.encode(clientPrivateKey), rpcUrl: draft.rpcUrl, enrollUrl: device.enrollUrl });
}

/** Thrown by the signed fetch when no device is enrolled or the machine no longer accepts it. */
export class DeviceRejectedError extends Error {
  constructor(readonly code: string) {
    super(`Device rejected: ${code}`);
    this.name = 'DeviceRejectedError';
  }
}

/** Shared HTTP/WebSocket authentication; callers sign the exact unsigned request target. */
export async function signDeviceRequest(device: BrowserDevice, request: { method: string; path: string; body: Uint8Array }): Promise<string> {
  const timestamp = accountClock.now();
  const nonce = crypto.randomUUID();
  const bodySha256 = rpcBodySha256(request.body);
  const payload = rpcSignaturePayload({ deviceId: device.deviceId, timestamp, nonce, method: request.method, path: request.path, bodySha256 });
  const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, owned(payload))));
  return encodeSignedRpcHeader({ version: 1, deviceId: device.deviceId, timestamp, nonce, bodySha256, signature });
}

/**
 * Fetch wrapper that signs each request with the current device, re-signing once
 * with a corrected clock when the account rejects the timestamp. A 401 naming
 * the device (revoked, expired, unknown) clears the stored identity so the
 * app falls back to the enrollment screen instead of retrying forever.
 */
export function createDeviceSignedFetch(currentDevice: () => Promise<BrowserDevice | null>, onRejected: (code: string) => void): typeof globalThis.fetch {
  const signedFetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const device = await currentDevice();
    if (!device) throw new DeviceRejectedError('NOT_ENROLLED');
    const original = new Request(input, init);
    const body = new Uint8Array(await original.arrayBuffer());
    const url = new URL(original.url);
    const signed = { method: original.method, path: `${url.pathname}${url.search}`, body };
    const response = await sendSigned(accountClock, async () => {
      const headers = new Headers(original.headers);
      headers.set(RPC_DEVICE_HEADER, await signDeviceRequest(device, signed));
      headers.set('x-gitspace-user', device.userId);
      return fetch(new Request(original.url, { method: original.method, headers, body: body.length > 0 ? body : null, signal: original.signal }));
    });
    if (response.status === 401) {
      const failure = await response.clone().json().catch(() => null) as { error?: { code?: string } } | null;
      const code = failure?.error?.code;
      // A proxy/identity outage is not proof that the enrolled device was revoked.
      // Nor may a late response revoke a replacement enrolled while it was in flight.
      if (code === 'RPC_DEVICE_UNKNOWN' && (await currentDevice())?.deviceId === device.deviceId) onRejected(code);
    }
    return response;
  };
  return signedFetch as typeof globalThis.fetch;
}
