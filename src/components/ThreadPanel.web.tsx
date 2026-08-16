/** @jsxImportSource react */
/**
 * ThreadPanel — right-side panel listing all review threads.
 *
 * Shows thread targets, decisions, comments, and allows:
 * - Resolving/unresolving threads
 * - Adding replies
 * - Editing/deleting own comments
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { ReviewThread, HunkDecision } from '../types/review.js';
import type { HunkFocusTarget } from './DiffViewer.web.js';
import { normalizeHunkHeader } from '../utils/hunk-header.js';
import { REVIEW_DECISION_COLORS } from './review-decision-colors.js';
import { CommentComposer, ReviewCommentList } from './review-comment-ui.web.js';

export interface ThreadPanelProps {
  threads: ReviewThread[];
  currentFilePath?: string | null;
  hunkFocus?: HunkFocusTarget | null;
  filterMode?: 'all' | 'current-file' | 'current-hunk';
  onFilterModeChange?: (mode: 'all' | 'current-file' | 'current-hunk') => void;
  selectedThreadId?: string | null;
  hoveredThreadId?: string | null;
  onResolveThread: (threadId: string, resolved: boolean) => Promise<void>;
  onAddReply: (threadId: string, body: string) => Promise<void>;
  onUpdateComment: (threadId: string, commentId: string, body: string) => Promise<void>;
  onDeleteComment: (threadId: string, commentId: string) => Promise<void>;
  onUpdateDecision: (threadId: string, decision: HunkDecision) => Promise<void>;
  onOpenThreadTarget?: (threadId: string) => void;
  /** Route a finding to the workspace's agent ('✦ Send to agent → fix'). */
  onSendToAgent?: (thread: ReviewThread) => Promise<void> | void;
  onClose?: () => void;
}

function targetLabel(thread: ReviewThread): string {
  const t = thread.target;
  if (t.kind === 'hunk') return `Hunk · ${t.file.split('/').pop()}`;
  if (t.kind === 'line') return `L${t.startLine}–${t.endLine} · ${t.file.split('/').pop()}`;
  if (t.kind === 'file') return `File · ${t.file.split('/').pop()}`;
  return 'Overall';
}

export function ThreadPanel({
  threads,
  currentFilePath,
  hunkFocus,
  filterMode = 'all',
  onFilterModeChange,
  selectedThreadId,
  hoveredThreadId,
  onResolveThread,
  onSendToAgent,
  onAddReply,
  onUpdateComment,
  onDeleteComment,
  onUpdateDecision,
  onOpenThreadTarget,
  onClose,
}: ThreadPanelProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const threadRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const visibleThreads = useMemo(() => {
    if (filterMode === 'current-file' && currentFilePath) {
      return threads.filter((thread) => {
        if (thread.target.kind === 'workspace') {
          return true;
        }
        return thread.target.file === currentFilePath;
      });
    }

    if (filterMode === 'current-hunk' && hunkFocus) {
      return threads.filter((thread) => {
        if (thread.target.kind === 'hunk') {
          return (
            thread.target.file === hunkFocus.filePath &&
            normalizeHunkHeader(thread.target.hunkHeader) === normalizeHunkHeader(hunkFocus.hunkHeader)
          );
        }
        if (thread.target.kind === 'line') {
          return doesLineThreadOverlapHunk(thread, hunkFocus);
        }
        return false;
      });
    }

    return threads;
  }, [currentFilePath, filterMode, hunkFocus, threads]);

  useEffect(() => {
    const focusId = hoveredThreadId ?? selectedThreadId;
    if (!focusId) return;

    const el = threadRefs.current[focusId];
    if (!el) return;

    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoveredThreadId, selectedThreadId]);

  if (visibleThreads.length === 0) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--gs-bg)',
        borderLeft: '1px solid var(--gs-border)',
      }}>
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--gs-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gs-text)' }}>Review Threads</span>
          {onClose && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--gs-text-muted)', cursor: 'pointer', fontSize: '16px' }}>×</button>
          )}
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gs-text-muted)', fontSize: '13px' }}>
          {filterMode === 'current-file'
            ? 'No threads for the current file.'
            : filterMode === 'current-hunk'
              ? 'No threads for the selected hunk.'
              : 'No threads yet. Click a diff line or hunk to add a comment.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--gs-bg)',
      borderLeft: '1px solid var(--gs-border)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--gs-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gs-text)' }}>
          Review Threads
          <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--gs-text-muted)', fontWeight: 400 }}>
            ({visibleThreads.filter((t) => !t.resolved).length} open)
          </span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            onClick={() => onFilterModeChange?.('all')}
            style={{
              fontSize: '10px',
              padding: '2px 8px',
              borderRadius: '999px',
              border: '1px solid var(--gs-border)',
              background: filterMode === 'all' ? 'var(--gs-chip-blue-bg)' : 'var(--gs-btn-secondary-bg)',
              color: filterMode === 'all' ? 'var(--gs-info)' : 'var(--gs-text-muted)',
              cursor: 'pointer',
            }}
          >
            All
          </button>
          <button
            onClick={() => onFilterModeChange?.('current-file')}
            disabled={!currentFilePath}
            style={{
              fontSize: '10px',
              padding: '2px 8px',
              borderRadius: '999px',
              border: '1px solid var(--gs-border)',
              background: filterMode === 'current-file' ? 'var(--gs-chip-blue-bg)' : 'var(--gs-btn-secondary-bg)',
              color: filterMode === 'current-file' ? 'var(--gs-info)' : 'var(--gs-text-muted)',
              cursor: currentFilePath ? 'pointer' : 'not-allowed',
            }}
          >
            Current file
          </button>
          <button
            onClick={() => onFilterModeChange?.('current-hunk')}
            disabled={!hunkFocus}
            style={{
              fontSize: '10px',
              padding: '2px 8px',
              borderRadius: '999px',
              border: '1px solid var(--gs-border)',
              background: filterMode === 'current-hunk' ? 'var(--gs-chip-blue-bg)' : 'var(--gs-btn-secondary-bg)',
              color: filterMode === 'current-hunk' ? 'var(--gs-info)' : 'var(--gs-text-muted)',
              cursor: hunkFocus ? 'pointer' : 'not-allowed',
            }}
          >
            Current hunk
          </button>
          {onClose && (
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: 'var(--gs-text-muted)', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {filterMode === 'current-hunk' && hunkFocus && (
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--gs-border-muted)',
          fontSize: '11px',
          color: 'var(--gs-text-muted)',
          background: 'var(--gs-bg)',
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
        }}>
          <span style={{ color: 'var(--gs-info)', fontWeight: 600 }}>Hunk filter</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {normalizeHunkHeader(hunkFocus.hunkHeader)}
          </span>
          <button
            onClick={() => onFilterModeChange?.('all')}
            style={{
              marginLeft: 'auto',
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: '3px',
              border: '1px solid var(--gs-border)',
              background: 'var(--gs-btn-secondary-bg)',
              color: 'var(--gs-text-muted)',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Thread list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {visibleThreads.map((thread) => {
          const isSelected = thread.id === selectedThreadId;
          const isHovered = thread.id === hoveredThreadId;
          const decision = thread.decision;

          return (
            <div
              key={thread.id}
              ref={(el) => { threadRefs.current[thread.id] = el; }}
              style={{
                borderBottom: '1px solid var(--gs-border-muted)',
                background: isSelected ? 'var(--gs-bg-elevated)' : isHovered ? 'var(--gs-bg-hover)' : 'transparent',
                boxShadow: isHovered ? 'inset 2px 0 0 var(--gs-info)' : undefined,
              }}
            >
              {/* Thread header */}
              <div style={{ padding: '10px 14px 6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  {/* Decision badge */}
                  {decision && (
                    <span style={{
                      fontSize: '11px',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      background: REVIEW_DECISION_COLORS[decision] + '22',
                      color: REVIEW_DECISION_COLORS[decision],
                      border: `1px solid ${REVIEW_DECISION_COLORS[decision]}44`,
                    }}>
                      {decision === 'approved' ? '✓ Approved' : decision === 'rejected' ? '✗ Changes requested' : '⏳ Pending'}
                    </span>
                  )}
                  {/* Resolved badge */}
                  {thread.resolved && (
                    <span style={{ fontSize: '11px', color: 'var(--gs-text-dim)' }}>✓ Resolved</span>
                  )}
                  <span style={{ fontSize: '11px', color: 'var(--gs-text-dim)', marginLeft: 'auto' }}>
                    {targetLabel(thread)}
                  </span>
                  {thread.target.kind !== 'workspace' && (
                    <button
                      onClick={() => onOpenThreadTarget?.(thread.id)}
                      style={{
                        fontSize: '10px',
                        padding: '1px 6px',
                        borderRadius: '3px',
                        border: '1px solid var(--gs-border)',
                        background: 'var(--gs-btn-secondary-bg)',
                        color: 'var(--gs-info)',
                        cursor: 'pointer',
                      }}
                    >
                      Go to code
                    </button>
                  )}
                </div>

                {/* Hunk decision buttons */}
                {thread.target.kind === 'hunk' && !thread.resolved && (
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                    {(['approved', 'rejected', 'pending'] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => {
                          void onUpdateDecision(thread.id, d).catch(() => {});
                        }}
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          border: '1px solid',
                          cursor: 'pointer',
                          background: decision === d ? REVIEW_DECISION_COLORS[d] + '33' : 'var(--gs-btn-secondary-bg)',
                          color: decision === d ? REVIEW_DECISION_COLORS[d] : 'var(--gs-text-muted)',
                          borderColor: decision === d ? REVIEW_DECISION_COLORS[d] + '66' : 'var(--gs-border)',
                        }}
                      >
                        {d === 'approved' ? '✓ Approve' : d === 'rejected' ? '✗ Reject' : '⏳ Pending'}
                      </button>
                    ))}
                  </div>
                )}

                {/* Comments — shared renderer (review-comment-ui.web.tsx) */}
                <ReviewCommentList
                  comments={thread.comments}
                  onUpdateComment={(commentId, body) => onUpdateComment(thread.id, commentId, body)}
                  onDeleteComment={(commentId) => onDeleteComment(thread.id, commentId)}
                />

                {/* Reply form — shared composer (review-comment-ui.web.tsx) */}
                {replyingTo === thread.id ? (
                  <div style={{ marginTop: '6px' }}>
                    <CommentComposer
                      placeholder="Write a reply..."
                      submitLabel="Reply"
                      rows={2}
                      onSubmit={async (body) => { await onAddReply(thread.id, body); setReplyingTo(null); }}
                      onCancel={() => setReplyingTo(null)}
                    />
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <button
                      onClick={() => setReplyingTo(thread.id)}
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        background: 'none',
                        color: 'var(--gs-info)',
                        border: '1px solid var(--gs-border)',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      Reply
                    </button>
                    <button
                      onClick={() => {
                        void onResolveThread(thread.id, !thread.resolved).catch(() => {});
                      }}
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        background: 'none',
                        color: thread.resolved ? 'var(--gs-text-dim)' : 'var(--gs-accent)',
                        border: '1px solid var(--gs-border)',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      {thread.resolved ? 'Re-open' : 'Resolve'}
                    </button>
                    {onSendToAgent && !thread.resolved && (
                      <button
                        onClick={() => { void Promise.resolve(onSendToAgent(thread)).catch(() => {}); }}
                        title="Route this finding to the workspace agent"
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          background: 'none',
                          color: 'var(--gs-accent)',
                          border: '1px solid rgba(0,255,102,.35)',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        ✦ Send to agent → fix
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function doesLineThreadOverlapHunk(thread: ReviewThread, hunkFocus: HunkFocusTarget): boolean {
  if (thread.target.kind !== 'line' || thread.target.file !== hunkFocus.filePath) {
    return false;
  }

  if (thread.target.side === 'LEFT') {
    if (hunkFocus.oldEnd < hunkFocus.oldStart) {
      return false;
    }
    return rangesOverlap(thread.target.startLine, thread.target.endLine, hunkFocus.oldStart, hunkFocus.oldEnd);
  }

  if (hunkFocus.newEnd < hunkFocus.newStart) {
    return false;
  }

  return rangesOverlap(thread.target.startLine, thread.target.endLine, hunkFocus.newStart, hunkFocus.newEnd);
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  const minA = Math.min(startA, endA);
  const maxA = Math.max(startA, endA);
  const minB = Math.min(startB, endB);
  const maxB = Math.max(startB, endB);
  return Math.max(minA, minB) <= Math.min(maxA, maxB);
}
