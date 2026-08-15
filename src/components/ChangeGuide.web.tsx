/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import { renderMarkdownHtml } from './markdown-render.js';
import type { ReviewChangedFile, ReviewThread } from '../types/review.js';
import {
  ReviewDiffView,
  requestFileContext,
  useReviewThreads,
  type ReviewDiffActions,
} from './review-diff-view.web.js';

/**
 * ChangeGuidePane — the '⛓ Change Guide' review dock pane (mock: stages/ReviewStage.tsx).
 * Scrollytelling PR walkthrough: fixed left timeline (scroll-spy via IntersectionObserver),
 * right column of narrative sections with real per-file diffs, mark-complete progress and
 * a progress-gated Approve · n/m foot action.
 *
 * Walkthrough steps are derived from get_changed_files grouped by top-level directory —
 * a heuristic stand-in for an agent-authored guide. Swap `buildWalkSteps` for a richer
 * guide source (e.g. a persisted walkthrough artifact) without touching the rendering.
 */

/* ── Walkthrough step model + derivation ───────────────────────────────────────
   Lives in change-guide-steps.ts: this module imports the web-only diff
   renderer, so anything beside it cannot be reached from a Node test. */
export type { WalkStepFile, WalkStepComment, WalkStep } from './change-guide-steps.js';
import { buildWalkSteps, walkStepsFromGuide, type WalkStep, type WalkStepComment, type WalkStepFile } from './change-guide-steps.js';
export { buildWalkSteps, walkStepsFromGuide };
/* ── View state that outlives an unmount ───────────────────────────────────────
   Losing your place in the guide has two distinct causes, measured in the
   running app rather than assumed:
     1. A dock TAB SWITCH does NOT unmount this pane — dockview hides it. React
        state survives, but the pane loses layout, the windowed diffs collapse
        to spacers and the browser clamps scrollTop to 0. Handled in the pane
        itself (see `holdAnchor` + the ResizeObserver).
     2. A real UNMOUNT — closing and reopening the guide tab, or a dock layout
        rebuild — drops everything. That is what this cache is for: a
        module-level store keyed by pane identity, the same shape of solution as
        `goalDetailCache` in app.web.tsx.
   Either way the restore is by ANCHOR, never by pixels: content height depends
   on which diffs are expanded and which lazy diffs have loaded, so a saved
   scrollTop lands somewhere else entirely. */

interface GuideViewState {
  /** Anchor: the section id (or `#n`) that was active, never a pixel offset. */
  activeSectionKey: string | null;
  /** Click-gated (large) diffs the reviewer had opened. */
  openedDiffPaths: string[];
  /** Marked-complete sections (guide-mode also persists these server-side). */
  doneKeys: string[];
  /** Files whose unmodified context the reviewer had expanded. */
  expandedPaths: string[];
}

const guideViewCache = new Map<string, GuideViewState>();

/** Stable per-section key: guide sections carry an id, heuristic ones don't. */
function stepKey(s: WalkStep): string {
  return s.sectionId ?? `#${s.n}`;
}

/** Tone → who-line color for section comment threads (mock styles.css .thread .who.*). */
const THREAD_TONE: Record<WalkStepComment['tone'], string> = {
  pass: 'text-[var(--gs-accent)]',
  fail: 'text-[var(--gs-danger)]',
  info: 'text-[var(--gs-info)]',
  warn: 'text-[var(--gs-warning)]',
};


/* ── Line-anchored review threads ──────────────────────────────────────────────
   The thread chrome, the composer and the hover '+' affordance all live in the
   shared ReviewDiffView now, so the guide and a changed file opened as its own
   tab render the identical reviewable diff. */

/** @deprecated Prefer ReviewDiffActions — kept as the guide's public prop name. */
export type GuideThreadActions = ReviewDiffActions;

/* ── Per-file diff block (lazy fetch via get_file_diff, rendered with ReviewDiffView) ── */

function FileDiffBlock({ backend, projectName, workspaceName, file, onOpenFile, threads, actions, anchorKey, gateOpened = false, onGateOpen, contextOpened = false, onContextOpen }: {
  backend: SessionBackend | null;
  projectName: string;
  workspaceName: string;
  file: WalkStepFile;
  onOpenFile?: (path: string) => void;
  /** Workspace threads (all kinds) — filtered to this file's line threads here. */
  threads: ReviewThread[];
  /** null on read-only surfaces → diff renders, comment affordances don't. */
  actions: GuideThreadActions | null;
  /** Scroll-restore anchor id — file blocks are the finest-grained anchor the
   *  pane has, so a restore lands within one block rather than one section. */
  anchorKey: string;
  /** Restored from the view cache: this large diff was open before the unmount. */
  gateOpened?: boolean;
  /** Records the click-gate opening so it survives the next unmount. */
  onGateOpen?: (path: string) => void;
  /** Restored from the view cache: the reviewer had expanded context here. */
  contextOpened?: boolean;
  /** Records a context expansion so it survives the next unmount. */
  onContextOpen?: (path: string) => void;
}): ReactElement {
  const [patch, setPatch] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  // Windowed rendering (guide diffs accumulate thousands of DOM nodes):
  // fetch once when first near the viewport, but keep the diff MOUNTED only
  // while near — far-away blocks swap to a measured-height spacer so scroll
  // position holds and the DOM stays bounded.
  const [visible, setVisible] = useState(false); // ever been near → fetch
  const [nearView, setNearView] = useState(false); // currently near → mount
  const [renderHuge, setRenderHuge] = useState(gateOpened);
  /* Expanding unmodified context is a deliberate act, and the expanded ranges
     live inside the renderer — recycling the block would silently throw them
     away. So a block the reviewer has expanded opts OUT of windowing and stays
     mounted. Bounded by construction: only files they actually opened up. */
  const [pinned, setPinned] = useState(contextOpened ?? false);
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const io = new IntersectionObserver((entries) => {
      const near = entries.some((e) => e.isIntersecting);
      if (near) setVisible(true);
      setNearView((prev) => {
        if (prev && !near && bodyRef.current) heightRef.current = bodyRef.current.offsetHeight;
        return near;
      });
    }, { rootMargin: '1200px 0px' });
    io.observe(host);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setState('loading');
    setPatch(null);
    if (!backend?.sendReviewRequest) { setState('error'); return; }
    void backend
      .sendReviewRequest({ op: 'get_file_diff', projectName, workspaceName, filePath: file.path, prevFilePath: file.prevPath })
      .then((r) => {
        if (!alive) return;
        const text = r.op === 'file_diff' ? r.diff : null;
        if (text && text.trim()) { setPatch(text); setState('ready'); }
        else setState('empty');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [visible, backend, projectName, workspaceName, file.path, file.prevPath]);

  /** Above this, the renderer + shiki block the main thread — gate behind a click. */
  const HUGE_PATCH_BYTES = 60_000;
  const isHuge = patch !== null && patch.length > HUGE_PATCH_BYTES;

  /* The whole file's text, fetched on demand so unmodified gaps can expand.
     Passed as a thunk: ReviewDiffView decides WHEN (first separator click), the
     guide only says HOW. */
  const requestContext = useCallback(
    () => requestFileContext(backend, projectName, workspaceName, file.path, file.prevPath),
    [backend, projectName, workspaceName, file.path, file.prevPath],
  );
  const handleContextLoaded = useCallback(() => {
    setPinned(true);
    onContextOpen?.(file.path);
  }, [onContextOpen, file.path]);

  return (
    <div ref={hostRef} data-guide-anchor={anchorKey} className="border border-[var(--gs-border)]">
      <button
        type="button"
        onClick={() => onOpenFile?.(file.path)}
        title={onOpenFile ? `Open ${file.path}` : file.path}
        /* Pins directly below the section's sticky block. The offset is that
           block's measured height (published as --gs-guide-sticky-top on the
           section), not a constant: it changes when the notes collapse or the
           title wraps. z-20 keeps it under the section header, which owns the
           top of the viewport. */
        style={{ top: 'var(--gs-guide-sticky-top, 0px)' }}
        className="sticky z-20 flex w-full items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2.5 py-[5px] text-left font-[family-name:var(--gs-font-mono)] text-[10.5px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]"
      >
        {/* The narrator's attention mark. Without it every exhibit looks equally
            urgent, which is the diff browser the guide is meant to replace. */}
        {file.slow && (
          <span title="Slow read — the narrator flagged this one as needing judgment" className="flex-shrink-0 border border-[rgba(255,204,0,.35)] px-1 text-[9.5px] uppercase tracking-[0.08em] text-[var(--gs-warning)]">slow</span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {file.path}
          {file.changeType !== 'modified' && (
            <span className="ml-2 lowercase text-[var(--gs-text-dim)]">
              ({file.changeType}{file.changeType === 'renamed' && file.prevPath ? ` from ${file.prevPath}` : ''})
            </span>
          )}
        </span>
      </button>
      {/* Why the narrator put this file in front of you — dropped entirely until
          now, which left a curated exhibit indistinguishable from a bare path. */}
      {file.note && (
        <div className="border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2.5 py-[5px] text-[11px] leading-[1.45] text-[var(--gs-text-muted)]">
          {file.note}
        </div>
      )}
      <div ref={bodyRef} className="overflow-x-auto">
        {visible && !nearView && !pinned && state === 'ready' ? (
          <div style={{ height: heightRef.current ?? 120 }} aria-hidden="true" />
        ) : !visible || state === 'loading' ? (
          <div className="px-2 py-2 text-[11px] text-[var(--gs-text-dim)]">Loading diff…</div>
        ) : state === 'error' ? (
          <div className="px-2 py-2 text-[11px] text-[var(--gs-danger)]">Failed to load diff for {file.path}</div>
        ) : state === 'empty' ? (
          <div className="px-2 py-2 text-[11px] text-[var(--gs-text-dim)]">No textual diff (binary or unchanged content).</div>
        ) : patch && isHuge && !renderHuge ? (
          <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-[var(--gs-text-dim)]">
            Large diff ({Math.round(patch.length / 1024)}KB) — heavy to render inline.
            <button type="button" onClick={() => { setRenderHuge(true); onGateOpen?.(file.path); }} className="border border-[var(--gs-border)] px-1.5 py-px text-[10.5px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]">render anyway</button>
            {onOpenFile && (
              <button type="button" onClick={() => onOpenFile(file.path)} className="border border-[var(--gs-border)] px-1.5 py-px text-[10.5px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]">open as tab</button>
            )}
          </div>
        ) : patch ? (
          <ReviewDiffView
            patch={patch}
            filePath={file.path}
            prevFilePath={file.prevPath}
            threads={threads}
            actions={actions}
            onRequestContext={requestContext}
            contextKey={`${projectName}/${workspaceName}/${file.path}`}
            onContextLoaded={handleContextLoaded}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ── The pane ──────────────────────────────────────────────────────────────── */

export function ChangeGuidePane({ backend, projectName, workspaceName, workspaceId, onOpenFile, onApprove, onOpenRubric, onRequestChanges, onGenerateGuide, humanGatePending = 0 }: {
  backend: SessionBackend | null;
  projectName: string;
  workspaceName: string;
  /** Enables guide-mode (review/guide.json) + persisted read-state. */
  workspaceId?: string;
  onOpenFile?: (path: string) => void;
  onApprove?: () => void;
  /** Opens the Review rubric pane (mock: foot '☰ Review rubric' → open('rubric')). */
  onOpenRubric?: () => void;
  /** The review loop: compose findings → workspace agent, stage back to code. */
  onRequestChanges?: (prompt: string) => void;
  /** Spawn a narrator session (review-guide-narrator skill). */
  onGenerateGuide?: () => void;
  /** Required human-gated requirements still awaiting a verdict — Approve is
   *  blocked until 0 (mock: review-gated approval owned by the human). */
  humanGatePending?: number;
}): ReactElement {
  const [steps, setSteps] = useState<WalkStep[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [active, setActive] = useState(0);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [reloadTick, setReloadTick] = useState(0);
  const [guideMode, setGuideMode] = useState(false);
  /** The narrative was written against an earlier HEAD. The guide is a cache
   *  (docs/REVIEW-GUIDE.md); showing a stale one as current is how it lies. */
  const [guideStale, setGuideStale] = useState(false);
  /** Workspace HEAD as of the guide read. Stamped into the approval record so an
   *  approval names the commit it approved. */
  const [headSha, setHeadSha] = useState('');
  const [specEvolution, setSpecEvolution] = useState<string | null>(null);
  /** ONE get_threads per workspace feeds both the Approve gate and the
   *  line-anchored inline threads in every file diff. Shared with the file-tab
   *  surface so a comment left in either place is the same thread. */
  const { threads, actions: threadActions } = useReviewThreads(backend, projectName, workspaceName);
  /* Per-file facts from git's name-status, keyed by path. This is the AUTHORITY
     for changeType and rename source: a guide exhibit names a file, not how it
     changed, and the mapping used to stamp every exhibit 'modified' — so an
     added or renamed file was described wrongly in its own header. */
  const [fileStats, setFileStats] = useState<Map<string, { additions?: number; deletions?: number; changeType: ReviewChangedFile['changeType']; prevPath?: string }>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<Array<HTMLElement | null>>([]);

  /* ── View state that must outlive a dockview tab switch ─────────────────── */
  const viewKey = workspaceId ?? `${projectName}/${workspaceName}`;
  /** Opened click-gates, mirrored in a ref so FileDiffBlock can read it at mount. */
  const openedGatesRef = useRef<Set<string>>(new Set(guideViewCache.get(viewKey)?.openedDiffPaths ?? []));
  /** Files expanded past their hunks — pinned out of windowing, same as gates. */
  const expandedPathsRef = useRef<Set<string>>(new Set(guideViewCache.get(viewKey)?.expandedPaths ?? []));
  const [gateTick, setGateTick] = useState(0);
  const noteGateOpen = useCallback((path: string): void => {
    openedGatesRef.current.add(path);
    setGateTick((t) => t + 1);
  }, []);
  const noteContextOpen = useCallback((path: string): void => {
    if (expandedPathsRef.current.has(path)) return;
    expandedPathsRef.current.add(path);
    setGateTick((t) => t + 1);
  }, []);
  /** Restore runs once per pane identity per mount. */
  const restoredRef = useRef<string | null>(null);

  /**
   * Height of each section's sticky block, published onto the section as
   * `--gs-guide-sticky-top` so the per-file diff headers can pin directly below
   * it. Measured rather than hardcoded: the block's height changes when the
   * notes collapse, when the title wraps, and between guide and heuristic mode.
   */
  const stickyRefs = useRef<Array<HTMLElement | null>>([]);
  useEffect(() => {
    const publish = (el: HTMLElement): void => {
      el.closest('section')?.style.setProperty('--gs-guide-sticky-top', `${Math.round(el.offsetHeight)}px`);
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) publish(entry.target as HTMLElement);
    });
    for (const el of stickyRefs.current) {
      if (!el) continue;
      publish(el);
      observer.observe(el);
    }
    return () => observer.disconnect();
  });

  useEffect(() => {
    let alive = true;
    setLoadState('loading');
    setDone(new Set());
    setActive(0);
    if (!backend?.sendReviewRequest) { setLoadState('error'); return; }

    const loadHeuristic = async (): Promise<void> => {
      const r = await backend.sendReviewRequest!({ op: 'get_changed_files', projectName, workspaceName });
      if (!alive || r.op !== 'changed_files') { if (alive) setLoadState('error'); return; }
      secRefs.current = [];
      setGuideMode(false);
      setSteps(buildWalkSteps(r.files));
      setLoadState('ready');
    };

    void (async () => {
      // Guide-mode: narrated guide resolved by the daemon via the canonical
      // goal-scoped reader (goals/<goalId>/review/guide.json). Reading the
      // mount-root 'review/guide.json' from the client never resolved for a
      // workspace goal, so the guide silently fell back to the heuristic walk.
      try {
        if (backend.sendReviewRequest) {
          const resp = await backend.sendReviewRequest({ op: 'get_review_guide', projectName, workspaceName });
          const guide = resp.op === 'review_guide' ? resp.guide : null;
          if (!alive) return;
          // Before the no-guide bail: HEAD comes back either way, and the
          // heuristic walk still records approvals against it.
          if (resp.op === 'review_guide' && resp.headSha) setHeadSha(resp.headSha);
          if (!guide) throw new Error('no guide');
          secRefs.current = [];
          setGuideMode(true);
          setGuideStale(resp.op === 'review_guide' && resp.stale === true);
          setSpecEvolution(guide.specEvolution ?? null);
          setSteps(walkStepsFromGuide(guide));
          setLoadState('ready');
          // persisted read-state keyed by section id
          const st = await backend.sendReviewRequest!({ op: 'get_review_guide_state', projectName, workspaceName });
          if (alive && st.op === 'review_guide_state') {
            const read = new Set(st.state.readSections);
            setDone(new Set(guide.sections.map((sec, i) => (read.has(sec.clusterId) ? i : -1)).filter((i) => i >= 0)));
          }
          return;
        }
      } catch { /* no guide yet — heuristic below */ }
      await loadHeuristic().catch(() => { if (alive) setLoadState('error'); });
    })();

    // Per-file facts for the manifests AND for each exhibit's real change type.
    void backend.sendReviewRequest({ op: 'get_changed_files', projectName, workspaceName })
      .then((r) => {
        if (!alive || r.op !== 'changed_files') return;
        setFileStats(new Map(r.files.map((f) => [f.filePath, { additions: f.additions, deletions: f.deletions, changeType: f.changeType, prevPath: f.prevFilePath }])));
      })
      .catch(() => undefined);

    return () => { alive = false; };
  }, [backend, projectName, workspaceName, workspaceId, reloadTick]);

  /** Approve gate + the request-changes prompt read off the same thread list. */
  const { threadsOpen, unresolvedSummaries } = useMemo(() => {
    const open = threads.filter((t) => !t.resolved);
    return {
      threadsOpen: open.length,
      unresolvedSummaries: open.map((t) => {
        const target = t.target.kind === 'workspace' ? 'workspace' : (t.target as { file?: string }).file ?? 'file';
        const first = t.comments[0]?.body?.split('\n')[0] ?? '';
        return `- [${target}] ${first}`.slice(0, 200);
      }),
    };
  }, [threads]);

  /** Persist read-state in guide-mode (fire-and-forget; heuristic mode stays in-memory). */
  const persistRead = useCallback((nextDone: Set<number>, allSteps: WalkStep[]) => {
    if (!guideMode || !backend?.sendReviewRequest) return;
    const readSections = allSteps.filter((_, i) => nextDone.has(i)).map((st) => st.sectionId!).filter(Boolean);
    void backend.sendReviewRequest({ op: 'set_review_guide_state', projectName, workspaceName, state: { readSections } }).catch(() => undefined);
  }, [guideMode, backend, projectName, workspaceName]);

  /* Scroll-spy: IntersectionObserver on sections drives the active timeline step.
     Active = last section whose top sits above a line 72px into the scroll viewport;
     snap to the last step when scrolled to the bottom. */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || steps.length === 0) return;
    const recompute = (): void => {
      // A hidden dock tab has no layout: every rect collapses to 0 and the
      // windowed diffs swap to spacers, which would otherwise walk `active` to
      // the last step (all tops <= the line) and then to the first (scrollTop
      // clamped to 0). Ignore the spy entirely while the pane isn't laid out.
      if (!root.isConnected || root.clientHeight === 0) return;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) { setActive(steps.length - 1); return; }
      const line = root.getBoundingClientRect().top + 72;
      let idx = 0;
      secRefs.current.forEach((el, i) => { if (el && el.getBoundingClientRect().top <= line) idx = i; });
      setActive(idx);
    };
    const io = new IntersectionObserver(recompute, { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    for (const el of secRefs.current) { if (el) io.observe(el); }
    recompute();
    return () => io.disconnect();
  }, [steps]);

  /* ── Restore by ANCHOR, never by pixels ───────────────────────────────────
     Two things can lose the reviewer's place, and both land here:
       · a dock TAB SWITCH — the pane keeps its React state but loses layout,
         so the windowed diffs collapse to spacers and the browser clamps
         scrollTop to 0; when the tab comes back the content re-expands under a
         scroll offset that now means something completely different.
       · a real UNMOUNT — closing and reopening the guide tab, or a layout
         rebuild — which drops everything, hence the module cache.
     Both restore the same way: re-open the click-gated diffs first (the file
     blocks read `gateOpened` at mount), then pull the ANCHORED ELEMENT back to
     its old offset and HOLD it there, because the lazy diffs above and below
     keep changing height for a while after the scroll. Any real scroll input
     from the reviewer wins immediately. */
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Last known reading position: the anchored element at the fold + its offset. */
  const anchorRef = useRef<{ key: string; offset: number; idx: number } | null>(null);
  /** Cancels an in-flight anchor hold — the timeline lives outside the scroll
   *  root, so its clicks can't reach the hold's own listeners. */
  const releaseHoldRef = useRef<() => void>(() => {});

  /**
   * Pin the element tagged `data-guide-anchor={key}` at `offset` px from the top
   * of the scroll viewport and keep it there while the lazy diffs settle.
   *
   * `offset` is what makes this a position restore rather than a jump-to-heading:
   * it carries how far past the anchor the reviewer had actually read. Anchors
   * are placed on sections AND on every file-diff block, so the nearest one above
   * the fold is never far — which matters, because the anchored element's own
   * height is the one thing an offset can't survive, and a file block is a much
   * smaller bet than a whole section.
   */
  const holdAnchor = useCallback((key: string, offset = -6, capMs = 8000): (() => void) => {
    const root = scrollRef.current;
    if (!root || !key) return () => {};
    const find = (): HTMLElement | null => root.querySelector<HTMLElement>(`[data-guide-anchor="${key}"]`);
    let raf = 0;
    let cancelled = false;
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const stop = (): void => {
      cancelled = true;
      cancelAnimationFrame(raf);
      for (const ev of events) root.removeEventListener(ev, stop);
      if (releaseHoldRef.current === stop) releaseHoldRef.current = () => {};
    };
    // Any real navigation intent wins over the restore, instantly.
    for (const ev of events) root.addEventListener(ev, stop, { passive: true });
    releaseHoldRef.current();
    releaseHoldRef.current = stop;
    /* Hold until the anchor STOPS MOVING, not for a fixed time: coming back to
       the tab re-expands the windowed diffs from their spacer estimates, and a
       block that was never measured (120px placeholder) can grow by thousands
       of pixels seconds later. Release after the anchor has been still for
       ~half a second; the hard cap only guards a pathological never-settling
       layout. */
    const hardCap = Date.now() + capMs;
    let stillFor = 0;
    const hold = (): void => {
      if (cancelled) return;
      const el = find();
      if (el && root.clientHeight > 0) {
        const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top - offset;
        if (Math.abs(delta) > 1) { root.scrollTop += delta; stillFor = 0; }
        else stillFor += 1;
      }
      if (stillFor >= 30 || Date.now() > hardCap) { stop(); return; }
      raf = requestAnimationFrame(hold);
    };
    raf = requestAnimationFrame(hold);
    return stop;
  }, []);

  /* Tab switch: the pane loses and regains layout without ever unmounting.
     Watch the scroll root's size — 0 means the tab went away (snapshot the
     anchor), non-0 again means it came back (restore it). */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || steps.length === 0) return;
    /* The anchor has to be sampled while the pane is still laid out — by the
       time the tab is hidden, scrollTop is already clamped and every rect reads
       0, so measuring then would capture the damage instead of the position. */
    const sample = (): void => {
      if (root.clientHeight === 0) return;
      const rootTop = root.getBoundingClientRect().top;
      let best: { key: string; offset: number } | null = null;
      // The last anchored element that starts at or above the fold — the thing
      // the reviewer is actually looking at.
      for (const el of root.querySelectorAll<HTMLElement>('[data-guide-anchor]')) {
        const offset = el.getBoundingClientRect().top - rootTop;
        if (offset > 1) break;
        best = { key: el.dataset.guideAnchor!, offset };
      }
      if (best) anchorRef.current = { ...best, idx: activeRef.current };
    };
    root.addEventListener('scroll', sample, { passive: true });
    sample();

    let wasHidden = root.clientHeight === 0;
    let release = (): void => {};
    const ro = new ResizeObserver(() => {
      const laidOut = root.clientHeight > 0;
      if (!laidOut) { wasHidden = true; return; }
      if (!wasHidden) return;
      wasHidden = false;
      const anchor = anchorRef.current;
      if (!anchor) return;
      setActive(anchor.idx);
      release();
      release = holdAnchor(anchor.key, anchor.offset);
    });
    ro.observe(root);
    return () => { ro.disconnect(); release(); root.removeEventListener('scroll', sample); };
  }, [steps, holdAnchor]);

  /* Real unmount (tab closed and reopened, layout rebuilt): the module cache is
     the only thing left, so replay it once per pane identity. */
  useEffect(() => {
    if (loadState !== 'ready' || steps.length === 0) return;
    if (restoredRef.current === viewKey) return;
    restoredRef.current = viewKey;

    const cached = guideViewCache.get(viewKey);
    openedGatesRef.current = new Set(cached?.openedDiffPaths ?? []);
    expandedPathsRef.current = new Set(cached?.expandedPaths ?? []);
    setGateTick((t) => t + 1);
    if (!cached) return;

    if (cached.doneKeys.length > 0) {
      const keys = new Set(cached.doneKeys);
      setDone(new Set(steps.map((s, i) => (keys.has(stepKey(s)) ? i : -1)).filter((i) => i >= 0)));
    }

    const idx = steps.findIndex((s) => stepKey(s) === cached.activeSectionKey);
    if (idx <= 0) return;
    setActive(idx);
    // Nothing is laid out yet after a fresh mount, so the section top is the
    // only honest target — an intra-section offset would be measured against
    // content that hasn't loaded.
    return holdAnchor(`s${idx}`);
  }, [loadState, steps, viewKey, holdAnchor]);

  /* Park the anchor + gates + read-state so the next mount can restore them. */
  useEffect(() => {
    if (loadState !== 'ready' || steps.length === 0) return;
    guideViewCache.set(viewKey, {
      activeSectionKey: steps[active] ? stepKey(steps[active]!) : null,
      openedDiffPaths: [...openedGatesRef.current],
      expandedPaths: [...expandedPathsRef.current],
      doneKeys: steps.filter((_, i) => done.has(i)).map(stepKey),
    });
  }, [viewKey, steps, active, done, loadState, gateTick]);

  /* Timeline click: jump to a section and CONVERGE on it.
     A one-shot `scrollIntoView` lands short, badly — measured in the running
     app, a click on section 28 from the top landed 11,023px above it, and one
     on section 5 landed 21,534px above it. The reason is windowing: the file
     blocks between here and there are unmounted spacers (a never-measured one
     is a single "Loading diff…" line), so the target's offset is computed
     against a page that is far shorter than the page you arrive on. The blocks
     fetch and expand as they come near, the target slides down, and the scroll
     — already committed to a number — stops where the target USED to be.
     So don't scroll to a number, hold the anchor: `holdAnchor` re-asserts the
     target's position every frame until it stops moving, which is exactly the
     convergence this needs. Deliberately NOT smooth — a per-frame hold and a
     smooth animation fight for scrollTop, and an animation toward a coordinate
     that moves 20k px is a lie anyway. The first hold frame is the jump; the
     rest are the corrections, and they're invisible because the anchor is what
     stays still while the content around it settles.
     Longer cap than a restore: a cold far jump traverses many unfetched blocks
     and can need several seconds of correction rounds. Reviewer input (wheel /
     touch / key / pointer) still cancels the hold instantly, so scrolling away
     mid-navigation is never undone. */
  const go = useCallback((i: number): void => {
    releaseHoldRef.current();
    setActive(i);
    holdAnchor(`s${i}`, 0, 20000);
  }, [holdAnchor]);

  const toggleDone = useCallback((i: number): void => {
    setDone((d) => {
      const next = new Set(d);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      persistRead(next, steps);
      return next;
    });
  }, [persistRead, steps]);

  /** Collapsed note blocks, by section key. Sections are open by default and
   *  this only records the exceptions, so a new section never starts hidden. */
  const [notesCollapsed, setNotesCollapsed] = useState<Set<string>>(new Set());
  const toggleNotes = useCallback((key: string): void => {
    setNotesCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const total = steps.length;
  const completed = done.size;
  const allDone = total > 0 && completed === total;
  const activeStep = steps[active];

  if (loadState === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[var(--gs-bg)] text-[12px] text-[var(--gs-text-dim)]">
        Loading changed files…
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-[var(--gs-bg)] text-[12px]">
        <span className="text-[var(--gs-danger)]">Failed to load the change guide.</span>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          className="border border-[var(--gs-border)] px-2 py-0.5 text-[11px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
        >
          Retry
        </button>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[var(--gs-bg)] text-[12px] text-[var(--gs-text-dim)]">
        No changed files — nothing to walk through.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-[var(--gs-bg)] text-[var(--gs-text)]">
      {/* LEFT — fixed timeline column */}
      <div className="flex w-[300px] flex-shrink-0 flex-col border-r border-[var(--gs-border)] bg-[#050505]">
        <div className="flex-shrink-0 border-b border-[var(--gs-border)] px-3.5 py-3">
          <div className="text-[12px] font-medium text-[var(--gs-text)]">Change Guide · the PR as a story</div>
        </div>

        <div className="relative max-h-[55%] flex-shrink-0 overflow-y-auto py-2">
          <div className="pointer-events-none absolute bottom-2 left-[22px] top-2 w-px bg-[var(--gs-border)]" />
          {steps.map((s, i) => {
            const isActive = active === i;
            const isDone = done.has(i);
            return (
              <button
                key={s.n}
                type="button"
                onClick={() => go(i)}
                className={`relative flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[11.5px] transition-colors duration-[120ms] ${
                  isActive ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'
                }`}
              >
                <span
                  className={`h-[9px] w-[9px] flex-shrink-0 rounded-full border-2 transition-colors duration-[120ms] ${
                    isDone
                      ? 'border-[var(--gs-success)] bg-[var(--gs-success)]'
                      : isActive
                        ? 'border-[var(--gs-accent)] bg-[var(--gs-accent)] shadow-[0_0_10px_var(--gs-accent)]'
                        : 'border-[var(--gs-border-active)] bg-[var(--gs-bg)]'
                  }`}
                />
                <span className={`w-4 flex-shrink-0 text-right font-[family-name:var(--gs-font-mono)] text-[10px] tabular-nums ${isDone ? 'text-[var(--gs-success)]' : isActive ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)]'}`}>
                  {isDone ? '✓' : s.n}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-shrink-0 px-3.5 py-1.5 text-[10px] tabular-nums text-[var(--gs-text-dim)]">
          {completed} / {total} phases reviewed
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--gs-border)] p-3.5">
          {guideMode && specEvolution && active === 0 && (
            <div className="mb-3 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-purple,#bc8cff)] bg-[var(--gs-bg-elevated)] px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#bc8cff]">how the spec evolved</div>
              <div className="gs-block-md mt-1 text-[11.5px] leading-[1.55] text-[var(--gs-text-muted)]" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(specEvolution) }} />
            </div>
          )}
          {activeStep && (
            <>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">{activeStep.kind}</div>
              {activeStep.explanationMd ? (
                <div className="mt-2 text-[11px] text-[var(--gs-text-dim)]">
                  {(activeStep.allFiles ?? activeStep.files).length} file{(activeStep.allFiles ?? activeStep.files).length === 1 ? '' : 's'} · narrative and diffs on the right.
                </div>
              ) : (
                <>
                  <p className="mt-2 text-[12.5px] leading-[1.55] text-[var(--gs-text)]">{activeStep.what}</p>
                  <p className="mt-2 text-[11.5px] leading-[1.55] text-[var(--gs-text-muted)]">
                    <span className="mr-1.5 uppercase text-[10px] tracking-[0.1em] text-[var(--gs-accent)]">why</span>
                    {activeStep.why}
                  </p>
                </>
              )}
              {!activeStep.explanationMd && (activeStep.callouts ?? []).map((c, ci) => (
                <div key={ci} className={`mt-2 border-l-2 px-2 py-1 text-[11px] ${c.tone === 'risk' ? 'border-[var(--gs-danger)] text-[var(--gs-danger)]' : c.tone === 'decision' ? 'border-[var(--gs-info)] text-[var(--gs-text-muted)]' : 'border-[var(--gs-border-active)] text-[var(--gs-text-dim)]'}`}>
                  <span className="mr-1 uppercase text-[9.5px] tracking-[0.1em]">{c.tone}</span>{c.text}
                </div>
              ))}
              {!activeStep.explanationMd && (activeStep.asks ?? []).map((a, ai) => (
                <div key={ai} className="mt-2 border border-[rgba(188,140,255,.3)] px-2 py-1 text-[11px] text-[#bc8cff]">
                  <span className="mr-1">?</span>{a}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Foot bar — rubric shortcut + human-gate owned approval (mock ReviewStage rg-foot) */}
        <div className="flex flex-shrink-0 items-center gap-[7px] border-t border-[var(--gs-border)] px-3.5 py-2.5">
          <button
            type="button"
            onClick={() => onOpenRubric?.()}
            className="border border-[var(--gs-border)] px-2 py-[3px] text-[11px] text-[var(--gs-text-muted)] transition-colors duration-[120ms] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)] active:scale-[.96]"
          >
            ☰ Review rubric
          </button>
          {/* A stale guide could not be regenerated from here: the button hid the
              moment a guide existed, so a narrative written against an older HEAD
              was a dead end. The guide is a cache keyed by headSha — regenerating
              it is the documented response to HEAD moving. */}
          {(!guideMode || guideStale) && onGenerateGuide && (
            <button
              type="button"
              onClick={onGenerateGuide}
              title={guideStale
                ? 'This guide was written against an earlier commit — spawn a narrator to re-narrate the changed clusters'
                : 'Spawn a narrator session that writes review/guide.json for this diff'}
              className={`border px-2 py-[3px] text-[11px] transition-colors duration-[120ms] active:scale-[.96] ${
                guideStale
                  ? 'border-[#4a3a1f] text-[var(--gs-warning)] hover:bg-[rgba(255,204,0,.08)]'
                  : 'border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]'
              }`}
            >
              {guideStale ? '✦ Regenerate guide' : '✦ Generate guide'}
            </button>
          )}
          {onRequestChanges && (threadsOpen > 0 || humanGatePending > 0) && (
            <button
              type="button"
              onClick={() => {
                const prompt = [
                  'Review requested changes — please address, then re-run the guide.',
                  unresolvedSummaries.length ? `\nOpen review threads:\n${unresolvedSummaries.join('\n')}` : '',
                  humanGatePending > 0 ? `\n${humanGatePending} required human-gated requirement(s) still lack a passing verdict — check the rubric.` : '',
                ].filter(Boolean).join('\n');
                onRequestChanges(prompt);
              }}
              className="border border-[#4a3a1f] px-2 py-[3px] text-[11px] text-[var(--gs-warning)] transition-colors duration-[120ms] hover:bg-[rgba(255,204,0,.08)] active:scale-[.96]"
            >
              ↺ Request changes
            </button>
          )}
          <button
            type="button"
            disabled={!allDone || humanGatePending > 0 || threadsOpen > 0}
            onClick={() => {
              if (!allDone || humanGatePending > 0 || threadsOpen > 0) return;
              // Record the approval durably, then let the shell advance the stage.
              // headSha was hardcoded '' here, so every approval recorded that it
              // approved nothing in particular — docs/REVIEW-GUIDE.md requires
              // {by, at, headSha} precisely so an approval can be checked against
              // what was actually reviewed.
              void backend?.sendReviewRequest?.({
                op: 'set_review_guide_state', projectName, workspaceName,
                state: { readSections: steps.filter((_, i) => done.has(i)).map((st) => st.sectionId ?? String(st.n)), approval: { by: 'human', at: new Date().toISOString(), headSha } },
              }).catch(() => undefined);
              onApprove?.();
            }}
            title={humanGatePending > 0 ? `${humanGatePending} human gate${humanGatePending === 1 ? '' : 's'} pending in the rubric` : undefined}
            className={`ml-auto whitespace-nowrap border border-[var(--gs-accent)] bg-[var(--gs-accent)] px-2 py-[3px] text-[11px] font-medium tabular-nums text-[var(--gs-text-on-accent)] transition-colors duration-[120ms] ${
              allDone && humanGatePending === 0 && threadsOpen === 0
                ? 'hover:bg-[var(--gs-accent-hover)] active:scale-[.96]'
                : 'cursor-not-allowed opacity-40'
            }`}
          >
            {allDone && humanGatePending === 0 && threadsOpen === 0 ? 'Approve' : `Approve · ${completed}/${total}${threadsOpen > 0 ? ` · ${threadsOpen} open thread${threadsOpen === 1 ? '' : 's'}` : ''}`}
          </button>
        </div>
      </div>

      {/* RIGHT — scrolling walkthrough sections */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        {guideStale && (
          <div className="mb-3 border border-[#4a3a1f] bg-[rgba(255,204,0,.06)] px-2.5 py-2 text-[11.5px] leading-[1.5] text-[var(--gs-warning)]">
            This guide was written against an earlier commit. Sections still describe
            the diff as it was then, and the exhibits below are the current diff — so
            the two can disagree. Regenerate to re-narrate the clusters that moved.
          </div>
        )}
        {steps.map((s, i) => {
          const isDone = done.has(i);
          // Notes = everything the narrator wrote about this step. Open by
          // default: the whole point is reading the code with the reason for it
          // still on screen.
          const hasNotes = Boolean(s.explanationMd) || (s.callouts ?? []).length > 0 || (s.asks ?? []).length > 0;
          const notesOpen = !notesCollapsed.has(stepKey(s));
          return (
            <section
              key={s.n}
              ref={(el) => { secRefs.current[i] = el; }}
              data-guide-anchor={`s${i}`}
              className={`mb-[18px] scroll-mt-[6px] border ${isDone ? 'border-[rgba(0,255,102,0.3)]' : 'border-[var(--gs-border)]'}`}
            >
              {/* Header + narrative pin together as ONE sticky block.

                  In guide mode the left panel deliberately holds no prose — it
                  says "narrative and diffs on the right" — so the explanation
                  lives in this scrolling column, which made it something you
                  scroll PAST to reach the code it explains. By the time you were
                  reading a diff, the reason for it was off-screen, along with the
                  Mark complete button.

                  One wrapper rather than two sticky siblings: stacking them would
                  need a hardcoded `top` offset equal to the header's height, which
                  is wrong the moment the header wraps. */}
              <div ref={(el) => { stickyRefs.current[i] = el; }} className="sticky top-0 z-30">
                <div
                  /* Opaque by construction: the done state is a translucent tint,
                     which over a sticky element would let the diff show through.
                     Composited over the surface colour so it stays theme-correct. */
                  style={{ background: isDone ? 'linear-gradient(rgba(0,255,102,0.05),rgba(0,255,102,0.05)), var(--gs-bg-elevated)' : 'var(--gs-bg-elevated)' }}
                  className="flex items-center gap-2.5 border-b border-[var(--gs-border)] px-[11px] py-[9px]"
                >
                  <span
                    className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border font-[family-name:var(--gs-font-mono)] text-[10px] tabular-nums ${
                      isDone ? 'border-[var(--gs-success)] text-[var(--gs-success)]' : 'border-[var(--gs-border-active)] text-[var(--gs-text-muted)]'
                    }`}
                  >
                    {isDone ? '✓' : s.n}
                  </span>
                  <span className="min-w-0 truncate text-[13px] font-medium text-[var(--gs-text)]">{s.title}</span>
                  <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-[0.06em] text-[var(--gs-text-dim)]">{s.kind}</span>
                  {hasNotes && (
                    <button
                      type="button"
                      onClick={() => toggleNotes(stepKey(s))}
                      title={notesOpen ? 'Collapse the notes for this step' : 'Keep the notes on screen while you read the diffs'}
                      className="flex-shrink-0 whitespace-nowrap border border-[var(--gs-border-active)] px-1.5 py-0.5 text-[10.5px] text-[var(--gs-text-muted)] transition-colors duration-[120ms] hover:border-[var(--gs-text-muted)] hover:text-[var(--gs-text)]"
                    >
                      {notesOpen ? '▾ notes' : '▸ notes'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleDone(i)}
                    className={`flex-shrink-0 whitespace-nowrap px-2 py-0.5 text-[10.5px] transition-transform duration-[120ms] active:scale-[.96] ${
                      isDone
                        ? 'border border-[var(--gs-success)] bg-[var(--gs-success)] text-[var(--gs-text-on-accent)]'
                        : 'border border-[var(--gs-border-active)] text-[var(--gs-text-muted)] hover:border-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'
                    }`}
                  >
                    {isDone ? '✓ Complete' : 'Mark complete'}
                  </button>
                </div>
                {/* Capped and scrollable: an explanation can run several
                    paragraphs, and pinning all of it would eat the viewport it is
                    supposed to help you read. */}
                {hasNotes && notesOpen && (
                  <div className="max-h-[32vh] overflow-y-auto border-b border-[var(--gs-border)] bg-[var(--gs-bg)] px-[11px] py-2.5">
                    <div className="flex flex-col gap-2.5">
                      {s.explanationMd && (
                        <div className="gs-block-md text-[12.5px] leading-[1.55] text-[var(--gs-text)]" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(s.explanationMd) }} />
                      )}
                      {(s.callouts ?? []).map((c, ci) => (
                        <div key={ci} className={`border-l-2 px-2 py-1 text-[11px] ${c.tone === 'risk' ? 'border-[var(--gs-danger)] text-[var(--gs-danger)]' : c.tone === 'decision' ? 'border-[var(--gs-info)] text-[var(--gs-text-muted)]' : 'border-[var(--gs-border-active)] text-[var(--gs-text-dim)]'}`}>
                          <span className="mr-1 uppercase text-[9.5px] tracking-[0.1em]">{c.tone}</span>{c.text}
                        </div>
                      ))}
                      {(s.asks ?? []).map((a, ai) => (
                        <div key={ai} className="border border-[rgba(188,140,255,.3)] px-2 py-1 text-[11px] text-[#bc8cff]">
                          <span className="mr-1">?</span>{a}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2.5 p-[11px]">
                {/* Full file manifest with line stats; exhibits render diffs below. */}
                {(s.allFiles ?? []).length > 0 && (
                  <div className="border border-[var(--gs-border)]">
                    <div className="border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2.5 py-[4px] text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">
                      {s.allFiles!.length} file{s.allFiles!.length === 1 ? '' : 's'} in this step
                    </div>
                    <div className="max-h-[220px] overflow-y-auto py-0.5">
                      {s.allFiles!.map((path) => {
                        const st = fileStats.get(path);
                        return (
                          <button
                            key={path}
                            type="button"
                            onClick={() => onOpenFile?.(path)}
                            className="flex w-full items-baseline gap-2 px-2.5 py-[2px] text-left font-[family-name:var(--gs-font)] text-[10.5px] text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]"
                          >
                            <span className="min-w-0 flex-1 truncate">{path}</span>
                            {st?.changeType && st.changeType !== 'modified' && (
                              <span className="flex-shrink-0 lowercase text-[9.5px] text-[var(--gs-text-dim)]">{st.changeType}</span>
                            )}
                            <span className="flex-shrink-0 tabular-nums">
                              {st?.additions !== undefined && <span className="text-[var(--gs-success)]">+{st.additions}</span>}
                              {st?.deletions !== undefined && <span className="ml-1 text-[var(--gs-danger)]">−{st.deletions}</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {s.files.length === 0 && guideMode && (
                  <div className="border border-dashed border-[var(--gs-border)] px-2.5 py-2 text-[11px] text-[var(--gs-text-dim)]">
                    No exhibits in this step — the narrator described it without singling out a file to read.
                  </div>
                )}
                {s.files.map((f) => {
                  // git's name-status wins over the guide's provisional 'modified':
                  // it knows an add from a rename, and it carries the rename source
                  // that makes a renamed exhibit diff as a rename instead of a
                  // whole new file.
                  const git = fileStats.get(f.path);
                  const file = git ? { ...f, changeType: git.changeType, prevPath: git.prevPath ?? f.prevPath } : f;
                  return (
                    <FileDiffBlock
                      key={f.path}
                      backend={backend}
                      projectName={projectName}
                      workspaceName={workspaceName}
                      file={file}
                      onOpenFile={onOpenFile}
                      threads={threads}
                      actions={threadActions}
                      anchorKey={`f${i}:${f.path}`}
                      gateOpened={openedGatesRef.current.has(f.path)}
                      onGateOpen={noteGateOpen}
                      contextOpened={expandedPathsRef.current.has(f.path)}
                      onContextOpen={noteContextOpen}
                    />
                  );
                })}
                {s.comment && (
                  <div className="border-l-2 border-[var(--gs-border-active)] bg-[#050505] px-[11px] py-2 text-[11.5px]">
                    <div className={`text-[10.5px] ${THREAD_TONE[s.comment.tone]}`}>◆ {s.comment.who}</div>
                    <div className="mt-[3px] text-[var(--gs-text-muted)]">{s.comment.text}</div>
                    {/* The mock had a Send-to-agent / Comment / Dismiss trio here.
                        None were ever wired, and no generated guide supplies
                        `comment` at all — three buttons that did nothing is worse
                        than none. Real routing lives in Request changes, which
                        composes the open threads into one prompt. */}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
