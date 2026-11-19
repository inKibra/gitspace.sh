// Image and Video blocks: a picture or a clip from the drive (drive://…), resolved to a signed file URL through the
// surface's ResourceFiles as files in a message are, or from a browser capture (capture:<id>), read from the
// workspace's captures as the capture player reads them. A video plays inline with its controls, only between `start`
// and `end` when they are set, and opens full-screen with its comment panel, where a new comment goes on the moment
// showing; inside a playing Sequence frame it plays along, muted.
import type { RuntimeBrowserCaptureView } from '@gitspace/protocol-runtime';
import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { Button, Dialog, DialogContent, DialogTitle, useShape } from '@gitspace/ui';
import { Maximize01, PauseCircle, PlayCircle } from '@untitledui/icons';
import { useContext, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { CAPTURE_THUMBNAIL, FramesPlayer, captureMedia, formatClock } from '../capture/CapturePlayer.js';
import { QuestionCardsContext, type QuestionCards } from '../QuestionCards.js';
import { useResourceFile } from '../resource-files.js';
import { TranscriptImage } from '../resource-media.js';
import { SequenceFrame } from './BlockDocument.js';
import { LightboxComments, LightboxPlaceReport, type LightboxPlace } from '../comments/LightboxComments.js';

type ImageProps = z.output<typeof gitspaceUiCatalog.components.Image.props>;
type VideoProps = z.output<typeof gitspaceUiCatalog.components.Video.props>;
/** What a source shows: a file URL to play or show, or a capture's screencast frames. */
type Media = { kind: 'video' | 'image'; url: string } | { kind: 'frames'; data: string; index: string; lengthMs: number };

const CAPTURE_PREFIX = 'capture:';
/** The workspace's captures are read again for each block that shows one: a capture gains files as it records, and a
 * new one may have started since the last read. Blocks that ask while a read is out share it; a file that has not
 * changed keeps its link, so the browser shows its bytes from its cache. */
const captureLists = new WeakMap<QuestionCards['request'], Promise<readonly RuntimeBrowserCaptureView[]>>();

function workspaceCaptures(request: QuestionCards['request']): Promise<readonly RuntimeBrowserCaptureView[]> {
  const known = captureLists.get(request);
  if (known) return known;
  const read = request({ type: 'browserCaptures' }).then((result) => {
    if (!result.browserCaptures) throw new Error('the workspace did not return its captures');
    return result.browserCaptures;
  });
  captureLists.set(request, read);
  const forget = () => { if (captureLists.get(request) === read) captureLists.delete(request); };
  read.then(forget, forget);
  return read;
}

/** What a capture shows as a still: its image, else its thumbnail. */
function captureStill(view: RuntimeBrowserCaptureView): Media | null {
  const media = captureMedia(view.capture, view.files);
  if (media?.kind === 'image') return media;
  const thumbnail = view.files[CAPTURE_THUMBNAIL];
  return thumbnail ? { kind: 'image', url: thumbnail } : null;
}

/** The media a source names: a drive file by its URL and type, or a capture's recording or still. */
function useMedia(src: string, still: boolean, enabled = true): { media: Media | null; error: string | null } {
  const capture = src.startsWith(CAPTURE_PREFIX) ? src.slice(CAPTURE_PREFIX.length) : null;
  const drive = useResourceFile(src, enabled && capture === null);
  const cards = useContext(QuestionCardsContext);
  const [captured, setCaptured] = useState<{ src: string; media: Media | null; error: string | null } | null>(null);
  useEffect(() => {
    if (capture === null || !cards || !enabled) return;
    let current = true;
    workspaceCaptures(cards.request).then(
      (views) => {
        const view = views.find((candidate) => candidate.capture.captureId === capture);
        if (!current) return;
        if (!view) { setCaptured({ src, media: null, error: 'no such capture in this workspace' }); return; }
        const recorded = captureMedia(view.capture, view.files);
        const media: Media | null = still ? captureStill(view)
          : recorded?.kind === 'frames' ? { ...recorded, lengthMs: view.capture.tracks.video?.durationMs ?? (view.capture.endedAt ? Date.parse(view.capture.endedAt) - Date.parse(view.capture.startedAt) : 0) }
          : recorded;
        setCaptured({ src, media, error: media ? null : 'the capture has nothing to show' });
      },
      (error: unknown) => { if (current) setCaptured({ src, media: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
  }, [capture, cards, enabled, src, still]);
  if (capture !== null) {
    if (!cards) return { media: null, error: 'captures are not available here' };
    return captured?.src === src ? { media: captured.media, error: captured.error } : { media: null, error: null };
  }
  if (drive.unavailable) return { media: null, error: 'files are not available here' };
  if (!drive.file) return { media: null, error: drive.error };
  return { media: { kind: drive.file.mediaType?.startsWith('image/') ? 'image' : 'video', url: drive.file.url }, error: null };
}

/** While the media is read, or why it could not be. */
function MediaPending({ label, error }: { label: string; error: string | null }) {
  if (error !== null) return <span role="alert" className="text-caption text-destructive">{label}: {error}</span>;
  return <span aria-busy="true" aria-label={`Loading ${label}`} className="block h-40 w-64 max-w-full animate-pulse rounded-md bg-surface-2" />;
}

export function ImageView({ src, alt, caption }: ImageProps) {
  const { media, error } = useMedia(src, true);
  // An SVG without width and height has no size of its own and would shrink to nothing in the thumbnail's fit-content
  // frame; a minimum width lets its aspect ratio set the height.
  return <figure className="flex flex-col gap-1.5 [&_img]:min-w-64">
    {media && media.kind !== 'frames' ? <TranscriptImage alt={alt} label={`Open ${alt}`} src={media.url} /> : <MediaPending label={alt} error={error} />}
    {caption ? <figcaption className="text-caption text-muted-foreground">{caption}</figcaption> : null}
  </figure>;
}

/** A media fragment that plays only between start and end. */
function clipUrl(url: string, start: number | null | undefined, end: number | null | undefined): string {
  if (start == null && end == null) return url;
  return `${url}#t=${start ?? 0}${end == null ? '' : `,${end}`}`;
}

/** A video's moment as a lightbox comment place: "0:42". */
function momentOf(seconds: number): LightboxPlace {
  const whole = Math.floor(seconds);
  return { at: { kind: 'time', seconds: whole }, label: `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`, quote: null };
}

export function VideoView({ src, alt, caption, poster, start, end }: VideoProps) {
  const shape = useShape();
  const video = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const { media, error } = useMedia(src, false);
  const still = useMedia(poster ?? '', true, Boolean(poster));
  const posterUrl = still.media && still.media.kind !== 'frames' ? still.media.url : undefined;
  const frame = useContext(SequenceFrame);
  const playing = frame?.playing ?? null;
  const url = media && media.kind !== 'frames' ? clipUrl(media.url, start, end) : null;
  // Drawn again in a block's lightbox, the clip tells the comment panel which moment is showing; inside a Sequence the
  // frame is the place.
  const lightboxReport = useContext(LightboxPlaceReport);
  const report = frame ? null : lightboxReport;
  // In a Sequence, the clip plays while its frame plays; the voice line carries the sound.
  useEffect(() => {
    const element = video.current;
    if (!element || playing === null) return;
    if (!playing) {
      element.pause();
      return;
    }
    element.muted = true;
    element.currentTime = start ?? 0;
    element.play().catch(() => undefined);
  }, [playing, url, start]);
  return <figure className="flex flex-col gap-1.5">
    {media?.kind === 'frames' ? <CaptureFrames label={alt} data={media.data} index={media.index} lengthMs={media.lengthMs} startMs={(start ?? 0) * 1000} endMs={end == null ? null : end * 1000} playing={playing} />
      : url ? <div className="group/video relative w-fit max-w-full">
        <video ref={video} aria-label={alt} controls playsInline preload="metadata" poster={posterUrl} src={url}
          onLoadedMetadata={report ? (event) => report(momentOf(event.currentTarget.currentTime)) : undefined} onTimeUpdate={report ? (event) => report(momentOf(event.currentTarget.currentTime)) : undefined}
          className={`${shape.container} block max-h-80 min-w-64 max-w-full bg-black shadow-surface-1`} />
        <Button variant="secondary" size="icon-compact" type="button" aria-label={`Open ${alt} full-screen`} aria-haspopup="dialog" onClick={() => { video.current?.pause(); setOpen(true); }}
          className="absolute left-2 top-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/video:opacity-100 [@media(hover:none)]:opacity-100"><Maximize01 width={14} height={14} /></Button>
      </div> : <MediaPending label={alt} error={error} />}
    {caption ? <figcaption className="text-caption text-muted-foreground">{caption}</figcaption> : null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg" className="flex max-h-[calc(100dvh-2rem)] !max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden bg-surface-1 p-4">
        <DialogTitle className="self-start pr-10">{alt}</DialogTitle>
        {url ? <LightboxComments><LightboxVideo alt={alt} url={url} poster={posterUrl} /></LightboxComments> : null}
      </DialogContent>
    </Dialog>
  </figure>;
}

/** The full-screen copy of a video, telling the comment panel which moment is showing. */
function LightboxVideo({ alt, url, poster }: { alt: string; url: string; poster: string | undefined }) {
  const shape = useShape();
  const report = useContext(LightboxPlaceReport);
  return <video aria-label={alt} autoPlay controls playsInline poster={poster} src={url} className={`${shape.container} mx-auto block max-h-[calc(100dvh-7rem)] max-w-full bg-black`}
    onLoadedMetadata={(event) => report?.(momentOf(event.currentTarget.currentTime))} onTimeUpdate={(event) => report?.(momentOf(event.currentTarget.currentTime))} />;
}

/** A capture recorded as screencast frames, played by the capture player's frames reader between start and end. */
function CaptureFrames({ label, data, index, lengthMs, startMs, endMs, playing: framePlaying }: { label: string; data: string; index: string; lengthMs: number; startMs: number; endMs: number | null; playing: boolean | null }) {
  const shape = useShape();
  const [time, setTime] = useState(startMs);
  const [own, setOwn] = useState(false);
  const [length, setLength] = useState(lengthMs);
  const stop = Math.min(endMs ?? Number.POSITIVE_INFINITY, Math.max(length, lengthMs));
  const playing = framePlaying ?? own;
  useEffect(() => {
    if (framePlaying) setTime(startMs);
  }, [framePlaying, startMs]);
  return <div className={`${shape.container} flex w-full max-w-xl flex-col overflow-hidden bg-black shadow-surface-1`}>
    <div className="aspect-video">
      <FramesPlayer indexUrl={index} dataUrl={data} label={label} time={time} length={stop} playing={playing}
        onTime={setTime} onLength={(ms) => setLength((known) => Math.max(known, ms))} onEnded={() => setOwn(false)} />
    </div>
    {framePlaying === null ? <div className="flex items-center gap-2 px-2 py-1 text-caption text-white/80">
      <button type="button" aria-label={own ? `Pause ${label}` : `Play ${label}`} className="rounded p-0.5 hover:text-white" onClick={() => {
        if (!own && time >= stop) setTime(startMs);
        setOwn(!own);
      }}>{own ? <PauseCircle width={16} height={16} /> : <PlayCircle width={16} height={16} />}</button>
      <span className="tabular-nums">{formatClock(time - startMs)} / {formatClock(stop - startMs)}</span>
    </div> : null}
  </div>;
}
