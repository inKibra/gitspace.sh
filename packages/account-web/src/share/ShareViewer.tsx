import { Badge, Button, ThinkingIndicator } from '@gitspace/ui';
import type {
  RuntimeBrowserPageComment,
  RuntimeBrowserShareBox,
  RuntimeBrowserSharePreview,
  RuntimeBrowserShareServerMessage,
  RuntimeBrowserShareTarget,
  RuntimeBrowserShareViewer,
} from '@gitspace/protocol-runtime';
import { browserSharePointerColor } from '@gitspace/protocol-runtime';
import { MessageTextSquare01 } from '@untitledui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ShareComments } from './ShareComments.js';
import { joinShare, openShareLive, ShareRequestError } from './share-client.js';
import type { ShareJoined, ShareLive } from './share-client.js';
import { shareEndsText } from './share-format.js';
import type { ShareEnd } from './share-format.js';

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Watcher = RuntimeBrowserShareViewer & { at: Point | null };
type Page = Extract<RuntimeBrowserShareServerMessage, { type: 'page' }>;
type Frame = Extract<RuntimeBrowserShareServerMessage, { type: 'frame' }>;
/** A comment being written: on the element at a point, or on a dragged area. */
type Draft = { kind: 'point'; at: Point } | { kind: 'region'; region: RuntimeBrowserShareBox };

/** At most 20 pointer messages a second. */
const POINTER_INTERVAL_MS = 50;
const HIT_INTERVAL_MS = 150;
const SIZE_INTERVAL_MS = 500;
/** A press that moves farther than this (CSS px) drags an area instead of picking an element. */
const DRAG_PX = 8;
const RECONNECT_MAX_MS = 15_000;

/** Sends at most once per interval; the latest value waiting is sent when the interval ends. */
class Throttle<T> {
  private last = Number.NEGATIVE_INFINITY;
  private timer: number | undefined;
  private waiting: { value: T } | null = null;
  constructor(private readonly interval: number, private readonly emit: (value: T) => void) {}
  push(value: T): void {
    const wait = this.last + this.interval - Date.now();
    if (wait <= 0 && this.timer === undefined) {
      this.last = Date.now();
      this.emit(value);
      return;
    }
    this.waiting = { value };
    this.timer ??= window.setTimeout(() => {
      this.timer = undefined;
      const waiting = this.waiting;
      this.waiting = null;
      if (!waiting) return;
      this.last = Date.now();
      this.emit(waiting.value);
    }, Math.max(0, wait));
  }
  cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting = null;
  }
}

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
  const [comments, setComments] = useState<RuntimeBrowserPageComment[]>([]);
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
          setComments(message.comments);
          return;
        case 'page': setPage(message); return;
        case 'frame': setFrame(message); return;
        case 'viewers': setWatchers(message.viewers); return;
        case 'hit': setHit(message.target); return;
        case 'presence': setOnline(message.online); return;
        case 'comments': {
          setComments(message.comments);
          const text = sent.current;
          if (text !== null && message.comments.some(comment => comment.text === text && comment.by.name === joined.name)) {
            sent.current = null;
            setSending(false);
            setDraft(null);
            setDraftText('');
            setHit(null);
          }
          return;
        }
        case 'error':
          if (sent.current !== null) {
            sent.current = null;
            setSending(false);
            setDraftError(message.message);
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
    if (!commenting || draft) return;
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

  const sharer = share.sharer || 'Someone';
  const aspect = page ?? frame ?? { width: 16, height: 10 };
  const fit = stage ? Math.min(stage.width, (stage.height * aspect.width) / aspect.height) : null;
  const anchor = draft?.kind === 'point' ? draft.at : draft ? { x: draft.region.x + draft.region.width, y: draft.region.y + draft.region.height } : null;
  const title = page?.title || share.page.title || share.page.site;
  return <main className="flex h-dvh flex-col bg-background">
    <header className="flex items-center gap-3 border-b border-border px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-body font-medium text-foreground">{title}</h1>
        <span className="truncate text-caption text-muted-foreground">{page ? siteOf(page.url, share.page.site) : share.page.site} · shared by {sharer} · ends {shareEndsText(share.expiresAt, Date.now())}</span>
      </div>
      {share.comment
        ? <Button type="button" size="compact" variant={commenting ? 'primary' : 'secondary'} aria-pressed={commenting} onClick={toggleCommenting}><MessageTextSquare01 aria-hidden className="size-4" />Comment</Button>
        : null}
    </header>
    {!online ? <p role="status" className="border-b border-border bg-surface-2 px-3 py-1.5 text-caption text-foreground">{sharer}'s Chrome is offline. The tab comes back when it reconnects.</p> : null}
    {!connected ? <p role="status" className="border-b border-border bg-surface-2 px-3 py-1.5 text-caption text-foreground">Connection lost. Reconnecting…</p> : null}
    {notice ? <p role="alert" className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-caption text-destructive">{notice}<Button type="button" size="compact" variant="ghost" className="ml-auto" onClick={() => setNotice(null)}>Dismiss</Button></p> : null}
    {commenting ? <p className="border-b border-border px-3 py-1.5 text-caption text-muted-foreground">Click or tap what you want to comment on, or drag over an area.</p> : null}
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 bg-surface-2 p-2 sm:p-4">
        <div ref={stageRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div
            ref={screenRef}
            aria-label="Shared tab"
            className={`relative touch-none select-none ${commenting ? 'cursor-crosshair' : 'cursor-none'}`}
            style={{ aspectRatio: `${aspect.width} / ${aspect.height}`, width: fit === null ? '100%' : `${fit}px` }}
            onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerLeave={onPointerLeave}
          >
            <div className="absolute inset-0 overflow-hidden rounded-lg bg-black/90 shadow-sm">
              {frame
                ? <img alt={`Live view of ${title}`} src={`data:image/jpeg;base64,${frame.data}`} draggable={false} className="size-full object-contain" />
                : <div className="flex size-full flex-col items-center justify-center gap-2 text-caption text-white/70"><ThinkingIndicator aria-label="Waiting for the tab" />Waiting for the tab…</div>}
            </div>
            {commenting && hit ? <Outline box={hit.box} label={[hit.role, hit.name].filter(Boolean).join(' ')} /> : null}
            {dragBox ? <Outline box={dragBox} label={null} /> : null}
            {draft?.kind === 'region' ? <Outline box={draft.region} label={null} /> : null}
            {/* Everyone's named pointer, yours included, is drawn on the tab itself and arrives in its frames. */}
            {draft && anchor ? <form
              aria-label="New comment"
              onSubmit={event => { event.preventDefault(); submitDraft(); }}
              onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
              className="absolute z-20 flex w-64 max-w-[80vw] cursor-auto flex-col gap-2 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg"
              style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%`, transform: `translate(${anchor.x > 0.6 ? '-100%' : '0'}, ${anchor.y > 0.6 ? '-100%' : '0'})` }}
            >
              <span className="truncate text-caption text-muted-foreground">{draft.kind === 'region' ? 'On this area' : hit ? `On ${[hit.role, hit.name ? `“${hit.name}”` : ''].filter(Boolean).join(' ')}` : 'On this spot'}</span>
              <textarea
                aria-label="Your comment" rows={3} autoFocus value={draftText} disabled={sending} maxLength={4000}
                className="w-full resize-none rounded-md border border-border bg-surface-2 p-2 text-body text-foreground"
                onChange={event => setDraftText(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') cancelDraft();
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitDraft(); }
                }}
              />
              {draftError ? <p role="alert" className="text-caption text-destructive">{draftError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" size="compact" variant="ghost" onClick={cancelDraft}>Cancel</Button>
                <Button type="submit" size="compact" variant="primary" disabled={!draftText.trim() || sending}>{sending ? 'Sending…' : 'Comment'}</Button>
              </div>
            </form> : null}
          </div>
        </div>
      </div>
      <aside className="flex max-h-[38dvh] flex-col gap-4 overflow-y-auto border-t border-border p-3 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
        <section aria-label="Watching" className="flex flex-col gap-2">
          <h2 className="text-caption font-medium text-muted-foreground">Watching · {watchers.length}</h2>
          <ul className="flex flex-col gap-1">
            {watchers.map(watcher => <li key={watcher.viewerId} className="flex items-center gap-2 text-body text-foreground">
              <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: browserSharePointerColor(watcher.viewerId) }} />
              <span className="truncate">{watcher.name}{watcher.viewerId === self.viewerId ? ' (you)' : ''}</span>
              {watcher.guest ? <Badge size="compact" color="gray">guest</Badge> : null}
            </li>)}
          </ul>
        </section>
        {share.comment ? <ShareComments comments={comments} /> : null}
      </aside>
    </div>
  </main>;
}

function Outline({ box, label }: { box: RuntimeBrowserShareBox; label: string | null }) {
  return <div
    aria-label={label ?? 'Selected area'}
    className="pointer-events-none absolute z-10 rounded-sm border-2 border-blue-500 bg-blue-500/10"
    style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}
  >
    {label ? <span className="absolute -top-6 left-0 max-w-64 truncate rounded bg-blue-600 px-1.5 py-0.5 text-[11px] text-white">{label}</span> : null}
  </div>;
}
