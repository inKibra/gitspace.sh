import { z } from 'zod';
import { Result } from 'better-result';
import { ArtifactsSnapshotError, initializeArtifactsRepository, validateSnapshotPath, writeArtifactsSnapshot, type WriteSnapshotInput } from './artifacts-snapshot.js';
import { planSnapshotMerge, snapshotEntries } from './artifacts-merge.js';
import type { RuntimeGitCheckpoint } from './artifacts-snapshot.js';
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

  async info(repository: string) {
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try { return await repo.info(); }
    finally { await disposeArtifactsRepository(repo); }
  }

  async initialCheckpoint(repository: string, workspaceId: string, branch: string) {
    const commit = await this.resolveRef(repository, `refs/heads/${branch}`);
    const repo = await this.binding.get(repositorySchema.parse(repository));
    try {
      if (commit === null) {
        // A missing destination branch in a populated fork is not an empty import.
        // HEAD is represented by omitting ref, not by the literal string "HEAD".
        if ((await repo.log({ limit: 1 })).length > 0) return null;
        const initial = await initializeArtifactsRepository(repo, { workspaceId, branch });
        return { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: null, branch, indexCommit: initial.indexCommit, trackedWorktreeCommit: initial.trackedWorktreeCommit, worktreeCommit: initial.worktreeCommit, indexTree: initial.tree, worktreeTree: initial.tree };
      }
      const metadata = await repo.readCommit(commit);
      if (!metadata) throw new Error('Initial workspace commit is unavailable');
      return { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: commit, branch, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: metadata.treeHash, worktreeTree: metadata.treeHash };
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
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Project import requires a credential-free HTTPS origin');
    const name = artifactsProjectRepository(projectId);
    const existing = await this.find(name);
    if (existing) return this.info(name);
    const created = await this.binding.import({ source, target: { name } });
    // Initial tokens are not persisted or exposed: callers mint explicitly scoped leases.
    const repo = await this.binding.get(name);
    try {
      await repo.revokeToken(created.token);
      return await repo.info();
    } finally { await disposeArtifactsRepository(repo); }
  }

  async forkWorkspace(projectId: string, workspaceId: string) {
    const name = artifactsWorkspaceRepository(workspaceId);
    const existing = await this.find(name);
    if (existing) return this.info(name);
    const source = await this.binding.get(artifactsProjectRepository(projectId));
    try {
      const created = await source.fork(name, { defaultBranchOnly: false, readOnly: false });
      const repo = await this.binding.get(name);
      try {
        await repo.revokeToken(created.token);
        return await repo.info();
      } finally { await disposeArtifactsRepository(repo); }
    } finally { await disposeArtifactsRepository(source); }
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
    if (ref !== 'HEAD' && (branch.startsWith('refs/') || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) throw new Error('Unsupported committed source ref');
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
