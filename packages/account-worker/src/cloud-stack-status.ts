import type { StackStatus } from '@gitspace/protocol';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';

/** Commits examined per comparison; beyond it the cloud fails rather than report a wrong position. */
const STACK_WALK_LIMIT = 5_000;
/** First-parent ancestors fetched with each commit read, so linear history costs one read per page. */
const HISTORY_PAGE = 100;
const LEFT = 1;
const RIGHT = 2;
const STALE = 4;

interface Commit { hash: string; parents: string[]; committedAt: number }
/** A tip and the repositories holding everything it reaches. */
interface Tip { head: string; repositories: readonly string[] }

/** Commit metadata across a project's Artifacts repositories. A commit ID is a content address: the same
 * commit read from any repository holding it is the same commit. */
class CommitHistory {
  private readonly commits = new Map<string, Commit>();
  constructor(private readonly code: ArtifactsCodeStore) {}

  async read(hash: string, repositories: readonly string[]): Promise<Commit> {
    for (const repository of repositories) {
      if (this.commits.has(hash)) break;
      for (const commit of await this.code.log(repository, hash, HISTORY_PAGE)) {
        this.commits.set(commit.hash, { hash: commit.hash, parents: commit.parents, committedAt: commit.committedAt });
      }
    }
    const commit = this.commits.get(hash);
    if (!commit) throw new Error(`Commit ${hash} is missing from the workspace's cloud repository`);
    return commit;
  }
}

/**
 * Git's merge-base walk: newest commit first, each commit marked with the tips that reach it, and every
 * ancestor of a common ancestor marked stale. It stops once only stale commits remain, so it reads history
 * back to the merge base and no further. Returns each commit's marks and the merge bases, newest first.
 */
async function paint(history: CommitHistory, left: Tip, right: Tip) {
  const flags = new Map<string, number>();
  const queue: Commit[] = [];
  const queued = new Set<string>();
  const bases: string[] = [];
  let active = 0;
  const reach = async (hash: string, flag: number) => {
    const previous = flags.get(hash) ?? 0;
    const next = previous | flag;
    if (next === previous) return;
    flags.set(hash, next);
    if (queued.has(hash)) {
      if (!(previous & STALE) && next & STALE) active--;
      return;
    }
    const commit = await history.read(hash, [...(next & LEFT ? left.repositories : []), ...(next & RIGHT ? right.repositories : [])]);
    const index = queue.findIndex(entry => entry.committedAt < commit.committedAt);
    queue.splice(index < 0 ? queue.length : index, 0, commit);
    queued.add(hash);
    if (!(next & STALE)) active++;
  };
  await reach(left.head, LEFT);
  await reach(right.head, RIGHT);
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
  return { flags, bases };
}

/**
 * A stacked workspace's position against its `stackedOn` parent, from cloud checkpoints and Artifacts history:
 * what `git merge-base`, `git rev-list --count HEAD..parent` and `git merge-base --is-ancestor parent base`
 * report on a machine. The base tip is the base workspace's checkpoint, or the project's imported base branch
 * before that workspace has one. Returns null when the workspace is not in the project.
 */
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
  const baseTip = async (): Promise<Tip | null> => {
    const saved = await env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`).runtimeCodeCheckpoint(RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
    if (saved) return saved.headCommit === null ? null : { head: saved.headCommit, repositories: [artifactsWorkspaceRepository(projectId)] };
    const repository = artifactsProjectRepository(projectId);
    const head = await code.resolveRef(repository, `refs/heads/${baseBranch}`);
    return head === null ? null : { head, repositories: [repository] };
  };
  const [child, parentCheckpoint, base] = await Promise.all([checkpoint(workspaceId), checkpoint(parent.id), baseTip()]);
  const history = new CommitHistory(code);
  const parentTip = parentCheckpoint.headCommit === null ? null : { head: parentCheckpoint.headCommit, repositories: [artifactsWorkspaceRepository(parent.id)] };
  const stack = parentTip && child.headCommit !== null ? await paint(history, parentTip, { head: child.headCommit, repositories: [artifactsWorkspaceRepository(workspaceId)] }) : null;
  const parentAhead = stack ? [...stack.flags.values()].filter(flag => (flag & (LEFT | RIGHT)) === LEFT).length : 0;
  // A parent working on the base branch itself trivially reaches it; that is not a merge.
  let parentMerged: StackStatus['parentMerged'] = 'not-merged';
  if (parent.branch !== baseBranch) {
    if (!parentTip || !base) parentMerged = 'unknown';
    else if ((await paint(history, parentTip, base)).bases.includes(parentTip.head)) parentMerged = 'merged';
  }
  const instruction = parentMerged === 'merged'
    ? `The parent merged into ${baseBranch}. Rebase only your own commits: \`git rebase --onto ${baseBranch} ${parent.branch}\`, then this workspace is no longer stacked.`
    : parentAhead > 0 ? `Rebase onto the parent: \`git rebase ${parent.branch}\`` : null;
  return { parentId: parent.id, parentBranch: parent.branch, baseBranch, mergeBase: stack?.bases[0] ?? null, parentAhead, parentMerged, instruction };
}
