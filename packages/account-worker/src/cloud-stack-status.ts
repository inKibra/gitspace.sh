import type { StackStatus } from '@gitspace/protocol';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';

/** Commits examined per comparison; beyond it the cloud fails rather than report a wrong position. */
const STACK_WALK_LIMIT = 5_000;
/** First-parent ancestors fetched with each commit read, so linear history costs one read per page. */
const HISTORY_PAGE = 100;
const LEFT = 1;
const RIGHT = 2;
const STALE = 4;

type Commit = Pick<ArtifactsCommitMetadata, 'hash' | 'parents' | 'committedAt'>;
/** Repositories that may hold a tip's graph, which can end at a shallow boundary. */
type Tip = { head: string; repositories: readonly string[] };
type HistoryReader = Pick<ArtifactsCodeStore, 'log' | 'readCommit'>;

/** Commit metadata across a project's Artifacts repositories. A commit ID is a content address: the same
 * commit read from any repository holding it is the same commit. */
class CommitHistory {
  private readonly commits = new Map<string, Commit>();
  constructor(private readonly code: HistoryReader) {}

  async read(hash: string, repositories: readonly string[]): Promise<Commit | null> {
    for (const repository of repositories) {
      if (this.commits.has(hash)) break;
      // log on an absent explicit ref can throw; a missing ancestor is not a missing tip.
      const root = await this.code.readCommit(repository, hash);
      if (!root) continue;
      this.commits.set(hash, root);
      for (const commit of await this.code.log(repository, hash, HISTORY_PAGE)) {
        this.commits.set(commit.hash, commit);
      }
    }
    return this.commits.get(hash) ?? null;
  }
}

/**
 * Git's merge-base walk: newest commit first, each commit marked with the tips that reach it, and every
 * ancestor of a common ancestor marked stale. It stops once only stale commits remain, so it reads history
 * back to the merge base and no further. An absent ancestor cannot prove separation or a count.
 */
export async function compareCloudHistory(code: HistoryReader, left: Tip, right: Tip) {
  const history = new CommitHistory(code);
  const repositories = [...new Set([...left.repositories, ...right.repositories])];
  const missing = new Set<string>();
  const flags = new Map<string, number>();
  const queue: Commit[] = [];
  const queued = new Set<string>();
  const bases: string[] = [];
  let active = 0;
  const reach = async (hash: string, flag: number, required = false) => {
    const previous = flags.get(hash) ?? 0;
    const next = previous | flag;
    if (next === previous) return;
    flags.set(hash, next);
    if (queued.has(hash)) {
      if (!(previous & STALE) && next & STALE) active--;
      return;
    }
    const commit = await history.read(hash, repositories);
    if (!commit) {
      if (required) throw new Error(`Commit ${hash} is missing from the workspace's cloud repository`);
      missing.add(hash);
      return;
    }
    missing.delete(hash);
    const index = queue.findIndex(entry => entry.committedAt < commit.committedAt);
    queue.splice(index < 0 ? queue.length : index, 0, commit);
    queued.add(hash);
    if (!(next & STALE)) active++;
  };
  await reach(left.head, LEFT, true);
  await reach(right.head, RIGHT, true);
  for (let examined = 0; active > 0; examined++) {
    if (examined >= STACK_WALK_LIMIT) throw new Error(`Stack history exceeds ${STACK_WALK_LIMIT} commits`);
    const commit = queue.shift();
    if (!commit) break;
    queued.delete(commit.hash);
    let flag = flags.get(commit.hash) ?? 0;
    if (!(flag & STALE)) {
      active--;
      if ((flag & (LEFT | RIGHT)) === (LEFT | RIGHT)) {
        bases.push(commit.hash);
        flag |= STALE;
        flags.set(commit.hash, flag);
      }
    }
    for (const parent of commit.parents) await reach(parent, flag);
  }
  const complete = [...missing].every(hash => (flags.get(hash) ?? 0) & STALE);
  return {
    complete,
    bases,
    leftAhead: complete ? [...flags].filter(([hash, flag]) => !missing.has(hash) && (flag & (LEFT | RIGHT)) === LEFT).length : null,
  };
}

/**
 * A stacked workspace's position against its `stackedOn` parent, from cloud checkpoints and Artifacts history:
 * what `git merge-base`, `git rev-list --count HEAD..parent` and `git merge-base --is-ancestor parent base`
 * report on a machine. The base tip is the base workspace's checkpoint, or the project's imported base branch
 * before that workspace has one. Returns null when the workspace is not in the project.
 */
const StackComparisonSchema = z.object({ mergeBase: z.string().nullable(), parentAhead: z.number(), parentMerged: z.enum(['merged', 'not-merged', 'unknown']) });

/** The project's base tip: the base workspace's checkpoint head, or the imported base branch before it has one. */
export async function readCloudBaseTip(env: Env, userId: string, projectId: string, baseBranch: string): Promise<Tip | null> {
  const saved = await env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`).runtimeCodeCheckpoint(RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
  if (saved) return saved.headCommit === null ? null : { head: saved.headCommit, repositories: [artifactsWorkspaceRepository(projectId)] };
  const repository = artifactsProjectRepository(projectId);
  const head = await new ArtifactsCodeStore(env.ARTIFACTS).resolveRef(repository, `refs/heads/${baseBranch}`);
  return head === null ? null : { head, repositories: [repository] };
}

export async function readCloudStackStatus(env: Env, userId: string, projectId: string, workspaceId: string): Promise<StackStatus | null> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [project, workspaces, relations] = await Promise.all([authority.getProject(), authority.listWorkspaces(), authority.listWorkspaceRelations()]);
  if (!project) throw new Error(`Project ${projectId} is unavailable`);
  if (!workspaces.some(entry => entry.id === workspaceId && entry.lifecycle !== 'deleting')) return null;
  const baseBranch = project.baseBranch;
  const stackedOn = relations[workspaceId]?.stackedOn ?? null;
  const parent = workspaces.find(entry => entry.id === stackedOn);
  if (!parent) return { parentId: null, parentBranch: null, baseBranch, mergeBase: null, parentAhead: 0, parentMerged: 'unknown', instruction: null };
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const checkpoint = (id: string) => env.SPACE_AUTHORITY.getByName(`${userId}:${id}`).runtimeRepositoryCheckpoint(RuntimeIdentitySchema.parse({ projectId, workspaceId: id }));
  const [child, parentCheckpoint, base] = await Promise.all([checkpoint(workspaceId), checkpoint(parent.id), readCloudBaseTip(env, userId, projectId, baseBranch)]);
  const parentTip = parentCheckpoint.headCommit === null ? null : { head: parentCheckpoint.headCommit, repositories: [artifactsWorkspaceRepository(parent.id)] };
  // The comparison depends only on these commits and branches, so it is computed once per change of any of them.
  const source = JSON.stringify([child.headCommit, parentTip?.head ?? null, base?.head ?? null, parent.branch, baseBranch]);
  const compare = async (): Promise<z.infer<typeof StackComparisonSchema>> => {
    const stack = parentTip && child.headCommit !== null ? await compareCloudHistory(code, parentTip, { head: child.headCommit, repositories: [artifactsWorkspaceRepository(workspaceId)] }) : null;
    if (stack && !stack.complete) throw new Error('Stack comparison is unavailable because cloud history is shallow or incomplete');
    // A parent working on the base branch itself trivially reaches it; that is not a merge.
    let merged: StackStatus['parentMerged'] = 'not-merged';
    if (parent.branch !== baseBranch) {
      if (!parentTip || !base) merged = 'unknown';
      else {
        const comparison = await compareCloudHistory(code, parentTip, base);
        if (comparison.bases.includes(parentTip.head)) merged = 'merged';
        else if (!comparison.complete) merged = 'unknown';
      }
    }
    return { mergeBase: stack?.bases[0] ?? null, parentAhead: stack?.leftAhead ?? 0, parentMerged: merged };
  };
  const saved = await authority.stackComparison(workspaceId, source);
  let comparison = saved === null ? null : StackComparisonSchema.parse(JSON.parse(saved));
  if (!comparison) {
    comparison = await compare();
    await authority.putStackComparison(workspaceId, source, JSON.stringify(comparison));
  }
  const { mergeBase, parentAhead, parentMerged } = comparison;
  const instruction = parentMerged === 'merged'
    ? `The parent merged into ${baseBranch}. Rebase only your own commits: \`git rebase --onto ${baseBranch} ${parent.branch}\`, then this workspace is no longer stacked.`
    : parentAhead > 0 ? `Rebase onto the parent: \`git rebase ${parent.branch}\`` : null;
  return { parentId: parent.id, parentBranch: parent.branch, baseBranch, mergeBase, parentAhead, parentMerged, instruction };
}
