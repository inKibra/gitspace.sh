import { z } from 'zod';

const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 15_000;
const RSA_SIGNING: RsaHashedImportParams = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const PEM = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----$/u;
/** AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }, DER-encoded. */
const RSA_ENCRYPTION_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
const GitHubErrorSchema = z.object({ message: z.string() });

/** A GitHub API answer other than success; `status` lets callers treat e.g. 404 as done. */
export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** PKCS#8 PrivateKeyInfo around a PKCS#1 RSAPrivateKey: version 0, rsaEncryption, the key as an OCTET STRING. */
function pkcs8FromPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = [0x02, 0x01, 0x00, ...RSA_ENCRYPTION_ALGORITHM, 0x04, ...derLength(pkcs1.byteLength)];
  const header = [0x30, ...derLength(body.length + pkcs1.byteLength), ...body];
  const der = new Uint8Array(header.length + pkcs1.byteLength);
  der.set(header);
  der.set(pkcs1, header.length);
  return der;
}

/** GitHub issues App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`); PKCS#8 (`BEGIN PRIVATE KEY`) is accepted too. */
export async function importGitHubAppPrivateKey(pem: string): Promise<CryptoKey> {
  const match = PEM.exec(pem.trim());
  if (!match) throw new Error('The private key must be the PEM file GitHub generated (BEGIN RSA PRIVATE KEY)');
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(match[2]!.replace(/\s+/gu, '')), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('The private key PEM is not valid base64');
  }
  const pkcs8 = match[1] === 'RSA PRIVATE KEY' ? pkcs8FromPkcs1(der) : der;
  try {
    return await crypto.subtle.importKey('pkcs8', pkcs8, RSA_SIGNING, false, ['sign']);
  } catch {
    throw new Error('The private key is not an RSA key GitSpace can sign with');
  }
}

/** The App JWT: backdated a minute for clock drift, valid for nine more (GitHub allows at most ten). */
export async function signGitHubAppJwt(key: CryptoKey, appId: number, now = Date.now()): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId })));
  const signature = await crypto.subtle.sign(RSA_SIGNING, key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/** `X-Hub-Signature-256: sha256=<hex>` is an HMAC-SHA256 of the raw body; `crypto.subtle.verify` compares in constant time. */
export async function verifyGitHubSignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/u.exec(header.trim());
  if (!match) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(match[1]!.match(/../gu)!, (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, signature, body);
}

/** One GitHub REST call; `token` is an App JWT or an installation token, absent for the unauthenticated manifest conversion. */
export async function githubRequest<T>(path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; token?: string; body?: unknown; schema: z.ZodType<T> }): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'GitSpace' });
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method, headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new Error(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* Reported below for errors; a success must parse. */ }
  if (!response.ok) {
    const reason = GitHubErrorSchema.safeParse(value);
    throw new GitHubApiError(response.status, `GitHub answered ${response.status}${reason.success ? `: ${reason.data.message.slice(0, 200)}` : ''}`);
  }
  const parsed = options.schema.safeParse(value);
  if (!parsed.success) throw new Error(`GitHub sent an unexpected answer (${method} ${response.status})`);
  return parsed.data;
}
