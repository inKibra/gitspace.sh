import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from 'cloudflare:workers';
import { createLocalJWKSet, createRemoteJWKSet, customFetch, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ingressUrlAllowed } from '@gitspace/protocol-environment';
import type { HostedIngress, HostedRouteTarget, StoredIngressCredential } from './hosted-route-registry.js';
import { fetchInternalService } from './service-access.js';

/** The caller's token when the app's own `Authorization` passes through. */
const INGRESS_HEADER = 'gitspace-ingress';
const ALGORITHMS = ['EdDSA', 'ES256', 'RS256'];
const MAX_TOKEN_AGE_S = 300;
/** A caller's clock may run this far ahead of ours. */
const CLOCK_TOLERANCE_S = 5;
const FETCH_TIMEOUT_MS = 5_000;
const DOCUMENT_LIMIT = 65_536;
const ISSUER_CACHE_MS = 600_000;
/** An unknown `kid` refetches an issuer's keys at most this often. */
const KEYS_COOLDOWN_MS = 30_000;
const CLAIM_REASONS: Record<string, string> = { aud: 'audience', iss: 'issuer', iat: 'issued_at', nbf: 'not_yet_valid', sub: 'subject' };
const ERROR_REASONS: Record<string, string> = {
  ERR_JOSE_ALG_NOT_ALLOWED: 'algorithm', ERR_JWS_SIGNATURE_VERIFICATION_FAILED: 'signature', ERR_JWKS_NO_MATCHING_KEY: 'unknown_key', ERR_JWKS_MULTIPLE_MATCHING_KEYS: 'ambiguous_key',
};
const DiscoverySchema = z.looseObject({ issuer: z.string(), jwks_uri: z.string() });

class IngressRejected extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** Per isolate: each OIDC issuer's discovered key set, which itself refetches on an unknown `kid` after its cooldown. */
const issuers = new Map<string, { jwksUri: string; keys: JWTVerifyGetKey; discoveredAt: number }>();

/** One JSON document: no redirects, at most 64 KiB. */
async function fetchDocument(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' }, signal });
  const reader = response.body?.getReader();
  if (response.status !== 200 || !reader) {
    await reader?.cancel();
    throw new Error(`${url} answered ${response.status}`);
  }
  const decoder = new TextDecoder();
  let text = '', size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > DOCUMENT_LIMIT) {
      await reader.cancel();
      throw new Error(`${url} exceeds 64 KiB`);
    }
    text += decoder.decode(read.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

async function issuerKeys(issuer: string): Promise<JWTVerifyGetKey> {
  const cached = issuers.get(issuer);
  if (cached && Date.now() - cached.discoveredAt < ISSUER_CACHE_MS) return cached.keys;
  let discovery: z.infer<typeof DiscoverySchema>;
  try {
    discovery = DiscoverySchema.parse(await fetchDocument(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`, AbortSignal.timeout(FETCH_TIMEOUT_MS)));
  } catch { throw new IngressRejected('discovery_failed'); }
  if (discovery.issuer !== issuer || !ingressUrlAllowed(discovery.jwks_uri)) throw new IngressRejected('discovery_failed');
  const keys = cached?.jwksUri === discovery.jwks_uri ? cached.keys : createRemoteJWKSet(new URL(discovery.jwks_uri), {
    timeoutDuration: FETCH_TIMEOUT_MS, cooldownDuration: KEYS_COOLDOWN_MS, cacheMaxAge: ISSUER_CACHE_MS,
    // A provider's key set may carry certificates and keys for other uses; the token's `alg`, `kid` and `use` pick one.
    [customFetch]: async (url, options) => {
      try { return Response.json(await fetchDocument(url, options.signal)); } catch { throw new IngressRejected('keys_unavailable'); }
    },
  });
  issuers.set(issuer, { jwksUri: discovery.jwks_uri, keys, discoveredAt: Date.now() });
  return keys;
}

/** Null when the credential admits the token, else why it does not. */
async function rejection(credential: StoredIngressCredential, token: string, request: Request, url: URL): Promise<string | null> {
  if (credential.kind === 'bearer') {
    const encoder = new TextEncoder();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return credential.hashes.some(hash => timingSafeEqual(encoder.encode(digest), encoder.encode(hash))) ? null : 'bearer_mismatch';
  }
  try {
    const keys: JWTVerifyGetKey = credential.kind === 'jwt' ? createLocalJWKSet(credential.keys) : async (header, input) => (await issuerKeys(credential.issuer))(header, input);
    const { payload } = await jwtVerify(token, keys, {
      issuer: credential.issuer, audience: `https://${url.hostname}`, algorithms: ALGORITHMS,
      requiredClaims: ['exp', 'sub'], maxTokenAge: MAX_TOKEN_AGE_S, clockTolerance: CLOCK_TOLERANCE_S,
    });
    const subject = payload.sub ?? '';
    if (!credential.subjects.some(pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'su').test(subject))) return 'subject';
    if (payload.htm !== undefined && payload.htm !== request.method) return 'htm';
    if (payload.htu !== undefined && payload.htu !== `${url.origin}${url.pathname}`) return 'htu';
    return null;
  } catch (error) {
    if (error instanceof IngressRejected) return error.reason;
    if (error instanceof errors.JWTExpired) return error.claim === 'iat' ? 'too_old' : 'expired';
    if (error instanceof errors.JWTClaimValidationFailed) return error.reason === 'missing' ? `missing_${error.claim}` : CLAIM_REASONS[error.claim] ?? 'invalid_token';
    return error instanceof errors.JOSEError ? ERROR_REASONS[error.code] ?? 'invalid_token' : 'invalid_token';
  }
}

/**
 * A declared route of a workspace URL: a credential the workspace registered admits the caller and the request goes to the
 * service as it came, less the header that carried the token; anything else is a plain 401, never a sign-in redirect.
 */
export async function serveIngress(env: Env, request: Request, ingress: HostedIngress, target: HostedRouteTarget): Promise<Response> {
  const url = new URL(request.url);
  const registry = env.HOSTED_ROUTES.getByName(url.hostname);
  const header = request.headers.has(INGRESS_HEADER) ? INGRESS_HEADER : 'authorization';
  const token = header === INGRESS_HEADER ? request.headers.get(INGRESS_HEADER)?.trim() : /^Bearer\s+(\S+)\s*$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
  let issuer: unknown;
  try { issuer = token ? decodeJwt(token).iss : undefined; } catch { issuer = undefined; }
  const signed = ingress.credentials.filter(credential => credential.kind !== 'bearer' && issuer !== undefined && credential.issuer === issuer);
  const failures: string[] = [];
  let admitted: StoredIngressCredential | undefined;
  if (token) for (const credential of [...signed, ...ingress.credentials.filter(credential => credential.kind === 'bearer')]) {
    // A credential that forwards the app's own `Authorization` takes its token only from `GitSpace-Ingress`.
    const failure = header === 'authorization' && credential.kind !== 'bearer' && credential.forwardAuthorization ? 'ingress_header_required' : await rejection(credential, token, request, url);
    if (failure === null) {
      admitted = credential;
      break;
    }
    failures.push(failure);
  }
  const at = new Date().toISOString();
  if (!admitted) {
    const reason = !token ? 'missing_credential' : issuer !== undefined && signed.length === 0 ? 'issuer_not_registered' : failures[0] ?? 'invalid_token';
    waitUntil(registry.recordIngressAdmission({ admitted: false, at, reason }));
    return Response.json({ error: 'INGRESS_UNAUTHORIZED', reason }, { status: 401, headers: { 'cache-control': 'no-store' } });
  }
  waitUntil(registry.recordIngressAdmission({ admitted: true, at }));
  const headers = new Headers(request.headers);
  headers.delete(header);
  return fetchInternalService(env, { kind: 'ingress', accountId: env.ACCOUNT_ID, workspaceId: ingress.workspaceId, credential: admitted.kind }, new Request(request, { headers }), undefined, target);
}
