import { credentialProtocolBase64 } from '@gitspace/protocol/credential-vault';
import { verifyRelayAuthorization } from '@gitspace/protocol/relay';
import { platformDeployRequestSchema, platformRevertRequestSchema, tenantIdSchema } from '@gitspace/protocol/deployment';
import { CloudflareR2PlatformClient } from './storage-provider.js';
import { CreditLedgerDO, isCreditLedgerRecord, type CreditLedgerRecord } from './credit-ledger.js';
import { deployChannelTenant, deployTenantWorker, revertTenantWorker, type DeployResult } from './deployer.js';
import { TenantControlDO } from './tenant-control.js';

export { CreditLedgerDO } from './credit-ledger.js';
export { TenantDeploymentsDO } from './tenant-deployments.js';
export { TenantControlDO } from './tenant-control.js';

const CREDIT_ADMIN_PATH = /^\/__platform\/credits\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u;
const TOKEN_ADMIN_PATH = /^\/__platform\/admin\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/token$/u;
const TENANT_DEPLOY_PATH = /^\/__platform\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/(deploy|revert)$/u;
const TENANT_BOOTSTRAP_PATH = /^\/__platform\/bootstrap\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u;
const OPERATOR_TENANT_PATH = /^\/__platform\/operator\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u;
const OPERATOR_TENANT_ACCESS_PATH = /^\/__platform\/operator\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/access$/u;
const OPERATOR_DEPLOY_PATH = /^\/__platform\/operator\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/(deploy|revert)$/u;

interface TenantDispatchTarget {
  tenant: string;
  service: boolean;
}

function tenantFromHostname(hostname: string, suffix: string): TenantDispatchTarget | null {
  const normalized = hostname.toLowerCase();
  const expectedSuffix = suffix.toLowerCase();
  if (!normalized.endsWith(expectedSuffix)) return null;
  const label = normalized.slice(0, -expectedSuffix.length);
  const service = /^.+--.+--([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)-srv$/u.exec(label);
  if (service) return tenantIdSchema.safeParse(service[1]).success ? { tenant: service[1]!, service: true } : null;
  return tenantIdSchema.safeParse(label).success ? { tenant: label, service: false } : null;
}

function platformError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}


/** Signed admin request (ed25519 over method target) + single-use nonce per tenant; null when authorized. */
async function authorizeAdmin(request: Request, env: Env, tenant: string): Promise<Response | null> {
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  const authorization = verifyRelayAuthorization({
    header: request.headers.get('authorization'),
    signingPublicKey: env.ADMIN_PUBLIC_KEY,
    target,
    maxSkewMs: Number(env.ADMIN_AUTH_MAX_SKEW_MS),
  });
  if (authorization.status === 'error') return platformError(401, 'ADMIN_UNAUTHORIZED', authorization.error.message);

  const credits = env.CREDITS.getByName(tenant);
  if (!await credits.consumeAdminNonce(authorization.value.nonce, authorization.value.timestamp, Number(env.ADMIN_AUTH_MAX_SKEW_MS))) {
    return platformError(401, 'ADMIN_REPLAY', 'Administrative authorization was already used');
  }
  return null;
}
async function accountIdForRoot(rootPublicKey: string): Promise<string> {
  const key = credentialProtocolBase64.decode(rootPublicKey);
  if (key.byteLength !== 32) throw new Error('Tenant root key is invalid');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(key).buffer));
  return `u-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function deploymentAccess(env: Env, tenant: string): Promise<Response | null> {
  try {
    const control = await env.TENANT_CONTROL.getByName(tenant).get();
    if (control.status !== 'active') {
      return platformError(423, 'TENANT_UNAVAILABLE', 'Tenant is suspended or quarantined');
    }
    return null;
  } catch {
    return platformError(503, 'TENANT_AUTHORITY_UNAVAILABLE', 'Tenant authorization authority is unavailable');
  }
}
async function handleTenantBootstrap(request: Request, env: Env, tenant: string): Promise<Response> {
  if (request.method !== 'POST') return platformError(405, 'METHOD_NOT_ALLOWED', 'Tenant bootstrap supports POST');
  if (!env.PLATFORM_BOOTSTRAP_TOKEN || request.headers.get('authorization') !== 'Bearer ' + env.PLATFORM_BOOTSTRAP_TOKEN) return platformError(401, 'BOOTSTRAP_UNAUTHORIZED', 'Bootstrap authorization is required');
  if (!tenantIdSchema.safeParse(tenant).success) return platformError(400, 'INVALID_TENANT', 'Tenant name is invalid or reserved');
  try {
    const body = await request.json() as { rootPublicKey?: unknown };
    if (typeof body.rootPublicKey !== 'string') return platformError(400, 'INVALID_BOOTSTRAP', 'Root public key is required');
    const accountId = await accountIdForRoot(body.rootPublicKey);
    const blobBucket = 'gsp-relay-' + accountId;
    const denied = await deploymentAccess(env, tenant);
    if (denied) return denied;
    const deployments = env.DEPLOYMENTS.getByName(tenant);
    await deployments.configure(body.rootPublicKey, blobBucket);
    const storage = new CloudflareR2PlatformClient({ accountId: env.CF_ACCOUNT_ID, apiToken: env.R2_API_TOKEN, parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID });
    await storage.ensureBucket({ bucketName: blobBucket });
    await deployments.providerToken();
    const current = await deployments.getState();
    const deployed: DeployResult = current.active ? { status: 'ok', value: { sha: current.active.sha, healthy: current.active.healthy, revertedTo: null, appliedMigrationTag: current.appliedMigrationTag } } : await deployChannelTenant(env, tenant);
    if (deployed.status === 'error') return platformError(deployed.error.status, deployed.error.code, deployed.error.message);
    return Response.json({ tenant, relayUrl: 'https://' + tenant + env.TENANT_HOST_SUFFIX, accountUrl: 'https://' + tenant + '.gitspace.sh', deployment: deployed.value });
  } catch (error) { return platformError(409, 'TENANT_PROVISIONING_FAILED', error instanceof Error ? error.message : 'Tenant provisioning failed'); }
}


async function handleCreditAdmin(request: Request, env: Env, tenant: string): Promise<Response> {
  const unauthorized = await authorizeAdmin(request, env, tenant);
  if (unauthorized) return unauthorized;
  const credits = env.CREDITS.getByName(tenant);

  if (request.method === 'GET') {
    return Response.json({ account: await credits.getAccount(), ledger: await credits.listLedger() });
  }
  if (request.method !== 'POST') return platformError(405, 'METHOD_NOT_ALLOWED', 'Credit admin supports GET and POST');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return platformError(400, 'INVALID_ADMIN_REQUEST', 'Administrative request must be JSON');
  }
  if (!body || typeof body !== 'object' || !('action' in body) || typeof body.action !== 'string') {
    return platformError(400, 'INVALID_ADMIN_REQUEST', 'Administrative action is required');
  }

  if (body.action === 'configure') {
    if (!('balanceMicros' in body) || !('riskReserveMicros' in body)
      || typeof body.balanceMicros !== 'number' || typeof body.riskReserveMicros !== 'number') {
      return platformError(400, 'INVALID_ADMIN_REQUEST', 'Configure requires numeric balanceMicros and riskReserveMicros');
    }
    return Response.json(await credits.configure({
      balanceMicros: body.balanceMicros,
      riskReserveMicros: body.riskReserveMicros,
    }));
  }
  if (body.action === 'usage') {
    if (!('record' in body) || !isCreditLedgerRecord(body.record)) {
      return platformError(400, 'INVALID_ADMIN_REQUEST', 'Usage ledger record is malformed');
    }
    return Response.json(await credits.applyUsage(body.record));
  }
  if (body.action === 'quarantine') {
    if (!('reason' in body) || typeof body.reason !== 'string') {
      return platformError(400, 'INVALID_ADMIN_REQUEST', 'Quarantine requires a reason');
    }
    return Response.json(await credits.quarantine(body.reason));
  }
  return platformError(400, 'INVALID_ADMIN_REQUEST', `Unknown credit action ${body.action}`);
}

/** Mints (or rotates) the bearer token the tenant worker presents to `/deploy` and `/revert`; shown once. */
async function handleTokenAdmin(request: Request, env: Env, tenant: string): Promise<Response> {
  if (request.method !== 'POST') return platformError(405, 'METHOD_NOT_ALLOWED', 'Token admin supports POST');
  const unauthorized = await authorizeAdmin(request, env, tenant);
  if (unauthorized) return unauthorized;

  let appliedMigrationTag: string | null | undefined;
  if (request.headers.get('content-length') !== '0' && request.headers.get('content-type')?.includes('application/json')) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return platformError(400, 'INVALID_ADMIN_REQUEST', 'Administrative request must be JSON');
    }
    if (body && typeof body === 'object' && 'appliedMigrationTag' in body) {
      if (body.appliedMigrationTag !== null && typeof body.appliedMigrationTag !== 'string') {
        return platformError(400, 'INVALID_ADMIN_REQUEST', 'appliedMigrationTag must be a string or null');
      }
      appliedMigrationTag = body.appliedMigrationTag;
    }
  }

  const deployments = env.DEPLOYMENTS.getByName(tenant);
  const token = await deployments.rotateToken();
  const state = appliedMigrationTag === undefined
    ? await deployments.getState()
    : await deployments.setAppliedMigrationTag(appliedMigrationTag);
  return Response.json({ token, appliedMigrationTag: state.appliedMigrationTag, active: state.active?.sha ?? null });
}

/** One `worker-deploy` ledger entry per swap; an unconfigured credit account is logged, never a deploy failure. */
async function meterDeploy(env: Env, tenant: string, sha: string): Promise<void> {
  const credits = env.CREDITS.getByName(tenant);
  const account = await credits.getAccount();
  if (account.status === 'error') {
    console.error(JSON.stringify({ event: 'deploy-metering-skipped', tenant, code: account.error.code }));
    return;
  }
  const now = new Date().toISOString();
  const ledger: CreditLedgerRecord = {
    id: `deploy:${tenant}:${sha}:${crypto.randomUUID()}`,
    resource: 'worker-deploy',
    quantity: '1',
    rateVersion: 'cloudflare-2026-08-27',
    debitMicros: Number(env.DEPLOY_SETTLEMENT_MICROS),
    windowStart: now,
    windowEnd: now,
    createdAt: now,
  };
  const applied = await credits.applyUsage(ledger);
  if (applied.status === 'error') console.error(JSON.stringify({ event: 'deploy-metering-failed', tenant, code: applied.error.code }));
}

/** Account for dispatched requests without making credit availability an access policy. */
async function meterDispatch(env: Env, tenant: string): Promise<void> {
  try {
    const credits = env.CREDITS.getByName(tenant);
    const account = await credits.getAccount();
    if (account.status === 'error') {
      if (account.error.code !== 'ACCOUNT_UNCONFIGURED') {
        console.error(JSON.stringify({ event: 'credit-settlement-failed', tenant, code: account.error.code }));
      }
      return;
    }
    const now = new Date().toISOString();
    const applied = await credits.applyUsage({
      id: `dispatch:${crypto.randomUUID()}`,
      resource: 'worker-request',
      quantity: '1',
      rateVersion: 'cloudflare-2026-08-27',
      debitMicros: Number(env.DISPATCH_SETTLEMENT_MICROS),
      windowStart: now,
      windowEnd: now,
      createdAt: now,
    });
    if (applied.status === 'error') console.error(JSON.stringify({ event: 'credit-settlement-failed', tenant, code: applied.error.code }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'credit-settlement-failed', tenant, message: error instanceof Error ? error.message : String(error) }));
  }
}

/** Tenant-authenticated worker swap: `deploy` a staged release or `revert` to the previous release / our channel. */
async function handleTenantDeployment(request: Request, env: Env, tenant: string, action: 'deploy' | 'revert', operator = false): Promise<Response> {
  if (request.method !== 'POST') return platformError(405, 'METHOD_NOT_ALLOWED', 'Tenant deployment supports POST');
  if (operator) {
    if (!env.PLATFORM_BOOTSTRAP_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}`) {
      return platformError(401, 'OPERATOR_UNAUTHORIZED', 'Platform operator authorization is required');
    }
  } else {
    const bearer = /^Bearer (\S+)$/u.exec(request.headers.get('authorization') ?? '');
    if (!bearer || !await env.DEPLOYMENTS.getByName(tenant).verifyToken(bearer[1]!)) {
      return platformError(401, 'TENANT_UNAUTHORIZED', 'Tenant deployment token is missing or invalid');
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return platformError(400, 'INVALID_DEPLOY_REQUEST', 'Deployment request must be JSON');
  }

  // The root-key binding is immutable and survives deploys/reverts. Neither a
  // tenant path nor an operator-supplied account id can select another account's data.
  const config = await env.DEPLOYMENTS.getByName(tenant).tenantConfig();
  if (!config) return platformError(409, 'TENANT_UNPROVISIONED', 'Tenant has no account binding');
  const accountId = await accountIdForRoot(config.rootPublicKey);
  if (operator && (!body || typeof body !== 'object' || !('accountId' in body) || body.accountId !== accountId)) {
    return platformError(403, 'TENANT_ACCOUNT_MISMATCH', 'Deployment account does not own this tenant');
  }
  const denied = await deploymentAccess(env, tenant);
  if (denied) return denied;
  let result: DeployResult;
  if (action === 'deploy') {
    const parsed = platformDeployRequestSchema.safeParse(body);
    if (!parsed.success) return platformError(400, 'INVALID_DEPLOY_REQUEST', parsed.error.message);
    if (!parsed.data.bundleKey.startsWith(`users/${accountId}/`)
      || parsed.data.bundleKey.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      return platformError(403, 'BUNDLE_ACCOUNT_MISMATCH', 'Worker bundle does not belong to this account');
    }
    result = await deployTenantWorker(env, tenant, parsed.data);
  } else {
    const parsed = platformRevertRequestSchema.safeParse(body);
    if (!parsed.success) return platformError(400, 'INVALID_DEPLOY_REQUEST', parsed.error.message);
    result = await revertTenantWorker(env, tenant, parsed.data.to);
  }
  if (result.status === 'error') return platformError(result.error.status, result.error.code, result.error.message);
  await meterDeploy(env, tenant, result.value.sha);
  return Response.json(result.value);
}

async function handleOperatorTenant(request: Request, env: Env, tenant: string, accessOnly = false): Promise<Response> {
  if (!env.PLATFORM_BOOTSTRAP_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}`) {
    return platformError(401, 'OPERATOR_UNAUTHORIZED', 'Platform operator authorization is required');
  }
  if (accessOnly) {
    if (request.method !== 'GET') return platformError(405, 'METHOD_NOT_ALLOWED', 'Platform operator tenant access supports GET');
    try {
      return Response.json({ control: await env.TENANT_CONTROL.getByName(tenant).get() }, { headers: { 'cache-control': 'private, no-store' } });
    } catch {
      return platformError(503, 'TENANT_AUTHORITY_UNAVAILABLE', 'Tenant authorization authority is unavailable');
    }
  }
  const control = env.TENANT_CONTROL.getByName(tenant);
  const credits = env.CREDITS.getByName(tenant);
  const deployments = env.DEPLOYMENTS.getByName(tenant);
  if (request.method === 'GET') {
    const [controlState, creditAccount, usage, deploymentState] = await Promise.all([
      control.get(),
      credits.getAccount(),
      credits.usageSummary(),
      deployments.getState(),
    ]);
    return Response.json({
      control: controlState,
      credits: creditAccount.status === 'ok' ? creditAccount.value : null,
      usage,
      deployment: {
        active: deploymentState.active?.sha ?? null,
        uploadedAt: deploymentState.active?.uploadedAt ?? null,
        appliedMigrationTag: deploymentState.appliedMigrationTag,
      },
    }, { headers: { 'cache-control': 'private, no-store' } });
  }
  if (request.method !== 'POST') return platformError(405, 'METHOD_NOT_ALLOWED', 'Platform operator tenant control supports GET and POST');
  let body: { action?: unknown; reason?: unknown };
  try {
    body = await request.json() as { action?: unknown; reason?: unknown };
  } catch {
    return platformError(400, 'INVALID_OPERATOR_ACTION', 'Tenant control request must be JSON');
  }
  const reason = typeof body.reason === 'string' ? body.reason : null;
  if (body.action === 'suspend') {
    return Response.json({ control: await control.set({ status: 'suspended', reason: reason ?? 'Suspended by operator' }) });
  }
  if (body.action === 'quarantine') {
    const creditAccount = await credits.getAccount();
    if (creditAccount.status === 'ok') await credits.quarantine(reason ?? 'Quarantined by operator');
    return Response.json({ control: await control.set({ status: 'quarantined', reason: reason ?? 'Quarantined by operator' }) });
  }
  if (body.action === 'restore') {
    const previous = await control.get();
    const creditAccount = await credits.getAccount();
    if (previous.status === 'quarantined' && creditAccount.status === 'ok') await credits.resume();
    return Response.json({ control: await control.set({ status: 'active', reason: null }) });
  }
  return platformError(400, 'INVALID_OPERATOR_ACTION', 'Tenant action must be suspend, quarantine, or restore');
}



async function handleTenantResource(request: Request, env: Env, tenant: string, path: string): Promise<Response> {
  const deployments = env.DEPLOYMENTS.getByName(tenant);
  const token = path.startsWith('/provider/') ? request.headers.get('x-gitspace-provider-token') : /^Bearer (\S+)$/u.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token || !await deployments.verifyToken(token)) return platformError(401, 'TENANT_UNAUTHORIZED', 'Tenant resource token is invalid');
  const denied = await deploymentAccess(env, tenant);
  if (denied) return denied;
  const config = await deployments.tenantConfig();
  if (!config) return platformError(409, 'TENANT_UNPROVISIONED', 'Tenant resource namespace is missing');
  if (path === '/state' && request.method === 'GET') {
    const [control, deployment] = await Promise.all([env.TENANT_CONTROL.getByName(tenant).get(), deployments.getState()]);
    return Response.json({ control, deployment: { active: deployment.active?.sha ?? null } }, { headers: { 'cache-control': 'private, no-store' } });
  }
  if (path === '/storage' && request.method === 'GET') return Response.json({ bucket: config.blobBucket, endpoint: 'https://' + env.CF_ACCOUNT_ID + '.r2.cloudflarestorage.com', region: 'auto' });
  if (path === '/storage/credentials' && request.method === 'POST') {
    try {
      const body = await request.json() as { prefixes?: unknown; ttlSeconds?: unknown; permission?: unknown };
      if (!Array.isArray(body.prefixes) || !body.prefixes.every((value): value is string => typeof value === 'string') || body.prefixes.length > 100) return platformError(400, 'INVALID_STORAGE_SCOPE', 'Storage prefixes are invalid');
      if (body.permission !== undefined && body.permission !== 'object-read-only' && body.permission !== 'object-read-write') return platformError(400, 'INVALID_STORAGE_PERMISSION', 'Storage permission is invalid');
      const client = new CloudflareR2PlatformClient({ accountId: env.CF_ACCOUNT_ID, apiToken: env.R2_API_TOKEN, parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID });
      const credentials = await client.mintTemporaryCredentials({ bucketName: config.blobBucket, prefixes: body.prefixes, ttlSeconds: Number(body.ttlSeconds ?? 3600), permission: body.permission });
      return Response.json(credentials, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return platformError(400, 'STORAGE_CREDENTIALS_FAILED', error instanceof Error ? error.message : 'Storage credentials failed'); }
  }
  if (path.startsWith('/provider/compute/')) {
    const userId = await accountIdForRoot(config.rootPublicKey);
    const headers = new Headers(request.headers);
    headers.delete('x-gitspace-provider-token');
    headers.set('x-gitspace-user-id', userId);
    headers.delete('host');
    const url = new URL(request.url);
    const target = 'https://compute.internal' + path.slice('/provider/compute'.length) + url.search;
    return env.COMPUTE.fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  }
  return platformError(404, 'RESOURCE_NOT_FOUND', 'Tenant resource route does not exist');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__platform/health') return Response.json({ status: 'ok' });

    const resource = /^\/__platform\/tenants\/([a-z0-9-]+)(\/(?:state|storage|provider)(?:\/.*)?)$/u.exec(url.pathname);
    if (resource && tenantIdSchema.safeParse(resource[1]).success) return handleTenantResource(request, env, resource[1]!, resource[2]!);
    const adminMatch = CREDIT_ADMIN_PATH.exec(url.pathname);
    if (adminMatch) return handleCreditAdmin(request, env, adminMatch[1]!);
    const tokenMatch = TOKEN_ADMIN_PATH.exec(url.pathname);
    if (tokenMatch) return handleTokenAdmin(request, env, tokenMatch[1]!);
    const bootstrapMatch = TENANT_BOOTSTRAP_PATH.exec(url.pathname);
    if (bootstrapMatch) return handleTenantBootstrap(request, env, bootstrapMatch[1]!);
    const deployMatch = TENANT_DEPLOY_PATH.exec(url.pathname);
    if (deployMatch) return handleTenantDeployment(request, env, deployMatch[1]!, deployMatch[2] === 'deploy' ? 'deploy' : 'revert');
    const operatorDeployMatch = OPERATOR_DEPLOY_PATH.exec(url.pathname);
    if (operatorDeployMatch) return handleTenantDeployment(request, env, operatorDeployMatch[1]!, operatorDeployMatch[2] === 'deploy' ? 'deploy' : 'revert', true);
    const operatorAccessMatch = OPERATOR_TENANT_ACCESS_PATH.exec(url.pathname);
    if (operatorAccessMatch) return handleOperatorTenant(request, env, operatorAccessMatch[1]!, true);
    const operatorTenantMatch = OPERATOR_TENANT_PATH.exec(url.pathname);
    if (operatorTenantMatch) return handleOperatorTenant(request, env, operatorTenantMatch[1]!);

    const target = tenantFromHostname(url.hostname, env.TENANT_HOST_SUFFIX) ?? tenantFromHostname(url.hostname, '.gitspace.sh');
    if (!target) return platformError(404, 'TENANT_NOT_FOUND', 'Tenant hostname is not registered');
    const tenant = target.tenant;
    try {
      const tenantControlState = await env.TENANT_CONTROL.getByName(tenant).get();
      if (tenantControlState.status !== 'active') {
        return platformError(423, `TENANT_${tenantControlState.status.toUpperCase()}`, tenantControlState.reason ?? `Tenant is ${tenantControlState.status}`);
      }
    } catch {
      return platformError(503, 'TENANT_AUTHORITY_UNAVAILABLE', 'Tenant authorization authority is unavailable');
    }

    let response: Response;
    try {
      const userWorker = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ? env.DISPATCHER.get(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`)
        : env.DISPATCHER.get(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`, {}, { limits: { cpuMs: Number(env.DEFAULT_CPU_MS), subRequests: Number(env.DEFAULT_SUBREQUESTS) } });
      const headers = new Headers(request.headers);
      headers.delete('x-gitspace-provider-token');
      headers.delete('x-gitspace-tenant');
      response = await userWorker.fetch(new Request(request, { headers }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'tenant-dispatch-failed', tenant, hostname: url.hostname, path: url.pathname, message }));
      response = message.startsWith('Worker not found')
        ? platformError(404, 'RELAY_NOT_DEPLOYED', 'Tenant relay is not deployed')
        : platformError(502, 'RELAY_DISPATCH_FAILED', 'Tenant relay dispatch failed');
    }

    ctx.waitUntil(meterDispatch(env, tenant));
    return response;
  },
} satisfies ExportedHandler<Env>;
