import { TRANSCRIPT_CACHE_ROWS, type ExecutionBlock, type TranscriptItem, type TranscriptRow, type TransportBlock } from '@gitspace/blocks';
import { Button } from '@gitspace/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { TranscriptItemView, TransportNotice, type ExecutionHistoryRenderer, type TranscriptItemState, type TranscriptReadingPosition, type TurnTranscriptProps } from './TurnTranscript.js';
import { useTranscriptHistory, type TranscriptHistory } from './useTranscriptHistory.js';
import { TranscriptContentCache } from './transcriptContentCache.js';

export interface VirtualTranscriptProps {
  history: TranscriptHistory;
  transport: TransportBlock[];
  onAnswer?: TurnTranscriptProps['onAnswer'];
  /** Execution history stays in its card and never recursively groups rows. */
  inline?: boolean;
  viewKey?: object;
  position?: TranscriptReadingPosition;
  onPositionChange?(position: TranscriptReadingPosition): void;
}

const OVERSCAN_ROWS = 6;
const MAX_PINNED_ROWS = 64;
const INTERACTION_CACHE_BYTES = 512 * 1024;
const interactionEncoder = new TextEncoder();
const EMPTY_STATE: TranscriptItemState = {};
interface Layout { rows: readonly TranscriptRow[]; offsets: number[]; total: number }
interface Anchor { id: string; ordinal: number; offset: number }
interface PinnedRow { row: TranscriptRow; top: number }
interface InteractionEntry { state: TranscriptItemState; bytes: number }

interface ViewState {
  generation: string | null;
  measurements: RefObject<Map<string, number>>;
  interactions: RefObject<Map<string, InteractionEntry>>;
  interactionBytes: RefObject<number>;
  anchor: RefObject<Anchor | null>;
  following: RefObject<boolean>;
  seenTotal: RefObject<number>;
  content: TranscriptContentCache;
}
// ScrollArea replaces its child tree when pointer mode changes. The hook's stable
// callback weakly owns bounded content and interaction state across that replacement.
const viewStates = new WeakMap<object, ViewState>();

function estimateHeight(row: TranscriptRow): number {
  const item = row.item;
  if (item.type === 'ask' && item.status === 'pending') return 280;
  if (item.type === 'message' || item.type === 'markdown' || item.type === 'code') return Math.min(640, 64 + Math.ceil(item.text.length / 90) * 20);
  if (item.type === 'image') return 264;
  return 72;
}

function rowAt(layout: Layout, top: number): number {
  let low = 0;
  let high = layout.rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (layout.offsets[middle + 1]! <= top) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, layout.rows.length - 1));
}


function MeasuredRow({ row, item, error, top, gap, state, onStateChange, onAnswer, onRetry, onMeasure, onNode, renderExecutionHistory }: {
  row: TranscriptRow; item?: TranscriptItem; error?: string; top: number; gap: number; state: TranscriptItemState;
  onStateChange(id: string, patch: Partial<TranscriptItemState>): void;
  onAnswer?: TurnTranscriptProps['onAnswer']; onRetry(): void;
  onMeasure(id: string, height: number): void; onNode(id: string, node: HTMLDivElement | null): void;
  renderExecutionHistory?: ExecutionHistoryRenderer;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const bind = useCallback((node: HTMLDivElement | null) => { element.current = node; onNode(row.id, node); }, [onNode, row.id]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => onMeasure(row.id, node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [row.id, onMeasure]);
  return <div ref={bind} data-transcript-row={row.id} data-turn-id={row.turnId} data-status={row.turnStatus} className="absolute inset-x-0 min-w-0" style={{ top, paddingBottom: gap }}>
    {item ? <TranscriptItemView item={item} active={row.turnStatus === 'running'} state={state} onStateChange={(patch) => onStateChange(row.id, patch)} onAnswer={onAnswer} renderExecutionHistory={renderExecutionHistory} />
      : !error ? <p role="status" className="py-4 text-body text-muted-foreground">Loading content…</p> : null}
    {error ? <div role="alert" className="mt-2 text-body text-destructive">{error}<Button variant="ghost" onClick={onRetry}>Retry content</Button></div> : null}
  </div>;
}

/** Uses the existing ScrollArea viewport: no nested scroller or scroll event cancellation. */
export function VirtualTranscript(props: VirtualTranscriptProps) {
  const [identity, setIdentity] = useState(() => ({ source: props.history.setViewport, generation: props.history.generation, key: 0 }));
  if (identity.source !== props.history.setViewport || identity.generation !== props.history.generation) {
    setIdentity({ source: props.history.setViewport, generation: props.history.generation, key: identity.key + 1 });
  }
  return <TranscriptWindow key={identity.key} {...props} />;
}

function TranscriptWindow({ history, transport, onAnswer, inline = false, viewKey, position, onPositionChange }: VirtualTranscriptProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const viewport = useRef<HTMLElement | null>(null);
  const latest = useRef(history);
  latest.current = history;
  const positionListener = useRef(onPositionChange);
  positionListener.current = onPositionChange;
  const [persistent] = useState(() => {
    const key = viewKey ?? history.setViewport;
    const previous = viewStates.get(key);
    if (previous?.generation === history.generation) return previous;
    const next: ViewState = {
      generation: history.generation,
      measurements: { current: new Map() }, interactions: { current: new Map() },
      interactionBytes: { current: 0 },
      anchor: { current: position?.generation === history.generation ? { id: position.rowId, ordinal: position.ordinal, offset: position.offset } : null },
      following: { current: position?.generation === history.generation ? position.following : true }, seenTotal: { current: history.total },
      content: new TranscriptContentCache(history.generation),
    };
    // Replay can rebuild the projection generation without changing runtime
    // identities. Keep user choices, never payloads from the old generation.
    if (previous) for (const [id, entry] of previous.interactions.current) {
      if (!inline && entry.state.executionOpen === undefined) continue;
      const state = { ...entry.state };
      if (state.executionPosition) state.executionPosition = { ...state.executionPosition, generation: history.generation };
      const bytes = interactionEncoder.encode(id).byteLength + interactionEncoder.encode(JSON.stringify(state)).byteLength;
      next.interactions.current.set(id, { state, bytes });
      next.interactionBytes.current += bytes;
    }
    viewStates.set(key, next);
    return next;
  });
  const { measurements, interactions, anchor, following, seenTotal, content: contentCache } = persistent;
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const pinned = useRef(new Map<string, PinnedRow>());
  const touch = useRef<{ top: number; moved: boolean } | null>(null);
  const programmedTop = useRef<number | null>(null);
  const [isFollowing, setFollowing] = useState(following.current);
  const [view, setView] = useState({ top: Number.POSITIVE_INFINITY, height: 600 });
  const [measurementVersion, invalidateMeasurements] = useState(0);
  const [, invalidateInteractions] = useState(0);
  const [, invalidateContent] = useState(0);
  useLayoutEffect(() => {
    const unsubscribe = contentCache.subscribe(() => invalidateContent((value) => value + 1));
    return () => { unsubscribe(); contentCache.suspend(inline); };
  }, [contentCache, inline]);
  const lastReported = useRef('');
  const lastBoundary = useRef('');
  const appliedNavigation = useRef<TranscriptHistory['navigation']>(null);
  const layout = useMemo<Layout>(() => {
    const offsets = [0];
    for (const row of history.rows) offsets.push(offsets[offsets.length - 1]! + (measurements.current.get(row.id) ?? estimateHeight(row)));
    return { rows: history.rows, offsets, total: offsets[offsets.length - 1]! };
  }, [history.rows, measurementVersion]);
  const committed = useRef(layout);

  const listTop = useCallback(() => {
    const element = viewport.current;
    return element && list.current ? list.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop : 0;
  }, []);
  const setFollow = useCallback((value: boolean) => {
    if (value) seenTotal.current = latest.current.total;
    following.current = value;
    setFollowing(value);
  }, []);
  const sample = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const current = committed.current;
    const top = element.scrollTop - listTop();
    const height = element.clientHeight;
    setView((previous) => previous.top === top && previous.height === height ? previous : { top, height });
    const first = rowAt(current, top);
    const last = rowAt(current, top + height);
    const row = current.rows[first];
    anchor.current = row ? { id: row.id, ordinal: row.ordinal, offset: top - current.offsets[first]! } : null;
    if (row) positionListener.current?.({ generation: latest.current.generation, rowId: row.id, ordinal: row.ordinal, offset: top - current.offsets[first]!, following: following.current });
    const firstId = row?.id ?? null;
    const lastId = current.rows[last]?.id ?? null;
    const report = JSON.stringify([firstId, lastId, following.current]);
    if (report !== lastReported.current) {
      lastReported.current = report;
      latest.current.setViewport(firstId, lastId, following.current);
    }
  }, [listTop]);
  const restore = useCallback(() => {
    const element = viewport.current;
    if (!element || touch.current) return;
    const current = committed.current;
    let next = element.scrollTop;
    if (following.current && !latest.current.hasAfter) next = Math.max(0, element.scrollHeight - element.clientHeight);
    else if (anchor.current && current.rows.length) {
      const held = anchor.current;
      let index = current.rows.findIndex((row) => row.id === held.id);
      if (index < 0) index = current.rows.findIndex((row) => row.ordinal >= held.ordinal);
      if (index < 0) index = current.rows.length - 1;
      next = listTop() + current.offsets[index]! + held.offset;
    }
    next = Math.max(0, Math.min(next, Math.max(0, element.scrollHeight - element.clientHeight)));
    if (Math.abs(element.scrollTop - next) > 0.5) {
      element.scrollTop = next;
      programmedTop.current = element.scrollTop;
    }
  }, [listTop]);
  const onMeasure = useCallback((id: string, height: number) => {
    if (height <= 0 || Math.abs((measurements.current.get(id) ?? 0) - height) < 0.5) return;
    measurements.current.set(id, height);
    invalidateMeasurements((value) => value + 1);
  }, []);
  const trimInteractions = useCallback(() => {
    if (interactions.current.size <= TRANSCRIPT_CACHE_ROWS && persistent.interactionBytes.current <= INTERACTION_CACHE_BYTES) return;
    for (const [id, entry] of interactions.current) {
      // Keep explicitly expanded execution histories and active edits. Their
      // payload windows are independently bounded and released on unmount.
      if (pinned.current.has(id) || entry.state.executionOpen === true) continue;
      interactions.current.delete(id);
      persistent.interactionBytes.current -= entry.bytes;
      if (interactions.current.size <= TRANSCRIPT_CACHE_ROWS && persistent.interactionBytes.current <= INTERACTION_CACHE_BYTES) break;
    }
  }, [interactions, persistent]);
  const onNode = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) {
      nodes.current.set(id, node);
      const entry = interactions.current.get(id);
      if (entry) {
        interactions.current.delete(id);
        interactions.current.set(id, entry);
      }
    }
    else nodes.current.delete(id);
  }, []);
  const onStateChange = useCallback((id: string, patch: Partial<TranscriptItemState>) => {
    if (!latest.current.rows.some((row) => row.id === id) && !pinned.current.has(id) && !interactions.current.has(id)) return;
    const previous = interactions.current.get(id);
    const state = { ...previous?.state, ...patch };
    const bytes = interactionEncoder.encode(id).byteLength + interactionEncoder.encode(JSON.stringify(state)).byteLength;
    interactions.current.delete(id);
    interactions.current.set(id, { state, bytes });
    persistent.interactionBytes.current += bytes - (previous?.bytes ?? 0);
    trimInteractions();
    invalidateInteractions((value) => value + 1);
  }, [interactions, persistent, trimInteractions]);

  useLayoutEffect(() => {
    if (following.current) seenTotal.current = history.total;
    committed.current = layout;
    if (history.navigation && history.navigation !== appliedNavigation.current) {
      const target = history.rows.find((row) => row.id === history.navigation!.rowId);
      if (history.navigation.rowId === null || target) {
        appliedNavigation.current = history.navigation;
        setFollow(history.navigation.rowId === null);
        anchor.current = target ? { id: target.id, ordinal: target.ordinal, offset: 0 } : null;
      }
    }
    const retained = new Set(history.rows.map((row) => row.id));
    for (const id of pinned.current.keys()) retained.add(id);
    for (const id of measurements.current.keys()) if (!retained.has(id)) measurements.current.delete(id);
    // Guard measurements even when an alternate caller supplies an oversized cache.
    while (measurements.current.size > TRANSCRIPT_CACHE_ROWS + MAX_PINNED_ROWS) {
      const disposable = [...measurements.current.keys()].find((id) => !pinned.current.has(id) && !nodes.current.has(id));
      if (!disposable) break;
      measurements.current.delete(disposable);
    }
    trimInteractions();
    restore();
    sample();
  }, [layout, history.hasAfter, history.total, history.navigation, restore, sample, setFollow, trimInteractions]);

  useLayoutEffect(() => {
    const element = root.current?.closest<HTMLElement>('[data-slot=scroll-area-viewport]');
    if (!element) return;
    viewport.current = element;
    const onScroll = () => {
      // Inner execution scrolling must not change the main transcript's anchor.
      // Native scroll events do not bubble; each window owns its nearest viewport.
      const internal = programmedTop.current !== null && Math.abs(element.scrollTop - programmedTop.current) < 1;
      programmedTop.current = null;
      if (!internal) {
        if (touch.current) touch.current.moved ||= element.scrollTop !== touch.current.top;
        setFollow(!latest.current.hasAfter && element.scrollHeight - element.scrollTop - element.clientHeight < 48);
      }
      sample();
    };
    const onTouchStart = () => { touch.current = { top: element.scrollTop, moved: false }; };
    const onTouchEnd = () => {
      const gesture = touch.current;
      touch.current = null;
      if (gesture && (gesture.moved || element.scrollTop !== gesture.top)) {
        setFollow(!latest.current.hasAfter && element.scrollHeight - element.scrollTop - element.clientHeight < 48);
        sample();
      } else { restore(); sample(); }
    };
    const updatePinned = () => {
      const selection = document.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
      const next = new Map<string, PinnedRow>();
      for (const [id, node] of nodes.current) {
        if (!node.contains(document.activeElement) && !(range?.intersectsNode(node))) continue;
        const index = committed.current.rows.findIndex((row) => row.id === id);
        const retained = index >= 0 ? { row: committed.current.rows[index]!, top: committed.current.offsets[index]! } : pinned.current.get(id);
        if (retained && next.size < MAX_PINNED_ROWS) next.set(id, retained);
      }
      if (next.size !== pinned.current.size || [...next.keys()].some((id) => !pinned.current.has(id))) {
        pinned.current = next;
        trimInteractions();
        invalidateInteractions((value) => value + 1);
        sample();
      }
    };
    const onFocusOut = () => queueMicrotask(() => { if (element.isConnected) updatePinned(); });
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    element.addEventListener('focusin', updatePinned);
    element.addEventListener('focusout', onFocusOut);
    document.addEventListener('selectionchange', updatePinned);
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        measurements.current.clear();
        for (const [id, node] of nodes.current) {
          const height = node.getBoundingClientRect().height;
          if (height > 0) measurements.current.set(id, height);
        }
        invalidateMeasurements((value) => value + 1);
      }
      restore();
      sample();
    });
    observer.observe(element);
    if (root.current) observer.observe(root.current);
    restore();
    sample();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      element.removeEventListener('focusin', updatePinned);
      element.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('selectionchange', updatePinned);
      viewport.current = null;
    };
  }, [restore, sample, setFollow, trimInteractions]);

  useEffect(() => {
    if (history.loading || history.error || !history.rows.length || following.current) return;
    const direction = view.top < 320 && history.hasBefore ? 'older' : view.top + view.height > layout.total - 320 && history.hasAfter ? 'newer' : null;
    if (!direction) { lastBoundary.current = ''; return; }
    const boundary = `${direction}:${direction === 'older' ? history.rows[0]!.id : history.rows[history.rows.length - 1]!.id}`;
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (direction === 'older') void history.loadOlder();
    else void history.loadNewer();
  }, [history, layout.total, view, isFollowing]);

  const jumpToLatest = () => {
    setFollow(true);
    anchor.current = null;
    lastReported.current = '';
    history.setViewport(null, null, true);
    void history.jumpToLatest();
    restore();
    sample();
  };
  const top = Number.isFinite(view.top) ? view.top : Math.max(0, layout.total - view.height);
  const first = Math.max(0, rowAt(layout, top) - OVERSCAN_ROWS);
  const last = Math.min(layout.rows.length - 1, rowAt(layout, top + view.height) + OVERSCAN_ROWS);
  const rendered = new Map<string, { row: TranscriptRow; top: number; gap: number }>();
  for (let index = first; index <= last; index++) {
    const row = layout.rows[index]!;
    rendered.set(row.id, { row, top: layout.offsets[index]!, gap: layout.rows[index + 1]?.turnId === row.turnId ? 8 : 24 });
  }
  for (const [id, held] of pinned.current) {
    if (rendered.has(id)) continue;
    const index = layout.rows.findIndex((row) => row.id === id);
    rendered.set(id, { row: index < 0 ? held.row : layout.rows[index]!, top: index < 0 ? -1_000_000 : layout.offsets[index]!, gap: 8 });
  }
  useLayoutEffect(() => {
    contentCache.setNeeded([...rendered.values()].map(({ row }) => row), (id, offset, signal) => latest.current.content(id, offset, signal));
  });
  const content: ReactNode[] = [...rendered.values()].sort((a, b) => a.row.ordinal - b.row.ordinal).map(({ row, top: rowTop, gap }) => {
    const complete = row.truncated ? contentCache.get(row) : { item: row.item };
    return <MeasuredRow key={row.id} row={row} {...complete} top={rowTop} gap={gap} state={interactions.current.get(row.id)?.state ?? EMPTY_STATE} onStateChange={onStateChange} onAnswer={onAnswer} onRetry={() => contentCache.retry(row)} onMeasure={onMeasure} onNode={onNode}
      renderExecutionHistory={inline ? undefined : (block, state, onChange) => <ExecutionHistory key={block.executionId} block={block} parent={history} state={state} onStateChange={onChange} onAnswer={onAnswer} />}
    />;
  });
  return <div ref={root} data-virtual-transcript className={inline ? 'min-w-0 w-full px-3 py-2' : 'mx-auto min-w-0 w-full max-w-3xl px-6 pb-[calc(var(--composer-overlay-height,0px)+1.5rem)] pt-6'} style={{ overflowAnchor: 'none' }}>
    {transport.length ? <div className="mb-6 flex min-w-0 flex-col gap-1">{transport.map((block) => <TransportNotice block={block} key={block.id} />)}</div> : null}
    {inline && history.error ? <div role="alert" className="flex min-w-0 items-center gap-2 text-body text-destructive [overflow-wrap:anywhere]">{history.error}<Button variant="ghost" className="min-h-10 shrink-0" disabled={history.loading} onClick={history.refresh}>Retry history</Button></div> : null}
    <div className="flex h-12 items-center justify-center text-caption text-muted-foreground">
      {history.hasBefore ? <Button variant="ghost" className="min-h-10" disabled={history.loading} onClick={() => { setFollow(false); void history.loadOlder(); }}>{inline ? 'Load earlier calls' : 'Load earlier blocks'}</Button> : history.initialLoading ? <span role="status">Loading transcript…</span> : <span>{inline ? 'Beginning of execution history' : 'Beginning of transcript'}</span>}
    </div>
    <div ref={list} data-transcript-items className="relative min-w-0" style={{ height: layout.total }}>{content}</div>
    <div className="flex h-12 items-center justify-center">
      {history.hasAfter ? <Button variant="ghost" className="min-h-10" disabled={history.loading} onClick={() => void history.loadNewer()}>{inline ? 'Load later calls' : 'Load later blocks'}</Button> : null}
    </div>
    {!isFollowing || history.hasAfter ? <div className="pointer-events-none sticky z-10 flex h-0 justify-center" style={{ bottom: inline ? '1rem' : 'calc(var(--composer-overlay-height,0px) + 1rem)' }}>
      <Button variant="secondary" className="pointer-events-auto min-h-10 -translate-y-full shadow-surface-3" onClick={jumpToLatest}>{history.total > seenTotal.current ? 'New activity · Jump to latest' : history.hasAfter ? 'Newer activity · Jump to latest' : 'Jump to latest'}</Button>
    </div> : null}
  </div>;
}

function ExecutionHistory({ block, parent, state, onStateChange, onAnswer }: {
  block: ExecutionBlock;
  parent: TranscriptHistory;
  state: TranscriptItemState;
  onStateChange?: (patch: Partial<TranscriptItemState>) => void;
  onAnswer?: TurnTranscriptProps['onAnswer'];
}) {
  const [viewKey] = useState(() => state.executionView ?? {});
  const previousPosition = useRef(state.executionPosition);
  const history = useTranscriptHistory({
    key: JSON.stringify([parent.generation, block.executionId]),
    revision: block,
    page: (request, signal) => parent.executionPage(block.executionId, request, signal),
    content: (request, signal) => parent.content(request.rowId, request.offset, signal),
  }, {
    generation: parent.generation,
    rowId: state.executionPosition?.following === false ? state.executionPosition.rowId : null,
  });
  useEffect(() => {
    if (state.executionView !== viewKey) onStateChange?.({ executionView: viewKey, executionOpen: true });
  }, [state.executionView, viewKey, onStateChange]);
  const preservePosition = (next: TranscriptReadingPosition): void => {
    const previous = previousPosition.current;
    if (previous?.generation === next.generation && previous.rowId === next.rowId && previous.offset === next.offset && previous.following === next.following) return;
    previousPosition.current = next;
    onStateChange?.({ executionPosition: next });
  };
  return <div className="border-t border-border/40">
    <div className="h-96 min-w-0 overflow-y-auto overscroll-contain" data-slot="scroll-area-viewport" role="region" aria-label={`${block.label} execution history`} tabIndex={0}>
      {history.generation === null || history.initialLoading || history.rows.length === 0 && history.error !== null ? <div className="px-3 py-4">
        {history.error ? <div role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">{history.error}<Button variant="ghost" className="min-h-10" disabled={history.loading} onClick={history.refresh}>Retry history</Button></div>
          : <p role="status" className="text-body text-muted-foreground">Loading execution history…</p>}
      </div> : <VirtualTranscript history={history} transport={[]} inline viewKey={viewKey} position={state.executionPosition} onPositionChange={preservePosition} onAnswer={onAnswer} />}
    </div>
  </div>;
}
