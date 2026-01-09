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

/**
 * List user's subdomains
 * GET /subdomains
 */
app.get('/', async (c) => {
  const user = c.get('user');

  const subdomains = await c.env.DB.prepare(
    `
    SELECT id, subdomain, status, is_primary, created_at, updated_at
    FROM subdomains
    WHERE user_id = ? AND status != 'deleted'
    ORDER BY is_primary DESC, created_at DESC
  `
  )
    .bind(user.id)
    .all();

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
    "SELECT id, user_id, status FROM subdomains WHERE subdomain = ?"
  )
    .bind(subdomain)
    .first<{ id: string; user_id: string; status: string }>();

  if (existing) {
    // If it belongs to another user and is active, reject
    if (existing.user_id !== user.id && existing.status !== 'deleted') {
      return c.json({ error: 'This subdomain is already taken' }, 400);
    }

    // If it's the same user or was deleted, we'll reconfigure it
    // Delete the old record first (we'll create a fresh one)
    if (existing.user_id === user.id || existing.status === 'deleted') {
      await c.env.DB.prepare('DELETE FROM subdomains WHERE id = ?')
        .bind(existing.id)
        .run();
    }
  }

  // Check user's subdomain limit
  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM subdomains WHERE user_id = ? AND status = 'active'"
  )
    .bind(user.id)
    .first<{ count: number }>();

  const count = countResult?.count ?? 0;
  if (count >= FREE_SUBDOMAIN_LIMIT) {
    return c.json(
      { error: `Subdomain limit reached (${FREE_SUBDOMAIN_LIMIT} for free tier)` },
      400
    );
  }

  // Create tunnel via Cloudflare API
  let tunnel;
  try {
    tunnel = await createTunnel(c.env, subdomain);
  } catch (error) {
    console.error('Tunnel creation failed:', error);
    return c.json({ error: 'Failed to create tunnel' }, 500);
  }

  // Configure tunnel ingress (routes traffic to local relay on port 4480)
  try {
    await configureTunnelIngress(c.env, tunnel.id, subdomain);
  } catch (error) {
    // Cleanup: delete the tunnel we just created
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    console.error('Tunnel ingress configuration failed:', error);
    return c.json({ error: 'Failed to configure tunnel' }, 500);
  }

  // Create DNS records
  let dnsRecordIds: string[];
  try {
    dnsRecordIds = await createDNSRecords(c.env, subdomain, tunnel.id);
  } catch (error) {
    // Cleanup: delete the tunnel we just created
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    console.error('DNS creation failed:', error);
    return c.json({ error: 'Failed to create DNS records' }, 500);
  }

  // Create custom hostname for wildcard SSL (Cloudflare for SaaS)
  let customHostnameId: string | null = null;
  try {
    const customHostname = await createCustomHostname(c.env, subdomain);
    customHostnameId = customHostname.id;
    console.log(`Custom hostname created: ${customHostname.hostname} (${customHostname.status})`);
  } catch (error) {
    // Non-fatal: wildcard SSL won't work but base subdomain will
    console.error('Custom hostname creation failed (non-fatal):', error);
  }

  // Encrypt tunnel token for storage
  const encryptedToken = await encryptToken(c.env, tunnel.token);

  // Check if this is user's first subdomain (set as primary)
  const isPrimary = count === 0 || body.isPrimary;

  // If setting as primary, unset other primaries
  if (isPrimary) {
    await c.env.DB.prepare(
      "UPDATE subdomains SET is_primary = 0 WHERE user_id = ? AND status = 'active'"
    )
      .bind(user.id)
      .run();
  }

  // Store in database
  const now = Date.now();
  const subdomainId = crypto.randomUUID();

  await c.env.DB.prepare(
    `
    INSERT INTO subdomains (
      id, subdomain, user_id, tunnel_id, dns_record_ids, custom_hostname_id,
      tunnel_token_encrypted, status, is_primary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      subdomainId,
      subdomain,
      user.id,
      tunnel.id,
      JSON.stringify(dnsRecordIds),
      customHostnameId,
      encryptedToken,
      'active',
      isPrimary ? 1 : 0,
      now,
      now
    )
    .run();

  return c.json({
    id: subdomainId,
    subdomain,
    hosts: [`${subdomain}.gitspace.sh`, `*.${subdomain}.gitspace.sh`],
    isPrimary,
  });
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

  // Verify ownership
  const record = await c.env.DB.prepare(
    "SELECT id FROM subdomains WHERE subdomain = ? AND user_id = ? AND status = 'active'"
  )
    .bind(subdomain, user.id)
    .first();

  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  // Unset all primaries
  await c.env.DB.prepare(
    "UPDATE subdomains SET is_primary = 0 WHERE user_id = ? AND status = 'active'"
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

  // Delete tunnel (this immediately blocks new connections)
  try {
    await deleteTunnel(c.env, record.tunnel_id);
  } catch (error) {
    console.error('Tunnel deletion failed:', error);
    // Continue anyway to clean up database
  }

  // Delete DNS records
  try {
    const dnsRecordIds = JSON.parse(record.dns_record_ids) as string[];
    await deleteDNSRecords(c.env, dnsRecordIds);
  } catch (error) {
    console.error('DNS deletion failed:', error);
    // Continue anyway
  }

  // Delete custom hostname (Cloudflare for SaaS)
  if (record.custom_hostname_id) {
    try {
      await deleteCustomHostname(c.env, record.custom_hostname_id);
    } catch (error) {
      console.error('Custom hostname deletion failed:', error);
      // Continue anyway
    }
  }

  // Mark as deleted in database
  await c.env.DB.prepare(
    "UPDATE subdomains SET status = 'deleted', updated_at = ? WHERE id = ?"
  )
    .bind(Date.now(), record.id)
    .run();

  return c.json({ success: true });
});

export default app;
