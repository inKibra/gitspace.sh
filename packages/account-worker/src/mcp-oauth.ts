import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  OAuthClientInformationFullSchema, OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import type { McpConnection, McpConnectionStatus } from '@gitspace/protocol';
import { z } from 'zod';
import type { CredentialVaultDO } from './application.js';

export const MCP_OAUTH_CALLBACK_PATH = '/v1/mcp/oauth/callback';
const SIGN_IN_SECONDS = 600;

/** What the vault keeps per connection. The client registration is reused while it names the current callback. */
const recordSchema = z.object({
  client: OAuthClientInformationFullSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
  codeVerifier: z.string().optional(),
  discovery: z.object({
    authorizationServerUrl: z.string(),
    resourceMetadataUrl: z.string().optional(),
    resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
    authorizationServerMetadata: z.union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema]).optional(),
  }).optional(),
});
type McpOAuthRecord = z.infer<typeof recordSchema>;

/** `interactive` belongs to a person's sign-in; `background` to agent calls, which refresh tokens but never start or
 * disturb a sign-in (they keep the pending code verifier and send no one anywhere). */
type Mode = 'interactive' | 'background';

class VaultOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  constructor(
    private readonly vault: DurableObjectStub<CredentialVaultDO>,
    private readonly connectionId: string,
    private readonly callback: string,
    private record: McpOAuthRecord,
    private readonly mode: Mode,
    private readonly signInState: string | null,
  ) {}
  get redirectUrl(): string { return this.callback; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'GitSpace', redirect_uris: [this.callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state(): string { return this.signInState ?? crypto.randomUUID(); }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.record.client?.redirect_uris.includes(this.callback) ? this.record.client : undefined;
  }
  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    this.record = { ...this.record, client: OAuthClientInformationFullSchema.parse(client) };
    await this.save();
  }
  tokens(): OAuthTokens | undefined { return this.record.tokens; }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.record = { ...this.record, tokens };
    await this.save();
  }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.mode === 'background') return;
    this.record = { ...this.record, codeVerifier };
    await this.save();
  }
  codeVerifier(): string {
    if (!this.record.codeVerifier) throw new Error('No sign-in is in progress for this plugin');
    return this.record.codeVerifier;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const { client, tokens, codeVerifier, discovery } = this.record;
    const next: McpOAuthRecord = {};
    if (scope !== 'all') {
      if (client && scope !== 'client') next.client = client;
      if (tokens && scope !== 'tokens') next.tokens = tokens;
      if (codeVerifier && scope !== 'verifier') next.codeVerifier = codeVerifier;
      if (discovery && scope !== 'discovery') next.discovery = discovery;
    }
    this.record = next;
    await this.save();
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.record = { ...this.record, discovery: state };
    await this.save();
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.record.discovery; }
  private async save(): Promise<void> { await this.vault.putMcpOAuth(this.connectionId, JSON.stringify(this.record)); }
}

async function provider(env: Env, connectionId: string, mode: Mode, signInState: string | null = null): Promise<VaultOAuthProvider> {
  const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(env.ACCOUNT_ID);
  const stored = await vault.getMcpOAuth(connectionId);
  const record = stored === null ? {} : recordSchema.parse(JSON.parse(stored));
  return new VaultOAuthProvider(vault, connectionId, new URL(MCP_OAUTH_CALLBACK_PATH, env.ACCOUNT_URL).href, record, mode, signInState);
}

/** For agent calls: the stored grant, refreshed when the server rejects it. Without one the transport throws
 * `UnauthorizedError`. */
export function mcpBackgroundAuth(env: Env, connectionId: string): Promise<OAuthClientProvider> {
  return provider(env, connectionId, 'background');
}

/** Whether the server asks MCP clients to sign in: an unauthenticated initialize answered 401 with a Bearer
 * challenge. The challenge may name its protected-resource metadata; Cloudflare Access names a non-standard path. */
export async function probeMcpSignIn(url: string): Promise<{ challenged: boolean; resourceMetadataUrl: URL | undefined }> {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'gitspace-cloud', version: '1.0.0' } } }),
  });
  await response.body?.cancel();
  const challenged = response.status === 401 && /^bearer\b/iu.test(response.headers.get('www-authenticate') ?? '');
  return { challenged, resourceMetadataUrl: challenged ? extractWWWAuthenticateParams(response).resourceMetadataUrl : undefined };
}

/** Starts a fresh sign-in: earlier tokens are dropped, the client registration is kept. Returns the page to open,
 * or null when the server granted access without one. */
export async function startMcpSignIn(env: Env, connectionId: string, url: string): Promise<string | null> {
  const state = crypto.randomUUID();
  const signIn = await provider(env, connectionId, 'interactive', state);
  await signIn.invalidateCredentials('tokens');
  const { resourceMetadataUrl } = await probeMcpSignIn(url);
  const result = await auth(signIn, { serverUrl: url, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) });
  if (result === 'AUTHORIZED' || !signIn.authorizationUrl) return null;
  const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(env.ACCOUNT_ID);
  await vault.beginMcpOAuth(connectionId, state, Date.now() + SIGN_IN_SECONDS * 1000);
  return signIn.authorizationUrl.href;
}

/** Exchanges the callback's code for tokens, then connects once to report the result. A connection that also binds
 * header secrets needs a project to read them from, so it is checked on its first agent call instead. */
export async function completeMcpSignIn(env: Env, connection: McpConnection, code: string): Promise<{ status: Extract<McpConnectionStatus, 'ready' | 'offline' | 'failed'>; message: string | null }> {
  const { transport } = connection;
  if (transport.type !== 'http' && transport.type !== 'sse') throw new Error('Only Streamable HTTP and SSE plugins sign in');
  const signIn = await provider(env, connection.id, 'interactive');
  const resourceMetadataUrl = signIn.discoveryState()?.resourceMetadataUrl;
  const result = await auth(signIn, { serverUrl: transport.url, authorizationCode: code, ...(resourceMetadataUrl ? { resourceMetadataUrl: new URL(resourceMetadataUrl) } : {}) });
  if (result !== 'AUTHORIZED') throw new Error('The authorization server did not issue a token');
  if (transport.headers.length > 0) return { status: 'offline', message: 'Signed in. It connects when an agent first uses it.' };
  const client = new Client({ name: 'gitspace-cloud', version: '1.0.0' }, { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  try {
    await client.connect(transport.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(transport.url), { redirectPolicy: 'same-origin', authProvider: signIn })
      : new SSEClientTransport(new URL(transport.url), { redirectPolicy: 'same-origin', authProvider: signIn }), { timeout: connection.timeoutMs });
    await client.listTools({}, { timeout: connection.timeoutMs });
    return { status: 'ready', message: null };
  } catch (error) {
    return { status: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
  } finally { await client.close(); }
}

/** The page the sign-in window lands on: it tells the Plugins page to refresh, then closes itself. */
export function mcpSignInPage(title: string, detail: string, status: number): Response {
  const escaped = detail.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
  return new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:48px;color:#161616}p{color:#5f5f5f}</style><h1>${title}</h1><p>${escaped}</p><script>window.opener?.postMessage({type:'gitspace:mcp-sign-in'},location.origin);${status === 200 ? 'window.close()' : ''}</script>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
