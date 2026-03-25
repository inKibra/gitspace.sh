/**
 * Subdomain handlers
 *
 * CRUD operations for subdomains and tunnel management
 */

import { Hono } from 'hono';
import type { Env, Subdomain } from '../types';
import type { AuthContext } from '../middleware/auth';
import {
  createTunnel,
  configureTunnelIngress,
  deleteTunnel,
  createDNSRecords,
  deleteDNSRecords,
  createCustomHostname,
  deleteCustomHostname,
  encryptToken,
  decryptToken,
} from '../services/cloudflare';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

// Subdomain limits
const FREE_SUBDOMAIN_LIMIT = 3;
const PAID_SUBDOMAIN_LIMIT = 10;

// Subdomain format validation
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;

function isServeSubdomain(subdomain: string): boolean {
  return subdomain.endsWith('.serve');
}

function getServeSubdomain(subdomain: string): string {
  return `${subdomain}.serve`;
}

interface StoredSubdomainRecord {
  id: string;
  tunnel_id: string;
  dns_record_ids: string;
  custom_hostname_id: string | null;
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
  serveSubdomain: string | null;
  serveStatus: string | null;
}

async function getStoredTunnelToken(env: Env, record: Pick<ExistingSubdomainRecord, 'tunnel_token_encrypted'>): Promise<string> {
  return decryptToken(env, record.tunnel_token_encrypted);
}

async function cleanupStoredSubdomain(env: Env, record: StoredSubdomainRecord): Promise<void> {
  try {
    await deleteTunnel(env, record.tunnel_id);
  } catch (error) {
    console.error('Tunnel deletion failed:', error);
  }

  try {
    const dnsRecordIds = JSON.parse(record.dns_record_ids) as string[];
    await deleteDNSRecords(env, dnsRecordIds);
  } catch (error) {
    console.error('DNS deletion failed:', error);
  }

  if (record.custom_hostname_id) {
    try {
      await deleteCustomHostname(env, record.custom_hostname_id);
    } catch (error) {
      console.error('Custom hostname deletion failed:', error);
    }
  }
}

async function hardDeleteStoredSubdomain(env: Env, record: StoredSubdomainRecord): Promise<void> {
  await cleanupStoredSubdomain(env, record);
  await env.DB.prepare('DELETE FROM subdomains WHERE id = ?').bind(record.id).run();
}

async function createManagedSubdomain(
  env: Env,
  userId: string,
  subdomain: string,
  isPrimary: boolean,
): Promise<{ id: string; tunnelToken: string }> {
  let tunnel;
  try {
    tunnel = await createTunnel(env, subdomain);
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

  let dnsRecordIds: string[];
  try {
    dnsRecordIds = await createDNSRecords(env, subdomain, tunnel.id);
  } catch (error) {
    await deleteTunnel(env, tunnel.id).catch(() => {});
    console.error('DNS creation failed:', error);
    throw new Error('Failed to create DNS records');
  }

  let customHostnameId: string | null = null;
  try {
    const customHostname = await createCustomHostname(env, subdomain);
    customHostnameId = customHostname.id;
    console.log(`Custom hostname created: ${customHostname.hostname} (${customHostname.status})`);
  } catch (error) {
    console.error('Custom hostname creation failed (non-fatal):', error);
  }

  const now = Date.now();
  const subdomainId = crypto.randomUUID();

  try {
    const encryptedToken = await encryptToken(env, tunnel.token);

    await env.DB.prepare(
      `
      INSERT INTO subdomains (
        id, subdomain, user_id, tunnel_id, dns_record_ids, custom_hostname_id,
        tunnel_token_encrypted, status, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
      .bind(
        subdomainId,
        subdomain,
        userId,
        tunnel.id,
        JSON.stringify(dnsRecordIds),
        customHostnameId,
        encryptedToken,
        'active',
        isPrimary ? 1 : 0,
        now,
        now,
      )
      .run();
  } catch (error) {
    await Promise.allSettled([
      deleteTunnel(env, tunnel.id),
      deleteDNSRecords(env, dnsRecordIds),
      customHostnameId ? deleteCustomHostname(env, customHostnameId) : Promise.resolve(),
    ]);
    throw error;
  }

  return { id: subdomainId, tunnelToken: tunnel.token };
}

/**
 * List user's subdomains
 * GET /subdomains
 */
app.get('/', async (c) => {
  const user = c.get('user');

  const subdomains = await c.env.DB.prepare(
    `
    SELECT
      primary_subdomains.id,
      primary_subdomains.subdomain,
      primary_subdomains.status,
      primary_subdomains.is_primary,
      primary_subdomains.created_at,
      primary_subdomains.updated_at,
      serve_subdomains.subdomain AS serveSubdomain,
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
  `
  )
    .bind(user.id)
    .all<ListedSubdomainRecord>();

  return c.json(subdomains.results);
});

/**
 * Check subdomain availability
 * GET /subdomains/check?name=xxx
 */
app.get('/check', async (c) => {
  const name = c.req.query('name')?.toLowerCase();

  if (!name) {
    return c.json({ available: false, reason: 'Subdomain name required' });
  }

  // Check format
  if (!SUBDOMAIN_REGEX.test(name)) {
    return c.json({
      available: false,
      reason: 'Invalid format. Use 3-20 lowercase letters, numbers, and hyphens.',
    });
  }

  // Check reserved
  const reserved = await c.env.DB.prepare(
    'SELECT 1 FROM reserved_subdomains WHERE subdomain = ?'
  )
    .bind(name)
    .first();

  if (reserved) {
    return c.json({ available: false, reason: 'This subdomain is reserved' });
  }

  // Check taken
  const existing = await c.env.DB.prepare(
    "SELECT 1 FROM subdomains WHERE subdomain = ? AND status != 'deleted'"
  )
    .bind(name)
    .first();

  if (existing) {
    return c.json({ available: false, reason: 'This subdomain is already taken' });
  }

  return c.json({ available: true });
});

/**
 * Reserve a subdomain
 * POST /subdomains
 */
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ subdomain: string; isPrimary?: boolean }>();
  const subdomain = body.subdomain?.toLowerCase();

  // Validate format
  if (!subdomain || !SUBDOMAIN_REGEX.test(subdomain)) {
    return c.json(
      {
        error: 'Invalid subdomain format. Use 3-20 lowercase letters, numbers, and hyphens.',
      },
      400
    );
  }

  // Check reserved
  const reserved = await c.env.DB.prepare(
    'SELECT reason FROM reserved_subdomains WHERE subdomain = ?'
  )
    .bind(subdomain)
    .first<{ reason: string }>();

  if (reserved) {
    return c.json({ error: `This subdomain is reserved (${reserved.reason})` }, 400);
  }

  // Check if subdomain exists
  const existing = await c.env.DB.prepare(
    `
    SELECT id, user_id, status, tunnel_id, dns_record_ids, custom_hostname_id, tunnel_token_encrypted, is_primary
    FROM subdomains
    WHERE subdomain = ?
  `
  )
    .bind(subdomain)
    .first<ExistingSubdomainRecord>();

  if (existing) {
    // If it belongs to another user and is active, reject
    if (existing.user_id !== user.id && existing.status !== 'deleted') {
      return c.json({ error: 'This subdomain is already taken' }, 400);
    }
    if (existing.status === 'deleted') {
      await hardDeleteStoredSubdomain(c.env, existing);
    }
  }

  // Check user's subdomain limit
  const countResult = await c.env.DB.prepare(
    `
    SELECT COUNT(*) as count
    FROM subdomains
    WHERE user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve' AND subdomain != ?
  `
  )
    .bind(user.id, subdomain)
    .first<{ count: number }>();

  const count = countResult?.count ?? 0;
  if (count >= FREE_SUBDOMAIN_LIMIT) {
    return c.json(
      { error: `Subdomain limit reached (${FREE_SUBDOMAIN_LIMIT} for free tier)` },
      400
    );
  }

  // Check if this is user's first subdomain (set as primary)
  const isPrimary = existing?.user_id === user.id && existing.status === 'active' && existing.is_primary === 1
    ? true
    : count === 0 || Boolean(body.isPrimary);

  const serveSubdomain = getServeSubdomain(subdomain);
  const existingServe = await c.env.DB.prepare(
    `
    SELECT id, user_id, status, tunnel_id, dns_record_ids, custom_hostname_id, tunnel_token_encrypted, is_primary
    FROM subdomains
    WHERE subdomain = ?
  `
  )
    .bind(serveSubdomain)
    .first<ExistingSubdomainRecord>();

  if (existingServe) {
    if (existingServe.user_id !== user.id && existingServe.status !== 'deleted') {
      return c.json({ error: 'Serve subdomain is already taken' }, 400);
    }
    if (existingServe.status === 'deleted') {
      await hardDeleteStoredSubdomain(c.env, existingServe);
    }
  }

  let createdPrimary: { id: string; tunnelToken: string } | null = null;
  let createdServe: { id: string; tunnelToken: string } | null = null;
  let createdPrimaryNew = false;
  let createdServeNew = false;

  try {
    if (existing && existing.user_id === user.id && existing.status === 'active') {
      createdPrimary = {
        id: existing.id,
        tunnelToken: await getStoredTunnelToken(c.env, existing),
      };
    } else {
      createdPrimary = await createManagedSubdomain(c.env, user.id, subdomain, false);
      createdPrimaryNew = true;
    }

    if (existingServe && existingServe.user_id === user.id && existingServe.status === 'active') {
      createdServe = {
        id: existingServe.id,
        tunnelToken: await getStoredTunnelToken(c.env, existingServe),
      };
    } else {
      createdServe = await createManagedSubdomain(c.env, user.id, serveSubdomain, false);
      createdServeNew = true;
    }

    if (isPrimary) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE subdomains SET is_primary = 0 WHERE user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'"
        ).bind(user.id),
        c.env.DB.prepare(
          "UPDATE subdomains SET is_primary = 1, updated_at = ? WHERE id = ?"
        ).bind(Date.now(), createdPrimary.id),
      ]);
    }

    return c.json({
      id: createdPrimary.id,
      subdomain,
      tunnelToken: createdPrimary.tunnelToken,
      serveSubdomain,
      serveTunnelToken: createdServe.tunnelToken,
      hosts: [`${subdomain}.gitspace.sh`, `*.${subdomain}.gitspace.sh`],
      isPrimary,
    });
  } catch (error) {
    if (createdServeNew && createdServe) {
      const serveRecord = await c.env.DB.prepare(
        `
        SELECT id, tunnel_id, dns_record_ids, custom_hostname_id
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
        SELECT id, tunnel_id, dns_record_ids, custom_hostname_id
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
 * Get tunnel token for a subdomain (for CLI)
 * GET /subdomains/:subdomain/token
 */
app.get('/:subdomain/token', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');

  const record = await c.env.DB.prepare(
    `
    SELECT tunnel_token_encrypted
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active'
  `
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
 * Set a subdomain as primary
 * POST /subdomains/:subdomain/set-primary
 */
app.post('/:subdomain/set-primary', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');

  if (isServeSubdomain(subdomain)) {
    return c.json({ error: 'Serve subdomains cannot be primary' }, 400);
  }

  // Verify ownership
  const record = await c.env.DB.prepare(
    "SELECT id FROM subdomains WHERE subdomain = ? AND user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'"
  )
    .bind(subdomain, user.id)
    .first();

  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  // Unset all primaries
  await c.env.DB.prepare(
    "UPDATE subdomains SET is_primary = 0 WHERE user_id = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'"
  )
    .bind(user.id)
    .run();

  // Set this one as primary
  await c.env.DB.prepare(
    'UPDATE subdomains SET is_primary = 1, updated_at = ? WHERE subdomain = ? AND user_id = ?'
  )
    .bind(Date.now(), subdomain, user.id)
    .run();

  return c.json({ success: true });
});

/**
 * Delete a subdomain
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
    SELECT id, tunnel_id, dns_record_ids, custom_hostname_id
    FROM subdomains
    WHERE subdomain = ? AND user_id = ? AND status = 'active'
  `
  )
    .bind(subdomain, user.id)
    .first<{ id: string; tunnel_id: string; dns_record_ids: string; custom_hostname_id: string | null }>();

  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  const recordsToDelete: Array<StoredSubdomainRecord> = [record];
  if (!isServeSubdomain(subdomain)) {
    const serveRecord = await c.env.DB.prepare(
      `
      SELECT id, tunnel_id, dns_record_ids, custom_hostname_id
      FROM subdomains
      WHERE subdomain = ? AND user_id = ? AND status = 'active'
    `,
    )
      .bind(getServeSubdomain(subdomain), user.id)
      .first<StoredSubdomainRecord>();

    if (serveRecord) {
      recordsToDelete.push(serveRecord);
    }
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
