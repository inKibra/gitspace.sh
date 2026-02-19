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
import {
  getWorkspaceChangedFiles,
  getWorkspaceDiff,
  getWorkspaceFileContextRange,
  getWorkspaceFileDiff,
  getWorkspaceFileVersions,
} from './git.js';
import { importGitHubReview, pushGitHubReview } from './github-review.js';
import { readProjectConfig } from './config.js';
import { scanWorkspaces } from '../lib/remote-session/workspace-scanner.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';

type ScanWorkspacesFn = typeof scanWorkspaces;

function toCanonicalWorkspaceId(workspace: { projectName: string; id: string }): string {
  return `${workspace.projectName}:${workspace.id}`;
}

function matchesWorkspaceId(
  workspace: { projectName: string; id: string },
  workspaceId: string
): boolean {
  return workspace.id === workspaceId || toCanonicalWorkspaceId(workspace) === workspaceId;
}

async function resolveWorkspaceByName(
  projectName: string,
  workspaceName: string,
  scan: ScanWorkspacesFn
): Promise<{ id: string; path: string; baseBranch: string }> {
  const workspaces = await scan();
  const workspace = workspaces.find(
    (w) => w.projectName === projectName && matchesWorkspaceId(w, workspaceName)
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
      const threads = getThreads(workspace.path, workspace.id, workspace.baseBranch);
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
        workspace.id,
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
        workspace.id,
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
        workspace.id,
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
        workspace.id,
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
        workspace.id,
        workspace.baseBranch,
        operation.threadId,
        operation.commentId
      );
      // deleteComment may return null if the thread was itself removed
      const now = new Date().toISOString();
      return {
        op: 'comment_deleted',
        thread: thread ?? {
          id: operation.threadId,
          target: { kind: 'workspace' as const },
          resolved: true,
          comments: [],
          createdAt: now,
          updatedAt: now,
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

    case 'get_changed_files': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const changed = await getWorkspaceChangedFiles(workspace.path, workspace.baseBranch);
      return {
        op: 'changed_files',
        files: changed.files,
        baseBranch: changed.baseBranch,
        headBranch: changed.headBranch,
      };
    }

    case 'get_file_diff': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const result = await getWorkspaceFileDiff(
        workspace.path,
        workspace.baseBranch,
        operation.filePath,
        operation.prevFilePath
      );
      return {
        op: 'file_diff',
        filePath: operation.filePath,
        prevFilePath: operation.prevFilePath,
        diff: result.diff,
      };
    }

    case 'get_file_versions': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const { oldContents, newContents } = await getWorkspaceFileVersions(
        workspace.path,
        workspace.baseBranch,
        operation.filePath,
        operation.prevFilePath
      );
      return {
        op: 'file_versions',
        filePath: operation.filePath,
        prevFilePath: operation.prevFilePath,
        oldContents,
        newContents,
      };
    }

    case 'get_file_context_range': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const result = await getWorkspaceFileContextRange(
        workspace.path,
        workspace.baseBranch,
        operation.filePath,
        operation.prevFilePath,
        {
          oldStart: operation.oldStart,
          oldEnd: operation.oldEnd,
          newStart: operation.newStart,
          newEnd: operation.newEnd,
        }
      );

      return {
        op: 'file_context_range',
        filePath: operation.filePath,
        prevFilePath: operation.prevFilePath,
        oldStart: result.oldStart,
        oldLines: result.oldLines,
        oldTotal: result.oldTotal,
        newStart: result.newStart,
        newLines: result.newLines,
        newTotal: result.newTotal,
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
        workspace.id,
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
        workspace.id,
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
