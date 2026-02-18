/** @jsxImportSource react */
/**
 * useReview — React hook for the review system.
 *
 * Calls terminal.sendReviewRequest() over the existing encrypted WebSocket
 * channel and manages local state for threads, diff, and loading.
 */

import { useState, useCallback } from 'react';
import type { ReviewThread, ThreadTarget, HunkDecision, ReviewOperation } from '../types/review.js';

export interface UseReviewOptions {
  sendReviewRequest: (operation: ReviewOperation) => Promise<import('../types/review.js').ReviewResult>;
  projectName: string;
  workspaceName: string;
}

export interface UseReviewReturn {
  /** All review threads for this workspace */
  threads: ReviewThread[];
  /** The raw unified diff text */
  diff: string | null;
  /** Base branch (e.g. "main") */
  baseBranch: string | null;
  /** Current branch */
  headBranch: string | null;
  /** True while any operation is in flight */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;

  /** Load threads from the machine */
  loadThreads: () => Promise<void>;
  /** Load the current diff from the machine */
  loadDiff: () => Promise<void>;

  /** Create a new thread */
  createThread: (target: ThreadTarget, body: string, decision?: HunkDecision) => Promise<void>;
  /** Add a reply to an existing thread */
  addReply: (threadId: string, body: string) => Promise<void>;
  /** Update thread properties (resolve/unresolve, change hunk decision) */
  updateThread: (threadId: string, updates: { resolved?: boolean; decision?: HunkDecision }) => Promise<void>;
  /** Update the body of a specific comment */
  updateComment: (threadId: string, commentId: string, body: string) => Promise<void>;
  /** Delete a comment */
  deleteComment: (threadId: string, commentId: string) => Promise<void>;
  /** Import GitHub PR review comments */
  importGitHub: (prNumber?: number) => Promise<{ imported: number }>;
  /** Push local review to GitHub as a formal PR review */
  pushGitHub: (prNumber?: number) => Promise<{ prNumber: number; url: string }>;
}

export function useReview({ sendReviewRequest, projectName, workspaceName }: UseReviewOptions): UseReviewReturn {
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [headBranch, setHeadBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setLoading(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadThreads = useCallback(async () => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'get_threads',
        projectName,
        workspaceName,
      });
      if (result.op === 'threads') {
        setThreads(result.threads);
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const loadDiff = useCallback(async () => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'get_diff',
        projectName,
        workspaceName,
      });
      if (result.op === 'diff') {
        setDiff(result.diff);
        setBaseBranch(result.baseBranch);
        setHeadBranch(result.headBranch);
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const createThread = useCallback(async (
    target: ThreadTarget,
    body: string,
    decision?: HunkDecision
  ) => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'create_thread',
        projectName,
        workspaceName,
        target,
        body,
        decision,
      });
      if (result.op === 'thread_created') {
        setThreads((prev) => [...prev, result.thread]);
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const addReply = useCallback(async (threadId: string, body: string) => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'add_reply',
        projectName,
        workspaceName,
        threadId,
        body,
      });
      if (result.op === 'comment_added') {
        setThreads((prev) => prev.map((t) => t.id === threadId ? result.thread : t));
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const updateThread = useCallback(async (
    threadId: string,
    updates: { resolved?: boolean; decision?: HunkDecision }
  ) => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'update_thread',
        projectName,
        workspaceName,
        threadId,
        ...updates,
      });
      if (result.op === 'thread_updated') {
        setThreads((prev) => prev.map((t) => t.id === threadId ? result.thread : t));
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const updateComment = useCallback(async (
    threadId: string,
    commentId: string,
    body: string
  ) => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'update_comment',
        projectName,
        workspaceName,
        threadId,
        commentId,
        body,
      });
      if (result.op === 'comment_updated') {
        setThreads((prev) => prev.map((t) => t.id === threadId ? result.thread : t));
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const deleteComment = useCallback(async (threadId: string, commentId: string) => {
    await run(async () => {
      const result = await sendReviewRequest({
        op: 'delete_comment',
        projectName,
        workspaceName,
        threadId,
        commentId,
      });
      if (result.op === 'comment_deleted') {
        // When the last comment is deleted, the server removes the whole thread
        // and returns a stub with comments: []. Filter it out rather than keeping
        // a zombie thread in state.
        if (result.thread.comments.length === 0) {
          setThreads((prev) => prev.filter((t) => t.id !== threadId));
        } else {
          setThreads((prev) => prev.map((t) => t.id === threadId ? result.thread : t));
        }
      }
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const importGitHub = useCallback(async (prNumber?: number): Promise<{ imported: number }> => {
    return run(async () => {
      const result = await sendReviewRequest({
        op: 'import_github',
        projectName,
        workspaceName,
        prNumber,
      });
      if (result.op === 'github_imported') {
        setThreads(result.threads);
        return { imported: result.imported };
      }
      return { imported: 0 };
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  const pushGitHub = useCallback(async (prNumber?: number): Promise<{ prNumber: number; url: string }> => {
    return run(async () => {
      const result = await sendReviewRequest({
        op: 'push_github',
        projectName,
        workspaceName,
        prNumber,
      });
      if (result.op === 'github_pushed') {
        return { prNumber: result.prNumber, url: result.url };
      }
      throw new Error('Unexpected response from push_github');
    });
  }, [run, sendReviewRequest, projectName, workspaceName]);

  return {
    threads,
    diff,
    baseBranch,
    headBranch,
    loading,
    error,
    loadThreads,
    loadDiff,
    createThread,
    addReply,
    updateThread,
    updateComment,
    deleteComment,
    importGitHub,
    pushGitHub,
  };
}
