import type { StackStatus } from '@gitspace/protocol';

export interface StackStatusInput {
  /** Root of the stacked (child) worktree; its HEAD is the child branch. */
  rootPath: string;
  baseBranch: string;
  /** The `stackedOn` parent, or null when the workspace is not stacked. */
  parent: { id: string; branch: string } | null;
}

interface GitResult {
  exitCode: number;
  stdout: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const child = Bun.spawn(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout: stdout.trim() };
}

/**
 * Where a stacked branch sits relative to its parent: how many parent commits it lacks, and
 * whether the parent already landed on the base branch. Every git failure degrades to
 * `unknown` rather than throwing so the Overview can still render the rest of the stack.
 */
export async function computeStackStatus(input: StackStatusInput): Promise<StackStatus> {
  if (!input.parent) {
    return { parentId: null, parentBranch: null, baseBranch: input.baseBranch, mergeBase: null, parentAhead: 0, parentMerged: 'unknown', instruction: null };
  }
  const parentBranch = input.parent.branch;
  const [mergeBase, ahead, ancestor] = await Promise.all([
    runGit(input.rootPath, ['merge-base', 'HEAD', parentBranch]),
    runGit(input.rootPath, ['rev-list', '--count', `HEAD..${parentBranch}`]),
    runGit(input.rootPath, ['merge-base', '--is-ancestor', parentBranch, input.baseBranch]),
  ]);
  const parentAhead = ahead.exitCode === 0 ? Number.parseInt(ahead.stdout, 10) : Number.NaN;
  // A parent working on the base branch itself is trivially "an ancestor of
  // base"; that is not a merge, so only the ahead count applies.
  const parentMerged: StackStatus['parentMerged'] = parentBranch === input.baseBranch
    ? 'not-merged'
    : ancestor.exitCode === 0 ? 'merged' : ancestor.exitCode === 1 ? 'not-merged' : 'unknown';
  let instruction: string | null = null;
  if (parentMerged === 'merged') {
    instruction = `The parent merged into ${input.baseBranch}. Rebase only your own commits: \`git rebase --onto ${input.baseBranch} ${parentBranch}\`, then this workspace is no longer stacked.`;
  } else if (parentAhead > 0) {
    instruction = `Rebase onto the parent: \`git rebase ${parentBranch}\``;
  }
  return {
    parentId: input.parent.id,
    parentBranch,
    baseBranch: input.baseBranch,
    mergeBase: mergeBase.exitCode === 0 && mergeBase.stdout ? mergeBase.stdout : null,
    parentAhead: Number.isFinite(parentAhead) ? parentAhead : 0,
    parentMerged,
    instruction,
  };
}
