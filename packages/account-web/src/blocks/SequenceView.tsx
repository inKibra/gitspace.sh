// A Sequence block: a narrated walkthrough played like a short video. Frame 1 shows as a still with a play button and
// never plays by itself. Play speaks each frame's `say` line in the person's Speech voice (SpeechContext), shows it as
// the subtitle, and moves on when the line ends and the frame's `hold` has passed. Without a voice (no Speech, Speech
// off, muted, no line, or a clip that failed) a frame lasts its `hold`, else 4 s. A frame whose content fails the
// checks shows the error card in its place and the rest still plays.
import { validateFrameContent, type gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { Button, Dialog, DialogContent, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, badgeColors, useShape } from '@gitspace/ui';
import { Renderer } from '@json-render/react';
import { ChevronLeft, ChevronRight, Maximize01, PauseCircle, Play, PlayCircle, VolumeMax, VolumeX } from '@untitledui/icons';
import { useContext, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { z } from 'zod';
import { SpeechContext } from '../speech.js';
import { BlockRendering, SequenceFrame, conforms } from './BlockDocument.js';
import { BlockErrorCard } from './BlockFrames.js';
import { ItemComment, commentItem } from '../comments/CommentLayer.js';
import { LightboxComments, LightboxPlaceReport } from '../comments/LightboxComments.js';

type SequenceProps = z.output<typeof gitspaceUiCatalog.components.Sequence.props>;
type Frame = SequenceProps['frames'][number];

/** Seconds a frame without a voice shows when it has no `hold`. */
const SILENT_FRAME_S = 4;
const FRAME_GAP_MS = 450;
const SPEEDS = ['0.75×', '1×', '1.25×', '1.5×'];
/** Starting one player pauses the others, so two never speak at once. */
const PLAY_EVENT = 'gitspace-sequence-play';
const FRAME_KEY = 'gitspace:sequence-frame';

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** One frame's content: an element drawn with the block's registry and state, or a block of the document by ref. */
function FrameContent({ content }: { content: Frame['content'] }) {
  const rendering = useContext(BlockRendering);
  const issues = useMemo(() => rendering ? validateFrameContent(content, rendering.spec.elements, rendering.spec.state ?? {}) : [], [content, rendering]);
  if (!rendering) return null;
  if (issues.length > 0) return <BlockErrorCard issues={issues} source={JSON.stringify(content, null, 2)} sourceLabel="JSON" />;
  if (typeof content.ref === 'string') return rendering.drawRef(content.ref);
  const spec = { ...rendering.spec, root: FRAME_KEY, elements: { ...rendering.spec.elements, [FRAME_KEY]: content } };
  return conforms(spec, issues) ? <Renderer spec={spec} registry={rendering.registry} /> : null;
}

export function SequenceView(props: SequenceProps) {
  const [expanded, setExpanded] = useState<{ index: number; playing: boolean } | null>(null);
  return <>
    <SequencePlayer {...props} large={false} startAt={0} autoPlay={false} onExpand={(index, playing) => setExpanded({ index, playing })} />
    <Dialog open={expanded !== null} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
      <DialogContent size="lg" className="flex h-[calc(100dvh-2rem)] !max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden p-4">
        <DialogTitle className="pr-10">{props.title}</DialogTitle>
        <LightboxComments><div className="min-h-0 flex-1 overflow-auto">{expanded ? <SequencePlayer {...props} large startAt={expanded.index} autoPlay={expanded.playing} /> : null}</div></LightboxComments>
      </DialogContent>
    </Dialog>
  </>;
}

function SequencePlayer({ title, frames, large, startAt, autoPlay, onExpand }: SequenceProps & { large: boolean; startAt: number; autoPlay: boolean; onExpand?: (index: number, playing: boolean) => void }) {
  const shape = useShape();
  const player = useId();
  const speech = useContext(SpeechContext);
  const [index, setIndex] = useState(startAt);
  const [playing, setPlaying] = useState(autoPlay);
  const [started, setStarted] = useState(autoPlay || startAt > 0);
  const [speed, setSpeed] = useState('1×');
  const [muted, setMuted] = useState(false);
  const [mode, setMode] = useState<'speech' | 'timing' | null>(null);
  const voiced = speech?.voice != null && !muted;
  const rate = Number.parseFloat(speed);
  const frame = frames[index];
  // In a lightbox, a new comment goes on the frame showing.
  const report = useContext(LightboxPlaceReport);
  useEffect(() => { report?.({ at: { kind: 'frame', index }, label: `Frame ${index + 1}`, quote: frame?.caption ?? frame?.say ?? null }); }, [report, index, frame]);

  // Another player started: this one pauses.
  useEffect(() => {
    const paused = (event: Event): void => { if (event instanceof CustomEvent && event.detail !== player) setPlaying(false); };
    window.addEventListener(PLAY_EVENT, paused);
    return () => window.removeEventListener(PLAY_EVENT, paused);
  }, [player]);
  useEffect(() => {
    if (playing) window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: player }));
  }, [playing, player]);

  // One frame of playback: speak its line (or wait its silent time) and its hold, then move on.
  useEffect(() => {
    if (!playing || !frame) return;
    const controller = new AbortController();
    const timers: number[] = [];
    const after = (ms: number, run: () => void): void => { timers.push(window.setTimeout(run, ms / rate)); };
    let audio: HTMLAudioElement | null = null;
    let spoken = false;
    let held = false;
    let finished = false;
    let fellBack = false;
    const settle = (): void => {
      if (finished || !spoken || !held) return;
      finished = true;
      after(FRAME_GAP_MS, () => {
        if (index + 1 < frames.length) setIndex(index + 1);
        else setPlaying(false);
      });
    };
    const silent = (): void => {
      if (controller.signal.aborted || fellBack) return;
      fellBack = true;
      setMode('timing');
      held = true;
      after((frame.hold ?? SILENT_FRAME_S) * 1000, () => { spoken = true; settle(); });
    };
    const line = frame.say ?? null;
    if (!voiced || !speech || !line) silent();
    else {
      after((frame.hold ?? 0) * 1000, () => { held = true; settle(); });
      void speech.clip(line, controller.signal).then((clip) => {
        if (controller.signal.aborted) return;
        if (!clip) { silent(); return; }
        const sound = new Audio(clip.url);
        audio = sound;
        sound.playbackRate = rate;
        sound.onended = () => { spoken = true; settle(); };
        sound.onerror = () => silent();
        setMode('speech');
        sound.play().catch(() => { if (!controller.signal.aborted) silent(); });
      }, () => silent());
    }
    return () => {
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
      }
    };
  }, [playing, index, frame, frames.length, rate, voiced, speech]);

  const total = frames.reduce((sum, item) => sum + (item.hold ?? SILENT_FRAME_S) * 1000 + FRAME_GAP_MS, 0);
  const go = (next: number): void => {
    setStarted(true);
    setIndex(Math.min(frames.length - 1, Math.max(0, next)));
  };
  const toggle = (): void => {
    setStarted(true);
    if (playing) { setPlaying(false); return; }
    if (index + 1 >= frames.length && started) setIndex(0);
    setPlaying(true);
  };
  const keys = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target) || target.closest('input, textarea, select, [contenteditable="true"], [role="slider"], [role="listbox"], [role="option"], [role="combobox"]')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
    else if (event.key === ' ') { event.preventDefault(); toggle(); }
  };
  const caption = frame?.caption ?? frame?.say ?? '';

  return <figure tabIndex={0} onKeyDown={keys} aria-label={`${title}, a walkthrough of ${frames.length} frames`} aria-roledescription="walkthrough"
    data-sequence-frame={index} data-sequence-playing={playing ? 'true' : 'false'} data-sequence-voice={mode ?? 'none'}
    className="flex flex-col gap-3 rounded-lg bg-surface-1 p-3 shadow-surface-1 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]">
    <figcaption className="flex items-baseline justify-between gap-2 pr-9">
      <span className="text-caption font-medium text-foreground">{title}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{frames.length} frames · about {clock(total)}</span>
    </figcaption>
    <div className={`relative overflow-auto bg-background p-3 shadow-[inset_0_0_0_1px_var(--border)] ${shape.container} ${large ? 'min-h-[50dvh]' : 'max-h-[28rem] min-h-[16rem]'}`}>
      <SequenceFrame.Provider value={{ playing }}>
        {frame ? <div key={index} className={started ? '' : 'pointer-events-none opacity-60'} aria-hidden={started ? undefined : true}><FrameContent content={frame.content} /></div> : null}
      </SequenceFrame.Provider>
      {started ? null : <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/55">
        <button type="button" aria-label={`Play ${title}`} onClick={toggle}
          className="flex size-16 items-center justify-center rounded-full text-white shadow-md transition-transform hover:scale-105 active:scale-95"
          style={{ background: badgeColors.blue }}><Play width={28} height={28} className="translate-x-0.5" /></button>
        <span className="rounded-md bg-background/90 px-2 py-0.5 text-caption text-muted-foreground">Play · {frames.length} frames · {voiced ? 'with voice' : 'captions only'}</span>
      </div>}
    </div>
    <p aria-live="polite" data-sequence-caption="" className="group/item min-h-10 text-center text-body leading-snug" {...commentItem(`frames/${index}`, `frame ${index + 1}`)}>
      <span className={started ? 'text-foreground' : 'text-muted-foreground'}>{caption}</span>
      {' '}<ItemComment path={`frames/${index}`} label={`frame ${index + 1}`} quote={caption || null} />
    </p>
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" aria-label="Previous frame" className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft width={14} height={14} /></button>
      <button type="button" aria-label={playing ? 'Pause' : 'Play'} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-caption shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-2" onClick={toggle}>
        {playing ? <PauseCircle width={14} height={14} /> : <PlayCircle width={14} height={14} />}{playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" aria-label="Next frame" className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={index + 1 >= frames.length} onClick={() => go(index + 1)}><ChevronRight width={14} height={14} /></button>
      <span className="mx-1 text-[11px] tabular-nums text-muted-foreground">{index + 1} / {frames.length}</span>
      <span className="ml-auto flex items-center gap-1">
        <Select size="compact" value={speed} onValueChange={(value) => setSpeed(value)}>
          <SelectTrigger variant="borderless" aria-label="Speed" className="w-20 min-w-0" />
          <SelectContent>{SPEEDS.map((value, position) => <SelectItem key={value} value={value} index={position}>{value}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="ghost" size="icon-compact" type="button" disabled={speech?.voice == null} aria-label={speech?.voice == null ? 'No voice: captions only' : muted ? 'Unmute: speak the lines' : 'Mute: captions only'} aria-pressed={muted}
          onClick={() => setMuted(!muted)}>
          {voiced ? <VolumeMax width={14} height={14} /> : <VolumeX width={14} height={14} />}
        </Button>
        {speech?.voice ? <Select size="compact" value={speech.voice.id} onValueChange={(value) => { if (value && value !== speech.voice?.id) speech.setBrowserVoice(value); }}>
          <SelectTrigger variant="borderless" aria-label="Voice in this browser" className="w-28 min-w-0" />
          <SelectContent>{speech.voices.map((voice, position) => <SelectItem key={voice.id} value={voice.id} index={position}>{voice.label}</SelectItem>)}</SelectContent>
        </Select> : null}
        {onExpand ? <Button variant="ghost" size="icon-compact" type="button" aria-label={`Open ${title} full-screen`} aria-haspopup="dialog" onClick={() => { const wasPlaying = playing; setPlaying(false); onExpand(index, wasPlaying); }}><Maximize01 width={14} height={14} /></Button> : null}
      </span>
    </div>
    <ol aria-label="Frames" className="flex gap-1.5 overflow-x-auto pb-1">
      {frames.map((item, position) => {
        const kind = typeof item.content.ref === 'string' ? item.content.ref : typeof item.content.type === 'string' ? item.content.type : 'Frame';
        const current = position === index;
        return <li key={position} className="shrink-0">
          <button type="button" aria-current={current ? 'step' : undefined} aria-label={`Frame ${position + 1}: ${item.caption ?? item.say ?? kind}`} onClick={() => go(position)}
            className={`flex w-32 flex-col gap-0.5 border px-2 py-1.5 text-left transition-colors ${shape.item} ${current ? 'border-transparent text-white' : position < index ? 'border-border bg-surface-2 text-foreground' : 'border-border text-muted-foreground hover:bg-surface-2'}`}
            style={current ? { background: badgeColors.blue } : undefined}>
            <span className="flex items-center gap-1 font-mono text-[10.5px] opacity-80"><span className="tabular-nums">{position + 1}</span>·<span className="truncate">{kind}</span></span>
            <span className="line-clamp-2 text-[11.5px] leading-snug">{item.caption ?? item.say ?? ''}</span>
          </button>
        </li>;
      })}
    </ol>
  </figure>;
}
