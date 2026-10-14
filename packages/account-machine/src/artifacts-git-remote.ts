import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** The remote branch already names other history; publication never moves it. */
export class ArtifactsBranchDivergedError extends ArtifactsGitError {
  constructor(readonly branch: string, readonly remoteCommit: string, readonly commit: string) {
    super('branch', `Remote branch ${branch} is at ${remoteCommit}, not ${commit}; refusing to overwrite it`);
    this.name = 'ArtifactsBranchDivergedError';
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

/** Checks that the current layers of `commit` fit, as a publication would. */
export async function verifyArtifactsGitUpload(repositoryPath: string, commit: string, headCommit: string | null): Promise<void> {
  await checkCurrentLayers(repositoryPath, commit, headCommit);
}

/** No daemon, S3 authority, persisted credential URL, or credential cache. */
export class ArtifactsGitRemote {
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
      await git(input.repositoryPath, [...PUSH, '--force', auth.remote, `${commit}:${input.checkpointRef}`], { ...auth.environment, ...shallow, GIT_LFS_SKIP_PUSH: '1' });
    });
  }

  /** Publishes a new branch from its tip only (a shallow boundary at the tip): older history, and any oversized
   * file in it, stays on the origin. Never moves an existing remote branch: equal is a no-op, any other commit is refused. */
  async publishBranch(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; branch: string; commit: string }): Promise<void> {
    if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('branch', 'Invalid branch commit');
    const ref = `refs/heads/${input.branch}`;
    await git(input.repositoryPath, ['check-ref-format', ref]);
    await git(input.repositoryPath, ['cat-file', '-e', `${input.commit}^{commit}`]);
    await withShallowBoundary(input.commit, async shallow => {
      await checkCurrentLayers(input.repositoryPath, input.commit, null, shallow);
      // Even read credentials may create the remote repository: check first.
      const probe = await this.auth(input.binding, 'read');
      const advertised = await git(input.repositoryPath, ['ls-remote', '--refs', probe.remote, ref], probe.environment);
      // ls-remote patterns match ref suffixes; only the exact branch counts.
      const current = advertised.split('\n').map(line => line.split('\t')).find(([, name]) => name === ref)?.[0];
      if (current === input.commit) return;
      if (current !== undefined) throw new ArtifactsBranchDivergedError(input.branch, current, input.commit);
      const auth = await this.auth(input.binding, 'write');
      await git(input.repositoryPath, [...PUSH, auth.remote, `${input.commit}:${ref}`], { ...auth.environment, ...shallow, GIT_LFS_SKIP_PUSH: '1' });
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
      await git(repositoryPath, ['fetch', '--update-shallow', '--no-write-fetch-head', auth.remote, `${checkpointRef}:${checkpointRef}`], environment);
      return;
    }
    const owned = `refs/gitspace/fetch/${crypto.randomUUID()}`;
    await git(repositoryPath, ['fetch', '--update-shallow', '--no-write-fetch-head', auth.remote, `${commit}:${owned}`], environment);
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

  private async auth(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write') {
    const credential = await this.options.credentials(binding, scope);
    const remote = new URL(credential.remote);
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new ArtifactsGitError('credentials', 'Invalid credential-free repository URL');
    if (Date.parse(credential.expiresAt) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(credential.expiresAt))) throw new ArtifactsGitError('credentials', 'Repository token expires too soon');
    if (!credential.plaintext || /[\r\n]/u.test(credential.plaintext)) throw new ArtifactsGitError('credentials', 'Invalid repository token');
    return { remote: remote.href, environment: {
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: `http.${remote.href}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.plaintext}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '', GIT_TERMINAL_PROMPT: '0',
    } };
  }
}
