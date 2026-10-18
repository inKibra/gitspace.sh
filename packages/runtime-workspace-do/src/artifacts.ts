import { z } from 'zod';
import { Result, TaggedError } from 'better-result';
import { ArtifactsSnapshotError, initializeArtifactsRepository, publishRef, readAdvertisedRefs, readShallowCommits, transferCommit, validateSnapshotPath, writeArtifactsSnapshot, type GitHttpAuth, type WriteSnapshotInput } from './artifacts-snapshot.js';
import { planSnapshotMerge, snapshotEntries } from './artifacts-merge.js';
import type { RuntimeGitCheckpoint } from './artifacts-snapshot.js';
export { ArtifactsSnapshotError, type RuntimeGitCheckpoint, type SnapshotMutation, type WriteSnapshotInput } from './artifacts-snapshot.js';

/** How an origin is read: null for a public origin read without credentials, or the credentials of a covered one,
 * requested only once the origin is actually contacted (issuing them costs a request of their own). */
export type OriginCredentials = (() => Promise<GitHttpAuth>) | null;
/** Artifacts write leases outlive a streamed transfer's request. */
const TRANSFER_LEASE_SECONDS = 900;

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const repositorySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

/** Workerd handles own a disposable RPC stub; getPlatformProxy handles may not. */
export async function disposeArtifactsRepository(repo: ArtifactsRepo): Promise<void> {
  await repo[Symbol.dispose]?.();
}

/** Reads of one repository: at most this many in flight across every walk of a merge or listing. */
const REPOSITORY_READS = 16;
/** A merge of a large repository makes thousands of reads; under that load Artifacts fails some with "An internal
 * error occurred.", and one such failure otherwise failed the whole publication on every retry. Each read is tried
 * this many times, waiting 250 ms, 0.5 s, 1 s and 2 s between tries, before its error stands. */
const READ_ATTEMPTS = 5;
type RepositoryReads = Pick<ArtifactsRepo, 'readTree' | 'readBlob' | 'readCommit' | 'info' | 'createToken' | 'revokeToken'>;
/** The repository handle as merges and listings use it: reads paced and retried, each tree read once (the versions a
 * merge compares share most of their directories), writes passed through. */
function pacedRepository(repo: ArtifactsRepo): RepositoryReads {
  const trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const read = async <T>(operation: string, oid: string, call: () => Promise<T>): Promise<T> => {
    if (active >= REPOSITORY_READS) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try {
      for (let attempt = 1; ; attempt++) {
        try { return await call(); }
        catch (error) {
          // The provider's message names neither the call nor the object.
          if (attempt >= READ_ATTEMPTS) throw new Error(`${operation} ${oid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
      }
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  return {
    readTree: oid => {
      let entries = trees.get(oid);
      if (!entries) {
        entries = read('readTree', oid, () => repo.readTree(oid));
        trees.set(oid, entries);
        void entries.catch(() => trees.delete(oid));
      }
      return entries;
    },
    // A blob's bytes arrive when it is read, not when the call returns: they are read here, inside the paced and
    // retried call, so a failure reading them is retried and names the blob.
    readBlob: oid => read('readBlob', oid, async () => {
      const blob = await repo.readBlob(oid);
      return blob && new Blob([await blob.arrayBuffer()]);
    }),
    readCommit: oid => read('readCommit', oid, () => repo.readCommit(oid)),
    info: () => repo.info(),
    createToken: (scope, ttl) => repo.createToken(scope, ttl),
    revokeToken: id => repo.revokeToken(id),
  };
}

/** Deterministic identities make interrupted create/import/fork operations recoverable. */
export function artifactsProjectRepository(projectId: string): string {
  return repositorySchema.parse(`project-${projectId}`);
}
export function artifactsWorkspaceRepository(workspaceId: string): string {
  return repositorySchema.parse(`workspace-${workspaceId}`);
}

export type ProjectImportRequiresMachineReason = 'private' | 'too-large' | 'pending';
const PROJECT_IMPORT_REQUIRES_MACHINE_MESSAGES: Record<ProjectImportRequiresMachineReason, string> = {
  private: "This is a private repository, so GitSpace Cloud can't import it. Create a workspace in this project with a machine connected; the machine does the initial import.",
  'too-large': "This repository is larger than Cloudflare Artifacts' 40 MB import limit. Create a workspace in this project with a machine connected; the machine does the initial import.",
  pending: "The initial import from a machine hasn't finished yet. Keep that machine online and try again shortly.",
};
/** Artifacts cannot import this origin itself: a connected machine seeds the project repository. */
export class ProjectImportRequiresMachineError extends TaggedError('ProjectImportRequiresMachineError')<{ reason: ProjectImportRequiresMachineReason; message: string }> {
  constructor(reason: ProjectImportRequiresMachineReason) {
    super({ reason, message: PROJECT_IMPORT_REQUIRES_MACHINE_MESSAGES[reason] });
  }
}
const ArtifactsImportRefusalSchema = z.object({ name: z.literal('ArtifactsError'), code: z.enum(['REMOTE_AUTH_REQUIRED', 'MEMORY_LIMIT']) });
const IMPORT_REFUSAL_REASONS: Record<z.infer<typeof ArtifactsImportRefusalSchema>['code'], ProjectImportRequiresMachineReason> = { REMOTE_AUTH_REQUIRED: 'private', MEMORY_LIMIT: 'too-large' };
const ArtifactsAlreadyExistsSchema = z.object({ name: z.literal('ArtifactsError'), code: z.literal('ALREADY_EXISTS') });
const ArtifactsNotFoundSchema = z.object({ name: z.literal('ArtifactsError'), code: z.literal('NOT_FOUND') });

/** The branch names Artifacts resolves: Git's ref rules over letters, digits, `.`, `_`, `-` and `/`. */
export function isSupportedBranchName(branch: string): boolean {
  return branch !== 'HEAD' && !branch.startsWith('refs/') && /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u.test(branch) && !branch.includes('..') && !branch.includes('//')
    && !branch.endsWith('/') && !branch.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));
}

/** Object reads through one repository handle, opened by the first read; `close` releases it. */
export interface ArtifactsRepositoryReader {
  readTree(oid: string): Promise<ArtifactsTreeEntry[] | null>;
  readBlob(oid: string): Promise<Blob | null>;
  readCommit(oid: string): Promise<ArtifactsCommitMetadata | null>;
  log(commit: string, limit: number): Promise<ArtifactsCommitMetadata[]>;
  close(): Promise<void>;
}

/** The binding is supplied by the tenant Worker, never an account control-plane token. */
export class ArtifactsCodeStore {
  constructor(private readonly binding: Artifacts) {}

  async writeSnapshot(input: WriteSnapshotInput) {
    const opened = await Result.tryPromise({
      try: () => this.binding.get(repositorySchema.parse(input.repository)),
      catch: error => new ArtifactsSnapshotError({ operation: 'openRepository', certainty: 'not-published', message: error instanceof Error ? error.message : String(error) }),
    });
    if (opened.isErr()) return opened;
    const repo = opened.value;
    try { return await writeArtifactsSnapshot(repo, input); }
    finally { await disposeArtifactsRepository(repo); }
  }

  async mergeSnapshot(input: { repository: string; workspaceId: string; previous: RuntimeGitCheckpoint; base: RuntimeGitCheckpoint; machine: RuntimeGitCheckpoint; forcePublication?: boolean }) {
    const opened = await Result.tryPromise({ try: () => this.binding.get(repositorySchema.parse(input.repository)), catch: error => new ArtifactsSnapshotError({ operation: 'openRepository', certainty: 'not-published', message: String(error) }) });
    if (opened.isErr()) return opened;
    const repo = opened.value;
    try {
      const paced = pacedRepository(repo);
      const plan = await Result.tryPromise({ try: () => planSnapshotMerge(paced, input.base, input.previous, input.machine, input), catch: error => new ArtifactsSnapshotError({ operation: 'planSnapshotMerge', certainty: 'not-published', message: String(error) }) });
      if (plan.isErr()) return plan;
      return await writeArtifactsSnapshot(paced, { ...input, ...plan.value });
    } finally { await disposeArtifactsRepository(repo); }
  }

  async listSnapshotPaths(repository: string, tree: string): Promise<string[]> {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return [...(await snapshotEntries(pacedRepository(repo), tree)).keys()].sort(); }
    finally { await disposeArtifactsRepository(repo); }
  }

  /** Inventories of several trees through one repository handle; subtrees they share are read once. */
  async listSnapshotInventories(repository: string, trees: readonly string[]) {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      const read = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
      const reader = {
        readTree(oid: string) {
          let entries = read.get(oid);
          if (!entries) { entries = repo.readTree(commitSchema.parse(oid)); read.set(oid, entries); }
          return entries;
        },
      };
      return await Promise.all(trees.map(tree => snapshotEntries(reader, tree)));
    } finally { await disposeArtifactsRepository(repo); }
  }

  /** A request's many object reads share one handle instead of opening one per object. */
  reader(repository: string): ArtifactsRepositoryReader {
    const name = repositorySchema.parse(repository);
    let opened: Promise<ArtifactsRepo> | null = null;
    const repo = () => opened ??= this.binding.get(name);
    return {
      readTree: async oid => (await repo()).readTree(commitSchema.parse(oid)),
      readBlob: async oid => (await repo()).readBlob(commitSchema.parse(oid)),
      readCommit: async oid => (await repo()).readCommit(commitSchema.parse(oid)),
      log: async (commit, limit) => (await repo()).log({ ref: commitSchema.parse(commit), limit }),
      close: async () => {
        const handle = await opened?.catch(() => null);
        if (handle) await disposeArtifactsRepository(handle);
      },
    };
  }

  async info(repository: string) {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.info(); }
    finally { await disposeArtifactsRepository(repo); }
  }

  /** The first checkpoint of a workspace: its branch tip, or `source`, another workspace's checkpoint (uncommitted
   * edits included) whose objects its fork holds. */
  async initialCheckpoint(repository: string, workspaceId: string, branch: string, source: RuntimeGitCheckpoint | null = null) {
    const commit = await this.resolveRef(repository, `refs/heads/${branch}`);
    const repo = await this.binding.get(repositorySchema.parse(repository));
    const checkpointRef = `refs/gitspace/spaces/${workspaceId}/checkpoints`;
    // Creation is replayable at the same tip (a concurrent first read creates it too), but never rewinds an advanced ref.
    const createCheckpointRef = async (target: string) => {
      const info = await repo.info();
      const token = await repo.createToken('write', 60);
      try { await publishRef({ remote: info.remote, auth: { kind: 'bearer', token: token.plaintext }, ref: checkpointRef, previous: null, commit: target }); }
      catch (error) { if (await this.resolveRef(repository, checkpointRef) !== target) throw error; }
      finally { await repo.revokeToken(token.id); }
    };
    try {
      if (source) {
        if (!await repo.readCommit(source.worktreeCommit)) throw new Error(`The source workspace's working copy ${source.worktreeCommit} is not in ${repository}`);
        await createCheckpointRef(source.worktreeCommit);
        return { ...source, checkpointRef, branch };
      }
      if (commit === null) {
        // A missing destination branch in a populated fork is not an empty import.
        // HEAD is represented by omitting ref, not by the literal string "HEAD".
        if ((await repo.log({ limit: 1 })).length > 0) return null;
        const initial = await initializeArtifactsRepository(repo, { workspaceId, branch });
        return { checkpointRef, headCommit: null, branch, indexCommit: initial.indexCommit, trackedWorktreeCommit: initial.trackedWorktreeCommit, worktreeCommit: initial.worktreeCommit, indexTree: initial.tree, worktreeTree: initial.tree };
      }
      const metadata = await repo.readCommit(commit);
      if (!metadata) throw new Error('Initial workspace commit is unavailable');
      // A fork holds the source objects and branches, not this workspace's checkpoint
      // ref. Publish that ref before the runtime can persist or hand out its checkpoint.
      await createCheckpointRef(commit);
      return { checkpointRef, headCommit: commit, branch, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: metadata.treeHash, worktreeTree: metadata.treeHash };
    } finally { await disposeArtifactsRepository(repo); }
  }

  async ensureEmptyProject(projectId: string, branch: string) {
    const name = artifactsProjectRepository(projectId);
    // Written atomically with repository creation: only our scratch repositories
    // may resume a failed initial push. Never seed a pre-existing imported repo.
    const description = `GitSpace scratch project ${projectId} (${branch})`;
    const existing = await this.find(name);
    if (existing) {
      if (existing.description === description && await this.resolveRef(name, `refs/heads/${branch}`) === null) {
        const repo = await this.binding.get(name);
        try {
          if ((await repo.log({ limit: 1 })).length === 0) await initializeArtifactsRepository(repo, { branch });
        }
        finally { await disposeArtifactsRepository(repo); }
      }
      return this.info(name);
    }
    const created = await this.binding.create(name, { setDefaultBranch: branch, readOnly: false, description });
    const repo = await this.binding.get(name);
    try {
      await repo.revokeToken(created.token);
      await initializeArtifactsRepository(repo, { branch });
      return await repo.info();
    } finally { await disposeArtifactsRepository(repo); }
  }
  /** The project repository with its origin's history. Artifacts' native import reads a public origin and cannot send
   * credentials, so a covered origin's repository is created empty and its base branch streamed in over authenticated
   * smart HTTP; an empty repository whose branch never landed (an interrupted import) is filled the same way. */
  async importProject(projectId: string, source: { url: string; branch?: string }, credentials: OriginCredentials) {
    const name = artifactsProjectRepository(projectId);
    const existing = await this.find(name);
    if (existing) {
      // A machine seed creates the repository before pushing history: until the base
      // branch exists it is not an import a workspace may fork. A resolvable default
      // branch keeps a completed import usable after the project's base branch changes.
      const base = source.branch === undefined || source.branch === 'HEAD' ? 'HEAD' : `refs/heads/${source.branch}`;
      // An explicitly migrated unborn base is complete without a branch, not a pending machine seed.
      const migratedUnborn = source.branch !== undefined && existing.description?.startsWith(`GitSpace legacy-migrated unborn project ${projectId} (${source.branch}) from sha256:`);
      if (!migratedUnborn && await this.resolveRef(name, base) === null && (base === 'HEAD' || await this.resolveRef(name, 'HEAD') === null)) {
        if (credentials === null) throw new ProjectImportRequiresMachineError('pending');
        await this.importCoveredProject(projectId, source, credentials, true);
      }
      return this.info(name);
    }
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Project import requires a credential-free HTTPS origin');
    if (credentials !== null) {
      await this.importCoveredProject(projectId, source, credentials, false);
      return this.info(name);
    }
    const created = await this.binding.import({ source, target: { name } }).catch((error: unknown) => {
      const refusal = ArtifactsImportRefusalSchema.safeParse(error);
      throw refusal.success ? new ProjectImportRequiresMachineError(IMPORT_REFUSAL_REASONS[refusal.data.code]) : error;
    });
    // Initial tokens are not persisted or exposed: callers mint explicitly scoped leases.
    const repo = await this.binding.get(name);
    try {
      await repo.revokeToken(created.token);
      return await repo.info();
    } finally { await disposeArtifactsRepository(repo); }
  }

  /** A covered origin's base branch streamed into the project repository, created first unless it `exists`. The
   * branch is created only from absent, so an interrupted import resumes and a concurrent one cannot overwrite it. */
  private async importCoveredProject(projectId: string, source: { url: string; branch?: string }, credentials: () => Promise<GitHttpAuth>, exists: boolean) {
    if (source.branch === undefined || !isSupportedBranchName(source.branch)) throw new Error('A covered origin is imported by its base branch name');
    const name = artifactsProjectRepository(projectId);
    const ref = `refs/heads/${source.branch}`;
    const auth = await credentials();
    const commit = (await readAdvertisedRefs({ remote: source.url, auth, refPrefix: ref })).get(ref);
    if (!commit) throw new Error(`The origin has no branch ${source.branch}`);
    if (!exists) {
      const created = await this.binding.create(name, { setDefaultBranch: source.branch, readOnly: false, description: `GitSpace authenticated import of project ${projectId} (${source.branch})` })
        .catch((error: unknown) => {
          // A concurrent first open created it; the branch transfer below is replayable.
          if (ArtifactsAlreadyExistsSchema.safeParse(error).success) return null;
          throw error;
        });
      if (created) {
        const repo = await this.binding.get(name);
        try { await repo.revokeToken(created.token); }
        finally { await disposeArtifactsRepository(repo); }
      }
    }
    await this.fetchIntoRepository(name, { remote: source.url, auth }, ref, commit, null);
  }

  /** Streams `commit` from an origin into a repository ref, negotiating with the repository's recent history qualified
   * by its shallow boundaries: a machine seed may deliberately omit old history while retaining the original base
   * commit ID. The ref moves only from `previous` (null: absent), or from whatever it holds for `replace`. */
  private async fetchIntoRepository(repository: string, origin: { remote: string; auth: GitHttpAuth | null }, ref: string, commit: string, previous: string | null | 'replace'): Promise<void> {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      const haves = (await repo.log({ limit: 32 })).map(entry => entry.hash);
      const [info, token] = await Promise.all([repo.info(), repo.createToken('write', TRANSFER_LEASE_SECONDS)]);
      const auth: GitHttpAuth = { kind: 'bearer', token: token.plaintext };
      try {
        const shallow = await readShallowCommits({ remote: info.remote, auth });
        const from = previous === 'replace' ? (await readAdvertisedRefs({ remote: info.remote, auth, refPrefix: ref })).get(ref) ?? null : previous;
        await transferCommit({ source: origin, destination: { remote: info.remote, auth }, ref, previous: from, commit, haves, shallow });
      } finally { await repo.revokeToken(token.id); }
    } finally { await disposeArtifactsRepository(repo); }
  }

  /** The empty repository a connected machine seeds with the audited base branch graph.
   * Never imports or commits: importProject reports 'pending' until the branch exists. */
  async ensureMachineSeedTarget(projectId: string, branch: string) {
    const name = artifactsProjectRepository(projectId);
    if (await this.find(name)) return this.info(name);
    // An unresolved gitspace-source branch is recorded as 'HEAD', never a branch name.
    const created = await this.binding.create(name, { ...(branch === 'HEAD' ? {} : { setDefaultBranch: branch }), readOnly: false, description: `GitSpace machine-seeded project ${projectId} (${branch})` })
      .catch((error: unknown) => {
        // A concurrent seed or cloud import created it first; it is not ours to initialize.
        if (ArtifactsAlreadyExistsSchema.safeParse(error).success) return null;
        throw error;
      });
    if (created === null) return this.info(name);
    const repo = await this.binding.get(name);
    try {
      await repo.revokeToken(created.token);
      return await repo.info();
    } finally { await disposeArtifactsRepository(repo); }
  }

  /** Seed a migrated base's canonical source from its committed HEAD, never its index/worktree.
   * Fork inside Artifacts: a valid graph can exceed the Worker's bounded pack buffer.
   * A creation marker makes interrupted seeds resumable without taking over unrelated repositories. */
  async seedLegacyProjectSource(input: { projectId: string; sourceRepository: string; branch: string; headCommit: string | null; sourceDigest: string }): Promise<void> {
    if (!isSupportedBranchName(input.branch)) throw new Error('Unsupported migrated project branch');
    const name = artifactsProjectRepository(input.projectId);
    const description = `GitSpace legacy-migrated ${input.headCommit === null ? 'unborn ' : ''}project ${input.projectId} (${input.branch}) from ${input.sourceDigest}`;
    let existing = await this.find(name);
    if (!existing) {
      let created: ArtifactsCreateRepoResult | null = null;
      try {
        if (input.headCommit === null) {
          created = await this.binding.create(name, { setDefaultBranch: input.branch, readOnly: false, description });
        } else {
          const source = await this.binding.get(repositorySchema.parse(input.sourceRepository));
          try {
            if ((await source.info()).defaultBranch !== input.branch) throw new Error('Migrated base repository has a different default branch');
            created = await source.fork(name, { defaultBranchOnly: false, readOnly: false, description });
          } finally { await disposeArtifactsRepository(source); }
        }
      } catch (error) {
        if (!ArtifactsAlreadyExistsSchema.safeParse(error).success) throw error;
      }
      const repo = await this.binding.get(name);
      try {
        if (created) await repo.revokeToken(created.token);
        existing = await repo.info();
      } finally { await disposeArtifactsRepository(repo); }
    }
    const ref = `refs/heads/${input.branch}`;
    const current = await this.resolveRef(name, ref);
    if (input.headCommit !== null && current === input.headCommit) return;
    if (current !== null || existing.description !== description || await this.resolveRef(name, 'HEAD') !== null) throw new Error('Destination project repository differs from the closed legacy base; refusing to replace its source');
    if (input.headCommit !== null) await this.copyCommit(input.sourceRepository, name, ref, input.headCommit, null);
  }

  /** A workspace forked from another workspace starts from that workspace's repository, which holds commits the project never received. */
  async forkWorkspace(projectId: string, workspaceId: string, source = artifactsProjectRepository(projectId)) {
    const name = artifactsWorkspaceRepository(workspaceId);
    const existing = await this.find(name);
    if (existing) return this.info(name);
    const sourceRepository = await this.binding.get(repositorySchema.parse(source));
    try {
      const created = await sourceRepository.fork(name, { defaultBranchOnly: false, readOnly: false });
      const repo = await this.binding.get(name);
      try {
        await repo.revokeToken(created.token);
        return await repo.info();
      } finally { await disposeArtifactsRepository(repo); }
    } finally { await disposeArtifactsRepository(sourceRepository); }
  }

  /** Points a branch at a commit the repository already holds; a no-op once it does. An existing branch moves only from the tip read here. */
  async setBranch(repository: string, branch: string, commit: string): Promise<void> {
    const current = await this.resolveRef(repository, `refs/heads/${branch}`);
    if (current === commitSchema.parse(commit)) return;
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      if (!await repo.readCommit(commit)) throw new Error(`Commit ${commit} is not in repository ${repository}`);
      const [info, token] = await Promise.all([repo.info(), repo.createToken('write', 60)]);
      try { await publishRef({ remote: info.remote, auth: { kind: 'bearer', token: token.plaintext }, ref: `refs/heads/${branch}`, previous: current, commit }); }
      finally { await repo.revokeToken(token.id); }
    } finally { await disposeArtifactsRepository(repo); }
  }

  /** Copy a commit absent from a fork, then CAS its destination ref. Existing objects need no download. */
  async copyCommit(source: string, destination: string, ref: string, commit: string, previous: string | null): Promise<void> {
    commitSchema.parse(commit);
    if (!/^refs\/(?:heads\/|gitspace\/)/u.test(ref)) throw new Error('Unsupported destination ref');
    const target = await this.binding.get(repositorySchema.parse(destination));
    try {
      const info = await target.info();
      const token = await target.createToken('write', TRANSFER_LEASE_SECONDS);
      const auth: GitHttpAuth = { kind: 'bearer', token: token.plaintext };
      try {
        if (await target.readCommit(commit)) {
          await publishRef({ remote: info.remote, auth, ref, previous, commit });
        } else {
          const origin = await this.binding.get(repositorySchema.parse(source));
          try {
            if (!await origin.readCommit(commit)) throw new Error(`Commit ${commit} is not in repository ${source}`);
            const sourceInfo = await origin.info();
            const readToken = await origin.createToken('read', TRANSFER_LEASE_SECONDS);
            try {
              const haves = (await target.log({ ...(previous === null ? {} : { ref: previous }), limit: 32 })).map(entry => entry.hash);
              const shallow = await readShallowCommits({ remote: info.remote, auth });
              await transferCommit({ source: { remote: sourceInfo.remote, auth: { kind: 'bearer', token: readToken.plaintext } }, destination: { remote: info.remote, auth }, ref, previous, commit, haves, shallow });
            } finally { await origin.revokeToken(readToken.id); }
          } finally { await disposeArtifactsRepository(origin); }
        }
      } finally { await target.revokeToken(token.id); }
    } finally { await disposeArtifactsRepository(target); }
  }

  /** Fetch an origin ref omitted by the initial import. Keep its objects and exact ref in Artifacts so creation retries
   * no longer depend on the origin. Origin redirects are refused. */
  async importSourceRef(projectId: string, url: string, ref: string, credentials: OriginCredentials): Promise<string> {
    const origin = new URL(url);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('Source import requires a credential-free HTTPS repository root without redirects');
    const branch = ref.startsWith('refs/heads/') && isSupportedBranchName(ref.slice('refs/heads/'.length));
    if (!branch && !/^refs\/(?:tags\/.+|pull\/[1-9][0-9]*\/head)$/u.test(ref)) throw new Error('Unsupported source ref');
    const repository = artifactsProjectRepository(projectId);
    const existing = branch ? await this.resolveRef(repository, ref) : await this.resolveAdvertisedRef(repository, ref);
    if (existing !== null) return existing;
    const auth = credentials === null ? null : await credentials();
    const advertised = await readAdvertisedRefs({ remote: origin.href, auth, refPrefix: ref });
    const object = advertised.get(ref);
    if (!object) throw new Error(`Source ref ${ref} is not advertised by the ${auth === null ? 'public ' : ''}origin`);
    await this.fetchIntoRepository(repository, { remote: origin.href, auth }, ref, object, null);
    const commit = branch ? await this.resolveRef(repository, ref) : await this.resolveAdvertisedRef(repository, ref);
    if (!commit) throw new Error(`Imported source ref ${ref} does not resolve to a commit`);
    return commit;
  }

  /** The origin's current head of `branch`, with its objects in the project repository. Fetched objects are held by
   * `refs/gitspace/origin/heads/<branch>`, so the project's own branch never moves here: the caller decides whether
   * the new head fast-forwards it. */
  async fetchOriginBranch(projectId: string, url: string, branch: string, credentials: OriginCredentials): Promise<string> {
    const origin = new URL(url);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('Origin reads require a credential-free HTTPS repository root without redirects');
    if (!isSupportedBranchName(branch)) throw new Error('Unsupported origin branch');
    const repository = artifactsProjectRepository(projectId);
    const ref = `refs/heads/${branch}`;
    const auth = credentials === null ? null : await credentials();
    const head = (await readAdvertisedRefs({ remote: origin.href, auth, refPrefix: ref })).get(ref);
    if (!head) throw new Error(`The origin has no branch ${branch}`);
    if (await this.readCommit(repository, head) === null) await this.fetchIntoRepository(repository, { remote: origin.href, auth }, `refs/gitspace/origin/heads/${branch}`, head, 'replace');
    return head;
  }

  /** Resolve imported tags and PR heads from advertised refs, peeling annotated tags through the binding. */
  async resolveAdvertisedRef(repository: string, ref: string): Promise<string | null> {
    if (!/^refs\/(?:tags\/.+|pull\/[1-9][0-9]*\/head)$/u.test(ref)) throw new Error('Unsupported advertised ref');
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      const [info, token] = await Promise.all([repo.info(), repo.createToken('read', 60)]);
      try {
        const refs = await readAdvertisedRefs({ remote: info.remote, auth: { kind: 'bearer', token: token.plaintext } });
        const peeled = refs.get(`${ref}^{}`);
        if (peeled) return peeled;
        const value = refs.get(ref);
        if (!value) return null;
        if (ref.startsWith('refs/tags/')) {
          const resolved = (await repo.log({ ref, limit: 1 }))[0];
          if (resolved) return resolved.hash;
        }
        return (await repo.readCommit(value))?.hash ?? null;
      } finally { await repo.revokeToken(token.id); }
    } finally { await disposeArtifactsRepository(repo); }
  }

  /** Permanent deletion; an absent repository is already deleted. */
  async deleteRepository(repository: string): Promise<boolean> {
    return this.binding.delete(repositorySchema.parse(repository)).catch((error: unknown) => {
      if (ArtifactsNotFoundSchema.safeParse(error).success) return false;
      throw error;
    });
  }

  async credentials(repository: string, scope: 'read' | 'write', ttlSeconds = 900) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw new Error('Invalid repository token lifetime');
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttlSeconds)]);
      return { remote: info.remote, plaintext: token.plaintext, expiresAt: token.expiresAt };
    } finally { await disposeArtifactsRepository(repo); }
  }

  async readFile(repository: string, commit: string, path: string): Promise<Blob | null> {
    commitSchema.parse(commit);
    validateSnapshotPath(path);
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.readFile({ ref: commit, path }); }
    finally { await disposeArtifactsRepository(repo); }
  }

  /** Raw Git blob bytes, including LFS pointers; never implies LFS payload hydration. */
  async readBlob(repository: string, oid: string): Promise<Blob | null> {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.readBlob(commitSchema.parse(oid)); }
    finally { await disposeArtifactsRepository(repo); }
  }

  async readCommit(repository: string, commit: string) {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.readCommit(commitSchema.parse(commit)); }
    finally { await disposeArtifactsRepository(repo); }
  }

  /** Only branch names, refs/heads/<branch>, HEAD and full commit IDs are supported.
   * Checkpoint refs are Git transport addresses; resolve their stored DO commit instead. */
  async resolveRef(repository: string, ref: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/u.test(ref)) return (await this.readCommit(repository, ref))?.hash ?? null;
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    if (ref !== 'HEAD' && !isSupportedBranchName(branch)) throw new Error('Unsupported committed source ref');
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return (await repo.log(ref === 'HEAD' ? { limit: 1 } : { ref: branch, limit: 1 }))[0]?.hash ?? null; }
    finally { await disposeArtifactsRepository(repo); }
  }

  async readTree(repository: string, tree: string) {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.readTree(commitSchema.parse(tree)); }
    finally { await disposeArtifactsRepository(repo); }
  }

  async log(repository: string, commit: string, limit = 50) {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.log({ ref: commitSchema.parse(commit), limit }); }
    finally { await disposeArtifactsRepository(repo); }
  }

  private async find(name: string) {
    let cursor: string | undefined;
    do {
      const page = await this.binding.list({ limit: 200, ...(cursor ? { cursor } : {}) });
      const existing = page.repos.find(repo => repo.name === name);
      if (existing) return existing;
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return null;
  }
}
