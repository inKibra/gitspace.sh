import { createRelayAuthorization, type DeviceView } from '@gitspace/protocol';
import { decodeDeviceInviteToken, deviceInvitePayload, deviceProtocolBase64, encodeDeviceInviteToken, signDeviceInvite, type DeviceCapability, type DeviceInvite, type SignedDeviceInvite } from '@gitspace/protocol/device-grant';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceSignedFetch, DeviceEnrollmentError, enrollDevice, type BrowserDevice } from './device.js';
import { currentDevice, deviceRejected } from './device-session.js';

const INVITATION_TTL_MS = 5 * 60_000;
const BROWSER_CAPABILITIES: DeviceCapability[] = ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'];
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u;
const RESERVED_HOSTS: Readonly<Record<string, true>> = { www: true, api: true, docs: true, operator: true, relay: true, app: true };

export interface BrowserInvitationStatus {
  inviteId: string;
  expiresAt: number;
  status: 'pending' | 'redeemed' | 'cancelled' | 'expired';
  deviceId: string | null;
}
export interface BrowserInvitation extends BrowserInvitationStatus { link: string }

export function accountHandleFromUrl(url: URL): string | null {
  const match = /^([a-z0-9-]+)\.gitspace\.sh$/u.exec(url.hostname);
  return match && HANDLE.test(match[1]!) && !RESERVED_HOSTS[match[1]!] ? match[1]! : null;
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function assertSecureUrl(url: URL): void {
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url)))) {
    throw new DeviceEnrollmentError('UNSAFE_ORIGIN', 'Open your account over HTTPS before connecting this browser.');
  }
}

function assertEnrollmentOrigin(enrollUrl: URL, pageUrl: URL): void {
  assertSecureUrl(pageUrl);
  assertSecureUrl(enrollUrl);
  if (enrollUrl.origin !== pageUrl.origin && enrollUrl.origin !== 'https://api.gitspace.sh' && enrollUrl.origin !== 'https://gitspace.sh') {
    throw new DeviceEnrollmentError('UNSAFE_ORIGIN', 'This enrollment link points to a different deployment. Open a link from your account.');
  }
}

/** Reject cross-account links before generating or storing a browser identity. */
export function enrollmentTokenForLocation(value: string, pageUrl: URL): string {
  let token = value.trim();
  if (/^[a-z][a-z\d+.-]*:/iu.test(token)) {
    const link = new URL(token);
    assertSecureUrl(link);
    if (link.origin !== pageUrl.origin) throw new DeviceEnrollmentError('ACCOUNT_MISMATCH', 'Open this link on the account hostname it was created for.');
    token = new URLSearchParams(link.hash.slice(1)).get('enroll') ?? link.searchParams.get('enroll') ?? '';
  }
  const invite = decodeDeviceInviteToken(token);
  if (!invite || invite.invite.kind !== 'browser') throw new DeviceEnrollmentError('INVALID_TOKEN', 'Enter a browser enrollment link from a connected browser.');
  assertEnrollmentOrigin(new URL(invite.invite.enrollUrl), pageUrl);
  return token;
}

export function canConnectBrowser(device: BrowserDevice | null, view: DeviceView | undefined): boolean {
  return Boolean(device?.canDelegate && view?.current && view.deviceId === device.deviceId && view.kind === 'browser' && view.active && view.scope === 'user' && BROWSER_CAPABILITIES.every(capability => view.capabilities.includes(capability)));
}

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);
async function requestInvitation(action: 'create' | 'status' | 'cancel', payload: { invite: SignedDeviceInvite } | { inviteId: string }, signal?: AbortSignal): Promise<BrowserInvitationStatus> {
  const device = await currentDevice();
  if (!device) throw new DeviceEnrollmentError('NOT_ENROLLED', 'Reconnect this browser before creating an enrollment link.');
  const response = await signedFetch(new URL(`/v1/devices/browser-invitations/${action}`, device.enrollUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: device.userId, ...payload }), signal,
  });
  const result = await response.json() as { status: 'ok'; value: BrowserInvitationStatus } | { status: 'error'; error: { code: string; message: string } };
  if (result.status === 'error') throw new DeviceEnrollmentError(result.error.code, result.error.message);
  if (!response.ok) throw new DeviceEnrollmentError('INVITATION_FAILED', `Could not ${action} the enrollment link (HTTP ${response.status}).`);
  return result.value;
}

export async function createBrowserInvitation(accountUrl: URL, view: DeviceView | undefined): Promise<BrowserInvitation> {
  const device = await currentDevice();
  if (!device || !canConnectBrowser(device, view)) throw new DeviceEnrollmentError('CANNOT_DELEGATE', 'This browser cannot grant full account access. Use your recovery key to connect another browser.');
  assertEnrollmentOrigin(new URL(device.enrollUrl), accountUrl);
  const now = Date.now();
  const expiresAt = now + INVITATION_TTL_MS;
  const grantTtlMs = view?.expiresAt ? Date.parse(view.expiresAt) - expiresAt : null;
  if (grantTtlMs !== null && (!Number.isFinite(grantTtlMs) || grantTtlMs <= 0)) throw new DeviceEnrollmentError('EXPIRING_DEVICE', 'This browser’s access expires too soon. Connect with your recovery key instead.');
  const invite: DeviceInvite = {
    version: 1, userId: device.userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: BROWSER_CAPABILITIES, canDelegate: true, issuedAt: now, expiresAt, grantTtlMs, enrollUrl: device.enrollUrl,
  };
  const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, Uint8Array.from(deviceInvitePayload(invite)))));
  const signed: SignedDeviceInvite = { invite, signature, issuer: { kind: 'device', deviceId: device.deviceId } };
  const status = await requestInvitation('create', { invite: signed });
  const link = new URL('/', accountUrl);
  link.hash = new URLSearchParams({ enroll: encodeDeviceInviteToken(signed) }).toString();
  return { ...status, link: link.toString() };
}

export function browserInvitationStatus(inviteId: string, signal?: AbortSignal): Promise<BrowserInvitationStatus> {
  return requestInvitation('status', { inviteId }, signal);
}
export function cancelBrowserInvitation(inviteId: string): Promise<BrowserInvitationStatus> {
  return requestInvitation('cancel', { inviteId });
}

/** Root bytes exist only for the recovery request and one browser invitation. */
export async function recoverAccountBrowser(handleInput: string, recoveryInput: string, pageUrl: URL): Promise<BrowserDevice> {
  let rootPrivateKey: Uint8Array | null = null;
  let savedKey = recoveryInput.trim();
  recoveryInput = '';
  try {
    assertSecureUrl(pageUrl);
    const inferred = accountHandleFromUrl(pageUrl);
    if (!inferred && !isLoopback(pageUrl) && pageUrl.origin !== 'https://gitspace.sh' && pageUrl.origin !== 'https://api.gitspace.sh') throw new DeviceEnrollmentError('UNSAFE_ORIGIN', 'Open your account at https://your-handle.gitspace.sh to use a recovery key.');
    const handle = handleInput.trim().toLowerCase();
    if (!HANDLE.test(handle)) throw new DeviceEnrollmentError('INVALID_HANDLE', 'Use 1 to 30 lowercase letters, numbers, or hyphens for your account handle.');
    if (inferred && handle !== inferred) throw new DeviceEnrollmentError('ACCOUNT_MISMATCH', 'The recovery handle must match this account hostname.');
    if (!/^gsr_[A-Za-z0-9_-]{43}$/u.test(savedKey)) throw new DeviceEnrollmentError('INVALID_RECOVERY', 'Enter the complete recovery key beginning with gsr_.');
    rootPrivateKey = deviceProtocolBase64.decode(`${savedKey.slice(4).replaceAll('-', '+').replaceAll('_', '/')}=`);
    if (`gsr_${deviceProtocolBase64.encode(rootPrivateKey).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}` !== savedKey) {
      throw new DeviceEnrollmentError('INVALID_RECOVERY', 'The recovery key is invalid.');
    }
    savedKey = '';
    const publicBytes = ed25519.getPublicKey(rootPrivateKey);
    const rootPublicKey = deviceProtocolBase64.encode(publicBytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(publicBytes)));
    const userId = `u-${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const path = '/v1/accounts/recover';
    const response = await fetch(new URL(path, pageUrl), {
      method: 'POST', cache: 'no-store', redirect: 'error', headers: { authorization: createRelayAuthorization(rootPrivateKey, path), 'content-type': 'application/json' },
      body: JSON.stringify({ handle, rootPublicKey }),
    });
    const result = await response.json() as { status: 'ok'; value: { userId: string; handle: string; accountUrl: string; apiUrl: string } } | { status: 'error'; error: { code: string; message: string } };
    if (result.status === 'error') throw new DeviceEnrollmentError(result.error.code, result.error.message);
    if (!response.ok) throw new DeviceEnrollmentError('RECOVERY_FAILED', `Account recovery failed (HTTP ${response.status}).`);
    const accountUrl = new URL(result.value.accountUrl);
    assertSecureUrl(accountUrl);
    if (result.value.userId !== userId || result.value.handle !== handle || accountUrl.origin !== `https://${handle}.gitspace.sh` || (inferred && accountUrl.origin !== pageUrl.origin)) {
      throw new DeviceEnrollmentError('ACCOUNT_MISMATCH', 'The recovery key does not match this account.');
    }
    assertEnrollmentOrigin(new URL(result.value.apiUrl), pageUrl);
    const now = Date.now();
    const signed = signDeviceInvite({
      version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: BROWSER_CAPABILITIES,
      canDelegate: true, issuedAt: now, expiresAt: now + INVITATION_TTL_MS, grantTtlMs: null, enrollUrl: result.value.apiUrl,
    }, rootPrivateKey);
    rootPrivateKey.fill(0);
    rootPrivateKey = null;
    return await enrollDevice(encodeDeviceInviteToken(signed), inferred ? pageUrl.origin : undefined);
  } finally {
    rootPrivateKey?.fill(0);
    savedKey = '';
    recoveryInput = '';
  }
}
