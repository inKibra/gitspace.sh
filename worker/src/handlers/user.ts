/**
 * User handlers
 *
 * Endpoints for user profile and token management
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import type { AuthContext } from '../middleware/auth';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import { tokens as tokensTable, users as usersTable } from '../db/schema';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

/**
 * Get current user info
 * GET /me
 */
app.get('/', (c) => {
  const user = c.get('user');

  return c.json({
    id: user.id,
    github_username: user.github_username,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    created_at: user.created_at,
  });
});

/**
 * List user's tokens
 * GET /me/tokens
 */
app.get('/tokens', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: tokensTable.id,
      prefix: tokensTable.prefix,
      device_name: tokensTable.deviceName,
      device_fingerprint: tokensTable.deviceFingerprint,
      created_at: tokensTable.createdAt,
      expires_at: tokensTable.expiresAt,
      last_used_at: tokensTable.lastUsedAt,
    })
    .from(tokensTable)
    .where(and(eq(tokensTable.userId, user.id), isNull(tokensTable.revokedAt)))
    .orderBy(desc(tokensTable.createdAt))
    .all();

  return c.json(rows);
});

/**
 * Revoke a token
 * DELETE /me/tokens/:tokenId
 */
app.delete('/tokens/:tokenId', async (c) => {
  const user = c.get('user');
  const tokenId = c.req.param('tokenId');
  const db = getDb(c.env);
  const result = await db
    .update(tokensTable)
    .set({ revokedAt: Date.now() })
    .where(and(eq(tokensTable.id, tokenId), eq(tokensTable.userId, user.id)))
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return c.json({ error: 'Token not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * Delete user account (and all associated data)
 * DELETE /me
 */
app.delete('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env);

  // This will cascade delete tokens, sessions, subdomains, etc.
  await db.delete(usersTable).where(eq(usersTable.id, user.id)).run();

  return c.json({ success: true });
});

export default app;
