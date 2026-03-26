/**
 * Subdomain handlers
 *
 * CRUD operations for subdomains and tunnel management.
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import type { AuthContext } from '../middleware/auth';
import {
  configureTunnelIngress,
  createDNSRecords,
  createLocalManagedTunnel,
  createRemoteManagedTunnel,
  createServeRouteDnsRecords,
  deleteDNSRecords,
  deleteServeRouteDnsRecords,
  deleteTunnel,
  decryptToken,
  encryptToken,
  getServeRouteDomain,
} from '../services/cloudflare';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

const FREE_SUBDOMAIN_LIMIT = 3;
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
const LOCAL_MANAGED_PLACEHOLDER_TOKEN = '__local_managed__';

interface StoredSubdomainRecord {
  id: string;
  subdomain: string;
  tunnel_id: string;
  dns_record_ids: string;
  custom_hostname_id: string | null;
  tunnel_name: string | null;
  tunnel_config_source: string | null;
  tunnel_secret_encrypted: string | null;
}

interface ExistingSubdomainRecord extends StoredSubdomainRecord {
  user_id: string;
  status: string;
  tunnel_token_encrypted: string;
  is_primary: number;
}

interface ListedSubdomainRecord {
  id: string;
  subdomain: string;
  status: string;
  is_primary: number;
  created_at: number;
  updated_at: number;
  serveStatus: string | null;
}

interface ServeRouteRecord {
  id: string;
  serve_subdomain_id: string;
  hostname: string;
  dns_record_id: string;
}

interface ServeTunnelResponse {
  serveDomain: string;
  serveTunnelId: string;
  serveTunnelName: string;
  serveTunnelConfigSource: 'local';
  serveTunnelCredentialsFile: {
    AccountTag: string;
    TunnelID: string;
    TunnelName: string;
    TunnelSecret: string;
  };
}

let hostingSchemaReady: Promise<void> | null = null;

function isServeSubdomain(subdomain: string): boolean {
  return subdomain.endsWith('.serve');
}

function getServeRecordSubdomain(rootSubdomain: string): string {
  return `${rootSubdomain}.serve`;
}

function normalizeTunnelConfigSource(value: string | null | undefined): 'cloudflare' | 'local' {
  return value === 'local' ? 'local' : 'cloudflare';
}

function normalizeServeRouteHostname(value: string): string {
  return value.trim().toLowerCase();
}


function getReservedServeNamespaceReason(subdomain: string): string | null {
  if (subdomain.includes('--')) {
    return 'Subdomain names containing -- are reserved for hosted service routes.';
  }
  if (subdomain.endsWith('-srv')) {
    return 'Subdomain names ending in -srv are reserved for hosted service routes.';
  }
  return null;
}

function isOwnedServeRouteHostname(hostname: string, serveDomain: string, rootSubdomain: string): boolean {
  const normalizedHostname = normalizeServeRouteHostname(hostname);
  const ownedSuffix = `--${rootSubdomain}-srv.${serveDomain}`;
  if (!normalizedHostname.endsWith(ownedSuffix)) {
    return false;
  }
  const label = normalizedHostname.slice(0, -(serveDomain.length + 1));
  return label.length > ownedSuffix.length - (serveDomain.length + 1) && !label.includes('.');
}

function buildServeTunnelResponse(args: {
  env: Env;
  serveTunnelId: string;
  serveTunnelName: string;
  tunnelSecret: string;
}): ServeTunnelResponse {
  return {
    serveDomain: getServeRouteDomain(args.env),
    serveTunnelId: args.serveTunnelId,
    serveTunnelName: args.serveTunnelName,
    serveTunnelConfigSource: 'local',
    serveTunnelCredentialsFile: {
      AccountTag: args.env.CF_ACCOUNT_ID,
      TunnelID: args.serveTunnelId,
      TunnelName: args.serveTunnelName,
      TunnelSecret: args.tunnelSecret,
    },
  };
}

async function ensureHostingSchema(env: Env): Promise<void> {
  if (!hostingSchemaReady) {
    hostingSchemaReady = (async () => {
      const result = await env.DB.prepare('PRAGMA table_info(subdomains)').all<{ name: string }>();
      const columns = new Set(result.results.map((row) => row.name));
      const migrations: string[] = [];

      if (!columns.has('tunnel_config_source')) {
        migrations.push("ALTER TABLE subdomains ADD COLUMN tunnel_config_source TEXT NOT NULL DEFAULT 'cloudflare'");
      }
      if (!columns.has('tunnel_name')) {
        migrations.push('ALTER TABLE subdomains ADD COLUMN tunnel_name TEXT');
      }
      if (!columns.has('tunnel_secret_encrypted')) {
        migrations.push('ALTER TABLE subdomains ADD COLUMN tunnel_secret_encrypted TEXT');
      }

      for (const statement of migrations) {
        await env.DB.prepare(statement).run();
      }

      await env.DB.prepare(
        `
        CREATE TABLE IF NOT EXISTS serve_route_records (
          id TEXT PRIMARY KEY,
          serve_subdomain_id TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
          hostname TEXT UNIQUE NOT NULL,
          dns_record_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
      ).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_serve_route_records_subdomain ON serve_route_records(serve_subdomain_id)').run();
      await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_serve_route_records_hostname ON serve_route_records(hostname)').run();
    })();
  }

  await hostingSchemaReady;
}

app.use('*', async (c, next) => {
  await ensureHostingSchema(c.env);
  await next();
});

async function getStoredTunnelToken(
  env: Env,
  record: Pick<ExistingSubdomainRecord, 'tunnel_token_encrypted'>,
): Promise<string> {
  return decryptToken(env, record.tunnel_token_encrypted);
}

async function getStoredServeTunnelDetails(
  env: Env,
  record: Pick<ExistingSubdomainRecord, 'tunnel_id' | 'tunnel_name' | 'tunnel_config_source' | 'tunnel_secret_encrypted'>,
): Promise<ServeTunnelResponse | null> {
  if (normalizeTunnelConfigSource(record.tunnel_config_source) !== 'local') {
    return null;
  }
  if (!record.tunnel_name || !record.tunnel_secret_encrypted) {
    return null;
  }

  const tunnelSecret = await decryptToken(env, record.tunnel_secret_encrypted);
  return buildServeTunnelResponse({
    env,
    serveTunnelId: record.tunnel_id,
    serveTunnelName: record.tunnel_name,
    tunnelSecret,
  });
}

async function listServeRouteRecords(env: Env, serveSubdomainId: string): Promise<ServeRouteRecord[]> {
  const result = await env.DB.prepare(
    `
    SELECT id, serve_subdomain_id, hostname, dns_record_id
    FROM serve_route_records
    WHERE serve_subdomain_id = ?
  `,
  )
    .bind(serveSubdomainId)
    .all<ServeRouteRecord>();
  return result.results;
}

async function cleanupServeRouteRecords(env: Env, serveSubdomainId: string): Promise<void> {
  const records = await listServeRouteRecords(env, serveSubdomainId);
  if (records.length === 0) {
    return;
  }

  try {
    await deleteServeRouteDnsRecords(env, records.map((record) => record.dns_record_id));
  } catch (error) {
    console.error('Serve route DNS deletion failed:', error);
  }

  for (const record of records) {
    await env.DB.prepare('DELETE FROM serve_route_records WHERE id = ?').bind(record.id).run();
  }
}

async function cleanupStoredSubdomain(env: Env, record: StoredSubdomainRecord): Promise<void> {
  if (isServeSubdomain(record.subdomain)) {
    await cleanupServeRouteRecords(env, record.id);
  }

  try {
    await deleteTunnel(env, record.tunnel_id);
  } catch (error) {
    console.error('Tunnel deletion failed:', error);
  }

  try {
    const dnsRecordIds = JSON.parse(record.dns_record_ids) as string[];
    if (dnsRecordIds.length > 0) {
      await deleteDNSRecords(env, dnsRecordIds);
    }
  } catch (error) {
    console.error('DNS deletion failed:', error);
  }
}

async function hardDeleteStoredSubdomain(env: Env, record: StoredSubdomainRecord): Promise<void> {
  await cleanupStoredSubdomain(env, record);
  await env.DB.prepare('DELETE FROM subdomains WHERE id = ?').bind(record.id).run();
}

async function insertStoredSubdomain(args: {
  env: Env;
  userId: string;
  subdomain: string;
  tunnelId: string;
  dnsRecordIds: string[];
  tunnelTokenEncrypted: string;
  tunnelConfigSource: 'cloudflare' | 'local';
  tunnelName: string | null;
  tunnelSecretEncrypted: string | null;
  isPrimary: boolean;
}): Promise<string> {
  const now = Date.now();
  const subdomainId = crypto.randomUUID();

  await args.env.DB.prepare(
    `
      INSERT INTO subdomains (
        id, subdomain, user_id, tunnel_id, dns_record_ids, custom_hostname_id,
        tunnel_token_encrypted, tunnel_config_source, tunnel_name, tunnel_secret_encrypted,
        status, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      subdomainId,
      args.subdomain,
      args.userId,
      args.tunnelId,
      JSON.stringify(args.dnsRecordIds),
      null,
      args.tunnelTokenEncrypted,
      args.tunnelConfigSource,
      args.tunnelName,
      args.tunnelSecretEncrypted,
      'active',
      args.isPrimary ? 1 : 0,
      now,
      now,
    )
    .run();

  return subdomainId;
}

async function createRemoteManagedSubdomain(
  env: Env,
  userId: string,
  subdomain: string,
  isPrimary: boolean,
): Promise<{ id: string; tunnelToken: string }> {
  let tunnel;
  try {
    tunnel = await createRemoteManagedTunnel(env, subdomain);
  } catch (error) {
    console.error('Tunnel creation failed:', error);
    throw new Error('Failed to create tunnel');
  }

  try {
    await configureTunnelIngress(env, tunnel.id, subdomain);
  } catch (error) {
    await deleteTunnel(env, tunnel.id).catch(() => {});
    console.error('Tunnel ingress configuration failed:', error);
    throw new Error('Failed to configure tunnel');
  }

  let dnsRecordIds: string[] = [];
  try {
    dnsRecordIds = await createDNSRecords(env, subdomain, tunnel.id);
    const encryptedToken = await encryptToken(env, tunnel.token);
    const id = await insertStoredSubdomain({
      env,
      userId,
      subdomain,
      tunnelId: tunnel.id,
      dnsRecordIds,
      tunnelTokenEncrypted: encryptedToken,
      tunnelConfigSource: 'cloudflare',
      tunnelName: tunnel.name,
      tunnelSecretEncrypted: null,
      isPrimary,
    });
    return { id, tunnelToken: tunnel.token };
  } catch (error) {
    await Promise.allSettled([
      deleteTunnel(env, tunnel.id),
      deleteDNSRecords(env, dnsRecordIds),
    ]);
    throw error;
  }
}

async function createLocalManagedServeSubdomain(
  env: Env,
  userId: string,
  serveRecordSubdomain: string,
): Promise<{ id: string; details: ServeTunnelResponse }> {
  let tunnel;
  try {
    tunnel = await createLocalManagedTunnel(env, serveRecordSubdomain);
  } catch (error) {
    console.error('Serve tunnel creation failed:', error);
    throw new Error('Failed to create serve tunnel');
  }

  try {
    const placeholderToken = await encryptToken(env, LOCAL_MANAGED_PLACEHOLDER_TOKEN);
    const encryptedSecret = await encryptToken(env, tunnel.tunnelSecret);
    const id = await insertStoredSubdomain({
      env,
      userId,
      subdomain: serveRecordSubdomain,
      tunnelId: tunnel.id,
      dnsRecordIds: [],
      tunnelTokenEncrypted: placeholderToken,
      tunnelConfigSource: 'local',
      tunnelName: tunnel.name,
      tunnelSecretEncrypted: encryptedSecret,
      isPrimary: false,
    });
    return {
      id,
      details: buildServeTunnelResponse({
        env,
        serveTunnelId: tunnel.id,
        serveTunnelName: tunnel.name,
        tunnelSecret: tunnel.tunnelSecret,
      }),
    };
  } catch (error) {
    await deleteTunnel(env, tunnel.id).catch(() => {});
    throw error;
  }
}

/**
 * List user's subdomains.
 * GET /subdomains
 */
app.get('/', async (c) => {
  const user = c.get('user');
  const serveDomain = getServeRouteDomain(c.env);

  const subdomains = await c.env.DB.prepare(
    `
    SELECT
      primary_subdomains.id,
      primary_subdomains.subdomain,
      primary_subdomains.status,
      primary_subdomains.is_primary,
      primary_subdomains.created_at,
      primary_subdomains.updated_at,
      serve_subdomains.status AS serveStatus
    FROM subdomains AS primary_subdomains
    LEFT JOIN subdomains AS serve_subdomains
      ON serve_subdomains.user_id = primary_subdomains.user_id
      AND serve_subdomains.subdomain = primary_subdomains.subdomain || '.serve'
      AND serve_subdomains.status != 'deleted'
    WHERE primary_subdomains.user_id = ?
      AND primary_subdomains.status != 'deleted'
      AND primary_subdomains.subdomain NOT LIKE '%.serve'
    ORDER BY primary_subdomains.is_primary DESC, primary_subdomains.created_at DESC
  `,
  )
    .bind(user.id)
    .all<ListedSubdomainRecord>();

  return c.json(subdomains.results.map((record) => ({
    ...record,
    serveDomain: record.serveStatus ? serveDomain : null,
  })));
});

/**
 * Check subdomain availability.
 * GET /subdomains/check?name=xxx
 */
app.get('/check', async (c) => {
  const name = c.req.query('name')?.toLowerCase();
  if (!name) {
    return c.json({ available: false, reason: 'Subdomain name required' });
  }

  if (!SUBDOMAIN_REGEX.test(name)) {
    return c.json({
      available: false,
      reason: 'Invalid format. Use 3-20 lowercase letters, numbers, and hyphens.',
    });
  }
  const reservedNamespaceReason = getReservedServeNamespaceReason(name);
  if (reservedNamespaceReason) {
    return c.json({ available: false, reason: reservedNamespaceReason });
  }

  const reserved = await c.env.DB.prepare(
    'SELECT 1 FROM reserved_subdomains WHERE subdomain = ?',
  )
    .bind(name)
    .first();
  if (reserved) {
    return c.json({ available: false, reason: 'This subdomain is reserved' });
  }

  const existing = await c.env.DB.prepare(
    "SELECT 1 FROM subdomains WHERE subdomain = ? AND status != 'deleted'",
  )
    .bind(name)
    .first();
  if (existing) {
    return c.json({ available: false, reason: 'This subdomain is already taken' });
  }

  return c.json({ available: true });
});

/**
 * Reserve a subdomain.
 * POST /subdomains
 */
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ subdomain: string; isPrimary?: boolean }>();
  const subdomain = body.subdomain?.toLowerCase();
  if (!subdomain || !SUBDOMAIN_REGEX.test(subdomain)) {
    return c.json({ error: 'Invalid subdomain format. Use 3-20 lowercase letters, numbers, and hyphens.' }, 400);
  }

  const reservedNamespaceReason = getReservedServeNamespaceReason(subdomain);
  if (reservedNamespaceReason) {
    return c.json({ error: reservedNamespaceReason }, 400);
  }

  const reserved = await c.env.DB.prepare(
    'SELECT reason FROM reserved_subdomains WHERE subdomain = ?',
  )
    .bind(subdomain)
    .first<{ reason: string }>();
  if (reserved) {
    return c.json({ error: `This subdomain is reserved (${reserved.reason})` }, 400);
  }

  let existing = await c.env.DB.prepare(
    `
    SELECT
      id, subdomain, user_id, status, tunnel_id, dns_record_ids, custom_hostname_id,
      tunnel_token_encrypted, tunnel_name, tunnel_config_source, tunnel_secret_encrypted, is_primary
    FROM subdomains
    WHERE subdomain = ?
  `,
  )
    .bind(subdomain)
    .first<ExistingSubdomainRecord>();

  if (existing) {
    if (existing.user_id !== user.id && existing.status !== 'deleted') {
      return c.json({ error: 'This subdomain is already taken' }, 400);
    }
    if (existing.status === 'deleted' || normalizeTunnelConfigSource(existing.tunnel_config_source) !== 'cloudflare') {
      await hardDeleteStoredSubdomain(c.env, existing);
      existing = null;
    }
  }

  const countResult = await c.env.DB.prepare(
    `
    SELECT COUNT(*) as count
    FROM subdomains
    WHERE user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve' AND subdomain != ?
  `,
  )
    .bind(user.id, subdomain)
    .first<{ count: number }>();

  const count = countResult?.count ?? 0;
  if (count >= FREE_SUBDOMAIN_LIMIT) {
    return c.json({ error: `Subdomain limit reached (${FREE_SUBDOMAIN_LIMIT} for free tier)` }, 400);
  }

  const isPrimary = existing?.user_id === user.id && existing.status === 'active' && existing.is_primary === 1
    ? true
    : count === 0 || Boolean(body.isPrimary);

  const serveRecordSubdomain = getServeRecordSubdomain(subdomain);
  let existingServe = await c.env.DB.prepare(
    `
    SELECT
      id, subdomain, user_id, status, tunnel_id, dns_record_ids, custom_hostname_id,
      tunnel_token_encrypted, tunnel_name, tunnel_config_source, tunnel_secret_encrypted, is_primary
    FROM subdomains
    WHERE subdomain = ?
  `,
  )
    .bind(serveRecordSubdomain)
    .first<ExistingSubdomainRecord>();

  if (existingServe) {
    if (existingServe.user_id !== user.id && existingServe.status !== 'deleted') {
      return c.json({ error: 'Serve tunnel namespace is already taken' }, 400);
    }
    if (existingServe.status === 'deleted' || normalizeTunnelConfigSource(existingServe.tunnel_config_source) !== 'local') {
      await hardDeleteStoredSubdomain(c.env, existingServe);
      existingServe = null;
    }
  }

  let createdPrimary: { id: string; tunnelToken: string } | null = null;
  let createdServe: { id: string; details: ServeTunnelResponse } | null = null;
  let createdPrimaryNew = false;
  let createdServeNew = false;

  try {
    if (existing && existing.user_id === user.id && existing.status === 'active') {
      createdPrimary = {
        id: existing.id,
        tunnelToken: await getStoredTunnelToken(c.env, existing),
      };
    } else {
      createdPrimary = await createRemoteManagedSubdomain(c.env, user.id, subdomain, false);
      createdPrimaryNew = true;
    }

    if (existingServe && existingServe.user_id === user.id && existingServe.status === 'active') {
      const storedDetails = await getStoredServeTunnelDetails(c.env, existingServe);
      if (!storedDetails) {
        await hardDeleteStoredSubdomain(c.env, existingServe);
        createdServe = await createLocalManagedServeSubdomain(c.env, user.id, serveRecordSubdomain);
        createdServeNew = true;
      } else {
        createdServe = { id: existingServe.id, details: storedDetails };
      }
    } else {
      createdServe = await createLocalManagedServeSubdomain(c.env, user.id, serveRecordSubdomain);
      createdServeNew = true;
    }

    if (isPrimary) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE subdomains SET is_primary = 0 WHERE user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'",
        ).bind(user.id),
        c.env.DB.prepare(
          'UPDATE subdomains SET is_primary = 1, updated_at = ? WHERE id = ?',
        ).bind(Date.now(), createdPrimary.id),
      ]);
    }

    return c.json({
      id: createdPrimary.id,
      subdomain,
      tunnelToken: createdPrimary.tunnelToken,
      ...createdServe.details,
      hosts: [`${subdomain}.gitspace.sh`, `*.${subdomain}.gitspace.sh`],
      isPrimary,
    });
  } catch (error) {
    if (createdServeNew && createdServe) {
      const serveRecord = await c.env.DB.prepare(
        `
        SELECT id, subdomain, tunnel_id, dns_record_ids, custom_hostname_id, tunnel_name, tunnel_config_source, tunnel_secret_encrypted
        FROM subdomains
        WHERE id = ?
      `,
      )
        .bind(createdServe.id)
        .first<StoredSubdomainRecord>();
      if (serveRecord) {
        await cleanupStoredSubdomain(c.env, serveRecord);
        await c.env.DB.prepare("UPDATE subdomains SET status = 'deleted', updated_at = ? WHERE id = ?")
          .bind(Date.now(), serveRecord.id)
          .run();
      }
    }

    if (createdPrimaryNew && createdPrimary) {
      const primaryRecord = await c.env.DB.prepare(
        `
        SELECT id, subdomain, tunnel_id, dns_record_ids, custom_hostname_id, tunnel_name, tunnel_config_source, tunnel_secret_encrypted
        FROM subdomains
        WHERE id = ?
      `,
      )
        .bind(createdPrimary.id)
        .first<StoredSubdomainRecord>();
      if (primaryRecord) {
        await cleanupStoredSubdomain(c.env, primaryRecord);
        await c.env.DB.prepare("UPDATE subdomains SET status = 'deleted', updated_at = ? WHERE id = ?")
          .bind(Date.now(), primaryRecord.id)
          .run();
      }
    }

    return c.json({ error: error instanceof Error ? error.message : 'Failed to reserve subdomain' }, 500);
  }
});

/**
 * Get locally-managed serve tunnel details for a root subdomain.
 * GET /subdomains/:subdomain
 */
app.get('/:subdomain', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');
  if (isServeSubdomain(subdomain)) {
    return c.json({ error: 'Fetch serve tunnel details through the root subdomain.' }, 400);
  }

  const rootRecord = await c.env.DB.prepare(
    `
    SELECT id
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'
  `,
  )
    .bind(subdomain, user.id)
    .first<{ id: string }>();
  if (!rootRecord) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  const serveRecord = await c.env.DB.prepare(
    `
    SELECT tunnel_id, tunnel_name, tunnel_config_source, tunnel_secret_encrypted
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active'
  `,
  )
    .bind(getServeRecordSubdomain(subdomain), user.id)
    .first<ExistingSubdomainRecord>();
  if (!serveRecord) {
    return c.json({ error: 'Serve tunnel not found' }, 404);
  }

  const details = await getStoredServeTunnelDetails(c.env, serveRecord);
  if (!details) {
    return c.json({ error: 'Serve tunnel is not locally managed for this subdomain' }, 409);
  }

  return c.json(details);
});

/**
 * Sync exact serve-route DNS records for a root subdomain.
 * PUT /subdomains/:subdomain/serve-routes
 */
app.put('/:subdomain/serve-routes', async (c) => {
  const user = c.get('user');
  const rootSubdomain = c.req.param('subdomain');
  if (isServeSubdomain(rootSubdomain)) {
    return c.json({ error: 'Sync serve routes through the root subdomain.' }, 400);
  }

  const body = await c.req.json<{ hostnames?: string[] }>();
  const requestedHostnames = Array.isArray(body.hostnames)
    ? body.hostnames.map((hostname) => normalizeServeRouteHostname(hostname)).filter(Boolean)
    : [];
  const serveDomain = getServeRouteDomain(c.env);

  for (const hostname of requestedHostnames) {
    if (!hostname.endsWith(`.${serveDomain}`)) {
      return c.json({ error: `Serve route ${hostname} must end with .${serveDomain}` }, 400);
    }
    if (!isOwnedServeRouteHostname(hostname, serveDomain, rootSubdomain)) {
      return c.json({
        error: `Serve route ${hostname} must be a single-label host ending with --${rootSubdomain}-srv.${serveDomain}`,
      }, 400);
    }
  }

  const serveRecord = await c.env.DB.prepare(
    `
    SELECT id, subdomain, tunnel_id, tunnel_name, tunnel_config_source, tunnel_secret_encrypted
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active'
  `,
  )
    .bind(getServeRecordSubdomain(rootSubdomain), user.id)
    .first<ExistingSubdomainRecord>();
  if (!serveRecord) {
    return c.json({ error: 'Serve tunnel not found' }, 404);
  }
  if (normalizeTunnelConfigSource(serveRecord.tunnel_config_source) !== 'local') {
    return c.json({ error: 'Serve tunnel is not locally managed for this subdomain' }, 409);
  }

  const existingRecords = await listServeRouteRecords(c.env, serveRecord.id);
  const nextHostnames = [...new Set(requestedHostnames)].sort();
  const nextHostnameSet = new Set(nextHostnames);

  const syncedRecords = await createServeRouteDnsRecords(c.env, nextHostnames, serveRecord.tunnel_id);
  const now = Date.now();
  for (const record of syncedRecords) {
    await c.env.DB.prepare(
      `
      INSERT INTO serve_route_records (id, serve_subdomain_id, hostname, dns_record_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hostname) DO UPDATE SET
        serve_subdomain_id = excluded.serve_subdomain_id,
        dns_record_id = excluded.dns_record_id,
        updated_at = excluded.updated_at
    `,
    )
      .bind(crypto.randomUUID(), serveRecord.id, record.hostname, record.dnsRecordId, now, now)
      .run();
  }

  const staleRecords = existingRecords.filter((record) => !nextHostnameSet.has(record.hostname));
  if (staleRecords.length > 0) {
    await deleteServeRouteDnsRecords(c.env, staleRecords.map((record) => record.dns_record_id));
    for (const record of staleRecords) {
      await c.env.DB.prepare('DELETE FROM serve_route_records WHERE id = ?').bind(record.id).run();
    }
  }

  return c.json({
    serveDomain,
    syncedHostnames: nextHostnames,
    deletedHostnames: staleRecords.map((record) => record.hostname).sort(),
  });
});

/**
 * Get tunnel token for a root subdomain (for CLI relay hosting).
 * GET /subdomains/:subdomain/token
 */
app.get('/:subdomain/token', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');
  if (isServeSubdomain(subdomain)) {
    return c.json({ error: 'Serve tunnels are locally managed and do not expose tunnel tokens' }, 400);
  }

  const record = await c.env.DB.prepare(
    `
    SELECT tunnel_token_encrypted
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'
  `,
  )
    .bind(subdomain, user.id)
    .first<{ tunnel_token_encrypted: string }>();
  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  const tunnelToken = await decryptToken(c.env, record.tunnel_token_encrypted);
  return c.json({ tunnelToken });
});

/**
 * Set a subdomain as primary.
 * POST /subdomains/:subdomain/set-primary
 */
app.post('/:subdomain/set-primary', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');
  if (isServeSubdomain(subdomain)) {
    return c.json({ error: 'Serve subdomains cannot be primary' }, 400);
  }

  const record = await c.env.DB.prepare(
    "SELECT id FROM subdomains WHERE subdomain = ? AND user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'",
  )
    .bind(subdomain, user.id)
    .first();
  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  await c.env.DB.prepare(
    "UPDATE subdomains SET is_primary = 0 WHERE user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'",
  )
    .bind(user.id)
    .run();

  await c.env.DB.prepare(
    'UPDATE subdomains SET is_primary = 1, updated_at = ? WHERE subdomain = ? AND user_id = ?',
  )
    .bind(Date.now(), subdomain, user.id)
    .run();

  return c.json({ success: true });
});

/**
 * Delete a subdomain.
 * DELETE /subdomains/:subdomain
 */
app.delete('/:subdomain', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');
  if (isServeSubdomain(subdomain)) {
    return c.json({ error: 'Serve subdomains cannot be deleted directly' }, 400);
  }

  const record = await c.env.DB.prepare(
    `
    SELECT id, subdomain, tunnel_id, dns_record_ids, custom_hostname_id, tunnel_name, tunnel_config_source, tunnel_secret_encrypted
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active'
  `,
  )
    .bind(subdomain, user.id)
    .first<StoredSubdomainRecord>();
  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  const recordsToDelete: StoredSubdomainRecord[] = [record];
  const serveRecord = await c.env.DB.prepare(
    `
    SELECT id, subdomain, tunnel_id, dns_record_ids, custom_hostname_id, tunnel_name, tunnel_config_source, tunnel_secret_encrypted
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active'
  `,
  )
    .bind(getServeRecordSubdomain(subdomain), user.id)
    .first<StoredSubdomainRecord>();
  if (serveRecord) {
    recordsToDelete.push(serveRecord);
  }

  const deletedAt = Date.now();
  for (const target of recordsToDelete) {
    await cleanupStoredSubdomain(c.env, target);
    await c.env.DB.prepare("UPDATE subdomains SET status = 'deleted', updated_at = ? WHERE id = ?")
      .bind(deletedAt, target.id)
      .run();
  }

  return c.json({ success: true });
});

export default app;
