import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Block } from '../index.js';
import type { TranscriptPage } from '../agent/transcript-source.js';

const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 120;
const DEFAULT_PAGE_SIZE = 40;

export type TranscriptMode = 'follow' | 'browse';

export interface UseTranscript {
  /** Attach to the scroll container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Committed history (paged, oldest → newest). */
  committed: Block[];
  mode: TranscriptMode;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  olderError: string | null;
  /** New blocks streamed in while browsing (for the jump-to-latest pill). */
  newBelowCount: number;
  jumpToLatest: () => void;
  retryOlder: () => void;
}

/**
 * Infinite-scroll transcript: a committed prefix paged from the session (pull,
 * oldest-ward) + a live suffix the caller supplies (push). Owns the two modes
 * (follow = pinned to bottom for streaming; browse = scrolled up, anchored),
 * scroll anchoring on prepend, and the jump-to-latest signal.
 *
 * `fetchRange(before, limit)` reads a page (server side maps entries → blocks);
 * `live` is the re-rendered live suffix (from agent events). Both injected so
 * the hook stays transport-agnostic and testable.
 */
export function useTranscript(opts: {
  fetchRange: (before: string | undefined, limit: number) => Promise<TranscriptPage>;
  live: readonly Block[];
  pageSize?: number;
  /** Bump to force a full refetch of the tail (e.g. after a conversation rewind). */
  refreshNonce?: number;
}): UseTranscript {
  const { fetchRange, live, refreshNonce } = opts;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [committed, setCommitted] = useState<Block[]>([]);
  const [mode, setMode] = useState<TranscriptMode>('follow');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [newBelowCount, setNewBelowCount] = useState(0);

  // refs mirror state for use inside scroll/async callbacks (avoid stale closures)
  const cursorRef = useRef<string | undefined>(undefined);
  const modeRef = useRef<TranscriptMode>(mode);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(false);
  const anchorRef = useRef<number | null>(null); // scrollHeight captured before a prepend
  const liveLenRef = useRef(0);
  /** Invalidate every in-flight transcript page when committed history rewrites. */
  const generationRef = useRef(0);
  modeRef.current = mode;
  hasMoreRef.current = hasMoreOlder;

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /**
   * Is the user mid-selection inside the transcript?
   *
   * Autoscroll fires on any IDENTITY change of `committed`/`live`, not just a
   * content change — and a `transcript_live` delta hands over a fresh array each
   * time, so a session that looks settled can still re-emit. Scrolling to the
   * bottom under a live selection doesn't clear it, it drags it out of view,
   * which is what made copying out of the transcript unreliable.
   *
   * A collapsed selection is just a caret and must not block anything.
   */
  const hasActiveSelection = (): boolean => {
    const el = containerRef.current;
    if (!el) return false;
    const selection = el.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    return el.contains(selection.getRangeAt(0).commonAncestorContainer);
  };

  // Initial / session-change load: fetch the tail, pin to bottom.
  useEffect(() => {
    const generation = ++generationRef.current;
    let alive = true;
    loadingRef.current = false;
    anchorRef.current = null;
    setCommitted([]);
    setMode('follow');
    setLoadingOlder(false);
    setNewBelowCount(0);
    setOlderError(null);
    hasMoreRef.current = false;
    setHasMoreOlder(false);
    cursorRef.current = undefined;
    fetchRange(undefined, pageSize)
      .then((page) => {
        if (!alive || generation !== generationRef.current) return;
        setCommitted(page.blocks);
        cursorRef.current = page.oldestCursor ?? undefined;
        setHasMoreOlder(page.hasMore);
        requestAnimationFrame(scrollToBottom);
      })
      .catch((err) => {
        // Keep the real error — this hook is a prime 'transcripts refuse to
        // load' report source; a generic string is useless for triage.
        if (alive && generation === generationRef.current) {
          setOlderError(`Failed to load transcript: ${err instanceof Error ? err.message : String(err)}`);
        }
        console.error('[transcript] initial load failed', err);
      });
    return () => {
      alive = false;
    };
  }, [fetchRange, pageSize, refreshNonce]);

  const loadOlder = useCallback(async () => {
    const el = containerRef.current;
    if (!el || loadingRef.current || !hasMoreRef.current) return;
    const generation = generationRef.current;
    loadingRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    anchorRef.current = el.scrollHeight; // capture before prepend, restored in layout effect
    try {
      const page = await fetchRange(cursorRef.current, pageSize);
      if (generation !== generationRef.current) return;
      setCommitted((prev) => [...page.blocks, ...prev]);
      cursorRef.current = page.oldestCursor ?? cursorRef.current;
      setHasMoreOlder(page.hasMore);
    } catch (err) {
      if (generation !== generationRef.current) return;
      anchorRef.current = null;
      setOlderError(`Failed to load older messages: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[transcript] load-older failed', err);
    } finally {
      if (generation !== generationRef.current) return;
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [fetchRange, pageSize]);

  // Restore scroll position after a prepend so the viewport stays still.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && anchorRef.current != null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [committed]);

  // Autoscroll while following (initial load + streaming live suffix).
  useLayoutEffect(() => {
    // Explicit user actions (jump-to-latest, initial load) still scroll; only the
    // automatic follow does not fight a selection.
    if (modeRef.current === 'follow' && !hasActiveSelection()) scrollToBottom();
  }, [committed, live]);

  // While browsing, count live growth for the jump-to-latest pill.
  useEffect(() => {
    if (modeRef.current === 'browse' && live.length > liveLenRef.current) {
      setNewBelowCount((c) => c + (live.length - liveLenRef.current));
    }
    liveLenRef.current = live.length;
  }, [live]);

  // When the live turn ends (live empties after being non-empty), reconcile the
  // finished turn into committed. `fetchRange` reads the session's live in-memory
  // manager (no lag), which already includes the just-finished turn, so a follow
  // refetch replaces committed with the authoritative tail. This MUST be a
  // layout effect with a synchronous append: if the live suffix vanished for
  // even one painted frame, the content shrink would clamp the user's scrollTop,
  // fire a scroll event, flip browse → follow, and yank a scrolled-up reader to
  // the bottom when a turn completes. Appending before paint keeps the height
  // stable (the render-time dedup absorbs any transient overlap).
  const prevLiveRef = useRef<readonly Block[]>([]);
  useLayoutEffect(() => {
    const prev = prevLiveRef.current;
    prevLiveRef.current = live;
    if (prev.length === 0 || live.length !== 0) return;
    const generation = generationRef.current;
    setCommitted((c) => [...c, ...prev]); // sync, pre-paint — no shrink frame
    if (modeRef.current === 'browse') return;
    let alive = true;
    fetchRange(undefined, pageSize)
      .then((page) => {
        if (!alive || generation !== generationRef.current) return;
        // Only adopt the authoritative tail if the user is still following —
        // they may have scrolled up during the fetch.
        if (modeRef.current !== 'follow') return;
        setCommitted(page.blocks);
        cursorRef.current = page.oldestCursor ?? undefined;
        setHasMoreOlder(page.hasMore);
        if (!hasActiveSelection()) requestAnimationFrame(scrollToBottom);
      })
      .catch((err) => { console.error('[transcript] live refetch failed', err); });
    return () => {
      alive = false;
    };
  }, [live, fetchRange, pageSize]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = distFromBottom < NEAR_BOTTOM_PX;
    setMode(following ? 'follow' : 'browse');
    if (following) setNewBelowCount(0);
    if (el.scrollTop < NEAR_TOP_PX && hasMoreRef.current && !loadingRef.current) void loadOlder();
  }, [loadOlder]);

  const jumpToLatest = useCallback(() => {
    setMode('follow');
    setNewBelowCount(0);
    requestAnimationFrame(scrollToBottom);
  }, []);

  return {
    containerRef,
    onScroll,
    committed,
    mode,
    loadingOlder,
    hasMoreOlder,
    olderError,
    newBelowCount,
    jumpToLatest,
    retryOlder: loadOlder,
  };
}
