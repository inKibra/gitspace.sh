/**
 * Authentication middleware for protected routes
 *
 * Validates Bearer tokens and attaches user to context.
 * Tokens are stored as SHA-256 hashes in D1.
 */

import type { Context, Next } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, User, Token } from '../types';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { getDb } from '../db/client';
import { tokens as tokensTable, users as usersTable, sessions as sessionsTable } from '../db/schema';

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
  const db = getDb(c.env);
  const result = await db
    .select({
      token_id: tokensTable.id,
      prefix: tokensTable.prefix,
      user_id: tokensTable.userId,
      device_name: tokensTable.deviceName,
      device_fingerprint: tokensTable.deviceFingerprint,
      token_created_at: tokensTable.createdAt,
      expires_at: tokensTable.expiresAt,
      last_used_at: tokensTable.lastUsedAt,
      revoked_at: tokensTable.revokedAt,
      id: usersTable.id,
      github_id: usersTable.githubId,
      github_username: usersTable.githubUsername,
      email: usersTable.email,
      name: usersTable.name,
      avatar_url: usersTable.avatarUrl,
      created_at: usersTable.createdAt,
      updated_at: usersTable.updatedAt,
    })
    .from(tokensTable)
    .innerJoin(usersTable, eq(tokensTable.userId, usersTable.id))
    .where(
      and(
        eq(tokensTable.id, tokenHash),
        isNull(tokensTable.revokedAt),
        or(isNull(tokensTable.expiresAt), gt(tokensTable.expiresAt, Date.now()))
      )
    )
    .get();

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
    db
      .update(tokensTable)
      .set({ lastUsedAt: Date.now() })
      .where(eq(tokensTable.id, tokenHash))
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
  const drizzleDb = getDb({ DB: db } as Env);
  const result = await drizzleDb
    .select({
      id: usersTable.id,
      github_id: usersTable.githubId,
      github_username: usersTable.githubUsername,
      email: usersTable.email,
      name: usersTable.name,
      avatar_url: usersTable.avatarUrl,
      created_at: usersTable.createdAt,
      updated_at: usersTable.updatedAt,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(and(eq(sessionsTable.id, sessionId), gt(sessionsTable.expiresAt, Date.now())))
    .get();

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
