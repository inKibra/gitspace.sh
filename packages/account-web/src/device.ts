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
  type DeviceBinding,
  type DeviceCapability,
  type DeviceInvite,
  type DeviceScope,
  type SignedDeviceInvite,
} from '@gitspace/protocol/device-grant';
import { ed25519 } from '@noble/curves/ed25519.js';

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

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const opened = Promise.withResolvers<IDBDatabase>();
  const openRequest = indexedDB.open(DB_NAME, 1);
  openRequest.onupgradeneeded = () => openRequest.result.createObjectStore(STORE);
  openRequest.onsuccess = () => opened.resolve(openRequest.result);
  openRequest.onerror = () => opened.reject(openRequest.error);
  const database = await opened.promise;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const request = run(database.transaction(STORE, mode).objectStore(STORE));
  request.onsuccess = () => { database.close(); resolve(request.result); };
  request.onerror = () => { database.close(); reject(request.error); };
  return promise;
}

export function loadDevice(): Promise<BrowserDevice | null> {
  return withStore<BrowserDevice | undefined>('readonly', (store) => store.get(KEY)).then((device) => device ?? null).catch(() => null);
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

/**
 * Redeem an enrollment token: generate the key pair, sign a binding to the
 * invite, and register it with the deployment named by the invite. The
 * private key never leaves WebCrypto.
 */
export async function enrollDevice(token: string): Promise<BrowserDevice> {
  const invite = decodeDeviceInviteToken(token);
  if (!invite) throw new DeviceEnrollmentError('INVALID_TOKEN', 'The enrollment link is not valid');
  if (invite.invite.expiresAt <= Date.now()) throw new DeviceEnrollmentError('EXPIRED', 'The enrollment link has expired');
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  const unsigned = { version: 1 as const, inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: publicKey, label: deviceLabel(), boundAt: Date.now() };
  const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, owned(deviceBindingPayload(unsigned)))));
  const binding: DeviceBinding = { ...unsigned, signature };
  const response = await fetch(new URL('/v1/devices/enroll', invite.invite.enrollUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite, binding } satisfies { invite: SignedDeviceInvite; binding: DeviceBinding }),
  });
  const result = await response.json() as { status: 'ok' } | { status: 'error'; error: { code: string; message: string } };
  if (result.status !== 'ok') throw new DeviceEnrollmentError(result.error.code, result.error.message);
  const device: BrowserDevice = { deviceId: unsigned.deviceId, label: unsigned.label, publicKey, keyPair, enrolledAt: unsigned.boundAt, userId: invite.invite.userId, enrollUrl: invite.invite.enrollUrl, canDelegate: invite.invite.canDelegate };
  await withStore('readwrite', (store) => store.put(device, KEY));
  return device;
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

/**
 * Mint an API client: this browser signs a delegated invite, a fresh client
 * key binds to it, the vault records the pair, and the private key is
 * returned exactly once as a `gsk_` string. Nothing here touches the root key.
 */
export async function createApiClient(device: BrowserDevice, draft: ApiClientDraft): Promise<string> {
  if (!device.canDelegate || !device.userId) throw new DeviceEnrollmentError('CANNOT_DELEGATE', 'This browser cannot create API clients; re-enroll it with a delegating link');
  const invite: DeviceInvite = {
    version: 1, userId: device.userId, inviteId: crypto.randomUUID(), kind: 'client', label: draft.label, scope: draft.scope, capabilities: draft.capabilities,
    canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 5 * 60_000, grantTtlMs: draft.ttlMs, enrollUrl: device.enrollUrl,
  };
  const inviteSignature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, owned(deviceInvitePayload(invite)))));
  const signed: SignedDeviceInvite = { invite, signature: inviteSignature, issuer: { kind: 'device', deviceId: device.deviceId } };
  const clientPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const binding = createDeviceBinding({
    inviteId: invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(clientPrivateKey)),
    label: draft.label, boundAt: Date.now(), signingPrivateKey: clientPrivateKey,
  });
  const response = await fetch(new URL('/v1/devices/enroll', device.enrollUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: signed, binding }) });
  const result = await response.json() as { status: 'ok' } | { status: 'error'; error: { code: string; message: string } };
  if (result.status !== 'ok') throw new DeviceEnrollmentError(result.error.code, result.error.message);
  return encodeApiKey({ version: 1, deviceId: binding.deviceId, signingPrivateKey: deviceProtocolBase64.encode(clientPrivateKey), rpcUrl: draft.rpcUrl, enrollUrl: device.enrollUrl });
}

/** Thrown by the signed fetch when no device is enrolled or the machine no longer accepts it. */
export class DeviceRejectedError extends Error {
  constructor(readonly code: string) {
    super(`Device rejected: ${code}`);
    this.name = 'DeviceRejectedError';
  }
}

/**
 * Fetch wrapper that signs each request with the current device. A 401 naming
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
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    const payload = rpcSignaturePayload({ deviceId: device.deviceId, timestamp, nonce, method: original.method, path: `${url.pathname}${url.search}`, body });
    const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, owned(payload))));
    const headers = new Headers(original.headers);
    headers.set(RPC_DEVICE_HEADER, encodeSignedRpcHeader({ version: 1, deviceId: device.deviceId, timestamp, nonce, signature }));
    headers.set('x-gitspace-user', device.userId);
    const response = await fetch(new Request(original.url, { method: original.method, headers, body: body.length > 0 ? body : null, signal: original.signal }));
    if (response.status === 401) {
      const failure = await response.clone().json().catch(() => null) as { error?: { code?: string } } | null;
      const code = failure?.error?.code ?? 'RPC_DEVICE_UNKNOWN';
      if (code === 'RPC_DEVICE_UNKNOWN') onRejected(code);
    }
    return response;
  };
  return signedFetch as typeof globalThis.fetch;
}
