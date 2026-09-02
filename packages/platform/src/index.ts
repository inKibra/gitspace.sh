import { platformDeployRequestSchema, platformRevertRequestSchema, verifyRelayAuthorization } from '@gitspace/protocol';
import { CreditLedgerDO, isCreditLedgerRecord, type CreditLedgerRecord } from './credit-ledger.js';
import { deployTenantWorker, revertTenantWorker, type DeployResult } from './deployer.js';

export { CreditLedgerDO } from './credit-ledger.js';
export { TenantDeploymentsDO } from './tenant-deployments.js';

const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CREDIT_ADMIN_PATH = /^\/__platform\/credits\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u;
const TOKEN_ADMIN_PATH = /^\/__platform\/admin\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/token$/u;
const TENANT_DEPLOY_PATH = /^\/__platform\/tenants\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/(deploy|revert)$/u;

function tenantFromHostname(hostname: string, suffix: string): string | null {
  const normalized = hostname.toLowerCase();
  const expectedSuffix = suffix.toLowerCase();
  if (!normalized.endsWith(expectedSuffix)) return null;
  const tenant = normalized.slice(0, -expectedSuffix.length);
  return TENANT_SLUG.test(tenant) ? tenant : null;
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

/** Tenant-authenticated worker swap: `deploy` a staged release or `revert` to the previous release / our channel. */
async function handleTenantDeployment(request: Request, env: Env, tenant: string, action: 'deploy' | 'revert'): Promise<Response> {
  if (request.method !== 'POST') return platformError(405, 'METHOD_NOT_ALLOWED', 'Tenant deployment supports POST');
  const bearer = /^Bearer (\S+)$/u.exec(request.headers.get('authorization') ?? '');
  if (!bearer || !await env.DEPLOYMENTS.getByName(tenant).verifyToken(bearer[1]!)) {
    return platformError(401, 'TENANT_UNAUTHORIZED', 'Tenant deployment token is missing or invalid');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return platformError(400, 'INVALID_DEPLOY_REQUEST', 'Deployment request must be JSON');
  }

  let result: DeployResult;
  if (action === 'deploy') {
    const parsed = platformDeployRequestSchema.safeParse(body);
    if (!parsed.success) return platformError(400, 'INVALID_DEPLOY_REQUEST', parsed.error.message);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__platform/health') return Response.json({ status: 'ok' });

    const adminMatch = CREDIT_ADMIN_PATH.exec(url.pathname);
    if (adminMatch) return handleCreditAdmin(request, env, adminMatch[1]!);
    const tokenMatch = TOKEN_ADMIN_PATH.exec(url.pathname);
    if (tokenMatch) return handleTokenAdmin(request, env, tokenMatch[1]!);
    const deployMatch = TENANT_DEPLOY_PATH.exec(url.pathname);
    if (deployMatch) return handleTenantDeployment(request, env, deployMatch[1]!, deployMatch[2] === 'deploy' ? 'deploy' : 'revert');

    const tenant = tenantFromHostname(url.hostname, env.TENANT_HOST_SUFFIX);
    if (!tenant) return platformError(404, 'TENANT_NOT_FOUND', 'Relay tenant hostname is not registered');

    const credits = env.CREDITS.getByName(tenant);
    const reservationId = crypto.randomUUID();
    const reserved = await credits.reserveDispatch({
      id: reservationId,
      amountMicros: Number(env.DISPATCH_RESERVATION_MICROS),
      expiresAt: Date.now() + Number(env.RESERVATION_TTL_MS),
    });
    if (reserved.status === 'error') {
      if (reserved.error.code === 'INSUFFICIENT_CREDITS') {
        await credits.quarantine('Credit balance exhausted below required risk reserve');
        return platformError(402, reserved.error.code, reserved.error.message);
      }
      return reserved.error.code === 'ACCOUNT_QUARANTINED'
        ? platformError(423, reserved.error.code, reserved.error.message)
        : platformError(402, reserved.error.code, reserved.error.message);
    }

    let response: Response;
    try {
      const userWorker = env.DISPATCHER.get(
        `tenant-${tenant}`,
        {},
        {
          limits: {
            cpuMs: Number(env.DEFAULT_CPU_MS),
            subRequests: Number(env.DEFAULT_SUBREQUESTS),
          },
        },
      );
      response = await userWorker.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = message.startsWith('Worker not found')
        ? platformError(404, 'RELAY_NOT_DEPLOYED', 'Tenant relay is not deployed')
        : platformError(502, 'RELAY_DISPATCH_FAILED', 'Tenant relay dispatch failed');
    }

    const now = new Date().toISOString();
    const ledger: CreditLedgerRecord = {
      id: `dispatch:${reservationId}`,
      resource: 'worker-request',
      quantity: '1',
      rateVersion: 'cloudflare-2026-08-27',
      debitMicros: Number(env.DISPATCH_SETTLEMENT_MICROS),
      windowStart: now,
      windowEnd: now,
      createdAt: now,
    };
    const settled = await credits.settleDispatch({ reservationId, ledger });
    if (settled.status === 'error') console.error(JSON.stringify({ event: 'credit-settlement-failed', tenant, code: settled.error.code }));
    return response;
  },
} satisfies ExportedHandler<Env>;
