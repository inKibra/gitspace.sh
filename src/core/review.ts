/**
 * Core review operations
 *
 * Manages ReviewThread storage in <workspace>/.gitspace/workspace/<workspaceName>/review.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  ReviewSession,
  ReviewThread,
  ReviewComment,
  ThreadTarget,
  HunkDecision,
  HunkTarget,
} from '../types/review.js';
import { generateId } from '../utils/id.js';
import { SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { ensureWorkspaceStorageIgnored, getWorkspaceReviewPath } from './workspace-metadata.js';

const execAsync = promisify(exec);

export interface ReviewWriteOptions {
  allowPrompt?: boolean;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Returns the path to the review.json file for this workspace.
 */
function getNotesPath(workspacePath: string, workspaceName: string): string {
  return getWorkspaceReviewPath(workspacePath, workspaceName);
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
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;

    if (code === 'ENOENT') {
      return createEmptySession(workspaceName, baseBranch);
    }

    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof SyntaxError) {
      logger.error(`Failed to parse review notes at ${notesPath}: ${message}`);
      throw new SpacesError(`Corrupted review notes at ${notesPath}: ${message}`, 'USER_ERROR', 1);
    }

    logger.error(`Failed to read review notes at ${notesPath}: ${message}`);
    if (error instanceof Error) {
      throw error;
    }

    throw new SpacesError(`Failed to read review notes at ${notesPath}: ${message}`, 'SYSTEM_ERROR', 2);
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
  author = 'local',
  options: ReviewWriteOptions = {}
): Promise<ReviewThread> {
  // Ensure .gitignore decision is handled before reading/writing session state so
  // concurrent CRUD writes cannot be overwritten after an async gap.
  await prepareReviewStorage(workspacePath, workspaceName, options);

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
    throw new SpacesError(`Thread not found: ${threadId}`, 'USER_ERROR', 1);
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
    throw new SpacesError(`Thread not found: ${threadId}`, 'USER_ERROR', 1);
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

export async function approveHunk(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  target: HunkTarget,
  author = 'local',
  options: ReviewWriteOptions = {},
): Promise<ReviewThread> {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const existing = session.threads.find((thread) => (
    thread.target.kind === 'hunk' &&
    thread.target.file === target.file &&
    thread.target.hunkHeader === target.hunkHeader
  ));

  if (existing) {
    if (existing.decision !== 'approved') {
      existing.decision = 'approved';
      existing.updatedAt = new Date().toISOString();
      writeReviewSession(workspacePath, workspaceName, session);
    }
    return existing;
  }

  return createThread(
    workspacePath,
    workspaceName,
    baseBranch,
    target,
    'Approved hunk via folder approval shortcut.',
    'approved',
    author,
    options,
  );
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
    throw new SpacesError(`Thread not found: ${threadId}`, 'USER_ERROR', 1);
  }

  const comment = thread.comments.find(c => c.id === commentId);
  if (!comment) {
    throw new SpacesError(`Comment not found: ${commentId}`, 'USER_ERROR', 1);
  }

  comment.body = body;
  thread.updatedAt = new Date().toISOString();

  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

/**
 * Delete a specific comment from a thread.
 * If it's the only comment in the thread, the thread itself is deleted.
 * Returns the updated thread snapshot. If the last comment is deleted,
 * the returned thread keeps its original target metadata and has comments: [].
 */
export function deleteComment(
  workspacePath: string,
  workspaceName: string,
  baseBranch: string,
  threadId: string,
  commentId: string
): ReviewThread {
  const session = readReviewSession(workspacePath, workspaceName, baseBranch);
  const threadIndex = session.threads.findIndex(t => t.id === threadId);

  if (threadIndex === -1) {
    throw new SpacesError(`Thread not found: ${threadId}`, 'USER_ERROR', 1);
  }

  const thread = session.threads[threadIndex];
  const commentIndex = thread.comments.findIndex(c => c.id === commentId);

  if (commentIndex === -1) {
    throw new SpacesError(`Comment not found: ${commentId}`, 'USER_ERROR', 1);
  }

  thread.comments.splice(commentIndex, 1);
  thread.updatedAt = new Date().toISOString();

  // If no comments remain, delete the whole thread
  if (thread.comments.length === 0) {
    session.threads.splice(threadIndex, 1);
    writeReviewSession(workspacePath, workspaceName, session);
    return thread;
  }

  writeReviewSession(workspacePath, workspaceName, session);
  return thread;
}

// ============================================================================
// .gitignore Management
// ============================================================================

async function ensureGitignore(
  workspacePath: string,
  _workspaceName: string,
  options: ReviewWriteOptions = {}
): Promise<void> {
  void options;
  ensureWorkspaceStorageIgnored(workspacePath);
}

export async function prepareReviewStorage(
  workspacePath: string,
  workspaceName: string,
  options: ReviewWriteOptions = {}
): Promise<void> {
  await ensureGitignore(workspacePath, workspaceName, options);
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
