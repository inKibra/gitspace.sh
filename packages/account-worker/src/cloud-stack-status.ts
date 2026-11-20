import type { CloudWorkspaceDefinition, StackStatus } from '@gitspace/protocol';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import type { WorkspaceRelations } from '@gitspace/protocol-workspace';
import type { WorkspaceBase } from '@gitspace/runtime-core';
import { z } from 'zod';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import type { ProjectAuthorityDO } from './project-authority.js';

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
    if (examined >= STACK_WALK_LIMIT) throw new StackHistoryUnavailable(`Stack history exceeds ${STACK_WALK_LIMIT} commits`);
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

/** How a branch at `commit` relates to `tip`: it already holds `tip` (equal or descended), fast-forwards to it, or has
 * `ahead` commits `tip` lacks (null when cloud history is too shallow to tell, which never counts as a fast-forward). */
export type ForwardPosition = { kind: 'holds' | 'forward' } | { kind: 'diverged'; ahead: number | null };
export async function forwardPosition(code: HistoryReader, repositories: readonly string[], commit: string, tip: string): Promise<ForwardPosition> {
  if (commit === tip) return { kind: 'holds' };
  const comparison = await compareCloudHistory(code, { head: commit, repositories }, { head: tip, repositories });
  // Reaching `tip` from `commit` proves containment even where older history is missing.
  if (comparison.bases.includes(tip)) return { kind: 'holds' };
  if (comparison.leftAhead === 0) return { kind: 'forward' };
  return { kind: 'diverged', ahead: comparison.leftAhead };
}

/**
 * A stacked workspace's last comparison with its parent, kept by the project per workspace: what `git merge-base`,
 * `git rev-list --count HEAD..parent` and `git merge-base --is-ancestor parent base` report on a machine, plus
 * `builtOn`, the commit the branch was built on: the merge base when it was first compared on this parent, moved to each
 * later merge base while the parent's history still holds the earlier one. When the parent's history no longer holds it
 * and the branch still does, the parent rewrote what the branch was built on (`baseRewritten`).
 */
const StackComparisonSchema = z.object({
  parentId: z.string(), mergeBase: z.string().nullable(), parentAhead: z.number(), parentMerged: z.enum(['merged', 'not-merged', 'unknown']),
  builtOn: z.string().nullable(), baseRewritten: z.boolean(),
});
type StackComparison = z.infer<typeof StackComparisonSchema>;
/** What the project keeps per stacked workspace: its last comparison, or why the commits it last read cannot be compared
 * with the comparison before (`earlier`, which the next comparison starts from). */
const StoredComparisonSchema = z.union([StackComparisonSchema, z.object({ unavailable: z.string(), earlier: StackComparisonSchema.nullable() })]);

/** Cloud history that cannot answer a comparison for these commits (shallow, incomplete or too long): the same commits
 * give the same answer, so it is kept until one of them changes. */
class StackHistoryUnavailable extends Error {}

/** The project repository's copy of a branch: what Update base moves and new workspaces start from. */
export async function readProjectBranchTip(env: Env, projectId: string, branch: string): Promise<Tip | null> {
  const repository = artifactsProjectRepository(projectId);
  const head = await new ArtifactsCodeStore(env.ARTIFACTS).resolveRef(repository, `refs/heads/${branch}`);
  return head === null ? null : { head, repositories: [repository] };
}

/** The project's base tip: the base workspace's checkpoint head, or the imported base branch before it has one. */
export async function readCloudBaseTip(env: Env, userId: string, projectId: string, baseBranch: string): Promise<Tip | null> {
  const saved = await env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`).runtimeCodeCheckpoint(RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
  if (saved) return saved.headCommit === null ? null : { head: saved.headCommit, repositories: [artifactsWorkspaceRepository(projectId)] };
  return readProjectBranchTip(env, projectId, baseBranch);
}

/**
 * Whether the origin's head of a branch is missing from GitSpace's copy: the project repository's base branch
 * (`workspace` null), else the workspace's committed checkpoint or, before it has one, the commit it was created from.
 * A commit no local repository holds is missing, and so is one only shallow history could reach: neither is proven
 * contained.
 */
export async function behindOrigin(env: Env, userId: string, projectId: string, branch: string, workspace: Pick<CloudWorkspaceDefinition, 'id' | 'sourceCommit'> | null, head: string): Promise<boolean> {
  const tip = workspace === null ? await readProjectBranchTip(env, projectId, branch) : await readCommittedTip(env, userId, projectId, workspace);
  if (tip === null) return true;
  if (tip.head === head) return false;
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  // The walk requires both commits; a commit no local repository holds is not contained.
  const held = async (hash: string) => {
    for (const repository of tip.repositories) if (await code.readCommit(repository, hash)) return true;
    return false;
  };
  if (!await held(head) || !await held(tip.head)) return true;
  return (await forwardPosition(code, tip.repositories, tip.head, head)).kind !== 'holds';
}

/** A workspace's committed cloud head: its checkpoint, or before it has one the commit it was created from. Commit ids
 * are content addresses, so ancestors it forked from may be read from the project repository. Reads the workspace
 * object's stored checkpoint only; no runtime opens. */
async function readCommittedTip(env: Env, userId: string, projectId: string, workspace: Pick<CloudWorkspaceDefinition, 'id' | 'sourceCommit'>): Promise<Tip | null> {
  const saved = await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).runtimeCodeCheckpoint(RuntimeIdentitySchema.parse({ projectId, workspaceId: workspace.id }));
  const head = saved ? saved.headCommit : workspace.sourceCommit;
  return head === null ? null : { head, repositories: [artifactsWorkspaceRepository(workspace.id), artifactsProjectRepository(projectId)] };
}

/** Compares a stacked workspace (`child`) with its parent and the parent with the base, from the stored comparison
 * `previous` (whose `builtOn` the rewrite check starts from). */
async function compareStack(code: HistoryReader, child: Tip, parentTip: Tip, base: Tip | null, parent: Pick<CloudWorkspaceDefinition, 'id' | 'branch' | 'sourceCommit'>, baseBranch: string, previous: StackComparison | null): Promise<StackComparison> {
  const stack = await compareCloudHistory(code, parentTip, child);
  if (!stack.complete) throw new StackHistoryUnavailable('Stack comparison is unavailable because cloud history is shallow or incomplete');
  let merged: StackStatus['parentMerged'] = 'not-merged';
  if (parentMerges(parent, parentTip.head, baseBranch)) {
    if (!base) merged = 'unknown';
    else {
      const comparison = await compareCloudHistory(code, parentTip, base);
      if (comparison.bases.includes(parentTip.head)) merged = 'merged';
      else if (!comparison.complete) merged = 'unknown';
    }
  }
  const mergeBase = stack.bases[0] ?? null;
  const earlier = previous?.parentId === parent.id ? previous.builtOn : null;
  let builtOn = mergeBase;
  let rewritten = false;
  if (earlier !== null && earlier !== mergeBase) {
    const repositories = [...new Set([...parentTip.repositories, ...child.repositories])];
    // A commit no repository holds any more is held by neither branch.
    const known = (await Promise.all(repositories.map(repository => code.readCommit(repository, earlier)))).some(commit => commit !== null);
    if (known && (await forwardPosition(code, repositories, parentTip.head, earlier)).kind !== 'holds' && (await forwardPosition(code, repositories, child.head, earlier)).kind === 'holds') {
      builtOn = earlier;
      rewritten = true;
    }
  }
  return { parentId: parent.id, mergeBase, parentAhead: stack.leftAhead ?? 0, parentMerged: merged, builtOn, baseRewritten: rewritten };
}

/**
 * Whether a parent at `head` can have merged into the base: it has commits of its own, its head being past the commit it
 * started from. A parent with none (just created, or never committed) is contained in the base it was created from
 * without having merged anything; a parent working on the base branch itself trivially reaches it.
 */
function parentMerges(parent: Pick<CloudWorkspaceDefinition, 'branch' | 'sourceCommit'>, head: string, baseBranch: string): boolean {
  return parent.branch !== baseBranch && head !== parent.sourceCommit;
}

/**
 * One stacked workspace's position against its `stackedOn` parent from heads already read: the stored comparison while
 * the commits and branches it compared are unchanged, else a new one, stored for next time. Without a child or parent
 * head (a checkout only on a machine) nothing is compared and the base is not read. `readBase` reads the base tip: the
 * base workspace's checkpoint, or the project's imported base branch before that workspace has one.
 */
async function stackPosition(authority: DurableObjectStub<ProjectAuthorityDO>, code: HistoryReader, input: {
  workspaceId: string; child: Tip | null; parent: Pick<CloudWorkspaceDefinition, 'id' | 'name' | 'branch' | 'sourceCommit'>; parentTip: Tip | null; readBase(): Promise<Tip | null>; baseBranch: string;
  stored: { source: string; resultJson: string } | undefined;
}): Promise<StackStatus> {
  const { child, parent, parentTip, baseBranch } = input;
  const status = (comparison: Omit<StackComparison, 'parentId'>): StackStatus => ({
    parentId: parent.id, parentBranch: parent.branch, baseBranch, mergeBase: comparison.mergeBase, parentAhead: comparison.parentAhead, parentMerged: comparison.parentMerged,
    baseRewritten: comparison.baseRewritten, instruction: stackPositionNote(parent, baseBranch, comparison),
  });
  if (!child || !parentTip) return status({ mergeBase: null, parentAhead: 0, parentMerged: parentTip ? 'not-merged' : 'unknown', builtOn: null, baseRewritten: false });
  const base = await input.readBase();
  const parsed = input.stored ? StoredComparisonSchema.safeParse(JSON.parse(input.stored.resultJson)) : null;
  const stored = parsed?.success ? parsed.data : null;
  const previous = stored && 'unavailable' in stored ? stored.earlier : stored;
  // The comparison depends only on these commits and branches, so it is computed once per change of any of them.
  const source = JSON.stringify([child.head, parentTip.head, base?.head ?? null, parent.id, parent.branch, parent.sourceCommit, baseBranch]);
  if (stored && input.stored?.source === source) {
    if ('unavailable' in stored) throw new StackHistoryUnavailable(stored.unavailable);
    return status(stored);
  }
  try {
    const comparison = await compareStack(code, child, parentTip, base, parent, baseBranch, previous);
    await authority.putStackComparison(input.workspaceId, source, JSON.stringify(comparison));
    return status(comparison);
  } catch (error) {
    if (error instanceof StackHistoryUnavailable) await authority.putStackComparison(input.workspaceId, source, JSON.stringify({ unavailable: error.message, earlier: previous }));
    throw error;
  }
}

/** A stacked workspace's position against its `stackedOn` parent, from cloud checkpoints and Artifacts history. Null
 * when the workspace is not in the project. */
export async function readCloudStackStatus(env: Env, userId: string, projectId: string, workspaceId: string): Promise<StackStatus | null> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [project, workspaces, relations, stored] = await Promise.all([authority.getProject(), authority.listWorkspaces(), authority.listWorkspaceRelations(), authority.stackComparisons()]);
  if (!project) throw new Error(`Project ${projectId} is unavailable`);
  const workspace = workspaces.find(entry => entry.id === workspaceId && entry.lifecycle !== 'deleting');
  if (!workspace) return null;
  const baseBranch = project.baseBranch;
  const stackedOn = relations[workspaceId]?.stackedOn ?? null;
  const parent = workspaces.find(entry => entry.id === stackedOn && entry.lifecycle !== 'deleting');
  if (!parent) return { parentId: null, parentBranch: null, baseBranch, mergeBase: null, parentAhead: 0, parentMerged: 'unknown', baseRewritten: false, instruction: null };
  const [child, parentTip] = await Promise.all([readCommittedTip(env, userId, projectId, workspace), readCommittedTip(env, userId, projectId, parent)]);
  return stackPosition(authority, new ArtifactsCodeStore(env.ARTIFACTS), { workspaceId, child, parent, parentTip, readBase: () => readCloudBaseTip(env, userId, projectId, baseBranch), baseBranch, stored: stored[workspaceId] });
}

/**
 * Every open stacked workspace's position against its parent, for the project view: the base tip and each workspace's
 * committed head read at most once (stored checkpoints only; no runtime opens and no machine is asked), and each
 * comparison reused while its commits are unchanged. A workspace whose position can't be read (cloud history too
 * shallow, an object failing) is left out, and the others are still returned.
 */
export async function readCloudStackPositions(env: Env, userId: string, project: { id: string; baseBranch: string }, worktrees: readonly CloudWorkspaceDefinition[], relations: Readonly<Record<string, WorkspaceRelations>>): Promise<Map<string, StackStatus>> {
  const byId = new Map(worktrees.map(definition => [definition.id, definition]));
  const stacked = worktrees.flatMap(definition => {
    const parent = byId.get(relations[definition.id]?.stackedOn ?? '');
    return definition.lifecycle !== 'archived' && parent ? [{ definition, parent }] : [];
  });
  if (!stacked.length) return new Map();
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`);
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const heads = new Map<string, Promise<Tip | null>>();
  const tip = (definition: CloudWorkspaceDefinition) => {
    const read = heads.get(definition.id) ?? readCommittedTip(env, userId, project.id, definition);
    heads.set(definition.id, read);
    return read;
  };
  const stored = authority.stackComparisons();
  let base: Promise<Tip | null> | undefined;
  const readBase = () => base ??= readCloudBaseTip(env, userId, project.id, project.baseBranch);
  const positions = await Promise.all(stacked.map(async ({ definition, parent }): Promise<[string, StackStatus] | null> => {
    try {
      const [comparisons, child, parentTip] = await Promise.all([stored, tip(definition), tip(parent)]);
      return [definition.id, await stackPosition(authority, code, { workspaceId: definition.id, child, parent, parentTip, readBase, baseBranch: project.baseBranch, stored: comparisons[definition.id] })];
    } catch (error) {
      console.error('Stack position was not read', { workspaceId: definition.id, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }));
  return new Map(positions.filter(entry => entry !== null));
}

/** What a stacked workspace's parent has that its branch lacks, or that the parent merged or rewrote what the branch was
 * built on, told to its agent as information with the optional command; null while the branch holds everything its
 * parent has. */
function stackPositionNote(parent: { name: string; branch: string }, baseBranch: string, comparison: Pick<StackComparison, 'parentAhead' | 'parentMerged' | 'builtOn' | 'baseRewritten'>): string | null {
  if (comparison.parentMerged === 'merged') return `${parent.name} merged into ${baseBranch}: restacking onto ${baseBranch} (unstacking this workspace) measures it against ${baseBranch}. If you want your branch to hold only your own commits: \`git rebase --onto ${baseBranch} ${parent.branch}\`. Optional.`;
  if (comparison.baseRewritten && comparison.builtOn) return `${parent.name} rewrote the commits your branch was built on. If you want your branch on its new history: \`git rebase --onto ${parent.branch} ${comparison.builtOn}\`. Optional.`;
  if (comparison.parentAhead > 0) return `You merge after ${parent.name}. Its branch has ${comparison.parentAhead} ${comparison.parentAhead === 1 ? 'commit' : 'commits'} yours doesn't. If you want to build on them: \`git rebase ${parent.branch}\`. Optional.`;
  return null;
}

/** The history walks of a workspace's last base reading, with the commits and branches they were read from. */
const BaseReadingSchema = z.object({ source: z.string(), merged: z.boolean(), subject: z.string().nullable(), behind: z.number().nullable(), overlapping: z.number().nullable() });

/**
 * What a workspace builds on, for its agent's Base line (runtime-core `workspace-base.ts`): its stack parent's branch
 * when it is stacked, else the project's base branch. Read from cloud checkpoints and Artifacts history, so no runtime
 * and no machine opens. `head` is the workspace's own committed cloud head; without one (a checkout only on a machine)
 * the reading has no behind count or overlap. `overlapping` counts the files changed both on the branch and on the base
 * since their merge base, two tree comparisons that read only differing directories. The walks depend only on the
 * commits and branches read, so `storage` (the workspace's own) keeps the last reading and an unchanged one walks
 * nothing. Null when the workspace is not in the project.
 */
export async function readCloudWorkspaceBase(env: Env, storage: DurableObjectStorage, userId: string, projectId: string, workspaceId: string, head: string | null): Promise<WorkspaceBase | null> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [project, workspaces, relations] = await Promise.all([authority.getProject(), authority.listWorkspaces(), authority.listWorkspaceRelations()]);
  if (!project) throw new Error(`Project ${projectId} is unavailable`);
  if (!workspaces.some(entry => entry.id === workspaceId && entry.lifecycle !== 'deleting')) return null;
  const baseBranch = project.baseBranch;
  const stackedOn = relations[workspaceId]?.stackedOn ?? null;
  const parent = workspaces.find(entry => entry.id === stackedOn && entry.lifecycle !== 'deleting');
  const [saved, base] = await Promise.all([
    parent ? env.SPACE_AUTHORITY.getByName(`${userId}:${parent.id}`).runtimeCodeCheckpoint(RuntimeIdentitySchema.parse({ projectId, workspaceId: parent.id })) : null,
    readCloudBaseTip(env, userId, projectId, baseBranch),
  ]);
  // A parent whose checkout is only on a machine has no cloud head: nothing is read for it.
  const target = parent ? (saved?.headCommit ? { head: saved.headCommit, repositories: [artifactsWorkspaceRepository(parent.id)] } : null) : base;
  const position = parent ? { id: parent.id, name: parent.name, branch: parent.branch } : null;
  if (!target) return { baseBranch, parent: position && { ...position, merged: false }, head: null, subject: null, behind: null, overlapping: null };
  const source = JSON.stringify([head, target.head, parent?.branch ?? null, parent?.sourceCommit ?? null, parent ? base?.head ?? null : null, baseBranch]);
  const stored: unknown = await storage.get('base.reading');
  let reading = stored === undefined ? null : BaseReadingSchema.parse(stored);
  if (reading?.source !== source) {
    const code = new ArtifactsCodeStore(env.ARTIFACTS);
    const [repository] = target.repositories;
    if (repository === undefined) throw new Error('The base has no repository');
    const commit = await code.readCommit(repository, target.head);
    const merged = parent && parentMerges(parent, target.head, baseBranch) && base ? (await compareCloudHistory(code, target, base)).bases.includes(target.head) : false;
    let behind: number | null = null;
    let overlapping: number | null = null;
    if (head !== null) {
      const own = artifactsWorkspaceRepository(workspaceId);
      const comparison = await compareCloudHistory(code, target, { head, repositories: [own, artifactsProjectRepository(projectId)] });
      behind = comparison.leftAhead;
      const [mergeBase] = comparison.bases;
      if (behind && mergeBase !== undefined && commit) {
        const [from, mine] = await Promise.all([code.readCommit(repository, mergeBase), code.readCommit(own, head)]);
        if (from && mine) {
          const [theirs, ours] = await Promise.all([code.changedSnapshotPaths(repository, from.treeHash, commit.treeHash), code.changedSnapshotPaths(own, from.treeHash, mine.treeHash)]);
          const changed = new Set(ours.map(change => change.path));
          overlapping = theirs.filter(change => changed.has(change.path)).length;
        }
      }
    }
    reading = { source, merged, subject: commit?.message.split('\n', 1)[0]?.trim() || null, behind, overlapping };
    await storage.put('base.reading', reading);
  }
  return { baseBranch, parent: position && { ...position, merged: reading.merged }, head: target.head, subject: reading.subject, behind: reading.behind, overlapping: reading.overlapping };
}
