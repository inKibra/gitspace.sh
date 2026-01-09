/**
 * User handlers
 *
 * Endpoints for user profile and token management
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import type { AuthContext } from '../middleware/auth';

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

  const tokens = await c.env.DB.prepare(
    `
    SELECT id, prefix, device_name, device_fingerprint, created_at, expires_at, last_used_at
    FROM tokens
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `
  )
    .bind(user.id)
    .all();

  return c.json(
    tokens.results.map((t) => ({
      id: t.id,
      prefix: t.prefix,
      device_name: t.device_name,
      created_at: t.created_at,
      expires_at: t.expires_at,
      last_used_at: t.last_used_at,
    }))
  );
});

/**
 * Revoke a token
 * DELETE /me/tokens/:tokenId
 */
app.delete('/tokens/:tokenId', async (c) => {
  const user = c.get('user');
  const tokenId = c.req.param('tokenId');

  const result = await c.env.DB.prepare(
    `
    UPDATE tokens
    SET revoked_at = ?
    WHERE id = ? AND user_id = ?
  `
  )
    .bind(Date.now(), tokenId, user.id)
    .run();

  if (result.meta.changes === 0) {
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

  // This will cascade delete tokens, sessions, subdomains, etc.
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

  return c.json({ success: true });
});

export default app;
