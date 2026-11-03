import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { parse, stringify } from 'devalue';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const MCP = 'https://landscaping.test/mcp';
const METADATA = 'https://landscaping.test/.well-known/access-protected-resource/mcp';
const ISSUER = 'https://team.access.test';

async function signedRpc() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, env.TENANT_ID);
  const browserKey = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: browserKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  return async (path: string, input: unknown = {}): Promise<unknown> => {
    const body = stringify({ v: 1, path, input });
    const signature = signRpcRequest({ deviceId: binding.deviceId, method: 'POST', path: '/rpc', body: new TextEncoder().encode(body), signingPrivateKey: browserKey });
    const response = await SELF.fetch(new Request(`https://${env.TENANT_ID}.gitspace.sh/rpc`, { method: 'POST', body, headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': userId, 'x-gitspace-device': signature } }));
    return parse(await response.text());
  };
}

/** An MCP server behind an authorization server the way Cloudflare Access fronts one: the challenge names a
 * non-standard metadata path, clients register themselves, and codes need the PKCE verifier. Bearer tokens the
 * server accepted are recorded per MCP request. */
function protectedServer() {
  const seen = { bearer: [] as string[], verifiers: [] as string[], challenge: '' };
  network.use(
    http.post(MCP, async ({ request }) => {
      const authorization = request.headers.get('authorization') ?? '';
      if (authorization !== 'Bearer token-1') {
        return new HttpResponse(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="OAuth", error="invalid_token", resource_metadata="${METADATA}"` } });
      }
      seen.bearer.push(authorization);
      const message = z.object({ id: z.number().optional(), method: z.string() }).parse(await request.json());
      if (message.id === undefined) return new HttpResponse(null, { status: 202 });
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'landscaping', version: '1.0.0' } }
        : { tools: [{ name: 'list_jobs', inputSchema: { type: 'object' } }] };
      return HttpResponse.json({ jsonrpc: '2.0', id: message.id, result });
    }),
    http.get(METADATA, () => HttpResponse.json({ resource: MCP, authorization_servers: [ISSUER] })),
    http.get(`${ISSUER}/.well-known/oauth-authorization-server`, () => HttpResponse.json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    })),
    http.post(`${ISSUER}/register`, async ({ request }) => HttpResponse.json({ ...z.record(z.string(), z.unknown()).parse(await request.json()), client_id: 'client-1' }, { status: 201 })),
    http.post(`${ISSUER}/token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      seen.verifiers.push(form.get('code_verifier') ?? '');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier') ?? '')));
      const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
      if (form.get('code') !== 'code-1' || challenge !== seen.challenge) return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
      return HttpResponse.json({ access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 });
    }),
  );
  return seen;
}

const connectionView = z.object({ status: z.literal('ok'), value: z.object({ status: z.string(), statusMessage: z.string().nullable(), revision: z.number() }) });

describe('MCP sign-in for custom plugins', () => {
  it('signs in once through the browser and connects with the issued token', async () => {
    const rpc = await signedRpc();
    const seen = protectedServer();
    const created = connectionView.parse(await rpc('mcp.connections.create', { connection: { id: 'landscaping', label: 'Landscaping', enabled: true, target: { kind: 'workspace' }, transport: { type: 'http', url: MCP, headers: [] }, timeoutMs: 5_000 } }));
    expect(created.value).toMatchObject({ status: 'sign-in-required', statusMessage: 'Sign in to connect' });

    const started = z.object({ status: z.literal('ok'), value: z.object({ authorizationUrl: z.string() }) }).parse(await rpc('mcp.connections.signIn', { connectionId: 'landscaping' }));
    const authorization = new URL(started.value.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorization.searchParams.get('client_id')).toBe('client-1');
    expect(authorization.searchParams.get('redirect_uri')).toBe(new URL('/v1/mcp/oauth/callback', env.ACCOUNT_URL).href);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    seen.challenge = authorization.searchParams.get('code_challenge') ?? '';
    const state = authorization.searchParams.get('state') ?? '';

    const callback = new URL('/v1/mcp/oauth/callback', env.ACCOUNT_URL);
    callback.searchParams.set('code', 'code-1');
    callback.searchParams.set('state', state);
    const landed = await SELF.fetch(callback);
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain('Plugin signed in');
    expect(seen.bearer.length).toBeGreaterThan(0);
    expect(connectionView.parse(await rpc('mcp.connections.status', { connectionId: 'landscaping' })).value).toMatchObject({ status: 'ready', statusMessage: null });

    // The state was spent: a replayed callback cannot exchange another code.
    const replayed = await SELF.fetch(callback);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain('expired or was already used');
    expect(seen.verifiers).toHaveLength(1);
  });

  it('never sends a grant to a changed server address', async () => {
    const rpc = await signedRpc();
    const seen = protectedServer();
    const draft = { id: 'moving', label: 'Moving', enabled: true, target: { kind: 'workspace' }, transport: { type: 'http', url: MCP, headers: [] }, timeoutMs: 5_000 };
    connectionView.parse(await rpc('mcp.connections.create', { connection: draft }));
    const started = z.object({ status: z.literal('ok'), value: z.object({ authorizationUrl: z.string() }) }).parse(await rpc('mcp.connections.signIn', { connectionId: 'moving' }));
    const authorization = new URL(started.value.authorizationUrl);
    seen.challenge = authorization.searchParams.get('code_challenge') ?? '';
    const callback = new URL('/v1/mcp/oauth/callback', env.ACCOUNT_URL);
    callback.searchParams.set('code', 'code-1');
    callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
    expect((await SELF.fetch(callback)).status).toBe(200);
    const ready = connectionView.parse(await rpc('mcp.connections.status', { connectionId: 'moving' }));
    expect(ready.value.status).toBe('ready');

    const elsewhere = 'https://elsewhere.test/mcp';
    const received: string[] = [];
    network.use(http.post(elsewhere, ({ request }) => {
      received.push(request.headers.get('authorization') ?? '');
      return new HttpResponse(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' } });
    }));
    const moved = connectionView.parse(await rpc('mcp.connections.update', { connectionId: 'moving', expectedRevision: ready.value.revision, connection: { ...draft, transport: { ...draft.transport, url: elsewhere } } }));
    expect(moved.value.status).toBe('sign-in-required');
    expect(received).toEqual(['']);
  });
});
