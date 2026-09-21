import { credentialProtocolBase64 } from '@gitspace/protocol/credential-vault';
import { verifyRelayAuthorization } from '@gitspace/protocol/relay';
import { tenantIdSchema } from '@gitspace/protocol/deployment';
import { AccountRegistryDO, type OperatorAccountRecord } from './account-registry.js';
import { InviteRegistryDO } from './invite-registry.js';
import { operatorIdentity } from './access-auth.js';
export { AccountRegistryDO } from './account-registry.js';
export { InviteRegistryDO } from './invite-registry.js';
const REQUEST_MAX_SKEW_MS = 60_000;
const REQUEST_MAX_BYTES = 512 * 1024;
const ACCOUNT_ID_BYTES = 16;
function publicError(code: string, message: string) { return { status: 'error' as const, error: { code, message } }; }
async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > REQUEST_MAX_BYTES) throw new Error('request too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > REQUEST_MAX_BYTES) throw new Error('request too large');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
async function accountIdForRootPublicKey(rootPublicKey: string): Promise<string | null> {
  try {
    const decoded = credentialProtocolBase64.decode(rootPublicKey);
    if (decoded.byteLength !== 32) return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(decoded).buffer));
    return `u-${Array.from(digest.subarray(0, ACCOUNT_ID_BYTES), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}
function accountRegistry(env: Env) {
  const namespace = env.ACCOUNTS as DurableObjectNamespace<AccountRegistryDO>;
  return namespace.get(namespace.idFromName('global'));
}
function inviteRegistry(env: Env) {
  const namespace = env.INVITES as DurableObjectNamespace<InviteRegistryDO>;
  return namespace.get(namespace.idFromName('global'));
}
interface OperatorPlatformState {
  control: { status: 'active' | 'quarantined' | 'suspended'; reason: string | null; updatedAt: string | null };
  credits: { balanceMicros: number; reservedMicros: number; riskReserveMicros: number; status: 'active' | 'quarantined'; reason: string | null; updatedAt: string } | null;
  usage: { records: number; debitedMicros: number };
  deployment: { active: string | null; uploadedAt: string | null; appliedMigrationTag: string | null };
}
async function operatorPlatformRequest(env: Env, handle: string, init?: RequestInit): Promise<OperatorPlatformState> {
  if (!env.PLATFORM_URL || !env.PLATFORM_BOOTSTRAP_TOKEN) throw new Error('Platform operator connection is not configured');
  const response = await fetch(`${env.PLATFORM_URL.replace(/\/+$/u, '')}/__platform/operator/tenants/${encodeURIComponent(handle)}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const body = await response.json() as OperatorPlatformState | { error?: { message?: unknown } };
  if (!response.ok || !('control' in body)) {
    throw new Error('error' in body && typeof body.error?.message === 'string' ? body.error.message : `Platform operator request failed with HTTP ${response.status}`);
  }
  return body;
}
async function operatorAccountView(env: Env, account: OperatorAccountRecord) {
  const platform = await operatorPlatformRequest(env, account.handle).catch(() => null);
  return { ...account, status: account.status === 'active' ? platform?.control.status ?? account.status : account.status, reason: platform?.control.reason ?? account.reason, credits: platform?.credits ?? null, usage: platform?.usage ?? { records: 0, debitedMicros: 0 }, deployment: platform?.deployment ?? null };
}
const operatorWorker = {
 async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' || url.pathname === '/healthz') return Response.json({ status: 'ok' });
  if (url.pathname.startsWith('/distribution/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      const stable = /^\/distribution\/v1\/stable\/(?:darwin|linux)-(?:arm64|x64)\.(?:json|txt)$/u.test(url.pathname);
      const release = /^\/distribution\/v1\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:darwin|linux)-(?:arm64|x64)\/(?:gitspace|manifest\.json|runtime\.bin\.gz|provenance\.json)$/u.test(url.pathname);
      if (!stable && !release) return new Response('Not found', { status: 404 });
      const key = url.pathname.slice(1);
      const object = request.method === 'HEAD' ? await env.DISTRIBUTION.head(key) : await env.DISTRIBUTION.get(key);
      if (!object) return new Response('Not found', { status: 404 });
      const headers = new Headers({
        'content-type': key.endsWith('.json') ? 'application/json' : key.endsWith('.txt') ? 'text/plain; charset=utf-8' : key.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
        'content-length': String(object.size),
        'cache-control': stable ? 'no-cache' : 'public, max-age=31536000, immutable',
        'etag': object.httpEtag,
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      });
      return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { headers });
    }
  if (url.pathname.startsWith('/v1/operator/')) {
      const identity = await operatorIdentity(request, env);
      if (!identity) {
        return Response.json(publicError('OPERATOR_UNAUTHORIZED', 'A valid Cloudflare Access operator session is required'), {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        });
      }
      const invites = inviteRegistry(env);
      const accounts = accountRegistry(env);
      if (url.pathname === '/v1/operator/session' && request.method === 'GET') {
        return Response.json({ status: 'ok', value: { authenticated: true, email: identity.email } }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/operator/overview' && request.method === 'GET') {
        const [accountViews, inviteViews] = await Promise.all([
          Promise.all((await accounts.list()).map((account) => operatorAccountView(env, account))),
          invites.list(),
        ]);
        return Response.json({
          status: 'ok',
          value: {
            accounts: {
              total: accountViews.length,
              active: accountViews.filter((account) => account.status === 'active').length,
              attention: accountViews.filter((account) => account.status !== 'active').length,
            },
            credits: {
              configuredAccounts: accountViews.filter((account) => account.credits !== null).length,
              balanceMicros: accountViews.reduce((total, account) => total + (account.credits?.balanceMicros ?? 0), 0),
              debitedMicros: accountViews.reduce((total, account) => total + account.usage.debitedMicros, 0),
            },
            invitations: {
              available: inviteViews.filter((invite) => invite.status === 'available').length,
              consumed: inviteViews.filter((invite) => invite.status === 'consumed').length,
            },
          },
        }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/operator/accounts' && request.method === 'GET') {
        const accountViews = await Promise.all((await accounts.list()).map((account) => operatorAccountView(env, account)));
        return Response.json({ status: 'ok', value: { accounts: accountViews } }, { headers: { 'cache-control': 'no-store' } });
      }
      const accountMatch = /^\/v1\/operator\/accounts\/(u-[a-f0-9]{32})$/u.exec(url.pathname);
      if (accountMatch && request.method === 'GET') {
        const account = await accounts.get(accountMatch[1]!);
        if (!account) return Response.json(publicError('ACCOUNT_NOT_FOUND', 'Operator account record was not found'), { status: 404 });
        const [view, events] = await Promise.all([operatorAccountView(env, account), accounts.listEvents(account.userId)]);
        return Response.json({ status: 'ok', value: { account: view, events } }, { headers: { 'cache-control': 'no-store' } });
      }
      const actionMatch = /^\/v1\/operator\/accounts\/(u-[a-f0-9]{32})\/actions$/u.exec(url.pathname);
      if (actionMatch && request.method === 'POST') {
        try {
          const account = await accounts.get(actionMatch[1]!);
          if (!account) return Response.json(publicError('ACCOUNT_NOT_FOUND', 'Operator account record was not found'), { status: 404 });
          const body = await readBoundedJson(request) as { action?: unknown; reason?: unknown };
          if (body.action !== 'suspend' && body.action !== 'quarantine' && body.action !== 'restore') {
            return Response.json(publicError('INVALID_ACCOUNT_ACTION', 'Account action must be suspend, quarantine, or restore'), { status: 400 });
          }
          const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
          // Restrict locally before the remote write; a platform outage must not
          // leave direct APIs open. Restore only after the platform accepts it.
          if (body.action !== 'restore') {
            await accounts.setStatus({
              userId: account.userId,
              status: body.action === 'suspend' ? 'suspended' : 'quarantined',
              reason,
              actor: identity.email,
              action: body.action,
            });
          }
          const platform = await operatorPlatformRequest(env, account.handle, {
            method: 'POST',
            body: JSON.stringify({ action: body.action, reason }),
          });
          const updated = body.action === 'restore'
            ? await accounts.setStatus({
              userId: account.userId,
              status: platform.control.status,
              reason: platform.control.reason,
              actor: identity.email,
              action: body.action,
            })
            : await accounts.get(account.userId);
          if (!updated) throw new Error('Account disappeared during operator action');
          return Response.json({ status: 'ok', value: { account: await operatorAccountView(env, updated) } }, { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json(publicError('ACCOUNT_ACTION_FAILED', error instanceof Error ? error.message : 'Account action failed'), { status: 502 });
        }
      }
      if (url.pathname === '/v1/operator/invites' && request.method === 'GET') {
        return Response.json({ status: 'ok', value: { invites: await invites.list() } }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/operator/invites' && request.method === 'POST') {
        try {
          const body = await readBoundedJson(request) as { note?: unknown; expiresInDays?: unknown };
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 160) : '';
          const expiresInDays = body.expiresInDays === null || body.expiresInDays === undefined ? 7 : body.expiresInDays;
          if (!Number.isInteger(expiresInDays) || Number(expiresInDays) < 1 || Number(expiresInDays) > 365) {
            return Response.json(publicError('INVALID_INVITE', 'Invite expiry must be between 1 and 365 days'), { status: 400 });
          }
          const created = await invites.create({ note, expiresAt: Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000 });
          return Response.json({
            status: 'ok',
            value: {
              ...created,
              signupUrl: `https://gitspace.sh/?invite=${encodeURIComponent(created.token)}#start`,
            },
          }, { status: 201, headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json(publicError('INVALID_INVITE', error instanceof Error ? error.message : 'Invite request is invalid'), { status: 400 });
        }
      }
      const inviteMatch = /^\/v1\/operator\/invites\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (inviteMatch && request.method === 'DELETE') {
        const result = await invites.revoke(inviteMatch[1]!);
        if (!result.revoked) return Response.json(publicError('INVITE_NOT_REVOCABLE', 'Invite is missing or no longer revocable'), { status: 409 });
        return Response.json({ status: 'ok', value: result }, { headers: { 'cache-control': 'no-store' } });
      }
      return new Response('Not found', { status: 404 });
    }
  if (url.pathname === '/v1/accounts/bootstrap' && request.method === 'POST') {
    let reservation: { token: string; userId: string } | undefined;
    let accountId: string | undefined;
    try {
      const payload = await readBoundedJson(request) as { rootPublicKey?: unknown; handle?: unknown; invite?: unknown };
      if (typeof payload.rootPublicKey !== 'string' || typeof payload.handle !== 'string' || typeof payload.invite !== 'string') return Response.json(publicError('INVALID_BOOTSTRAP', 'Invitation, root key and handle are required'), { status: 400 });
      const handle = payload.handle.trim().toLowerCase();
      if (handle.length > 30 || !tenantIdSchema.safeParse(handle).success) return Response.json(publicError('INVALID_HANDLE', 'Handle is invalid or reserved'), { status: 400 });
      const userId = await accountIdForRootPublicKey(payload.rootPublicKey);
      if (!userId) return Response.json(publicError('INVALID_ROOT', 'Root key is invalid'), { status: 400 });
      const verified = verifyRelayAuthorization({ header: request.headers.get('authorization'), signingPublicKey: payload.rootPublicKey, target: url.pathname + url.search, maxSkewMs: REQUEST_MAX_SKEW_MS });
      if (verified.status === 'error') return Response.json(verified, { status: 401 });
      const invites = inviteRegistry(env);
      const reserved = await invites.reserve({ token: payload.invite.trim(), userId, handle });
      if (reserved.status === 'invalid') return Response.json(publicError('INVITE_INVALID', 'Invitation is unavailable'), { status: 403 });
      if (reserved.status === 'reserved') reservation = { token: payload.invite.trim(), userId };
      const accounts = accountRegistry(env);
      await accounts.upsertProvisioning({ userId, handle });
      accountId = userId;
      const platform = await fetch(new URL('/__platform/bootstrap/' + handle, env.PLATFORM_URL), { method: 'POST', headers: { authorization: 'Bearer ' + env.PLATFORM_BOOTSTRAP_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ rootPublicKey: payload.rootPublicKey }) });
      const deployment = await platform.json() as { deployment?: { sha: string }; error?: { message: string } };
      if (!platform.ok) throw new Error(deployment.error?.message ?? 'Provider bootstrap failed');
      const accountUrl = 'https://' + handle + '.gitspace.sh';
      if (reservation && !(await invites.consume({ ...reservation, handle })).consumed) throw new Error('Invitation consumption failed');
      reservation = undefined;
      await accounts.markActive({ userId, release: deployment.deployment?.sha ?? null });
      return Response.json({ status: 'ok', value: { userId, handle, relayUrl: `https://${handle}.gssh.dev`, accountUrl, apiUrl: accountUrl } }, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (reservation) await inviteRegistry(env).release(reservation);
      if (accountId) await accountRegistry(env).markFailed({ userId: accountId, message: error instanceof Error ? error.message : 'Bootstrap failed' });
      return Response.json(publicError('BOOTSTRAP_FAILED', error instanceof Error ? error.message : 'Bootstrap failed'), { status: 502 });
    }
  }
  if (url.pathname === '/v1/accounts/recover' && request.method === 'POST') {
    const body = await readBoundedJson(request) as { rootPublicKey?: unknown; handle?: unknown };
    if (typeof body.rootPublicKey !== 'string' || typeof body.handle !== 'string') return Response.json(publicError('INVALID_RECOVERY', 'Root key and handle are required'), { status: 400 });
    const userId = await accountIdForRootPublicKey(body.rootPublicKey);
    const verified = verifyRelayAuthorization({ header: request.headers.get('authorization'), signingPublicKey: body.rootPublicKey, target: url.pathname + url.search, maxSkewMs: REQUEST_MAX_SKEW_MS });
    if (!userId || verified.status === 'error') return Response.json(publicError('ROOT_UNAUTHORIZED', 'Recovery signature is invalid'), { status: 401 });
    const account = await accountRegistry(env).get(userId);
    if (!account || account.handle !== body.handle || account.status !== 'active') return Response.json(publicError('ACCOUNT_UNAVAILABLE', 'Account is unavailable'), { status: 403 });
    const platform = await operatorPlatformRequest(env, account.handle);
    if (platform.control.status !== 'active') return Response.json(publicError('ACCOUNT_UNAVAILABLE', 'Account is blocked'), { status: 403 });
    return Response.json({ status: 'ok', value: { userId, handle: account.handle, relayUrl: 'https://' + account.handle + '.gssh.dev', accountUrl: 'https://' + account.handle + '.gitspace.sh', apiUrl: 'https://' + account.handle + '.gitspace.sh' } });
  }
  if (request.method === 'GET' || request.method === 'HEAD') return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
 }
} satisfies ExportedHandler<Env>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/v1/accounts/bootstrap' && path !== '/v1/accounts/recover') return operatorWorker.fetch(request, env);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'cache-control': 'private, no-store' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const response = await operatorWorker.fetch(request, env);
    return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
  },
} satisfies ExportedHandler<Env>;
