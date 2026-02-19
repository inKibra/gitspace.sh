/**
 * Core review operations
 *
 * Manages ReviewThread storage in <workspace>/.gitspace/review/<workspaceName>/notes.json
 * Threads are namespaced by workspace name so that workspaces branched from each
 * other don't share the same thread store.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { confirm } from '@inquirer/prompts';
import type {
  ReviewSession,
  ReviewThread,
  ReviewComment,
  ThreadTarget,
  HunkDecision,
} from '../types/review.js';
import { generateId } from '../utils/id.js';

const execAsync = promisify(exec);

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Returns the directory where review notes are stored for this workspace.
 * Path: <workspacePath>/.gitspace/review/<workspaceName>/
 */
export function getReviewDir(workspacePath: string, workspaceName: string): string {
  return join(workspacePath, '.gitspace', 'review', workspaceName);
}

/**
 * Returns the path to the notes.json file for this workspace.
 */
export function getNotesPath(workspacePath: string, workspaceName: string): string {
  return join(getReviewDir(workspacePath, workspaceName), 'notes.json');
}

// ============================================================================
// Session Read / Write
// ============================================================================

/**
 * Read the review session from disk. Returns a fresh session if none exists.
 */
export function readReviewSession(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string
): ReviewSession {
  const notesPath = getNotesPath(workspacePath, workspaceName);

  if (!existsSync(notesPath)) {
    return createEmptySession(workspaceName, baseBranch);
  }

  try {
    const raw = readFileSync(notesPath, 'utf-8');
    const parsed = JSON.parse(raw) as ReviewSession;
    return parsed;
  } catch {
    return createEmptySession(workspaceName, baseBranch);
  }
}

/**
 * Write the review session to disk, creating directories as needed.
 */
export function writeReviewSession(
  workspacePath: string,
  workspaceName: string,
  session: ReviewSession
): void {
  const notesPath = getNotesPath(workspacePath, workspaceName);
  const dir = dirname(notesPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const updated: ReviewSession = {
    ...session,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(notesPath, JSON.stringify(updated, null, 2), 'utf-8');
}

function createEmptySession(workspaceName: string, baseBranch: string): ReviewSession {
  const now = new Date().toISOString();
  return {
    version: '1.0',
    workspaceName,
    baseBranch,
    prNumber: null,
    threads: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Thread CRUD
// ============================================================================

/**
 * Get all threads for a workspace.
 */
export function getThreads(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string
): ReviewThread[] {
  return readReviewSession(workspacePath, workspaceName, baseBranch).threads;
}

/**
 * Create a new thread with an initial comment.
 */
export async function createThread(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  target: ThreadTarget,
  body: string,
  decision?: HunkDecision,
  author = 'local'
): Promise<ReviewThread> {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const now = new Date().toISOString();

  const threadId = generateId();
  const commentId = generateId();

  const comment: ReviewComment = {
    id: commentId,
    threadId,
    body,
    author,
    createdAt: now,
  };

  const thread: ReviewThread = {
    id: threadId,
    target,
    decision: target.kind === 'hunk' ? (decision ?? 'pending') : undefined,
    resolved: false,
    comments: [comment],
    createdAt: now,
    updatedAt: now,
  };

  session.threads.push(thread);

  // First-time .gitignore prompt
  await ensureGitignore(workspacePath, workspaceName);

  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

/**
 * Add a reply to an existing thread.
 */
export function addReply(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  threadId: string,
  body: string,
  author = 'local'
): ReviewThread {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const thread = session.threads.find(t => t.id === threadId);

  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: generateId(),
    threadId,
    body,
    author,
    createdAt: now,
  };

  thread.comments.push(comment);
  thread.updatedAt = now;

  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

/**
 * Update a thread's resolved status or hunk decision.
 */
export function updateThread(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  threadId: string,
  updates: { resolved?: boolean; decision?: HunkDecision }
): ReviewThread {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const thread = session.threads.find(t => t.id === threadId);

  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  if (updates.resolved !== undefined) {
    thread.resolved = updates.resolved;
  }

  if (updates.decision !== undefined && thread.target.kind === 'hunk') {
    thread.decision = updates.decision;
  }

  thread.updatedAt = new Date().toISOString();

  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

/**
 * Update the body of a specific comment in a thread.
 */
export function updateComment(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  threadId: string,
  commentId: string,
  body: string
): ReviewThread {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const thread = session.threads.find(t => t.id === threadId);

  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const comment = thread.comments.find(c => c.id === commentId);
  if (!comment) {
    throw new Error(`Comment not found: ${commentId}`);
  }

  comment.body = body;
  if (comment.author === 'local' && comment.githubId === undefined) {
    delete comment.syncedToGitHubAt;
  }
  thread.updatedAt = new Date().toISOString();

  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

/**
 * Delete a specific comment from a thread.
 * If it's the only comment in the thread, the thread itself is deleted.
 * Returns the updated thread, or null if the thread was deleted.
 */
export function deleteComment(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  threadId: string,
  commentId: string
): ReviewThread | null {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const threadIndex = session.threads.findIndex(t => t.id === threadId);

  if (threadIndex === -1) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const thread = session.threads[threadIndex];
  const commentIndex = thread.comments.findIndex(c => c.id === commentId);

  if (commentIndex === -1) {
    throw new Error(`Comment not found: ${commentId}`);
  }

  thread.comments.splice(commentIndex, 1);

  // If no comments remain, delete the whole thread
  if (thread.comments.length === 0) {
    session.threads.splice(threadIndex, 1);
    writeReviewSession(workspacePath, workspaceName, session);
    return null;
  }

  thread.updatedAt = new Date().toISOString();
  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

// ============================================================================
// .gitignore Management
// ============================================================================

const GITIGNORE_ENTRY = '.gitspace/review/';
const GITIGNORE_MARKER = '# gssh review — workspace review notes';

/**
 * Ensure that .gitspace/review/ is handled appropriately in .gitignore.
 * On first note creation, prompts the user whether to gitignore or commit.
 * Remembers the choice in a local marker file so it's not asked again.
 */
async function ensureGitignore(workspacePath: string, workspaceName: string): Promise<void> {
  const reviewDir = getReviewDir(workspacePath, workspaceName);
  const markerPath = join(reviewDir, '.gitignore-decided');

  // Already decided — skip
  if (existsSync(markerPath)) return;

  const gitignorePath = join(workspacePath, '.gitignore');
  const alreadyIgnored =
    existsSync(gitignorePath) &&
    readFileSync(gitignorePath, 'utf-8').includes(GITIGNORE_ENTRY);

  if (alreadyIgnored) {
    // Already ignored — write marker and return
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, 'gitignored\n', 'utf-8');
    return;
  }

  let keepPrivate = true;

  // Only prompt when running interactively (stdin is a TTY).
  // When called from the serve daemon there is no TTY, so we silently
  // default to keeping notes private.
  const isTTY = Boolean(process.stdin.isTTY);
  if (isTTY) {
    try {
      keepPrivate = await confirm({
        message:
          'Review notes found. Keep them private (add to .gitignore) or share with the team (commit alongside branch)?',
        default: true,
      });
    } catch {
      // Prompt cancelled or non-interactive — default to private
      keepPrivate = true;
    }
  }

  if (keepPrivate) {
    appendFileSync(
      gitignorePath,
      `\n${GITIGNORE_MARKER}\n${GITIGNORE_ENTRY}\n`,
      'utf-8'
    );
  }

  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, keepPrivate ? 'gitignored\n' : 'committed\n', 'utf-8');
}

// ============================================================================
// Workspace Detection
// ============================================================================

/**
 * Detect the PR number associated with the current workspace branch
 * by using `gh pr view`.
 */
export async function detectPRNumber(workspacePath: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync('gh pr view --json number --jq .number', {
      cwd: workspacePath,
    });
    const num = parseInt(stdout.trim(), 10);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
}
