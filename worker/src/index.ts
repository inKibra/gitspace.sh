/**
 * gitspace.sh API Worker
 *
 * Entry point for the Cloudflare Worker handling:
 * - GitHub OAuth authentication
 * - Subdomain/tunnel management
 * - User management
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, User } from './types';
import { authMiddleware, type AuthContext } from './middleware/auth';
import authHandlers from './handlers/auth';
import identityHandlers from './handlers/identity';
import userHandlers from './handlers/user';
import subdomainHandlers from './handlers/subdomains';

// Create app with typed bindings
const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

// CORS for portal, CLI, and *.gitspace.sh subdomains
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return 'https://gitspace.sh';
      if (origin === 'https://gitspace.sh') return origin;
      if (origin === 'http://localhost:5173') return origin;
      // Allow any *.gitspace.sh subdomain (for web terminals)
      if (/^https:\/\/[a-z0-9-]+\.gitspace\.sh$/.test(origin)) return origin;
      return null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Fingerprint'],
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Public config (for CLI compatibility checks and GitHub Client ID)
const WORKER_VERSION = '1.0.0';
const WORKER_API_VERSION = 1;
const SUBDOMAINS_SCHEMA_VERSION = 2;

app.get('/config', (c) => {
  return c.json({
    github_client_id: c.env.GITHUB_CLIENT_ID,
    version: WORKER_VERSION,
    apiVersion: WORKER_API_VERSION,
    subdomainsSchemaVersion: SUBDOMAINS_SCHEMA_VERSION,
  });
});

// Public routes (no auth required)
app.route('/auth', authHandlers);

// Protected routes (require valid token)
app.use('/me', authMiddleware);
app.use('/me/*', authMiddleware);
app.use('/subdomains', authMiddleware);
app.use('/subdomains/*', authMiddleware);
app.use('/identity', authMiddleware);
app.use('/identity/*', authMiddleware);
app.route('/me', userHandlers);
app.route('/subdomains', subdomainHandlers);
app.route('/identity', identityHandlers);

// Root redirect to portal
app.get('/', (c) => {
  return c.redirect(c.env.PORTAL_URL);
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
