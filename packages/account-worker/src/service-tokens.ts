import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import {
  SERVICE_TOKEN_HEADER, SERVICE_TOKEN_MAX_TTL_S, SERVICE_TOKEN_REFRESH_PATH, SERVICE_TOKEN_REFRESH_TTL_S, SERVICE_TOKEN_KEY_ROTATION_S,
  type ServiceTokenGrant, type ServiceTokenRequest, type ServiceTokensView,
} from '@gitspace/protocol-environment';

/**
 * Service tokens: the account vault holds one P-256 key per workspace and service, sealed with the vault key, and signs
 * with it; only public keys leave the vault. Each workspace URL's hosted route registry keeps the public keys, the tokens
 * issued for it (which the edge admits only while listed and unrevoked) and its hashed refresh tokens.
 */

/** A managed key's public half and its lifetime: it signs until `signsUntil` and verifies until `verifiesUntil`. */
export const ManagedKeySchema = z.object({
  kid: z.string().min(1).max(64),
  jwk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(1), y: z.string().min(1) }).strict(),
  createdAt: z.string(),
  signsUntil: z.string(),
  verifiesUntil: z.string(),
}).strict();
export type ManagedKey = z.infer<typeof ManagedKeySchema>;

/** The private JWK the vault seals: the curve point and `d`, nothing else. */
const PrivateJwkSchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(1), y: z.string().min(1), d: z.string().min(1) });

/** A token the registry admits while it is listed, unexpired and unrevoked; `family` names its refresh chain. */
export interface ManagedTokenRecord {
  jti: string;
  subject: string;
  issuedAt: string;
  expiresAt: string;
  family: string | null;
}

export interface ManagedRefreshRecord {
  hash: string;
  family: string;
  subject: string;
  expiresAt: string;
}

/** What the vault answers for a signed token: never the private key. */
export interface SignedServiceToken {
  token: string;
  hostname: string;
  port: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  keys: ManagedKey[];
}

/** Where a key's lifetime ends after it is created at `now`: signing for 7 days, verifying 8 hours more. */
export function managedKeyLifetime(now: number): Pick<ManagedKey, 'createdAt' | 'signsUntil' | 'verifiesUntil'> {
  const signsUntil = now + SERVICE_TOKEN_KEY_ROTATION_S * 1000;
  return { createdAt: new Date(now).toISOString(), signsUntil: new Date(signsUntil).toISOString(), verifiesUntil: new Date(signsUntil + SERVICE_TOKEN_MAX_TTL_S * 1000).toISOString() };
}

/** A new P-256 key: its private JWK (for the vault to seal) and its public key with the RFC 7638 thumbprint as `kid`. */
export async function createManagedKey(now: number): Promise<{ privateJwk: string; key: ManagedKey }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const exported = await exportJWK(publicKey);
  const jwk = ManagedKeySchema.shape.jwk.parse({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });
  return { privateJwk: JSON.stringify(PrivateJwkSchema.parse(await exportJWK(privateKey))), key: { kid: await calculateJwkThumbprint(jwk), jwk, ...managedKeyLifetime(now) } };
}

export async function signManagedToken(privateJwk: string, kid: string, claims: { issuer: string; audience: string; subject: string; jti: string; issuedAt: number; expiresAt: number }): Promise<string> {
  const key = await importJWK(PrivateJwkSchema.parse(JSON.parse(privateJwk)), 'ES256');
  return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(claims.issuer).setAudience(claims.audience).setSubject(claims.subject).setJti(claims.jti)
    .setIssuedAt(claims.issuedAt).setExpirationTime(claims.expiresAt).sign(key);
}

/** The public keys the edge verifies a workspace URL's managed tokens with. */
export interface ManagedJwks {
  keys: Array<ManagedKey['jwk'] & { kid: string; alg: 'ES256'; use: 'sig' }>;
}

/** The `managed` credential the registry adds on routes that set `tokens: true`. */
export interface ManagedIngressCredential {
  kind: 'managed';
  issuer: string;
  keys: ManagedJwks;
}

/** The keys the edge verifies with now: those whose tokens may still be live. */
export function verifyingKeys(keys: readonly ManagedKey[], now: string): ManagedJwks {
  return { keys: keys.filter(key => key.verifiesUntil > now).map(key => ({ ...key.jwk, kid: key.kid, alg: 'ES256', use: 'sig' })) };
}

export async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** An opaque refresh token (256 random bits, base64url) and the hash the registry keeps. */
async function newRefreshToken(): Promise<{ token: string; hash: string }> {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  return { token, hash: await sha256Hex(token) };
}

/**
 * Signs an access token for one of the workspace service's URLs and lists it with that URL's registry; with `refresh`,
 * also a refresh token that starts a chain. A token the registry did not list is refused at the edge.
 */
export async function mintServiceToken(env: Env, workspaceId: string, request: ServiceTokenRequest): Promise<ServiceTokenGrant> {
  const jti = crypto.randomUUID();
  const signed = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).signServiceToken({
    workspaceId, service: request.service, ...(request.port ? { port: request.port } : {}), subject: request.subject,
    ttlSeconds: request.ttlSeconds ?? SERVICE_TOKEN_MAX_TTL_S, jti,
  });
  const refresh = request.refresh ? await newRefreshToken() : null;
  const family = refresh ? crypto.randomUUID() : null;
  const refreshExpiresAt = new Date(Date.parse(signed.issuedAt) + SERVICE_TOKEN_REFRESH_TTL_S * 1000).toISOString();
  await env.HOSTED_ROUTES.getByName(signed.hostname).issueManaged(env.ACCOUNT_ID, workspaceId, signed.keys,
    { jti, subject: request.subject, issuedAt: signed.issuedAt, expiresAt: signed.expiresAt, family },
    refresh && family ? { hash: refresh.hash, family, subject: request.subject, expiresAt: refreshExpiresAt } : null);
  return {
    service: request.service, port: signed.port, url: `https://${signed.hostname}`, subject: request.subject, header: SERVICE_TOKEN_HEADER,
    token: signed.token, expiresAt: signed.expiresAt,
    ...(refresh ? { refreshToken: refresh.token, refreshExpiresAt, refreshUrl: `https://${signed.hostname}${SERVICE_TOKEN_REFRESH_PATH}` } : {}),
  };
}

/** The service's keys from the vault and the unexpired tokens of each of its URLs from their registries. */
export async function serviceTokensView(env: Env, workspaceId: string, service: string): Promise<ServiceTokensView> {
  const state = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).serviceTokenKeys(workspaceId, service);
  const tokens = await Promise.all(state.urls.map(async url => (await env.HOSTED_ROUTES.getByName(url.hostname).managedTokens(env.ACCOUNT_ID, workspaceId))
    .map(token => ({ ...token, url: `https://${url.hostname}` }))));
  return {
    service,
    urls: state.urls.map(url => ({ port: url.port, url: `https://${url.hostname}` })),
    keys: state.keys.map(key => ({ fingerprint: key.kid, createdAt: key.createdAt, signsUntil: key.signsUntil, verifiesUntil: key.verifiesUntil })),
    tokens: tokens.flat().toSorted((left, right) => right.issuedAt.localeCompare(left.issuedAt)),
  };
}

/** A new key signs from now and every earlier key of the service stops verifying, which ends every token it signed. */
export async function rotateServiceTokenKey(env: Env, workspaceId: string, service: string): Promise<ServiceTokensView> {
  const state = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).rotateServiceTokenKey(workspaceId, service);
  await Promise.all(state.urls.map(url => env.HOSTED_ROUTES.getByName(url.hostname).updateManagedKeys(env.ACCOUNT_ID, workspaceId, state.keys)));
  return serviceTokensView(env, workspaceId, service);
}

/** Ends one issued token and, when it came with a refresh token, its whole refresh chain. */
export async function revokeServiceToken(env: Env, workspaceId: string, service: string, url: string, id: string): Promise<ServiceTokensView> {
  const state = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).serviceTokenKeys(workspaceId, service);
  const hostname = state.urls.find(entry => `https://${entry.hostname}` === url)?.hostname;
  if (!hostname) throw new Error(`${url} is not a workspace URL of ${service}`);
  if (!await env.HOSTED_ROUTES.getByName(hostname).revokeManaged(env.ACCOUNT_ID, workspaceId, id)) throw new Error('That token is not listed for this service; it may have expired');
  return serviceTokensView(env, workspaceId, service);
}

const RefreshRequestSchema = z.object({ refresh_token: z.string().min(1).max(256) }).strip();
const OAUTH_HEADERS = { 'cache-control': 'no-store', pragma: 'no-cache' };

/**
 * `POST https://<service URL>/__gitspace/token` with `{refresh_token}`: exchanges a refresh token once for a new access
 * token and refresh token (OAuth names). The registry decides the exchange; presenting a spent refresh token revokes its
 * whole chain.
 */
export async function serveServiceTokenRefresh(env: Env, request: Request): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'invalid_request', error_description: 'Use POST' }, { status: 405, headers: { ...OAUTH_HEADERS, allow: 'POST' } });
  let body: z.infer<typeof RefreshRequestSchema>;
  try { body = RefreshRequestSchema.parse(await request.json()); } catch {
    return Response.json({ error: 'invalid_request', error_description: 'Send JSON {"refresh_token": "…"}' }, { status: 400, headers: OAUTH_HEADERS });
  }
  const invalid = () => Response.json({ error: 'invalid_grant' }, { status: 400, headers: OAUTH_HEADERS });
  const hostname = new URL(request.url).hostname;
  const registry = env.HOSTED_ROUTES.getByName(hostname);
  const hash = await sha256Hex(body.refresh_token);
  const found = await registry.redeemRefresh(hash);
  if (!found || found.tenant !== env.ACCOUNT_ID) return invalid();
  const jti = crypto.randomUUID();
  let signed: SignedServiceToken;
  try {
    signed = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).signServiceToken({ workspaceId: found.workspaceId, service: found.service, port: found.port, subject: found.subject, ttlSeconds: SERVICE_TOKEN_MAX_TTL_S, jti });
  } catch { return invalid(); }
  if (signed.hostname !== hostname) return invalid();
  const next = await newRefreshToken();
  const refreshExpiresAt = new Date(Date.parse(signed.issuedAt) + SERVICE_TOKEN_REFRESH_TTL_S * 1000).toISOString();
  const exchanged = await registry.exchangeRefresh(hash, signed.keys,
    { jti, subject: found.subject, issuedAt: signed.issuedAt, expiresAt: signed.expiresAt, family: found.family },
    { hash: next.hash, family: found.family, subject: found.subject, expiresAt: refreshExpiresAt });
  if (!exchanged) return invalid();
  return Response.json({
    access_token: signed.token, token_type: 'Bearer', expires_in: Math.round((Date.parse(signed.expiresAt) - Date.parse(signed.issuedAt)) / 1000), refresh_token: next.token,
  }, { headers: OAUTH_HEADERS });
}
