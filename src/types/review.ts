/**
 * Review system types
 *
 * Supports threaded code review with hunk-level approve/reject decisions,
 * line-range comments, file-level notes, and workspace-level notes.
 * Bidirectionally syncs with GitHub PR review comments.
 */

// ============================================================================
// Thread Targets
// ============================================================================

/** Attach to a specific diff hunk (@@ block) — can carry an approve/reject decision */
export interface HunkTarget {
  kind: 'hunk';
  file: string;
  /** The @@ -start,lines +start,lines @@ header string — used as stable hunk ID */
  hunkHeader: string;
}

/** Attach to a range of lines in a file */
export interface LineTarget {
  kind: 'line';
  file: string;
  startLine: number;
  endLine: number;
  /** Which side of the diff — LEFT (old) or RIGHT (new) */
  side: 'LEFT' | 'RIGHT';
}

/** Attach to an entire file */
export interface FileTarget {
  kind: 'file';
  file: string;
}

/** Attach to the workspace as a whole — general review comment */
export interface WorkspaceTarget {
  kind: 'workspace';
}

export type ThreadTarget = HunkTarget | LineTarget | FileTarget | WorkspaceTarget;

// ============================================================================
// Hunk Decision
// ============================================================================

/** Decision on a diff hunk — only valid when thread target is 'hunk' */
export type HunkDecision = 'approved' | 'rejected' | 'pending';

// ============================================================================
// Comment (thread reply)
// ============================================================================

export interface ReviewComment {
  id: string;
  /** The thread this comment belongs to */
  threadId: string;
  body: string;
  /** 'local' for locally-authored, or GitHub username when imported */
  author: string;
  createdAt: string;
  /** Set when synced from/to GitHub */
  githubId?: number;
  /** Set for local comments once they have been pushed to GitHub */
  syncedToGitHubAt?: string;
}

// ============================================================================
// Thread (the unified container for all review activity)
// ============================================================================

export interface ReviewThread {
  id: string;
  target: ThreadTarget;
  /**
   * Approve/reject decision — only populated when target.kind === 'hunk'.
   * undefined means not yet reviewed (equivalent to 'pending').
   */
  decision?: HunkDecision;
  /** Whether this thread has been resolved */
  resolved: boolean;
  /** Flat list: first comment is the root, subsequent are replies */
  comments: ReviewComment[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Review Session (the notes.json file content)
// ============================================================================

export interface ReviewSession {
  version: '1.0';
  workspaceName: string;
  baseBranch: string;
  /** Set when associated with a GitHub PR */
  prNumber: number | null;
  threads: ReviewThread[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Derived Statuses (computed, never stored)
// ============================================================================

/** Per-file review status derived from hunk decisions */
export type FileReviewStatus =
  | 'not_reviewed'   // No hunk decisions made
  | 'in_progress'    // Some hunks reviewed, some pending
  | 'approved'       // All hunks approved, none rejected
  | 'needs_changes'; // At least one hunk rejected

/** Overall workspace review status derived from all files */
export type WorkspaceReviewStatus =
  | 'not_started'     // No threads at all
  | 'in_progress'     // Some threads exist but not all hunks reviewed
  | 'approved'        // All files approved
  | 'changes_required'; // At least one file needs changes

/** Summary of a file's review state */
export interface FileReviewSummary {
  file: string;
  status: FileReviewStatus;
  totalHunks: number;
  approvedHunks: number;
  rejectedHunks: number;
  pendingHunks: number;
  threadCount: number;
  unresolvedThreadCount: number;
}

// ============================================================================
// Review Operations (the request/response contract for WebSocket messages)
// ============================================================================

/** Operations that can be sent from client to machine */
export type ReviewOperation =
  | { op: 'get_threads'; projectName: string; workspaceName: string }
  | {
      op: 'create_thread';
      projectName: string;
      workspaceName: string;
      target: ThreadTarget;
      body: string;
      decision?: HunkDecision;
    }
  | {
      op: 'add_reply';
      projectName: string;
      workspaceName: string;
      threadId: string;
      body: string;
    }
  | {
      op: 'update_thread';
      projectName: string;
      workspaceName: string;
      threadId: string;
      resolved?: boolean;
      decision?: HunkDecision;
    }
  | {
      op: 'update_comment';
      projectName: string;
      workspaceName: string;
      threadId: string;
      commentId: string;
      body: string;
    }
  | {
      op: 'delete_comment';
      projectName: string;
      workspaceName: string;
      threadId: string;
      commentId: string;
    }
  | { op: 'get_review_guide'; projectName: string; workspaceName: string }
  | { op: 'get_review_guide_state'; projectName: string; workspaceName: string }
  | { op: 'set_review_guide_state'; projectName: string; workspaceName: string; state: { readSections: string[]; approval?: { by: string; at: string; headSha: string }; requestedChangesAt?: string } }
  | { op: 'get_changed_files'; projectName: string; workspaceName: string; base?: string }
  | { op: 'get_diff'; projectName: string; workspaceName: string }
  | {
      op: 'get_file_diff';
      projectName: string;
      workspaceName: string;
      filePath: string;
      prevFilePath?: string;
      base?: string;
    }
  | {
      op: 'get_file_versions';
      projectName: string;
      workspaceName: string;
      filePath: string;
      /** Optional old path for renames (rename from) */
      prevFilePath?: string;
    }
  | {
      op: 'get_file_context_range';
      projectName: string;
      workspaceName: string;
      filePath: string;
      /** Optional old path for renames (rename from) */
      prevFilePath?: string;
      /**
       * Ref the old side comes from. MUST match the ref the diff being expanded
       * was produced against — the repo view can diff vs any ref, and pulling
       * context from the workspace base instead would splice the wrong file's
       * text into the gaps. Omit for the workspace's base branch.
       */
      base?: string;
      /** 1-based inclusive range on old/base side. Omit for full file */
      oldStart?: number;
      /** 1-based inclusive range on old/base side. Omit for full file */
      oldEnd?: number;
      /** 1-based inclusive range on new/head side. Omit for full file */
      newStart?: number;
      /** 1-based inclusive range on new/head side. Omit for full file */
      newEnd?: number;
    }
  | {
      op: 'approve_path';
      projectName: string;
      workspaceName: string;
      path: string;
      pathKind: 'file' | 'folder';
    }
  | { op: 'import_github'; projectName: string; workspaceName: string; prNumber?: number }
  | { op: 'push_github'; projectName: string; workspaceName: string; prNumber?: number };

export interface ReviewChangedFile {
  filePath: string;
  /** Optional old path for renames/copies (source path) */
  prevFilePath?: string;
  changeType: 'new' | 'deleted' | 'renamed' | 'copied' | 'modified';
  /** Line counts vs the diff base (from --numstat; absent for binary). */
  additions?: number;
  deletions?: number;
}

/** Results returned from machine to client */
export type ReviewResult =
  | { op: 'threads'; threads: ReviewThread[] }
  | {
      /** The committed narrated guide (review/guide.json), resolved via the
       *  canonical goal-scoped reader so the UI never has to reconstruct the
       *  `goals/<goalId>/` path. Null when no guide has been submitted. */
      op: 'review_guide';
      guide: import('../core/review-guide.js').ReviewGuide | null;
    }
  | {
      op: 'review_guide_state';
      state: { readSections: string[]; approval?: { by: string; at: string; headSha: string }; requestedChangesAt?: string };
      /** Goal-validation timeline (phase-stamped) — one source shared by the
       *  guide UI and the narrator. Absent when the workspace has no goal. */
      goalTimeline?: import('./goals.js').TimelineEvent[];
      /** Phase-journal lite: which requirements advanced in which phase.
       *  Absent when the workspace has no journal. */
      journal?: Array<{
        phase: string;
        startedAt: string;
        endedAt?: string;
        requirementsAdvanced: Array<{ id: string; from: string; to: string }>;
      }>;
    }
  | { op: 'thread_created'; thread: ReviewThread }
  | { op: 'thread_updated'; thread: ReviewThread }
  | { op: 'comment_added'; thread: ReviewThread }
  | { op: 'comment_updated'; thread: ReviewThread }
  | { op: 'comment_deleted'; thread: ReviewThread }
  | {
      op: 'changed_files';
      files: ReviewChangedFile[];
      baseBranch: string;
      headBranch: string;
    }
  | { op: 'diff'; diff: string; baseBranch: string; headBranch: string }
  | {
      op: 'file_diff';
      filePath: string;
      prevFilePath?: string;
      diff: string;
    }
  | {
      op: 'file_versions';
      filePath: string;
      prevFilePath?: string;
      oldContents: string | null;
      newContents: string | null;
    }
  | {
      op: 'file_context_range';
      filePath: string;
      prevFilePath?: string;
      oldStart: number;
      oldLines: string[];
      oldTotal: number;
      newStart: number;
      newLines: string[];
      newTotal: number;
    }
  | {
      op: 'path_approved';
      path: string;
      pathKind: 'file' | 'folder';
      approvedCount: number;
      threads: ReviewThread[];
    }
  | { op: 'github_imported'; imported: number; threads: ReviewThread[] }
  | { op: 'github_pushed'; prNumber: number; url: string };

// ============================================================================
// Helpers
// ============================================================================

/** Compute per-file review status from threads */
export function computeFileStatuses(threads: ReviewThread[]): Map<string, FileReviewSummary> {
  const fileMap = new Map<string, FileReviewSummary>();

  const getOrCreate = (file: string): FileReviewSummary => {
    if (!fileMap.has(file)) {
      fileMap.set(file, {
        file,
        status: 'not_reviewed',
        totalHunks: 0,
        approvedHunks: 0,
        rejectedHunks: 0,
        pendingHunks: 0,
        threadCount: 0,
        unresolvedThreadCount: 0,
      });
    }
    return fileMap.get(file)!;
  };

  for (const thread of threads) {
    const file = thread.target.kind === 'workspace' ? null : thread.target.file;
    if (!file) continue;

    const summary = getOrCreate(file);
    summary.threadCount++;
    if (!thread.resolved) {
      summary.unresolvedThreadCount++;
    }

    if (thread.target.kind === 'hunk') {
      summary.totalHunks++;
      const decision = thread.decision ?? 'pending';
      if (decision === 'approved') summary.approvedHunks++;
      else if (decision === 'rejected') summary.rejectedHunks++;
      else summary.pendingHunks++;
    }
  }

  // Compute derived status for each file
  for (const summary of fileMap.values()) {
    if (summary.totalHunks === 0) {
      summary.status = 'not_reviewed';
    } else if (summary.rejectedHunks > 0) {
      summary.status = 'needs_changes';
    } else if (summary.pendingHunks > 0) {
      summary.status = 'in_progress';
    } else {
      summary.status = 'approved';
    }
  }

  return fileMap;
}

/** Compute overall workspace review status */
export function computeWorkspaceStatus(threads: ReviewThread[]): WorkspaceReviewStatus {
  if (threads.length === 0) return 'not_started';

  const fileStatuses = computeFileStatuses(threads);

  // If all threads are workspace-level they don't appear in fileStatuses.
  // Treat that as in_progress (reviewer has left notes but made no hunk decisions).
  if (fileStatuses.size === 0) return 'in_progress';

  let anyChangesRequired = false;
  let anyInProgress = false;
  let anyNotReviewed = false;

  for (const summary of fileStatuses.values()) {
    if (summary.status === 'needs_changes') anyChangesRequired = true;
    else if (summary.status === 'in_progress') anyInProgress = true;
    else if (summary.status === 'not_reviewed') anyNotReviewed = true;
  }

  if (anyChangesRequired) return 'changes_required';
  // Files with only non-hunk threads (comments but no hunk decisions) are
  // 'not_reviewed'. That means the reviewer has started looking but hasn't
  // approved/rejected anything — call that 'in_progress'.
  if (anyInProgress || anyNotReviewed) return 'in_progress';
  return 'approved';
}
