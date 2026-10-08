import { SIGNED_REQUEST_MAX_AGE_MS, signedControlRequestSchema, type SignedControlRequest } from '@gitspace/protocol';
import type { AccountStateDO, AccountRecord, AccountAuthorization } from './account-state.js';
import type { CredentialVaultDO, CredentialVaultResult } from './application.js';

/** Tenant ownership is immutable; platform control also fences existing subscriptions. */
export async function activeAccount(env: Env, userId: string): Promise<CredentialVaultResult<AccountRecord & { authorization: Extract<AccountAuthorization, { status: 'active' }> }>> {
  if (userId !== env.ACCOUNT_ID) return { status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account does not own this tenant' } };
  try {
    const state = (env.ACCOUNT_STATE as DurableObjectNamespace<AccountStateDO>).getByName('account');
    const authority = await state.authorization(userId);
    if (authority.status === 'unavailable') return { status: 'error', error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE', message: 'Account authorization authority is unavailable' } };
    if (authority.status === 'blocked') return { status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account is blocked by the platform' } };
    const account = await state.get(userId);
    if (!account) throw new Error('Tenant identity is unavailable');
    return { status: 'ok', value: { ...account, authorization: authority } };
  } catch {
    return { status: 'error', error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE', message: 'Account authorization authority is unavailable' } };
  }
}

export function accountAccessResponse(result: CredentialVaultResult<unknown>): Response | null {
  return result.status === 'error'
    ? Response.json(result, { status: result.error.code === 'ACCOUNT_AUTHORITY_UNAVAILABLE' ? 503 : result.error.code === 'ACCOUNT_UNAVAILABLE' ? 403 : 401, headers: { 'cache-control': 'private, no-store' } })
    : null;
}

export async function authorizeControl(env: Env, request: SignedControlRequest, capability: 'storage.provision' | 'storage.access' | 'space.control' | 'credential.access' | 'credential.manage', maxAgeMs = SIGNED_REQUEST_MAX_AGE_MS): Promise<CredentialVaultResult<{ authorized: true }>> {
  const vaults = env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>;
  const authorized = await vaults.get(vaults.idFromName(request.userId)).authorizeControl(request, capability, maxAgeMs);
  if (authorized.status === 'error') return authorized;
  const account = await activeAccount(env, request.userId);
  return account.status === 'error' ? account : authorized;
}

/** Preserve the original proof, not caller-controlled user headers; recheck before every disclosure. */
export async function subscriptionIdentity(env: Env, request: Request, capability: 'storage.access' | 'space.control'): Promise<{ signed: SignedControlRequest; generation: number }> {
  const encoded = new URL(request.url).searchParams.get('control');
  if (!encoded) throw new Error('Subscription identity is missing');
  const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const signed = signedControlRequestSchema.parse(JSON.parse(atob(base64)));
  const vaults = env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>;
  const generation = await vaults.get(vaults.idFromName(signed.userId)).authorizeSubscription(signed, capability);
  if (generation === null) throw new Error('Subscription identity is no longer authorized');
  return { signed, generation };
}
export async function subscriptionActive(env: Env, socket: WebSocket, capability: 'storage.access' | 'space.control'): Promise<boolean> {
  try {
    const attachment = socket.deserializeAttachment() as { signed?: unknown; generation?: unknown } | null;
    const signed = signedControlRequestSchema.parse(attachment?.signed);
    const account = await activeAccount(env, signed.userId);
    if (account.status === 'ok') {
      const vaults = env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>;
      const generation = await vaults.get(vaults.idFromName(signed.userId)).authorizeSubscription(signed, capability);
      if (generation !== null && generation === attachment?.generation) return true;
    }
  } catch {
    // Legacy sockets without an identity and unavailable authorities fail closed.
  }
  socket.close(1008, 'Subscription authorization ended');
  return false;
}
