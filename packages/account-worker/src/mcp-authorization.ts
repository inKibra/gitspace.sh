import { credentialProtocolBase64, deviceCapabilitySchema, encodeBase64Url, type DeviceBinding, type DeviceCapability, type SignedDeviceInvite, type StepUpAction, type VerifiedDevice } from '@gitspace/protocol';
import { RPC_DEVICE_HEADER, STEP_UP_HEADER } from '@gitspace/protocol/device-grant';
import {
  MCP_OAUTH_CONSENT_API, MCP_OAUTH_CONSENT_PAGE, MCP_STEP_UP_CAPABILITIES, mcpOAuthClientViewSchema, mcpOAuthConsentDecisionSchema, mcpOAuthConsentViewRequestSchema,
  type McpOAuthConsentView,
} from '@gitspace/protocol/mcp-authorization';
import { z } from 'zod';
import { accountAccessResponse, activeAccount } from './account-access.js';
import type { CredentialVaultResult } from './application.js';
import type { StepUpGrant } from './passkeys.js';
import { acrossRelease } from './release-worker.js';

/**
 * The OAuth authorization server for the account's `/mcp` (MCP authorization, 2026-07-28; docs/GITSPACE-MCP-CAPABILITY-MATRIX.md
 * "OAuth"). The account origin is the issuer and `<origin>/mcp` the one resource. Clients identify with a Client ID
 * Metadata Document (their `client_id` is its https URL) or register dynamically (RFC 7591). The authorization code
 * flow takes PKCE (S256), binds the resource (RFC 8707) and answers `iss` (RFC 9207). A person allows it on the consent
 * page from a signed-in GitSpace browser, which signs a client invitation for exactly the permissions, projects and
 * lifetime chosen; powerful permissions also take a passkey step-up (`mcp-oauth.grant`). The grant is the same API-client
 * device as a token connection in Settings → MCP, listed and revoked there. Access tokens last an hour; refresh tokens
 * rotate on every use, and presenting a used one (or a used code) revokes the grant. Only SHA-256 hashes of codes,
 * tokens and client secrets are kept. Loaded on the OAuth routes and the vault's first OAuth call.
 */

const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const OPEN_REQUESTS = 64;
/** Spent refresh tokens are kept this long to recognise their reuse. */
const SPENT_TOKEN_RETENTION_MS = 30 * 86_400_000;
const REGISTRATION_WINDOW_MS = 10 * 60_000;
const REGISTRATIONS_PER_WINDOW = 20;
/** Dynamic clients kept that no connection uses; the oldest go first. */
const UNUSED_DYNAMIC_CLIENTS = 200;
const DOCUMENT_MAX_BYTES = 8 * 1024;
const DOCUMENT_TIMEOUT_MS = 5_000;
const DOCUMENT_CACHE_MIN_MS = 5 * 60_000;
const DOCUMENT_CACHE_DEFAULT_MS = 60 * 60_000;
const DOCUMENT_CACHE_MAX_MS = 24 * 60 * 60_000;
const CACHED_DOCUMENTS = 64;
const BODY_MAX_BYTES = 16 * 1024;
/** What a client that names no scope is offered: read, write and talk to agents. */
const DEFAULT_SCOPES: readonly DeviceCapability[] = ['rpc.read', 'rpc.write', 'session.prompt'];
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = { localhost: true, '127.0.0.1': true, '[::1]': true };
const SECRET_AUTH_METHODS: Readonly<Record<string, true>> = { client_secret_post: true, client_secret_basic: true };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
};
const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** A client as the server keeps it: who it is, where it may be sent, and how it authenticates at the token endpoint. */
const storedClientSchema = z.object({
  view: mcpOAuthClientViewSchema,
  redirectUris: z.array(z.string()).min(1),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
});
type StoredClient = z.infer<typeof storedClientSchema>;

/** An authorization request waiting for the consent page. */
const authorizationRequestSchema = z.object({
  client: mcpOAuthClientViewSchema,
  redirectUri: z.string(),
  state: z.string().nullable(),
  codeChallenge: z.string(),
  capabilities: z.array(deviceCapabilitySchema),
  resource: z.string(),
});
type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;

/** What an authorization code was issued for. */
const codeSchema = z.object({ clientId: z.string(), redirectUri: z.string(), codeChallenge: z.string(), resource: z.string() });
const connectionClientSchema = z.object({ client: z.object({ clientId: z.string() }) });

const clientMetadataSchema = z.looseObject({
  client_name: z.string().trim().min(1).max(160).optional(),
  client_uri: z.string().url().max(2_048).optional(),
  logo_uri: z.string().url().max(2_048).optional(),
  redirect_uris: z.array(z.string().max(2_048)).min(1).max(16),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(128)).max(16).optional(),
  response_types: z.array(z.string().max(64)).max(8).optional(),
});
const clientDocumentSchema = clientMetadataSchema.extend({ client_id: z.string() });

export type OAuthReply = { status: number; body: Record<string, string | number | readonly string[]>; headers: Record<string, string> };
export type AuthorizeOutcome = { kind: 'consent'; requestId: string } | { kind: 'redirect'; location: string } | { kind: 'refused'; status: number; message: string };

/** What the vault lends this module. */
export interface McpAuthorizationHost {
  storage: DurableObjectStorage;
  accountUrl: string;
  config(): { user_id: string; root_public_key: string; vault_key: string } | undefined;
  currentDevice(deviceId: string): VerifiedDevice | null;
  /** A request signed by a current, account-wide browser holding `capabilities`. */
  authorizeBrowser(input: { header: string | null; target: string; body: Uint8Array; capabilities: DeviceCapability[] }): CredentialVaultResult<{ deviceId: string }>;
  consumeStepUp(input: { deviceId: string; action: StepUpAction; proof: string | null }): CredentialVaultResult<StepUpGrant>;
  /** The client device for `invite`, its key sealed in the vault (`CredentialVaultDO.mintMcpClient`). */
  mintClient(invite: SignedDeviceInvite, label: string, vaultKey: string): Promise<{ binding: DeviceBinding; sealedKey: string }>;
  /** Enrolls the client and records its connection (`CredentialVaultDO.recordMcpConnection`); inside a transaction. */
  recordConnection(input: { invite: SignedDeviceInvite; binding: DeviceBinding; sealedKey: string; label: string; tokenHash: string | null; oauth: string | null }): CredentialVaultResult<{ connectionId: string }>;
  revokeDevice(deviceId: string): void;
}

function randomToken(prefix: string): string {
  return `${prefix}${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function tokenHash(token: string): Promise<string> {
  return credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}): OAuthReply {
  return { status, body: { error, error_description: description }, headers };
}

function refuse(code: string, message: string): CredentialVaultResult<never> {
  return { status: 'error', error: { code, message } };
}

/** `uri` with `params` added to its query; absent values are left out. */
function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

/** Why a redirect URI is refused, or null: https, or http on a loopback host for a native client; no fragment or credentials. */
function redirectUriProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'it is not a URL'; }
  if (value.includes('#')) return 'it has a fragment';
  if (url.username || url.password) return 'it carries credentials';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS[url.hostname])) return null;
  return 'it must be https, or http on localhost, 127.0.0.1 or [::1]';
}

/** Registered and presented redirect URIs match exactly; a loopback one matches on any port (RFC 8252 §7.3), since a
 * native client listens on whatever port it was given. */
function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const expected = new URL(registered), actual = new URL(presented);
  return expected.protocol === 'http:' && actual.protocol === 'http:' && LOOPBACK_HOSTS[expected.hostname] === true
    && expected.hostname === actual.hostname && expected.pathname === actual.pathname && expected.search === actual.search;
}

/** The resource indicator names the account's `/mcp`; scheme and host compare case-insensitively. */
function resourceIs(value: string, resource: string): boolean {
  try {
    const url = new URL(value);
    return !value.includes('#') && url.search === '' && `${url.origin}${url.pathname}` === resource;
  } catch {
    return false;
  }
}

/** Why a metadata document URL is not fetched, or null: https on the default port, a path, and a public DNS name or
 * public IPv4 address. A Worker's fetch cannot reach private networks either; this refuses them before asking. */
function documentUrlProblem(clientId: string): string | null {
  let url: URL;
  try { url = new URL(clientId); } catch { return 'its client_id is not a URL'; }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || clientId.includes('#') || url.pathname === '/') {
    return 'a metadata document client_id is an https URL with a path, on the default port';
  }
  const host = url.hostname;
  if (host.startsWith('[') || !host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/u.test(host)) return 'its metadata document is not on a public host';
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/u.exec(host);
  if (ipv4) {
    const first = Number(ipv4[1]), second = Number(ipv4[2]);
    if (first === 0 || first === 10 || first === 127 || first >= 224 || (first === 100 && second >= 64 && second < 128) || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second < 32) || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19))) {
      return 'its metadata document is on a private address';
    }
  }
  return null;
}

/** Reads at most `limit` bytes of a body; null when it is longer. */
async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** A client's own name, logo and homepage as its metadata states them; a logo only over https. */
function clientIdentity(metadata: z.infer<typeof clientMetadataSchema>, fallbackName: string): Pick<StoredClient['view'], 'name' | 'logoUri' | 'clientUri'> {
  return {
    name: metadata.client_name ?? fallbackName,
    logoUri: metadata.logo_uri?.startsWith('https://') ? metadata.logo_uri : null,
    clientUri: metadata.client_uri ?? null,
  };
}

/**
 * Fetches a Client ID Metadata Document: https only, no redirects, at most `DOCUMENT_MAX_BYTES` in
 * `DOCUMENT_TIMEOUT_MS`; its `client_id` must equal its URL exactly. Answers the client and how long to keep it
 * (its `Cache-Control: max-age`, bounded), or why not.
 */
async function fetchClientDocument(clientId: string): Promise<{ client: StoredClient; maxAgeMs: number } | { problem: string }> {
  const refused = documentUrlProblem(clientId);
  if (refused) return { problem: refused };
  let response: Response;
  try {
    response = await fetch(clientId, { redirect: 'manual', signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS), headers: { accept: 'application/json' } });
  } catch {
    return { problem: 'its metadata document could not be fetched' };
  }
  if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > DOCUMENT_MAX_BYTES) {
    await response.body?.cancel();
    return { problem: response.status === 200 ? 'its metadata document is too large' : `its metadata document answered HTTP ${response.status}` };
  }
  let raw: unknown = null;
  try {
    const text = await boundedText(response.body, DOCUMENT_MAX_BYTES);
    if (text === null) return { problem: 'its metadata document is too large' };
    raw = JSON.parse(text);
  } catch {
    return { problem: 'its metadata document is not JSON' };
  }
  const parsed = clientDocumentSchema.safeParse(raw);
  if (!parsed.success) return { problem: 'its metadata document lacks client_id or redirect_uris' };
  const document = parsed.data;
  if (document.client_id !== clientId) return { problem: 'its metadata document names another client_id' };
  if (document.token_endpoint_auth_method !== undefined && document.token_endpoint_auth_method !== 'none') {
    return { problem: `GitSpace accepts metadata-document clients that authenticate with "none", not "${document.token_endpoint_auth_method}"` };
  }
  for (const uri of document.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return { problem: `its redirect URI ${uri} is not allowed: ${problem}` };
  }
  const host = new URL(clientId).host;
  const cacheControl = response.headers.get('cache-control') ?? '';
  const maxAge = /(?:^|,)\s*max-age=(\d+)/u.exec(cacheControl);
  const maxAgeMs = /no-store|no-cache/u.test(cacheControl) ? DOCUMENT_CACHE_MIN_MS
    : Math.min(DOCUMENT_CACHE_MAX_MS, Math.max(DOCUMENT_CACHE_MIN_MS, maxAge ? Number(maxAge[1]) * 1000 : DOCUMENT_CACHE_DEFAULT_MS));
  return {
    client: { view: { clientId, ...clientIdentity(document, host), host, registration: 'metadata-document' }, redirectUris: document.redirect_uris, authMethod: 'none' },
    maxAgeMs,
  };
}

/** The vault's side: clients, authorization requests, consent, codes and tokens. */
export class McpAuthorizationVault {
  constructor(private readonly host: McpAuthorizationHost) {}

  private get issuer(): string {
    return new URL(this.host.accountUrl).origin;
  }

  /** A registered client, or a metadata-document client from cache or fetched now; or why it is not known. */
  private async client(clientId: string): Promise<{ client: StoredClient } | { problem: string }> {
    const now = Date.now();
    const row = this.host.storage.sql.exec<{ client_json: string; expires_at: number | null }>('SELECT client_json, expires_at FROM mcp_oauth_clients WHERE client_id = ?', clientId).toArray()[0];
    if (row && (row.expires_at === null || row.expires_at > now)) return { client: storedClientSchema.parse(JSON.parse(row.client_json)) };
    if (!clientId.startsWith('https://')) return { problem: 'it is not registered with this account' };
    const fetched = await fetchClientDocument(clientId);
    if ('problem' in fetched) return fetched;
    const sql = this.host.storage.sql;
    sql.exec("DELETE FROM mcp_oauth_clients WHERE kind = 'metadata-document' AND expires_at <= ?", now);
    sql.exec("DELETE FROM mcp_oauth_clients WHERE client_id IN (SELECT client_id FROM mcp_oauth_clients WHERE kind = 'metadata-document' AND client_id != ? ORDER BY expires_at DESC LIMIT -1 OFFSET ?)", clientId, CACHED_DOCUMENTS - 1);
    sql.exec("INSERT OR REPLACE INTO mcp_oauth_clients(client_id, kind, client_json, secret_hash, created_at, expires_at) VALUES (?, 'metadata-document', ?, NULL, ?, ?)",
      clientId, JSON.stringify(fetched.client), now, now + fetched.maxAgeMs);
    return { client: fetched.client };
  }

  /** `POST /oauth/register` (RFC 7591). At most `REGISTRATIONS_PER_WINDOW` per ten minutes per account. */
  async register(body: string): Promise<OAuthReply> {
    let raw: unknown = null;
    try { raw = JSON.parse(body); } catch { return oauthError(400, 'invalid_client_metadata', 'The registration is not JSON'); }
    const parsed = clientMetadataSchema.safeParse(raw);
    if (!parsed.success) return oauthError(400, 'invalid_client_metadata', 'Client metadata needs redirect_uris, and names and URLs of bounded length');
    const metadata = parsed.data;
    for (const uri of metadata.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem) return oauthError(400, 'invalid_redirect_uri', `${uri}: ${problem}`);
    }
    const authMethod = metadata.token_endpoint_auth_method ?? 'client_secret_basic';
    if (authMethod !== 'none' && !SECRET_AUTH_METHODS[authMethod]) return oauthError(400, 'invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic');
    if (metadata.grant_types && !metadata.grant_types.includes('authorization_code')) return oauthError(400, 'invalid_client_metadata', 'grant_types must include authorization_code');
    if (metadata.response_types && !metadata.response_types.includes('code')) return oauthError(400, 'invalid_client_metadata', 'response_types must include code');
    const secret = authMethod === 'none' ? null : randomToken('gscs_');
    const secretHash = secret === null ? null : await tokenHash(secret);
    const now = Date.now();
    const sql = this.host.storage.sql;
    if (sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_oauth_clients WHERE kind = 'dynamic' AND created_at > ?", now - REGISTRATION_WINDOW_MS).one().count >= REGISTRATIONS_PER_WINDOW) {
      return oauthError(429, 'temporarily_unavailable', 'Too many client registrations for this account; try again in a few minutes', { 'retry-after': String(REGISTRATION_WINDOW_MS / 1000) });
    }
    const clientId = `gsdc_${crypto.randomUUID()}`;
    const client: StoredClient = {
      view: { clientId, ...clientIdentity(metadata, 'Unnamed client'), host: metadata.client_uri ? new URL(metadata.client_uri).host : null, registration: 'dynamic' },
      redirectUris: metadata.redirect_uris,
      authMethod: authMethod === 'none' ? 'none' : authMethod === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic',
    };
    sql.exec("INSERT INTO mcp_oauth_clients(client_id, kind, client_json, secret_hash, created_at, expires_at) VALUES (?, 'dynamic', ?, ?, ?, NULL)", clientId, JSON.stringify(client), secretHash, now);
    sql.exec(`DELETE FROM mcp_oauth_clients WHERE client_id IN (
      SELECT client_id FROM mcp_oauth_clients c WHERE kind = 'dynamic'
        AND NOT EXISTS (SELECT 1 FROM mcp_connections m WHERE json_extract(m.oauth_json, '$.client.clientId') = c.client_id)
      ORDER BY created_at DESC LIMIT -1 OFFSET ?)`, UNUSED_DYNAMIC_CLIENTS);
    return {
      status: 201,
      headers: {},
      body: {
        client_id: clientId, client_id_issued_at: Math.floor(now / 1000),
        ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
        client_name: client.view.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: client.authMethod,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        ...(client.view.clientUri ? { client_uri: client.view.clientUri } : {}), ...(client.view.logoUri ? { logo_uri: client.view.logoUri } : {}),
      },
    };
  }

  /**
   * `GET /oauth/authorize`. A client it cannot identify, or a redirect URI the client did not register, is refused on a
   * page (never redirected); any other problem goes back to the client's redirect URI with `state` and `iss`. A valid
   * request waits ten minutes for the consent page.
   */
  async authorize(query: Record<string, string>): Promise<AuthorizeOutcome> {
    const clientId = query.client_id;
    if (!clientId) return { kind: 'refused', status: 400, message: 'The request names no client (client_id).' };
    const resolved = await this.client(clientId);
    if ('problem' in resolved) return { kind: 'refused', status: 400, message: `GitSpace cannot identify this client: ${resolved.problem}.` };
    const { client } = resolved;
    const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || redirectUriProblem(redirectUri) !== null || !client.redirectUris.some(registered => redirectMatches(registered, redirectUri))) {
      return { kind: 'refused', status: 400, message: 'The redirect_uri is not one this client registered.' };
    }
    const state = query.state ?? null;
    const fail = (error: string, description: string): AuthorizeOutcome => ({ kind: 'redirect', location: redirectWith(redirectUri, { error, error_description: description, state, iss: this.issuer }) });
    if (query.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/u.test(query.code_challenge ?? '')) return fail('invalid_request', 'PKCE is required: send a code_challenge with code_challenge_method=S256');
    const resource = `${this.issuer}/mcp`;
    if (query.resource !== undefined && !resourceIs(query.resource, resource)) return fail('invalid_target', `This server issues tokens only for ${resource}`);
    if (state !== null && state.length > 2_048) return fail('invalid_request', 'state is longer than 2048 characters');
    const known = deviceCapabilitySchema.options;
    const capabilities = known.filter(capability => (query.scope ?? '').split(' ').includes(capability));
    const request: AuthorizationRequest = { client: client.view, redirectUri, state, codeChallenge: query.code_challenge ?? '', capabilities, resource };
    const requestId = crypto.randomUUID();
    const now = Date.now();
    const sql = this.host.storage.sql;
    sql.exec('DELETE FROM mcp_oauth_requests WHERE expires_at <= ?', now);
    sql.exec('DELETE FROM mcp_oauth_requests WHERE request_id IN (SELECT request_id FROM mcp_oauth_requests ORDER BY expires_at DESC LIMIT -1 OFFSET ?)', OPEN_REQUESTS - 1);
    sql.exec("INSERT INTO mcp_oauth_requests(request_id, request_json, expires_at, state) VALUES (?, ?, ?, 'pending')", requestId, JSON.stringify(request), now + REQUEST_TTL_MS);
    return { kind: 'consent', requestId };
  }

  /** A request still waiting for a decision. */
  private pending(requestId: string): CredentialVaultResult<{ request: AuthorizationRequest; expiresAt: number }> {
    const row = this.host.storage.sql.exec<{ request_json: string; expires_at: number; state: string }>('SELECT request_json, expires_at, state FROM mcp_oauth_requests WHERE request_id = ?', requestId).toArray()[0];
    if (!row) return refuse('MCP_OAUTH_REQUEST_UNKNOWN', 'This connection request is unknown or expired; start again from your app');
    if (row.state !== 'pending') return refuse('MCP_OAUTH_REQUEST_DECIDED', 'This connection request was already answered');
    if (row.expires_at <= Date.now()) return refuse('MCP_OAUTH_REQUEST_EXPIRED', 'This connection request expired; start again from your app');
    return { status: 'ok', value: { request: authorizationRequestSchema.parse(JSON.parse(row.request_json)), expiresAt: row.expires_at } };
  }

  /**
   * The consent page's API, from a signed-in account-wide browser. `view` shows the request. `decide` denies it, or
   * allows it with the client invitation the browser signed: the vault makes the client's key, enrolls it, records the
   * connection and a one-time code (sixty seconds), and answers the client's redirect URI with the code, `state` and
   * `iss`. Powerful permissions spend an `mcp-oauth.grant` step-up naming the request in the same transaction.
   */
  async consent(input: { operation: 'view' | 'decide'; header: string | null; stepUp: string | null; target: string; body: Uint8Array }): Promise<CredentialVaultResult<McpOAuthConsentView | { redirectUrl: string }>> {
    const config = this.host.config();
    if (!config) return refuse('VAULT_UNCONFIGURED', 'Vault is not configured');
    let raw: unknown = null;
    try { raw = JSON.parse(new TextDecoder().decode(input.body)); } catch { return refuse('MCP_OAUTH_CONSENT_INVALID', 'The consent request is not JSON'); }
    if (input.operation === 'view') {
      const parsed = mcpOAuthConsentViewRequestSchema.safeParse(raw);
      if (!parsed.success || parsed.data.userId !== config.user_id) return refuse('MCP_OAUTH_CONSENT_INVALID', 'The consent request is invalid or belongs to another account');
      const authorized = this.host.authorizeBrowser({ header: input.header, target: input.target, body: input.body, capabilities: ['rpc.read'] });
      if (authorized.status === 'error') return authorized;
      const pending = this.pending(parsed.data.requestId);
      if (pending.status === 'error') return pending;
      const { request, expiresAt } = pending.value;
      const redirect = new URL(request.redirectUri);
      return { status: 'ok', value: {
        requestId: parsed.data.requestId, client: request.client, redirectUri: request.redirectUri, redirectHost: redirect.host,
        loopback: LOOPBACK_HOSTS[redirect.hostname] === true, requestedCapabilities: request.capabilities, expiresAt,
      } };
    }
    const parsed = mcpOAuthConsentDecisionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.userId !== config.user_id) return refuse('MCP_OAUTH_CONSENT_INVALID', 'The consent request is invalid or belongs to another account');
    const decision = parsed.data;
    const browserRequest = { header: input.header, target: input.target, body: input.body, capabilities: ['devices.manage'] satisfies DeviceCapability[] };
    const authorized = this.host.authorizeBrowser(browserRequest);
    if (authorized.status === 'error') return authorized;
    const pending = this.pending(decision.requestId);
    if (pending.status === 'error') return pending;
    const { request } = pending.value;
    const decided = () => this.host.storage.sql.exec("UPDATE mcp_oauth_requests SET state = 'decided' WHERE request_id = ? AND state = 'pending'", decision.requestId).rowsWritten === 1;
    if (decision.decision === 'deny') {
      if (!decided()) return refuse('MCP_OAUTH_REQUEST_DECIDED', 'This connection request was already answered');
      return { status: 'ok', value: { redirectUrl: redirectWith(request.redirectUri, { error: 'access_denied', error_description: 'The account owner declined the connection', state: request.state, iss: this.issuer }) } };
    }
    const { invite } = decision;
    const browser = this.host.currentDevice(authorized.value.deviceId);
    if (!browser?.canDelegate || invite.issuer.kind !== 'device' || invite.issuer.deviceId !== browser.deviceId || invite.invite.userId !== config.user_id
      || invite.invite.kind !== 'client' || invite.invite.canDelegate || invite.invite.scope.kind === 'workspace') {
      return refuse('RPC_FORBIDDEN', 'An MCP client grant needs a non-delegating client invitation for the account or its projects, signed by this browser');
    }
    const label = request.client.name;
    const { binding, sealedKey } = await this.host.mintClient(invite, label, config.vault_key);
    const code = randomToken('gsoc_');
    const codeHash = await tokenHash(code);
    // Crypto yields: authority and the request are checked again where the grant is written.
    return this.host.storage.transactionSync((): CredentialVaultResult<{ redirectUrl: string }> => {
      const again = this.host.authorizeBrowser(browserRequest);
      if (again.status === 'error') return again;
      const still = this.pending(decision.requestId);
      if (still.status === 'error') return still;
      if (invite.invite.capabilities.some(capability => MCP_STEP_UP_CAPABILITIES[capability])) {
        const stepped = this.host.consumeStepUp({ deviceId: browser.deviceId, action: { purpose: 'mcp-oauth.grant', targets: [decision.requestId] }, proof: input.stepUp });
        if (stepped.status === 'error') return stepped;
      }
      const recorded = this.host.recordConnection({
        invite, binding, sealedKey, label, tokenHash: null,
        oauth: JSON.stringify({ client: request.client, redirectHost: new URL(request.redirectUri).host }),
      });
      if (recorded.status === 'error') return recorded;
      decided();
      this.host.storage.sql.exec("INSERT INTO mcp_oauth_tokens(token_hash, kind, connection_id, expires_at, used_at, code_json) VALUES (?, 'code', ?, ?, NULL, ?)",
        codeHash, recorded.value.connectionId, Date.now() + CODE_TTL_MS,
        JSON.stringify({ clientId: request.client.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, resource: request.resource } satisfies z.infer<typeof codeSchema>));
      return { status: 'ok', value: { redirectUrl: redirectWith(request.redirectUri, { code, state: request.state, iss: this.issuer }) } };
    });
  }

  /** Why the token endpoint does not accept this client's authentication, or null. Metadata-document clients are
   * public; a dynamic client authenticates as it registered. */
  private async authenticate(clientId: string, secret: string | null): Promise<string | null> {
    if (clientId.startsWith('https://')) return null;
    const row = this.host.storage.sql.exec<{ secret_hash: string | null }>("SELECT secret_hash FROM mcp_oauth_clients WHERE client_id = ? AND kind = 'dynamic'", clientId).toArray()[0];
    if (!row) return 'This client is not registered with this account';
    if (row.secret_hash === null) return null;
    if (secret === null) return 'This client authenticates with its client secret';
    return await tokenHash(secret) === row.secret_hash ? null : 'The client secret is wrong';
  }

  /** A presented code or refresh token was already spent: whoever holds it is not the client alone, so the grant goes. */
  private revokeConnection(connectionId: string): void {
    const row = this.host.storage.sql.exec<{ device_id: string }>('SELECT device_id FROM mcp_connections WHERE id = ?', connectionId).toArray()[0];
    if (row) this.host.revokeDevice(row.device_id);
    this.host.storage.sql.exec('DELETE FROM mcp_oauth_tokens WHERE connection_id = ?', connectionId);
  }

  /** A new access and refresh token for a connection whose grant is current. Inside the exchange's transaction. */
  private issue(connectionId: string, tokens: { access: string; accessHash: string; refresh: string; refreshHash: string }, now: number): OAuthReply {
    const sql = this.host.storage.sql;
    const row = sql.exec<{ device_id: string }>('SELECT device_id FROM mcp_connections WHERE id = ?', connectionId).toArray()[0];
    const device = row ? this.host.currentDevice(row.device_id) : null;
    if (!device) return oauthError(400, 'invalid_grant', 'The grant was revoked or has expired');
    const accessExpiresAt = Math.min(now + ACCESS_TOKEN_TTL_MS, device.expiresAt ?? Infinity);
    sql.exec("DELETE FROM mcp_oauth_tokens WHERE connection_id = ? AND ((kind = 'access' AND expires_at <= ?) OR (kind = 'code' AND expires_at <= ?) OR (kind = 'refresh' AND used_at <= ?))",
      connectionId, now, now, now - SPENT_TOKEN_RETENTION_MS);
    sql.exec("INSERT INTO mcp_oauth_tokens(token_hash, kind, connection_id, expires_at, used_at, code_json) VALUES (?, 'access', ?, ?, NULL, NULL)", tokens.accessHash, connectionId, accessExpiresAt);
    sql.exec("INSERT INTO mcp_oauth_tokens(token_hash, kind, connection_id, expires_at, used_at, code_json) VALUES (?, 'refresh', ?, ?, NULL, NULL)", tokens.refreshHash, connectionId, device.expiresAt);
    return {
      status: 200,
      headers: {},
      body: { access_token: tokens.access, token_type: 'Bearer', expires_in: Math.floor((accessExpiresAt - now) / 1000), refresh_token: tokens.refresh, scope: device.capabilities.join(' ') },
    };
  }

  /** `POST /oauth/token`: `authorization_code` with PKCE, or `refresh_token`, which rotates. */
  async token(form: Record<string, string>, authorization: string | null): Promise<OAuthReply> {
    const grantType = form.grant_type;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    let basic: { clientId: string; secret: string } | null = null;
    if (authorization?.startsWith('Basic ')) {
      try {
        const [id, secret] = atob(authorization.slice('Basic '.length)).split(':', 2);
        basic = id !== undefined && secret !== undefined ? { clientId: decodeURIComponent(id), secret: decodeURIComponent(secret) } : null;
      } catch {
        basic = null;
      }
      if (!basic) return oauthError(401, 'invalid_client', 'The Basic authorization is malformed', { 'www-authenticate': 'Basic realm="GitSpace"' });
    }
    if (basic && form.client_id !== undefined && form.client_id !== basic.clientId) return oauthError(400, 'invalid_request', 'client_id differs from the authenticated client');
    const clientId = basic?.clientId ?? form.client_id;
    if (!clientId) return oauthError(401, 'invalid_client', 'Name the client with client_id');
    const problem = await this.authenticate(clientId, basic?.secret ?? form.client_secret ?? null);
    if (problem) return oauthError(401, 'invalid_client', problem, basic ? { 'www-authenticate': 'Basic realm="GitSpace"' } : {});
    const presented = grantType === 'authorization_code' ? form.code : form.refresh_token;
    if (!presented) return oauthError(400, 'invalid_request', grantType === 'authorization_code' ? 'code is missing' : 'refresh_token is missing');
    const access = randomToken('gsoa_'), refresh = randomToken('gsor_');
    const [presentedHash, accessHash, refreshHash] = await Promise.all([tokenHash(presented), tokenHash(access), tokenHash(refresh)]);
    const tokens = { access, accessHash, refresh, refreshHash };
    const resource = `${this.issuer}/mcp`;
    if (form.resource !== undefined && !resourceIs(form.resource, resource)) return oauthError(400, 'invalid_target', `This server issues tokens only for ${resource}`);
    const sql = this.host.storage.sql;
    if (grantType === 'authorization_code') {
      const verifier = form.code_verifier ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return oauthError(400, 'invalid_request', 'code_verifier is missing or malformed');
      const challenge = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      // One synchronous exchange: a code is spent at most once.
      return this.host.storage.transactionSync((): OAuthReply => {
        const now = Date.now();
        const row = sql.exec<{ connection_id: string; expires_at: number; used_at: number | null; code_json: string }>("SELECT connection_id, expires_at, used_at, code_json FROM mcp_oauth_tokens WHERE token_hash = ? AND kind = 'code'", presentedHash).toArray()[0];
        if (!row) return oauthError(400, 'invalid_grant', 'The authorization code is unknown');
        const code = codeSchema.parse(JSON.parse(row.code_json));
        if (code.clientId !== clientId) return oauthError(400, 'invalid_grant', 'The authorization code was issued to another client');
        if (row.used_at !== null) {
          this.revokeConnection(row.connection_id);
          return oauthError(400, 'invalid_grant', 'The authorization code was already used; the grant it made is revoked');
        }
        if (row.expires_at <= now) return oauthError(400, 'invalid_grant', 'The authorization code expired');
        if (form.redirect_uri !== code.redirectUri) return oauthError(400, 'invalid_grant', 'redirect_uri differs from the authorization request');
        if (challenge !== code.codeChallenge) return oauthError(400, 'invalid_grant', 'The code_verifier does not match the code_challenge');
        sql.exec('UPDATE mcp_oauth_tokens SET used_at = ? WHERE token_hash = ?', now, presentedHash);
        return this.issue(row.connection_id, tokens, now);
      });
    }
    return this.host.storage.transactionSync((): OAuthReply => {
      const now = Date.now();
      const row = sql.exec<{ connection_id: string; expires_at: number | null; used_at: number | null }>("SELECT connection_id, expires_at, used_at FROM mcp_oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", presentedHash).toArray()[0];
      if (!row) return oauthError(400, 'invalid_grant', 'The refresh token is unknown or its grant was revoked');
      const connection = sql.exec<{ oauth_json: string | null }>('SELECT oauth_json FROM mcp_connections WHERE id = ?', row.connection_id).toArray()[0];
      const owner = connection?.oauth_json ? connectionClientSchema.safeParse(JSON.parse(connection.oauth_json)) : null;
      if (!owner?.success || owner.data.client.clientId !== clientId) return oauthError(400, 'invalid_grant', 'The refresh token was issued to another client');
      if (row.used_at !== null) {
        this.revokeConnection(row.connection_id);
        return oauthError(400, 'invalid_grant', 'The refresh token was already used; the grant is revoked');
      }
      if (row.expires_at !== null && row.expires_at <= now) return oauthError(400, 'invalid_grant', 'The refresh token expired');
      sql.exec('UPDATE mcp_oauth_tokens SET used_at = ? WHERE token_hash = ?', now, presentedHash);
      return this.issue(row.connection_id, tokens, now);
    });
  }
}

/** Form or query parameters, each named at most once (RFC 6749 §3.1); null when one repeats. */
function singleParameters(parameters: URLSearchParams): Record<string, string> | null {
  const seen = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (seen.has(name)) return null;
    seen.set(name, value);
  }
  return Object.fromEntries(seen);
}

function oauthResponse(reply: OAuthReply): Response {
  return Response.json(reply.body, { status: reply.status, headers: { ...CORS, 'cache-control': 'no-store', pragma: 'no-cache', ...reply.headers } });
}

/** The page an authorization request that cannot go back to its client ends on. */
function refusalPage(status: number, message: string): Response {
  const escaped = message.replace(/[&<>"']/gu, character => HTML_ESCAPES[character] ?? character);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitSpace connection request</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">This connection request cannot continue</h1><p>${escaped}</p><p>Start again from the app that sent you here.</p></body></html>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' },
  });
}

/** A call to the vault, or null when it failed. Right after a release the vault can still run code without the OAuth
 * methods: `acrossRelease` retries that for a few seconds. Callers answer "try again" rather than an error that names the
 * cause. */
async function reach<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await acrossRelease(call);
  } catch (error) {
    console.error(JSON.stringify({ event: 'mcp_oauth_vault_unavailable', message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > BODY_MAX_BYTES) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength > BODY_MAX_BYTES ? null : body;
}

/**
 * The OAuth routes on the account origin: protected resource metadata (RFC 9728) at
 * `/.well-known/oauth-protected-resource[/mcp]`, authorization server metadata (RFC 8414) at
 * `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, the consent page
 * `/oauth/consent` (served by `frontend`, never framed) and its API `/v1/mcp-oauth/consent/(view|decide)`.
 */
export async function serveMcpAuthorization(request: Request, env: Env, frontend: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const issuer = new URL(env.ACCOUNT_URL).origin;
  const resource = `${issuer}/mcp`;
  const metadata = path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-authorization-server';
  if ((metadata || path === '/oauth/register' || path === '/oauth/token') && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (metadata) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...CORS, allow: 'GET, HEAD, OPTIONS' } });
    const document = path === '/.well-known/oauth-authorization-server' ? {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      scopes_supported: deviceCapabilitySchema.options,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    } : {
      resource,
      authorization_servers: [issuer],
      scopes_supported: DEFAULT_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'GitSpace',
    };
    return Response.json(document, { headers: { ...CORS, 'cache-control': 'public, max-age=300' } });
  }
  if (path === MCP_OAUTH_CONSENT_PAGE) {
    const page = await frontend(request);
    const framed = new Response(page.body, page);
    framed.headers.set('content-security-policy', "frame-ancestors 'none'");
    framed.headers.set('x-frame-options', 'DENY');
    framed.headers.set('referrer-policy', 'no-referrer');
    return framed;
  }
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  const unavailable = oauthError(503, 'temporarily_unavailable', 'GitSpace authorization is briefly unavailable; try again in a minute', { 'retry-after': '30' });
  if (path === '/oauth/register') {
    if (request.method !== 'POST') return oauthResponse(oauthError(405, 'invalid_request', 'Register with POST'));
    const body = await boundedBody(request);
    if (!body) return oauthResponse(oauthError(413, 'invalid_client_metadata', 'The registration is too large'));
    return oauthResponse(await reach(() => vault.mcpOAuthRegister(new TextDecoder().decode(body))) ?? unavailable);
  }
  if (path === '/oauth/token') {
    if (request.method !== 'POST') return oauthResponse(oauthError(405, 'invalid_request', 'Exchange tokens with POST'));
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return oauthResponse(oauthError(400, 'invalid_request', 'The token request must be application/x-www-form-urlencoded'));
    const body = await boundedBody(request);
    const form = body ? singleParameters(new URLSearchParams(new TextDecoder().decode(body))) : null;
    if (!form) return oauthResponse(oauthError(400, 'invalid_request', 'The token request is too large or repeats a parameter'));
    return oauthResponse(await reach(() => vault.mcpOAuthToken(form, request.headers.get('authorization'))) ?? unavailable);
  }
  if (path === '/oauth/authorize') {
    if (request.method !== 'GET') return refusalPage(405, 'Authorization requests use GET.');
    const query = singleParameters(url.searchParams);
    if (!query) return refusalPage(400, 'The request repeats a parameter.');
    const outcome = await reach<AuthorizeOutcome>(() => vault.mcpOAuthAuthorize(query));
    if (!outcome) return refusalPage(503, 'GitSpace authorization is briefly unavailable. Try again in a minute.');
    if (outcome.kind === 'refused') return refusalPage(outcome.status, outcome.message);
    const location = outcome.kind === 'redirect' ? outcome.location : `${issuer}${MCP_OAUTH_CONSENT_PAGE}?request=${encodeURIComponent(outcome.requestId)}`;
    return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  const consent = new RegExp(`^${MCP_OAUTH_CONSENT_API}/(view|decide)$`, 'u').exec(path)?.[1];
  if (consent === 'view' || consent === 'decide') {
    const headers = { 'cache-control': 'private, no-store' };
    if (request.method !== 'POST' || request.headers.get('origin') !== issuer) return Response.json(refuse('ORIGIN_REJECTED', 'The consent page runs on the account origin'), { status: 403, headers });
    const body = await boundedBody(request);
    if (!body) return Response.json(refuse('MCP_OAUTH_CONSENT_INVALID', 'The consent request is too large'), { status: 413, headers });
    const result = await reach<CredentialVaultResult<McpOAuthConsentView | { redirectUrl: string }>>(() => vault.mcpOAuthConsent({ operation: consent, header: request.headers.get(RPC_DEVICE_HEADER), stepUp: request.headers.get(STEP_UP_HEADER), target: `${path}${url.search}`, body }));
    if (!result) return Response.json(refuse('MCP_OAUTH_UNAVAILABLE', 'GitSpace authorization is briefly unavailable; try again in a minute'), { status: 503, headers });
    const code = result.status === 'error' ? result.error.code : '';
    const status = result.status === 'ok' ? 200 : code.startsWith('STEP_UP_') || code === 'RPC_FORBIDDEN' ? 403 : code.startsWith('RPC_') ? 401 : code.startsWith('MCP_OAUTH_REQUEST_') ? 410 : 400;
    return Response.json(result, { status, headers });
  }
  return new Response('Not found', { status: 404 });
}
