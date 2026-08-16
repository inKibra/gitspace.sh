/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import {
  parsePatchFiles,
  type AnnotationSide,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
} from '@pierre/diffs';
import type { HunkDecision, LineTarget, ReviewThread } from '../types/review.js';
import type { SessionBackend } from '../session/backend.js';
import {
  guideLineAnnotations,
  lineRangeLabel,
  lineTargetFromSelection,
  withDraftAnnotation,
  type GuideThreadMeta,
} from './change-guide-threads.web.js';
import { CommentComposer, ReviewCommentList } from './review-comment-ui.web.js';

/**
 * ReviewDiffView — THE reviewable diff surface.
 *
 * Every place a reviewer looks at a changed file renders this: the Change Guide's
 * per-file exhibits, a changed file opened as its own tab, and (next) the repo
 * view. Before this existed the guide and the file tab each re-implemented a
 * thinner subset of DiffViewer and quietly dropped affordances — you could not
 * comment from an opened file at all, and you could not expand unmodified
 * context anywhere but the old review page. Growing a fourth partial diff
 * surface is the failure mode this module exists to prevent.
 *
 * What it owns, so no caller has to rebuild it:
 *   · the hover-gutter '+' button that makes commenting DISCOVERABLE (drag-select
 *     already worked, but nothing on screen ever said so),
 *   · drag-select of a line range, opening the same composer,
 *   · inline thread cards + the draft composer, anchored AT the line,
 *   · click-to-expand unmodified context, via the line-info separators.
 *
 * Thread rendering and the composer chrome are the SHARED ones
 * (review-comment-ui.web.tsx) that ThreadPanel uses; the thread<->annotation
 * mapping is the shared pure layer (change-guide-threads.web.ts). This module
 * adds only the in-diff chrome and the context-expansion wiring.
 */

/* ── Actions ───────────────────────────────────────────────────────────────── */

/** Mutations the inline review threads need — one object so props stay flat. */
export interface ReviewDiffActions {
  onCreateThread: (target: LineTarget, body: string) => Promise<void>;
  onAddReply: (threadId: string, body: string) => Promise<void>;
  onUpdateThread: (threadId: string, updates: { resolved?: boolean; decision?: HunkDecision }) => Promise<void>;
  onUpdateComment: (threadId: string, commentId: string, body: string) => Promise<void>;
  onDeleteComment: (threadId: string, commentId: string) => Promise<void>;
}

/* ── Shared thread state + actions (one get_threads per workspace) ──────────── */

/**
 * The workspace's review threads plus the mutations over them.
 *
 * Every mutation returns the updated thread, so it's spliced into local state
 * rather than re-fetching the whole workspace on each keystroke-sized action.
 * `actions` is null when the backend has no review seam (read-only host / share
 * viewer) — the diff then renders with no comment affordances at all.
 */
export function useReviewThreads(
  backend: SessionBackend | null,
  projectName: string,
  workspaceName: string,
): { threads: ReviewThread[]; actions: ReviewDiffActions | null; reload: () => void } {
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!backend?.sendReviewRequest) { setThreads([]); return; }
    void backend.sendReviewRequest({ op: 'get_threads', projectName, workspaceName })
      .then((r) => { if (alive && r.op === 'threads') setThreads(r.threads); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [backend, projectName, workspaceName, tick]);

  const actions = useMemo((): ReviewDiffActions | null => {
    if (!backend?.sendReviewRequest) return null;
    // Bind: the backends implement this as a class method, so it must stay
    // attached to its receiver (a bare reference loses `this`).
    const send = (op: Parameters<NonNullable<SessionBackend['sendReviewRequest']>>[0]) =>
      backend.sendReviewRequest!(op);

    const applyThread = (thread: ReviewThread): void => {
      setThreads((prev) => prev.some((t) => t.id === thread.id)
        ? prev.map((t) => (t.id === thread.id ? thread : t))
        : [...prev, thread]);
    };

    return {
      onCreateThread: async (target, body) => {
        const r = await send({ op: 'create_thread', projectName, workspaceName, target, body });
        if (r.op === 'thread_created') applyThread(r.thread);
      },
      onAddReply: async (threadId, body) => {
        const r = await send({ op: 'add_reply', projectName, workspaceName, threadId, body });
        if (r.op === 'comment_added') applyThread(r.thread);
      },
      onUpdateThread: async (threadId, updates) => {
        const r = await send({ op: 'update_thread', projectName, workspaceName, threadId, ...updates });
        if (r.op === 'thread_updated') applyThread(r.thread);
      },
      onUpdateComment: async (threadId, commentId, body) => {
        const r = await send({ op: 'update_comment', projectName, workspaceName, threadId, commentId, body });
        if (r.op === 'comment_updated') applyThread(r.thread);
      },
      onDeleteComment: async (threadId, commentId) => {
        const r = await send({ op: 'delete_comment', projectName, workspaceName, threadId, commentId });
        // Deleting the last comment deletes the thread (core/review.ts) — drop it.
        if (r.op !== 'comment_deleted') return;
        if (r.thread.comments.length === 0) setThreads((prev) => prev.filter((t) => t.id !== threadId));
        else applyThread(r.thread);
      },
    };
  }, [backend, projectName, workspaceName]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { threads, actions, reload };
}

/**
 * Fetch the full old/new file contents backing a diff, so the renderer can
 * expand unmodified context. Returns null when the backend has no review seam.
 */
export async function requestFileContext(
  backend: SessionBackend | null,
  projectName: string,
  workspaceName: string,
  filePath: string,
  prevFilePath?: string,
  /** Ref the diff was taken against — omit for the workspace's base branch. */
  base?: string,
): Promise<{ oldLines: string[]; newLines: string[]; oldTotal: number; newTotal: number } | null> {
  if (!backend?.sendReviewRequest) return null;
  const r = await backend.sendReviewRequest({
    op: 'get_file_context_range', projectName, workspaceName, filePath, prevFilePath, base,
  });
  if (r.op !== 'file_context_range') return null;
  return {
    oldLines: expandToAbsoluteLines(r.oldLines, r.oldStart, r.oldTotal),
    newLines: expandToAbsoluteLines(r.newLines, r.newStart, r.newTotal),
    oldTotal: r.oldTotal,
    newTotal: r.newTotal,
  };
}

/**
 * Place a partial line range at its ABSOLUTE position in the file.
 *
 * The renderer indexes oldLines/newLines by absolute line number, so a range
 * that starts at line 40 has to sit at index 39 — otherwise every expanded
 * gap shows the wrong text. Identity when the backend returns the whole file,
 * which is the normal case; the offset is the defensive path.
 */
export function expandToAbsoluteLines(lines: string[], start: number, total: number): string[] {
  if (total <= 0) return [];
  const output = new Array<string>(total).fill('');
  const offset = Math.max(0, start - 1);
  for (let index = 0; index < lines.length; index++) {
    const absoluteIndex = offset + index;
    if (absoluteIndex >= output.length) break;
    output[absoluteIndex] = lines[index] ?? '';
  }
  return output;
}

/* ── View mode: a whole file, through the same surface ─────────────────────── */

/** What a View-mode render turned out to be, so the caller can label it. */
export interface FileViewPatch {
  /** Unified patch whose every line is CONTEXT — i.e. the file, unchanged. */
  patch: string;
  /** Lines actually included (== total unless the cap bit). */
  shownLines: number;
  totalLines: number;
  truncated: boolean;
}

/**
 * Render a plain file — no diff — through the review surface.
 *
 * The repo view's DEFAULT is View: clicking a file shows the file, the way an
 * IDE does. But a reviewer must still be able to comment on any line there, and
 * ReviewDiffView already owns commenting (hover '+', drag-select, inline
 * threads, the composer). Rebuilding that for plain files is exactly the
 * fourth-diff-surface failure this module exists to prevent.
 *
 * So instead of a second renderer, View mode is expressed as a diff the renderer
 * already understands: a single hunk in which every line is a CONTEXT line. The
 * parse yields real 1-based line numbers on both sides, so a LineTarget minted
 * from a hover or a drag lands on the file's actual line — no diff-side
 * assumptions leak in, because in an all-context hunk both sides agree.
 * Nothing in ReviewDiffView had to change to support this.
 *
 * Capped because the whole file becomes one shiki-highlighted hunk; callers
 * gate very large files rather than locking the main thread.
 */
export function fileViewPatch(filePath: string, text: string, maxLines = 4000): FileViewPatch {
  // A trailing newline is a line terminator, not an empty final line.
  const all = text.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const totalLines = all.length;
  const lines = all.slice(0, maxLines);
  const shownLines = lines.length;

  // An empty file has no hunk to render at all.
  const body = shownLines === 0
    ? ''
    : `@@ -1,${shownLines} +1,${shownLines} @@\n${lines.map((line) => ` ${line}`).join('\n')}\n`;

  return {
    patch: `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${body}`,
    shownLines,
    totalLines,
    truncated: shownLines < totalLines,
  };
}

/* ── Inline thread chrome ──────────────────────────────────────────────────── */

/**
 * One anchor's worth of threads, rendered inline in the diff at the line the
 * thread targets. Comment rendering + the reply composer are the SHARED ones
 * (review-comment-ui.web.tsx) that ThreadPanel uses — this only adds the
 * in-diff chrome (anchor label, resolve toggle, collapse).
 */
function InlineThreadCard({ threads, actions }: {
  threads: ReviewThread[];
  actions: ReviewDiffActions | null;
}): ReactElement {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  return (
    <div className="my-1 flex flex-col gap-1">
      {threads.map((thread) => {
        const target = thread.target as LineTarget;
        const isCollapsed = collapsed.has(thread.id);
        return (
          <div
            key={thread.id}
            data-thread-id={thread.id}
            className={`border-l-2 bg-[var(--gs-bg-elevated)] px-2.5 py-1.5 font-[family-name:var(--gs-font)] ${
              thread.resolved ? 'border-l-[var(--gs-border-active)] opacity-70' : 'border-l-[var(--gs-info)]'
            }`}
          >
            <div className="mb-1 flex items-center gap-2 text-[10px]">
              <button
                type="button"
                onClick={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(thread.id)) next.delete(thread.id); else next.add(thread.id);
                  return next;
                })}
                className="text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]"
                title={isCollapsed ? 'Expand thread' : 'Collapse thread'}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
              <span className="font-[family-name:var(--gs-font-mono)] tabular-nums text-[var(--gs-info)]">
                {lineRangeLabel(target)}
              </span>
              <span className="text-[var(--gs-text-dim)]">
                {thread.comments.length} comment{thread.comments.length === 1 ? '' : 's'}
              </span>
              {thread.resolved && <span className="text-[var(--gs-text-dim)]">✓ resolved</span>}
              {actions && (
                <button
                  type="button"
                  onClick={() => { void actions.onUpdateThread(thread.id, { resolved: !thread.resolved }).catch(() => {}); }}
                  className="ml-auto border border-[var(--gs-border)] px-1.5 py-px text-[10px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
                >
                  {thread.resolved ? 'Re-open' : 'Resolve'}
                </button>
              )}
            </div>

            {!isCollapsed && (
              <>
                <ReviewCommentList
                  comments={thread.comments}
                  compact
                  onUpdateComment={actions ? (commentId, body) => actions.onUpdateComment(thread.id, commentId, body) : undefined}
                  onDeleteComment={actions ? (commentId) => actions.onDeleteComment(thread.id, commentId) : undefined}
                />
                {actions && (replyingTo === thread.id ? (
                  <CommentComposer
                    placeholder="Write a reply…"
                    submitLabel="Reply"
                    rows={2}
                    compact
                    onSubmit={async (body) => { await actions.onAddReply(thread.id, body); setReplyingTo(null); }}
                    onCancel={() => setReplyingTo(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setReplyingTo(thread.id)}
                    className="border border-[var(--gs-border)] px-1.5 py-px text-[10.5px] text-[var(--gs-info)] hover:border-[var(--gs-border-active)]"
                  >
                    Reply
                  </button>
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The composer for a FRESH line thread, rendered as a draft annotation — inline
 * at the line it targets, through the same slot the resulting thread lands in.
 * The reviewer writes the comment where the comment will end up.
 *
 * Chrome only: the textarea, the submit/cancel keys and the draft retention on
 * a failed write all belong to the shared CommentComposer.
 */
function InlineDraftComposer({ target, actions, onDone, plain }: {
  target: LineTarget;
  actions: ReviewDiffActions;
  onDone: () => void;
  /** View mode: there are no sides, so don't claim the comment is on the 'new' one. */
  plain?: boolean;
}): ReactElement {
  return (
    <div className="my-1 border-l-2 border-l-[var(--gs-accent)] bg-[var(--gs-bg-elevated)] px-2.5 py-1.5 font-[family-name:var(--gs-font)]">
      <CommentComposer
        compact
        rows={3}
        label={<>Commenting on <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-info)]">{lineRangeLabel(target)}</span>{plain ? null : <> · {target.side === 'LEFT' ? 'old' : 'new'} side</>}</>}
        placeholder="Leave a review comment…"
        submitLabel="Comment"
        // A throw keeps the composer open with its text — CommentComposer
        // surfaces the error and holds the draft, so onDone runs only on a
        // durable write.
        onSubmit={async (body) => { await actions.onCreateThread(target, body); onDone(); }}
        onCancel={onDone}
      />
    </div>
  );
}

/* ── The diff surface ──────────────────────────────────────────────────────── */

/** Styling the guide and the file tab share, so both diffs look identical. */
const DIFF_CSS_VARS: CSSProperties = {
  '--diffs-dark-bg': '#000000',
  '--diffs-addition-color-override': 'rgb(0, 255, 102)',
  '--diffs-fg-number-override': 'var(--gs-text-ghost)',
  '--diffs-font-size': '11.5px',
  '--diffs-line-height': '18px',
  '--diffs-font-family': 'var(--gs-font)',
} as CSSProperties;

type ContextState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; oldLines: string[]; newLines: string[]; hash: string }
  | { status: 'error' };

/**
 * Loaded file text, kept past this component's lifetime.
 *
 * The Change Guide WINDOWS its file blocks — scroll away (or switch dock tabs,
 * which drops layout and reads as "not near the viewport") and the diff
 * unmounts to a spacer. Without this, coming back would refetch the file and
 * re-collapse every gap, so expanding context felt like it never stuck. Keyed by
 * caller-supplied identity; an entry is just file text, so staleness is bounded
 * by the pane's own lifetime.
 */
const contextCache = new Map<string, Extract<ContextState, { status: 'ready' }>>();

export interface ReviewDiffViewProps {
  /** Unified patch text for exactly one file (get_file_diff output). */
  patch: string;
  filePath: string;
  prevFilePath?: string;
  /** Workspace threads (all kinds) — filtered to this file's line threads here. */
  threads: ReviewThread[];
  /** null on read-only surfaces → diff renders, comment affordances don't. */
  actions: ReviewDiffActions | null;
  /**
   * Loads the whole file so unmodified gaps can be expanded. Omit to keep the
   * separators inert (they still render, they just won't open).
   */
  onRequestContext?: () => Promise<{ oldLines: string[]; newLines: string[]; oldTotal: number; newTotal: number } | null>;
  /** Stable identity for the context cache — omit to opt out of caching. */
  contextKey?: string;
  /**
   * Fired once this file's context is available (freshly loaded OR restored
   * from cache). A windowing host uses it to stop recycling this block, so the
   * ranges the reviewer expanded aren't thrown away on the next scroll.
   */
  onContextLoaded?: () => void;
  /**
   * This patch is a whole-file View render (see fileViewPatch), not a real
   * diff. Only affects wording — there are no old/new sides to name.
   */
  plain?: boolean;
}

export function ReviewDiffView({
  patch,
  filePath,
  prevFilePath,
  threads,
  actions,
  onRequestContext,
  contextKey,
  onContextLoaded,
  plain,
}: ReviewDiffViewProps): ReactElement {
  const [composeTarget, setComposeTarget] = useState<LineTarget | null>(null);
  /* Seed from the cache so a remount (windowed away and back, or a dock tab
     switch) comes straight back with the file text already in hand. */
  const [context, setContext] = useState<ContextState>(
    () => (contextKey && contextCache.get(contextKey)) || { status: 'idle' },
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<ContextState>(context);
  contextRef.current = context;

  const loadedRef = useRef(onContextLoaded);
  loadedRef.current = onContextLoaded;

  /* A new file (or a re-fetched patch) invalidates any loaded context. */
  useEffect(() => {
    setContext((contextKey && contextCache.get(contextKey)) || { status: 'idle' });
    setComposeTarget(null);
  }, [filePath, prevFilePath, patch, contextKey]);

  /* Tell the host as soon as context exists — including the cache-seeded case,
     which never goes through loadContext. */
  useEffect(() => {
    if (context.status === 'ready') loadedRef.current?.();
  }, [context.status]);

  const parsed = useMemo((): FileDiffMetadata | null => {
    try {
      const files = parsePatchFiles(patch).flatMap((p) => p.files);
      // A single-file patch is the normal case; match by name defensively so a
      // rename (name vs prevName) still resolves to the right entry.
      return files.find((f) => (
        f.name === filePath || f.prevName === filePath ||
        (prevFilePath !== undefined && (f.name === prevFilePath || f.prevName === prevFilePath))
      )) ?? files[0] ?? null;
    } catch {
      return null;
    }
  }, [patch, filePath, prevFilePath]);

  /* ── Line threads for this file ───────────────────────────────────────────
     Annotations derive from the ONE workspace-level get_threads the caller
     already runs — no per-file/per-line fetching. */
  const threadAnnotations = useMemo(
    () => guideLineAnnotations(threads, filePath, prevFilePath),
    [threads, filePath, prevFilePath],
  );

  /* The pending composer rides the SAME annotation mechanism as the threads, so
     it opens inline at the selected line rather than under the diff. Overlaid in
     its own memo: the thread mapping above is the expensive half and shouldn't
     re-run when the selection moves. */
  const lineAnnotations = useMemo(
    () => withDraftAnnotation(threadAnnotations, composeTarget, filePath, prevFilePath),
    [threadAnnotations, composeTarget, filePath, prevFilePath],
  );

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<GuideThreadMeta>) => {
    const { threads: anchored, draft } = annotation.metadata;
    return (
      <>
        {anchored.length > 0 && <InlineThreadCard threads={anchored} actions={actions} />}
        {draft && actions && (
          <InlineDraftComposer target={draft} actions={actions} plain={plain} onDone={() => setComposeTarget(null)} />
        )}
      </>
    );
  }, [actions, plain]);

  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    if (!range || !actions) return;
    setComposeTarget(lineTargetFromSelection(range, filePath));
  }, [actions, filePath]);

  /**
   * The hover-gutter '+' — the affordance that makes commenting discoverable.
   *
   * Drag-selecting a range already opened the composer, but nothing on screen
   * ever said so, which is why reviewers concluded inline comments were gone.
   * Same composer, same target shape; this just gives it a visible entry point
   * for the single-line case.
   */
  const renderHoverUtility = useCallback((
    getHoveredLine: () => { lineNumber: number; side: AnnotationSide } | undefined
  ) => (
    <button
      type="button"
      aria-label="Add line comment"
      title="Add comment"
      onMouseDown={(event) => {
        // preventDefault: a mousedown in the gutter would otherwise start a
        // line-range drag, which fights the click we actually want.
        event.preventDefault();
        const hovered = getHoveredLine();
        if (!hovered) return;
        setComposeTarget({
          kind: 'line',
          file: filePath,
          startLine: hovered.lineNumber,
          endLine: hovered.lineNumber,
          side: hovered.side === 'deletions' ? 'LEFT' : 'RIGHT',
        });
      }}
      style={{
        width: '18px',
        height: '18px',
        borderRadius: '999px',
        border: 'none',
        background: 'var(--gs-info)',
        color: 'var(--gs-text-on-accent)',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
      }}
    >
      +
    </button>
  ), [filePath]);

  /* ── Expand unmodified context ────────────────────────────────────────────
     The renderer can expand a gap on its own, but only once the file's full
     text is on the metadata. So the FIRST click on a 'n unmodified lines'
     separator is intercepted to fetch that text; once it's loaded the renderer
     owns every subsequent click and expands normally. Capture phase, because
     the separator is inside the diff's shadow DOM and handles its own clicks. */
  const loadContext = useCallback(async (): Promise<void> => {
    if (!onRequestContext) return;
    const current = contextRef.current;
    if (current.status === 'loading' || current.status === 'ready') return;
    setContext({ status: 'loading' });
    try {
      const ctx = await onRequestContext();
      if (!ctx || ctx.oldTotal <= 0 || ctx.newTotal <= 0) { setContext({ status: 'error' }); return; }
      const ready = {
        status: 'ready' as const,
        oldLines: ctx.oldLines,
        newLines: ctx.newLines,
        hash: `${ctx.oldTotal}:${ctx.newTotal}`,
      };
      if (contextKey) contextCache.set(contextKey, ready);
      setContext(ready);
    } catch {
      setContext({ status: 'error' });
    }
  }, [onRequestContext, contextKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onRequestContext) return;

    const onCaptureClick = (event: MouseEvent): void => {
      const current = contextRef.current;
      if (current.status === 'loading' || current.status === 'ready') return;

      // composedPath crosses the shadow boundary — the separator element itself
      // is never visible to a plain event.target check.
      const hitSeparator = event.composedPath().some((node) => (
        node instanceof HTMLElement && (
          node.hasAttribute('data-unmodified-lines') ||
          node.hasAttribute('data-separator-content') ||
          node.getAttribute('data-separator') === 'line-info'
        )
      ));
      if (!hitSeparator) return;

      event.preventDefault();
      event.stopPropagation();
      void loadContext();
    };

    host.addEventListener('click', onCaptureClick, true);
    return () => host.removeEventListener('click', onCaptureClick, true);
  }, [onRequestContext, loadContext]);

  /**
   * Hand the renderer the full file text once it's loaded.
   *
   * The cacheKey has to change with it: the renderer caches rendered ASTs by
   * that key, so reusing the pre-context key would serve the un-expandable
   * render straight back out of cache.
   */
  const fileDiff = useMemo((): FileDiffMetadata | null => {
    if (!parsed) return null;
    if (context.status !== 'ready') return parsed;
    return {
      ...parsed,
      cacheKey: `${parsed.cacheKey ?? filePath}:context:${context.hash}`,
      oldLines: context.oldLines,
      newLines: context.newLines,
    };
  }, [parsed, context, filePath]);

  const options = useMemo((): FileDiffOptions<GuideThreadMeta> => ({
    diffStyle: 'unified',
    theme: 'pierre-dark',
    disableFileHeader: true,
    // 'line-info' is what renders the clickable 'n unmodified lines' separators.
    hunkSeparators: 'line-info',
    // Selection AND the hover '+' drive thread creation; read-only surfaces
    // (actions === null) get an inert diff with neither.
    enableHoverUtility: actions !== null,
    enableLineSelection: actions !== null,
    onLineSelectionEnd: handleLineSelectionEnd,
  }), [actions, handleLineSelectionEnd]);

  if (!fileDiff) {
    return <div className="px-2 py-2 text-[11px] text-[var(--gs-text-dim)]">No parseable diff for {filePath}.</div>;
  }

  return (
    <div ref={hostRef} style={DIFF_CSS_VARS}>
      {context.status === 'error' && (
        <div className="px-2 py-1 text-[10.5px] text-[var(--gs-danger)]">
          Could not load the rest of {filePath} — unmodified lines can’t be expanded.
        </div>
      )}
      <FileDiff
        key={fileDiff.cacheKey ?? filePath}
        fileDiff={fileDiff}
        options={options}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
        renderHoverUtility={actions !== null ? renderHoverUtility : undefined}
      />
    </div>
  );
}
