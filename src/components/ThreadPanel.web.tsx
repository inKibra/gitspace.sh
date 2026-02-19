/** @jsxImportSource react */
/**
 * ThreadPanel — right-side panel listing all review threads.
 *
 * Shows thread targets, decisions, comments, and allows:
 * - Resolving/unresolving threads
 * - Adding replies
 * - Editing/deleting own comments
 */

import { Fragment, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ReviewThread, HunkDecision } from '../types/review.js';
import type { HunkFocusTarget } from './DiffViewer.web.js';
import { normalizeHunkHeader } from '../utils/hunk-header.js';
import { REVIEW_DECISION_COLORS } from './review-decision-colors.js';

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
  onClose?: () => void;
}

const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

function isSafeMarkdownHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return true;
  }

  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!scheme?.[1]) {
    // Relative paths without a URI scheme are safe.
    return true;
  }

  return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase());
}

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

function renderMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(\[[^\]]+\]\([^\)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const tokens = text.split(tokenPattern);

  return tokens.map((token, index) => {
    const key = `${keyPrefix}-inline-${index}`;

    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code key={key} style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '11px',
          background: '#0d1117',
          border: '1px solid #30363d',
          borderRadius: '3px',
          padding: '0 4px',
          color: '#c9d1d9',
        }}>
          {token.slice(1, -1)}
        </code>
      );
    }

    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    }

    if (token.startsWith('*') && token.endsWith('*')) {
      return <em key={key}>{token.slice(1, -1)}</em>;
    }

    const linkMatch = token.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
    if (linkMatch) {
      const label = linkMatch[1] ?? token;
      const href = linkMatch[2] ?? '#';
      if (!isSafeMarkdownHref(href)) {
        return <Fragment key={key}>{label}</Fragment>;
      }
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#58a6ff' }}
        >
          {label}
        </a>
      );
    }

    return <Fragment key={key}>{token}</Fragment>;
  });
}

function renderMarkdownBody(markdown: string, keyPrefix: string): ReactNode[] {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ');
    nodes.push(
      <p key={`${keyPrefix}-p-${nodes.length}`} style={{ margin: '0 0 6px 0' }}>
        {renderMarkdownInline(text, `${keyPrefix}-p-${nodes.length}`)}
      </p>
    );
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`${keyPrefix}-ul-${nodes.length}`} style={{ margin: '0 0 6px 16px', padding: 0 }}>
        {listItems.map((item, index) => (
          <li key={`${keyPrefix}-li-${index}`} style={{ marginBottom: '2px' }}>
            {renderMarkdownInline(item, `${keyPrefix}-li-${index}`)}
          </li>
        ))}
      </ul>
    );
    listItems = [];
  };

  const flushCodeBlock = () => {
    if (codeLines.length === 0) return;
    nodes.push(
      <pre key={`${keyPrefix}-code-${nodes.length}`} style={{
        margin: '0 0 6px 0',
        padding: '8px',
        borderRadius: '6px',
        background: '#0d1117',
        border: '1px solid #30363d',
        overflowX: 'auto',
      }}>
        <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px' }}>
          {codeLines.join('\n')}
        </code>
      </pre>
    );
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCodeBlock();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (line.trimStart().startsWith('- ')) {
      flushParagraph();
      listItems.push(line.trimStart().slice(2));
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCodeBlock();

  if (nodes.length === 0) {
    nodes.push(<p key={`${keyPrefix}-empty`} style={{ margin: 0 }} />);
  }

  return nodes;
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
  onAddReply,
  onUpdateComment,
  onDeleteComment,
  onUpdateDecision,
  onOpenThreadTarget,
  onClose,
}: ThreadPanelProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [editingComment, setEditingComment] = useState<{ threadId: string; commentId: string; body: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
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

  const handleAddReply = useCallback(async (threadId: string) => {
    if (!replyBody.trim()) return;
    setSubmitting(true);
    try {
      await onAddReply(threadId, replyBody.trim());
      setReplyBody('');
      setReplyingTo(null);
    } catch {
      // Error is surfaced via review hook state; avoid unhandled promise rejections.
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
    } catch {
      // Error is surfaced via review hook state; avoid unhandled promise rejections.
    } finally {
      setSubmitting(false);
    }
  }, [editingComment, onUpdateComment]);

  if (visibleThreads.length === 0) {
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
              border: '1px solid #30363d',
              background: filterMode === 'all' ? '#1f6feb33' : '#21262d',
              color: filterMode === 'all' ? '#58a6ff' : '#8b949e',
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
              border: '1px solid #30363d',
              background: filterMode === 'current-file' ? '#1f6feb33' : '#21262d',
              color: filterMode === 'current-file' ? '#58a6ff' : '#8b949e',
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
              border: '1px solid #30363d',
              background: filterMode === 'current-hunk' ? '#1f6feb33' : '#21262d',
              color: filterMode === 'current-hunk' ? '#58a6ff' : '#8b949e',
              cursor: hunkFocus ? 'pointer' : 'not-allowed',
            }}
          >
            Current hunk
          </button>
          {onClose && (
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {filterMode === 'current-hunk' && hunkFocus && (
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #21262d',
          fontSize: '11px',
          color: '#8b949e',
          background: '#11161d',
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
        }}>
          <span style={{ color: '#58a6ff', fontWeight: 600 }}>Hunk filter</span>
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
              border: '1px solid #30363d',
              background: '#21262d',
              color: '#8b949e',
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
                borderBottom: '1px solid #21262d',
                background: isSelected ? '#161b22' : isHovered ? '#1b2230' : 'transparent',
                boxShadow: isHovered ? 'inset 2px 0 0 #58a6ff' : undefined,
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
                    <span style={{ fontSize: '11px', color: '#6e7681' }}>✓ Resolved</span>
                  )}
                  <span style={{ fontSize: '11px', color: '#6e7681', marginLeft: 'auto' }}>
                    {targetLabel(thread)}
                  </span>
                  {thread.target.kind !== 'workspace' && (
                    <button
                      onClick={() => onOpenThreadTarget?.(thread.id)}
                      style={{
                        fontSize: '10px',
                        padding: '1px 6px',
                        borderRadius: '3px',
                        border: '1px solid #30363d',
                        background: '#21262d',
                        color: '#58a6ff',
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
                          background: decision === d ? REVIEW_DECISION_COLORS[d] + '33' : '#21262d',
                          color: decision === d ? REVIEW_DECISION_COLORS[d] : '#8b949e',
                          borderColor: decision === d ? REVIEW_DECISION_COLORS[d] + '66' : '#30363d',
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
                            onClick={() => {
                              void handleSaveEdit().catch(() => {});
                            }}
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
                        <div style={{
                          flex: 1,
                          fontSize: '12px',
                          color: '#e6edf3',
                          margin: 0,
                          whiteSpace: 'normal',
                          wordBreak: 'break-word',
                          lineHeight: 1.45,
                        }}>
                          {renderMarkdownBody(comment.body, comment.id)}
                        </div>
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
                              onClick={() => {
                                void onDeleteComment(thread.id, comment.id).catch(() => {});
                              }}
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
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          void handleAddReply(thread.id).catch(() => {});
                        }
                      }}
                    />
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                      <button
                        onClick={() => {
                          void handleAddReply(thread.id).catch(() => {});
                        }}
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
                      onClick={() => {
                        void onResolveThread(thread.id, !thread.resolved).catch(() => {});
                      }}
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

function doesLineThreadOverlapHunk(thread: ReviewThread, hunkFocus: HunkFocusTarget): boolean {
  if (thread.target.kind !== 'line' || thread.target.file !== hunkFocus.filePath) {
    return false;
  }

  if (thread.target.side === 'LEFT') {
    return rangesOverlap(thread.target.startLine, thread.target.endLine, hunkFocus.oldStart, hunkFocus.oldEnd);
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
