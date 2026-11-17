// A Sequence block: a narrated walkthrough played like a short video. Frame 1 shows as a still with a play button and
// never plays by itself. Play speaks each frame's `say` line in the person's Speech voice (SpeechContext), shows it as
// the subtitle, and moves on when the line ends and the frame's `hold` has passed; the clips of the next frames are made
// while a frame plays. Without a voice (no Speech, Speech off, muted, no line) a frame lasts its `hold`, else its
// line's reading time. A frame whose clip fails, is refused by the browser or is not playing within CLIP_WAIT_MS shows
// its line on that reading time too, with a note that the voice is off for the frame. A bar under the stage shows how
// far the frame has played. A frame whose content fails the checks shows the error card in its place and the rest
// still plays.
import { validateFrameContent, type gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { Button, Dialog, DialogContent, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, badgeColors, useShape } from '@gitspace/ui';
import { Renderer } from '@json-render/react';
import { ChevronLeft, ChevronRight, Maximize01, PauseCircle, Play, PlayCircle, VolumeMax, VolumeX } from '@untitledui/icons';
import { useContext, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { z } from 'zod';
import { SpeechContext } from '../speech.js';
import { BlockRendering, DocumentRefs, SequenceFrame, SequenceStart, conforms } from './BlockDocument.js';
import { BlockErrorCard } from './BlockFrames.js';
import { ItemComment, commentItem } from '../comments/CommentLayer.js';
import { LightboxComments, LightboxPlaceReport } from '../comments/LightboxComments.js';

type SequenceProps = z.output<typeof gitspaceUiCatalog.components.Sequence.props>;
type Frame = SequenceProps['frames'][number];
/** Why a frame with a line plays without its voice. */
type VoiceOff = 'failed' | 'refused' | 'slow';
/** Where the frame showing is in its playback: waiting for its clip, speaking it, or showing its line on timing. `at`
 * is when the phase began, so a replayed frame starts its progress bar again. */
type Phase = { kind: 'waiting'; at: number } | { kind: 'speaking'; ms: number; at: number } | { kind: 'timing'; ms: number; off: VoiceOff | null; at: number };

/** Seconds a frame without a voice shows at least when it has no `hold`. */
const SILENT_FRAME_S = 4;
/** Reading a line takes about this long a word, plus a second to take in the frame. */
const READING_MS_PER_WORD = 300;
const FRAME_GAP_MS = 450;
/** How long a frame waits for its clip to start playing before it shows its line on timing. */
const CLIP_WAIT_MS = 10_000;
/** Past a clip's length, how long a frame waits for its end before moving on without it. */
const CLIP_SLACK_MS = 2_000;
/** The least a frame whose voice failed still shows after it failed. */
const FALLBACK_MIN_MS = 1_500;
/** How many frames ahead the clips are made: a new clip takes about as long to make as three short frames take to play. */
const PREFETCH_FRAMES = 3;
const SPEEDS = ['0.75×', '1×', '1.25×', '1.5×'];
/** Starting one player pauses the others, so two never speak at once. */
const PLAY_EVENT = 'gitspace-sequence-play';
const FRAME_KEY = 'gitspace:sequence-frame';
const VOICE_OFF: Record<VoiceOff, string> = { failed: 'the clip did not load', refused: 'the browser blocked sound', slow: 'the clip was not ready in time' };

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** How long a frame shows without its voice, at 1×: its `hold`, else the time its line takes to read. */
function readingMs(frame: Frame): number {
  if (frame.hold != null) return frame.hold * 1000;
  const words = (frame.say ?? frame.caption ?? '').split(/\s+/u).filter(Boolean).length;
  return Math.max(SILENT_FRAME_S * 1000, words * READING_MS_PER_WORD + 1000);
}

/** One frame's content: an element drawn with the block's registry and state, a block of the document by ref, or a part
 * of the document its DocumentRefs draws (a Change Guide's section, diagram or exhibit). */
function FrameContent({ content }: { content: Frame['content'] }) {
  const rendering = useContext(BlockRendering);
  const documentRefs = useContext(DocumentRefs);
  const part = typeof content.ref === 'string' ? documentRefs?.(content.ref) ?? null : null;
  const ownRef = part !== null;
  const issues = useMemo(() => rendering && !ownRef ? validateFrameContent(content, rendering.spec.elements, rendering.spec.state ?? {}) : [], [content, rendering, ownRef]);
  if (part !== null) return <>{part}</>;
  if (!rendering) return null;
  if (issues.length > 0) return <BlockErrorCard issues={issues} source={JSON.stringify(content, null, 2)} sourceLabel="JSON" />;
  if (typeof content.ref === 'string') return rendering.drawRef(content.ref);
  const spec = { ...rendering.spec, root: FRAME_KEY, elements: { ...rendering.spec.elements, [FRAME_KEY]: content } };
  return conforms(spec, issues) ? <Renderer spec={spec} registry={rendering.registry} /> : null;
}

export function SequenceView(props: SequenceProps) {
  const start = useContext(SequenceStart);
  const [expanded, setExpanded] = useState<{ index: number; playing: boolean } | null>(start ? { index: 0, playing: true } : null);
  return <>
    {start ? null : <SequencePlayer {...props} large={false} startAt={0} autoPlay={false} onExpand={(index, playing) => setExpanded({ index, playing })} />}
    <Dialog open={expanded !== null} onOpenChange={(open) => { if (!open) { setExpanded(null); start?.onClose(); } }}>
      <DialogContent size="lg" className="flex h-[calc(100dvh-2rem)] !max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden p-4">
        <DialogTitle className="pr-10">{props.title}</DialogTitle>
        {/* The player takes the dialog's height; its stage takes what the controls leave. */}
        <LightboxComments><div className="flex min-h-0 flex-1 flex-col overflow-auto">{expanded ? <SequencePlayer {...props} large startAt={expanded.index} autoPlay={expanded.playing} /> : null}</div></LightboxComments>
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
  const [phase, setPhase] = useState<Phase | null>(null);
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

  // One frame of playback: speak its line (or show it its reading time) and its hold, then move on. Every path ends in a
  // timer, so a playing frame always moves on.
  useEffect(() => {
    if (!playing || !frame) return;
    const controller = new AbortController();
    const timers: number[] = [];
    const after = (ms: number, run: () => void): void => { timers.push(window.setTimeout(run, ms)); };
    const startedAt = Date.now();
    const holdMs = (frame.hold ?? 0) * 1000 / rate;
    let audio: HTMLAudioElement | null = null;
    let speaking = false;
    let finished = false;
    const finish = (ms: number): void => {
      if (finished || controller.signal.aborted) return;
      finished = true;
      after(Math.max(0, ms) + FRAME_GAP_MS / rate, () => {
        if (index + 1 < frames.length) setIndex(index + 1);
        else setPlaying(false);
      });
    };
    const silence = (): void => {
      if (!audio) return;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    };
    // The line on timing: its reading time, or once its voice failed, what is left of that time and at least
    // FALLBACK_MIN_MS.
    const timing = (off: VoiceOff | null): void => {
      if (finished || controller.signal.aborted) return;
      silence();
      const ms = off ? Math.max(readingMs(frame) / rate - (Date.now() - startedAt), FALLBACK_MIN_MS) : readingMs(frame) / rate;
      setPhase({ kind: 'timing', ms, off, at: Date.now() });
      finish(ms);
    };
    const line = frame.say ?? null;
    if (!voiced || !speech || !line) timing(null);
    else {
      setPhase({ kind: 'waiting', at: startedAt });
      after(CLIP_WAIT_MS, () => { if (!speaking) timing('slow'); });
      void speech.clip(line, controller.signal).then((clip) => {
        if (finished || controller.signal.aborted) return;
        if (!clip) { timing('failed'); return; }
        const sound = new Audio(clip.url);
        audio = sound;
        sound.playbackRate = rate;
        sound.onerror = () => timing('failed');
        sound.onended = () => finish(holdMs - (Date.now() - startedAt));
        sound.play().then(() => {
          if (finished || controller.signal.aborted) return;
          speaking = true;
          const ms = (Number.isFinite(sound.duration) && sound.duration > 0 ? sound.duration * 1000 : clip.durationMs) / rate;
          setPhase({ kind: 'speaking', ms, at: Date.now() });
          // A clip whose end never comes moves on all the same.
          after(ms + CLIP_SLACK_MS, () => finish(holdMs - (Date.now() - startedAt)));
        }, (error: unknown) => timing(error instanceof DOMException && error.name === 'NotAllowedError' ? 'refused' : 'failed'));
      }, () => timing('failed'));
      // The next frames' clips are made while this one plays; one that fails here is asked for again by its frame.
      for (const ahead of frames.slice(index + 1, index + 1 + PREFETCH_FRAMES)) if (ahead.say) void speech.clip(ahead.say, controller.signal).catch(() => null);
    }
    return () => {
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
      silence();
    };
  }, [playing, index, frame, frames, rate, voiced, speech]);

  const total = frames.reduce((sum, item) => sum + readingMs(item) + FRAME_GAP_MS, 0);
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
    data-sequence-frame={index} data-sequence-playing={playing ? 'true' : 'false'} data-sequence-voice={phase ? { waiting: 'waiting', speaking: 'speech', timing: 'timing' }[phase.kind] : 'none'}
    className={`flex flex-col gap-3 rounded-lg bg-surface-1 p-3 shadow-surface-1 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${large ? 'min-h-0 flex-1' : ''}`}>
    <figcaption className="flex items-baseline justify-between gap-2 pr-9">
      <span className="text-caption font-medium text-foreground">{title}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{frames.length} frames · about {clock(total)}</span>
    </figcaption>
    <div className={`flex flex-col gap-1 ${large ? 'min-h-0 flex-1' : ''}`}>
      <div className={`relative overflow-auto bg-background shadow-[inset_0_0_0_1px_var(--border)] ${shape.container} ${large ? 'min-h-48 flex-1 p-6' : 'max-h-[28rem] min-h-[16rem] p-3'}`}>
        <SequenceFrame.Provider value={{ playing }}>
          {/* In the full-screen player the frame stands in the middle of the stage, or from its top once taller. */}
          {frame ? <div key={index} className={`${large ? 'flex min-h-full flex-col justify-center' : ''} ${started ? '' : 'pointer-events-none opacity-60'}`} aria-hidden={started ? undefined : true}><FrameContent content={frame.content} /></div> : null}
        </SequenceFrame.Provider>
        {started ? null : <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/55">
          <button type="button" aria-label={`Play ${title}`} onClick={toggle}
            className="flex size-16 items-center justify-center rounded-full text-white shadow-md transition-transform hover:scale-105 active:scale-95"
            style={{ background: badgeColors.blue }}><Play width={28} height={28} className="translate-x-0.5" /></button>
          <span className="rounded-md bg-background/90 px-2 py-0.5 text-caption text-muted-foreground">Play · {frames.length} frames · {voiced ? 'with voice' : 'captions only'}</span>
        </div>}
      </div>
      <div aria-hidden className="h-0.5 overflow-hidden rounded-full bg-border/50">
        {playing && phase && phase.kind !== 'waiting' ? <div key={phase.at} data-sequence-progress="" className="sequence-progress h-full" style={{ animationDuration: `${Math.round(phase.ms)}ms`, background: badgeColors.blue }} /> : null}
      </div>
    </div>
    <p aria-live="polite" data-sequence-caption="" className={`group/item min-h-10 text-center leading-snug ${large ? 'mx-auto max-w-4xl text-[17px]' : 'text-body'}`} {...commentItem(`frames/${index}`, `frame ${index + 1}`)}>
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
      {playing && phase?.kind === 'waiting' ? <span data-sequence-voice-note="waiting" className="text-[11px] text-muted-foreground">Preparing the voice…</span> : null}
      {phase?.kind === 'timing' && phase.off ? <span data-sequence-voice-off={phase.off} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <VolumeX width={12} height={12} />Voice off for this frame: {VOICE_OFF[phase.off]}
      </span> : null}
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
