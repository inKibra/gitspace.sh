import type {
  TranscriptContentPage,
  TranscriptContentRequest,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRow,
} from '@gitspace/blocks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_TRANSCRIPT_CACHE,
  mergeTranscriptPage,
  type TranscriptHistoryCache,
  type TranscriptViewport,
} from './transcriptHistoryCache.js';

export interface TranscriptHistorySource {
  /** Changes only when the workspace, session, or live/checkpoint source changes. */
  key: string;
  /** Invalidations coalesce without starving a page already in flight. */
  revision: unknown;
  page(request: TranscriptPageRequest, signal: AbortSignal): Promise<TranscriptPage>;
  content(request: TranscriptContentRequest, signal: AbortSignal): Promise<TranscriptContentPage>;
}

export interface TranscriptHistory {
  rows: readonly TranscriptRow[];
  generation: string | null;
  /** A new object requests a scroll after an explicit jump has loaded. */
  navigation: { rowId: string | null } | null;
  loading: boolean;
  initialLoading: boolean;
  error: string | null;
  refresh(): void;
  hasBefore: boolean;
  hasAfter: boolean;
  total: number;
  loadOlder(): void;
  loadNewer(): void;
  jumpToLatest(): void;
  jumpToRow(id: string): void;
  setViewport(firstId: string | null, lastId: string | null, following: boolean): void;
  content(rowId: string, offset: number, signal: AbortSignal): Promise<TranscriptContentPage>;
  executionPage(executionId: string, request: TranscriptPageRequest, signal: AbortSignal): Promise<TranscriptPage>;
}

type Navigation = 'older' | 'newer' | 'latest' | { rowId: string };
interface HistorySession {
  identity: { key: string | null };
  refresh(): void;
  navigate(destination: Navigation): void;
  setViewport(firstId: string | null, lastId: string | null, following: boolean): void;
  content(rowId: string, offset: number, signal: AbortSignal): Promise<TranscriptContentPage>;
  executionPage(executionId: string, request: TranscriptPageRequest, signal: AbortSignal): Promise<TranscriptPage>;
}
interface HistoryState {
  identity: HistorySession['identity'];
  cache: TranscriptHistoryCache;
  navigation: TranscriptHistory['navigation'];
  loading: boolean;
  hasSnapshot: boolean;
  error: string | null;
}

/** Retains only a bounded, contiguous window; full content is fetched separately. */
export function useTranscriptHistory(source: TranscriptHistorySource | null, initialPosition?: { generation: string | null; rowId: string | null }): TranscriptHistory {
  const identity = useMemo(() => ({ key: source?.key ?? null }), [source?.key]);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const session = useRef<HistorySession | null>(null);
  const [state, setState] = useState<HistoryState>({ identity, cache: EMPTY_TRANSCRIPT_CACHE, navigation: null, loading: source !== null, hasSnapshot: false, error: null });
  const initial = useRef(initialPosition);
  const refresh = useCallback(() => {
    if (session.current?.identity === identity) session.current.refresh();
  }, [identity]);
  const loadOlder = useCallback(() => {
    if (session.current?.identity === identity) session.current.navigate('older');
  }, [identity]);
  const loadNewer = useCallback(() => {
    if (session.current?.identity === identity) session.current.navigate('newer');
  }, [identity]);
  const jumpToLatest = useCallback(() => {
    if (session.current?.identity === identity) session.current.navigate('latest');
  }, [identity]);
  const jumpToRow = useCallback((id: string) => {
    if (session.current?.identity === identity) session.current.navigate({ rowId: id });
  }, [identity]);
  const setViewport = useCallback((firstId: string | null, lastId: string | null, following: boolean) => {
    if (session.current?.identity === identity) session.current.setViewport(firstId, lastId, following);
  }, [identity]);
  const content = useCallback(async (rowId: string, offset: number, signal: AbortSignal) => {
    if (session.current?.identity !== identity) throw new DOMException('Transcript source changed', 'AbortError');
    return session.current.content(rowId, offset, signal);
  }, [identity]);
  const executionPage = useCallback(async (executionId: string, request: TranscriptPageRequest, signal: AbortSignal) => {
    if (session.current?.identity !== identity) throw new DOMException('Transcript source changed', 'AbortError');
    return session.current.executionPage(executionId, request, signal);
  }, [identity]);

  useEffect(() => {
    if (!sourceRef.current) return;
    let active = true;
    let cache = { ...EMPTY_TRANSCRIPT_CACHE, generation: initial.current?.generation ?? null };
    let viewport: TranscriptViewport = { firstId: initial.current?.rowId ?? null, lastId: initial.current?.rowId ?? null, following: !initial.current?.rowId };
    let controller: AbortController | null = null;
    const contentControllers = new Set<AbortController>();
    let requested = false;
    let hasSnapshot = false;
    let error: string | null = null;
    let pendingNavigation: Navigation | null = null;
    let navigation: TranscriptHistory['navigation'] = null;
    let viewportRefreshRequested = false;
    let lastViewportRefresh: { generation: string | null; revision: number; anchor: string } | null = null;

    const load = async (request: TranscriptPageRequest, replace: boolean): Promise<void> => {
      const currentSource = sourceRef.current;
      if (!active || currentSource?.key !== identity.key) return;
      const current = new AbortController();
      controller = current;
      setState({ identity, cache, navigation, loading: true, hasSnapshot, error });
      try {
        const page = await currentSource.page(request, current.signal);
        if (!active || current.signal.aborted || controller !== current || sourceRef.current?.key !== identity.key) return;
        const generationChanged = cache.generation !== null && cache.generation !== page.generation;
        if (generationChanged) {
          for (const pending of contentControllers) pending.abort();
          viewport = { firstId: null, lastId: null, following: true };
        }
        // A reader can leave follow mode while a latest-page refresh is in
        // flight. Do not replace their now-visible window with a distant tail.
        const movedAnchor = !replace && !generationChanged && !viewport.following
          && request.before === null && request.after === null && request.around !== viewport.firstId
          && cache.rows.some((row) => row.id === viewport.firstId)
          && !page.rows.some((row) => cache.rows.some((previous) => previous.id === row.id));
        if (movedAnchor) requested = true;
        else cache = mergeTranscriptPage(cache, page, request, viewport, replace || generationChanged);
        if (replace || generationChanged) navigation = { rowId: generationChanged ? null : request.around };
        hasSnapshot = true;
        error = null;
      } catch (cause) {
        if (!active || current.signal.aborted || controller !== current || sourceRef.current?.key !== identity.key) return;
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (!active || current.signal.aborted || controller !== current) return;
      controller = null;
      pendingNavigation = null;
      setState({ identity, cache, navigation, loading: requested, hasSnapshot, error });
      if (requested) invalidate();
      else if (viewportRefreshRequested) {
        viewportRefreshRequested = false;
        refreshStaleViewport();
      }
    };
    const invalidate = (): void => {
      requested = true;
      if (controller) return;
      requested = false;
      const anchor = viewport.firstId ?? cache.rows[0]?.id ?? null;
      void load({ generation: cache.generation, before: null, after: null, around: viewport.following ? null : anchor }, false);
    };
    const refreshStaleViewport = (): void => {
      const first = cache.rows.findIndex((row) => row.id === viewport.firstId);
      const last = cache.rows.findIndex((row) => row.id === viewport.lastId);
      if (first < 0 && last < 0) return;
      const start = first < 0 ? last : last < 0 ? first : Math.min(first, last);
      const end = Math.max(first, last);
      for (let index = start; index <= end; index++) {
        if (cache.rowRevisions[index]! >= cache.revision) continue;
        const anchor = cache.rows[index]!.id;
        // Repeated measurements must not duplicate a pending read or retry a
        // failed read forever at the same source revision and visible anchor.
        if (lastViewportRefresh?.generation === cache.generation && lastViewportRefresh.revision === cache.revision && lastViewportRefresh.anchor === anchor) return;
        if (controller) {
          viewportRefreshRequested = true;
          return;
        }
        lastViewportRefresh = { generation: cache.generation, revision: cache.revision, anchor };
        void load({ generation: cache.generation, before: null, after: null, around: anchor }, false);
        return;
      }
    };
    const navigate = (destination: Navigation): void => {
      const first = cache.rows[0];
      const last = cache.rows[cache.rows.length - 1];
      // Repeated boundary observations must not restart the same request.
      if ((destination === 'older' || destination === 'newer') && pendingNavigation === destination) return;
      if (destination === 'older' && (!cache.hasBefore || !first)) return;
      if (destination === 'newer' && (!cache.hasAfter || !last)) return;
      controller?.abort();
      requested = false;
      viewportRefreshRequested = false;
      pendingNavigation = destination;
      const request: TranscriptPageRequest = { generation: cache.generation, before: null, after: null, around: null };
      if (destination === 'older') {
        viewport = { ...viewport, following: false };
        request.before = first!.ordinal;
      } else if (destination === 'newer') {
        request.after = last!.ordinal;
      } else if (destination === 'latest') {
        viewport = { firstId: null, lastId: null, following: true };
      } else {
        request.around = destination.rowId;
        viewport = { firstId: destination.rowId, lastId: destination.rowId, following: false };
      }
      void load(request, destination === 'latest' || typeof destination === 'object');
    };
    const currentSession: HistorySession = {
      identity,
      refresh: invalidate,
      navigate,
      setViewport(firstId, lastId, following) {
        if (pendingNavigation === 'latest' || typeof pendingNavigation === 'object' && pendingNavigation !== null) return;
        viewport = { firstId, lastId, following };
        refreshStaleViewport();
      },
      async executionPage(executionId, request, signal) {
        const currentSource = sourceRef.current;
        if (!active || currentSource?.key !== identity.key || signal.aborted) {
          throw new DOMException('Transcript source changed', 'AbortError');
        }
        const current = new AbortController();
        contentControllers.add(current);
        const abort = () => current.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const page = await currentSource.page({ ...request, executionId }, current.signal);
          if (!active || current.signal.aborted || sourceRef.current?.key !== identity.key) {
            throw new DOMException('Transcript source changed', 'AbortError');
          }
          return page;
        } finally {
          signal.removeEventListener('abort', abort);
          contentControllers.delete(current);
        }
      },
      async content(rowId, offset, signal) {
        const currentSource = sourceRef.current;
        const generation = cache.generation;
        if (!active || currentSource?.key !== identity.key || generation === null || signal.aborted) {
          throw new DOMException('Transcript content is no longer available', 'AbortError');
        }
        // Each mounted row owns its cancellation. Source/generation disposal
        // still aborts every outstanding read together.
        const current = new AbortController();
        contentControllers.add(current);
        const abort = () => current.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const page = await currentSource.content({ generation, rowId, offset }, current.signal);
          if (!active || current.signal.aborted || cache.generation !== generation || sourceRef.current?.key !== identity.key) {
            throw new DOMException('Transcript content changed', 'AbortError');
          }
          return page;
        } finally {
          signal.removeEventListener('abort', abort);
          contentControllers.delete(current);
        }
      },
    };
    session.current = currentSession;
    invalidate();
    return () => {
      active = false;
      controller?.abort();
      for (const pending of contentControllers) pending.abort();
      if (session.current === currentSession) session.current = null;
    };
  }, [identity]);

  const revision = source?.revision;
  const previousRevision = useRef({ identity, revision });
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = { identity, revision };
    if (previous.identity === identity && !Object.is(previous.revision, revision)) refresh();
  }, [identity, revision, refresh]);

  // Hide a replaced source synchronously, before cleanup or late completions.
  const current = state.identity === identity ? state : { cache: EMPTY_TRANSCRIPT_CACHE, navigation: null, loading: source !== null, hasSnapshot: false, error: null };
  return {
    rows: current.cache.rows,
    generation: current.cache.generation,
    navigation: current.navigation,
    loading: current.loading,
    initialLoading: current.loading && !current.hasSnapshot,
    error: current.error,
    hasBefore: current.cache.hasBefore,
    hasAfter: current.cache.hasAfter,
    total: current.cache.total,
    refresh, loadOlder, loadNewer, jumpToLatest, jumpToRow, setViewport, content, executionPage,
  };
}
