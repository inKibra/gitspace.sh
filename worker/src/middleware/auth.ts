/**
 * Authentication middleware for protected routes
 *
 * Validates Bearer tokens and attaches user to context.
 * Tokens are stored as SHA-256 hashes in D1.
 */

import type { Context, Next } from 'hono';
import type { Env, User, Token } from '../types';

export interface AuthContext {
  user: User;
  token: Token;
}

/**
 * Hash a token using SHA-256
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Middleware to validate Bearer token and attach user to context
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AuthContext }>,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const tokenPlain = authHeader.slice(7);

  // Validate token format
  if (!tokenPlain.startsWith('gst_') || tokenPlain.length < 20) {
    return c.json({ error: 'Invalid token format' }, 401);
  }

  // Hash token to look up in database
  const tokenHash = await hashToken(tokenPlain);

  // Look up token and join with user
  const result = await c.env.DB.prepare(`
    SELECT
      t.id as token_id, t.prefix, t.user_id, t.device_name, t.device_fingerprint,
      t.created_at as token_created_at, t.expires_at, t.last_used_at, t.revoked_at,
      u.id, u.github_id, u.github_username, u.email, u.name, u.avatar_url,
      u.created_at, u.updated_at
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.id = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > ?)
  `)
    .bind(tokenHash, Date.now())
    .first();

  if (!result) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  // Build user and token objects
  const user: User = {
    id: result.id as string,
    github_id: result.github_id as string,
    github_username: result.github_username as string,
    email: result.email as string | null,
    name: result.name as string | null,
    avatar_url: result.avatar_url as string | null,
    created_at: result.created_at as number,
    updated_at: result.updated_at as number,
  };

  const token: Token = {
    id: result.token_id as string,
    prefix: result.prefix as string,
    user_id: result.user_id as string,
    device_name: result.device_name as string | null,
    device_fingerprint: result.device_fingerprint as string | null,
    created_at: result.token_created_at as number,
    expires_at: result.expires_at as number | null,
    last_used_at: result.last_used_at as number | null,
    revoked_at: result.revoked_at as number | null,
  };

  // Enforce device fingerprint binding when present
  if (token.device_fingerprint) {
    const deviceFingerprint = c.req.header('X-Device-Fingerprint');
    if (!deviceFingerprint) {
      return c.json({ error: 'Missing device fingerprint' }, 401);
    }
    if (deviceFingerprint !== token.device_fingerprint) {
      return c.json({ error: 'Invalid device fingerprint' }, 401);
    }
  }

  // Attach to context
  c.set('user', user);
  c.set('token', token);

  // Update last_used_at (fire-and-forget)
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')
      .bind(Date.now(), tokenHash)
      .run()
  );

  await next();
}

/**
 * Validate a session cookie (for portal)
 */
export async function validateSession(
  db: D1Database,
  sessionId: string
): Promise<User | null> {
  const result = await db
    .prepare(
      `
    SELECT u.*
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > ?
  `
    )
    .bind(sessionId, Date.now())
    .first();

  if (!result) {
    return null;
  }

  return {
    id: result.id as string,
    github_id: result.github_id as string,
    github_username: result.github_username as string,
    email: result.email as string | null,
    name: result.name as string | null,
    avatar_url: result.avatar_url as string | null,
    created_at: result.created_at as number,
    updated_at: result.updated_at as number,
  };
}
