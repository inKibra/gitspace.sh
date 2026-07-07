/**
 * GitHub-backed artifacts sharing — THE managed path, zero new
 * infrastructure: every gitspace machine already has `gh` (hard dependency,
 * OAuth'd). Provisioning creates a private `<owner>/<repo>-artifacts` repo,
 * wires it as the remote, commits the pointer, pushes, and mirrors the code
 * repo's collaborators.
 *
 * Large files: our pointer files are byte-for-byte standard git-LFS pointers
 * and captures write matching .gitattributes lines, so blob storage is
 * GitHub LFS itself — we speak the LFS batch API directly (no git-lfs binary
 * needed) against the artifacts repo, and external `git lfs` clones interop
 * natively.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { artifactPaths, artifactBlobPath, getArtifactsRemote, setArtifactsRemote, syncArtifacts, writeArtifactsPointerConfig, ensureArtifactsRepo, ensureLfsAttributes, listArtifactFiles, artifactsMountDir, type ArtifactBlobFetcher } from './artifacts.js';
import { readProjectConfig } from './config.js';
import { SpacesError } from '../types/errors.js';

const run = promisify(execFile);

async function gh(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    if (opts.allowFail) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) };
    }
    throw error;
  }
}

/** `<owner>/<code-repo>-artifacts` derived from the project's repository. */
export function artifactsRepoSlug(projectName: string): string {
  const config = readProjectConfig(projectName);
  const repository = config?.repository;
  if (!repository || !repository.includes('/')) {
    throw new SpacesError(`Project ${projectName} has no GitHub repository configured.`, 'USER_ERROR', 1);
  }
  const [owner, repo] = repository.split('/');
  return `${owner}/${repo}-artifacts`;
}

export interface ProvisionResult {
  slug: string;
  url: string;
  created: boolean;
  pushed: boolean;
  collaboratorsCopied: number;
  blobsUploaded: number;
}

export async function provisionGithubArtifacts(
  projectName: string,
  projectDir: string,
  baseDir: string,
): Promise<ProvisionResult> {
  const slug = artifactsRepoSlug(projectName);
  await ensureArtifactsRepo(projectDir);

  // 1. Create the private repo (idempotent).
  let created = false;
  const exists = await gh(['repo', 'view', slug, '--json', 'name'], { allowFail: true });
  if (!exists.ok) {
    const mk = await gh(['repo', 'create', slug, '--private', '--description', `gitspace artifacts for ${projectName} (journals, evidence, dashboards, review guides)`], { allowFail: true });
    if (!mk.ok) throw new SpacesError(`Failed to create ${slug}: ${mk.stderr.trim()}`, 'USER_ERROR', 1);
    created = true;
  }
  const url = `https://github.com/${slug}.git`;

  // 2. Remote + committed pointer + LFS attribute backfill for pointers that
  //    predate attribute-writing captures + full branch push. gh's credential
  //    helper authenticates the https push.
  await gh(['auth', 'setup-git'], { allowFail: true });
  await setArtifactsRemote(projectDir, url);
  try { await writeArtifactsPointerConfig(baseDir, { remote: url }); } catch { /* base missing */ }
  await backfillLfsAttributes(baseDir);
  const sync = await syncArtifacts(projectDir);

  // 3. Mirror the code repo's collaborators (best-effort, day-one access).
  let collaboratorsCopied = 0;
  const config = readProjectConfig(projectName);
  if (config?.repository) {
    const list = await gh(['api', `repos/${config.repository}/collaborators?affiliation=direct`, '--jq', '.[].login'], { allowFail: true });
    if (list.ok) {
      for (const login of list.stdout.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const add = await gh(['api', '-X', 'PUT', `repos/${slug}/collaborators/${login}`, '-f', 'permission=push'], { allowFail: true });
        if (add.ok) collaboratorsCopied += 1;
      }
    }
  }

  // 4. Blob upload (GitHub LFS batch API).
  const blobsUploaded = await uploadMissingBlobs(projectDir, slug);
  return { slug, url, created, pushed: sync.pushed, collaboratorsCopied, blobsUploaded };
}

/** Repos provisioned before capture-time attribute writing may hold pointer
 *  files with no .gitattributes coverage — GitHub LFS ignores those. Backfill
 *  through the base clone's main mount (best-effort; workspace branches get
 *  their lines from ongoing captures). */
async function backfillLfsAttributes(baseDir: string): Promise<void> {
  try {
    const mount = artifactsMountDir(baseDir);
    if (!existsSync(join(mount, '.git'))) return;
    const pointers = listArtifactFiles(mount).filter((e) => e.pointer).map((e) => e.path);
    if (!ensureLfsAttributes(mount, pointers)) return;
    const { execFile: ef } = await import('child_process');
    const runGit = promisify(ef);
    await runGit('git', ['-C', mount, '-c', 'user.name=gitspace', '-c', 'user.email=artifacts@gitspace.sh', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'lfs: backfill .gitattributes for existing pointers']);
  } catch { /* best-effort */ }
}

// ── GitHub LFS batch API ────────────────────────────────────────────────────

export interface GithubLfsDeps {
  fetchImpl?: typeof fetch;
  /** gh OAuth token provider (default: `gh auth token`). */
  tokenProvider?: () => Promise<string>;
}

async function ghAuthToken(): Promise<string> {
  const r = await gh(['auth', 'token']);
  const token = r.stdout.trim();
  if (!token) throw new SpacesError('gh auth token returned nothing — run `gh auth login`.', 'USER_ERROR', 1);
  return token;
}

interface LfsAction { href: string; header?: Record<string, string> }
interface LfsBatchObject {
  oid: string;
  size: number;
  actions?: { upload?: LfsAction; verify?: LfsAction; download?: LfsAction };
  error?: { code: number; message: string };
}

const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';

async function lfsBatch(
  slug: string,
  operation: 'upload' | 'download',
  objects: Array<{ oid: string; size: number }>,
  deps: GithubLfsDeps,
): Promise<LfsBatchObject[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await (deps.tokenProvider ?? ghAuthToken)();
  const res = await fetchImpl(`https://github.com/${slug}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: {
      Accept: LFS_MEDIA_TYPE,
      'Content-Type': LFS_MEDIA_TYPE,
      Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
    body: JSON.stringify({ operation, transfers: ['basic'], objects }),
  });
  if (!res.ok) throw new SpacesError(`GitHub LFS batch ${operation} failed for ${slug} (${res.status})`, 'SYSTEM_ERROR', 1);
  const data = (await res.json()) as { objects?: LfsBatchObject[] };
  return data.objects ?? [];
}

/** Walk the local blob store; upload objects GitHub LFS doesn't have yet.
 *  Objects the server already has come back without an upload action. */
export async function uploadMissingBlobs(projectDir: string, slug: string, deps: GithubLfsDeps = {}): Promise<number> {
  const { blobsDir } = artifactPaths(projectDir);
  if (!existsSync(blobsDir)) return 0;
  const local: Array<{ oid: string; size: number; file: string }> = [];
  for (const shard of readdirSync(blobsDir)) {
    const shardDir = join(blobsDir, shard);
    try {
      for (const oid of readdirSync(shardDir)) {
        const file = join(shardDir, oid);
        local.push({ oid, size: statSync(file).size, file });
      }
    } catch { /* not a dir */ }
  }
  if (local.length === 0) return 0;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const batch = await lfsBatch(slug, 'upload', local.map(({ oid, size }) => ({ oid, size })), deps);
  const byOid = new Map(local.map((b) => [b.oid, b]));
  let uploaded = 0;
  for (const obj of batch) {
    const src = byOid.get(obj.oid);
    const action = obj.actions?.upload;
    if (!src || !action || obj.error) continue;
    const put = await fetchImpl(action.href, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...(action.header ?? {}) },
      body: new Uint8Array(readFileSync(src.file)),
    });
    if (!put.ok) continue;
    const verify = obj.actions?.verify;
    if (verify) {
      await fetchImpl(verify.href, {
        method: 'POST',
        headers: { Accept: LFS_MEDIA_TYPE, 'Content-Type': LFS_MEDIA_TYPE, ...(verify.header ?? {}) },
        body: JSON.stringify({ oid: obj.oid, size: src.size }),
      }).catch(() => undefined);
    }
    uploaded += 1;
  }
  return uploaded;
}

/** Fetch one blob from GitHub LFS into the local blob store (sha256-verified). */
export async function downloadBlob(projectDir: string, slug: string, oid: string, size: number, deps: GithubLfsDeps = {}): Promise<boolean> {
  const { blobsDir } = artifactPaths(projectDir);
  const dest = artifactBlobPath(blobsDir, oid);
  if (existsSync(dest)) return true;
  const bytes = await fetchLfsObject(slug, oid, size, deps);
  if (!bytes) return false;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);
  return true;
}

async function fetchLfsObject(slug: string, oid: string, size: number, deps: GithubLfsDeps): Promise<Buffer | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const [obj] = await lfsBatch(slug, 'download', [{ oid, size }], deps);
  const action = obj?.actions?.download;
  if (!action || obj?.error) return null;
  const res = await fetchImpl(action.href, { headers: action.header ?? {} });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  const gotOid = createHash('sha256').update(bytes).digest('hex');
  if (gotOid !== oid) return null;
  return bytes;
}

/** Blob fetcher for {@link readArtifactResolving} — non-null only when this
 *  project's artifacts remote is a github.com repo. */
export async function createGithubBlobFetcher(projectDir: string, deps: GithubLfsDeps = {}): Promise<ArtifactBlobFetcher | null> {
  const slug = slugFromRemote(await getArtifactsRemote(projectDir));
  if (!slug) return null;
  return (oid, size) => fetchLfsObject(slug, oid, size, deps);
}

/** github.com remotes expose the slug for blob ops; others don't. */
export function slugFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

/** Full sync for a provisioned project: branches via git, blobs via LFS. */
export async function syncGithubArtifacts(projectDir: string, deps: GithubLfsDeps = {}): Promise<{ pushed: boolean; blobsUploaded: number }> {
  const sync = await syncArtifacts(projectDir);
  const slug = slugFromRemote(await getArtifactsRemote(projectDir));
  const blobsUploaded = slug ? await uploadMissingBlobs(projectDir, slug, deps) : 0;
  return { pushed: sync.pushed, blobsUploaded };
}
