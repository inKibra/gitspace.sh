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
import {
  prepareReviewStorage,
  readReviewSession,
  writeReviewSession,
  type ReviewWriteOptions,
} from './review.js';
import { escapeShellArg } from '../utils/shell-escape.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';

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
  start_side?: 'LEFT' | 'RIGHT' | null;
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
  prNumber: number,
  options: ReviewWriteOptions = {}
): Promise<{ imported: number; threads: ReviewThread[] }> {
  const owner = await getRepoOwner(workspacePath);
  const repo = await getRepoName(workspacePath);

  // Fetch all review comments from the PR
  const comments = await fetchPRComments(owner, repo, prNumber, workspacePath);

  await prepareReviewStorage(workspacePath, workspaceName, options);

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
  let url = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

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
  const reviewCommentDraftByThreadId = new Map<string, GitHubDraftReviewComment>();
  const workspaceNoteBodies: string[] = [];
  const workspaceNoteIdsByThreadId = new Map<string, string[]>();
  let pushedPendingHunkTopLevel = false;
  let pullHeadSha: string | null = null;

  const resolvePullHeadSha = async (): Promise<string> => {
    if (pullHeadSha !== null) {
      return pullHeadSha;
    }
    pullHeadSha = await getPullHeadSha(owner, repo, prNumber, workspacePath);
    return pullHeadSha;
  };

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

    if (thread.target.kind === 'file' || thread.target.kind === 'hunk') {
      const topLevelComment = buildGitHubTopLevelComment(
        thread,
        localBodies,
        await resolvePullHeadSha()
      );

      if (topLevelComment) {
        const posted = await postPRTopLevelComment(
          owner,
          repo,
          prNumber,
          topLevelComment,
          workspacePath
        );

        markThreadCommentsSynced(
          thread,
          new Set(pendingLocalComments.map((comment) => comment.id)),
          syncedAt,
          posted.id
        );
        thread.updatedAt = syncedAt;
        session.prNumber = prNumber;
        writeReviewSession(workspacePath, workspaceName, session);
        if (posted.html_url) {
          url = posted.html_url;
        }
        if (thread.target.kind === 'hunk') {
          pushedPendingHunkTopLevel = true;
        }
        changed = true;
      }
      continue;
    }

    if (thread.target.kind !== 'line') {
      continue;
    }

    const reviewComment = buildGitHubLineComment(thread, localBodies);
    reviewComments.push(reviewComment);
    reviewCommentIdsByThreadId.set(thread.id, pendingLocalComments.map((comment) => comment.id));
    reviewCommentDraftByThreadId.set(thread.id, reviewComment);
  }

  const workspaceNotes = workspaceNoteBodies.join('\n\n');

  const bodyParts: string[] = [];
  if (workspaceNotes) {
    bodyParts.push('**General notes:**\n\n' + workspaceNotes);
  }

  const shouldSubmitFormalReview =
    reviewComments.length > 0 ||
    bodyParts.length > 0 ||
    (event !== 'COMMENT' && pushedPendingHunkTopLevel);

  if (shouldSubmitFormalReview) {
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

    const reviewCommentGithubIdsByKey = new Map<string, number[]>();
    if (reviewComments.length > 0) {
      try {
        const postedReviewComments = await fetchReviewCommentsForReview(
          owner,
          repo,
          prNumber,
          reviewData.id,
          workspacePath
        );
        for (const comment of postedReviewComments) {
          const key = buildReviewCommentMatchKey(comment);
          const ids = reviewCommentGithubIdsByKey.get(key) ?? [];
          ids.push(comment.id);
          reviewCommentGithubIdsByKey.set(key, ids);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warning(`Could not map GitHub review comment IDs: ${message}`);
      }
    }

    for (const thread of unresolved) {
      const reviewCommentIds = reviewCommentIdsByThreadId.get(thread.id) ?? [];
      const workspaceNoteIds = workspaceNoteIdsByThreadId.get(thread.id) ?? [];
      const syncedIds = new Set([...reviewCommentIds, ...workspaceNoteIds]);
      if (syncedIds.size === 0) {
        continue;
      }

      let githubId: number | undefined;
      if (reviewCommentIds.length > 0) {
        const draft = reviewCommentDraftByThreadId.get(thread.id);
        if (draft) {
          const key = buildReviewCommentMatchKey(draft);
          const ids = reviewCommentGithubIdsByKey.get(key);
          if (ids && ids.length > 0) {
            githubId = ids.shift();
            if (ids.length === 0) {
              reviewCommentGithubIdsByKey.delete(key);
            }
          }
        }
      }

      markThreadCommentsSynced(thread, syncedIds, syncedAt, githubId);
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

/** Build a line-anchored GitHub PR review comment from a local line thread */
function buildGitHubLineComment(
  thread: ReviewThread,
  bodies: string[]
): GitHubDraftReviewComment {
  if (thread.target.kind !== 'line') {
    throw new Error(`Expected line target thread, got: ${thread.target.kind}`);
  }

  const body = bodies.join('\n\n---\n\n');

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
  syncedAt: string,
  githubId?: number
): void {
  let githubIdAssigned = false;
  for (const comment of thread.comments) {
    if (commentIds.has(comment.id)) {
      comment.syncedToGitHubAt = syncedAt;
      if (!githubIdAssigned && githubId !== undefined && comment.githubId === undefined) {
        comment.githubId = githubId;
        githubIdAssigned = true;
      }
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

async function fetchReviewCommentsForReview(
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  cwd: string
): Promise<GitHubPRComment[]> {
  const endpoint = `repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`;
  const { stdout } = await execAsync(
    `gh api ${escapeShellArg(endpoint)} --paginate --slurp`,
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

function buildReviewCommentMatchKey(comment: {
  path: string;
  line: number | null;
  side?: string | null;
  start_line?: number | null;
  start_side?: string | null;
  body: string;
}): string {
  return [
    comment.path,
    String(comment.line ?? ''),
    String(comment.side ?? ''),
    String(comment.start_line ?? ''),
    String(comment.start_side ?? ''),
    comment.body,
  ].join('|');
}

interface GitHubDraftReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT' | string;
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT' | string;
}

interface GitHubTopLevelPRComment {
  body: string;
  commit_id: string;
  path: string;
  subject_type?: 'file';
  line?: number;
  side?: 'LEFT' | 'RIGHT';
}

interface HunkAnchor {
  line: number;
  side: 'LEFT' | 'RIGHT';
}

function parseHunkAnchor(hunkHeader: string): HunkAnchor | null {
  const match = hunkHeader.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);
  if (!match) {
    return null;
  }

  const oldStart = parseInt(match[1] ?? '', 10);
  const oldCount = parseInt(match[2] ?? '1', 10);
  const newStart = parseInt(match[3] ?? '', 10);
  const newCount = parseInt(match[4] ?? '1', 10);

  if (Number.isNaN(oldStart) || Number.isNaN(oldCount) || Number.isNaN(newStart) || Number.isNaN(newCount)) {
    return null;
  }

  if (newCount > 0) {
    return { line: newStart + newCount - 1, side: 'RIGHT' };
  }

  if (oldCount > 0) {
    return { line: oldStart + oldCount - 1, side: 'LEFT' };
  }

  return null;
}

function buildGitHubTopLevelComment(
  thread: ReviewThread,
  bodies: string[],
  commitSha: string
): GitHubTopLevelPRComment | null {
  const body = bodies.join('\n\n---\n\n');

  if (thread.target.kind === 'file') {
    return {
      path: thread.target.file,
      commit_id: commitSha,
      subject_type: 'file',
      body,
    };
  }

  if (thread.target.kind === 'hunk') {
    const decisionPrefix =
      thread.decision === 'approved'
        ? '✅ **Approved**\n\n'
        : thread.decision === 'rejected'
          ? '❌ **Rejected**\n\n'
          : '';
    const finalBody = decisionPrefix + body;
    const anchor = parseHunkAnchor(thread.target.hunkHeader);

    if (!anchor) {
      return {
        path: thread.target.file,
        commit_id: commitSha,
        subject_type: 'file',
        body: finalBody,
      };
    }

    return {
      path: thread.target.file,
      commit_id: commitSha,
      line: anchor.line,
      side: anchor.side,
      body: finalBody,
    };
  }

  return null;
}

async function getPullHeadSha(
  owner: string,
  repo: string,
  prNumber: number,
  cwd: string
): Promise<string> {
  const endpoint = `repos/${owner}/${repo}/pulls/${prNumber}`;
  const { stdout } = await execAsync(
    `gh api ${escapeShellArg(endpoint)} --jq '.head.sha'`,
    { cwd }
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Could not resolve head SHA for PR #${prNumber}`);
  }

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { head?: { sha?: string } };
    const sha = parsed.head?.sha?.trim();
    if (sha) {
      return sha;
    }
    throw new Error(`Could not resolve head SHA for PR #${prNumber}`);
  }

  return trimmed;
}

async function postPRTopLevelComment(
  owner: string,
  repo: string,
  prNumber: number,
  payload: GitHubTopLevelPRComment,
  cwd: string
): Promise<{ id: number; html_url?: string }> {
  const endpoint = `repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const response = await postGitHubApi(endpoint, payload, cwd);
  return JSON.parse(response) as { id: number; html_url?: string };
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
