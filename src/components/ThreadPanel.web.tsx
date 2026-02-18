/** @jsxImportSource react */
/**
 * ThreadPanel — right-side panel listing all review threads.
 *
 * Shows thread targets, decisions, comments, and allows:
 * - Resolving/unresolving threads
 * - Adding replies
 * - Editing/deleting own comments
 */

import { useState, useCallback } from 'react';
import type { ReviewThread, HunkDecision } from '../types/review.js';

export interface ThreadPanelProps {
  threads: ReviewThread[];
  selectedThreadId?: string | null;
  onResolveThread: (threadId: string, resolved: boolean) => Promise<void>;
  onAddReply: (threadId: string, body: string) => Promise<void>;
  onUpdateComment: (threadId: string, commentId: string, body: string) => Promise<void>;
  onDeleteComment: (threadId: string, commentId: string) => Promise<void>;
  onUpdateDecision: (threadId: string, decision: HunkDecision) => Promise<void>;
  onClose?: () => void;
}

const DECISION_COLORS: Record<string, string> = {
  approved: '#22c55e',
  rejected: '#f85149',
  pending: '#d29922',
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
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
  selectedThreadId,
  onResolveThread,
  onAddReply,
  onUpdateComment,
  onDeleteComment,
  onUpdateDecision,
  onClose,
}: ThreadPanelProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [editingComment, setEditingComment] = useState<{ threadId: string; commentId: string; body: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleAddReply = useCallback(async (threadId: string) => {
    if (!replyBody.trim()) return;
    setSubmitting(true);
    try {
      await onAddReply(threadId, replyBody.trim());
      setReplyBody('');
      setReplyingTo(null);
    } finally {
      setSubmitting(false);
    }
  }, [replyBody, onAddReply]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingComment || !editingComment.body.trim()) return;
    setSubmitting(true);
    try {
      await onUpdateComment(editingComment.threadId, editingComment.commentId, editingComment.body.trim());
      setEditingComment(null);
    } finally {
      setSubmitting(false);
    }
  }, [editingComment, onUpdateComment]);

  if (threads.length === 0) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#0d1117',
        borderLeft: '1px solid #30363d',
      }}>
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #30363d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#e6edf3' }}>Review Threads</span>
          {onClose && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '16px' }}>×</button>
          )}
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: '13px' }}>
          No threads yet. Click a diff line or hunk to add a comment.
        </div>
      </div>
    );
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#0d1117',
      borderLeft: '1px solid #30363d',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #30363d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#e6edf3' }}>
          Review Threads
          <span style={{ marginLeft: '8px', fontSize: '11px', color: '#8b949e', fontWeight: 400 }}>
            ({threads.filter((t) => !t.resolved).length} open)
          </span>
        </span>
        {onClose && (
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}
          >
            ×
          </button>
        )}
      </div>

      {/* Thread list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {threads.map((thread) => {
          const isSelected = thread.id === selectedThreadId;
          const decision = thread.decision;

          return (
            <div
              key={thread.id}
              style={{
                borderBottom: '1px solid #21262d',
                background: isSelected ? '#161b22' : 'transparent',
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
                      background: DECISION_COLORS[decision] + '22',
                      color: DECISION_COLORS[decision],
                      border: `1px solid ${DECISION_COLORS[decision]}44`,
                    }}>
                      {decision === 'approved' ? '✓ Approved' : decision === 'rejected' ? '✗ Changes requested' : '⏳ Pending'}
                    </span>
                  )}
                  {/* Resolved badge */}
                  {thread.resolved && (
                    <span style={{ fontSize: '11px', color: '#6e7681' }}>✓ Resolved</span>
                  )}
                  <span style={{ fontSize: '11px', color: '#6e7681', marginLeft: 'auto' }}>
                    {targetLabel(thread)}
                  </span>
                </div>

                {/* Hunk decision buttons */}
                {thread.target.kind === 'hunk' && !thread.resolved && (
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                    {(['approved', 'rejected', 'pending'] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => void onUpdateDecision(thread.id, d)}
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          border: '1px solid',
                          cursor: 'pointer',
                          background: decision === d ? DECISION_COLORS[d] + '33' : '#21262d',
                          color: decision === d ? DECISION_COLORS[d] : '#8b949e',
                          borderColor: decision === d ? DECISION_COLORS[d] + '66' : '#30363d',
                        }}
                      >
                        {d === 'approved' ? '✓ Approve' : d === 'rejected' ? '✗ Reject' : '⏳ Pending'}
                      </button>
                    ))}
                  </div>
                )}

                {/* Comments */}
                {thread.comments.map((comment, idx) => (
                  <div
                    key={comment.id}
                    style={{
                      marginBottom: '8px',
                      paddingLeft: idx > 0 ? '12px' : 0,
                      borderLeft: idx > 0 ? '2px solid #21262d' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#58a6ff' }}>{comment.author}</span>
                      <span style={{ fontSize: '11px', color: '#6e7681' }}>{formatDate(comment.createdAt)}</span>
                      {comment.githubId && (
                        <span style={{ fontSize: '10px', color: '#6e7681' }}>· GH</span>
                      )}
                    </div>

                    {editingComment?.commentId === comment.id ? (
                      <div>
                        <textarea
                          value={editingComment.body}
                          onChange={(e) => setEditingComment({ ...editingComment, body: e.target.value })}
                          rows={3}
                          style={{
                            width: '100%',
                            background: '#161b22',
                            border: '1px solid #30363d',
                            borderRadius: '4px',
                            color: '#e6edf3',
                            padding: '6px',
                            fontSize: '12px',
                            resize: 'vertical',
                            boxSizing: 'border-box',
                          }}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                          <button
                            onClick={() => void handleSaveEdit()}
                            disabled={submitting}
                            style={{
                              fontSize: '11px',
                              padding: '3px 10px',
                              background: '#22c55e',
                              color: '#0d1117',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                            }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingComment(null)}
                            style={{
                              fontSize: '11px',
                              padding: '3px 10px',
                              background: '#21262d',
                              color: '#8b949e',
                              border: '1px solid #30363d',
                              borderRadius: '4px',
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        <p style={{ flex: 1, fontSize: '12px', color: '#e6edf3', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {comment.body}
                        </p>
                        {comment.author === 'local' && (
                          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                            <button
                              onClick={() => setEditingComment({ threadId: thread.id, commentId: comment.id, body: comment.body })}
                              style={{
                                fontSize: '10px',
                                padding: '1px 5px',
                                background: 'none',
                                color: '#6e7681',
                                border: '1px solid #30363d',
                                borderRadius: '3px',
                                cursor: 'pointer',
                              }}
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => void onDeleteComment(thread.id, comment.id)}
                              style={{
                                fontSize: '10px',
                                padding: '1px 5px',
                                background: 'none',
                                color: '#f85149',
                                border: '1px solid #f8514944',
                                borderRadius: '3px',
                                cursor: 'pointer',
                              }}
                            >
                              Del
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {/* Reply form */}
                {replyingTo === thread.id ? (
                  <div style={{ marginTop: '6px' }}>
                    <textarea
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder="Write a reply..."
                      rows={2}
                      style={{
                        width: '100%',
                        background: '#161b22',
                        border: '1px solid #30363d',
                        borderRadius: '4px',
                        color: '#e6edf3',
                        padding: '6px',
                        fontSize: '12px',
                        resize: 'vertical',
                        boxSizing: 'border-box',
                      }}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setReplyingTo(null); setReplyBody(''); }
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleAddReply(thread.id);
                      }}
                    />
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                      <button
                        onClick={() => void handleAddReply(thread.id)}
                        disabled={submitting || !replyBody.trim()}
                        style={{
                          fontSize: '11px',
                          padding: '3px 10px',
                          background: '#22c55e',
                          color: '#0d1117',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        Reply
                      </button>
                      <button
                        onClick={() => { setReplyingTo(null); setReplyBody(''); }}
                        style={{
                          fontSize: '11px',
                          padding: '3px 10px',
                          background: '#21262d',
                          color: '#8b949e',
                          border: '1px solid #30363d',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <button
                      onClick={() => { setReplyingTo(thread.id); setReplyBody(''); }}
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        background: 'none',
                        color: '#58a6ff',
                        border: '1px solid #30363d',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      Reply
                    </button>
                    <button
                      onClick={() => void onResolveThread(thread.id, !thread.resolved)}
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        background: 'none',
                        color: thread.resolved ? '#6e7681' : '#22c55e',
                        border: '1px solid #30363d',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      {thread.resolved ? 'Re-open' : 'Resolve'}
                    </button>
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
