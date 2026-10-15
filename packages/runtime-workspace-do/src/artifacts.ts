import { z } from 'zod';
import { Result, TaggedError } from 'better-result';
import { ArtifactsSnapshotError, initializeArtifactsRepository, publishRef, publishSnapshotPack, readCommitPack, readAdvertisedRefs, readShallowCommits, validateSnapshotPath, writeArtifactsSnapshot, type WriteSnapshotInput } from './artifacts-snapshot.js';
import { planSnapshotMerge, snapshotEntries } from './artifacts-merge.js';
import type { GitCommitPack, RuntimeGitCheckpoint } from './artifacts-snapshot.js';
export { ArtifactsSnapshotError, type RuntimeGitCheckpoint, type SnapshotMutation, type WriteSnapshotInput } from './artifacts-snapshot.js';

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const repositorySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

/** Workerd handles own a disposable RPC stub; getPlatformProxy handles may not. */
export async function disposeArtifactsRepository(repo: ArtifactsRepo): Promise<void> {
  await repo[Symbol.dispose]?.();
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
    const opened = await Result.tryPromise({ try: () => this.binding.get(repositorySchema.parse(input.repository)), catch: error => new ArtifactsSnapshotError({ operation: 'mergeSnapshot', certainty: 'not-published', message: String(error) }) });
    if (opened.isErr()) return opened;
    const repo = opened.value;
    try {
      const plan = await Result.tryPromise({ try: () => planSnapshotMerge(repo, input.base, input.previous, input.machine, input), catch: error => new ArtifactsSnapshotError({ operation: 'mergeSnapshot', certainty: 'not-published', message: String(error) }) });
      if (plan.isErr()) return plan;
      return await writeArtifactsSnapshot(repo, { ...input, ...plan.value });
    } finally { await disposeArtifactsRepository(repo); }
  }

  async listSnapshotPaths(repository: string, tree: string): Promise<string[]> {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return [...(await snapshotEntries(repo, tree)).keys()].sort(); }
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
      try { await publishRef({ remote: info.remote, token: token.plaintext, ref: checkpointRef, previous: null, commit: target }); }
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
  async importProject(projectId: string, source: { url: string; branch?: string }) {
    const name = artifactsProjectRepository(projectId);
    const existing = await this.find(name);
    if (existing) {
      // A machine seed creates the repository before pushing history: until the base
      // branch exists it is not an import a workspace may fork. A resolvable default
      // branch keeps a completed import usable after the project's base branch changes.
      const base = source.branch === undefined || source.branch === 'HEAD' ? 'HEAD' : `refs/heads/${source.branch}`;
      // An explicitly migrated unborn base is complete without a branch, not a pending machine seed.
      const migratedUnborn = source.branch !== undefined && existing.description?.startsWith(`GitSpace legacy-migrated unborn project ${projectId} (${source.branch}) from sha256:`);
      if (!migratedUnborn && await this.resolveRef(name, base) === null && (base === 'HEAD' || await this.resolveRef(name, 'HEAD') === null)) throw new ProjectImportRequiresMachineError('pending');
      return this.info(name);
    }
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Project import requires a credential-free HTTPS origin');
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
      try { await publishRef({ remote: info.remote, token: token.plaintext, ref: `refs/heads/${branch}`, previous: current, commit }); }
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
      const token = await target.createToken('write', 60);
      try {
        if (await target.readCommit(commit)) {
          await publishRef({ remote: info.remote, token: token.plaintext, ref, previous, commit });
        } else {
          const origin = await this.binding.get(repositorySchema.parse(source));
          try {
            if (!await origin.readCommit(commit)) throw new Error(`Commit ${commit} is not in repository ${source}`);
            const sourceInfo = await origin.info();
            const readToken = await origin.createToken('read', 60);
            try {
              const haves = (await target.log({ ...(previous === null ? {} : { ref: previous }), limit: 32 })).map(entry => entry.hash);
              const shallow = await readShallowCommits({ remote: info.remote, token: token.plaintext });
              const transfer = await readCommitPack({ remote: sourceInfo.remote, token: readToken.plaintext, commit, haves, shallow });
              await publishSnapshotPack({ remote: info.remote, token: token.plaintext, ref, previous: previous ?? '0'.repeat(40), commit, ...transfer });
            } finally { await origin.revokeToken(readToken.id); }
          } finally { await disposeArtifactsRepository(origin); }
        }
      } finally { await target.revokeToken(token.id); }
    } finally { await disposeArtifactsRepository(target); }
  }

  /** Fetch a public origin ref omitted by the initial import. Keep its objects and exact ref in
   * Artifacts so creation retries no longer depend on the origin. Origin redirects are refused. */
  async importSourceRef(projectId: string, url: string, ref: string): Promise<string> {
    const origin = new URL(url);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('Source import requires a credential-free HTTPS repository root without redirects');
    const branch = ref.startsWith('refs/heads/') && isSupportedBranchName(ref.slice('refs/heads/'.length));
    if (!branch && !/^refs\/(?:tags\/.+|pull\/[1-9][0-9]*\/head)$/u.test(ref)) throw new Error('Unsupported source ref');
    const repository = artifactsProjectRepository(projectId);
    const existing = branch ? await this.resolveRef(repository, ref) : await this.resolveAdvertisedRef(repository, ref);
    if (existing !== null) return existing;
    const advertised = await readAdvertisedRefs({ remote: origin.href, token: null, refPrefix: ref });
    const object = advertised.get(ref);
    if (!object) throw new Error(`Source ref ${ref} is not advertised by the public origin`);
    const repo = await this.binding.get(repository);
    try {
      // Qualify negotiation haves with the project's shallow boundaries: a machine seed
      // may deliberately omit old history while retaining the original base commit ID.
      const haves = (await repo.log({ limit: 32 })).map(entry => entry.hash);
      const info = await repo.info();
      const readToken = await repo.createToken('read', 60);
      let transfer: GitCommitPack;
      try {
        const shallow = await readShallowCommits({ remote: info.remote, token: readToken.plaintext });
        transfer = await readCommitPack({ remote: origin.href, token: null, commit: object, haves, shallow });
      } finally { await repo.revokeToken(readToken.id); }
      const token = await repo.createToken('write', 60);
      try {
        await publishSnapshotPack({ remote: info.remote, token: token.plaintext, ref, previous: '0'.repeat(40), commit: object, ...transfer });
      } finally { await repo.revokeToken(token.id); }
    } finally { await disposeArtifactsRepository(repo); }
    const commit = branch ? await this.resolveRef(repository, ref) : await this.resolveAdvertisedRef(repository, ref);
    if (!commit) throw new Error(`Imported source ref ${ref} does not resolve to a commit`);
    return commit;
  }

  /** Resolve imported tags and PR heads from advertised refs, peeling annotated tags through the binding. */
  async resolveAdvertisedRef(repository: string, ref: string): Promise<string | null> {
    if (!/^refs\/(?:tags\/.+|pull\/[1-9][0-9]*\/head)$/u.test(ref)) throw new Error('Unsupported advertised ref');
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      const [info, token] = await Promise.all([repo.info(), repo.createToken('read', 60)]);
      try {
        const refs = await readAdvertisedRefs({ remote: info.remote, token: token.plaintext });
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
