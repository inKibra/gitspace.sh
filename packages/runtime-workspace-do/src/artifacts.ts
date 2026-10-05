import { z } from 'zod';
import { Result } from 'better-result';
import { ArtifactsSnapshotError, initializeArtifactsRepository, validateSnapshotPath, writeArtifactsSnapshot, type WriteSnapshotInput } from './artifacts-snapshot.js';
export { ArtifactsSnapshotError, type RuntimeGitCheckpoint, type SnapshotMutation, type WriteSnapshotInput } from './artifacts-snapshot.js';

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const repositorySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

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
    using repo = opened.value;
    return await writeArtifactsSnapshot(repo, input);
  }

  async info(repository: string) {
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return await repo.info();
  }

  async initialCheckpoint(repository: string, workspaceId: string, branch: string) {
    const commit = await this.resolveRef(repository, `refs/heads/${branch}`);
    using repo = await this.binding.get(repositorySchema.parse(repository));
    if (commit === null) {
      // A missing destination branch in a populated fork still needs the
      // machine's selected source materialized; it is not an empty import.
      if ((await repo.log({ ref: 'HEAD', limit: 1 })).length > 0) return null;
      const initial = await initializeArtifactsRepository(repo, { workspaceId, branch });
      return { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: null, branch, indexCommit: initial.indexCommit, trackedWorktreeCommit: initial.trackedWorktreeCommit, worktreeCommit: initial.worktreeCommit, indexTree: initial.tree, worktreeTree: initial.tree };
    }
    const metadata = await repo.readCommit(commit);
    if (!metadata) throw new Error('Initial workspace commit is unavailable');
    return { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: commit, branch, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: metadata.treeHash, worktreeTree: metadata.treeHash };
  }

  async ensureEmptyProject(projectId: string, branch: string) {
    const name = artifactsProjectRepository(projectId);
    // Written atomically with repository creation: only our scratch repositories
    // may resume a failed initial push. Never seed a pre-existing imported repo.
    const description = `GitSpace scratch project ${projectId} (${branch})`;
    const existing = await this.find(name);
    if (existing) {
      if (existing.description === description && await this.resolveRef(name, `refs/heads/${branch}`) === null) {
        using repo = await this.binding.get(name);
        await initializeArtifactsRepository(repo, { branch });
      }
      return this.info(name);
    }
    const created = await this.binding.create(name, { setDefaultBranch: branch, readOnly: false, description });
    using repo = await this.binding.get(name);
    await repo.revokeToken(created.token);
    await initializeArtifactsRepository(repo, { branch });
    return await repo.info();
  }
  async importProject(projectId: string, source: { url: string; branch?: string }) {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Project import requires a credential-free HTTPS origin');
    const name = artifactsProjectRepository(projectId);
    const existing = await this.find(name);
    if (existing) return this.info(name);
    const created = await this.binding.import({ source, target: { name } });
    // Initial tokens are not persisted or exposed: callers mint explicitly scoped leases.
    using repo = await this.binding.get(name);
    await repo.revokeToken(created.token);
    return await repo.info();
  }

  async forkWorkspace(projectId: string, workspaceId: string) {
    const name = artifactsWorkspaceRepository(workspaceId);
    const existing = await this.find(name);
    if (existing) return this.info(name);
    using source = await this.binding.get(artifactsProjectRepository(projectId));
    const created = await source.fork(name, { defaultBranchOnly: false, readOnly: false });
    using repo = await this.binding.get(name);
    await repo.revokeToken(created.token);
    return await repo.info();
  }

  async credentials(repository: string, scope: 'read' | 'write', ttlSeconds = 900) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw new Error('Invalid repository token lifetime');
    using repo = await this.binding.get(repositorySchema.parse(repository));
    const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttlSeconds)]);
    return { remote: info.remote, plaintext: token.plaintext, expiresAt: token.expiresAt };
  }

  async readFile(repository: string, commit: string, path: string): Promise<Blob | null> {
    commitSchema.parse(commit);
    validateSnapshotPath(path);
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return await repo.readFile({ ref: commit, path });
  }

  /** Raw Git blob bytes, including LFS pointers; never implies LFS payload hydration. */
  async readBlob(repository: string, oid: string): Promise<Blob | null> {
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return await repo.readBlob(commitSchema.parse(oid));
  }

  async readCommit(repository: string, commit: string) {
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return await repo.readCommit(commitSchema.parse(commit));
  }

  async resolveRef(repository: string, ref: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/u.test(ref)) return (await this.readCommit(repository, ref))?.hash ?? null;
    if (!/^refs\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.includes('..')) throw new Error('Invalid committed source ref');
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return (await repo.log({ ref, limit: 1 }))[0]?.hash ?? null;
  }

  async readTree(repository: string, tree: string) {
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return await repo.readTree(commitSchema.parse(tree));
  }

  async log(repository: string, commit: string, limit = 50) {
    using repo = await this.binding.get(repositorySchema.parse(repository));
    return await repo.log({ ref: commitSchema.parse(commit), limit });
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
