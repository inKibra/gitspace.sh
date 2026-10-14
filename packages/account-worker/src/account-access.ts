import { CONTROL_SOCKET_PROTOCOL, SIGNED_REQUEST_MAX_AGE_MS, signedControlRequestSchema, socketProtocolProof, type ControlOperation, type SignedControlRequest } from '@gitspace/protocol';
import { z } from 'zod';
import type { AccountRecord, AccountAuthorization } from './account-state.js';
import type { CredentialVaultResult } from './application.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, deviceAuthority, deviceAuthorityUnavailable, withDeviceAuthority, type DeviceAuthorityView, type MachineCapability } from './device-authority.js';

export type ActiveAccount = AccountRecord & { authorization: Extract<AccountAuthorization, { status: 'active' }> };

/** Tenant ownership is immutable; platform control also fences existing subscriptions. */
export function accountStatus(env: Env, view: DeviceAuthorityView, userId: string): CredentialVaultResult<ActiveAccount> {
  if (userId !== env.ACCOUNT_ID) return { status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account does not own this tenant' } };
  const { authorization, record } = view.account;
  if (authorization.status === 'blocked') return { status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account is blocked by the platform' } };
  if (authorization.status === 'unavailable' || !record) return { status: 'error', error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE', message: 'Account authorization authority is unavailable' } };
  return { status: 'ok', value: { ...record, authorization } };
}

/** The account state read with the isolate's device authority; never a per-request object call. */
export async function activeAccount(env: Env, userId: string): Promise<CredentialVaultResult<ActiveAccount>> {
  const view = await deviceAuthority(env).current();
  return view ? accountStatus(env, view, userId) : deviceAuthorityUnavailable();
}

export function accountAccessResponse(result: CredentialVaultResult<unknown>): Response | null {
  if (result.status === 'ok') return null;
  const { code } = result.error;
  const status = code === 'ACCOUNT_AUTHORITY_UNAVAILABLE' || code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : code === 'ACCOUNT_UNAVAILABLE' ? 403 : 401;
  return Response.json(result, { status, headers: { 'cache-control': 'private, no-store' } });
}

/** A machine's signed control request, checked against the cached registry, then the account. */
export function authorizeControl(env: Env, request: SignedControlRequest, capability: MachineCapability, maxAgeMs = SIGNED_REQUEST_MAX_AGE_MS): Promise<CredentialVaultResult<{ machineId: string; generation: number }>> {
  return withDeviceAuthority(env, (view, now) => {
    const authorized = view.authorizeControl(request, capability, maxAgeMs, now);
    if (authorized.status === 'error') return authorized;
    const account = accountStatus(env, view, request.userId);
    return account.status === 'error' ? { ...account, miss: false } : authorized;
  });
}

/** A control stream admitted at `generation` lives while that credential and the account stay current. */
export async function controlSubscriptionActive(env: Env, signed: SignedControlRequest, generation: number, capability: MachineCapability): Promise<boolean> {
  const view = await deviceAuthority(env).current();
  return view !== null && accountStatus(env, view, signed.userId).status === 'ok'
    && view.controlSubscription({ userId: signed.userId, machineId: signed.machineId, generation }, capability, Date.now());
}

const subscriptionAttachmentSchema = z.object({ signed: signedControlRequestSchema, generation: z.number().int() });
export type SubscriptionAttachment = z.infer<typeof subscriptionAttachmentSchema>;

/** Admits a socket whose signed control request rides in `Sec-WebSocket-Protocol`, never in the URL. */
export async function subscriptionIdentity(env: Env, request: Request, operation: ControlOperation, capability: MachineCapability): Promise<Response | { protocol: string; attachment: SubscriptionAttachment }> {
  const offered = socketProtocolProof(request.headers.get('sec-websocket-protocol'), CONTROL_SOCKET_PROTOCOL);
  let signed: SignedControlRequest | null = null;
  try {
    const proof = offered?.proof ?? '';
    signed = signedControlRequestSchema.parse(JSON.parse(atob(proof.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(proof.length / 4) * 4, '='))));
  } catch {
    // Reported below as a missing identity.
  }
  if (!offered || signed?.operation !== operation) {
    return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: 'Signed subscription identity is missing or invalid' } }, { status: 400, headers: { 'cache-control': 'private, no-store' } });
  }
  const authorized = await authorizeControl(env, signed, capability);
  if (authorized.status === 'error') return accountAccessResponse(authorized)!;
  return { protocol: offered.protocol, attachment: { signed, generation: authorized.value.generation } };
}

/** Rechecked on ping and before every delivery; a revoked or replaced credential closes the socket. */
export async function subscriptionActive(env: Env, socket: WebSocket, capability: MachineCapability): Promise<boolean> {
  const attachment = subscriptionAttachmentSchema.safeParse(socket.deserializeAttachment());
  if (attachment.success && await controlSubscriptionActive(env, attachment.data.signed, attachment.data.generation, capability)) return true;
  socket.close(1008, 'Subscription authorization ended');
  return false;
}
