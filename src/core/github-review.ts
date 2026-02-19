/**
 * GitHub PR review integration
 *
 * Import PR review comments from GitHub into the local ReviewThread format,
 * and push local threads back to GitHub as a PR review.
 *
 * Uses the `gh` CLI for all GitHub API calls (inherits existing auth).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ReviewThread, ReviewComment, ThreadTarget } from '../types/review.js';
import { readReviewSession, writeReviewSession } from './review.js';
import { escapeShellArg } from '../utils/shell-escape.js';
import { generateId } from '../utils/id.js';

const execAsync = promisify(exec);

// ============================================================================
// GitHub API Types (raw shapes returned by `gh api`)
// ============================================================================

interface GitHubPRComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: 'LEFT' | 'RIGHT';
  start_line: number | null;
  original_start_line: number | null;
  diff_hunk: string;
  user: { login: string };
  created_at: string;
  in_reply_to_id?: number | null;
  pull_request_review_id: number;
}

// ============================================================================
// Import from GitHub
// ============================================================================

/**
 * Import PR review comments from GitHub into local threads.
 * Deduplicates by githubId — existing threads are not overwritten.
 *
 * @returns Number of newly imported threads
 */
export async function importGitHubReview(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  prNumber: number
): Promise<{ imported: number; threads: ReviewThread[] }> {
  const owner = await getRepoOwner(workspacePath);
  const repo = await getRepoName(workspacePath);

  // Fetch all review comments from the PR
  const comments = await fetchPRComments(owner, repo, prNumber, workspacePath);

  const session = readReviewSession(workspacePath, workspaceName, baseBranch);

  // Build a set of existing github IDs to avoid duplication
  const existingGithubIds = new Set<number>();
  const threadByRootGithubId = new Map<number, ReviewThread>();
  for (const thread of session.threads) {
    let rootGithubId: number | null = null;
    for (const comment of thread.comments) {
      if (comment.githubId !== undefined) {
        existingGithubIds.add(comment.githubId);
        if (rootGithubId === null) {
          rootGithubId = comment.githubId;
        }
      }
    }
    if (rootGithubId !== null) {
      threadByRootGithubId.set(rootGithubId, thread);
    }
  }

  // Group comments into threads (root comments + replies)
  const roots = comments.filter(c => c.in_reply_to_id == null);
  const replies = comments.filter(c => c.in_reply_to_id != null);

  // Map: root comment id → reply list
  const replyMap = new Map<number, GitHubPRComment[]>();
  for (const reply of replies) {
    const rootId = reply.in_reply_to_id;
    if (rootId == null) {
      continue;
    }
    const list = replyMap.get(rootId) ?? [];
    list.push(reply);
    replyMap.set(rootId, list);
  }

  let imported = 0;

  for (const root of roots) {
    const freshReplies: ReviewComment[] = (replyMap.get(root.id) ?? [])
      .filter(r => !existingGithubIds.has(r.id))
      .map(r => ({
        id: generateId(),
        threadId: '',
        body: r.body,
        author: r.user.login,
        createdAt: r.created_at,
        githubId: r.id,
      }));

    const existingThread = threadByRootGithubId.get(root.id);
    if (existingThread) {
      if (freshReplies.length > 0) {
        for (const reply of freshReplies) {
          existingThread.comments.push({
            ...reply,
            threadId: existingThread.id,
          });
          if (reply.githubId !== undefined) {
            existingGithubIds.add(reply.githubId);
          }
        }

        const newestReply = freshReplies[freshReplies.length - 1];
        existingThread.updatedAt = newestReply?.createdAt ?? new Date().toISOString();
      }
      continue;
    }

    const now = new Date().toISOString();
    const threadId = generateId();

    const rootComment: ReviewComment = {
      id: generateId(),
      threadId,
      body: root.body,
      author: root.user.login,
      createdAt: root.created_at,
      githubId: root.id,
    };

    const replyComments: ReviewComment[] = freshReplies.map((reply) => ({
      ...reply,
      threadId,
    }));

    const target: ThreadTarget = buildTarget(root);

    const thread: ReviewThread = {
      id: threadId,
      target,
      resolved: false,
      comments: [rootComment, ...replyComments],
      createdAt: root.created_at,
      updatedAt: now,
    };

    session.threads.push(thread);
    threadByRootGithubId.set(root.id, thread);
    existingGithubIds.add(root.id);
    for (const reply of replyComments) {
      if (reply.githubId !== undefined) {
        existingGithubIds.add(reply.githubId);
      }
    }
    imported++;
  }

  session.prNumber = prNumber;
  writeReviewSession(workspacePath, workspaceName, session);

  return { imported, threads: session.threads };
}

// ============================================================================
// Push to GitHub
// ============================================================================

/**
 * Push all unresolved threads to GitHub as a PR review.
 *
 * Derives the overall action from hunk decisions:
 *  - Any rejected hunk → REQUEST_CHANGES
 *  - All hunks approved, none rejected → APPROVE
 *  - Otherwise → COMMENT
 *
 * @returns The PR number and URL of the submitted review
 */
export async function pushGitHubReview(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  prNumber: number
): Promise<{ prNumber: number; url: string }> {
  const owner = await getRepoOwner(workspacePath);
  const repo = await getRepoName(workspacePath);

  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const unresolved = session.threads.filter(t => !t.resolved);
  const syncedAt = new Date().toISOString();
  let changed = false;

  // Compute overall review action
  const hunkThreads = unresolved.filter(t => t.target.kind === 'hunk');
  const hasRejection = hunkThreads.some(t => t.decision === 'rejected');
  const allApproved =
    hunkThreads.length > 0 &&
    hunkThreads.every(t => t.decision === 'approved');

  const event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = hasRejection
    ? 'REQUEST_CHANGES'
    : allApproved
      ? 'APPROVE'
      : 'COMMENT';

  const reviewComments: GitHubDraftReviewComment[] = [];
  const reviewCommentIdsByThreadId = new Map<string, string[]>();
  const workspaceNoteBodies: string[] = [];
  const workspaceNoteIdsByThreadId = new Map<string, string[]>();

  for (const thread of unresolved) {
    const pendingLocalComments = thread.comments.filter(isPendingLocalComment);
    if (pendingLocalComments.length === 0) {
      continue;
    }

    const rootGithubCommentId = getRootGithubCommentId(thread);
    if (rootGithubCommentId !== null) {
      for (const comment of pendingLocalComments) {
        const posted = await postPRReply(
          owner,
          repo,
          prNumber,
          rootGithubCommentId,
          comment.body,
          workspacePath
        );
        comment.githubId = posted.id;
        comment.syncedToGitHubAt = syncedAt;
        thread.updatedAt = syncedAt;
        session.prNumber = prNumber;
        writeReviewSession(workspacePath, workspaceName, session);
        changed = true;
      }
      continue;
    }

    const localBodies = pendingLocalComments.map((comment) => comment.body);
    if (thread.target.kind === 'workspace') {
      workspaceNoteBodies.push(localBodies.join('\n\n---\n\n'));
      workspaceNoteIdsByThreadId.set(thread.id, pendingLocalComments.map((comment) => comment.id));
      continue;
    }

    const reviewComment = buildGitHubComment(thread, localBodies);
    if (reviewComment) {
      reviewComments.push(reviewComment);
      reviewCommentIdsByThreadId.set(thread.id, pendingLocalComments.map((comment) => comment.id));
    }
  }

  const workspaceNotes = workspaceNoteBodies.join('\n\n');

  const bodyParts: string[] = [];
  if (workspaceNotes) {
    bodyParts.push('**General notes:**\n\n' + workspaceNotes);
  }

  let url = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  if (reviewComments.length > 0 || bodyParts.length > 0) {
    const reviewBody = bodyParts.join('\n\n') || 'Review submitted via gssh.';

    const reviewData = await submitPullReview(
      owner,
      repo,
      prNumber,
      {
        body: reviewBody,
        event,
        comments: reviewComments,
      },
      workspacePath
    );

    url =
      reviewData.html_url ??
      `https://github.com/${owner}/${repo}/pull/${prNumber}#pullrequestreview-${reviewData.id}`;

    for (const thread of unresolved) {
      const reviewCommentIds = reviewCommentIdsByThreadId.get(thread.id) ?? [];
      const workspaceNoteIds = workspaceNoteIdsByThreadId.get(thread.id) ?? [];
      const syncedIds = new Set([...reviewCommentIds, ...workspaceNoteIds]);
      if (syncedIds.size === 0) {
        continue;
      }

      markThreadCommentsSynced(thread, syncedIds, syncedAt);
      thread.updatedAt = syncedAt;
      changed = true;
    }
  }

  if (changed) {
    session.prNumber = prNumber;
    writeReviewSession(workspacePath, workspaceName, session);
  }

  return { prNumber, url };
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchPRComments(
  owner: string,
  repo: string,
  prNumber: number,
  cwd: string
): Promise<GitHubPRComment[]> {
  const commentsEndpoint = `repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const { stdout } = await execAsync(
    `gh api ${escapeShellArg(commentsEndpoint)} --paginate --slurp`,
    { cwd }
  );
  const parsed = JSON.parse(stdout) as unknown;

  if (!Array.isArray(parsed)) {
    return [];
  }

  if (parsed.length === 0) {
    return [];
  }

  if (Array.isArray(parsed[0])) {
    return (parsed as GitHubPRComment[][]).flat();
  }

  return parsed as GitHubPRComment[];
}

async function getRepoOwner(cwd: string): Promise<string> {
  const { stdout } = await execAsync(
    "gh repo view --json owner --jq '.owner.login'",
    { cwd }
  );
  return stdout.trim();
}

async function getRepoName(cwd: string): Promise<string> {
  const { stdout } = await execAsync(
    "gh repo view --json name --jq '.name'",
    { cwd }
  );
  return stdout.trim();
}

/** Build a ThreadTarget from a GitHub PR comment */
function buildTarget(comment: GitHubPRComment): ThreadTarget {
  const line = comment.line ?? comment.original_line;

  // Extract hunk header from diff_hunk
  const hunkHeaderMatch = comment.diff_hunk.match(/^(@@ [^@]+ @@[^\n]*)/m);
  if (hunkHeaderMatch && line !== null) {
    const startLine = comment.start_line ?? comment.original_start_line ?? line;

    // We prefer line-level targeting so the annotation is precise
    return {
      kind: 'line',
      file: comment.path,
      startLine,
      endLine: line,
      side: comment.side ?? 'RIGHT',
    };
  }

  return {
    kind: 'file',
    file: comment.path,
  };
}

/** Build a GitHub PR review comment from a local thread */
function buildGitHubComment(
  thread: ReviewThread,
  bodies: string[]
): GitHubDraftReviewComment | null {
  const body = bodies.join('\n\n---\n\n');

  if (thread.target.kind === 'line') {
    const payload: GitHubDraftReviewComment = {
      path: thread.target.file,
      line: thread.target.endLine,
      side: thread.target.side,
      body,
    };
    if (thread.target.startLine !== thread.target.endLine) {
      payload.start_line = thread.target.startLine;
      payload.start_side = thread.target.side;
    }
    return payload;
  }

  if (thread.target.kind === 'hunk') {
    // For hunk-level threads, we can only submit as a file comment at line 1
    // GitHub doesn't have a hunk-level comment concept natively
    const decisionPrefix =
      thread.decision === 'approved'
        ? '✅ **Approved**\n\n'
        : thread.decision === 'rejected'
          ? '❌ **Rejected**\n\n'
          : '';
    return {
      path: thread.target.file,
      line: 1,
      side: 'RIGHT',
      body: decisionPrefix + body,
    };
  }

  if (thread.target.kind === 'file') {
    return {
      path: thread.target.file,
      line: 1,
      side: 'RIGHT',
      body,
    };
  }

  // workspace-level threads go in the review body — handled separately
  return null;
}

function isPendingLocalComment(comment: ReviewComment): boolean {
  return (
    comment.author === 'local' &&
    comment.githubId === undefined &&
    !comment.syncedToGitHubAt
  );
}

function getRootGithubCommentId(thread: ReviewThread): number | null {
  const rootComment = thread.comments[0];
  return rootComment?.githubId ?? null;
}

function markThreadCommentsSynced(
  thread: ReviewThread,
  commentIds: Set<string>,
  syncedAt: string
): void {
  for (const comment of thread.comments) {
    if (commentIds.has(comment.id)) {
      comment.syncedToGitHubAt = syncedAt;
    }
  }
}

async function postPRReply(
  owner: string,
  repo: string,
  prNumber: number,
  inReplyTo: number,
  body: string,
  cwd: string
): Promise<{ id: number; html_url?: string }> {
  const endpoint = `repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const payload = {
    body,
    in_reply_to: inReplyTo,
  };
  const response = await postGitHubApi(endpoint, payload, cwd);
  return JSON.parse(response) as { id: number; html_url?: string };
}

async function submitPullReview(
  owner: string,
  repo: string,
  prNumber: number,
  payload: {
    body: string;
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    comments: GitHubDraftReviewComment[];
  },
  cwd: string
): Promise<{ id: number; html_url?: string }> {
  const endpoint = `repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  const response = await postGitHubApi(endpoint, payload, cwd);
  return JSON.parse(response) as { id: number; html_url?: string };
}

interface GitHubDraftReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT' | string;
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT' | string;
}

async function postGitHubApi(endpoint: string, payload: object, cwd: string): Promise<string> {
  const tmpFile = join(tmpdir(), `gssh-review-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');
    const { stdout } = await execAsync(
      `gh api ${escapeShellArg(endpoint)} --method POST --input ${escapeShellArg(tmpFile)}`,
      { cwd }
    );
    return stdout;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
