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

/** The remote branch already names other history; publication never moves it. */
export class ArtifactsBranchDivergedError extends ArtifactsGitError {
  constructor(readonly branch: string, readonly remoteCommit: string, readonly commit: string) {
    super('branch', `Remote branch ${branch} is at ${remoteCommit}, not ${commit}; refusing to overwrite it`);
    this.name = 'ArtifactsBranchDivergedError';
  }
}

async function git(repositoryPath: string, args: string[], environment: Record<string, string> = {}, input?: string): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, env: { ...Bun.env, ...environment }, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
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

async function uploadInventory(repositoryPath: string, commit: string): Promise<UploadObject[]> {
  const names = new Map<string, string>();
  const revisions = await git(repositoryPath, ['rev-list', '--objects', '--reverse', '--topo-order', commit]);
  for (const line of revisions.split('\n')) {
    const space = line.indexOf(' ');
    names.set(space < 0 ? line : line.slice(0, space), space < 0 ? line : line.slice(space + 1));
  }
  const metadata = await git(repositoryPath, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {}, `${[...names.keys()].join('\n')}\n`);
  const blobs: UploadObject[] = [];
  const trees = new Map<string, UploadObject>();
  const commits: UploadObject[] = [];
  for (const line of metadata.split('\n')) {
    const [oid, kind, rawSize] = line.split(' ');
    const size = Number(rawSize);
    if (!oid || (kind !== 'blob' && kind !== 'tree' && kind !== 'commit') || !Number.isSafeInteger(size) || size < 0) throw new ArtifactsGitError('checkpoint', `Invalid Git object metadata: ${line}`);
    const object: UploadObject = { oid, kind, size };
    if (kind === 'blob') {
      if (size > MAX_BLOB_BYTES) throw new ArtifactsGitError('checkpoint', `Blob ${names.get(oid) ?? oid} is ${size} bytes; maximum is ${MAX_BLOB_BYTES} bytes (32 MB). Use Git LFS for larger files.`);
      blobs.push(object);
    } else if (kind === 'tree') trees.set(oid, object);
    else commits.push(object);
  }
  // Shared trees are visited once, children before parents; rev-list's object
  // enumeration alone does not guarantee this ordering across merges.
  const ordered = blobs;
  const visited = new Set<string>();
  async function visitTree(oid: string): Promise<void> {
    if (visited.has(oid)) return;
    const tree = trees.get(oid);
    if (!tree) throw new ArtifactsGitError('checkpoint', `Missing tree ${oid}`);
    visited.add(oid);
    const entries = await git(repositoryPath, ['ls-tree', '-z', oid]);
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
async function packFits(repositoryPath: string, commit: string, previous?: string): Promise<boolean> {
  const child = Bun.spawn(['git', ...PACK_CONFIG, 'pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object'], {
    cwd: repositoryPath, stdin: new Blob([`${commit}\n${previous ? `^${previous}\n` : ''}`]), stdout: 'pipe', stderr: 'pipe',
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

async function stagingCommit(repositoryPath: string, objects: UploadObject[], previous?: UploadState): Promise<UploadState> {
  const entries = objects.filter(object => object.kind !== 'commit').map(object => `${object.kind === 'tree' ? '040000 tree' : '100644 blob'} ${object.oid}\t${object.oid}\0`).join('');
  let tree = await git(repositoryPath, ['mktree', '-z'], {}, entries);
  // Keep every staged object in the current boundary tree, not just ancestor
  // commits: Git's boundary traversal can otherwise resend earlier batches.
  // Binary merging bounds tree depth and mktree input logarithmically.
  const trees = previous ? [...previous.trees] : [];
  let level = 0;
  while (true) {
    const left = trees.at(-1);
    if (!left || left.level !== level) break;
    trees.pop();
    tree = await git(repositoryPath, ['mktree', '-z'], {}, `040000 tree ${left.oid}\tleft\0` + `040000 tree ${tree}\tright\0`);
    level++;
  }
  trees.push({ oid: tree, level });
  const root = await git(repositoryPath, ['mktree', '-z'], {}, trees.map(node => `040000 tree ${node.oid}\tlevel-${node.level}\0`).join(''));
  const parents = previous ? ['-p', previous.commit] : [];
  for (const object of objects) if (object.kind === 'commit') parents.push('-p', object.oid);
  const commit = await git(repositoryPath, ['commit-tree', root, ...parents], {
    GIT_AUTHOR_NAME: 'GitSpace upload', GIT_AUTHOR_EMAIL: 'upload@gitspace.invalid',
    GIT_COMMITTER_NAME: 'GitSpace upload', GIT_COMMITTER_EMAIL: 'upload@gitspace.invalid',
  }, 'Temporary bounded checkpoint upload\n');
  return { commit, trees };
}

/** Pushes `commit` to `targetRef` through receive-pack-sized packs, never forced. Oversized graphs
 * travel as synthetic commits on an owned `refs/gitspace/upload/*` ref, which is always removed. */
async function publishBounded(repositoryPath: string, commit: string, objects: UploadObject[], targetRef: string, auth: { remote: string; environment: Record<string, string> }): Promise<void> {
  const push = (refspec: string) => git(repositoryPath, [...PACK_CONFIG, '-c', 'core.hooksPath=/dev/null', 'push', auth.remote, refspec], { ...auth.environment, GIT_LFS_SKIP_PUSH: '1' });
  if (await packFits(repositoryPath, commit)) {
    await push(`${commit}:${targetRef}`);
    return;
  }
  const temporaryRef = `refs/gitspace/upload/${crypto.randomUUID()}`;
  let previous: UploadState | undefined;
  let attemptedUpload = false;
  let failure: unknown;
  async function upload(batch: UploadObject[]): Promise<void> {
    const synthetic = await stagingCommit(repositoryPath, batch, previous);
    if (!await packFits(repositoryPath, synthetic.commit, previous?.commit)) {
      if (batch.length === 1) throw new ArtifactsGitError('checkpoint', `Git ${batch[0]?.kind} object ${batch[0]?.oid} (${batch[0]?.size} bytes) cannot fit the ${MAX_PACK_BYTES}-byte upload pack limit`);
      const middle = Math.floor(batch.length / 2);
      await upload(batch.slice(0, middle));
      await upload(batch.slice(middle));
      return;
    }
    attemptedUpload = true;
    await push(`${synthetic.commit}:${temporaryRef}`);
    previous = synthetic;
  }
  try {
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
    if (!await packFits(repositoryPath, commit, previous?.commit)) throw new ArtifactsGitError('checkpoint', 'Final checkpoint exceeds the bounded upload limit');
    await push(`${commit}:${targetRef}`);
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

  async publishCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string }): Promise<void> {
    this.checkRef(input.checkpointRef);
    // Resolve once: a concurrently advanced local ref must not change the object
    // graph after validation or make the final push publish unchecked bytes.
    const commit = await git(input.repositoryPath, ['rev-parse', '--verify', `${input.checkpointRef}^{commit}`]);
    const objects = await uploadInventory(input.repositoryPath, commit);
    await publishBounded(input.repositoryPath, commit, objects, input.checkpointRef, await this.auth(input.binding, 'write'));
  }

  /** Publishes a branch's full history through the same bounded packs as checkpoints.
   * Never moves an existing remote branch: equal is a no-op, any other commit is refused. */
  async publishBranch(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; branch: string; commit: string }): Promise<void> {
    if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('branch', 'Invalid branch commit');
    const ref = `refs/heads/${input.branch}`;
    await git(input.repositoryPath, ['check-ref-format', ref]);
    await git(input.repositoryPath, ['cat-file', '-e', `${input.commit}^{commit}`]);
    // Shallow parents can never reach the remote, so its connectivity check would refuse the branch.
    if (await git(input.repositoryPath, ['rev-parse', '--is-shallow-repository']) === 'true') throw new ArtifactsGitError('branch', 'A shallow clone cannot publish full branch history');
    const probe = await this.auth(input.binding, 'read');
    const advertised = await git(input.repositoryPath, ['ls-remote', '--refs', probe.remote, ref], probe.environment);
    // ls-remote patterns match ref suffixes; only the exact branch counts.
    const current = advertised.split('\n').map(line => line.split('\t')).find(([, name]) => name === ref)?.[0];
    if (current === input.commit) return;
    if (current !== undefined) throw new ArtifactsBranchDivergedError(input.branch, current, input.commit);
    const objects = await uploadInventory(input.repositoryPath, input.commit);
    // A branch created concurrently since the probe is only ever fast-forwarded.
    await publishBounded(input.repositoryPath, input.commit, objects, ref, await this.auth(input.binding, 'write'));
  }

  async fetchCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; commit?: string }): Promise<void> {
    this.checkRef(input.checkpointRef);
    if (input.commit !== undefined && !/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('checkpoint', 'Invalid immutable checkpoint commit');
    const auth = await this.auth(input.binding, 'read');
    await git(input.repositoryPath, ['fetch', '--no-write-fetch-head', auth.remote, `${input.commit ?? input.checkpointRef}:${input.checkpointRef}`], { ...auth.environment, GIT_LFS_SKIP_SMUDGE: '1' });
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
