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
import userHandlers from './handlers/user';
import subdomainHandlers from './handlers/subdomains';

// Create app with typed bindings
const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

// CORS for portal and CLI
app.use(
  '*',
  cors({
    origin: ['https://gitspace.sh', 'http://localhost:5173'],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Fingerprint'],
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Public config (for CLI to fetch GitHub Client ID)
app.get('/config', (c) => {
  return c.json({
    github_client_id: c.env.GITHUB_CLIENT_ID,
    version: '1.0.0',
  });
});

// Public routes (no auth required)
app.route('/auth', authHandlers);

// Protected routes (require valid token)
app.use('/me/*', authMiddleware);
app.use('/subdomains/*', authMiddleware);
app.route('/me', userHandlers);
app.route('/subdomains', subdomainHandlers);

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
