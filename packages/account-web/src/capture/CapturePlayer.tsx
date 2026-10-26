import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  CAPTURE_SECRET_VALUE, CAPTURE_TRACK_FILES, RuntimeBrowserCaptureStepsSchema, RuntimeBrowserFramesIndexSchema, RuntimeBrowserLayoutSampleSchema,
  type RuntimeBrowserCapture, type RuntimeBrowserCaptureStep, type RuntimeBrowserCommentAnchor, type RuntimeBrowserCommentBox, type RuntimeBrowserCommentThread,
  type RuntimeBrowserFramesIndex, type RuntimeBrowserLayoutSample,
} from '@gitspace/protocol-runtime';
import { Button, TabsSubtle, TabsSubtleItem } from '@gitspace/ui';
import { MessagePlusSquare } from '@untitledui/icons';
import { COMMENT_PURPLE, CommentPin, ThreadPopover, commentAnchorLabel, commentAuthorName, placeThread, type ThreadActions } from '../comment-threads.js';
import { glyph } from '../glyph.js';

type Frames = RuntimeBrowserFramesIndex['frames'];
type Media = { kind: 'video' | 'image'; url: string } | { kind: 'frames'; data: string; index: string };
/** A thread of this capture with its number on the timeline and its moment. */
type Timed = { thread: RuntimeBrowserCommentThread; n: number; atMs: number };
type Element = RuntimeBrowserLayoutSample['elements'][number];
/** A comment being written: what it points at, at which moment. */
type Draft = { anchor: Omit<RuntimeBrowserCommentAnchor, 'cropFile'>; atMs: number };
/** The frames player's object URLs by frame, the frames being read, the one on screen (kept while the next loads),
 * and the reads of the current recording. */
type FrameCache = { images: Map<number, string>; pending: Set<number>; shown: string | null; controller: AbortController | null };
type Sidebar = 'comments' | 'steps';

/** Frames a recording reads ahead of the playhead, in one byte-range request of `frames.bin`. */
export const FRAMES_AHEAD = 6;
/** Frames kept decoded behind the playhead, so a small step back shows at once. */
const FRAMES_BEHIND = 12;
/** A capture's preview image beside `capture.json` (contract: written when the capture has one). */
export const CAPTURE_THUMBNAIL = 'thumbnail.jpg';
/** A press that moves less than this many pixels is a click on an element; more drags out an area. */
const DRAG_PX = 12;
/** The arrow keys step the playhead this far. */
const KEY_STEP_MS = 5000;
const SIDEBAR_ORDER: readonly Sidebar[] = ['comments', 'steps'];
const STEP_KIND: Record<RuntimeBrowserCaptureStep['kind'], string> = { goto: 'Go to', click: 'Click', fill: 'Fill', press: 'Press', select: 'Select', check: 'Check', upload: 'Upload', request: 'Request' };
const CommentGlyph = glyph(MessagePlusSquare);

/** `m:ss` of a duration in milliseconds. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A recording's length: its video's, else from its start to its end; zero for a screenshot or one still recording. */
export function captureLength(capture: RuntimeBrowserCapture): number {
  return capture.tracks.video?.durationMs ?? (capture.endedAt ? Math.max(0, Date.parse(capture.endedAt) - Date.parse(capture.startedAt)) : 0);
}

/** What the player shows: video (Chrome's recording with sound) before screencast frames before a single image. */
export function captureMedia(capture: RuntimeBrowserCapture, files: Readonly<Record<string, string>>): Media | null {
  const { video, frames, image } = capture.tracks;
  const videoUrl = video ? files[video.path] : undefined;
  if (videoUrl) return { kind: 'video', url: videoUrl };
  const data = frames ? files[frames.path] : undefined, index = frames ? files[frames.index] : undefined;
  if (data && index) return { kind: 'frames', data, index };
  const imageUrl = image ? files[image.path] : undefined;
  return imageUrl ? { kind: 'image', url: imageUrl } : null;
}

/** A capture's threads in timeline order, numbered from 1: by their moment, then by when they were made. */
export function timedThreads(threads: readonly RuntimeBrowserCommentThread[]): Timed[] {
  return threads
    .flatMap(thread => thread.root.source.kind === 'capture' ? [{ thread, atMs: thread.root.source.atMs }] : [])
    .toSorted((a, b) => a.atMs - b.atMs || a.thread.root.createdAt.localeCompare(b.thread.root.createdAt))
    .map((timed, index) => ({ ...timed, n: index + 1 }));
}

/** The frame showing at `t` ms: the last one at or before it. */
function frameAt(frames: Frames, t: number): number {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle]!.t <= t) low = middle; else high = middle - 1;
  }
  return low;
}

/** The layout kept at `t` ms: the last sample at or before it, else the first. */
function sampleAt(samples: readonly RuntimeBrowserLayoutSample[], t: number): RuntimeBrowserLayoutSample | null {
  let found: RuntimeBrowserLayoutSample | null = samples[0] ?? null;
  for (const sample of samples) { if (sample.atMs > t) break; found = sample; }
  return found;
}

/** The smallest element of a layout sample under a point (viewport fractions). */
function elementAt(sample: RuntimeBrowserLayoutSample | null, x: number, y: number): Element | null {
  let best: Element | null = null;
  for (const element of sample?.elements ?? []) {
    const { box } = element;
    if (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) continue;
    if (!best || box.w * box.h < best.box.w * best.box.h) best = element;
  }
  return best;
}

/** One track file read once, or why it could not be: `parse` turns its text into the track. */
function useTrackFile<T>(url: string | undefined, parse: (text: string) => T): { value: T | null; error: string | null } {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({ value: null, error: null });
  const parser = useRef(parse);
  useEffect(() => {
    setState({ value: null, error: null });
    if (!url) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = parser.current(await response.text());
        if (!controller.signal.aborted) setState({ value, error: null });
      } catch (cause) { if (!controller.signal.aborted) setState({ value: null, error: cause instanceof Error ? cause.message : String(cause) }); }
    })();
    return () => controller.abort();
  }, [url]);
  return state;
}

/** A comment written on the recording: at `atMs`, on the page shown then, pointing at `anchor`. */
export type CaptureCommentInput = { atMs: number; page: { url: string; title: string }; anchor: Omit<RuntimeBrowserCommentAnchor, 'cropFile'>; text: string };
/** Replying, resolving, and commenting at a moment; each settles once saved, or rejects with why it was not. */
export interface CapturePlayerActions extends ThreadActions {
  comment(input: CaptureCommentInput): Promise<void>;
}

export interface CapturePlayerProps {
  capture: RuntimeBrowserCapture;
  /** Links to the files of the capture's folder, by name. */
  files: Readonly<Record<string, string>>;
  /** The capture's threads; null until read. */
  threads: readonly RuntimeBrowserCommentThread[] | null;
  threadsError?: string | null;
  /** Who comments and replies here, as the fields say: "You", "Ana (guest)". */
  as: string;
  canComment: boolean;
  /** The account's owner: Resolve and Reopen. */
  canResolve: boolean;
  actions: CapturePlayerActions;
  /** The header row: the capture's name and where it comes from. */
  header: ReactNode;
}

/**
 * One player for every capture (docs/APERTURE-DESIGN.md §11): Chrome's video, screencast frames or a screenshot, with
 * a scrubber marking each step and each comment, the comments made up to the playhead pinned where they point, a
 * sidebar of comments and steps that seeks on a click, and "Comment at m:ss": hovering the frame outlines the element
 * the layout track kept at that moment, a click anchors to it and a drag to an area.
 */
export function CapturePlayer({ capture, files, threads, threadsError, as, canComment, canResolve, actions, header }: CapturePlayerProps) {
  const media = captureMedia(capture, files);
  const steps = useTrackFile(capture.tracks.steps ? files[CAPTURE_TRACK_FILES.steps] : undefined, text => RuntimeBrowserCaptureStepsSchema.parse(JSON.parse(text)).toSorted((a, b) => a.atMs - b.atMs));
  const layout = useTrackFile(capture.tracks.layout ? files[CAPTURE_TRACK_FILES.layout] : undefined, text => text.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { const sample = RuntimeBrowserLayoutSampleSchema.safeParse(JSON.parse(line)); return sample.success ? [sample.data] : []; } catch { return []; }
  }).toSorted((a, b) => a.atMs - b.atMs));
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [length, setLength] = useState(() => captureLength(capture));
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  const [sidebar, setSidebar] = useState<Sidebar>('comments');
  const [selected, setSelected] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [hover, setHover] = useState<Element | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const video = useRef<HTMLVideoElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => { const box = element.getBoundingClientRect(); setArea({ width: box.width, height: box.height }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const samples = layout.value ?? [];
  const firstSample = samples[0];
  // The frame's shape: the video's own, else the recorded frames' or screenshot's, else the page's viewport.
  const shape = videoSize
    ?? (capture.tracks.frames ? { w: capture.tracks.frames.width, h: capture.tracks.frames.height } : capture.tracks.image ? { w: capture.tracks.image.width, h: capture.tracks.image.height } : firstSample ? firstSample.viewport : { w: 16, h: 10 });
  const scale = Math.min(area.width / shape.w, area.height / shape.h) || 0;
  const frame = { width: shape.w * scale, height: shape.h * scale };
  const timed = useMemo(() => timedThreads(threads ?? []), [threads]);
  const visible = timed.filter(item => item.atMs <= time);
  const latest = visible.at(-1);
  const active = selected !== null ? timed.find(item => item.thread.root.id === selected) : latest;
  const popover = active && active.thread.root.id !== dismissed && !commenting && draft === null ? active : null;
  const sample = sampleAt(samples, time);
  const timeline = media?.kind === 'video' || media?.kind === 'frames';

  const seek = (ms: number) => {
    const next = Math.max(0, Math.min(length || ms, ms));
    setTime(next);
    if (video.current) video.current.currentTime = next / 1000;
  };
  /** Seeks to a thread's moment and opens it. */
  const show = (item: Timed) => { seek(item.atMs); setSelected(item.thread.root.id); setDismissed(null); };
  const toggle = () => {
    const element = video.current;
    if (media?.kind === 'video' && element) {
      if (element.paused) void Promise.resolve(element.play()).catch(() => setPlaying(false)); else element.pause();
      return;
    }
    if (!playing && time >= length) setTime(0);
    setSelected(null);
    setPlaying(!playing);
  };
  const startCommenting = () => {
    if (commenting) { setCommenting(false); setHover(null); setDraft(null); return; }
    video.current?.pause();
    setPlaying(false);
    setCommenting(true);
  };
  /** The point under the pointer as fractions of the frame. */
  const point = (event: { clientX: number; clientY: number }) => {
    const box = overlay.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)), width: box.width, height: box.height };
  };
  // The page shown at the playhead: the last step's address at or before it, else where the capture began.
  const stepAtTime = (steps.value ?? []).filter(step => step.atMs <= time && step.kind !== 'request').at(-1);
  const page = stepAtTime && stepAtTime.url !== capture.page.url ? { url: stepAtTime.url, title: '' } : capture.page;

  const hoverBox = drag ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : hover?.box ?? null;
  return <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-surface-1">
    <header className="flex min-w-0 items-center gap-2.5 border-b border-border px-4 py-2.5">{header}</header>
    <div className="flex min-h-0 flex-col md:h-[min(60vh,520px)] md:flex-row">
      <aside aria-label="Comments and steps" className="flex max-h-56 w-full shrink-0 flex-col gap-1 overflow-hidden border-b border-border p-2 md:max-h-none md:w-64 md:border-b-0 md:border-r">
        <TabsSubtle size="compact" selectedIndex={SIDEBAR_ORDER.indexOf(sidebar)} onSelect={index => setSidebar(SIDEBAR_ORDER[index] ?? 'comments')} idPrefix={`capture-sidebar-${capture.captureId}`} aria-label="Capture track">
          <TabsSubtleItem index={0} label={`Comments · ${timed.length}`} />
          <TabsSubtleItem index={1} label={`Steps · ${capture.tracks.steps?.count ?? steps.value?.length ?? 0}`} />
        </TabsSubtle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sidebar === 'comments' ? <>
            {threadsError ? <p role="alert" className="p-2 text-caption text-destructive">{threadsError}</p> : null}
            {threads === null && !threadsError ? <p role="status" className="p-2 text-caption text-muted-foreground">Loading comments…</p> : null}
            {threads !== null && !timed.length ? <p className="p-2 text-caption text-muted-foreground">{canComment ? 'No comments yet. Pause where something matters and use Comment at the bottom.' : 'No comments on this capture.'}</p> : null}
            <ol className="flex flex-col gap-1">{timed.map(item => {
              const { root } = item.thread;
              const later = capture.endedAt !== null && root.createdAt > capture.endedAt;
              return <li key={root.id}><button type="button" aria-label={`Comment ${item.n} at ${formatClock(item.atMs)}`} onClick={() => show(item)} className={`flex w-full gap-2 rounded-lg p-2 text-left text-caption ${active?.thread.root.id === root.id ? 'bg-surface-3' : 'hover:bg-hover'}`}>
                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[10px] font-bold text-white" style={{ background: root.resolved ? '#525252' : COMMENT_PURPLE }}>{item.n}</span>
                <span className="min-w-0">
                  <span className="block break-words">{root.text}</span>
                  <span className="block text-[11px] text-muted-foreground">{commentAuthorName(root.by)}{root.by.kind === 'person' && root.by.guest ? ' (guest)' : ''} · at {formatClock(item.atMs)}{later ? ' · added later' : ''}{root.resolved ? ' · resolved' : ''}{item.thread.replies.length ? ` · ${item.thread.replies.length} ${item.thread.replies.length === 1 ? 'reply' : 'replies'}` : ''}</span>
                </span>
              </button></li>;
            })}</ol>
          </> : <>
            {steps.error ? <p role="alert" className="p-2 text-caption text-destructive">The steps could not be read: {steps.error}</p> : null}
            {!capture.tracks.steps ? <p className="p-2 text-caption text-muted-foreground">This capture recorded no steps.</p> : steps.value === null && !steps.error ? <p role="status" className="p-2 text-caption text-muted-foreground">Loading steps…</p> : null}
            <ol className="flex flex-col gap-0.5">{(steps.value ?? []).map((step, index) => <li key={`${step.atMs}:${index}`}><button type="button" aria-label={`Step ${index + 1} at ${formatClock(step.atMs)}`} onClick={() => { setSelected(null); seek(step.atMs); }} className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-caption ${stepAtTime === step ? 'bg-surface-3' : 'hover:bg-hover'}`}>
              <span className="w-9 shrink-0 tabular-nums text-muted-foreground">{formatClock(step.atMs)}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{STEP_KIND[step.kind]}{step.method ? ` ${step.method}` : ''}</span>{step.mutating ? <span className="ml-1 rounded-full bg-[#f59e0b]/15 px-1.5 text-[10px] text-[#b45309]">changes data</span> : null}
                <span className="block truncate font-mono text-[11px]" title={step.locator ?? step.url}>{step.kind === 'goto' || step.kind === 'request' || !step.locator ? step.url.replace(/^https?:\/\//u, '') : step.locator}</span>
                {step.value !== undefined ? <span className={`block truncate font-mono text-[11px] ${step.value === CAPTURE_SECRET_VALUE ? 'text-muted-foreground' : ''}`} title={step.value}>{step.value === CAPTURE_SECRET_VALUE ? '«secret» (masked)' : JSON.stringify(step.value)}</span> : null}
              </span>
            </button></li>)}</ol>
          </>}
        </div>
      </aside>
      <div ref={stage} className="relative flex h-[min(50vh,420px)] min-w-0 flex-1 items-center justify-center bg-neutral-950 md:h-auto">
        <div className="relative overflow-hidden" style={{ width: frame.width, height: frame.height }}>
          {media?.kind === 'video' ? <video
            ref={video} aria-label={`Video of ${capture.name}`} className="block h-full w-full bg-black" src={media.url} poster={files[CAPTURE_THUMBNAIL]} preload="metadata" playsInline
            onLoadedMetadata={event => {
              const element = event.currentTarget;
              if (element.videoWidth && element.videoHeight) setVideoSize({ w: element.videoWidth, h: element.videoHeight });
              // Chrome's recordings often name no length; the capture's own stands then.
              if (Number.isFinite(element.duration) && element.duration > 0) setLength(Math.round(element.duration * 1000));
            }}
            onTimeUpdate={event => setTime(Math.round(event.currentTarget.currentTime * 1000))}
            onPlay={() => { setPlaying(true); setSelected(null); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          /> : media?.kind === 'frames' ? <FramesPlayer indexUrl={media.index} dataUrl={media.data} label={capture.name} time={time} playing={playing} onTime={setTime} onLength={setLength} onEnded={() => setPlaying(false)} />
            : media?.kind === 'image' ? <img className="block h-full w-full object-contain" src={media.url} alt={capture.name} />
              : null}
          {visible.map(item => item.thread.root.anchor ? <CommentPin key={item.thread.root.id} n={item.n} box={item.thread.root.anchor.box} resolved={item.thread.root.resolved !== null} highlighted={popover?.thread.root.id === item.thread.root.id} onClick={commenting ? undefined : () => show(item)} /> : null)}
          {commenting ? <div
            ref={overlay} aria-label="Point at what to comment on" className="absolute inset-0 z-10 cursor-crosshair" style={{ boxShadow: `inset 0 0 0 3px ${COMMENT_PURPLE}` }}
            onPointerLeave={() => { if (!drag) setHover(null); }}
            onPointerMove={event => {
              const at = point(event);
              if (!at || draft) return;
              if (drag) setDrag({ ...drag, x1: at.x, y1: at.y }); else setHover(elementAt(sample, at.x, at.y));
            }}
            onPointerDown={event => {
              const at = point(event);
              if (!at || draft) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setDrag({ x0: at.x, y0: at.y, x1: at.x, y1: at.y });
            }}
            onPointerUp={event => {
              const at = point(event);
              const start = drag;
              setDrag(null);
              if (!at || !start || draft) return;
              const dragged = Math.hypot((at.x - start.x0) * at.width, (at.y - start.y0) * at.height) > DRAG_PX;
              const element = dragged ? null : elementAt(sample, at.x, at.y);
              const box: RuntimeBrowserCommentBox = dragged ? { x: Math.min(start.x0, at.x), y: Math.min(start.y0, at.y), w: Math.abs(at.x - start.x0), h: Math.abs(at.y - start.y0) } : element?.box ?? { x: at.x, y: at.y, w: 0, h: 0 };
              setHover(null);
              setDraft({ atMs: time, anchor: element ? { role: element.role, name: element.name, selector: element.selector, box } : { role: '', name: '', selector: '', box } });
            }}
          /> : null}
          {commenting && hoverBox && !draft ? <>
            <span aria-hidden className="pointer-events-none absolute z-20 rounded" style={{ left: `${hoverBox.x * 100}%`, top: `${hoverBox.y * 100}%`, width: `${hoverBox.w * 100}%`, height: `${hoverBox.h * 100}%`, outline: `2px dashed ${COMMENT_PURPLE}`, background: drag ? `${COMMENT_PURPLE}14` : undefined }} />
            {hover && !drag ? <span role="status" className="pointer-events-none absolute z-20 -translate-y-full rounded px-1.5 py-0.5 text-[10px] text-white" style={{ left: `${hover.box.x * 100}%`, top: `${hover.box.y * 100}%`, background: COMMENT_PURPLE }}>{commentAnchorLabel({ ...hover, box: hover.box })} · from the recording</span> : null}
          </> : null}
          {draft ? <CommentDraft key={`${draft.atMs}:${draft.anchor.box.x}:${draft.anchor.box.y}`} draft={draft} as={as} style={placeThread(draft.anchor.box, frame.width, frame.height)} onCancel={() => setDraft(null)} onSend={async text => {
            await actions.comment({ atMs: draft.atMs, page, anchor: draft.anchor, text });
            setDraft(null); setCommenting(false);
          }} /> : null}
          {popover ? <ThreadPopover key={popover.thread.root.id} thread={popover.thread} n={popover.n} as={as} canResolve={canResolve} actions={actions} now={Date.now()}
            style={placeThread(popover.thread.root.anchor?.box ?? null, frame.width, frame.height)} onClose={() => { setDismissed(popover.thread.root.id); setSelected(null); }} /> : null}
        </div>
        {!media ? <p className="absolute text-caption text-white/70">This capture has no media to play.</p> : null}
      </div>
    </div>
    {commenting && !draft ? <p className="border-t border-border px-4 py-1.5 text-caption text-muted-foreground">Hover to see what a comment at {formatClock(time)} would point at, from the page layout kept then; click it, or drag across an area. Esc to stop.</p> : null}
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5" onKeyDown={event => { if (event.key === 'Escape' && commenting) { setCommenting(false); setDraft(null); setHover(null); } }}>
      {timeline ? <>
        <button type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-[11px] text-white dark:bg-neutral-100 dark:text-neutral-900">{playing ? '❚❚' : '▶'}</button>
        <span className="w-24 shrink-0 text-caption tabular-nums">{formatClock(time)} / {formatClock(length)}</span>
        <div className="relative h-8 min-w-32 flex-1">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-3" />
          <span aria-hidden className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-neutral-500" style={{ width: `${length ? Math.min(100, time / length * 100) : 0}%` }} />
          {(steps.value ?? []).map((step, index) => <span key={`${step.atMs}:${index}`} data-step-tick title={`${STEP_KIND[step.kind]} at ${formatClock(step.atMs)}`} className="pointer-events-none absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 bg-neutral-400" style={{ left: `${length ? Math.min(100, step.atMs / length * 100) : 0}%` }} />)}
          <input aria-label="Seek" type="range" min={0} max={length} step={1} value={Math.min(time, length)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            onChange={event => { setSelected(null); seek(Number(event.currentTarget.value)); }}
            onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setSelected(null); seek(time + (event.key === 'ArrowRight' ? KEY_STEP_MS : -KEY_STEP_MS)); } }} />
          {timed.map(item => <button key={item.thread.root.id} type="button" aria-label={`Comment ${item.n} on the timeline`} onClick={() => show(item)}
            className="absolute top-0 z-10 flex size-4 -translate-x-1/2 items-center justify-center rounded-full rounded-bl-none text-[9px] font-bold text-white"
            style={{ left: `${length ? Math.min(100, item.atMs / length * 100) : 0}%`, background: item.thread.root.resolved ? '#525252' : COMMENT_PURPLE }}>{item.n}</button>)}
          <span aria-hidden className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-neutral-900 shadow" style={{ left: `${length ? Math.min(100, time / length * 100) : 0}%` }} />
        </div>
      </> : <span className="flex-1 text-caption text-muted-foreground">{media?.kind === 'image' ? 'A screenshot: one frame.' : ''}</span>}
      {canComment && media ? <Button variant={commenting ? 'primary' : 'secondary'} size="compact" leadingIcon={CommentGlyph} onClick={startCommenting}>{commenting ? 'Commenting' : `Comment at ${formatClock(time)}`}</Button> : null}
    </div>
  </div>;
}

/** A comment being written on the recording: where it points and when, the text, Cancel and a purple Comment. */
function CommentDraft({ draft, as, style, onCancel, onSend }: { draft: Draft; as: string; style: CSSProperties; onCancel(): void; onSend(text: string): Promise<void> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true); setError(null);
    try { await onSend(trimmed); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSending(false); }
  };
  return <div role="dialog" aria-label="New comment" className="absolute z-30 flex w-72 max-w-[80vw] flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-[12px] text-neutral-800 shadow-2xl" style={style}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <p className="text-[11px] text-neutral-500">On {commentAnchorLabel(draft.anchor)} · at {formatClock(draft.atMs)} · as <strong className="text-neutral-700">{as}</strong></p>
    <textarea aria-label="Your comment" autoFocus rows={3} value={text} maxLength={4000} placeholder="Write a comment…" disabled={sending}
      className="w-full resize-none rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-[#a142f4] focus:outline-none"
      onChange={event => setText(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
    {error ? <p role="alert" className="text-[11px] text-red-600">{error}</p> : null}
    <div className="flex items-center gap-2">
      <button type="button" className="text-[11px] text-neutral-500 hover:text-neutral-800" onClick={onCancel}>Cancel</button>
      <span className="flex-1" />
      <button type="button" disabled={!text.trim() || sending} className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50" style={{ background: COMMENT_PURPLE }} onClick={() => void send()}>{sending ? 'Sending…' : 'Comment'}</button>
    </div>
  </div>;
}

/** Screencast frames from `frames.bin` at the player's playhead (`time`), read with byte ranges a few frames ahead of it;
 * while `playing`, each frame shows until the next one's recorded time (`onTime`) and the last ends playback. */
function FramesPlayer({ indexUrl, dataUrl, label, time, playing, onTime, onLength, onEnded }: { indexUrl: string; dataUrl: string; label: string; time: number; playing: boolean; onTime(ms: number): void; onLength(ms: number): void; onEnded(): void }) {
  const [frames, setFrames] = useState<Frames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setLoaded] = useState(0);
  const cache = useRef<FrameCache>({ images: new Map(), pending: new Set(), shown: null, controller: null });
  const position = frames ? frameAt(frames, time) : 0;
  const playhead = useRef(0);
  playhead.current = position;
  const reported = useRef({ onLength, onTime, onEnded });
  reported.current = { onLength, onTime, onEnded };

  useEffect(() => {
    const state = cache.current;
    const controller = new AbortController();
    state.controller = controller;
    void (async () => {
      try {
        const response = await fetch(indexUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`The recording's frame index could not be read (HTTP ${response.status}).`);
        const index = RuntimeBrowserFramesIndexSchema.safeParse(await response.json());
        if (!index.success) throw new Error('The recording\'s frame index is not valid.');
        if (!index.data.frames.length) throw new Error('This recording has no frames.');
        if (controller.signal.aborted) return;
        setFrames(index.data.frames);
        reported.current.onLength(index.data.frames.at(-1)?.t ?? 0);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The recording could not be read.'); }
    })();
    return () => {
      controller.abort();
      for (const url of state.images.values()) URL.revokeObjectURL(url);
      state.images.clear(); state.pending.clear(); state.shown = null;
    };
  }, [indexUrl]);

  // Reads the next batch once the playhead comes within `FRAMES_AHEAD` of a frame not yet read.
  useEffect(() => {
    const state = cache.current;
    const controller = state.controller;
    if (!frames || !controller) return;
    const end = Math.min(frames.length, position + FRAMES_AHEAD);
    let first = position;
    while (first < end && (state.images.has(first) || state.pending.has(first))) first += 1;
    if (first >= end) return;
    const batch: number[] = [];
    for (let index = first; index < Math.min(frames.length, first + FRAMES_AHEAD) && !state.images.has(index) && !state.pending.has(index); index += 1) batch.push(index);
    const start = Math.min(...batch.map(index => frames[index]!.offset));
    const stop = Math.max(...batch.map(index => frames[index]!.offset + frames[index]!.length));
    for (const index of batch) state.pending.add(index);
    void (async () => {
      try {
        const response = await fetch(dataUrl, { headers: { Range: `bytes=${start}-${stop - 1}` }, signal: controller.signal });
        if (response.status !== 206 && response.status !== 200) throw new Error(`The recording's frames could not be read (HTTP ${response.status}).`);
        const bytes = await response.arrayBuffer();
        // A server may answer a range with the whole file.
        const base = response.status === 206 ? start : 0;
        if (bytes.byteLength < stop - base) throw new Error('The recording\'s frames are shorter than its index.');
        if (controller.signal.aborted) return;
        for (const index of batch) {
          const frame = frames[index]!;
          state.images.set(index, URL.createObjectURL(new Blob([bytes.slice(frame.offset - base, frame.offset - base + frame.length)], { type: 'image/jpeg' })));
        }
        const keep = playhead.current;
        for (const [index, url] of state.images) {
          if ((index < keep - FRAMES_BEHIND || index >= keep + 2 * FRAMES_AHEAD) && url !== state.shown) { URL.revokeObjectURL(url); state.images.delete(index); }
        }
        setLoaded(value => value + 1);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The recording could not be read.'); }
      finally { for (const index of batch) state.pending.delete(index); }
    })();
  });

  const nextReady = frames !== null && cache.current.images.has(position + 1);
  useEffect(() => {
    if (!playing || !frames) return;
    const next = frames[position + 1];
    if (!next) { reported.current.onEnded(); return; }
    if (!nextReady) return;
    const timer = setTimeout(() => reported.current.onTime(next.t), Math.max(0, next.t - time));
    return () => clearTimeout(timer);
  }, [playing, frames, position, nextReady, time]);

  if (error) return <p role="alert" className="flex h-full items-center justify-center p-4 text-caption text-red-300">{error}</p>;
  if (!frames) return <p role="status" className="flex h-full items-center justify-center text-caption text-white/70">Loading recording…</p>;
  const image = cache.current.images.get(position) ?? cache.current.shown;
  cache.current.shown = image;
  return image ? <img className="block h-full w-full object-contain" src={image} alt={`${label} at ${formatClock(frames[position]!.t)}`} /> : <p role="status" className="flex h-full items-center justify-center text-caption text-white/70">Loading frame…</p>;
}
