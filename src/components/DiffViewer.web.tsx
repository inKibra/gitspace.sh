/** @jsxImportSource react */
/**
 * DiffViewer — wraps @pierre/diffs PatchDiff component.
 *
 * Shows the unified diff with per-hunk approve/reject buttons
 * and comment count badges. Clicking a line opens a comment form.
 */

import { useState, useCallback } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import type { DiffLineAnnotation, AnnotationSide } from '@pierre/diffs';
import type { ReviewThread, ThreadTarget, HunkDecision } from '../types/review.js';

export interface DiffViewerProps {
  diff: string;
  threads: ReviewThread[];
  onCreateThread: (target: ThreadTarget, body: string, decision?: HunkDecision) => Promise<void>;
  onUpdateThread: (threadId: string, updates: { decision?: HunkDecision }) => Promise<void>;
  onThreadClick?: (threadId: string) => void;
}

interface CommentFormState {
  target: ThreadTarget;
  decision?: HunkDecision;
}

export function DiffViewer({ diff, threads, onCreateThread, onUpdateThread, onThreadClick }: DiffViewerProps) {
  const [commentForm, setCommentForm] = useState<CommentFormState | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmitComment = useCallback(async () => {
    if (!commentForm || !commentBody.trim()) return;
    setSubmitting(true);
    try {
      await onCreateThread(commentForm.target, commentBody.trim(), commentForm.decision);
      setCommentForm(null);
      setCommentBody('');
    } finally {
      setSubmitting(false);
    }
  }, [commentForm, commentBody, onCreateThread]);

  const handleApproveHunk = useCallback(async (hunkHeader: string, file: string) => {
    // Find existing hunk thread
    const existing = threads.find(
      (t) => t.target.kind === 'hunk' && t.target.hunkHeader === hunkHeader && t.target.file === file
    );
    if (existing) {
      await onUpdateThread(existing.id, { decision: 'approved' });
    } else {
      setCommentForm({ target: { kind: 'hunk', file, hunkHeader }, decision: 'approved' });
      setCommentBody('');
    }
  }, [threads, onUpdateThread]);

  const handleRejectHunk = useCallback(async (hunkHeader: string, file: string) => {
    const existing = threads.find(
      (t) => t.target.kind === 'hunk' && t.target.hunkHeader === hunkHeader && t.target.file === file
    );
    if (existing) {
      await onUpdateThread(existing.id, { decision: 'rejected' });
    } else {
      setCommentForm({ target: { kind: 'hunk', file, hunkHeader }, decision: 'rejected' });
      setCommentBody('');
    }
  }, [threads, onUpdateThread]);

  // Map threads to badge annotations for @pierre/diffs
  // AnnotationSide uses "deletions"/"additions" (not "LEFT"/"RIGHT")
  const annotations: DiffLineAnnotation<ReviewThread>[] = threads
    .filter((t) => t.target.kind === 'line' || t.target.kind === 'hunk')
    .map((t) => {
      const side: AnnotationSide = t.target.kind === 'line'
        ? (t.target.side === 'LEFT' ? 'deletions' : 'additions')
        : 'additions';
      const lineNumber = t.target.kind === 'line' ? t.target.startLine : 1;
      return { side, lineNumber, metadata: t };
    });

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<ReviewThread>) => {
    const thread = annotation.metadata;
    const count = thread.comments.length;
    const decision = thread.decision;
    const color =
      decision === 'approved' ? '#22c55e' :
      decision === 'rejected' ? '#f85149' :
      '#58a6ff';

    return (
      <button
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '11px',
          padding: '1px 6px',
          borderRadius: '10px',
          background: color + '22',
          color,
          border: `1px solid ${color}44`,
          cursor: 'pointer',
        }}
        onClick={() => onThreadClick?.(thread.id)}
      >
        {decision === 'approved' ? '✓' : decision === 'rejected' ? '✗' : '💬'}
        {count > 1 && ` ${count}`}
      </button>
    );
  }, [onThreadClick]);

  if (!diff) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#8b949e' }}>
        No diff available.
      </div>
    );
  }

  // Parse hunk headers from the diff for approve/reject buttons
  const hunkHeaders = extractHunkHeaders(diff);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Hunk approve/reject toolbar — scrollable, shows all hunks */}
      {hunkHeaders.length > 0 && (
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #30363d',
          display: 'flex',
          gap: '6px',
          flexShrink: 0,
          overflowX: 'auto',
        }}>
          {hunkHeaders.map(({ header, file }) => {
            const thread = threads.find(
              (t) => t.target.kind === 'hunk' && t.target.hunkHeader === header && t.target.file === file
            );
            const decision = thread?.decision;
            return (
              <div key={`${file}:${header}`} style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: '11px', color: '#6e7681', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {header.replace(/@@.*@@\s*/, '').trim() || header.slice(0, 30)}
                </span>
                <button
                  onClick={() => void handleApproveHunk(header, file)}
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: '1px solid',
                    cursor: 'pointer',
                    background: decision === 'approved' ? '#22c55e33' : '#21262d',
                    color: decision === 'approved' ? '#22c55e' : '#8b949e',
                    borderColor: decision === 'approved' ? '#22c55e66' : '#30363d',
                  }}
                >
                  ✓ Approve
                </button>
                <button
                  onClick={() => void handleRejectHunk(header, file)}
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: '1px solid',
                    cursor: 'pointer',
                    background: decision === 'rejected' ? '#f8514933' : '#21262d',
                    color: decision === 'rejected' ? '#f85149' : '#8b949e',
                    borderColor: decision === 'rejected' ? '#f8514966' : '#30363d',
                  }}
                >
                  ✗ Reject
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Diff viewer */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <PatchDiff
          patch={diff}
          lineAnnotations={annotations}
          renderAnnotation={renderAnnotation}
          className="diff-viewer"
        />
      </div>

      {/* Inline comment form */}
      {commentForm && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: '#161b22',
          borderTop: '1px solid #30363d',
          padding: '12px 16px',
          zIndex: 100,
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', maxWidth: '800px', margin: '0 auto' }}>
            <div style={{ flex: 1 }}>
              {commentForm.decision && (
                <div style={{
                  marginBottom: '6px',
                  fontSize: '12px',
                  color: commentForm.decision === 'approved' ? '#22c55e' : '#f85149',
                }}>
                  {commentForm.decision === 'approved' ? '✓ Approving hunk' : '✗ Requesting changes on hunk'}
                  {commentForm.target.kind === 'hunk' && (
                    <span style={{ color: '#6e7681', marginLeft: '8px' }}>{commentForm.target.hunkHeader.slice(0, 50)}</span>
                  )}
                </div>
              )}
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Add a comment (optional)..."
                rows={3}
                style={{
                  width: '100%',
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  color: '#e6edf3',
                  padding: '8px',
                  fontSize: '13px',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setCommentForm(null);
                    setCommentBody('');
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    void handleSubmitComment();
                  }
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <button
                onClick={() => void handleSubmitComment()}
                disabled={submitting}
                style={{
                  padding: '8px 16px',
                  background: '#22c55e',
                  color: '#0d1117',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: submitting ? 'wait' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                {submitting ? '...' : 'Submit'}
              </button>
              <button
                onClick={() => { setCommentForm(null); setCommentBody(''); }}
                style={{
                  padding: '8px 16px',
                  background: '#21262d',
                  color: '#8b949e',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

interface HunkInfo {
  header: string;
  file: string;
}

function extractHunkHeaders(patch: string): HunkInfo[] {
  const lines = patch.split('\n');
  const result: HunkInfo[] = [];
  let currentFile = '';

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      // e.g. "diff --git a/src/foo.ts b/src/foo.ts"
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = match[1];
      }
    } else if (line.startsWith('@@')) {
      result.push({ header: line, file: currentFile });
    }
  }

  return result;
}
