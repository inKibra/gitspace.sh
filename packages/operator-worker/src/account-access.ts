import { signedControlRequestSchema, type SignedControlRequest } from '@gitspace/protocol';
import type { AccountRegistryDO, OperatorAccountRecord } from './account-registry.js';
import type { CredentialVaultDO, CredentialVaultResult } from './index.js';
/** The bearer is bound to one account, machine, and enrollment generation. */
export async function machineBrokerToken(secret: string, userId: string, machineId: string, generation: number): Promise<string> {
  if (!secret || !userId || !machineId || machineId.length > 160 || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Broker identity is invalid');
  const machine = btoa(String.fromCharCode(...new TextEncoder().encode(machineId))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const payload = `gsb2.${machine}.${generation}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${userId}\n${payload}`)));
  return `${payload}.${btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

export async function verifyMachineBrokerToken(secret: string, userId: string, authorization: string | null): Promise<{ machineId: string; generation: number } | null> {
  const token = /^Bearer (gsb2\.([A-Za-z0-9_-]{1,856})\.([1-9][0-9]{0,15}))\.([A-Za-z0-9_-]{43})$/u.exec(authorization ?? '');
  if (!secret || !token) return null;
  try {
    const generation = Number(token[3]);
    if (!Number.isSafeInteger(generation)) return null;
    const machineId = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(token[2]!.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0)));
    if (!machineId || machineId.length > 160) return null;
    const signature = Uint8Array.from(atob(token[4]!.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`${userId}\n${token[1]}`))
      ? { machineId, generation } : null;
  } catch {
    return null;
  }
}


/** The registry is required in every environment; configured platform controls can only restrict it. */
export async function activeAccount(env: Env, userId: string): Promise<CredentialVaultResult<OperatorAccountRecord>> {
  try {
    const accounts = env.ACCOUNTS as DurableObjectNamespace<AccountRegistryDO>;
    const account = await accounts.get(accounts.idFromName('global')).get(userId);
    if (!account || account.status !== 'active') {
      return { status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account is not active' } };
    }
    if (env.PLATFORM_URL) {
      if (!env.PLATFORM_BOOTSTRAP_TOKEN) throw new Error('Platform authority is not configured');
      const response = await fetch(`${env.PLATFORM_URL.replace(/\/+$/u, '')}/__platform/operator/tenants/${encodeURIComponent(account.handle)}`, {
        headers: { authorization: `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}` },
      });
      if (!response.ok) throw new Error('Platform authority is unavailable');
      const state = await response.json() as { control?: { status?: unknown }; credits?: { status?: unknown } | null };
      if (!state.control || !['active', 'suspended', 'quarantined'].includes(String(state.control.status))
        || (state.credits !== null && (!state.credits || !['active', 'quarantined'].includes(String(state.credits.status))))) {
        throw new Error('Platform authority returned invalid state');
      }
      if (state.control.status !== 'active' || state.credits?.status === 'quarantined') {
        return { status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account is blocked by the platform' } };
      }
    }
    return { status: 'ok', value: account };
  } catch {
    return { status: 'error', error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE', message: 'Account authorization authority is unavailable' } };
  }
}

export function accountAccessResponse(result: CredentialVaultResult<unknown>): Response | null {
  return result.status === 'error'
    ? Response.json(result, { status: result.error.code === 'ACCOUNT_AUTHORITY_UNAVAILABLE' ? 503 : result.error.code === 'ACCOUNT_UNAVAILABLE' ? 403 : 401, headers: { 'cache-control': 'private, no-store' } })
    : null;
}

export async function authorizeControl(env: Env, request: SignedControlRequest, capability: 'storage.provision' | 'storage.access' | 'space.control'): Promise<CredentialVaultResult<{ authorized: true }>> {
  const vaults = env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>;
  const authorized = await vaults.get(vaults.idFromName(request.userId)).authorizeControl(request, capability);
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
