/**
 * Managed artifacts tier (Tier 2) — client side (docs/ARTIFACTS-FS.md).
 *
 * Counterpart of worker/src/handlers/artifacts.ts (the source of truth for
 * the wire contract):
 *   - POST {API}/artifacts/provision   { project: "handle/slug" }
 *       → { project, gitUrl, token, expiresAt }   (idempotent — attaching an
 *         already-provisioned project just re-mints; this is also how
 *         additional machines adopt via .gitspace/artifacts.json)
 *   - GET  {API}/artifacts/token?project=handle/slug → same shape
 *   - PUT/GET/HEAD {API}/artifacts/blobs/{handle}/{slug}/{oid}
 *
 * Two credentials, two scopes:
 *   - The gitspace.sh user session (keychain token + device fingerprint —
 *     exactly how src/commands/host.ts authenticates) authorizes every worker
 *     API call, including blobs.
 *   - The short-lived repo-scoped token (≤1h) returned by provision/token is
 *     GIT auth only: it rides in `http.<gitUrl>.extraheader` on the bare
 *     artifacts repo and is refreshed proactively on expiry and reactively
 *     when a sync hits a 401.
 *
 * Everything network-shaped takes an injectable fetch (and auth-headers
 * provider) so the whole module is unit-testable offline.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import { escapeShellArg } from '../utils/shell-escape.js';
import { GITSPACE_API_BASE } from './gitspace-api.js';
import {
  artifactPaths,
  getArtifactsRemote,
  setArtifactsRemote,
  setManagedArtifactsProject,
  getManagedArtifactsProject,
  syncArtifactsGit,
  writeArtifactsPointerConfig,
  type ArtifactBlobFetcher,
  type ArtifactsBlobSyncResult,
  type ArtifactsSyncResult,
} from './artifacts.js';

const execAsync = promisify(exec);

// ── plumbing ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Mirrors how host/subdomain commands authenticate against the gitspace.sh
 *  API: keychain session token + device fingerprint (src/commands/host.ts). */
export type AuthHeadersProvider = () => Promise<Record<string, string>>;

async function defaultUserAuthHeaders(): Promise<Record<string, string>> {
  const { getSecret } = await import('../utils/secrets.js');
  const { getPublicKeyWithoutPassword } = await import('./identity.js');
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    throw new SpacesError('Not logged in.\n\nRun: gssh user auth login', 'USER_ERROR', 1);
  }
  const identity = getPublicKeyWithoutPassword();
  if (!identity) {
    throw new SpacesError('Identity not found.\n\nRun: gssh user identity init', 'USER_ERROR', 1);
  }
  return {
    Authorization: `Bearer ${token}`,
    'X-Device-Fingerprint': identity.signingPublicKey,
  };
}

/** Fetch wrapper that injects the user's gitspace.sh auth headers into every
 *  request (blob store + provisioning calls). */
export function createUserApiFetch(
  opts: { authHeaders?: AuthHeadersProvider; fetchImpl?: FetchLike } = {},
): FetchLike {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const provider = opts.authHeaders ?? defaultUserAuthHeaders;
  return async (url, init) => {
    const headers = { ...(await provider()), ...(init?.headers as Record<string, string> | undefined) };
    return fetchImpl(url, { ...init, headers });
  };
}

async function git(repoDir: string, args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git -C ${escapeShellArg(repoDir)} ${args}`);
    return stdout.trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SpacesError(`git failed (${args.split(' ')[0]}): ${msg}`, 'SYSTEM_ERROR', 1);
  }
}

async function gitConfigGet(repoDir: string, key: string): Promise<string | null> {
  try {
    return (await git(repoDir, `config --get ${escapeShellArg(key)}`)) || null;
  } catch {
    return null;
  }
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const body = (await res.text().catch(() => '')).trim();
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed?.error) return `${fallback}: ${parsed.error}`;
  } catch { /* not json */ }
  return body ? `${fallback}: ${body.slice(0, 200)}` : fallback;
}

// ── project refs (handle/slug — worker validation mirrored) ────────────────

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseManagedProjectRef(value: string): { handle: string; slug: string } {
  const parts = value.split('/');
  if (parts.length !== 2 || !HANDLE_RE.test(parts[0]!) || !SLUG_RE.test(parts[1]!)) {
    throw new SpacesError(`Invalid managed artifacts project "${value}" — expected "handle/slug".`, 'USER_ERROR', 1);
  }
  return { handle: parts[0]!, slug: parts[1]! };
}

/** Local project name → worker-legal slug. */
export function deriveManagedSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!SLUG_RE.test(slug)) {
    throw new SpacesError(`Cannot derive a managed artifacts slug from "${name}".`, 'USER_ERROR', 1);
  }
  return slug;
}

/** "handle/slug" for a local project: handle = the account's primary root
 *  subdomain (the worker's ownership model), slug from the project name. */
export async function deriveManagedProjectRef(projectName: string): Promise<string> {
  const { readHostConfig } = await import('../commands/host.js');
  const handle = readHostConfig()?.subdomain;
  if (!handle) {
    throw new SpacesError(
      'Managed artifacts need a gitspace.sh handle (your root subdomain).\n\nRun: gssh user host reserve <name>',
      'USER_ERROR',
      1,
    );
  }
  return `${handle}/${deriveManagedSlug(projectName)}`;
}

// ── short-lived git token ───────────────────────────────────────────────────

export interface ArtifactsToken {
  token: string;
  /** Epoch millis; absent/0 = unknown (rely on 401 re-mint). */
  expiresAt?: number;
}

/** Refresh this long before the recorded expiry. */
const TOKEN_EXPIRY_SKEW_MS = 30_000;

function tokenIsFresh(token: ArtifactsToken | null): token is ArtifactsToken {
  if (!token) return false;
  if (!token.expiresAt) return true; // unknown expiry — rely on 401 re-mint
  return token.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now();
}

export interface MintedArtifactsAccess extends ArtifactsToken {
  project: string;
  gitUrl: string;
}

/** GET {API}/artifacts/token — re-mint the short-lived repo-scoped token for
 *  a provisioned project using the user's existing gitspace.sh auth. */
export async function mintArtifactsToken(
  project: string,
  opts: { fetchImpl?: FetchLike; authHeaders?: AuthHeadersProvider } = {},
): Promise<MintedArtifactsAccess> {
  const apiFetch = createUserApiFetch(opts);
  const res = await apiFetch(`${GITSPACE_API_BASE}/artifacts/token?project=${encodeURIComponent(project)}`);
  if (!res.ok) {
    throw new SpacesError(
      await readApiError(res, `Failed to mint artifacts token for ${project} (${res.status})`),
      res.status === 401 || res.status === 403 || res.status === 404 ? 'USER_ERROR' : 'SYSTEM_ERROR',
      1,
    );
  }
  const data = await res.json() as { project?: string; gitUrl?: string; token?: string; expiresAt?: number };
  if (!data.token || !data.gitUrl) {
    throw new SpacesError(`Artifacts token response missing token/gitUrl for ${project}`, 'SYSTEM_ERROR', 1);
  }
  return {
    project: data.project ?? project,
    gitUrl: data.gitUrl,
    token: data.token,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
  };
}

export interface ManagedTokenClient {
  /** Current token, minting when absent or expired (skewed). */
  getToken(): Promise<ArtifactsToken>;
  /** Force a re-mint (used after a 401). */
  refresh(): Promise<ArtifactsToken>;
  /** Authorized fetch: injects `Authorization: Bearer <token>` and re-mints
   *  once on 401 before retrying. */
  fetch: FetchLike;
}

/** Token cache + refresh-on-401 wrapper around a mint function. Inject a fake
 *  `mint`/`fetchImpl` in tests — nothing here touches the network on its own. */
export function createManagedTokenClient(opts: {
  mint: () => Promise<ArtifactsToken>;
  fetchImpl?: FetchLike;
  /** Seed (e.g. the token that came back with provision). */
  initial?: ArtifactsToken;
}): ManagedTokenClient {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  let cached: ArtifactsToken | null = opts.initial ?? null;

  const getToken = async (): Promise<ArtifactsToken> => {
    if (tokenIsFresh(cached)) return cached;
    cached = await opts.mint();
    return cached;
  };

  const refresh = async (): Promise<ArtifactsToken> => {
    cached = await opts.mint();
    return cached;
  };

  const authorizedFetch: FetchLike = async (url, init) => {
    const withAuth = (token: ArtifactsToken): RequestInit => ({
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token.token}` },
    });
    const res = await fetchImpl(url, withAuth(await getToken()));
    if (res.status !== 401) return res;
    return fetchImpl(url, withAuth(await refresh()));
  };

  return { getToken, refresh, fetch: authorizedFetch };
}

function defaultTokenClient(
  project: string,
  opts: { fetchImpl?: FetchLike; authHeaders?: AuthHeadersProvider; tokenClient?: ManagedTokenClient; initial?: ArtifactsToken },
): ManagedTokenClient {
  return opts.tokenClient ?? createManagedTokenClient({
    mint: () => mintArtifactsToken(project, opts),
    fetchImpl: opts.fetchImpl,
    initial: opts.initial,
  });
}

// ── git http auth (extraheader) ─────────────────────────────────────────────

const TOKEN_EXPIRES_CONFIG_KEY = 'gitspace.artifactsTokenExpires';

/** Persist the short-lived token as `http.<gitUrl>.extraheader` on the bare
 *  repo (plus its expiry, so sync can refresh proactively). */
export async function writeArtifactsGitAuth(repoDir: string, gitUrl: string, token: ArtifactsToken): Promise<void> {
  await git(repoDir, `config ${escapeShellArg(`http.${gitUrl}.extraheader`)} ${escapeShellArg(`Authorization: Bearer ${token.token}`)}`);
  await git(repoDir, `config ${TOKEN_EXPIRES_CONFIG_KEY} ${escapeShellArg(String(token.expiresAt ?? 0))}`);
}

async function ensureFreshGitAuth(projectDir: string, gitUrl: string, client: ManagedTokenClient): Promise<void> {
  const { repoDir } = artifactPaths(projectDir);
  const header = await gitConfigGet(repoDir, `http.${gitUrl}.extraheader`);
  const expires = Number(await gitConfigGet(repoDir, TOKEN_EXPIRES_CONFIG_KEY) ?? '0');
  const stillFresh = header !== null && (expires === 0 || expires - TOKEN_EXPIRY_SKEW_MS > Date.now());
  if (stillFresh) return;
  await writeArtifactsGitAuth(repoDir, gitUrl, expires ? await client.refresh() : await client.getToken());
}

/** Heuristic for "git over http rejected our token" — the smart-HTTP client
 *  surfaces worker 401s as fatal messages containing the status. */
export function isGitAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b401\b|Authentication failed|Authorization/i.test(msg);
}

// ── blob store sync ─────────────────────────────────────────────────────────

export interface LocalBlob {
  oid: string;
  size: number;
  /** Absolute path in the local blob store. */
  file: string;
}

const OID_RE = /^[0-9a-f]{64}$/;

/** Walk the local blob store (`.artifacts-blobs/<aa>/<oid>`). Pure fs. */
export function listLocalBlobs(blobsDir: string): LocalBlob[] {
  const out: LocalBlob[] = [];
  if (!existsSync(blobsDir)) return out;
  for (const shard of readdirSync(blobsDir)) {
    const shardDir = join(blobsDir, shard);
    if (!/^[0-9a-f]{2}$/.test(shard) || !statSync(shardDir).isDirectory()) continue;
    for (const name of readdirSync(shardDir)) {
      if (!OID_RE.test(name) || !name.startsWith(shard)) continue;
      const file = join(shardDir, name);
      const st = statSync(file);
      if (st.isFile()) out.push({ oid: name, size: st.size, file });
    }
  }
  return out.sort((a, b) => a.oid.localeCompare(b.oid));
}

export function artifactsBlobUrl(project: string, oid: string): string {
  return `${GITSPACE_API_BASE}/artifacts/blobs/${project}/${oid}`;
}

/** Split oids into remotely-present vs missing via HEAD requests.
 *  Non-404 failures throw (callers decide whether that's fatal). */
export async function computeMissingBlobOids(
  project: string,
  oids: string[],
  apiFetch: FetchLike,
): Promise<{ present: string[]; missing: string[] }> {
  const present: string[] = [];
  const missing: string[] = [];
  for (const oid of oids) {
    const res = await apiFetch(artifactsBlobUrl(project, oid), { method: 'HEAD' });
    if (res.ok) present.push(oid);
    else if (res.status === 404) missing.push(oid);
    else throw new SpacesError(`Blob HEAD failed for ${oid} (${res.status})`, 'SYSTEM_ERROR', 1);
  }
  return { present, missing };
}

/** Upload every local blob the API doesn't have yet (HEAD then PUT).
 *  Per-blob failures are counted, not thrown — sync stays best-effort. */
export async function syncManagedBlobs(
  projectDir: string,
  project: string,
  apiFetch: FetchLike,
): Promise<ArtifactsBlobSyncResult> {
  const { blobsDir } = artifactPaths(projectDir);
  const blobs = listLocalBlobs(blobsDir);
  const result: ArtifactsBlobSyncResult = { total: blobs.length, uploaded: 0, alreadyPresent: 0, failed: 0 };
  for (const blob of blobs) {
    try {
      const head = await apiFetch(artifactsBlobUrl(project, blob.oid), { method: 'HEAD' });
      if (head.ok) {
        result.alreadyPresent += 1;
        continue;
      }
      if (head.status !== 404) {
        result.failed += 1;
        continue;
      }
      const bytes = readFileSync(blob.file);
      const put = await apiFetch(artifactsBlobUrl(project, blob.oid), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.byteLength), // worker replies 411 without it
        },
        body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as BodyInit,
      });
      if (put.ok) result.uploaded += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** Presence report for `gssh artifacts status` (managed tier). */
export async function checkRemoteBlobs(
  projectDir: string,
  project: string,
  opts: { fetchImpl?: FetchLike; authHeaders?: AuthHeadersProvider } = {},
): Promise<{ total: number; present: number; missing: number }> {
  const apiFetch = createUserApiFetch(opts);
  const { blobsDir } = artifactPaths(projectDir);
  const oids = listLocalBlobs(blobsDir).map((b) => b.oid);
  const { present, missing } = await computeMissingBlobOids(project, oids, apiFetch);
  return { total: oids.length, present: present.length, missing: missing.length };
}

/** HTTP-backed {@link ArtifactBlobFetcher}: GET the blob from the API
 *  (null on 404 so readArtifactResolving reports "missing" cleanly). */
export function createManagedBlobFetcher(project: string, apiFetch: FetchLike): ArtifactBlobFetcher {
  return async (oid: string): Promise<Buffer | null> => {
    const res = await apiFetch(artifactsBlobUrl(project, oid), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new SpacesError(`Blob GET failed for ${oid} (${res.status})`, 'SYSTEM_ERROR', 1);
    return Buffer.from(await res.arrayBuffer());
  };
}

/** The default fetcher wired into readArtifactResolving: present only when
 *  this project is attached to managed artifacts. */
export async function createDefaultBlobFetcher(projectDir: string): Promise<ArtifactBlobFetcher | null> {
  const project = await getManagedArtifactsProject(projectDir);
  if (!project) return null;
  return createManagedBlobFetcher(project, createUserApiFetch());
}

// ── provision / setup / sync ────────────────────────────────────────────────

export type ManagedProvisionResult = MintedArtifactsAccess;

/** POST {API}/artifacts/provision { project: "handle/slug" }. Idempotent:
 *  creates the upstream repo on first call, re-mints a token afterwards —
 *  the same call additional machines make when adopting. */
export async function provisionManagedArtifacts(
  project: string,
  opts: { fetchImpl?: FetchLike; authHeaders?: AuthHeadersProvider } = {},
): Promise<ManagedProvisionResult> {
  parseManagedProjectRef(project);
  const apiFetch = createUserApiFetch(opts);
  const res = await apiFetch(`${GITSPACE_API_BASE}/artifacts/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });
  if (!res.ok) {
    throw new SpacesError(
      await readApiError(res, `Failed to provision managed artifacts for ${project} (${res.status})`),
      res.status === 401 || res.status === 403 || res.status === 404 ? 'USER_ERROR' : 'SYSTEM_ERROR',
      1,
    );
  }
  const data = await res.json() as { project?: string; gitUrl?: string; token?: string; expiresAt?: number };
  if (!data.project || !data.gitUrl || !data.token) {
    throw new SpacesError('Provision response missing project/gitUrl/token', 'SYSTEM_ERROR', 1);
  }
  return {
    project: data.project,
    gitUrl: data.gitUrl,
    token: data.token,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
  };
}

export interface SetupManagedArtifactsArgs {
  /** `~/gitspace/<project>` — owns `.artifacts.git` + `.artifacts-blobs`. */
  projectDir: string;
  /** The base code clone — receives the committed `.gitspace/artifacts.json`. */
  baseDir: string;
  /** "handle/slug" to provision/attach. Derive via deriveManagedProjectRef
   *  when starting from a local project name. */
  project: string;
  /** Skip the initial sync (default: sync, best-effort). */
  sync?: boolean;
  fetchImpl?: FetchLike;
  authHeaders?: AuthHeadersProvider;
  tokenClient?: ManagedTokenClient;
}

export interface SetupManagedArtifactsResult {
  project: string;
  gitUrl: string;
  synced: boolean;
}

/**
 * Wire a project to gitspace.sh-managed artifacts:
 * provision (or attach) → remote = gitUrl with extraheader auth (installed
 * BEFORE the adopt-fetch so machine #2 fast-forwards from remote history) →
 * record the managed marker → write the committed pointer
 * (`.gitspace/artifacts.json` = `{ "project": "handle/slug" }`) → initial
 * sync (git branches + blobs, best-effort).
 */
export async function setupManagedArtifacts(args: SetupManagedArtifactsArgs): Promise<SetupManagedArtifactsResult> {
  const provisioned = await provisionManagedArtifacts(args.project, args);
  const client = defaultTokenClient(provisioned.project, { ...args, initial: provisioned });

  await setArtifactsRemote(args.projectDir, provisioned.gitUrl, {
    beforeFetch: (repoDir) => writeArtifactsGitAuth(repoDir, provisioned.gitUrl, provisioned),
  });
  // Repo exists now in every path — make sure auth + marker are recorded
  // (beforeFetch only fires on the fresh-repo adopt path).
  const { repoDir } = artifactPaths(args.projectDir);
  await writeArtifactsGitAuth(repoDir, provisioned.gitUrl, provisioned);
  await setManagedArtifactsProject(args.projectDir, provisioned.project);
  await writeArtifactsPointerConfig(args.baseDir, { project: provisioned.project });

  let synced = false;
  if (args.sync !== false) {
    try {
      await syncManagedArtifacts(args.projectDir, provisioned.project, {
        fetchImpl: args.fetchImpl,
        authHeaders: args.authHeaders,
        tokenClient: client,
      });
      synced = true;
    } catch {
      /* initial sync is best-effort — `gssh artifacts sync` reconciles later */
    }
  }
  return { project: provisioned.project, gitUrl: provisioned.gitUrl, synced };
}

/**
 * Managed sync: refresh git auth when the stored token expired, run the git
 * sync (re-minting once on a 401-shaped failure), then upload any blobs the
 * API is missing. Called by artifacts.syncArtifacts whenever the managed
 * marker is set.
 */
export async function syncManagedArtifacts(
  projectDir: string,
  project: string,
  opts: { fetchImpl?: FetchLike; authHeaders?: AuthHeadersProvider; tokenClient?: ManagedTokenClient } = {},
): Promise<ArtifactsSyncResult> {
  const client = defaultTokenClient(project, opts);
  const gitUrl = await getArtifactsRemote(projectDir);
  if (!gitUrl) {
    throw new SpacesError('Managed artifacts remote missing — run: gssh artifacts managed setup', 'USER_ERROR', 1);
  }

  await ensureFreshGitAuth(projectDir, gitUrl, client);
  let gitResult: ArtifactsSyncResult;
  try {
    gitResult = await syncArtifactsGit(projectDir);
  } catch (e) {
    if (!isGitAuthError(e)) throw e;
    // Token rejected mid-flight — re-mint once and retry.
    const { repoDir } = artifactPaths(projectDir);
    await writeArtifactsGitAuth(repoDir, gitUrl, await client.refresh());
    gitResult = await syncArtifactsGit(projectDir);
  }

  const blobs = await syncManagedBlobs(projectDir, project, createUserApiFetch(opts));
  return { ...gitResult, blobs };
}
