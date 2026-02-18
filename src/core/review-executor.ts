/**
 * Local review operation executor.
 *
 * Shared by LocalSessionBackend (direct filesystem access) and
 * RemoteSessionHandler (over encrypted WebSocket). Implements all
 * ReviewOperation variants using the core review and git modules.
 */

import {
  getThreads,
  createThread,
  addReply,
  updateThread,
  updateComment,
  deleteComment,
  detectPRNumber,
} from './review.js';
import { getWorkspaceDiff } from './git.js';
import { importGitHubReview, pushGitHubReview } from './github-review.js';
import { readProjectConfig } from './config.js';
import { scanWorkspaces } from '../lib/remote-session/workspace-scanner.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';

type ScanWorkspacesFn = typeof scanWorkspaces;

async function resolveWorkspaceByName(
  projectName: string,
  workspaceName: string,
  scan: ScanWorkspacesFn
): Promise<{ id: string; path: string; baseBranch: string }> {
  const workspaces = await scan();
  const workspace = workspaces.find(
    (w) => w.projectName === projectName && w.id === workspaceName
  );

  if (!workspace) {
    throw new Error(`Workspace not found: ${projectName}:${workspaceName}`);
  }

  let baseBranch = 'main';
  try {
    const projectConfig = readProjectConfig(projectName);
    baseBranch = projectConfig.baseBranch ?? 'main';
  } catch {
    // Fall back to 'main'
  }

  return { id: workspace.id, path: workspace.path, baseBranch };
}

/**
 * Execute a ReviewOperation with direct filesystem access.
 *
 * @param operation - The operation to execute
 * @param scan - scanWorkspaces implementation (injectable for testing)
 */
export async function executeLocalReviewOperation(
  operation: ReviewOperation,
  scan: ScanWorkspacesFn = scanWorkspaces
): Promise<ReviewResult> {
  switch (operation.op) {
    case 'get_threads': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const threads = getThreads(workspace.path, operation.workspaceName, workspace.baseBranch);
      return { op: 'threads', threads };
    }

    case 'create_thread': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const thread = await createThread(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        operation.target,
        operation.body,
        operation.decision
      );
      return { op: 'thread_created', thread };
    }

    case 'add_reply': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const thread = addReply(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        operation.threadId,
        operation.body
      );
      return { op: 'comment_added', thread };
    }

    case 'update_thread': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const thread = updateThread(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        operation.threadId,
        { resolved: operation.resolved, decision: operation.decision }
      );
      return { op: 'thread_updated', thread };
    }

    case 'update_comment': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const thread = updateComment(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        operation.threadId,
        operation.commentId,
        operation.body
      );
      return { op: 'comment_updated', thread };
    }

    case 'delete_comment': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const thread = deleteComment(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        operation.threadId,
        operation.commentId
      );
      // deleteComment may return null if the thread was itself removed
      return {
        op: 'comment_deleted',
        thread: thread ?? {
          id: operation.threadId,
          target: { kind: 'workspace' as const },
          resolved: true,
          comments: [],
          createdAt: '',
          updatedAt: '',
        },
      };
    }

    case 'get_diff': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const diffResult = await getWorkspaceDiff(workspace.path, workspace.baseBranch);
      return {
        op: 'diff',
        diff: diffResult.diff,
        baseBranch: diffResult.baseBranch,
        headBranch: diffResult.headBranch,
      };
    }

    case 'import_github': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const prNumber =
        operation.prNumber ?? (await detectPRNumber(workspace.path)) ?? null;
      if (!prNumber) {
        throw new Error(
          'Could not determine PR number. Pass prNumber explicitly or ensure the branch has an open PR.'
        );
      }
      const { imported, threads } = await importGitHubReview(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        prNumber
      );
      return { op: 'github_imported', imported, threads };
    }

    case 'push_github': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const prNumber =
        operation.prNumber ?? (await detectPRNumber(workspace.path)) ?? null;
      if (!prNumber) {
        throw new Error(
          'Could not determine PR number. Pass prNumber explicitly or ensure the branch has an open PR.'
        );
      }
      const { url } = await pushGitHubReview(
        workspace.path,
        operation.workspaceName,
        workspace.baseBranch,
        prNumber
      );
      return { op: 'github_pushed', prNumber, url };
    }

    default: {
      const unknown = operation as { op: string };
      throw new Error(`Unknown review operation: ${unknown.op}`);
    }
  }
}
