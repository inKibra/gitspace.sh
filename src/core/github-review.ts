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
  in_reply_to_id?: number;
  pull_request_review_id: number;
}

interface GitHubReview {
  id: number;
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  user: { login: string };
  submitted_at: string;
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
  const comments = await fetchPRComments(owner, repo, prNumber);

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
  const roots = comments.filter(c => !c.in_reply_to_id);
  const replies = comments.filter(c => c.in_reply_to_id !== undefined);

  // Map: root comment id → reply list
  const replyMap = new Map<number, GitHubPRComment[]>();
  for (const reply of replies) {
    const rootId = reply.in_reply_to_id!;
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

  // Build review comments (only threads that can be mapped to a file+line)
  const reviewComments = unresolved
    .filter(t => t.target.kind !== 'workspace')
    .map(t => buildGitHubComment(t))
    .filter(Boolean);

  // Collect workspace-level threads as PR body additions
  const workspaceNotes = unresolved
    .filter(t => t.target.kind === 'workspace')
    .map(t => t.comments[0]?.body ?? '')
    .filter(Boolean)
    .join('\n\n');

  const bodyParts: string[] = [];
  if (workspaceNotes) {
    bodyParts.push('**General notes:**\n\n' + workspaceNotes);
  }

  const reviewBody = bodyParts.join('\n\n') || 'Review submitted via gssh.';

  // Submit via `gh api`
  const payload = {
    body: reviewBody,
    event,
    comments: reviewComments,
  };

  // Write payload to temp file for `gh api --input`
  const tmpFile = join(tmpdir(), `gssh-review-${Date.now()}.json`);
  let rawStdout = '';
  try {
    writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');
    const result = await execAsync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/reviews --method POST --input ${JSON.stringify(tmpFile)}`,
      { cwd: workspacePath }
    );
    rawStdout = result.stdout;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  const reviewData = JSON.parse(rawStdout) as { id: number; html_url?: string };
  const url =
    reviewData.html_url ??
    `https://github.com/${owner}/${repo}/pull/${prNumber}#pullrequestreview-${reviewData.id}`;

  return { prNumber, url };
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchPRComments(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubPRComment[]> {
  const { stdout } = await execAsync(
    `gh api repos/${owner}/${repo}/pulls/${prNumber}/comments --paginate`
  );
  return JSON.parse(stdout) as GitHubPRComment[];
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
  const line = comment.line ?? comment.original_line ?? 1;
  const startLine = comment.start_line ?? comment.original_start_line ?? line;

  // Extract hunk header from diff_hunk
  const hunkHeaderMatch = comment.diff_hunk.match(/^(@@ [^@]+ @@[^\n]*)/m);
  if (hunkHeaderMatch) {
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
  thread: ReviewThread
): { path: string; line: number; side: string; body: string } | null {
  const body = thread.comments.map(c => c.body).join('\n\n---\n\n');

  if (thread.target.kind === 'line') {
    return {
      path: thread.target.file,
      line: thread.target.endLine,
      side: thread.target.side,
      body,
    };
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

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
