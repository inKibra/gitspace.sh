import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { auth, Client, extractWWWAuthenticateParams, StreamableHTTPClientTransport, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type OAuthTokens } from '@modelcontextprotocol/client';
import {
  createSignedRpcFetch, credentialProtocolBase64, encodeBase64Url, encodeStepUpProof, passkeyChallengePayload, RPC_DEVICE_HEADER, signDeviceInvite, signRpcRequest, STEP_UP_HEADER,
  type DeviceCapability, type DeviceScope,
} from '@gitspace/protocol';
import { createBrowserClient } from 'result-rpc/client';
import { MCP_OAUTH_CONSENT_API, mcpOAuthConsentViewSchema } from '@gitspace/protocol/mcp-authorization';
import { mcpAccessResultSchema } from '@gitspace/protocol/mcp-access';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import worker from '../src/index.js';
import { softwareAuthenticator } from '../../protocol/test/software-authenticator.js';
import { answerSchema, browser, enrollPasskey, passkeyChallenge, passkeyProof, type TestBrowser } from './fixtures/passkeys.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const ORIGIN = new URL(env.ACCOUNT_URL).origin;
const MCP = `${ORIGIN}/mcp`;
const DOCUMENT = 'https://agents.example/oauth/client.json';
const call = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env);
const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string(), token_type: z.literal('Bearer'), expires_in: z.number(), scope: z.string() });
const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string() });

/** An MCP client's OAuth state, kept in memory the way an app would keep it per server. */
class AgentProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  client: OAuthClientInformationMixed | undefined;
  stored: OAuthTokens | undefined;
  verifier = '';
  discovery: OAuthDiscoveryState | undefined;
  constructor(private readonly redirect: string, readonly clientMetadataUrl?: string, private readonly authMethod = 'none') {}
  get redirectUrl(): string { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Orchard Agent', client_uri: 'https://dcr.example', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: this.authMethod };
  }
  state(): string { return 'state-7'; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.client; }
  saveClientInformation(client: OAuthClientInformationMixed): void { this.client = client; }
  tokens(): OAuthTokens | undefined { return this.stored; }
  saveTokens(tokens: OAuthTokens): void { this.stored = tokens; }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
}

/** The account's browser, signed in, with the account's handle set. */
async function signedIn(): Promise<TestBrowser> {
  const laptop = await browser();
  await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).setHandle('bootstrap', 0, env.TENANT_ID);
  return laptop;
}

/** `POST /v1/mcp-oauth/consent/<operation>` from the consent page in `from`. */
async function consent(from: TestBrowser, operation: 'view' | 'decide', payload: object, stepUp: string | null = null) {
  const path = `${MCP_OAUTH_CONSENT_API}/${operation}`;
  const body = new TextEncoder().encode(JSON.stringify({ userId: env.ACCOUNT_ID, ...payload }));
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN, [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: from.deviceId, signingPrivateKey: from.key, method: 'POST', path, body }) };
  if (stepUp) headers[STEP_UP_HEADER] = stepUp;
  const response = await call(`${ORIGIN}${path}`, { method: 'POST', headers, body });
  return { status: response.status, json: answerSchema.parse(await response.json()) };
}

/** The person allows `requestId` with `capabilities` over `scope`: the page signs a client invitation with the browser's key. */
async function allow(from: TestBrowser, requestId: string, capabilities: DeviceCapability[], scope: DeviceScope = { kind: 'user' }, stepUp: string | null = null) {
  const invite = signDeviceInvite({
    version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'client', label: 'Agent', scope, capabilities, canDelegate: false,
    issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: 7 * 86_400_000, enrollUrl: env.ACCOUNT_URL,
  }, from.key, { kind: 'device', deviceId: from.deviceId });
  return consent(from, 'decide', { requestId, decision: 'allow', invite }, stepUp);
}

function redirected(answer: { json: z.infer<typeof answerSchema> }): URL {
  return new URL(z.object({ redirectUrl: z.string() }).parse(answer.json.value).redirectUrl);
}

/** Follows an authorization URL as the user agent would; answers the consent page's request id. */
async function consentRequest(authorizationUrl: URL | string): Promise<string> {
  const response = await call(authorizationUrl);
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '', ORIGIN);
  expect(location.pathname).toBe('/oauth/consent');
  return location.searchParams.get('request') ?? '';
}

async function pkce() {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function register(metadata: object) {
  const response = await call(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) });
  return { status: response.status, json: z.record(z.string(), z.unknown()).parse(await response.json()) };
}

function authorizeUrl(params: Record<string, string>): string {
  return `${ORIGIN}/oauth/authorize?${new URLSearchParams(params)}`;
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await call(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
  return { status: response.status, json: z.record(z.string(), z.unknown()).parse(await response.json()) };
}

/** `tools/list` on `/mcp` with a bearer: its status, and the tool names when allowed. */
async function listTools(bearer: string) {
  const response = await call(MCP, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  return response.status;
}

/** A public client registered dynamically with one redirect URI, and a consented code for it. */
async function consentedCode(laptop: TestBrowser, capabilities: DeviceCapability[] = ['rpc.read'], scope: DeviceScope = { kind: 'user' }) {
  const registered = await register({ client_name: 'Raw Agent', redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' });
  const clientId = z.string().parse(registered.json.client_id);
  const { verifier, challenge } = await pkce();
  const requestId = await consentRequest(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'https://app.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: MCP, scope: 'rpc.read' }));
  const answer = await allow(laptop, requestId, capabilities, scope);
  expect(answer.status).toBe(200);
  return { clientId, verifier, code: redirected(answer).searchParams.get('code') ?? '' };
}

/** `POST /v1/mcp-access/<operation>` from Settings in `from`. */
async function settings(from: TestBrowser, operation: 'status' | 'disable', payload: object = {}) {
  const path = `/v1/mcp-access/${operation}`;
  const body = new TextEncoder().encode(JSON.stringify({ userId: env.ACCOUNT_ID, ...payload }));
  const response = await call(`${ORIGIN}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-gitspace-user': env.ACCOUNT_ID, [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: from.deviceId, signingPrivateKey: from.key, method: 'POST', path, body }) } });
  const result = mcpAccessResultSchema.parse(await response.json());
  if (result.status === 'error') throw new Error(result.error.message);
  return result.value;
}

describe('OAuth for /mcp', () => {
  it('answers an unauthenticated /mcp with the protected resource metadata, which names this account as the authorization server', async () => {
    const unauthorized = await call(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(unauthorized);
    expect(resourceMetadataUrl?.href).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(await (await call(resourceMetadataUrl ?? '')).json()).toEqual({ resource: MCP, authorization_servers: [ORIGIN], scopes_supported: ['rpc.read', 'rpc.write', 'session.prompt'], bearer_methods_supported: ['header'], resource_name: 'GitSpace' });
    expect(await (await call(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`,
      scopes_supported: ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control', 'account.admin', 'lifecycle.control', 'operator.decide'],
      code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    const consentPage = await call(`${ORIGIN}/oauth/consent?request=anything`);
    expect(consentPage.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('signs an MCP SDK client in with its Client ID Metadata Document, grants exactly what the person allowed, rotates its refresh token, and revokes the grant when a spent one returns', async () => {
    const laptop = await signedIn();
    let fetched = 0;
    network.use(http.get(DOCUMENT, () => {
      fetched += 1;
      return HttpResponse.json({ client_id: DOCUMENT, client_name: 'Agents', client_uri: 'https://agents.example', logo_uri: 'https://agents.example/logo.png', redirect_uris: ['https://agents.example/callback'], token_endpoint_auth_method: 'none' }, { headers: { 'cache-control': 'max-age=600' } });
    }));
    const provider = new AgentProvider('https://agents.example/callback', DOCUMENT);
    const first = new Client({ name: 'agents', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: call });
    await expect(first.connect(transport)).rejects.toThrow();
    const authorization = provider.authorizationUrl;
    if (!authorization) throw new Error('The SDK did not start authorization');
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({ client_id: DOCUMENT, response_type: 'code', code_challenge_method: 'S256', resource: MCP, scope: 'rpc.read rpc.write session.prompt', state: 'state-7' });
    const requestId = await consentRequest(authorization);
    const view = mcpOAuthConsentViewSchema.parse((await consent(laptop, 'view', { requestId })).json.value);
    expect(view).toMatchObject({
      client: { clientId: DOCUMENT, name: 'Agents', logoUri: 'https://agents.example/logo.png', host: 'agents.example', registration: 'metadata-document' },
      redirectHost: 'agents.example', loopback: false, requestedCapabilities: ['rpc.read', 'rpc.write', 'session.prompt'],
    });
    // The person unticks Write and Talk to agents.
    const callback = redirected(await allow(laptop, requestId, ['rpc.read']));
    expect(`${callback.origin}${callback.pathname}`).toBe('https://agents.example/callback');
    expect(callback.searchParams.get('state')).toBe('state-7');
    expect(callback.searchParams.get('iss')).toBe(ORIGIN);
    await transport.finishAuth(callback.searchParams);
    expect(provider.stored?.scope).toBe('rpc.read');
    const connected = new Client({ name: 'agents', version: '1.0.0' });
    await connected.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: call }));
    try {
      const tools = (await connected.listTools()).tools.map(tool => tool.name);
      expect(tools).toContain('gitspace_configuration_values_get');
      expect(tools).not.toContain('gitspace_configuration_values_put');
    } finally { await connected.close(); }
    expect(fetched).toBe(1);
    const listed = await settings(laptop, 'status');
    expect(listed.connections).toMatchObject([{ label: 'Agents', active: true, capabilities: ['rpc.read'], scope: { kind: 'user' }, oauth: { client: { clientId: DOCUMENT, registration: 'metadata-document' }, redirectHost: 'agents.example' } }]);
    // Refresh rotates both tokens.
    const before = provider.stored;
    if (!before?.refresh_token) throw new Error('No refresh token was issued');
    expect(await auth(provider, { serverUrl: MCP, fetchFn: call })).toBe('AUTHORIZED');
    const after = provider.stored;
    if (!after?.refresh_token) throw new Error('No refresh token after refresh');
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(after.access_token).not.toBe(before.access_token);
    expect(await listTools(after.access_token)).toBe(200);
    // The spent refresh token comes back: the grant is revoked, and every token with it.
    expect(await token({ grant_type: 'refresh_token', refresh_token: before.refresh_token, client_id: DOCUMENT })).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
    expect(await listTools(after.access_token)).toBe(401);
    expect(await token({ grant_type: 'refresh_token', refresh_token: after.refresh_token, client_id: DOCUMENT })).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
    expect((await settings(laptop, 'status')).connections).toMatchObject([{ active: false }]);
  }, 60_000);

  it('registers a client dynamically, shows it as unverified, takes its secret at the token endpoint, and loses access when Settings revokes it', async () => {
    const laptop = await signedIn();
    const provider = new AgentProvider('https://dcr.example/callback', undefined, 'client_secret_basic');
    const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: call });
    await expect(new Client({ name: 'dcr', version: '1.0.0' }).connect(transport)).rejects.toThrow();
    const client = z.object({ client_id: z.string(), client_secret: z.string() }).parse(provider.client);
    expect(client.client_id).toMatch(/^gsdc_/u);
    const requestId = await consentRequest(provider.authorizationUrl ?? '');
    expect(mcpOAuthConsentViewSchema.parse((await consent(laptop, 'view', { requestId })).json.value).client).toMatchObject({ name: 'Orchard Agent', host: 'dcr.example', registration: 'dynamic' });
    await transport.finishAuth(redirected(await allow(laptop, requestId, ['rpc.read', 'rpc.write'])).searchParams);
    const tokens = tokenSchema.parse(provider.stored);
    expect(tokens.scope).toBe('rpc.read rpc.write');
    const connected = new Client({ name: 'dcr', version: '1.0.0' });
    await connected.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: call }));
    try {
      expect((await connected.listTools()).tools.map(tool => tool.name)).toContain('gitspace_configuration_values_put');
    } finally { await connected.close(); }
    // Its secret is required.
    expect(await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).toMatchObject({ status: 401, json: { error: 'invalid_client' } });
    const status = await settings(laptop, 'status');
    const connection = status.connections[0];
    if (!connection) throw new Error('The OAuth connection is not listed');
    expect(connection.oauth?.client).toMatchObject({ registration: 'dynamic', host: 'dcr.example' });
    await settings(laptop, 'disable', { expectedRevision: status.revision, connectionId: connection.connectionId });
    expect(await listTools(tokens.access_token)).toBe(401);
    const basic = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
    expect(await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, { authorization: basic })).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
  }, 60_000);

  it('refuses unregistered and insecure redirects, requests without PKCE or for another resource, a wrong verifier, and a reused code', async () => {
    const laptop = await signedIn();
    expect(await register({ client_name: 'Plain', redirect_uris: ['http://app.example/cb'], token_endpoint_auth_method: 'none' })).toMatchObject({ status: 400, json: { error: 'invalid_redirect_uri' } });
    const registered = await register({ client_name: 'Raw Agent', redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' });
    const clientId = z.string().parse(registered.json.client_id);
    const { verifier, challenge } = await pkce();
    const base = { response_type: 'code', client_id: clientId, redirect_uri: 'https://app.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: MCP };
    // A redirect URI the client never registered ends on GitSpace's page, not at that URI.
    const elsewhere = await call(authorizeUrl({ ...base, redirect_uri: 'https://evil.example/cb' }));
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('location')).toBeNull();
    expect(await elsewhere.text()).toContain('redirect_uri is not one this client registered');
    for (const [params, error] of [[{ ...base, code_challenge: '' }, 'invalid_request'], [{ ...base, code_challenge_method: 'plain' }, 'invalid_request'], [{ ...base, resource: 'https://other.example/mcp' }, 'invalid_target'], [{ ...base, response_type: 'token' }, 'unsupported_response_type']] as const) {
      const response = await call(authorizeUrl(params));
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location') ?? '');
      expect(Object.fromEntries(location.searchParams)).toMatchObject({ error, state: 's', iss: ORIGIN });
    }
    const requestId = await consentRequest(authorizeUrl(base));
    const code = redirected(await allow(laptop, requestId, ['rpc.read'])).searchParams.get('code') ?? '';
    const exchange = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://app.example/cb', code_verifier: verifier, resource: MCP };
    expect(await token({ ...exchange, code_verifier: (await pkce()).verifier })).toMatchObject({ status: 400, json: { error: 'invalid_grant', error_description: 'The code_verifier does not match the code_challenge' } });
    expect(await token({ ...exchange, redirect_uri: 'https://app.example/other' })).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
    expect(await token({ ...exchange, resource: 'https://other.example/mcp' })).toMatchObject({ status: 400, json: { error: 'invalid_target' } });
    const issued = tokenSchema.parse((await token(exchange)).json);
    expect(await listTools(issued.access_token)).toBe(200);
    // The same code again: whoever holds it is not the client alone, so its grant goes.
    expect(oauthErrorSchema.parse((await token(exchange)).json)).toMatchObject({ error: 'invalid_grant', error_description: 'The authorization code was already used; the grant it made is revoked' });
    expect(await listTools(issued.access_token)).toBe(401);
    // Deny goes back with access_denied.
    const denied = redirected(await consent(laptop, 'decide', { requestId: await consentRequest(authorizeUrl(base)), decision: 'deny' }));
    expect(Object.fromEntries(denied.searchParams)).toMatchObject({ error: 'access_denied', state: 's', iss: ORIGIN });
  }, 60_000);

  it('matches a native client\'s loopback redirect on any port, and fetches a metadata document only from a public https host', async () => {
    await signedIn();
    network.use(http.get(DOCUMENT, () => HttpResponse.json({ client_id: DOCUMENT, client_name: 'Native', redirect_uris: ['http://127.0.0.1/callback'] })));
    const { challenge } = await pkce();
    const native = { response_type: 'code', client_id: DOCUMENT, code_challenge: challenge, code_challenge_method: 'S256' };
    expect(await consentRequest(authorizeUrl({ ...native, redirect_uri: 'http://127.0.0.1:43123/callback' }))).not.toBe('');
    expect((await call(authorizeUrl({ ...native, redirect_uri: 'http://localhost:43123/callback' }))).status).toBe(400);
    expect((await call(authorizeUrl({ ...native, redirect_uri: 'http://127.0.0.1:43123/other' }))).status).toBe(400);
    // Documents GitSpace would accept, served from hosts it must not fetch.
    const privateDocuments = ['https://127.0.0.1/client.json', 'https://10.0.0.8/client.json', 'https://localhost/client.json', 'https://agents.example:8443/client.json'];
    network.use(...privateDocuments.map(url => http.get(url, () => HttpResponse.json({ client_id: url, client_name: 'Inside', redirect_uris: ['http://127.0.0.1/callback'] }))));
    for (const clientId of [...privateDocuments, 'https://agents.example/']) {
      const refused = await call(authorizeUrl({ ...native, client_id: clientId, redirect_uri: 'http://127.0.0.1/callback' }));
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain('GitSpace cannot identify this client');
    }
    // A document that names another client is not that client.
    const impostor = 'https://agents.example/oauth/impostor.json';
    network.use(http.get(impostor, () => HttpResponse.json({ client_id: DOCUMENT, client_name: 'Native', redirect_uris: ['http://127.0.0.1/callback'] })));
    const claimed = await call(authorizeUrl({ ...native, client_id: impostor, redirect_uri: 'http://127.0.0.1/callback' }));
    expect(claimed.status).toBe(400);
    expect(await claimed.text()).toContain('its metadata document names another client_id');
  });

  it('grants powerful permissions only after an mcp-oauth.grant step-up: the recovery key while no passkey is enrolled, then the passkey', async () => {
    const laptop = await signedIn();
    const registered = await register({ client_name: 'Raw Agent', redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' });
    const clientId = z.string().parse(registered.json.client_id);
    const newRequest = async () => consentRequest(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'https://app.example/cb', code_challenge: (await pkce()).challenge, code_challenge_method: 'S256' }));
    const powerful: DeviceCapability[] = ['rpc.read', 'rpc.write', 'operator.decide'];
    const first = await newRequest();
    expect(await allow(laptop, first, powerful)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_ENROLL_REQUIRED' } } });
    const recoveryChallenge = await passkeyChallenge(laptop, 'mcp-oauth.grant', [first]);
    if (!recoveryChallenge.required) throw new Error('A step-up was due');
    const recovery = encodeStepUpProof({ challengeId: recoveryChallenge.challengeId, proof: { kind: 'root', signature: credentialProtocolBase64.encode(ed25519.sign(passkeyChallengePayload(recoveryChallenge.payload), tenantRootPrivateKey)) } });
    expect((await allow(laptop, first, powerful, { kind: 'user' }, recovery)).status).toBe(200);
    const yubikey = await softwareAuthenticator();
    expect((await enrollPasskey(laptop, yubikey)).status).toBe(200);
    const second = await newRequest();
    expect(await allow(laptop, second, ['rpc.read', 'account.admin'])).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_REQUIRED' } } });
    const third = await newRequest();
    expect(await allow(laptop, second, ['rpc.read', 'account.admin'], { kind: 'user' }, await passkeyProof(laptop, yubikey, { purpose: 'mcp-oauth.grant', targets: [third] }))).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_INVALID' } } });
    expect((await allow(laptop, second, ['rpc.read', 'account.admin'], { kind: 'user' }, await passkeyProof(laptop, yubikey, { purpose: 'mcp-oauth.grant', targets: [second] }))).status).toBe(200);
    // Ordinary permissions take none.
    expect((await allow(laptop, third, ['rpc.read', 'rpc.write', 'session.prompt'])).status).toBe(200);
  }, 60_000);

  it('answers "try again" on every OAuth route while the vault still runs a build without the OAuth methods', async () => {
    const laptop = await signedIn();
    const vault = env.CREDENTIALS.getByName.bind(env.CREDENTIALS);
    // As right after a deploy: the vault object still serves the previous build's code.
    const stale = vi.spyOn(env.CREDENTIALS, 'getByName').mockImplementation((name) => new Proxy(vault(name), {
      get(target, property) {
        if (typeof property === 'string' && property.startsWith('mcpOAuth')) return () => Promise.reject(new Error(`The RPC receiver does not implement the method "${property}".`));
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      },
    }));
    try {
      const page = await call(authorizeUrl({ response_type: 'code', client_id: DOCUMENT, redirect_uri: 'https://agents.example/callback', code_challenge: (await pkce()).challenge, code_challenge_method: 'S256' }));
      expect(page.status).toBe(503);
      expect(await page.text()).toContain('briefly unavailable');
      expect(await register({ redirect_uris: ['https://app.example/cb'] })).toMatchObject({ status: 503, json: { error: 'temporarily_unavailable' } });
      expect(await token({ grant_type: 'refresh_token', refresh_token: 'gsor_spent', client_id: DOCUMENT })).toMatchObject({ status: 503, json: { error: 'temporarily_unavailable' } });
      expect(await consent(laptop, 'view', { requestId: crypto.randomUUID() })).toMatchObject({ status: 503, json: { error: { code: 'MCP_OAUTH_UNAVAILABLE' } } });
      expect((await call(`${ORIGIN}/.well-known/oauth-authorization-server`)).status).toBe(200);
    } finally { stale.mockRestore(); }
  }, 60_000);

  it('confines a grant for several projects to exactly those projects', async () => {
    const laptop = await signedIn();
    const rpc = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({
      homeUrl: `${ORIGIN}/rpc`, fetch: createSignedRpcFetch({ deviceId: laptop.deviceId, userId: env.ACCOUNT_ID, signingPrivateKey: laptop.key, fetch: call }),
    }) });
    const projects: string[] = [];
    for (const name of ['Orchard', 'Pantry', 'Ledger']) {
      const created = await rpc.project.create({ name, baseBranch: null, repositoryUrl: null });
      if (created.status === 'error') throw created.error;
      projects.push(created.value.project.id);
    }
    const [orchard, pantry, ledger] = projects;
    if (!orchard || !pantry || !ledger) throw new Error('Projects were not created');
    const granted = await consentedCode(laptop, ['rpc.read'], { kind: 'projects', projectIds: [orchard, pantry] });
    const issued = tokenSchema.parse((await token({ grant_type: 'authorization_code', code: granted.code, client_id: granted.clientId, redirect_uri: 'https://app.example/cb', code_verifier: granted.verifier })).json);
    expect((await settings(laptop, 'status')).connections).toMatchObject([{ scope: { kind: 'projects', projectIds: [orchard, pantry] } }]);
    const client = new Client({ name: 'projects', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${issued.access_token}` } }, fetch: call }));
    try {
      const snapshot = (projectId: string) => client.callTool({ name: 'gitspace_runtime_snapshot', arguments: { projectId, workspaceId: projectId } });
      for (const projectId of [orchard, pantry]) {
        const read = await snapshot(projectId);
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toMatchObject({ result: { projectId, workspaceId: projectId } });
      }
      const refused = await snapshot(ledger);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('outside the device scope');
      // Account-wide procedures stay closed to a project-scoped grant.
      expect(JSON.stringify(await client.callTool({ name: 'gitspace_configuration_values_get', arguments: {} }))).toContain('"isError":true');
    } finally { await client.close(); }
  }, 60_000);
});
