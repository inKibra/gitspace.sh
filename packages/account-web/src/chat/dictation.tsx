import { DICTATION_MAX_MS, DICTATION_PATH, DICTATION_SAMPLE_RATE, RuntimeDictationServerMessageSchema, type RuntimeDictationQuery } from '@gitspace/protocol-runtime';
import { DEVICE_SOCKET_PROTOCOL } from '@gitspace/protocol/socket-auth';
import { Button } from '@gitspace/ui';
import { Microphone01, StopCircle } from '@untitledui/icons';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { signDeviceRequest } from '../device.js';
import { currentDevice } from '../device-session.js';

/**
 * Dictation in the composer: the microphone's audio, as 16 kHz mono PCM16 from an AudioWorklet, goes to the account's
 * dictation socket (`DICTATION_PATH`), which hands it to the provider the project's inference profile names. Final text
 * goes into the draft at the cursor; nothing is sent. A tab records once at a time: starting a recording ends the tab's
 * other one.
 */

type Phase = 'idle' | 'starting' | 'recording' | 'finishing';
export type DictationView = { phase: Phase; mode: 'live' | 'batch' | null; interim: string; error: string | null; notice: string | null };
type Handlers = { update(change: Partial<DictationView>): void; final(text: string): void };

const IDLE: DictationView = { phase: 'idle', mode: null, interim: '', error: null, notice: null };
const PROCESSOR = 'gitspace-pcm16';
/** Audio goes out in frames of a tenth of a second. */
const FRAME_SAMPLES = DICTATION_SAMPLE_RATE / 10;
/** How long the worklet may take to hand over its last partial frame on stop. */
const FLUSH_MS = 300;
/** A press of the mic held this long records until it is released. */
const HOLD_MS = 400;
const MIC_BLOCKED = 'Microphone access is blocked. Allow the microphone for this site in your browser, then try again.';
const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: MIC_BLOCKED,
  SecurityError: MIC_BLOCKED,
  NotFoundError: 'No microphone was found.',
  OverconstrainedError: 'No microphone was found.',
  NotReadableError: 'The microphone could not be started; another app may be using it.',
  AbortError: 'The microphone could not be started; another app may be using it.',
};
/** The worklet: the context's input, mono, averaged down to `rate` and written as PCM16 frames of `frame` samples to
 * its port; `flush` on the port sends the partial frame, then `flushed`. A posted frame's buffer is transferred, which
 * leaves that array empty, so each new frame takes its size from `size`. */
export const DICTATION_WORKLET = `class Pcm16 extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.step = sampleRate / options.processorOptions.rate;
    this.position = 0; this.sum = 0; this.count = 0; this.length = 0;
    this.size = options.processorOptions.frame;
    this.frame = new Int16Array(this.size);
    this.port.onmessage = () => {
      if (this.length) this.port.postMessage(this.frame.slice(0, this.length).buffer);
      this.length = 0;
      this.port.postMessage('flushed');
    };
  }
  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (!samples) return true;
    for (let index = 0; index < samples.length; index += 1) {
      this.sum += samples[index]; this.count += 1; this.position += 1;
      if (this.position < this.step) continue;
      this.position -= this.step;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.frame[this.length++] = value < 0 ? value * 32768 : value * 32767;
      this.sum = 0; this.count = 0;
      if (this.length === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(this.size);
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR}', Pcm16);`;

let workletUrl: string | null = null;
/** The tab's recording, if any. */
let recording: Recording | null = null;

/** Why the microphone did not open, as the person can act on it. */
function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  return Object.hasOwn(MIC_ERRORS, name) ? MIC_ERRORS[name]! : `The microphone is unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

/** The dictation socket for a workspace, signed by this browser's device in `Sec-WebSocket-Protocol`. */
async function openDictation(identity: RuntimeDictationQuery): Promise<WebSocket> {
  const device = await currentDevice();
  if (!device) throw new Error('This browser is not signed in to GitSpace');
  const path = `${DICTATION_PATH}?${new URLSearchParams(identity)}`;
  const proof = await signDeviceRequest(device, { method: 'GET', path, body: new Uint8Array() });
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url.href, [`${DEVICE_SOCKET_PROTOCOL}${proof}`]);
  socket.binaryType = 'arraybuffer';
  return socket;
}

/** One recording: the microphone, its worklet and its socket, from start until the provider's last text. */
class Recording {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private socket: WebSocket | null = null;
  private held: ArrayBuffer[] = [];
  private flushed: PromiseWithResolvers<void> | null = null;
  private ready = false;
  private stopping = false;
  private finished = false;
  private worklet: AudioWorkletNode | null = null;
  private timer: number | undefined;

  constructor(private readonly identity: RuntimeDictationQuery, private readonly handlers: Handlers) {}

  /** Called from the press itself: the audio context is made before anything is awaited, so the browser lets it run. */
  async start(): Promise<void> {
    this.handlers.update({ ...IDLE, phase: 'starting' });
    const context = this.context = new AudioContext();
    try {
      if (!navigator.mediaDevices) throw new Error('this page cannot record audio');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) { this.finish(microphoneError(error)); return; }
    if (this.finished) { this.release(); return; }
    try {
      workletUrl ??= URL.createObjectURL(new Blob([DICTATION_WORKLET], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(workletUrl);
      const node = this.worklet = new AudioWorkletNode(context, PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', processorOptions: { rate: DICTATION_SAMPLE_RATE, frame: FRAME_SAMPLES } });
      node.port.onmessage = (event: MessageEvent<unknown>) => this.audio(event.data);
      context.createMediaStreamSource(this.stream).connect(node);
      if (this.finished) { this.release(); return; }
      const socket = this.socket = await openDictation(this.identity);
      socket.addEventListener('message', event => this.message(event.data));
      socket.addEventListener('close', () => this.finish('Dictation disconnected before it finished.'));
      this.timer = window.setTimeout(() => void this.stop(), DICTATION_MAX_MS);
    } catch (error) { this.finish(`Dictation could not start: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The recording ended: the last audio goes out, then `stop`, and the provider's last text comes back. */
  async stop(): Promise<void> {
    if (this.stopping || this.finished) return;
    if (!this.ready) { this.finish(null); return; }
    this.stopping = true;
    clearTimeout(this.timer);
    this.handlers.update({ phase: 'finishing' });
    const flushed = this.flushed = Promise.withResolvers<void>();
    const late = setTimeout(flushed.resolve, FLUSH_MS);
    this.worklet?.port.postMessage('flush');
    await flushed.promise;
    clearTimeout(late);
    this.release();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
  }

  /** Ends the recording now, its text unfinished. */
  cancel(): void { this.finish(null); }

  private audio(data: unknown): void {
    if (data === 'flushed') { this.flushed?.resolve(); return; }
    if (!(data instanceof ArrayBuffer) || this.finished) return;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
    else this.held.push(data);
  }

  private message(data: unknown): void {
    if (typeof data !== 'string') return;
    const parsed = RuntimeDictationServerMessageSchema.safeParse(JSON.parse(data));
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'ready') {
      this.ready = true;
      for (const frame of this.held.splice(0)) this.socket?.send(frame);
      this.handlers.update({ phase: 'recording', mode: message.mode });
    } else if (message.type === 'interim') this.handlers.update({ interim: message.text });
    else if (message.type === 'final') { this.handlers.final(message.text); this.handlers.update({ interim: '' }); }
    else if (message.type === 'transcribing') this.handlers.update({ phase: 'finishing' });
    else if (message.type === 'limit') { this.handlers.update({ notice: 'Recordings stop at 10 minutes.' }); void this.stop(); }
    else if (message.type === 'done') this.finish(null);
    else this.finish(message.message);
  }

  private release(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.worklet?.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }

  private finish(error: string | null): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.flushed?.resolve();
    this.release();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
    if (recording === this) recording = null;
    this.handlers.update({ phase: 'idle', mode: null, interim: '', ...(error === null ? {} : { error }) });
  }
}

/** A workspace's dictation: its state, and start and stop. `onFinal` receives each finished text. */
export function useDictation(identity: RuntimeDictationQuery, onFinal: (text: string) => void) {
  const [view, setView] = useState<DictationView>(IDLE);
  const mine = useRef<Recording | null>(null);
  const final = useRef(onFinal);
  useEffect(() => { final.current = onFinal; }, [onFinal]);
  useEffect(() => () => mine.current?.cancel(), []);
  const { projectId, workspaceId } = identity;
  const start = useCallback(() => {
    recording?.cancel();
    const next = new Recording({ projectId, workspaceId }, {
      update: change => setView(current => ({ ...current, ...change })),
      final: text => final.current(text),
    });
    recording = mine.current = next;
    void next.start();
  }, [projectId, workspaceId]);
  const stop = useCallback(() => { void mine.current?.stop(); }, []);
  return { view, start, stop };
}

/** The composer's mic: click to record and click again to stop, or hold it while you speak. Beside it, what is heard
 * so far, or why dictation stopped. */
export function DictationControl({ identity, insertText, disabled }: { identity: RuntimeDictationQuery; insertText(text: string): void; disabled: boolean }) {
  const { view, start, stop } = useDictation(identity, insertText);
  // When the press that started the recording began; null while a press of a recording should stop it.
  const pressed = useRef<number | null>(null);
  const active = view.phase !== 'idle';
  const caption = view.error ?? (view.phase === 'starting' ? 'Starting the microphone…'
    : view.phase === 'recording' ? view.interim || (view.mode === 'batch' ? 'Recording… click to stop' : 'Listening…')
    : view.phase === 'finishing' ? (view.mode === 'batch' ? 'Transcribing…' : 'Finishing…')
    : view.notice);
  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    pressed.current = active ? null : Date.now();
    if (!active) start();
  };
  const up = () => {
    if (pressed.current !== null && pressed.current > 0 && Date.now() - pressed.current >= HOLD_MS) { pressed.current = 0; stop(); }
  };
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    // A keyboard press has no pointer: it toggles.
    if (event.detail === 0) { if (active) stop(); else start(); return; }
    if (pressed.current === null) stop();
    pressed.current = null;
  };
  return <>
    <Button variant="ghost" size="icon-compact" type="button" aria-label={active ? 'Stop dictation' : 'Dictate'} aria-pressed={active}
      disabled={(disabled && !active) || view.phase === 'finishing'} onPointerDown={down} onPointerUp={up} onClick={click}
      className={view.phase === 'recording' ? 'text-destructive' : undefined}>
      {active ? <StopCircle width={16} height={16} strokeWidth={1.5} /> : <Microphone01 width={16} height={16} strokeWidth={1.5} />}
    </Button>
    {caption ? <span role={view.error ? 'alert' : 'status'} title={caption}
      className={view.error ? 'min-w-0 max-w-[20rem] text-caption text-destructive' : 'min-w-0 max-w-[16rem] truncate text-caption text-muted-foreground'}>{caption}</span> : null}
  </>;
}
