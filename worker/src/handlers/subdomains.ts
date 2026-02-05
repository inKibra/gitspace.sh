/**
 * Subdomain handlers
 *
 * CRUD operations for subdomains and tunnel management
 */

import { Hono } from 'hono';
import type { Env, Subdomain } from '../types';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { reservedSubdomains, subdomains as subdomainsTable } from '../db/schema';
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
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: subdomainsTable.id,
      subdomain: subdomainsTable.subdomain,
      status: subdomainsTable.status,
      is_primary: subdomainsTable.isPrimary,
      created_at: subdomainsTable.createdAt,
      updated_at: subdomainsTable.updatedAt,
    })
    .from(subdomainsTable)
    .where(and(eq(subdomainsTable.userId, user.id), ne(subdomainsTable.status, 'deleted')))
    .orderBy(desc(subdomainsTable.isPrimary), desc(subdomainsTable.createdAt))
    .all();

  return c.json(rows);
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

  if (name === 'serve') {
    return c.json({ available: false, reason: 'This subdomain is reserved' });
  }

  // Check reserved
  const db = getDb(c.env);
  const reserved = await db
    .select({ subdomain: reservedSubdomains.subdomain })
    .from(reservedSubdomains)
    .where(eq(reservedSubdomains.subdomain, name))
    .get();

  if (reserved) {
    return c.json({ available: false, reason: 'This subdomain is reserved' });
  }

  // Check taken
  const existing = await db
    .select({ id: subdomainsTable.id })
    .from(subdomainsTable)
    .where(and(eq(subdomainsTable.subdomain, name), ne(subdomainsTable.status, 'deleted')))
    .get();

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
  const db = getDb(c.env);

  // Validate format
  if (!subdomain || !SUBDOMAIN_REGEX.test(subdomain)) {
    return c.json(
      {
        error: 'Invalid subdomain format. Use 3-20 lowercase letters, numbers, and hyphens.',
      },
      400
    );
  }

  if (subdomain === 'serve') {
    return c.json({ error: 'This subdomain is reserved' }, 400);
  }

  // Check reserved
  const reserved = await db
    .select({ reason: reservedSubdomains.reason })
    .from(reservedSubdomains)
    .where(eq(reservedSubdomains.subdomain, subdomain))
    .get();

  if (reserved) {
    return c.json({ error: `This subdomain is reserved (${reserved.reason})` }, 400);
  }

  // Check if subdomain exists
  const existing = await db
    .select({ id: subdomainsTable.id, user_id: subdomainsTable.userId, status: subdomainsTable.status })
    .from(subdomainsTable)
    .where(eq(subdomainsTable.subdomain, subdomain))
    .get();

  if (existing) {
    // If it belongs to another user and is active, reject
    if (existing.user_id !== user.id && existing.status !== 'deleted') {
      return c.json({ error: 'This subdomain is already taken' }, 400);
    }

    // If it's the same user or was deleted, we'll reconfigure it
    // Delete the old record first (we'll create a fresh one)
    if (existing.user_id === user.id || existing.status === 'deleted') {
      await db.delete(subdomainsTable).where(eq(subdomainsTable.id, existing.id)).run();
    }
  }

  // Check user's subdomain limit
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(subdomainsTable)
    .where(and(eq(subdomainsTable.userId, user.id), eq(subdomainsTable.status, 'active')))
    .get();

  const count = countResult?.count ?? 0;
  if (count >= FREE_SUBDOMAIN_LIMIT) {
    return c.json(
      { error: `Subdomain limit reached (${FREE_SUBDOMAIN_LIMIT} for free tier)` },
      400
    );
  }

  const serveSubdomain = `${subdomain}.serve`;

  // Create tunnel via Cloudflare API
  let tunnel;
  let serveTunnel;
  try {
    tunnel = await createTunnel(c.env, subdomain);
  } catch (error) {
    console.error('Tunnel creation failed:', error);
    return c.json({ error: 'Failed to create tunnel' }, 500);
  }

  try {
    serveTunnel = await createTunnel(c.env, serveSubdomain);
  } catch (error) {
    console.error('Serve tunnel creation failed:', error);
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    return c.json({ error: 'Failed to create serve tunnel' }, 500);
  }

  // Configure tunnel ingress (routes traffic to local relay on port 4480)
  try {
    await configureTunnelIngress(c.env, tunnel.id, subdomain);
  } catch (error) {
    // Cleanup: delete the tunnel we just created
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    if (serveTunnel) {
      await deleteTunnel(c.env, serveTunnel.id).catch(() => {});
    }
    console.error('Tunnel ingress configuration failed:', error);
    return c.json({ error: 'Failed to configure tunnel' }, 500);
  }

  try {
    await configureTunnelIngress(c.env, serveTunnel.id, serveSubdomain);
  } catch (error) {
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    await deleteTunnel(c.env, serveTunnel.id).catch(() => {});
    console.error('Serve tunnel ingress configuration failed:', error);
    return c.json({ error: 'Failed to configure serve tunnel' }, 500);
  }

  // Create DNS records
  let dnsRecordIds: string[];
  let serveDnsRecordIds: string[];
  try {
    dnsRecordIds = await createDNSRecords(c.env, subdomain, tunnel.id);
  } catch (error) {
    // Cleanup: delete the tunnel we just created
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    await deleteTunnel(c.env, serveTunnel.id).catch(() => {});
    console.error('DNS creation failed:', error);
    return c.json({ error: 'Failed to create DNS records' }, 500);
  }

  try {
    serveDnsRecordIds = await createDNSRecords(c.env, serveSubdomain, serveTunnel.id);
  } catch (error) {
    await deleteTunnel(c.env, tunnel.id).catch(() => {});
    await deleteTunnel(c.env, serveTunnel.id).catch(() => {});
    await deleteDNSRecords(c.env, dnsRecordIds).catch(() => {});
    console.error('Serve DNS creation failed:', error);
    return c.json({ error: 'Failed to create serve DNS records' }, 500);
  }

  // Create custom hostname for wildcard SSL (Cloudflare for SaaS)
  let customHostnameId: string | null = null;
  let serveCustomHostnameId: string | null = null;
  try {
    const customHostname = await createCustomHostname(c.env, subdomain);
    customHostnameId = customHostname.id;
    console.log(`Custom hostname created: ${customHostname.hostname} (${customHostname.status})`);
  } catch (error) {
    // Non-fatal: wildcard SSL won't work but base subdomain will
    console.error('Custom hostname creation failed (non-fatal):', error);
  }

  try {
    const customHostname = await createCustomHostname(c.env, serveSubdomain);
    serveCustomHostnameId = customHostname.id;
    console.log(`Serve custom hostname created: ${customHostname.hostname} (${customHostname.status})`);
  } catch (error) {
    console.error('Serve custom hostname creation failed (non-fatal):', error);
  }

  // Encrypt tunnel token for storage
  const encryptedToken = await encryptToken(c.env, tunnel.token);
  const serveEncryptedToken = await encryptToken(c.env, serveTunnel.token);

  // Check if this is user's first subdomain (set as primary)
  const isPrimary = count === 0 || body.isPrimary;

  // If setting as primary, unset other primaries
  if (isPrimary) {
    await db
      .update(subdomainsTable)
      .set({ isPrimary: 0 })
      .where(and(eq(subdomainsTable.userId, user.id), eq(subdomainsTable.status, 'active')))
      .run();
  }

  // Store in database
  const now = Date.now();
  const subdomainId = crypto.randomUUID();

  await db
    .insert(subdomainsTable)
    .values({
      id: subdomainId,
      subdomain,
      userId: user.id,
      tunnelId: tunnel.id,
      serveTunnelId: serveTunnel.id,
      dnsRecordIds: JSON.stringify(dnsRecordIds),
      serveDnsRecordIds: JSON.stringify(serveDnsRecordIds),
      customHostnameId,
      serveCustomHostnameId,
      tunnelTokenEncrypted: encryptedToken,
      serveTunnelTokenEncrypted: serveEncryptedToken,
      status: 'active',
      isPrimary: isPrimary ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return c.json({
    id: subdomainId,
    subdomain,
    tunnelToken: tunnel.token,
    serveSubdomain,
    serveTunnelToken: serveTunnel.token,
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
  const isServe = subdomain.endsWith('.serve');
  const baseSubdomain = isServe ? subdomain.slice(0, -'.serve'.length) : subdomain;
  const db = getDb(c.env);

  const record = await db
    .select({
      tunnel_token_encrypted: subdomainsTable.tunnelTokenEncrypted,
      serve_tunnel_token_encrypted: subdomainsTable.serveTunnelTokenEncrypted,
    })
    .from(subdomainsTable)
    .where(and(
      eq(subdomainsTable.subdomain, baseSubdomain),
      eq(subdomainsTable.userId, user.id),
      eq(subdomainsTable.status, 'active')
    ))
    .get();

  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  const encrypted = isServe ? record.serve_tunnel_token_encrypted : record.tunnel_token_encrypted;
  if (!encrypted) {
    return c.json({ error: 'Tunnel token not found' }, 404);
  }
  const tunnelToken = await decryptToken(c.env, encrypted);

  return c.json({ tunnelToken });
});

/**
 * Set a subdomain as primary
 * POST /subdomains/:subdomain/set-primary
 */
app.post('/:subdomain/set-primary', async (c) => {
  const user = c.get('user');
  const subdomain = c.req.param('subdomain');
  const db = getDb(c.env);

  // Verify ownership
  const record = await db
    .select({ id: subdomainsTable.id })
    .from(subdomainsTable)
    .where(and(
      eq(subdomainsTable.subdomain, subdomain),
      eq(subdomainsTable.userId, user.id),
      eq(subdomainsTable.status, 'active')
    ))
    .get();

  if (!record) {
    return c.json({ error: 'Subdomain not found' }, 404);
  }

  // Unset all primaries
  await db
    .update(subdomainsTable)
    .set({ isPrimary: 0 })
    .where(and(eq(subdomainsTable.userId, user.id), eq(subdomainsTable.status, 'active')))
    .run();

  // Set this one as primary
  await db
    .update(subdomainsTable)
    .set({ isPrimary: 1, updatedAt: Date.now() })
    .where(and(eq(subdomainsTable.subdomain, subdomain), eq(subdomainsTable.userId, user.id)))
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
  const baseSubdomain = subdomain.endsWith('.serve')
    ? subdomain.slice(0, -'.serve'.length)
    : subdomain;
  const db = getDb(c.env);

  const record = await db
    .select({
      id: subdomainsTable.id,
      tunnel_id: subdomainsTable.tunnelId,
      serve_tunnel_id: subdomainsTable.serveTunnelId,
      dns_record_ids: subdomainsTable.dnsRecordIds,
      serve_dns_record_ids: subdomainsTable.serveDnsRecordIds,
      custom_hostname_id: subdomainsTable.customHostnameId,
      serve_custom_hostname_id: subdomainsTable.serveCustomHostnameId,
    })
    .from(subdomainsTable)
    .where(and(
      eq(subdomainsTable.subdomain, baseSubdomain),
      eq(subdomainsTable.userId, user.id),
      eq(subdomainsTable.status, 'active')
    ))
    .get();

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

  if (record.serve_tunnel_id) {
    try {
      await deleteTunnel(c.env, record.serve_tunnel_id);
    } catch (error) {
      console.error('Serve tunnel deletion failed:', error);
    }
  }

  // Delete DNS records
  try {
    const dnsRecordIds = JSON.parse(record.dns_record_ids) as string[];
    await deleteDNSRecords(c.env, dnsRecordIds);
  } catch (error) {
    console.error('DNS deletion failed:', error);
    // Continue anyway
  }

  if (record.serve_dns_record_ids) {
    try {
      const dnsRecordIds = JSON.parse(record.serve_dns_record_ids) as string[];
      await deleteDNSRecords(c.env, dnsRecordIds);
    } catch (error) {
      console.error('Serve DNS deletion failed:', error);
    }
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

  if (record.serve_custom_hostname_id) {
    try {
      await deleteCustomHostname(c.env, record.serve_custom_hostname_id);
    } catch (error) {
      console.error('Serve custom hostname deletion failed:', error);
    }
  }

  // Mark as deleted in database
  await db
    .update(subdomainsTable)
    .set({ status: 'deleted', updatedAt: Date.now() })
    .where(eq(subdomainsTable.id, record.id))
    .run();

  return c.json({ success: true });
});

export default app;
