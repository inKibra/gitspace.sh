import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactsPushRefusal, smallerArtifactsPush } from '@gitspace/protocol-workspace';

export type ArtifactsRepositoryBinding = { projectId: string; repository: string };
export type ArtifactsRepositoryCredentials = { remote: string; plaintext: string; expiresAt: string };
export type ArtifactsGitRemoteOptions = {
  /** Asks the account for a lease on the repository; stops when `signal` aborts. */
  credentials(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write', signal: AbortSignal): Promise<ArtifactsRepositoryCredentials>;
  /** How long a lease request may take before it fails: `LEASE_REQUEST_MS` unless given. */
  leaseTimeoutMs?: number;
};

/** Who follows a publication: `progress` hears each step it takes and git's own progress lines, and `signal` kills the
 * git it runs. */
export type ArtifactsWatch = { signal?: AbortSignal; progress?(step: string): void };

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

async function git(repositoryPath: string, args: string[], environment: Record<string, string> = {}, watch: ArtifactsWatch & { input?: string } = {}): Promise<string> {
  watch.signal?.throwIfAborted();
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, env: { ...Bun.env, ...environment, GIT_NO_REPLACE_OBJECTS: '1' }, stdin: watch.input === undefined ? 'ignore' : new Blob([watch.input]), stdout: 'pipe', stderr: 'pipe' });
  const kill = () => child.kill();
  watch.signal?.addEventListener('abort', kill, { once: true });
  const readStderr = async () => {
    if (!watch.progress) return new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let text = '';
    let partial = '';
    for await (const chunk of child.stderr) {
      const piece = decoder.decode(chunk, { stream: true });
      text += piece;
      // git's progress meter rewrites its line with `\r`; each rewrite is a step here.
      const lines = (partial + piece).split(/[\r\n]/u);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) watch.progress(line.trim());
    }
    return text;
  };
  const output = Promise.all([new Response(child.stdout).text(), readStderr()]);
  let exitCode: number;
  try { exitCode = await child.exited; }
  finally { watch.signal?.removeEventListener('abort', kill); }
  if (watch.signal?.aborted) {
    // A transport git started can hold its pipes open after it was killed.
    void output.catch(() => undefined);
    throw watch.signal.reason;
  }
  const [stdout, stderr] = await output;
  if (exitCode !== 0) throw new ArtifactsGitError(args[0] ?? 'git', stderr.trim() || `exited with ${exitCode}`);
  return stdout.trim();
}

const MAX_BLOB_BYTES = 32_000_000;

/** Runs `run` with `boundary` and `held` as the only shallow commits, so nothing older than them is ever read or
 * pushed. `held` are commits the remote already holds, which the push never sends. */
async function withShallowBoundary<T>(boundary: string | null, held: string[], run: (environment: Record<string, string>) => Promise<T>): Promise<T> {
  if (boundary === null) return run({});
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-push-'));
  try {
    await writeFile(join(directory, 'shallow'), [...new Set([boundary, ...held])].map(commit => `${commit}\n`).join(''));
    return await run({ GIT_SHALLOW_FILE: join(directory, 'shallow') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Every current layer of `commit` (the commits down to and including `head`) must fit Artifacts' 32 MB file
 * limit. One git pass reads the size of every object in those commits' trees (each commit's tree whole, never file
 * contents) and reports none over it; only then are the trees listed one by one to name every path such a file has. */
async function checkCurrentLayers(repositoryPath: string, commit: string, head: string | null, environment: Record<string, string> = {}, watch: ArtifactsWatch = {}): Promise<void> {
  const range = head === null ? [commit] : [commit, '--not', `${head}^@`];
  watch.progress?.('Listing the commits whose file sizes to check');
  const commits = await git(repositoryPath, ['rev-list', ...range], environment, { signal: watch.signal });
  watch.progress?.(`Checking file sizes in ${commits.split('\n').filter(Boolean).length} commits`);
  // `--no-walk`: each listed commit's tree, whole, and nothing of its parents'. The size filter names each file over the
  // limit with a `~` prefix.
  const sizes = await git(repositoryPath, ['rev-list', '--objects', '--no-object-names', '--no-walk', '--stdin', `--filter=blob:limit=${MAX_BLOB_BYTES + 1}`, '--filter-print-omitted'], environment, { signal: watch.signal, input: commits });
  if (!sizes.split('\n').some(line => line.startsWith('~'))) return;
  const issues = new Map<string, ArtifactsRepositoryIssue>();
  const trees = new Set((await git(repositoryPath, ['log', '--format=%T', ...range], environment, { signal: watch.signal })).split('\n').filter(Boolean));
  let checked = 0;
  for (const tree of trees) {
    watch.progress?.(`Naming files over the size limit: tree ${++checked} of ${trees.size}`);
    for (const entry of (await git(repositoryPath, ['ls-tree', '-r', '-l', '-z', '--full-tree', tree], environment, { signal: watch.signal })).split('\0')) {
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

/** The commits `remote` holds without their parents. Artifacts advertises none, but a fetch reports those of the
 * history it sends; it refuses a commits-only (filtered) fetch with HTTP 400, so this downloads the tips' trees. */
async function remoteShallowBoundaries(input: ArtifactsPush): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-boundaries-'));
  try {
    await git(directory, ['init', '--quiet', '--bare']);
    input.watch.progress?.('Reading the shallow boundaries of the GitSpace repository');
    await input.lease(lease => git(directory, ['fetch', '--quiet', '--update-shallow', '--no-tags', lease.remote, '+refs/*:refs/remote/*'], lease.environment, { signal: input.watch.signal }));
    const shallow = join(directory, 'shallow');
    return existsSync(shallow) ? (await readFile(shallow, 'utf8')).split('\n').filter(Boolean) : [];
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A lease's remote and the git environment carrying its token. */
type PushLease = Pick<RepositoryLease, 'remote' | 'environment'>;

/** One push to Artifacts: `refspec` from the checkout at `repositoryPath`, with the publication's shallow boundaries
 * (`shallow`) as git environment. `update` says whether the push may move a ref the remote holds: only forward
 * (`fast-forward`), to anything (`force`), or only while it still names `from`. `lease` runs one git invocation against
 * the remote with a write lease current for it, renewing a lease the remote refuses and running it once more; `watch`
 * (its own when given to `lease`) follows it. */
type ArtifactsPush = {
  repositoryPath: string; refspec: string; update: 'fast-forward' | 'force' | { from: string }; shallow: Record<string, string>; watch: ArtifactsWatch;
  lease<T>(run: (lease: PushLease) => Promise<T>, watch?: ArtifactsWatch): Promise<T>;
};

/**
 * Artifacts' receive-pack refuses some pushes that a differently built one passes (`artifactsPushRefusal`):
 * - packs of deltas, which it accepts sent whole: with HTTP 500 (djmc, 2026-10-19: 164 objects, 146 deltas, refused
 *   every time), saying a delta's base is missing though it advertised that base (inkibra-cell-executor-sandbox-spike,
 *   2026-10-28), or saying an offset delta's base, always in the same pack, is not found (three acme-core workspaces
 *   since 2026-10-23);
 * - packs leaving out commits it lacks. It advertises no shallow boundaries, so git counts the history below them,
 *   which this checkout may hold, as the remote's and omits it: the executor-sandbox push, sent whole, was refused with
 *   `reachable object is missing` for a merged parent that the remote held only as the parent of a boundary;
 * - pushes over its 64 MiB limit (a 96.1 MiB base-branch import, 2026-10-31).
 * A refused pack is sent once more without deltas, with the remote's boundaries added to the push's own (`pushPack`);
 * a push too large is sent as several smaller ones (`pushInSteps`).
 */
async function pushToArtifacts(input: ArtifactsPush): Promise<void> {
  try { await pushPack(input); }
  catch (error) {
    if (!(error instanceof ArtifactsGitError) || artifactsPushRefusal(error.message) !== 'too-large') throw error;
    input.watch.progress?.(`GitSpace refused ${input.refspec} in one push as too large (${error.message.split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200)}); pushing it in steps`);
    await pushInSteps(input);
  }
}

async function pushPack(input: ArtifactsPush): Promise<void> {
  const ref = input.refspec.slice(input.refspec.lastIndexOf(':') + 1);
  const update = input.update === 'fast-forward' ? [] : input.update === 'force' ? ['--force'] : [`--force-with-lease=${ref}:${input.update.from}`];
  input.watch.progress?.(`Pushing ${input.refspec} to GitSpace in one push`);
  try { await input.lease(lease => git(input.repositoryPath, [...PUSH, ...input.watch.progress ? ['--progress'] : [], ...update, lease.remote, input.refspec], { ...lease.environment, ...input.shallow, GIT_LFS_SKIP_PUSH: '1' }, input.watch)); }
  catch (error) {
    if (!(error instanceof ArtifactsGitError) || artifactsPushRefusal(error.message) !== 'pack') throw error;
    // The push's own boundaries: the one publication set, or the checkout's.
    const ownFile = input.shallow.GIT_SHALLOW_FILE ?? await git(input.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
    const own = existsSync(ownFile) ? (await readFile(ownFile, 'utf8')).split('\n') : [];
    // A remote whose tips cannot be fetched (it answers HTTP 500 for a missing object) gets the whole-object push alone.
    const remote = await remoteShallowBoundaries(input).catch(() => []);
    const directory = await mkdtemp(join(tmpdir(), 'gitspace-push-'));
    try {
      await writeFile(join(directory, 'shallow'), [...new Set([...own, ...remote].filter(Boolean))].map(commit => `${commit}\n`).join(''));
      input.watch.progress?.(`GitSpace refused the pack for ${input.refspec} (${error.message.split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200)}); pushing it again as whole objects`);
      await input.lease(lease => git(input.repositoryPath, [...WHOLE_OBJECTS, ...PUSH, ...input.watch.progress ? ['--progress'] : [], '--no-thin', ...update, lease.remote, input.refspec], { ...lease.environment, GIT_SHALLOW_FILE: join(directory, 'shallow'), GIT_LFS_SKIP_PUSH: '1' }, input.watch));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

/**
 * A push Artifacts refused as too large, sent as several: the commits the remote lacks, parents before children and
 * every parent's history included (a merge brings the merged branch's), go in steps, each carrying fewer commits after a
 * further refusal (`smallerArtifactsPush`), and then the ref itself moves, sending little more. A step reaches the
 * remote through staging refs at its commits that no other commit of the step descends from; every staging ref stays
 * until the ref has moved, so each push sends only what earlier ones did not. The whole history stays linked. A step of
 * one commit still too large sends that commit's blobs ahead of it (`pushBlobsInParts`).
 */
async function pushInSteps(input: ArtifactsPush): Promise<void> {
  const source = input.refspec.slice(input.refspec.startsWith('+') ? 1 : 0, input.refspec.lastIndexOf(':'));
  const commit = (await git(input.repositoryPath, ['rev-parse', '--verify', `${source}^{commit}`])).trim();
  input.watch.progress?.('Reading what the GitSpace repository holds, to push in steps');
  const held = (await input.lease(lease => git(input.repositoryPath, ['ls-remote', lease.remote], lease.environment, { signal: input.watch.signal }))).split('\n')
    .map(line => line.split('\t')[0] ?? '').filter(oid => /^[0-9a-f]{40}$/u.test(oid));
  // Each line: a commit, then its parents.
  const commits = (await git(input.repositoryPath, ['rev-list', '--topo-order', '--reverse', '--parents', '--ignore-missing', commit, ...(held.length ? ['--not', ...held] : [])], input.shallow, { signal: input.watch.signal }))
    .split('\n').filter(Boolean).map(line => line.split(' '));
  let size = smallerArtifactsPush(commits.length) ?? 1;
  input.watch.progress?.(`Pushing ${commits.length} commits in steps of at most ${size}`);
  // Named by when it began, so `clearStaging` tells a publication's in-flight refs from those one cut short left.
  const staging = `refs/gitspace/staging/${Date.now()}-${crypto.randomUUID()}`;
  const refs: string[] = [];
  // Commits whose blobs went ahead of them: a push of one refused again after that stands.
  const parted = new Set<string>();
  try {
    // A lone commit was just refused whole.
    const [lone] = commits;
    if (commits.length === 1 && lone) { await pushBlobsInParts(input, lone, staging, refs); parted.add(lone[0]!); }
    for (let sent = 0; sent < commits.length;) {
      const step = commits.slice(sent, sent + size);
      input.watch.progress?.(`Pushing step: commits ${sent + 1}–${sent + step.length} of ${commits.length}`);
      const parents = new Set(step.flatMap(([, ...of]) => of));
      try {
        for (const [tip] of step.filter(([oid]) => !parents.has(oid!))) {
          const ref = `${staging}/${refs.length}`;
          await pushPack({ ...input, refspec: `${tip}:${ref}`, update: 'force' });
          refs.push(ref);
        }
        sent += step.length;
      } catch (error) {
        if (!(error instanceof ArtifactsGitError) || artifactsPushRefusal(error.message) !== 'too-large') throw error;
        const smaller = smallerArtifactsPush(size);
        if (smaller !== null) { size = smaller; continue; }
        const [single] = step;
        if (!single || parted.has(single[0]!)) throw error;
        await pushBlobsInParts(input, single, staging, refs);
        parted.add(single[0]!);
      }
    }
    await pushPack(input);
  } finally {
    // Staging refs hold only objects the pushed ref holds too. They are deleted even after the publication was stopped,
    // under their own deadline; any a killed process leaves, the next copy deletes (`clearStaging`). A deletion sends no
    // objects, so it sends no shallow boundaries either (`DELETE_SHALLOW`).
    const cleanup = { signal: AbortSignal.timeout(STAGING_CLEANUP_MS) };
    if (refs.length) await input.lease(lease => git(input.repositoryPath, [...PUSH, lease.remote, ...refs.map(ref => `:${ref}`)], { ...lease.environment, ...DELETE_SHALLOW }, cleanup), cleanup).catch(() => undefined);
  }
}

/** Raw blob bytes one staging part of a commit carries at most, well under Artifacts' 64 MiB per push. */
const PART_BYTES = 32 * 1024 * 1024;

/**
 * The blobs `commit` adds over its `parents`, pushed ahead of it to staging refs in parts: each part a parentless
 * commit whose flat tree names its blobs by id, PART_BYTES of them at most and halved after a refusal. The commit's own
 * push then sends its trees and little more: a push with a shallow boundary (git's `pack-objects --shallow`) counts
 * every staged tree as held, which an ordinary push does not. A single blob Artifacts refuses stays refused. A 134.1
 * MiB base-branch tip of one commit (2026-11-26) could not be pushed otherwise.
 */
async function pushBlobsInParts(input: ArtifactsPush, [commit, ...parents]: string[], staging: string, refs: string[]): Promise<void> {
  const repository = input.repositoryPath;
  const added = new Set((await git(repository, ['rev-list', '--objects', '--no-object-names', '--ignore-missing', commit!, ...(parents.length ? ['--not', ...parents] : [])], input.shallow, { signal: input.watch.signal })).split('\n'));
  const blobs = new Map<string, number>();
  // `<mode> <type> <oid> <size>\t<path>`
  for (const entry of (await git(repository, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit!], input.shallow)).split('\0')) {
    const [, type, oid, size] = entry.slice(0, entry.indexOf('\t')).split(/\s+/u);
    if (type === 'blob' && oid && added.has(oid)) blobs.set(oid, Number(size));
  }
  const parts: string[][] = [];
  let bytes = PART_BYTES;
  for (const [oid, size] of blobs) {
    if (bytes + size > PART_BYTES) { parts.push([]); bytes = 0; }
    parts.at(-1)!.push(oid);
    bytes += size;
  }
  const author = { GIT_AUTHOR_NAME: 'GitSpace', GIT_AUTHOR_EMAIL: 'staging@gitspace.invalid', GIT_COMMITTER_NAME: 'GitSpace', GIT_COMMITTER_EMAIL: 'staging@gitspace.invalid' };
  for (let part = parts.shift(); part; part = parts.shift()) {
    const mktree = Bun.spawn(['git', 'mktree', '-z'], {
      cwd: repository, env: { ...Bun.env, ...input.shallow }, stdout: 'pipe', stderr: 'pipe',
      stdin: new Blob([part.map(oid => `100644 blob ${oid}\t${oid}\0`).join('')]),
    });
    const [exitCode, tree, stderr] = await Promise.all([mktree.exited, new Response(mktree.stdout).text(), new Response(mktree.stderr).text()]);
    if (exitCode !== 0) throw new ArtifactsGitError('mktree', stderr.trim() || `exited with ${exitCode}`);
    const staged = await git(repository, ['commit-tree', tree.trim(), '-m', 'GitSpace staging'], { ...input.shallow, ...author });
    const ref = `${staging}/${refs.length}`;
    try {
      await pushPack({ ...input, refspec: `${staged}:${ref}`, update: 'force' });
      refs.push(ref);
    } catch (error) {
      if (!(error instanceof ArtifactsGitError) || artifactsPushRefusal(error.message) !== 'too-large' || part.length === 1) throw error;
      parts.unshift(part.slice(0, part.length / 2), part.slice(part.length / 2));
    }
  }
}

/** Checks that the current layers of `commit` fit, as a publication would. */
export async function verifyArtifactsGitUpload(repositoryPath: string, commit: string, headCommit: string | null): Promise<void> {
  await checkCurrentLayers(repositoryPath, commit, headCommit);
}

/** A lease is renewed this long before it expires, so no git operation starts with a token about to lapse. */
const LEASE_RENEWAL_MS = 60_000;
/** A push starts only with a lease this long from expiring: pushes of a large publication run for minutes, and a token
 * that lapsed mid-push failed one (403 "Invalid or expired token", 2026-11-28). */
const PUSH_LEASE_MS = 10 * 60_000;
/** A lease request the account has not answered in this long fails: it reaches a workspace object that may be stuck. */
const LEASE_REQUEST_MS = 60_000;
/** How long deleting a publication's staging refs may take. */
const STAGING_CLEANUP_MS = 60_000;
/** A staging ref older than this belongs to a publication that ended without deleting it. */
const STAGING_STALE_MS = 60 * 60_000;
/** A push that only deletes refs reads no shallow boundaries: git 2.43's receive-pack crashed (segfault) on a
 * deletion-only push from a shallow repository into one accepting shallow updates. */
const DELETE_SHALLOW = { GIT_SHALLOW_FILE: '/dev/null' };
/** How git reports a token the remote refused: 401 without a prompt to fall back on, or 403. */
const AUTHENTICATION_FAILURE = /could not read (?:Username|Password)|Authentication failed|returned error: 40[13]\b|\bHTTP 40[13]\b/u;
type RepositoryLease = { remote: string; expiresAt: number; environment: Record<string, string> };

/** No daemon, S3 authority, or persisted credential URL. Leases live in memory only. */
export class ArtifactsGitRemote {
  private readonly leases = new Map<string, Partial<Record<'read' | 'write', RepositoryLease>>>();

  constructor(private readonly options: ArtifactsGitRemoteOptions) {}

  /** `remoteHead` is a HEAD the remote already holds (the last accepted one), or null when unknown. A HEAD
   * descending from it is a plain push: git sends only what the remote lacks and history stays linked. Any other
   * HEAD, or new commits carrying a file Artifacts cannot store, is pushed from HEAD only (a shallow boundary). `watch`
   * follows the publication. */
  async publishCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; headCommit: string | null; remoteHead: string | null; watch?: ArtifactsWatch }): Promise<void> {
    const watch = input.watch ?? {};
    this.checkRef(input.checkpointRef);
    // Resolve once: a concurrently advanced local ref must not change the object
    // graph after validation or make the final push publish unchecked bytes.
    const commit = await git(input.repositoryPath, ['rev-parse', '--verify', `${input.checkpointRef}^{commit}`]);
    await checkCurrentLayers(input.repositoryPath, commit, input.headCommit, {}, watch);
    let boundary = input.headCommit;
    if (boundary !== null && input.remoteHead !== null) {
      const ancestry = Bun.spawn(['git', 'merge-base', '--is-ancestor', input.remoteHead, boundary], { cwd: input.repositoryPath, stdout: 'ignore', stderr: 'ignore' });
      // Only the new commits are listed; git's size filter reports oversized files with a `~` prefix.
      const oversizedHistory = await ancestry.exited === 0 && (await git(input.repositoryPath, ['rev-list', '--objects', '--no-object-names', `--filter=blob:limit=${MAX_BLOB_BYTES + 1}`, '--filter-print-omitted', boundary, '--not', input.remoteHead], {}, { signal: watch.signal })).split('\n').some(line => line.startsWith('~'));
      // A boundary at a commit the remote holds would make it record that commit as having no parents.
      if (await ancestry.exited === 0 && !oversizedHistory) boundary = null;
    }
    const auth = await this.auth(input.binding, 'write', watch);
    // A forced push whose remote ref holds a commit this checkout has checks whether it fast-forwards, walking the new
    // commit's whole history whatever the remote holds. A checkout of a project copied in from its tip stops at that
    // tip (its own shallow boundary), and the walk read the tip's missing parent: git 2.54 failed the push ("Could not
    // read <parent>", every sync of two workspaces, 2026-11-27). The checkout's boundaries the remote advertises stay
    // boundaries; any other may lie among the commits sent, where it would conceal a missing layer.
    const ownFile = await git(input.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
    const own = boundary !== null && existsSync(ownFile) ? (await readFile(ownFile, 'utf8')).split('\n').filter(Boolean) : [];
    const advertised = own.length ? new Set((await git(input.repositoryPath, ['ls-remote', auth.remote], auth.environment, { signal: watch.signal })).split('\n').map(line => line.split('\t')[0])) : new Set<string>();
    await withShallowBoundary(boundary, own.filter(commit => advertised.has(commit)), async shallow => {
      await this.transfer(input.binding, pushToArtifacts({ repositoryPath: input.repositoryPath, refspec: `${commit}:${input.checkpointRef}`, update: 'force', shallow, watch, lease: this.pushLease(input.binding, watch) }));
    });
  }

  /** Publishes a new branch, tag, pull request head or kept commit (`refs/heads/*`, `refs/tags/*`, `refs/pull/<n>/head`,
   * `refs/gitspace/commits/<commit>`) from its tip only (a shallow boundary at the tip): older history, and any oversized
   * file in it, stays on the origin. Never moves an existing remote ref: equal is a no-op, any other commit is refused.
   * `watch` hears each step. */
  async publishRef(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; ref: string; commit: string; watch?: ArtifactsWatch }): Promise<void> {
    const watch = input.watch ?? {};
    if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('ref', 'Invalid ref commit');
    await this.checkPublishedRef(input.repositoryPath, input.ref);
    await git(input.repositoryPath, ['cat-file', '-e', `${input.commit}^{commit}`]);
    await withShallowBoundary(input.commit, [], shallow => checkCurrentLayers(input.repositoryPath, input.commit, null, shallow, watch));
    const refs = await this.remoteRefs(input, undefined, watch);
    const current = refs.get(input.ref) ?? null;
    if (current === input.commit) return;
    if (current !== null) throw new ArtifactsRefDivergedError(input.ref, current, input.commit);
    // The remote's tips this checkout holds stay boundaries too: the remote may hold one without its parents (a
    // workspace copied in from its tip), and git would count history below it, `commit` among it, as the remote's
    // and leave it out of the push.
    const tips = [...new Set(refs.values())];
    const held = tips.length ? (await git(input.repositoryPath, ['rev-list', '--no-walk', '--ignore-missing', ...tips])).split('\n').filter(Boolean) : [];
    await withShallowBoundary(input.commit, held, async shallow => {
      await this.transfer(input.binding, pushToArtifacts({ repositoryPath: input.repositoryPath, refspec: `${input.commit}:${input.ref}`, update: 'fast-forward', shallow, watch, lease: this.pushLease(input.binding, watch) }));
    });
  }

  /** The commit a ref of the kinds `publishRef` publishes names on the remote, or null while the remote lacks it. */
  async readRef(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; ref: string; watch?: ArtifactsWatch }): Promise<string | null> {
    await this.checkPublishedRef(input.repositoryPath, input.ref);
    return (await this.remoteRefs(input, input.ref, input.watch ?? {})).get(input.ref) ?? null;
  }

  /** Moves a ref of the kinds `publishRef` publishes from `from`, the commit the remote holds it at, to `commit`, a
   * descendant of `from` in the checkout at `repositoryPath`. `from` is the push's shallow boundary, so the push sends
   * only commits after it and the moved ref's history stays linked to it. The push moves the ref only while it still
   * names `from`; a `commit` not descending from `from` is refused before any write. `watch` hears each step. */
  async advanceRef(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; ref: string; from: string; commit: string; watch?: ArtifactsWatch }): Promise<void> {
    const watch = input.watch ?? {};
    if (!/^[0-9a-f]{40}$/u.test(input.commit) || !/^[0-9a-f]{40}$/u.test(input.from)) throw new ArtifactsGitError('ref', 'Invalid ref commit');
    await this.checkPublishedRef(input.repositoryPath, input.ref);
    await git(input.repositoryPath, ['cat-file', '-e', `${input.commit}^{commit}`]);
    // The checkout's own boundaries stay boundaries: their parents are not here to read.
    const ownFile = await git(input.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
    const own = existsSync(ownFile) ? (await readFile(ownFile, 'utf8')).split('\n').filter(Boolean) : [];
    await withShallowBoundary(input.from, own, async shallow => {
      watch.progress?.(`Checking that ${input.commit.slice(0, 7)} builds on ${input.from.slice(0, 7)}`);
      watch.signal?.throwIfAborted();
      const ancestry = Bun.spawn(['git', 'merge-base', '--is-ancestor', input.from, input.commit], { cwd: input.repositoryPath, env: { ...Bun.env, ...shallow }, stdout: 'ignore', stderr: 'ignore' });
      const kill = () => ancestry.kill();
      watch.signal?.addEventListener('abort', kill, { once: true });
      const exitCode = await ancestry.exited;
      watch.signal?.removeEventListener('abort', kill);
      watch.signal?.throwIfAborted();
      if (exitCode !== 0) throw new ArtifactsRefDivergedError(input.ref, input.from, input.commit);
      await checkCurrentLayers(input.repositoryPath, input.commit, input.from, shallow, watch);
      await this.transfer(input.binding, pushToArtifacts({ repositoryPath: input.repositoryPath, refspec: `${input.commit}:${input.ref}`, update: { from: input.from }, shallow, watch, lease: this.pushLease(input.binding, watch) }));
    });
  }

  /** Deletes the staging refs (`refs/gitspace/staging/<startedMs>-<uuid>/<n>`) publications cut short left in the
   * repository: begun over `STAGING_STALE_MS` ago, or named before staging refs carried their start (no time). A machine
   * killed mid-push leaves them, and they hold objects nothing else reaches; a publication still running keeps its own.
   * Returns how many it deleted. */
  async clearStaging(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; watch?: ArtifactsWatch }): Promise<number> {
    const watch = input.watch ?? {};
    const auth = await this.auth(input.binding, 'write', watch);
    const stale = Date.now() - STAGING_STALE_MS;
    const staging = (await this.transfer(input.binding, git(input.repositoryPath, ['ls-remote', '--refs', auth.remote, 'refs/gitspace/staging/*'], auth.environment, { signal: watch.signal })))
      .split('\n').map(line => line.split('\t')[1] ?? '').filter(ref => {
        if (!ref.startsWith('refs/gitspace/staging/')) return false;
        const started = /^refs\/gitspace\/staging\/(\d+)-/u.exec(ref);
        return started === null || Number(started[1]) < stale;
      });
    if (!staging.length) return 0;
    watch.progress?.(`Deleting ${staging.length} staging refs cut-short publications left in ${input.binding.repository}`);
    await this.transfer(input.binding, git(input.repositoryPath, [...PUSH, auth.remote, ...staging.map(ref => `:${ref}`)], { ...auth.environment, ...DELETE_SHALLOW }, { signal: watch.signal }));
    return staging.length;
  }

  private async checkPublishedRef(repositoryPath: string, ref: string): Promise<void> {
    if (!/^refs\/(?:heads|tags)\/./u.test(ref) && !/^refs\/pull\/[1-9][0-9]*\/head$/u.test(ref) && !/^refs\/gitspace\/commits\/[0-9a-f]{40}$/u.test(ref)) throw new ArtifactsGitError('ref', `Unsupported ref ${ref}`);
    await git(repositoryPath, ['check-ref-format', ref]);
  }

  /** The remote's refs (those matching `pattern` when given) and their commits. Asks with read credentials first: even
   * those may create the remote repository. ls-remote patterns match ref suffixes, so callers look up exact names. */
  private async remoteRefs(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string }, pattern: string | undefined, watch: ArtifactsWatch): Promise<Map<string, string>> {
    const probe = await this.auth(input.binding, 'read', watch);
    watch.progress?.(`Reading the refs of ${input.binding.repository}`);
    const advertised = await this.transfer(input.binding, git(input.repositoryPath, ['ls-remote', '--refs', probe.remote, ...pattern === undefined ? [] : [pattern]], probe.environment, { signal: watch.signal }));
    return new Map(advertised.split('\n').filter(Boolean).map(line => {
      const [commit = '', name = ''] = line.split('\t');
      return [name, commit];
    }));
  }

  /** With `commit`, `checkpointRef` is this checkout's anchor for a cloud ref that every cache of the
   * workspace advances, so a cache can be handed a tip older than one it already holds (a long-poll or
   * dispatch snapshot its own publication overtook). The transfer lands on an owned ref, and the anchor
   * moves only to a commit it does not already reach: it never rewinds, so the newest checkpoint this
   * checkout received stays reachable, and a replaced canonical history is followed rather than refused. `watch`
   * follows the transfer. */
  async fetchCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; commit?: string; watch?: ArtifactsWatch }): Promise<void> {
    const watch = input.watch ?? {};
    this.checkRef(input.checkpointRef);
    const { commit, checkpointRef, repositoryPath } = input;
    if (commit !== undefined && !/^[0-9a-f]{40}$/u.test(commit)) throw new ArtifactsGitError('checkpoint', 'Invalid immutable checkpoint commit');
    const auth = await this.auth(input.binding, 'read', watch);
    const environment = { ...auth.environment, GIT_LFS_SKIP_SMUDGE: '1' };
    if (commit === undefined) {
      await this.transfer(input.binding, git(repositoryPath, ['fetch', '--update-shallow', '--no-write-fetch-head', auth.remote, `${checkpointRef}:${checkpointRef}`], environment, watch));
      return;
    }
    const owned = `refs/gitspace/fetch/${crypto.randomUUID()}`;
    await this.transfer(input.binding, git(repositoryPath, ['fetch', '--update-shallow', '--no-write-fetch-head', auth.remote, `${commit}:${owned}`], environment, watch));
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

  /** A lease is reused until `headroomMs` (a minute unless given) before it expires, and a write lease also serves
   * reads: every lease costs the cloud a workspace wake-up, and sync runs git several times a minute. A request the
   * account does not answer within `leaseTimeoutMs` fails, and `watch` hears that one is being asked for. */
  private async auth(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write', watch: ArtifactsWatch = {}, headroomMs = LEASE_RENEWAL_MS): Promise<RepositoryLease> {
    const key = JSON.stringify([binding.projectId, binding.repository]);
    const held = this.leases.get(key);
    const now = Date.now();
    if (held?.write && held.write.expiresAt - now > headroomMs) return held.write;
    if (scope === 'read' && held?.read && held.read.expiresAt - now > headroomMs) return held.read;
    const timeoutMs = this.options.leaseTimeoutMs ?? LEASE_REQUEST_MS;
    watch.progress?.(`Requesting a ${scope} lease on ${binding.repository} from the account`);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = watch.signal ? AbortSignal.any([watch.signal, deadline]) : deadline;
    // The deadline holds even for a request that ignores its signal.
    const { promise: ended, reject } = Promise.withResolvers<never>();
    const end = () => reject(deadline.aborted ? new ArtifactsGitError('credentials', `The account did not answer a ${scope} lease request for ${binding.repository} within ${Math.round(timeoutMs / 1000)} s`) : signal.reason);
    signal.addEventListener('abort', end, { once: true });
    let credential: ArtifactsRepositoryCredentials;
    try { credential = await Promise.race([this.options.credentials(binding, scope, signal), ended]); }
    finally { signal.removeEventListener('abort', end); }
    const remote = new URL(credential.remote);
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new ArtifactsGitError('credentials', 'Invalid credential-free repository URL');
    if (Date.parse(credential.expiresAt) <= Date.now() + LEASE_RENEWAL_MS || !Number.isFinite(Date.parse(credential.expiresAt))) throw new ArtifactsGitError('credentials', 'Repository token expires too soon');
    if (!credential.plaintext || /[\r\n]/u.test(credential.plaintext)) throw new ArtifactsGitError('credentials', 'Invalid repository token');
    const lease = { remote: remote.href, expiresAt: Date.parse(credential.expiresAt), environment: {
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: `http.${remote.href}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.plaintext}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '', GIT_TERMINAL_PROMPT: '0',
    } };
    this.leases.set(key, { ...this.leases.get(key), [scope]: lease });
    return lease;
  }

  /** Runs each git invocation of a push with a write lease at least `PUSH_LEASE_MS` from expiring, asked for when the
   * held one is not; a lease the remote refuses (it expired, or was revoked) is replaced and the invocation run once
   * more. `watch` asks for leases unless the invocation brings its own. */
  private pushLease(binding: ArtifactsRepositoryBinding, watch: ArtifactsWatch): ArtifactsPush['lease'] {
    return async (run, own = watch) => {
      try { return await run(await this.auth(binding, 'write', own, PUSH_LEASE_MS)); }
      catch (error) {
        if (!(error instanceof ArtifactsGitError) || !AUTHENTICATION_FAILURE.test(error.message)) throw error;
        this.leases.delete(JSON.stringify([binding.projectId, binding.repository]));
        own.progress?.(`${binding.repository} refused the write lease (${error.message.split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200)}); asking for a new one and running that step again`);
        return run(await this.auth(binding, 'write', own, PUSH_LEASE_MS));
      }
    };
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
