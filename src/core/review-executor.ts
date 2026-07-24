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
  approveHunk,
  type ReviewWriteOptions,
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
import { matchesWorkspaceId } from '../utils/workspace-id.js';
import { normalizeHunkHeader } from '../utils/hunk-header.js';

type ScanWorkspacesFn = typeof scanWorkspaces;

function extractHunkHeaders(diff: string): string[] {
  const matches = diff.match(/^@@[^\n]*@@.*$/gm) ?? [];
  return matches.map((header) => normalizeHunkHeader(header));
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
  scan: ScanWorkspacesFn = scanWorkspaces,
  writeOptions: ReviewWriteOptions = {}
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
        operation.decision,
        undefined,
        writeOptions
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
      return {
        op: 'comment_deleted',
        thread,
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

    case 'get_review_guide': {
      // Resolve via the canonical goal-scoped reader (goals/<goalId>/review/
      // guide.json). The UI previously read the mount-root 'review/guide.json',
      // which never resolves for a workspace goal, so the Change Guide silently
      // fell back to the heuristic diff-walk and appeared "not visible".
      const { readReviewGuide } = await import('./review-guide.js');
      return { op: 'review_guide', guide: readReviewGuide(operation.projectName, operation.workspaceName) };
    }

    case 'get_review_guide_state': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const { readReviewGuideState } = await import('./review.js');

      // Joins (phase-journal ⇄ goal ledger): the guide UI and the narrator
      // share one source for the goal timeline + per-phase requirement motion.
      let goalTimeline: import('../types/goals.js').TimelineEvent[] | undefined;
      try {
        const { readWorkspaceGoal } = await import('./goal-chain.js');
        const goal = readWorkspaceGoal(operation.projectName, operation.workspaceName);
        if (goal?.validation?.events?.length) goalTimeline = goal.validation.events;
      } catch { /* no goal — state alone */ }
      let journal: Array<{ phase: string; startedAt: string; endedAt?: string; requirementsAdvanced: Array<{ id: string; from: string; to: string }> }> | undefined;
      try {
        const { listPhaseJournalEntries } = await import('./phase-journal.js');
        const entries = listPhaseJournalEntries(workspace.path);
        if (entries.length > 0) {
          journal = entries.map((e) => ({
            phase: e.phase,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            requirementsAdvanced: e.delta?.requirementsAdvanced ?? [],
          }));
        }
      } catch { /* no journal mount */ }

      return {
        op: 'review_guide_state',
        state: readReviewGuideState(workspace.path, workspace.id),
        ...(goalTimeline ? { goalTimeline } : {}),
        ...(journal ? { journal } : {}),
      };
    }

    case 'set_review_guide_state': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const { writeReviewGuideState } = await import('./review.js');
      return { op: 'review_guide_state', state: writeReviewGuideState(workspace.path, workspace.id, operation.state) };
    }

    case 'get_changed_files': {
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan
      );
      const changed = await getWorkspaceChangedFiles(workspace.path, operation.base ?? workspace.baseBranch);
      const { listLocalBranches } = await import('./git.js');
      return {
        op: 'changed_files',
        files: changed.files,
        baseBranch: changed.baseBranch,
        headBranch: changed.headBranch,
        branches: await listLocalBranches(workspace.path),
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
        operation.base ?? workspace.baseBranch,
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
        // Same ref the diff came from — see the op's `base` doc.
        operation.base ?? workspace.baseBranch,
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

    case 'approve_path': {
      const hunkKey = (filePath: string, hunkHeader: string) => `${filePath}@@${normalizeHunkHeader(hunkHeader)}`;
      const workspace = await resolveWorkspaceByName(
        operation.projectName,
        operation.workspaceName,
        scan,
      );

      const changed = await getWorkspaceChangedFiles(workspace.path, workspace.baseBranch);
      const matchingFiles = changed.files.filter((file) => (
        operation.pathKind === 'folder'
          ? file.filePath === operation.path || file.filePath.startsWith(`${operation.path}/`)
          : file.filePath === operation.path
      ));

      const existingApprovedHunks = new Set(
        getThreads(workspace.path, workspace.id, workspace.baseBranch)
          .flatMap((thread) => thread.target.kind === 'hunk' && thread.decision === 'approved'
            ? [hunkKey(thread.target.file, thread.target.hunkHeader)]
            : []),
      );

      let approvedCount = 0;
      for (const file of matchingFiles) {
        const fileDiff = await getWorkspaceFileDiff(
          workspace.path,
          workspace.baseBranch,
          file.filePath,
          file.prevFilePath,
        );
        const headers = extractHunkHeaders(fileDiff.diff);
        for (const hunkHeader of headers) {
          const key = hunkKey(file.filePath, hunkHeader);
          if (existingApprovedHunks.has(key)) {
            continue;
          }
          await approveHunk(
            workspace.path,
            workspace.id,
            workspace.baseBranch,
            {
              kind: 'hunk',
              file: file.filePath,
              hunkHeader,
            },
            undefined,
            writeOptions
          );
          existingApprovedHunks.add(key);
          approvedCount += 1;
        }
      }

      const threads = getThreads(workspace.path, workspace.id, workspace.baseBranch);
      return {
        op: 'path_approved',
        path: operation.path,
        pathKind: operation.pathKind,
        approvedCount,
        threads,
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
        prNumber,
        writeOptions
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
