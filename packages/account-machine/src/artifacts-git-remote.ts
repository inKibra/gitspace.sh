import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ArtifactsRepositoryBinding = { projectId: string; repository: string };
export type ArtifactsRepositoryCredentials = { remote: string; plaintext: string; expiresAt: string };
export type ArtifactsGitRemoteOptions = {
  credentials(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write'): Promise<ArtifactsRepositoryCredentials>;
};

export class ArtifactsGitError extends Error {
  constructor(readonly operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'ArtifactsGitError';
  }
}

export type ArtifactsRepositoryIssue = { oid: string; path: string; size: number; location: 'current' | 'history' };

/** Current snapshot layers exceed Artifacts' decimal 32 MB limit. Never automatically retried. */
export class ArtifactsRepositoryIncompatibleError extends ArtifactsGitError {
  readonly code = 'ARTIFACTS_REPOSITORY_INCOMPATIBLE';
  readonly retryable = false;

  constructor(readonly issues: ArtifactsRepositoryIssue[]) {
    const details = issues.slice(0, 10).map(issue => {
      const path = issue.path.length > 200 ? `${issue.path.slice(0, 200)}…` : issue.path;
      return `${JSON.stringify(path)} (${issue.size} bytes, ${issue.location}, ${issue.oid})`;
    }).join('; ');
    super('preflight', `Repository is incompatible with Artifacts: ${issues.length} oversized blob path(s), maximum ${MAX_BLOB_BYTES} bytes (32 MB). ${details}${issues.length > 10 ? '; further paths are available in structured issue details' : ''}. Current HEAD, index, tracked worktree and portable worktree must all fit. For new large files, explicitly configure Git LFS and stage LFS pointers before checkpointing. Deleting a worktree file does not remove it from HEAD or the index. Older history is never uploaded. No automatic LFS conversion or history rewrite was performed.`);
    this.name = 'ArtifactsRepositoryIncompatibleError';
  }
}

/** Only this rejection proves publication stopped before credentials or remote writes. */
export function artifactsPublicationRejection(error: unknown): ArtifactsRepositoryIncompatibleError | null {
  const visited = new Set<Error>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof ArtifactsRepositoryIncompatibleError) return error;
    visited.add(error);
    error = error.cause;
  }
  return null;
}

/** The remote ref already names other history; publication never moves it. */
export class ArtifactsRefDivergedError extends ArtifactsGitError {
  constructor(readonly ref: string, readonly remoteCommit: string, readonly commit: string) {
    super('ref', `Remote ref ${ref} is at ${remoteCommit}, not ${commit}; refusing to overwrite it`);
    this.name = 'ArtifactsRefDivergedError';
  }
}

async function git(repositoryPath: string, args: string[], environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, env: { ...Bun.env, ...environment, GIT_NO_REPLACE_OBJECTS: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new ArtifactsGitError(args[0] ?? 'git', stderr.trim() || `exited with ${exitCode}`);
  return stdout.trim();
}

const MAX_BLOB_BYTES = 32_000_000;

/** Runs `run` with `boundary` as the only shallow commit, so nothing older than it is ever read or pushed. */
async function withShallowBoundary<T>(boundary: string | null, run: (environment: Record<string, string>) => Promise<T>): Promise<T> {
  if (boundary === null) return run({});
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-push-'));
  try {
    await writeFile(join(directory, 'shallow'), `${boundary}\n`);
    return await run({ GIT_SHALLOW_FILE: join(directory, 'shallow') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Every current layer of `commit` (the commits down to and including `head`) must fit Artifacts' 32 MB file
 * limit. Reads tree listings only, never file contents. */
async function checkCurrentLayers(repositoryPath: string, commit: string, head: string | null, environment: Record<string, string> = {}): Promise<void> {
  const issues = new Map<string, ArtifactsRepositoryIssue>();
  const range = head === null ? [commit] : [commit, '--not', `${head}^@`];
  const trees = new Set((await git(repositoryPath, ['log', '--format=%T', ...range], environment)).split('\n').filter(Boolean));
  for (const tree of trees) {
    for (const entry of (await git(repositoryPath, ['ls-tree', '-r', '-l', '-z', '--full-tree', tree], environment)).split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, kind, oid, rawSize] = entry.slice(0, tab).split(/ +/u);
      const size = Number(rawSize);
      if (kind !== 'blob' || !oid || !(size > MAX_BLOB_BYTES)) continue;
      const path = entry.slice(tab + 1);
      issues.set(`${oid}\0${path}`, { oid, path, size, location: 'current' });
    }
  }
  if (issues.size) throw new ArtifactsRepositoryIncompatibleError([...issues.values()]);
}

/** Hooks (including the LFS pre-push hook) never run: LFS content travels separately. */
const PUSH = ['-c', 'core.hooksPath=/dev/null', 'push'];
/** A pack of whole objects: no deltas computed or reused, none against objects the remote holds. */
const WHOLE_OBJECTS = ['-c', 'pack.window=0', '-c', 'pack.depth=0', '-c', 'pack.allowPackReuse=false'];

/** How a pushed pack (not a ref update) is refused when a second push, built as `pushToArtifacts` describes, can pass. */
const PACK_REFUSAL = /\bHTTP 500\b|delta base is missing|OFS_DELTA base not found|reachable object is missing|missing necessary objects/u;

/** The commits `remote` holds without their parents. Artifacts advertises none, but a fetch reports those of the
 * history it sends; it refuses a commits-only (filtered) fetch with HTTP 400, so this downloads the tips' trees. */
async function remoteShallowBoundaries(remote: string, auth: Record<string, string>): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-boundaries-'));
  try {
    await git(directory, ['init', '--quiet', '--bare']);
    await git(directory, ['fetch', '--quiet', '--update-shallow', '--no-tags', remote, '+refs/*:refs/remote/*'], auth);
    const shallow = join(directory, 'shallow');
    return existsSync(shallow) ? (await readFile(shallow, 'utf8')).split('\n').filter(Boolean) : [];
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * Artifacts' receive-pack refuses some pushes that a second, differently built one passes:
 * - packs of deltas, which it accepts sent whole: with HTTP 500 (djmc, 2026-10-19: 164 objects, 146 deltas, refused
 *   every time), saying a delta's base is missing though it advertised that base (inkibra-cell-executor-sandbox-spike,
 *   2026-10-28), or saying an offset delta's base, always in the same pack, is not found (three inkibra-core workspaces
 *   since 2026-10-23);
 * - packs leaving out commits it lacks. It advertises no shallow boundaries, so git counts the history below them,
 *   which this checkout may hold, as the remote's and omits it: the executor-sandbox push, sent whole, was refused with
 *   `reachable object is missing` for a merged parent that the remote held only as the parent of a boundary.
 * A refused push is sent once more without deltas, with the remote's boundaries added to the push's own.
 */
async function pushToArtifacts(input: { repositoryPath: string; remote: string; refspec: string; force: boolean; auth: Record<string, string>; shallow: Record<string, string> }): Promise<void> {
  const target = [...(input.force ? ['--force'] : []), input.remote, input.refspec];
  try { await git(input.repositoryPath, [...PUSH, ...target], { ...input.auth, ...input.shallow, GIT_LFS_SKIP_PUSH: '1' }); }
  catch (error) {
    if (!(error instanceof ArtifactsGitError) || !PACK_REFUSAL.test(error.message)) throw error;
    // The push's own boundaries: the one publication set, or the checkout's.
    const ownFile = input.shallow.GIT_SHALLOW_FILE ?? await git(input.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
    const own = existsSync(ownFile) ? (await readFile(ownFile, 'utf8')).split('\n') : [];
    // A remote whose tips cannot be fetched (it answers HTTP 500 for a missing object) gets the whole-object push alone.
    const remote = await remoteShallowBoundaries(input.remote, input.auth).catch(() => []);
    const directory = await mkdtemp(join(tmpdir(), 'gitspace-push-'));
    try {
      await writeFile(join(directory, 'shallow'), [...new Set([...own, ...remote].filter(Boolean))].map(commit => `${commit}\n`).join(''));
      await git(input.repositoryPath, [...WHOLE_OBJECTS, ...PUSH, '--no-thin', ...target], { ...input.auth, GIT_SHALLOW_FILE: join(directory, 'shallow'), GIT_LFS_SKIP_PUSH: '1' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

/** Checks that the current layers of `commit` fit, as a publication would. */
export async function verifyArtifactsGitUpload(repositoryPath: string, commit: string, headCommit: string | null): Promise<void> {
  await checkCurrentLayers(repositoryPath, commit, headCommit);
}

/** A lease is renewed this long before it expires, so no git operation starts with a token about to lapse. */
const LEASE_RENEWAL_MS = 60_000;
/** How git reports a token the remote refused: 401 without a prompt to fall back on, or 403. */
const AUTHENTICATION_FAILURE = /could not read (?:Username|Password)|Authentication failed|returned error: 40[13]\b|\bHTTP 40[13]\b/u;
type RepositoryLease = { remote: string; renewAt: number; environment: Record<string, string> };

/** No daemon, S3 authority, or persisted credential URL. Leases live in memory only. */
export class ArtifactsGitRemote {
  private readonly leases = new Map<string, Partial<Record<'read' | 'write', RepositoryLease>>>();

  constructor(private readonly options: ArtifactsGitRemoteOptions) {}

  /** `remoteHead` is a HEAD the remote already holds (the last accepted one), or null when unknown. A HEAD
   * descending from it is a plain push: git sends only what the remote lacks and history stays linked. Any other
   * HEAD, or new commits carrying a file Artifacts cannot store, is pushed from HEAD only (a shallow boundary). */
  async publishCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; headCommit: string | null; remoteHead: string | null }): Promise<void> {
    this.checkRef(input.checkpointRef);
    // Resolve once: a concurrently advanced local ref must not change the object
    // graph after validation or make the final push publish unchecked bytes.
    const commit = await git(input.repositoryPath, ['rev-parse', '--verify', `${input.checkpointRef}^{commit}`]);
    await checkCurrentLayers(input.repositoryPath, commit, input.headCommit);
    let boundary = input.headCommit;
    if (boundary !== null && input.remoteHead !== null) {
      const ancestry = Bun.spawn(['git', 'merge-base', '--is-ancestor', input.remoteHead, boundary], { cwd: input.repositoryPath, stdout: 'ignore', stderr: 'ignore' });
      // Only the new commits are listed; git's size filter reports oversized files with a `~` prefix.
      const oversizedHistory = await ancestry.exited === 0 && (await git(input.repositoryPath, ['rev-list', '--objects', '--no-object-names', `--filter=blob:limit=${MAX_BLOB_BYTES + 1}`, '--filter-print-omitted', boundary, '--not', input.remoteHead])).split('\n').some(line => line.startsWith('~'));
      // A boundary at a commit the remote holds would make it record that commit as having no parents.
      if (await ancestry.exited === 0 && !oversizedHistory) boundary = null;
    }
    await withShallowBoundary(boundary, async shallow => {
      const auth = await this.auth(input.binding, 'write');
      await this.transfer(input.binding, pushToArtifacts({ repositoryPath: input.repositoryPath, remote: auth.remote, refspec: `${commit}:${input.checkpointRef}`, force: true, auth: auth.environment, shallow }));
    });
  }

  /** Publishes a new branch, tag or pull request head (`refs/heads/*`, `refs/tags/*`, `refs/pull/<n>/head`) from its
   * tip only (a shallow boundary at the tip): older history, and any oversized file in it, stays on the origin. Never
   * moves an existing remote ref: equal is a no-op, any other commit is refused. */
  async publishRef(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; ref: string; commit: string }): Promise<void> {
    if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('ref', 'Invalid ref commit');
    if (!/^refs\/(?:heads|tags)\/./u.test(input.ref) && !/^refs\/pull\/[1-9][0-9]*\/head$/u.test(input.ref)) throw new ArtifactsGitError('ref', `Unsupported ref ${input.ref}`);
    await git(input.repositoryPath, ['check-ref-format', input.ref]);
    await git(input.repositoryPath, ['cat-file', '-e', `${input.commit}^{commit}`]);
    await withShallowBoundary(input.commit, async shallow => {
      await checkCurrentLayers(input.repositoryPath, input.commit, null, shallow);
      // Even read credentials may create the remote repository: check first.
      const probe = await this.auth(input.binding, 'read');
      const advertised = await this.transfer(input.binding, git(input.repositoryPath, ['ls-remote', '--refs', probe.remote, input.ref], probe.environment));
      // ls-remote patterns match ref suffixes; only the exact ref counts.
      const current = advertised.split('\n').map(line => line.split('\t')).find(([, name]) => name === input.ref)?.[0];
      if (current === input.commit) return;
      if (current !== undefined) throw new ArtifactsRefDivergedError(input.ref, current, input.commit);
      const auth = await this.auth(input.binding, 'write');
      await this.transfer(input.binding, pushToArtifacts({ repositoryPath: input.repositoryPath, remote: auth.remote, refspec: `${input.commit}:${input.ref}`, force: false, auth: auth.environment, shallow }));
    });
  }

  /** With `commit`, `checkpointRef` is this checkout's anchor for a cloud ref that every cache of the
   * workspace advances, so a cache can be handed a tip older than one it already holds (a long-poll or
   * dispatch snapshot its own publication overtook). The transfer lands on an owned ref, and the anchor
   * moves only to a commit it does not already reach: it never rewinds, so the newest checkpoint this
   * checkout received stays reachable, and a replaced canonical history is followed rather than refused. */
  async fetchCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; commit?: string }): Promise<void> {
    this.checkRef(input.checkpointRef);
    const { commit, checkpointRef, repositoryPath } = input;
    if (commit !== undefined && !/^[0-9a-f]{40}$/u.test(commit)) throw new ArtifactsGitError('checkpoint', 'Invalid immutable checkpoint commit');
    const auth = await this.auth(input.binding, 'read');
    const environment = { ...auth.environment, GIT_LFS_SKIP_SMUDGE: '1' };
    if (commit === undefined) {
      await this.transfer(input.binding, git(repositoryPath, ['fetch', '--update-shallow', '--no-write-fetch-head', auth.remote, `${checkpointRef}:${checkpointRef}`], environment));
      return;
    }
    const owned = `refs/gitspace/fetch/${crypto.randomUUID()}`;
    await this.transfer(input.binding, git(repositoryPath, ['fetch', '--update-shallow', '--no-write-fetch-head', auth.remote, `${commit}:${owned}`], environment));
    // Exact match: for-each-ref patterns also match refs below `checkpointRef/`.
    const anchor = async () => (await git(repositoryPath, ['for-each-ref', '--format=%(objectname) %(refname)', checkpointRef])).split('\n').map(line => line.split(' ')).find(([, name]) => name === checkpointRef)?.[0] ?? null;
    try {
      for (;;) {
        const current = await anchor();
        // Nothing reachable from `commit` is missing from the anchor: equal, or an older tip.
        if (current !== null && await git(repositoryPath, ['rev-list', '-n', '1', commit, '--not', current]) === '') return;
        try {
          await git(repositoryPath, ['update-ref', checkpointRef, commit, current ?? '0'.repeat(40)]);
          return;
        } catch (error) {
          // Only a concurrent fetch in this checkout moving the anchor is decided again.
          if (await anchor() === current) throw error;
        }
      }
    } finally {
      await git(repositoryPath, ['update-ref', '-d', owned, commit]);
    }
  }

  private checkRef(ref: string): void {
    if (!ref.startsWith('refs/gitspace/') || ref.includes('..') || !/^[A-Za-z0-9._/-]+$/u.test(ref)) throw new ArtifactsGitError('checkpoint', 'Invalid private checkpoint ref');
  }

  /** A lease is reused until a minute before it expires, and a write lease also serves reads: every lease costs the
   * cloud a workspace wake-up, and sync runs git several times a minute. */
  private async auth(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write'): Promise<RepositoryLease> {
    const key = JSON.stringify([binding.projectId, binding.repository]);
    const held = this.leases.get(key);
    const now = Date.now();
    if (held?.write && held.write.renewAt > now) return held.write;
    if (scope === 'read' && held?.read && held.read.renewAt > now) return held.read;
    const credential = await this.options.credentials(binding, scope);
    const remote = new URL(credential.remote);
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new ArtifactsGitError('credentials', 'Invalid credential-free repository URL');
    if (Date.parse(credential.expiresAt) <= Date.now() + LEASE_RENEWAL_MS || !Number.isFinite(Date.parse(credential.expiresAt))) throw new ArtifactsGitError('credentials', 'Repository token expires too soon');
    if (!credential.plaintext || /[\r\n]/u.test(credential.plaintext)) throw new ArtifactsGitError('credentials', 'Invalid repository token');
    const lease = { remote: remote.href, renewAt: Date.parse(credential.expiresAt) - LEASE_RENEWAL_MS, environment: {
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: `http.${remote.href}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.plaintext}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '', GIT_TERMINAL_PROMPT: '0',
    } };
    this.leases.set(key, { ...this.leases.get(key), [scope]: lease });
    return lease;
  }

  /** A remote that refuses a lease (revoked, or rotated by the cloud) makes the binding mint a fresh one next time. */
  private async transfer<T>(binding: ArtifactsRepositoryBinding, operation: Promise<T>): Promise<T> {
    try { return await operation; }
    catch (error) {
      if (error instanceof ArtifactsGitError && AUTHENTICATION_FAILURE.test(error.message)) this.leases.delete(JSON.stringify([binding.projectId, binding.repository]));
      throw error;
    }
  }
}
