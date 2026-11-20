import { createRelayAuthorization, type DeviceView } from '@gitspace/protocol';
import { BROWSER_GRANT_CAPABILITIES, deviceInvitePayload, deviceProtocolBase64, decodeDeviceInviteToken, encodeDeviceInviteToken, signDeviceInvite, STEP_UP_HEADER, type DeviceInvite, type SignedDeviceInvite } from '@gitspace/protocol/device-grant';
import { accountClock, createDeviceSignedFetch, DeviceEnrollmentError, enrollDevice, type BrowserDevice } from './device.js';
import { sendSigned } from '@gitspace/protocol/server-clock';
import { currentDevice, deviceRejected } from './device-session.js';
import { requestStepUp, type StepUp } from './passkeys.js';
import { parseRecoveryKey } from './recovery-key.js';

const INVITATION_TTL_MS = 5 * 60_000;
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
  return Boolean(device?.canDelegate && view?.current && view.deviceId === device.deviceId && view.kind === 'browser' && view.active && view.scope === 'user' && BROWSER_GRANT_CAPABILITIES.every(capability => view.capabilities.includes(capability)));
}

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);
async function requestInvitation(action: 'create' | 'status' | 'cancel', payload: { invite: SignedDeviceInvite } | { inviteId: string }, signal?: AbortSignal, stepUp?: string | null): Promise<BrowserInvitationStatus> {
  const device = await currentDevice();
  if (!device) throw new DeviceEnrollmentError('NOT_ENROLLED', 'Reconnect this browser before creating an enrollment link.');
  // A browser enrolled through the platform stores https://gitspace.sh as its enrollUrl; only the account host serves these routes.
  const pageUrl = new URL(window.location.href);
  const response = await signedFetch(new URL(`/v1/devices/browser-invitations/${action}`, accountHandleFromUrl(pageUrl) ? pageUrl.origin : device.enrollUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(stepUp ? { [STEP_UP_HEADER]: stepUp } : {}) }, body: JSON.stringify({ userId: device.userId, ...payload }), signal,
  });
  const result = await response.json() as { status: 'ok'; value: BrowserInvitationStatus } | { status: 'error'; error: { code: string; message: string } };
  if (result.status === 'error') throw new DeviceEnrollmentError(result.error.code, result.error.message);
  if (!response.ok) throw new DeviceEnrollmentError('INVITATION_FAILED', `Could not ${action} the enrollment link (HTTP ${response.status}).`);
  return result.value;
}

/** A signed browser invitation not yet registered, and the step-up registering it needs (`browser-invitation.create`,
 * naming the invite). */
export interface PreparedBrowserInvitation {
  invite: SignedDeviceInvite;
  stepUp: StepUp;
}

export async function prepareBrowserInvitation(accountUrl: URL, view: DeviceView | undefined): Promise<PreparedBrowserInvitation> {
  const device = await currentDevice();
  if (!device || !canConnectBrowser(device, view)) throw new DeviceEnrollmentError('CANNOT_DELEGATE', 'This browser cannot grant full account access. Use your recovery key to connect another browser.');
  assertEnrollmentOrigin(new URL(device.enrollUrl), accountUrl);
  const now = Date.now();
  const expiresAt = now + INVITATION_TTL_MS;
  const grantTtlMs = view?.expiresAt ? Date.parse(view.expiresAt) - expiresAt : null;
  if (grantTtlMs !== null && (!Number.isFinite(grantTtlMs) || grantTtlMs <= 0)) throw new DeviceEnrollmentError('EXPIRING_DEVICE', 'This browser’s access expires too soon. Connect with your recovery key instead.');
  const invite: DeviceInvite = {
    version: 1, userId: device.userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true, issuedAt: now, expiresAt, grantTtlMs, enrollUrl: device.enrollUrl,
  };
  const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, Uint8Array.from(deviceInvitePayload(invite)))));
  return { invite: { invite, signature, issuer: { kind: 'device', deviceId: device.deviceId } }, stepUp: await requestStepUp({ purpose: 'browser-invitation.create', targets: [invite.inviteId] }) };
}

/** Registers a prepared invitation with its step-up proof (null when none is due) and answers the single-use link. */
export async function createBrowserInvitation(accountUrl: URL, prepared: PreparedBrowserInvitation, stepUp: string | null): Promise<BrowserInvitation> {
  const status = await requestInvitation('create', { invite: prepared.invite }, undefined, stepUp);
  const link = new URL('/', accountUrl);
  link.hash = new URLSearchParams({ enroll: encodeDeviceInviteToken(prepared.invite) }).toString();
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
    const root = await parseRecoveryKey(savedKey);
    savedKey = '';
    rootPrivateKey = root.privateKey;
    const { publicKey: rootPublicKey, userId } = root;
    const path = '/v1/accounts/recover';
    const rootKey = rootPrivateKey;
    const response = await sendSigned(accountClock, timestamp => fetch(new URL(path, pageUrl), {
      method: 'POST', cache: 'no-store', redirect: 'error', headers: { authorization: createRelayAuthorization(rootKey, path, timestamp), 'content-type': 'application/json' },
      body: JSON.stringify({ handle, rootPublicKey }),
    }));
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
      version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: [...BROWSER_GRANT_CAPABILITIES],
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
