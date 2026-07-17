/** @jsxImportSource react */
/**
 * Shared review-comment UI — the comment body renderer, the comment list and
 * the composer, used by BOTH thread surfaces:
 *
 *   - ThreadPanel.web.tsx      — the right-side list of all threads
 *   - ChangeGuide.web.tsx      — line-anchored threads inline in the guide diffs
 *
 * Extracted from ThreadPanel so the guide reuses one copy of the comment
 * rendering rather than forking a second. Presentation only: every mutation is
 * a prop, so a surface with no write ops (share view, read-only host) just
 * omits the handlers and the affordances disappear.
 */
import { Fragment, useCallback, useState, type ReactNode } from 'react';
import type { ReviewComment } from '../types/review.js';

const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

function isSafeMarkdownHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith('//')) {
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

export function formatCommentDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
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
          background: 'var(--gs-bg)',
          border: '1px solid var(--gs-border)',
          borderRadius: '3px',
          padding: '0 4px',
          color: 'var(--gs-text-secondary)',
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
          style={{ color: 'var(--gs-info)' }}
        >
          {label}
        </a>
      );
    }

    return <Fragment key={key}>{token}</Fragment>;
  });
}

/** Render a comment body's restricted markdown (paragraphs, lists, code, inline). */
export function renderCommentMarkdown(markdown: string, keyPrefix: string): ReactNode[] {
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
        background: 'var(--gs-bg)',
        border: '1px solid var(--gs-border)',
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

/* ── Comment list ──────────────────────────────────────────────────────────── */

export interface ReviewCommentListProps {
  comments: ReviewComment[];
  /** Omit to hide the edit affordance (read-only surfaces). */
  onUpdateComment?: (commentId: string, body: string) => Promise<void>;
  /** Omit to hide the delete affordance (read-only surfaces). */
  onDeleteComment?: (commentId: string) => Promise<void>;
  /** Compact spacing for the inline (in-diff) surface. */
  compact?: boolean;
}

/**
 * A thread's comments, root first then replies. Edit/delete are offered only
 * for locally-authored comments AND only when the surface passes the handler.
 */
export function ReviewCommentList({
  comments,
  onUpdateComment,
  onDeleteComment,
  compact = false,
}: ReviewCommentListProps) {
  const [editing, setEditing] = useState<{ commentId: string; body: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const saveEdit = useCallback(async () => {
    if (!editing || !editing.body.trim() || !onUpdateComment) return;
    setSubmitting(true);
    try {
      await onUpdateComment(editing.commentId, editing.body.trim());
      setEditing(null);
    } catch {
      // Surfaced by the owning surface's error state; don't reject unhandled.
    } finally {
      setSubmitting(false);
    }
  }, [editing, onUpdateComment]);

  return (
    <>
      {comments.map((comment, idx) => (
        <div
          key={comment.id}
          style={{
            marginBottom: compact ? '6px' : '8px',
            paddingLeft: idx > 0 ? '12px' : 0,
            borderLeft: idx > 0 ? '2px solid var(--gs-border-muted)' : 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
            <span style={{ fontSize: compact ? '11px' : '12px', fontWeight: 600, color: 'var(--gs-info)' }}>{comment.author}</span>
            <span style={{ fontSize: compact ? '10px' : '11px', color: 'var(--gs-text-dim)' }}>{formatCommentDate(comment.createdAt)}</span>
            {comment.githubId && (
              <span style={{ fontSize: '10px', color: 'var(--gs-text-dim)' }}>· GH</span>
            )}
          </div>

          {editing?.commentId === comment.id ? (
            <div>
              <textarea
                value={editing.body}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                rows={3}
                style={{
                  width: '100%',
                  background: 'var(--gs-bg-elevated)',
                  border: '1px solid var(--gs-border)',
                  borderRadius: '4px',
                  color: 'var(--gs-text)',
                  padding: '6px',
                  fontSize: '12px',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <button
                  onClick={() => { void saveEdit().catch(() => {}); }}
                  disabled={submitting}
                  style={{
                    fontSize: '11px',
                    padding: '3px 10px',
                    background: 'var(--gs-accent)',
                    color: 'var(--gs-text-on-accent)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setEditing(null)}
                  style={{
                    fontSize: '11px',
                    padding: '3px 10px',
                    background: 'var(--gs-btn-secondary-bg)',
                    color: 'var(--gs-text-muted)',
                    border: '1px solid var(--gs-border)',
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
                fontSize: compact ? '11.5px' : '12px',
                color: 'var(--gs-text)',
                margin: 0,
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                lineHeight: 1.45,
              }}>
                {renderCommentMarkdown(comment.body, comment.id)}
              </div>
              {comment.author === 'local' && (onUpdateComment || onDeleteComment) && (
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  {onUpdateComment && (
                    <button
                      onClick={() => setEditing({ commentId: comment.id, body: comment.body })}
                      style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        background: 'none',
                        color: 'var(--gs-text-dim)',
                        border: '1px solid var(--gs-border)',
                        borderRadius: '3px',
                        cursor: 'pointer',
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {onDeleteComment && (
                    <button
                      onClick={() => { void onDeleteComment(comment.id).catch(() => {}); }}
                      style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        background: 'none',
                        color: 'var(--gs-danger)',
                        border: '1px solid var(--gs-danger)',
                        borderRadius: '3px',
                        cursor: 'pointer',
                      }}
                    >
                      Del
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/* ── Composer ──────────────────────────────────────────────────────────────── */

export interface CommentComposerProps {
  /** Rendered above the textarea — e.g. 'Commenting on L12–L18'. */
  label?: ReactNode;
  placeholder?: string;
  submitLabel?: string;
  rows?: number;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  compact?: boolean;
}

/**
 * Textarea + Submit/Cancel. Cmd/Ctrl+Enter submits, Escape cancels — the same
 * keys the ThreadPanel reply form has always used.
 */
export function CommentComposer({
  label,
  placeholder = 'Add a comment...',
  submitLabel = 'Submit',
  rows = 3,
  autoFocus = true,
  onSubmit,
  onCancel,
  compact = false,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(body.trim());
      setBody('');
    } catch (err) {
      // Keep the draft in the box so the text survives a failed write.
      setError(err instanceof Error ? err.message : 'Failed to save the comment.');
    } finally {
      setSubmitting(false);
    }
  }, [body, submitting, onSubmit]);

  return (
    <div>
      {label && (
        <div style={{ marginBottom: '6px', fontSize: compact ? '11px' : '12px', color: 'var(--gs-text-muted)' }}>
          {label}
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          width: '100%',
          background: 'var(--gs-bg-elevated)',
          border: '1px solid var(--gs-border)',
          borderRadius: '4px',
          color: 'var(--gs-text)',
          padding: '6px',
          fontSize: compact ? '11.5px' : '12px',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setBody(''); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { void submit().catch(() => {}); }
        }}
      />
      <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
        <button
          onClick={() => { void submit().catch(() => {}); }}
          disabled={submitting || !body.trim()}
          style={{
            fontSize: '11px',
            padding: '3px 10px',
            background: 'var(--gs-accent)',
            color: 'var(--gs-text-on-accent)',
            border: 'none',
            borderRadius: '4px',
            cursor: submitting || !body.trim() ? 'not-allowed' : 'pointer',
            opacity: submitting || !body.trim() ? 0.5 : 1,
          }}
        >
          {submitting ? '…' : submitLabel}
        </button>
        <button
          onClick={() => { setBody(''); onCancel(); }}
          style={{
            fontSize: '11px',
            padding: '3px 10px',
            background: 'var(--gs-btn-secondary-bg)',
            color: 'var(--gs-text-muted)',
            border: '1px solid var(--gs-border)',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        {error && (
          <span style={{ alignSelf: 'center', fontSize: '11px', color: 'var(--gs-danger)' }}>{error}</span>
        )}
      </div>
    </div>
  );
}
