/**
 * GitHub-backed artifacts provisioning — the REAL managed path, zero new
 * infrastructure: every gitspace machine already has `gh` (hard dependency,
 * OAuth'd). Provisioning creates a private `<owner>/<repo>-artifacts` repo,
 * wires it as the remote, commits the pointer, pushes, and mirrors the code
 * repo's collaborators. Blobs (our ≥2MB LFS-style pointers) sync as release
 * assets on the SAME repo — asset name = sha256 oid, tag `blobs`.
 *
 * The worker/R2 tier (docs/ARTIFACTS-FS.md) remains the future scale path;
 * this one is provable end-to-end today.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { artifactPaths, getArtifactsRemote, setArtifactsRemote, syncArtifacts, writeArtifactsPointerConfig, ensureArtifactsRepo } from './artifacts.js';
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

  // 2. Remote + committed pointer + full branch push. gh's credential helper
  //    authenticates the https push.
  await gh(['auth', 'setup-git'], { allowFail: true });
  await setArtifactsRemote(projectDir, url);
  try { await writeArtifactsPointerConfig(baseDir, { remote: url }); } catch { /* base missing */ }
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

  // 4. Blob upload (release assets).
  const blobsUploaded = await uploadMissingBlobs(projectDir, slug);
  return { slug, url, created, pushed: sync.pushed, collaboratorsCopied, blobsUploaded };
}

const BLOB_TAG = 'blobs';

async function ensureBlobRelease(slug: string): Promise<void> {
  const view = await gh(['release', 'view', BLOB_TAG, '--repo', slug, '--json', 'tagName'], { allowFail: true });
  if (view.ok) return;
  const mk = await gh(['release', 'create', BLOB_TAG, '--repo', slug, '--title', 'artifact blobs', '--notes', 'LFS-style blob store — asset name = sha256 oid. Managed by gitspace; do not edit.'], { allowFail: true });
  if (!mk.ok && !/already exists/i.test(mk.stderr)) {
    throw new SpacesError(`Failed to create blob release on ${slug}: ${mk.stderr.trim()}`, 'USER_ERROR', 1);
  }
}

/** Walk the local blob store; upload assets the release doesn't have. */
export async function uploadMissingBlobs(projectDir: string, slug: string): Promise<number> {
  const { blobsDir } = artifactPaths(projectDir);
  if (!existsSync(blobsDir)) return 0;
  const local: Array<{ oid: string; file: string }> = [];
  for (const shard of readdirSync(blobsDir)) {
    const shardDir = join(blobsDir, shard);
    try {
      for (const oid of readdirSync(shardDir)) local.push({ oid, file: join(shardDir, oid) });
    } catch { /* not a dir */ }
  }
  if (local.length === 0) return 0;
  await ensureBlobRelease(slug);
  const listed = await gh(['release', 'view', BLOB_TAG, '--repo', slug, '--json', 'assets', '--jq', '.assets[].name'], { allowFail: true });
  const have = new Set(listed.ok ? listed.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : []);
  let uploaded = 0;
  for (const { oid, file } of local) {
    if (have.has(oid)) continue;
    const up = await gh(['release', 'upload', BLOB_TAG, `${file}#${oid}`, '--repo', slug], { allowFail: true });
    if (up.ok) uploaded += 1;
  }
  return uploaded;
}

/** Fetch one blob from the release store into the local blob dir. */
export async function downloadBlob(projectDir: string, slug: string, oid: string): Promise<boolean> {
  const { blobsDir } = artifactPaths(projectDir);
  const dest = join(blobsDir, oid.slice(0, 2), oid);
  if (existsSync(dest)) return true;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const dl = await gh(['release', 'download', BLOB_TAG, '--repo', slug, '--pattern', oid, '--output', tmp], { allowFail: true });
  if (!dl.ok || !existsSync(tmp)) return false;
  renameSync(tmp, dest);
  return true;
}

/** github.com remotes expose the slug for blob ops; others don't. */
export function slugFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

/** Full sync for a provisioned project: branches + blobs both directions on demand. */
export async function syncGithubArtifacts(projectDir: string): Promise<{ pushed: boolean; blobsUploaded: number }> {
  const sync = await syncArtifacts(projectDir);
  const slug = slugFromRemote(await getArtifactsRemote(projectDir));
  const blobsUploaded = slug ? await uploadMissingBlobs(projectDir, slug) : 0;
  return { pushed: sync.pushed, blobsUploaded };
}
