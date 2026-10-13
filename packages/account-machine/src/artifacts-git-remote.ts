import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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
    super('preflight', `Repository is incompatible with Artifacts: ${issues.length} oversized blob path(s), maximum ${MAX_BLOB_BYTES} bytes (32 MB). ${details}${issues.length > 10 ? '; further paths are available in structured issue details' : ''}. Current HEAD, index, tracked worktree and portable worktree must all fit. For new large files, explicitly configure Git LFS and stage LFS pointers before checkpointing. Deleting a worktree file does not remove it from HEAD or the index. Oversized blobs confined to older history are excluded with a shallow boundary at the original HEAD; local history is retained. No automatic LFS conversion or history rewrite was performed.`);
    this.name = 'ArtifactsRepositoryIncompatibleError';
  }
}

/** The immutable graph cannot be represented by bounded upload packs. */
export class ArtifactsUploadLimitError extends ArtifactsGitError {
  readonly code = 'ARTIFACTS_UPLOAD_LIMIT';
  readonly retryable = false;

  constructor(message: string) {
    super('preflight', `${message}. Automatic retry cannot fix this current snapshot; reduce the oversized Git metadata or choose a compatible repository.`);
    this.name = 'ArtifactsUploadLimitError';
  }
}

/** Only these rejections prove publication stopped before credentials or remote writes. */
export function artifactsPublicationRejection(error: unknown): ArtifactsRepositoryIncompatibleError | ArtifactsUploadLimitError | null {
  const visited = new Set<Error>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof ArtifactsRepositoryIncompatibleError || error instanceof ArtifactsUploadLimitError) return error;
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

async function git(repositoryPath: string, args: string[], environment: Record<string, string> = {}, input?: string): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, env: { ...Bun.env, ...environment, GIT_NO_REPLACE_OBJECTS: '1' }, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new ArtifactsGitError(args[0] ?? 'git', stderr.trim() || `exited with ${exitCode}`);
  return stdout.trim();
}

const MAX_BLOB_BYTES = 32_000_000;
const BATCH_BYTES = 40 * 1024 * 1024;
const MAX_PACK_BYTES = 48 * 1024 * 1024;
// Uncompressed, non-delta packs make the bound independent of repository compression
// settings and delta heuristics. The remaining 16 MiB is transport/pack headroom.
// Sparse traversal can re-send blobs when synthetic staging paths change.
const PACK_CONFIG = ['-c', 'pack.window=0', '-c', 'pack.depth=0', '-c', 'pack.compression=0', '-c', 'pack.allowPackReuse=false', '-c', 'pack.useBitmaps=false', '-c', 'pack.useSparse=false'];
type UploadObject = { oid: string; kind: 'blob' | 'tree' | 'commit'; size: number };
type UploadState = { commit: string; trees: { oid: string; level: number }[] };
type UploadPlan = { tips: { commit: string; staging: boolean }[]; environment: Record<string, string> };

async function oversizedPaths(repositoryPath: string, commit: string, oversized: Map<string, number>, environment: Record<string, string>): Promise<ArtifactsRepositoryIssue[]> {
  const issues = new Map<string, ArtifactsRepositoryIssue>();
  const roots = new Set((await git(repositoryPath, ['log', '--format=%T', commit], environment)).split('\n'));
  // NUL framing preserves tabs, newlines, quoting and renamed/deleted paths. Only
  // tree metadata is read, never blob bodies. All validated layers are current.
  for (const tree of roots) {
    const entries = await git(repositoryPath, ['ls-tree', '-r', '-z', '--full-tree', tree], environment);
    for (const entry of entries.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, kind, oid] = entry.slice(0, tab).split(' ');
      if (kind !== 'blob' || !oid) continue;
      const size = oversized.get(oid);
      if (size === undefined) continue;
      const path = entry.slice(tab + 1);
      const key = `${oid}\0${path}`;
      if (!issues.has(key)) issues.set(key, { oid, path, size, location: 'current' });
    }
  }
  return [...issues.values()];
}

async function uploadInventory(repositoryPath: string, commit: string, environment: Record<string, string>): Promise<UploadObject[]> {
  // Object IDs, unlike rev-list's optional path hints, are unambiguous metadata.
  const revisions = await git(repositoryPath, ['rev-list', '--objects', '--no-object-names', '--reverse', '--topo-order', commit], environment);
  const metadata = await git(repositoryPath, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], environment, `${revisions}\n`);
  const blobs: UploadObject[] = [];
  const trees = new Map<string, UploadObject>();
  const commits: UploadObject[] = [];
  const oversized = new Map<string, number>();
  for (const line of metadata.split('\n')) {
    const [oid, kind, rawSize] = line.split(' ');
    const size = Number(rawSize);
    if (!oid || (kind !== 'blob' && kind !== 'tree' && kind !== 'commit') || !Number.isSafeInteger(size) || size < 0) throw new ArtifactsGitError('checkpoint', `Invalid Git object metadata: ${line}`);
    const object: UploadObject = { oid, kind, size };
    if (kind === 'blob') {
      if (size > MAX_BLOB_BYTES) oversized.set(oid, size);
      blobs.push(object);
    } else if (kind === 'tree') trees.set(oid, object);
    else commits.push(object);
  }
  if (oversized.size) throw new ArtifactsRepositoryIncompatibleError(await oversizedPaths(repositoryPath, commit, oversized, environment));
  // Shared trees are visited once, children before parents; rev-list's object
  // enumeration alone does not guarantee this ordering across merges.
  const ordered = blobs;
  const visited = new Set<string>();
  async function visitTree(oid: string): Promise<void> {
    if (visited.has(oid)) return;
    const tree = trees.get(oid);
    if (!tree) throw new ArtifactsGitError('checkpoint', `Missing tree ${oid}`);
    visited.add(oid);
    const entries = await git(repositoryPath, ['ls-tree', '-z', oid], environment);
    for (const entry of entries.split('\0')) {
      const match = /^040000 tree ([0-9a-f]+)\t/u.exec(entry);
      if (match?.[1]) await visitTree(match[1]);
    }
    ordered.push(tree);
  }
  for (const oid of trees.keys()) await visitTree(oid);
  for (const commitObject of commits) ordered.push(commitObject);
  return ordered;
}

/** Count subprocess output incrementally without accumulating blob/pack bytes in JS. */
async function packFits(repositoryPath: string, commit: string, environment: Record<string, string>, previous?: string): Promise<boolean> {
  const child = Bun.spawn(['git', ...PACK_CONFIG, 'pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object'], {
    cwd: repositoryPath, env: { ...Bun.env, ...environment, GIT_NO_REPLACE_OBJECTS: '1' }, stdin: new Blob([`${commit}\n${previous ? `^${previous}\n` : ''}`]), stdout: 'pipe', stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_PACK_BYTES) {
      child.kill();
      await reader.cancel();
      await Promise.all([child.exited, stderr]);
      return false;
    }
  }
  const [exitCode, error] = await Promise.all([child.exited, stderr]);
  if (exitCode !== 0) throw new ArtifactsGitError('pack-objects', error.trim() || `exited with ${exitCode}`);
  return true;
}

async function stagingCommit(repositoryPath: string, objects: UploadObject[], environment: Record<string, string>, previous?: UploadState): Promise<UploadState> {
  const entries = objects.filter(object => object.kind !== 'commit').map(object => `${object.kind === 'tree' ? '040000 tree' : '100644 blob'} ${object.oid}\t${object.oid}\0`).join('');
  let tree = await git(repositoryPath, ['mktree', '-z'], environment, entries);
  // Keep every staged object in the current boundary tree, not just ancestor
  // commits: Git's boundary traversal can otherwise resend earlier batches.
  // Binary merging bounds tree depth and mktree input logarithmically.
  const trees = previous ? [...previous.trees] : [];
  let level = 0;
  while (true) {
    const left = trees.at(-1);
    if (!left || left.level !== level) break;
    trees.pop();
    tree = await git(repositoryPath, ['mktree', '-z'], environment, `040000 tree ${left.oid}\tleft\0` + `040000 tree ${tree}\tright\0`);
    level++;
  }
  trees.push({ oid: tree, level });
  const root = await git(repositoryPath, ['mktree', '-z'], environment, trees.map(node => `040000 tree ${node.oid}\tlevel-${node.level}\0`).join(''));
  const parents = previous ? ['-p', previous.commit] : [];
  for (const object of objects) if (object.kind === 'commit') parents.push('-p', object.oid);
  const commit = await git(repositoryPath, ['commit-tree', root, ...parents], {
    ...environment,
    GIT_AUTHOR_NAME: 'GitSpace upload', GIT_AUTHOR_EMAIL: 'upload@gitspace.invalid',
    GIT_COMMITTER_NAME: 'GitSpace upload', GIT_COMMITTER_EMAIL: 'upload@gitspace.invalid',
  }, 'Temporary bounded checkpoint upload\n');
  return { commit, trees };
}

/** Validate every exact pack once, retaining immutable tips for later publication. */
async function walkBoundedUpload(repositoryPath: string, commit: string, objects: UploadObject[], plan: UploadPlan): Promise<void> {
  if (await packFits(repositoryPath, commit, plan.environment)) {
    plan.tips.push({ commit, staging: false });
    return;
  }
  let previous: UploadState | undefined;
  async function upload(batch: UploadObject[]): Promise<void> {
    const synthetic = await stagingCommit(repositoryPath, batch, plan.environment, previous);
    if (!await packFits(repositoryPath, synthetic.commit, plan.environment, previous?.commit)) {
      if (batch.length === 1) throw new ArtifactsUploadLimitError(`Git ${batch[0]?.kind} object ${batch[0]?.oid} (${batch[0]?.size} bytes) cannot fit the ${MAX_PACK_BYTES}-byte upload pack limit`);
      const middle = Math.floor(batch.length / 2);
      await upload(batch.slice(0, middle));
      await upload(batch.slice(middle));
      return;
    }
    plan.tips.push({ commit: synthetic.commit, staging: true });
    previous = synthetic;
  }
  let batch: UploadObject[] = [];
  let bytes = 0;
  for (const object of objects) {
    // A bounded entry/parent count also bounds mktree input and argv size.
    if (batch.length && (bytes + object.size + 256 > BATCH_BYTES || batch.length >= 128)) {
      await upload(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(object);
    bytes += object.size + 256;
  }
  if (batch.length) await upload(batch);
  if (!await packFits(repositoryPath, commit, plan.environment, previous?.commit)) throw new ArtifactsUploadLimitError('Final checkpoint exceeds the bounded upload limit');
  plan.tips.push({ commit, staging: false });
}

/** Both shallow metadata and synthetic upload objects are private. The caller's
 * index, refs, object database, working tree, shallow file and config stay untouched. */
async function withUploadPlan(repositoryPath: string, commit: string, headCommit: string | null, consume?: (plan: UploadPlan) => Promise<void>): Promise<void> {
  const head = headCommit === null ? null : await git(repositoryPath, ['rev-parse', '--verify', `${headCommit}^{commit}`]);
  const originalObjects = await git(repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const originalShallow = await git(repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
  let sourceBoundary = '';
  try { sourceBoundary = await readFile(originalShallow, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-upload-plan-'));
  try {
    const alternates = [JSON.stringify(originalObjects), Bun.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(value => value !== undefined).join(delimiter);
    const shallow = join(directory, 'shallow');
    const plan: UploadPlan = { tips: [], environment: { GIT_OBJECT_DIRECTORY: directory, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates, GIT_SHALLOW_FILE: shallow } };
    // Ignore source shallow markers here: none may hide a required snapshot layer.
    // HEAD alone is the boundary, and an unborn snapshot must reach a real root.
    const currentBoundary = head === null ? '' : `${head}\n`;
    await writeFile(shallow, currentBoundary);
    let objects = await uploadInventory(repositoryPath, commit, plan.environment);
    if (head !== null && !objects.some(object => object.kind === 'commit' && object.oid === head)) throw new ArtifactsGitError('preflight', 'Checkpoint does not reach its explicit HEAD boundary');
    if (head !== null && sourceBoundary !== currentBoundary) {
      await writeFile(shallow, sourceBoundary);
      try {
        objects = await uploadInventory(repositoryPath, commit, plan.environment);
      } catch (error) {
        // Every current layer already passed. Only incompatible older blobs may
        // cut the graph; missing objects and all other failures remain failures.
        if (!(error instanceof ArtifactsRepositoryIncompatibleError)) throw error;
        await writeFile(shallow, currentBoundary);
      }
    }
    await walkBoundedUpload(repositoryPath, commit, objects, plan);
    await consume?.(plan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Check all current layers, then the exact full or shallow upload without credentials. */
export async function verifyArtifactsGitUpload(repositoryPath: string, commit: string, headCommit: string | null): Promise<void> {
  const immutableCommit = await git(repositoryPath, ['rev-parse', '--verify', `${commit}^{commit}`]);
  await withUploadPlan(repositoryPath, immutableCommit, headCommit);
}

/** Pushes `commit` to `targetRef` through receive-pack-sized packs, never forced. Oversized graphs
 * travel as synthetic commits on an owned `refs/gitspace/upload/*` ref, which is always removed. */
async function publishBounded(repositoryPath: string, plan: UploadPlan, targetRef: string, auth: { remote: string; environment: Record<string, string> }): Promise<void> {
  const push = (refspec: string) => git(repositoryPath, [...PACK_CONFIG, '-c', 'core.hooksPath=/dev/null', 'push', auth.remote, refspec], { ...auth.environment, ...plan.environment, GIT_LFS_SKIP_PUSH: '1' });
  const temporaryRef = `refs/gitspace/upload/${crypto.randomUUID()}`;
  let attemptedUpload = false;
  let failure: unknown;
  try {
    for (const tip of plan.tips) {
      if (tip.staging) attemptedUpload = true;
      await push(`${tip.commit}:${tip.staging ? temporaryRef : targetRef}`);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (attemptedUpload) {
      try { await push(`:${temporaryRef}`); }
      catch (cleanupError) {
        throw new AggregateError(failure === undefined ? [cleanupError] : [failure, cleanupError], `Could not remove owned upload ref ${temporaryRef}`);
      }
    }
  }
}

/** No daemon, S3 authority, persisted credential URL, or credential cache. */
export class ArtifactsGitRemote {
  constructor(private readonly options: ArtifactsGitRemoteOptions) {}

  async publishCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; headCommit: string | null }): Promise<void> {
    this.checkRef(input.checkpointRef);
    // Resolve once: a concurrently advanced local ref must not change the object
    // graph after validation or make the final push publish unchecked bytes.
    const commit = await git(input.repositoryPath, ['rev-parse', '--verify', `${input.checkpointRef}^{commit}`]);
    await withUploadPlan(input.repositoryPath, commit, input.headCommit, async plan => {
      await publishBounded(input.repositoryPath, plan, input.checkpointRef, await this.auth(input.binding, 'write'));
    });
  }

  /** Publishes compatible full history, or a shallow graph at the original branch tip.
   * Never moves an existing remote branch: equal is a no-op, any other commit is refused. */
  async publishBranch(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; branch: string; commit: string }): Promise<void> {
    if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('branch', 'Invalid branch commit');
    const ref = `refs/heads/${input.branch}`;
    await git(input.repositoryPath, ['check-ref-format', ref]);
    await git(input.repositoryPath, ['cat-file', '-e', `${input.commit}^{commit}`]);
    await withUploadPlan(input.repositoryPath, input.commit, input.commit, async plan => {
      // Even read credentials may create the remote repository: preflight first.
      const probe = await this.auth(input.binding, 'read');
      const advertised = await git(input.repositoryPath, ['ls-remote', '--refs', probe.remote, ref], probe.environment);
      // ls-remote patterns match ref suffixes; only the exact branch counts.
      const current = advertised.split('\n').map(line => line.split('\t')).find(([, name]) => name === ref)?.[0];
      if (current === input.commit) return;
      if (current !== undefined) throw new ArtifactsBranchDivergedError(input.branch, current, input.commit);
      // A branch created concurrently since the probe is only ever fast-forwarded.
      await publishBounded(input.repositoryPath, plan, ref, await this.auth(input.binding, 'write'));
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
