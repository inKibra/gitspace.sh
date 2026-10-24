import { useEffect, useRef, useState } from 'react';
import { BROWSER_DRIVE_PREFIX, RuntimeBrowserFramesIndexSchema, type RuntimeBrowserCapture, type RuntimeBrowserCaptureView, type RuntimeBrowserFramesIndex } from '@gitspace/protocol-runtime';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, useShape } from '@gitspace/ui';

type Frames = RuntimeBrowserFramesIndex['frames'];
type CaptureFilter = 'all' | 'screenshots' | 'video';
type Media = { kind: 'video' | 'image'; url: string } | { kind: 'frames'; data: string; index: string };
/** The frames player's object URLs by frame, the frames being read, the one on screen (kept while the next loads),
 * and the reads of the current recording. */
type FrameCache = { images: Map<number, string>; pending: Set<number>; shown: string | null; controller: AbortController | null };

/** Frames a recording reads ahead of the playhead, in one byte-range request of `frames.bin`. */
export const FRAMES_AHEAD = 6;
/** Frames kept decoded behind the playhead, so a small step back shows at once. */
const FRAMES_BEHIND = 12;
/** A capture's preview image beside `capture.json` (contract: written when the capture has one). */
const THUMBNAIL_PATH = 'thumbnail.jpg';
const CAPTURE_FILTERS: Record<CaptureFilter, { label: string; keep(capture: RuntimeBrowserCapture): boolean }> = {
  all: { label: 'All', keep: () => true },
  screenshots: { label: 'Screenshots', keep: capture => capture.tracks.image !== undefined },
  video: { label: 'Video', keep: capture => capture.tracks.image === undefined },
};
const CAPTURE_FILTER_ORDER: readonly CaptureFilter[] = ['all', 'screenshots', 'video'];
const CAPTURE_BY: Record<RuntimeBrowserCapture['by'], string> = { agent: 'By agent', you: 'By you' };

/** `m:ss` of a duration in milliseconds. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** `REC m:ss` since `startedAt`, ticking every second. */
export function RecordingClock({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>REC {formatClock(now - Date.parse(startedAt))}</>;
}

/** The sealed `/files/` link of a file in the capture's folder, when the account listed one. */
function fileUrl(view: RuntimeBrowserCaptureView, path: string | undefined): string | undefined {
  return path === undefined ? undefined : view.files[path];
}

/** What the player shows: video (Chrome's recording with sound) before screencast frames before a single image. */
function playable(view: RuntimeBrowserCaptureView): Media | null {
  const { tracks } = view.capture;
  const video = fileUrl(view, tracks.video?.path);
  if (video) return { kind: 'video', url: video };
  const data = fileUrl(view, tracks.frames?.path);
  const index = fileUrl(view, tracks.frames?.index);
  if (data && index) return { kind: 'frames', data, index };
  const image = fileUrl(view, tracks.image?.path);
  if (image) return { kind: 'image', url: image };
  return null;
}

/** A row's length: a screenshot's size, a recording's duration. */
function captureLength(capture: RuntimeBrowserCapture): string | null {
  if (capture.tracks.image) return `${capture.tracks.image.width}×${capture.tracks.image.height}`;
  if (capture.tracks.video) return formatClock(capture.tracks.video.durationMs);
  if (capture.endedAt) return formatClock(Date.parse(capture.endedAt) - Date.parse(capture.startedAt));
  return null;
}

/** The Browser tab's Captures: the workspace's screenshots and recordings, newest first, each to mention in the chat
 * (its drive folder) or open in the player. `captures` is null until first read. */
export function BrowserCaptures({ captures, error }: { captures: readonly RuntimeBrowserCaptureView[] | null; error: string | null }) {
  const shape = useShape();
  const [filter, setFilter] = useState<CaptureFilter>('all');
  const [open, setOpen] = useState<RuntimeBrowserCaptureView | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const shown = (captures ?? []).filter(view => CAPTURE_FILTERS[filter].keep(view.capture)).sort((a, b) => Date.parse(b.capture.startedAt) - Date.parse(a.capture.startedAt));
  const mention = async (captureId: string) => {
    try {
      await navigator.clipboard.writeText(`drive://workspace/${BROWSER_DRIVE_PREFIX.captures}${captureId}/`);
      setCopied(captureId); setCopyError(null);
    } catch { setCopyError('Copying to the clipboard failed. Allow clipboard access and try again.'); }
  };
  return <section aria-label="Captures" className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`}>
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="min-w-0 flex-1 text-body font-medium">Captures</h4>
      <div role="group" aria-label="Show captures" className="flex gap-1">
        {CAPTURE_FILTER_ORDER.map(key => <Button key={key} variant={filter === key ? 'secondary' : 'ghost'} size="compact" aria-pressed={filter === key} onClick={() => setFilter(key)}>{CAPTURE_FILTERS[key].label}</Button>)}
      </div>
    </div>
    {error ? <p role="alert" className="text-caption text-destructive">{error}{captures ? ' Showing the last list read.' : ''}</p> : null}
    {copyError ? <p role="alert" className="text-caption text-destructive">{copyError}</p> : null}
    {captures === null && !error ? <p role="status" className="text-caption text-muted-foreground">Loading captures…</p> : null}
    {captures !== null && !shown.length ? <p className="text-caption text-muted-foreground">{captures.length ? 'No captures of this kind.' : 'No captures yet. Capture a tab here or from Chrome; screenshots agents take in scripts appear here too.'}</p> : null}
    {shown.length ? <ul className="flex flex-col gap-2">{shown.map(view => {
      const { capture } = view;
      const thumbnail = fileUrl(view, THUMBNAIL_PATH) ?? fileUrl(view, capture.tracks.image?.path);
      const length = captureLength(capture);
      return <li key={capture.captureId} aria-label={capture.name} className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-3 p-2">
        <div className="flex aspect-video w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2">
          {thumbnail ? <img className="h-full w-full object-cover object-top" src={thumbnail} alt="" loading="lazy" /> : <span className="text-caption text-muted-foreground">{capture.tracks.image ? 'Image' : 'Video'}</span>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-caption font-medium" title={capture.name}>{capture.name}</p>
          <p className="truncate text-caption text-muted-foreground">
            {CAPTURE_BY[capture.by]} · {capture.browser} · <time dateTime={capture.startedAt}>{new Date(capture.startedAt).toLocaleString()}</time>
            {capture.state === 'recording' ? null : length ? <> · <span className="tabular-nums">{length}</span></> : null}
          </p>
          {capture.state === 'recording' ? <div><Badge size="compact" color="red"><RecordingClock startedAt={capture.startedAt} /></Badge></div> : null}
          {capture.state === 'failed' ? <p className="text-caption text-destructive"><Badge size="compact" color="red">Failed</Badge> {capture.reason ?? 'The capture was not saved.'}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button variant="ghost" size="compact" aria-label={`Mention ${capture.name}`} onClick={() => void mention(capture.captureId)}>{copied === capture.captureId ? 'Copied' : 'Mention'}</Button>
          <Button variant="secondary" size="compact" aria-label={`Open ${capture.name}`} disabled={capture.state === 'recording' || playable(view) === null} onClick={() => setOpen(view)}>Open</Button>
        </div>
      </li>;
    })}</ul> : null}
    {open ? <CapturePlayer key={open.capture.captureId} view={open} onClose={() => setOpen(null)} /> : null}
  </section>;
}

/** One player for every capture: Chrome's video with sound, screencast frames with a scrub bar, or a screenshot. */
function CapturePlayer({ view, onClose }: { view: RuntimeBrowserCaptureView; onClose(): void }) {
  const shape = useShape();
  const { capture } = view;
  const media = playable(view);
  const thumbnail = fileUrl(view, THUMBNAIL_PATH);
  return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent size="lg">
      <DialogHeader>
        <DialogTitle>{capture.name}</DialogTitle>
        <DialogDescription>{CAPTURE_BY[capture.by]} · {capture.browser} · <span className="break-all">{capture.page.url}</span></DialogDescription>
      </DialogHeader>
      {media?.kind === 'video' ? <video aria-label={`Video of ${capture.name}`} className={`${shape.container} block max-h-[70vh] w-full bg-black`} controls src={media.url} poster={thumbnail} />
        : media?.kind === 'frames' ? <FramesPlayer indexUrl={media.index} dataUrl={media.data} label={capture.name} />
        : media?.kind === 'image' ? <img className={`${shape.container} block max-h-[70vh] w-full bg-black object-contain`} src={media.url} alt={capture.name} />
        : <p className="text-caption text-muted-foreground">This capture has no media to play.</p>}
    </DialogContent>
  </Dialog>;
}

/** The frame showing at `t` ms: the last one at or before it. */
function frameAt(frames: Frames, t: number): number {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].t <= t) low = middle; else high = middle - 1;
  }
  return low;
}

/** Screencast frames from `frames.bin`, read with byte ranges a few frames ahead of the playhead and shown at their
 * recorded times; only frames near the playhead are kept. */
function FramesPlayer({ indexUrl, dataUrl, label }: { indexUrl: string; dataUrl: string; label: string }) {
  const shape = useShape();
  const [frames, setFrames] = useState<Frames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [, setLoaded] = useState(0);
  const cache = useRef<FrameCache>({ images: new Map(), pending: new Set(), shown: null, controller: null });
  const playhead = useRef(0);
  playhead.current = position;

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
        if (!controller.signal.aborted) setFrames(index.data.frames);
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
    const start = Math.min(...batch.map(index => frames[index].offset));
    const stop = Math.max(...batch.map(index => frames[index].offset + frames[index].length));
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
          const frame = frames[index];
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
    if (position + 1 >= frames.length) { setPlaying(false); return; }
    if (!nextReady) return;
    const timer = setTimeout(() => setPosition(position + 1), frames[position + 1].t - frames[position].t);
    return () => clearTimeout(timer);
  }, [playing, frames, position, nextReady]);

  if (error) return <p role="alert" className="text-caption text-destructive">{error}</p>;
  if (!frames) return <p role="status" className="text-caption text-muted-foreground">Loading recording…</p>;
  const image = cache.current.images.get(position) ?? cache.current.shown;
  cache.current.shown = image;
  const duration = frames[frames.length - 1].t;
  return <div className="flex flex-col gap-2">
    <div className={`${shape.container} flex aspect-video items-center justify-center overflow-hidden bg-black`}>
      {image ? <img className="h-full w-full object-contain" src={image} alt={`${label} at ${formatClock(frames[position].t)}`} /> : <p role="status" className="text-caption text-white/70">Loading frame…</p>}
    </div>
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="compact" onClick={() => { if (!playing && position + 1 >= frames.length) setPosition(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</Button>
      <input aria-label="Seek" className="min-w-0 flex-1" type="range" min={0} max={duration} step={1} value={frames[position].t} onChange={event => setPosition(frameAt(frames, Number(event.currentTarget.value)))} />
      <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{formatClock(frames[position].t)} / {formatClock(duration)}</span>
    </div>
  </div>;
}
