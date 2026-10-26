import { Button, ThinkingIndicator } from '@gitspace/ui';
import type {
  RuntimeBrowserCommentThread,
  RuntimeBrowserShareBox,
  RuntimeBrowserSharePreview,
  RuntimeBrowserShareServerMessage,
  RuntimeBrowserShareTarget,
  RuntimeBrowserShareViewer,
  RuntimeBrowserShareViewerMessage,
} from '@gitspace/protocol-runtime';
import { browserCommentPageKey, browserSharePointerColor } from '@gitspace/protocol-runtime';
import { MessagePlusSquare } from '@untitledui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { COMMENT_PURPLE, CommentPin, numberThreads, placeThread, ThreadPopover } from '../comment-threads.js';
import type { ThreadActions } from '../comment-threads.js';
import { glyph } from '../glyph.js';
import { ShareComments } from './ShareComments.js';
import { joinShare, openShareLive, ShareRequestError } from './share-client.js';
import type { ShareJoined, ShareLive } from './share-client.js';
import { shareTargetLabel, shareTimeLeft } from './share-format.js';
import type { ShareEnd } from './share-format.js';
import { Throttle } from '../throttle.js';

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Watcher = RuntimeBrowserShareViewer & { at: Point | null };
type Page = Extract<RuntimeBrowserShareServerMessage, { type: 'page' }>;
type Frame = Extract<RuntimeBrowserShareServerMessage, { type: 'frame' }>;
/** A comment being written: on the element at a point, or on a dragged area. */
type Draft = { kind: 'point'; at: Point } | { kind: 'region'; region: RuntimeBrowserShareBox };
/** A reply or resolve sent on the socket, settled when the thread comes back changed or the share refuses it. */
type ThreadOperation = { threadId: string; settled(thread: RuntimeBrowserCommentThread): boolean; resolve(): void; reject(error: Error): void };

/** At most 20 pointer messages a second. */
const POINTER_INTERVAL_MS = 50;
const HIT_INTERVAL_MS = 150;
const SIZE_INTERVAL_MS = 500;
/** A press that moves farther than this (CSS px) drags an area instead of picking an element. */
const DRAG_PX = 8;
const RECONNECT_MAX_MS = 15_000;
/** The sharer's own pointer and avatar: gray, apart from the viewers' colors and the agent's blue. */
const SHARER_GRAY = '#525252';
const CommentGlyph = glyph(MessagePlusSquare);
/** Watchers shown as avatars in the header; the rest are counted. */
const WATCHER_AVATARS = 6;
/** The comment box is `w-72`; it sits this far beside its target and needs about this much height. */
const DRAFT_WIDTH_PX = 288;
const DRAFT_GAP_PX = 12;
const DRAFT_HEIGHT_PX = 150;


const fraction = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
const viewerSize = (value: number) => Math.round(Math.min(4096, Math.max(64, value)));
function boxBetween(from: Point, to: Point): RuntimeBrowserShareBox {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}
function siteOf(url: string, fallback: string): string {
  try { return new URL(url).host || fallback; } catch { return fallback; }
}

export interface ShareViewerProps {
  shareId: string;
  secret: string;
  preview: RuntimeBrowserSharePreview;
  joined: ShareJoined;
  /** How this viewer joined, to join again when the socket drops. */
  name: string;
  signed: boolean;
  onEnded(reason: ShareEnd | null): void;
}

/**
 * The live share: the tab's frames scaled to fit, everyone's named pointers, who is watching, and (on comment shares)
 * Comment mode and the comments. Nothing here clicks or types in the tab. A dropped socket joins again with a fresh
 * token, waiting longer after each failure.
 */
export function ShareViewer({ shareId, secret, preview, joined, name, signed, onEnded }: ShareViewerProps) {
  const [self, setSelf] = useState(joined);
  const [share, setShare] = useState(preview);
  const [page, setPage] = useState<Page | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  /** The sharer's own pointer on the tab, from their Chrome: drawn here, not on the tab. */
  const [sharerAt, setSharerAt] = useState<Point | null>(null);
  const [threads, setThreads] = useState<RuntimeBrowserCommentThread[]>([]);
  /** The thread open over the page, by its root's id. */
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [connected, setConnected] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [hit, setHit] = useState<RuntimeBrowserShareTarget | null>(null);
  const [dragBox, setDragBox] = useState<RuntimeBrowserShareBox | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState<Size | null>(null);
  const live = useRef<ShareLive | null>(null);
  const sent = useRef<string | null>(null);
  const threadOperation = useRef<ThreadOperation | null>(null);
  const press = useRef<{ start: Point; x: number; y: number; moved: boolean } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  const throttles = useMemo(() => ({
    pointer: new Throttle<Point | null>(POINTER_INTERVAL_MS, at => live.current?.send({ type: 'pointer', at })),
    hit: new Throttle<Point>(HIT_INTERVAL_MS, at => live.current?.send({ type: 'hit', at })),
    size: new Throttle<Size>(SIZE_INTERVAL_MS, size => live.current?.send({ type: 'size', ...size })),
  }), []);
  useEffect(() => () => { throttles.pointer.cancel(); throttles.hit.cancel(); throttles.size.cancel(); }, [throttles]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setStage(current => rect.width > 0 && rect.height > 0
        ? current?.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }
        : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The screen area offered for the tab: the stage, or the window before the stage has a size.
  const size = { width: viewerSize(stage?.width ?? window.innerWidth), height: viewerSize(stage?.height ?? window.innerHeight) };
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = { width: size.width, height: size.height };
    // Before the socket exists, connecting sends the size.
    if (live.current) throttles.size.push(sizeRef.current);
  }, [size.width, size.height, throttles]);

  useEffect(() => {
    let disposed = false;
    let finished = false;
    let failures = 0;
    let timer: number | undefined;
    const receive = (message: RuntimeBrowserShareServerMessage) => {
      switch (message.type) {
        case 'joined':
          failures = 0;
          setConnected(true);
          setShare(message.share);
          setWatchers(message.viewers.map(viewer => ({ ...viewer, at: null })));
          setSharerAt(null);
          setThreads(message.threads);
          return;
        case 'page': setPage(message); return;
        case 'frame': setFrame(message); return;
        case 'viewers': setWatchers(message.viewers); return;
        case 'sharer': setSharerAt(message.at); return;
        case 'hit': setHit(message.target); return;
        case 'presence': setOnline(message.online); return;
        case 'thread': {
          const { thread } = message;
          setThreads(current => current.some(other => other.root.id === thread.root.id) ? current.map(other => other.root.id === thread.root.id ? thread : other) : [...current, thread]);
          const text = sent.current, { root } = thread;
          if (text !== null && thread.replies.length === 0 && root.text === text && root.by.kind === 'person' && root.by.name === joined.name) {
            sent.current = null;
            setSending(false);
            setDraft(null);
            setDraftText('');
            setHit(null);
          }
          const operation = threadOperation.current;
          if (operation?.threadId === root.id && operation.settled(thread)) {
            threadOperation.current = null;
            operation.resolve();
          }
          return;
        }
        case 'error':
          if (sent.current !== null) {
            sent.current = null;
            setSending(false);
            setDraftError(message.message);
          } else if (threadOperation.current) {
            threadOperation.current.reject(new Error(message.message));
            threadOperation.current = null;
          } else setNotice(message.message);
          return;
        case 'ended':
          finished = true;
          ended.current(message.reason);
          return;
      }
    };
    const connect = (current: ShareJoined) => {
      live.current = openShareLive(shareId, current.token, { message: receive, dropped });
      live.current.send({ type: 'size', ...sizeRef.current });
    };
    const rejoin = () => {
      joinShare(shareId, secret, name, signed).then(next => {
        if (disposed) return;
        setSelf(next);
        connect(next);
      }, (cause: unknown) => {
        if (disposed) return;
        if (cause instanceof ShareRequestError && (cause.code === 'SHARE_ENDED' || cause.code === 'SHARE_UNKNOWN')) ended.current(null);
        else dropped();
      });
    };
    function dropped() {
      live.current = null;
      if (disposed || finished) return;
      setConnected(false);
      if (sent.current !== null) {
        sent.current = null;
        setSending(false);
        setDraftError('The connection dropped before your comment was saved. Send it again.');
      }
      threadOperation.current?.reject(new Error('The connection dropped before it was saved. Try again.'));
      threadOperation.current = null;
      timer = window.setTimeout(rejoin, Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** failures));
      failures += 1;
    }
    connect(joined);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      live.current?.close();
      live.current = null;
    };
  }, [shareId, secret, joined, name, signed]);

  useEffect(() => {
    if (!commenting || draft) return;
    const leave = (event: KeyboardEvent) => { if (event.key === 'Escape') setCommenting(false); };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [commenting, draft]);

  const pointAt = (event: ReactPointerEvent): Point | null => {
    const rect = screenRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return { x: fraction((event.clientX - rect.left) / rect.width), y: fraction((event.clientY - rect.top) / rect.height) };
  };
  const point = (at: Point) => { throttles.pointer.push(at); };
  const onPointerMove = (event: ReactPointerEvent) => {
    const at = pointAt(event);
    if (!at) return;
    point(at);
    if (!commenting || draft) return;
    const pressed = press.current;
    if (pressed) {
      if (pressed.moved || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > DRAG_PX) {
        pressed.moved = true;
        throttles.hit.cancel();
        setHit(null);
        setDragBox(boxBetween(pressed.start, at));
      }
      return;
    }
    if (event.pointerType !== 'touch') throttles.hit.push(at);
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    const at = pointAt(event);
    if (!at) return;
    point(at);
    if (!commenting) { setOpenThread(null); return; }
    if (draft) return;
    press.current = { start: at, x: event.clientX, y: event.clientY, moved: false };
    // Keeps a drag going when it leaves the frame; a browser without capture ends it at the frame's edge instead.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* no capture for this pointer */ }
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const pressed = press.current;
    press.current = null;
    if (!pressed || !commenting) return;
    const at = pointAt(event) ?? pressed.start;
    setDragBox(null);
    setDraftError(null);
    setOpenThread(null);
    if (pressed.moved) {
      setHit(null);
      setDraft({ kind: 'region', region: boxBetween(pressed.start, at) });
      return;
    }
    throttles.hit.cancel();
    live.current?.send({ type: 'hit', at });
    setDraft({ kind: 'point', at });
  };
  const onPointerLeave = (event: ReactPointerEvent) => {
    // A finger's pointer stays where it last touched.
    if (event.pointerType === 'touch' || press.current) return;
    throttles.pointer.push(null);
    throttles.hit.cancel();
    if (!draft) setHit(null);
  };
  const cancelDraft = () => {
    sent.current = null;
    setSending(false);
    setDraft(null);
    setDraftText('');
    setDraftError(null);
    setHit(null);
  };
  const submitDraft = () => {
    const text = draftText.trim();
    if (!draft || !text || sending) return;
    if (!live.current) { setDraftError('Not connected. Send it again once the tab is back.'); return; }
    sent.current = text;
    setSending(true);
    setDraftError(null);
    live.current.send(draft.kind === 'point' ? { type: 'comment', at: draft.at, text } : { type: 'comment', region: draft.region, text });
  };
  const toggleCommenting = () => {
    setCommenting(current => !current);
    cancelDraft();
    throttles.hit.cancel();
  };
  /** Replies and resolves go on the socket, one at a time; each settles when its thread comes back changed. */
  const threadActions: ThreadActions = {
    reply: (threadId, text) => sendThreadChange(threadId, { type: 'commentReply', threadId, text }, thread => thread.replies.some(reply => reply.text === text && reply.by.kind === 'person' && reply.by.name === self.name)),
    resolve: (threadId, reopen) => sendThreadChange(threadId, reopen ? { type: 'commentResolve', threadId, reopen } : { type: 'commentResolve', threadId }, thread => (thread.root.resolved === null) === reopen),
  };
  function sendThreadChange(threadId: string, message: RuntimeBrowserShareViewerMessage, settled: ThreadOperation['settled']): Promise<void> {
    if (!live.current) return Promise.reject(new Error('Not connected. Try again once the tab is back.'));
    if (threadOperation.current) return Promise.reject(new Error('Wait for the last change to be saved.'));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    threadOperation.current = { threadId, settled, resolve, reject };
    live.current.send(message);
    return promise;
  }
  /** Opens a thread over the page, or closes it when it is open. */
  const toggleThread = (threadId: string) => {
    cancelDraft();
    setOpenThread(current => current === threadId ? null : threadId);
  };

  const sharer = share.sharer || 'Someone';
  const aspect = page ?? frame ?? { width: 16, height: 10 };
  const fit = stage ? Math.min(stage.width, (stage.height * aspect.width) / aspect.height) : null;
  const title = page?.title || share.page.title || share.page.site;
  const frameHeight = ((fit ?? 0) * aspect.height) / aspect.width;
  const chosen = draft?.kind === 'region' ? draft.region : draft && hit ? hit.box : draft ? { ...draft.at, width: 0, height: 0 } : null;
  const popover = chosen ? placeDraft(chosen, fit ?? 0, frameHeight) : null;
  const draftLabel = draft?.kind === 'region' ? 'an area of the page' : hit ? shareTargetLabel(hit) : 'this spot';
  const shownWatchers = watchers.slice(0, WATCHER_AVATARS);
  const numbered = numberThreads(threads);
  // Pins: this page's open threads that point at something, where the tab's viewport showed it.
  const pageKey = page ? browserCommentPageKey(page.url) : null;
  const pinned = numbered.filter(({ thread: { root } }) => root.anchor !== null && root.resolved === null && browserCommentPageKey(root.page.url) === pageKey);
  const shown = numbered.find(({ thread }) => thread.root.id === openThread) ?? null;
  const shownPinned = shown !== null && pinned.includes(shown);
  return <main className="flex h-dvh flex-col bg-background">
    <header className="flex items-center gap-2.5 border-b border-border bg-surface-1 px-4 py-2.5">
      <img src="/favicon.png" alt="" width={20} height={20} className="shrink-0 rounded-md" />
      <p className="min-w-0 flex-1 truncate text-caption text-foreground">
        <strong>{sharer}</strong> is sharing <span className="font-mono">{page ? siteOf(page.url, share.page.site) : share.page.site}</span> · {shareTimeLeft(share.expiresAt, Date.now())} left
      </p>
      <ul aria-label="Watching" className="flex shrink-0 -space-x-1.5">
        {/* The sharer, at their Chrome while it is online, in the gray of their pointer. */}
        {online ? <li title={`${sharer} · sharing`} className="flex size-6 items-center justify-center rounded-full border-2 border-surface-1 text-[10px] font-bold text-white" style={{ background: SHARER_GRAY }}>
          <span aria-hidden>{[...sharer.trim()][0]?.toUpperCase() ?? '?'}</span><span className="sr-only">{sharer} · sharing</span>
        </li> : null}
        {shownWatchers.map(watcher => {
          const label = `${watcher.name}${watcher.viewerId === self.viewerId ? ' (you)' : ''}${watcher.guest ? ' · guest' : ''}`;
          return <li key={watcher.viewerId} title={label} className="flex size-6 items-center justify-center rounded-full border-2 border-surface-1 text-[10px] font-bold text-white" style={{ background: browserSharePointerColor(watcher.viewerId) }}>
            <span aria-hidden>{[...watcher.name.trim()][0]?.toUpperCase() ?? '?'}</span><span className="sr-only">{label}</span>
          </li>;
        })}
        {watchers.length > shownWatchers.length ? <li title={`${watchers.length} watching`} className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-surface-1 bg-surface-3 px-1 text-[10px] font-bold text-foreground">+{watchers.length - shownWatchers.length}</li> : null}
      </ul>
      {share.comment
        ? <Button type="button" size="compact" variant={commenting ? 'primary' : 'secondary'} aria-pressed={commenting} leadingIcon={CommentGlyph} onClick={toggleCommenting}>{commenting ? 'Commenting' : 'Comment'}</Button>
        : null}
    </header>
    {!online ? <p role="status" className="border-b border-border bg-surface-2 px-4 py-1.5 text-caption text-foreground">{sharer}'s Chrome is offline. The tab comes back when it reconnects.</p> : null}
    {!connected ? <p role="status" className="border-b border-border bg-surface-2 px-4 py-1.5 text-caption text-foreground">Connection lost. Reconnecting…</p> : null}
    {notice ? <p role="alert" className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-1.5 text-caption text-destructive">{notice}<Button type="button" size="compact" variant="ghost" className="ml-auto" onClick={() => setNotice(null)}>Dismiss</Button></p> : null}
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 bg-surface-2 p-2 sm:p-4">
          <div ref={stageRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
            <div
              ref={screenRef}
              aria-label="Shared tab"
              className={`relative touch-none select-none ${commenting ? 'cursor-crosshair' : 'cursor-default'}`}
              style={{ aspectRatio: `${aspect.width} / ${aspect.height}`, width: fit === null ? '100%' : `${fit}px` }}
              onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerLeave={onPointerLeave}
            >
              <div className="absolute inset-0 overflow-hidden rounded-md bg-black/90 shadow-sm">
                {frame
                  ? <img alt={`Live view of ${title}`} src={`data:image/jpeg;base64,${frame.data}`} draggable={false} className="size-full object-contain" />
                  : <div className="flex size-full flex-col items-center justify-center gap-2 text-caption text-white/70"><ThinkingIndicator aria-label="Waiting for the tab" />Waiting for the tab…</div>}
              </div>
              {commenting ? <div aria-hidden className="pointer-events-none absolute inset-0 rounded-md" style={{ boxShadow: `inset 0 0 0 3px ${COMMENT_PURPLE}` }} /> : null}
              {commenting && hit && !draft && !dragBox ? <Outline box={hit.box} label={shareTargetLabel(hit)} kind="hover" /> : null}
              {dragBox ? <Outline box={dragBox} label="Selected area" kind="area" /> : null}
              {draft?.kind === 'region' ? <Outline box={draft.region} label="Selected area" kind="chosenArea" /> : null}
              {draft?.kind === 'point' && hit ? <Outline box={hit.box} label={shareTargetLabel(hit)} kind="chosen" /> : null}
              {/* Viewers' named pointers, yours included, and the agent's cursor are drawn on the tab and arrive in its
                  frames. The sharer's own pointer is drawn here: on the tab it would sit under their cursor. */}
              {sharerAt && online ? <SharerPointer at={sharerAt} name={sharer} /> : null}
              {share.comment ? pinned.map(({ thread: { root }, n }) => root.anchor ? <CommentPin key={root.id} n={n} box={root.anchor.box} resolved={false} highlighted={root.id === openThread} onClick={() => toggleThread(root.id)} /> : null) : null}
              {shown ? <ThreadPopover
                key={shown.thread.root.id} thread={shown.thread} n={shown.n} as={`${self.name}${self.guest ? ' (guest)' : ''}`} canResolve={!self.guest}
                actions={threadActions} now={Date.now()} onClose={() => setOpenThread(null)}
                style={placeThread(shownPinned ? shown.thread.root.anchor?.box ?? null : null, fit ?? 0, frameHeight)}
              /> : null}
              {draft && popover ? <form
                aria-label="New comment"
                onSubmit={event => { event.preventDefault(); submitDraft(); }}
                onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
                className="absolute z-30 flex w-72 max-w-[80vw] cursor-auto flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-[12px] text-neutral-800 shadow-2xl"
                style={popover}
              >
                <p className="text-[11px] text-neutral-500">On {draftLabel} · as <strong className="text-neutral-700">{self.name}{self.guest ? ' (guest)' : ''}</strong></p>
                <textarea
                  aria-label="Your comment" rows={2} autoFocus value={draftText} disabled={sending} maxLength={4000} placeholder="Write a comment…"
                  className="w-full resize-none rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-[#a142f4] focus:outline-none"
                  onChange={event => setDraftText(event.currentTarget.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') cancelDraft();
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitDraft(); }
                  }}
                />
                {draftError ? <p role="alert" className="text-[11px] text-red-600">{draftError}</p> : null}
                <div className="flex items-center gap-2">
                  <button type="button" className="text-[11px] text-neutral-500 hover:text-neutral-800" onClick={cancelDraft}>Cancel</button>
                  <span className="flex-1" />
                  <button type="submit" className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50" style={{ background: COMMENT_PURPLE }} disabled={!draftText.trim() || sending}>{sending ? 'Sending…' : 'Comment'}</button>
                </div>
              </form> : null}
            </div>
          </div>
        </div>
        <p className="border-t border-border bg-surface-1 px-4 py-2 text-[11px] text-muted-foreground">
          {commenting
            ? `Hover to see what a comment would attach to, click it, or drag across an area. ${sharer} sees your comment on the page in their Chrome and in their workspace.`
            : 'Watching live · your pointer is visible to everyone here'}
        </p>
      </div>
      {share.comment ? <aside className="flex max-h-[38dvh] flex-col overflow-y-auto border-t border-border bg-surface-1 p-4 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
        <ShareComments threads={numbered} open={openThread} onOpen={toggleThread} />
      </aside> : null}
    </div>
  </main>;
}

/** The sharer's gray pointer and name (the overlay's arrow), gliding to each place their Chrome reports; the arrow's
 * tip is 2 px into its box. */
function SharerPointer({ at, name }: { at: Point; name: string }) {
  return <div
    role="img" aria-label={`${name}’s pointer`}
    className="pointer-events-none absolute z-20 -translate-x-0.5 -translate-y-0.5 transition-[left,top] duration-100 ease-out motion-reduce:transition-none"
    style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
  >
    <svg width="22" height="24" viewBox="0 0 22 24" aria-hidden style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' }}>
      <path d="M2 2 L2 19 L6.6 14.8 L9.6 21.6 L12.6 20.3 L9.7 13.6 L16 13.4 Z" fill={SHARER_GRAY} stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
    <span aria-hidden className="absolute left-4 top-5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white shadow" style={{ background: SHARER_GRAY }}>{name}</span>
  </div>;
}

type OutlineKind = 'hover' | 'area' | 'chosen' | 'chosenArea';
/** Hovered and dragged are dashed, chosen is solid; areas are filled. */
const OUTLINE_STYLE: Record<OutlineKind, CSSProperties> = {
  hover: { outline: `2px dashed ${COMMENT_PURPLE}`, outlineOffset: 2 },
  area: { outline: `2px dashed ${COMMENT_PURPLE}`, background: `${COMMENT_PURPLE}14` },
  chosen: { outline: `2px solid ${COMMENT_PURPLE}`, outlineOffset: 2 },
  chosenArea: { outline: `2px solid ${COMMENT_PURPLE}`, background: `${COMMENT_PURPLE}14` },
};

function Outline({ box, label, kind }: { box: RuntimeBrowserShareBox; label: string; kind: OutlineKind }) {
  return <div
    aria-label={label}
    className="pointer-events-none absolute z-10 rounded"
    style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%`, ...OUTLINE_STYLE[kind] }}
  >
    {kind === 'hover' ? <span className="absolute -top-6 -left-[3px] max-w-64 truncate rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: COMMENT_PURPLE }}>{label}</span> : null}
  </div>;
}

/** Where the comment box goes in the frame (`width` × `height` px): beside the target, on the side with room. */
function placeDraft(target: RuntimeBrowserShareBox, width: number, height: number): CSSProperties {
  const right = (target.x + target.width) * width + DRAFT_GAP_PX;
  const left = right + DRAFT_WIDTH_PX <= width ? right : Math.max(0, Math.min(width - DRAFT_WIDTH_PX, target.x * width - DRAFT_GAP_PX - DRAFT_WIDTH_PX));
  return { left, top: Math.max(8, Math.min(target.y * height - 8, height - DRAFT_HEIGHT_PX)) };
}
