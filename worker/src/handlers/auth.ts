/**
 * Authentication handlers
 *
 * Handles GitHub OAuth flow (portal) and Device Flow (CLI)
 */

import { Hono } from 'hono';
import { ed25519 } from '@noble/curves/ed25519';
import type { Env, User, GitHubUser } from '../types';
import type { D1Database } from '@cloudflare/workers-types';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sessions as sessionsTable, tokens as tokensTable, users as usersTable } from '../db/schema';
import { hashToken } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// GitHub OAuth (Portal - redirect-based)
// ============================================================================

/**
 * Start GitHub OAuth flow
 * GET /auth/github
 */
app.get('/github', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `https://api.gitspace.sh/auth/github/callback`,
    scope: 'read:user user:email',
    state: crypto.randomUUID(),
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

/**
 * GitHub OAuth callback
 * GET /auth/github/callback?code=xxx
 */
app.get('/github/callback', async (c) => {
  const code = c.req.query('code');

  if (!code) {
    return c.redirect(`${c.env.PORTAL_URL}?error=missing_code`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
    };

    if (!tokenData.access_token) {
      return c.redirect(`${c.env.PORTAL_URL}?error=token_exchange_failed`);
    }

    // Fetch GitHub user
    const githubUser = await fetchGitHubUser(tokenData.access_token);

    // Find or create user (with account limit check)
    const maxAccounts = parseInt(c.env.MAX_ACCOUNTS, 10) || undefined;
    let user: User;
    try {
      user = await findOrCreateUser(c.env.DB, githubUser, maxAccounts);
    } catch (error) {
      if (error instanceof Error && error.message === 'ACCOUNT_LIMIT_REACHED') {
        return c.redirect(`${c.env.PORTAL_URL}?error=waitlist`);
      }
      throw error;
    }

    // Create session
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

    const db = getDb(c.env);
    await db
      .insert(sessionsTable)
      .values({
        id: sessionId,
        userId: user.id,
        createdAt: Date.now(),
        expiresAt,
        ipAddress: c.req.header('CF-Connecting-IP') ?? null,
        userAgent: c.req.header('User-Agent') ?? null,
      })
      .run();

    // Redirect with session cookie
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${c.env.PORTAL_URL}/dashboard`,
        'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`,
      },
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    return c.redirect(`${c.env.PORTAL_URL}?error=auth_failed`);
  }
});

// ============================================================================
// GitHub Device Flow (CLI)
// ============================================================================

interface DeviceAuthRequest {
  github_token: string;
  machine_pubkey: string;
  device_name: string;
  auth_timestamp: number;
  auth_signature: string;
}

/**
 * Exchange GitHub token for gitspace.sh CLI token
 * POST /auth/github/device
 *
 * SECURITY: Requires Ed25519 signature to prevent device impersonation
 */
app.post('/github/device', async (c) => {
  const body = await c.req.json<DeviceAuthRequest>();
  const {
    github_token,
    machine_pubkey,
    device_name,
    auth_timestamp,
    auth_signature,
  } = body;

  // Validate required fields
  if (!github_token || !machine_pubkey || !device_name) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  if (!auth_timestamp || !auth_signature) {
    return c.json({ error: 'Missing auth signature fields' }, 400);
  }

  if (typeof device_name !== 'string') {
    return c.json({ error: 'Invalid device_name' }, 400);
  }

  const normalizedDeviceName = device_name.trim();
  if (!/^[a-zA-Z0-9 _.-]{1,64}$/.test(normalizedDeviceName)) {
    return c.json({ error: 'Invalid device_name' }, 400);
  }

  // ========================================================================
  // Step 0: Verify signature to prevent device impersonation
  // ========================================================================

  const now = Date.now();
  const MAX_TIMESTAMP_AGE = 5 * 60 * 1000; // 5 minutes

  // Check timestamp freshness (prevent replay attacks)
  if (Math.abs(now - auth_timestamp) > MAX_TIMESTAMP_AGE) {
    return c.json(
      { error: 'Auth timestamp expired. Please try again.' },
      401
    );
  }

  // Verify the signature proves ownership of private key
  const authMessage = `gitspace-device-auth:${auth_timestamp}`;
  const messageBytes = new TextEncoder().encode(authMessage);

  let signatureBytes: Uint8Array;
  let publicKeyBytes: Uint8Array;

  try {
    signatureBytes = new Uint8Array(
      atob(auth_signature)
        .split('')
        .map((c) => c.charCodeAt(0))
    );
    publicKeyBytes = new Uint8Array(
      atob(machine_pubkey)
        .split('')
        .map((c) => c.charCodeAt(0))
    );
  } catch {
    return c.json({ error: 'Invalid signature or public key format' }, 400);
  }

  try {
    const isValid = ed25519.verify(signatureBytes, messageBytes, publicKeyBytes);
    if (!isValid) {
      return c.json({ error: 'Invalid device signature' }, 401);
    }
  } catch (err) {
    return c.json({ error: 'Signature verification failed' }, 401);
  }

  // ========================================================================
  // Step 1: Verify GitHub token by fetching user info
  // ========================================================================

  let githubUser: GitHubUser;
  try {
    githubUser = await fetchGitHubUser(github_token);
  } catch (error) {
    return c.json({ error: 'Invalid GitHub token' }, 401);
  }

  // ========================================================================
  // Step 2: Find or create user (with account limit check)
  // ========================================================================

  const maxAccounts = parseInt(c.env.MAX_ACCOUNTS, 10) || undefined;
  let user: User;
  try {
    user = await findOrCreateUser(c.env.DB, githubUser, maxAccounts);
  } catch (error) {
    if (error instanceof Error && error.message === 'ACCOUNT_LIMIT_REACHED') {
      return c.json(
        {
          error: 'Account limit reached',
          message:
            'gitspace.sh is currently in private beta. Sign up for the waitlist at https://gitspace.sh',
        },
        503
      );
    }
    throw error;
  }

  // ========================================================================
  // Step 3: Create CLI token (hashed for storage)
  // ========================================================================

  const tokenPlain = `gst_${crypto.randomUUID().replace(/-/g, '')}`;
  const tokenPrefix = tokenPlain.slice(0, 12); // "gst_abc12345"
  const tokenHash = await hashToken(tokenPlain);
  const expiresAt = now + 90 * 24 * 60 * 60 * 1000; // 90 days

  const db = getDb(c.env);
  await db
    .insert(tokensTable)
    .values({
      id: tokenHash,
      prefix: tokenPrefix,
      userId: user.id,
      deviceName: normalizedDeviceName,
      deviceFingerprint: machine_pubkey,
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
    })
    .run();

  // ========================================================================
  // Step 4: Return token and user info
  // ========================================================================

  // IMPORTANT: This is the only time the plain token is returned!
  return c.json({
    token: tokenPlain,
    user: {
      id: user.id,
      github_username: githubUser.login,
      email: githubUser.email,
      name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    },
  });
});

/**
 * Logout (clear session)
 * POST /auth/logout
 */
app.post('/logout', async (c) => {
  const sessionCookie = c.req.header('Cookie')?.match(/session=([^;]+)/)?.[1];

  if (sessionCookie) {
    const db = getDb(c.env);
    await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionCookie)).run();
  }

  return new Response(null, {
    status: 200,
    headers: {
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    },
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetch GitHub user info from API
 */
async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'gitspace.sh',
      Accept: 'application/vnd.github+json',
    },
  });

  if (!userRes.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  const user = (await userRes.json()) as GitHubUser;

  // If email not in profile, try to get it from emails endpoint
  if (!user.email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'gitspace.sh',
        Accept: 'application/vnd.github+json',
      },
    });

    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified);
      if (primary) {
        user.email = primary.email;
      }
    }
  }

  return user;
}

/**
 * Find or create a user by GitHub ID
 * @throws Error if account limit reached (for new users)
 */
async function findOrCreateUser(
  db: D1Database,
  githubUser: GitHubUser,
  maxAccounts?: number
): Promise<User> {
  const now = Date.now();
  const githubId = String(githubUser.id);
  const drizzleDb = getDb({ DB: db } as Env);

  const toUser = (row: {
    id: string;
    githubId: string;
    githubUsername: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    createdAt: number;
    updatedAt: number;
  }): User => ({
    id: row.id,
    github_id: row.githubId,
    github_username: row.githubUsername,
    email: row.email,
    name: row.name,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });

  // Try to find existing user
  let user = await drizzleDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.githubId, githubId))
    .get();

  if (user) {
    // Update user info
    await drizzleDb
      .update(usersTable)
      .set({
        githubUsername: githubUser.login,
        email: githubUser.email ?? user.email,
        name: githubUser.name ?? user.name,
        avatarUrl: githubUser.avatar_url ?? user.avatarUrl,
        updatedAt: now,
      })
      .where(eq(usersTable.id, user.id))
      .run();

    // Refresh user data
    user = await drizzleDb
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .get();
  } else {
    // Check account limit before creating new user
    if (maxAccounts !== undefined) {
      const countResult = await drizzleDb
        .select({ count: sql<number>`count(*)` })
        .from(usersTable)
        .get();

      if (countResult && countResult.count >= maxAccounts) {
        throw new Error('ACCOUNT_LIMIT_REACHED');
      }
    }

    // Create new user
    const userId = crypto.randomUUID();

    await drizzleDb
      .insert(usersTable)
      .values({
        id: userId,
        githubId,
        githubUsername: githubUser.login,
        email: githubUser.email,
        name: githubUser.name,
        avatarUrl: githubUser.avatar_url,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    user = {
      id: userId,
      githubId,
      githubUsername: githubUser.login,
      email: githubUser.email,
      name: githubUser.name,
      avatarUrl: githubUser.avatar_url,
      createdAt: now,
      updatedAt: now,
    };
  }

  return toUser(user!);
}

export default app;
