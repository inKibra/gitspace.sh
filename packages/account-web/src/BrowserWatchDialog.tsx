import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { BROWSER_WATCH_PATH, RuntimeBrowserWatchServerMessageSchema, type RuntimeBrowserCommentBox, type RuntimeBrowserRemoteInput, type RuntimeBrowserWatchClientMessage, type RuntimeBrowserWatchQuery, type RuntimeBrowserWatchServerMessage } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { DEVICE_SOCKET_PROTOCOL } from '@gitspace/protocol/socket-auth';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useTouchPrimary } from '@gitspace/ui';
import { CommentPin } from './comment-threads.js';
import { signDeviceRequest } from './device.js';
import { currentDevice } from './device-session.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { Throttle } from './throttle.js';

/** A tab to watch: on your Chrome's group or the cloud browser's (`groupId`), with what the dialog names it by. `label`
 * names the browser and group ("Cloud browser", "Studio desktop · Its group"). */
export type BrowserWatchTarget = { source: 'chrome' | 'cloud'; groupId: string; targetId: string; title: string; url: string; label: string };
type Request = (command: RuntimeSessionCommand, signal?: AbortSignal) => Promise<RuntimeSessionResult>;
type Frame = Extract<RuntimeBrowserWatchServerMessage, { type: 'frame' }>;
type Page = Extract<RuntimeBrowserWatchServerMessage, { type: 'page' }>;
type Control = Omit<Extract<RuntimeBrowserWatchServerMessage, { type: 'control' }>, 'type'>;
type Ended = Extract<RuntimeBrowserWatchServerMessage, { type: 'ended' }>['reason'];
type Mouse = Extract<RuntimeBrowserRemoteInput, { type: 'mouse' }>;
type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** Chrome's blue, as the extension's toolbar draws Resume agent. */
const BLUE = '#1a73e8';
/** Pointer moves and touch moves go out at most this often (30 a second); presses, keys and touches never wait. */
const MOVE_MS = 33;
const SIZE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/** Presses this close together, in time and place, count as one double or triple click. */
const CLICK_MS = 500;
const CLICK_PX = 5;
const PAUSED = 'main is paused · it sees your changes when it resumes';
const BUTTON: Record<number, Mouse['button']> = { 0: 'left', 1: 'middle', 2: 'right', 3: 'back', 4: 'forward' };
const ENDED: Record<Ended, string> = { closed: 'This tab closed.', ended: 'The browser closed, or this tab left the workspace.', idle: 'The cloud browser closed after 5 minutes without use.' };
/** Lines and pages of a wheel in CSS pixels, as Chrome scrolls them. */
const WHEEL_UNIT: Record<number, number> = { 0: 1, 1: 40, 2: 800 };

/** A point of the element showing the frame (`rect`, the frame drawn contained in it) as fractions of the frame, or null
 * outside the drawn frame. */
export function framePoint(rect: { left: number; top: number; width: number; height: number }, frame: Size, client: Point): Point | null {
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  if (!(scale > 0)) return null;
  const width = frame.width * scale, height = frame.height * scale;
  const x = (client.x - rect.left - (rect.width - width) / 2) / width, y = (client.y - rect.top - (rect.height - height) / 2) / height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x: Math.round(x * 10_000) / 10_000, y: Math.round(y * 10_000) / 10_000 };
}

/** CDP's modifier bits of an event: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/** A key of yours as the tab gets it: what it types (a printable key without Ctrl or ⌘, and Enter), and its codes. */
export function keyInput(event: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'location' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>, down: boolean): RuntimeBrowserRemoteInput {
  const printable = [...event.key].length === 1 && !event.ctrlKey && !event.metaKey;
  const text = printable ? event.key : event.key === 'Enter' ? '\r' : undefined;
  return { type: 'key', event: down ? 'down' : 'up', key: event.key.slice(0, 64), code: event.code.slice(0, 64), keyCode: Math.min(255, Math.max(0, event.keyCode)), ...(text === undefined ? {} : { text }), location: Math.min(3, Math.max(0, event.location)), repeat: event.repeat, modifiers: modifiers(event) };
}

/** The Watch dialog's socket for one tab, signed by this browser's device in `Sec-WebSocket-Protocol`. */
async function openWatch(query: RuntimeBrowserWatchQuery): Promise<WebSocket> {
  const device = await currentDevice();
  if (!device) throw new Error('This browser is not signed in to GitSpace');
  const path = `${BROWSER_WATCH_PATH}?${new URLSearchParams(query)}`;
  const proof = await signDeviceRequest(device, { method: 'GET', path, body: new Uint8Array() });
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url.href, [`${DEVICE_SOCKET_PROTOCOL}${proof}`]);
}

/**
 * Watching one tab live (docs/APERTURE-DESIGN.md §7.1–7.2): its screencast frames while the dialog is open (closing it
 * stops them), Take over and Resume agent, and while you hold the tab from this device, your pointer, wheel, keys and
 * touches go to it, positions mapped from the frame to the tab's viewport. On a touch screen a text field types into
 * the tab's focused element. `takeover`: the browser can be taken over from GitSpace (else "Update the extension").
 * `focusInChrome` adds Focus in Chrome. `pin` (Show on page) highlights a comment thread's pin, numbered `n`, where
 * its anchor was in the tab's viewport.
 */
export function BrowserWatchDialog({ identity, request, target, focusInChrome, takeover, pin, onClose }: { identity: { projectId: string; workspaceId: string }; request: Request; target: BrowserWatchTarget; focusInChrome: boolean; takeover: boolean; pin?: { n: number; box: RuntimeBrowserCommentBox }; onClose(): void }) {
  const touch = useTouchPrimary();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [control, setControl] = useState<Control>({ holder: null, input: false });
  const [online, setOnline] = useState(true);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [pending, setPending] = useState<'takeOver' | 'resume' | 'focus' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const live = useRef<WebSocket | null>(null);
  // The element showing the frame, once the dialog's portal mounted it.
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const size = useRef<Size | null>(null);
  const touches = useRef(new Map<number, { id: number; x: number; y: number }>());
  /** The next touch point's id (0–15, as DevTools takes them). */
  const touchIds = useRef(0);
  const clicks = useRef<{ at: number; x: number; y: number; count: number } | null>(null);
  const wheel = useRef({ deltaX: 0, deltaY: 0 });
  const input = control.input && !ended;

  const send = useCallback((message: RuntimeBrowserWatchClientMessage) => {
    const socket = live.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);
  const throttles = useMemo(() => ({
    move: new Throttle<RuntimeBrowserRemoteInput>(MOVE_MS, send),
    size: new Throttle<Size>(SIZE_MS, value => send({ type: 'size', ...value })),
    wheel: new Throttle<Point & { modifiers: number }>(MOVE_MS, at => {
      const { deltaX, deltaY } = wheel.current;
      wheel.current = { deltaX: 0, deltaY: 0 };
      send({ type: 'wheel', ...at, deltaX: Math.max(-10_000, Math.min(10_000, deltaX)), deltaY: Math.max(-10_000, Math.min(10_000, deltaY)) });
    }),
  }), [send]);
  useEffect(() => () => { throttles.move.cancel(); throttles.size.cancel(); throttles.wheel.cancel(); }, [throttles]);

  const { projectId, workspaceId } = identity, { source, groupId, targetId } = target;
  useEffect(() => {
    const query: RuntimeBrowserWatchQuery = source === 'chrome' ? { source, projectId, workspaceId, groupId, targetId } : { source, projectId, workspaceId, targetId };
    let disposed = false, finished = false, failures = 0, timer: number | undefined;
    const receive = (message: RuntimeBrowserWatchServerMessage) => {
      switch (message.type) {
        case 'frame': setFrame(message); return;
        case 'page': setPage(message); return;
        case 'control': setControl({ holder: message.holder, input: message.input }); return;
        case 'presence': setOnline(message.online); return;
        case 'error': setNotice(message.message); return;
        case 'ended': finished = true; setEnded(message.reason); return;
      }
    };
    const connect = () => {
      openWatch(query).then(socket => {
        if (disposed) { socket.close(1000); return; }
        live.current = socket;
        socket.addEventListener('open', () => {
          failures = 0;
          setConnected(true);
          if (size.current) socket.send(JSON.stringify({ type: 'size', ...size.current } satisfies RuntimeBrowserWatchClientMessage));
        });
        socket.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data !== 'string') return;
          let data: unknown;
          try { data = JSON.parse(event.data); } catch { return; }
          const parsed = RuntimeBrowserWatchServerMessageSchema.safeParse(data);
          if (parsed.success) receive(parsed.data);
        });
        socket.addEventListener('close', () => { if (live.current === socket) dropped(); });
      }, (cause: unknown) => { if (!disposed) { setNotice(rpcErrorMessage(cause, 'Watch this tab')); dropped(); } });
    };
    function dropped() {
      live.current = null;
      setConnected(false);
      if (disposed || finished) return;
      timer = window.setTimeout(connect, Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** failures));
      failures += 1;
    }
    connect();
    // Closing the dialog closes the socket, which stops the tab's screencast.
    return () => { disposed = true; window.clearTimeout(timer); const socket = live.current; live.current = null; socket?.close(1000); };
  }, [projectId, workspaceId, source, groupId, targetId]);

  // The frame's area on screen, in device pixels: frames are sent at that size (at most 1280 on a side).
  useLayoutEffect(() => {
    if (!screen) return;
    const measure = () => {
      const rect = screen.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = { width: Math.round(Math.min(4096, Math.max(64, rect.width * ratio))), height: Math.round(Math.min(4096, Math.max(64, rect.height * ratio))) };
      if (size.current?.width === next.width && size.current.height === next.height) return;
      size.current = next;
      throttles.size.push(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    return () => observer.disconnect();
  }, [screen, throttles]);

  const shown = frame ?? page;
  const pointAt = (client: Point) => {
    const rect = screen?.getBoundingClientRect();
    return rect && shown ? framePoint(rect, shown, client) : null;
  };
  // The wheel scrolls the tab, not the dialog: React's wheel listener is passive, so this one is the element's own.
  useEffect(() => {
    if (!screen || !input) return;
    const scroll = (event: WheelEvent) => {
      const at = pointAt({ x: event.clientX, y: event.clientY });
      if (!at) return;
      event.preventDefault();
      const unit = WHEEL_UNIT[event.deltaMode] ?? 1;
      wheel.current = { deltaX: wheel.current.deltaX + event.deltaX * unit, deltaY: wheel.current.deltaY + event.deltaY * unit };
      throttles.wheel.push({ ...at, modifiers: modifiers(event) });
    };
    screen.addEventListener('wheel', scroll, { passive: false });
    return () => screen.removeEventListener('wheel', scroll);
  });

  const touchPoints = () => [...touches.current.values()];
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!input) return;
    const at = pointAt({ x: event.clientX, y: event.clientY });
    if (!at) return;
    event.preventDefault();
    event.currentTarget.focus();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* no capture for this pointer */ }
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, { id: touchIds.current, ...at });
      touchIds.current = (touchIds.current + 1) % 16;
      throttles.move.cancel();
      send({ type: 'touch', event: 'start', points: touchPoints().slice(0, 10), modifiers: 0 });
      return;
    }
    const now = Date.now(), last = clicks.current;
    const count = last && now - last.at < CLICK_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < CLICK_PX ? Math.min(3, last.count + 1) : 1;
    clicks.current = { at: now, x: event.clientX, y: event.clientY, count };
    throttles.move.cancel();
    send({ type: 'mouse', event: 'down', ...at, button: BUTTON[event.button] ?? 'left', buttons: event.buttons & 31, clickCount: count, modifiers: modifiers(event) });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!input) return;
    const at = pointAt({ x: event.clientX, y: event.clientY });
    if (!at) return;
    if (event.pointerType === 'touch') {
      const touched = touches.current.get(event.pointerId);
      if (!touched) return;
      touches.current.set(event.pointerId, { ...touched, ...at });
      throttles.move.push({ type: 'touch', event: 'move', points: touchPoints().slice(0, 10), modifiers: 0 });
      return;
    }
    throttles.move.push({ type: 'mouse', event: 'move', ...at, button: 'none', buttons: event.buttons & 31, clickCount: 0, modifiers: modifiers(event) });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!input) return;
    if (event.pointerType === 'touch') {
      if (!touches.current.delete(event.pointerId)) return;
      throttles.move.cancel();
      // A finger lifted while others stay down moves the rest; the last one ends the touch.
      const left = touchPoints();
      send(left.length ? { type: 'touch', event: 'move', points: left.slice(0, 10), modifiers: 0 } : { type: 'touch', event: cancelled ? 'cancel' : 'end', points: [], modifiers: 0 });
      return;
    }
    const at = pointAt({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 };
    throttles.move.cancel();
    send({ type: 'mouse', event: 'up', ...at, button: BUTTON[event.button] ?? 'left', buttons: event.buttons & 31, clickCount: clicks.current?.count ?? 1, modifiers: modifiers(event) });
  };
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>, down: boolean) => {
    if (!input || event.nativeEvent.isComposing) return;
    // Every key is the tab's while it has focus here, Tab and Escape too.
    event.preventDefault();
    event.stopPropagation();
    send(keyInput(event.nativeEvent, down));
  };
  const typeText = (event: FormEvent) => {
    event.preventDefault();
    if (!typed || !input) return;
    send({ type: 'text', text: typed.slice(0, 1000) });
    setTyped('');
  };
  const pressKey = (key: 'Enter' | 'Backspace') => {
    const named = { key, code: key, keyCode: key === 'Enter' ? 13 : 8, location: 0, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    send(keyInput(named, true));
    send(keyInput(named, false));
  };
  const act = async (kind: 'takeOver' | 'resume' | 'focus') => {
    setPending(kind); setActionError(null);
    const command: RuntimeSessionCommand = kind === 'takeOver' ? { type: 'browserTakeOver', groupId, targetId } : kind === 'resume' ? { type: 'browserResume', groupId, targetId } : { type: 'browserFocusTab', groupId, targetId };
    const labels: Record<typeof kind, string> = { takeOver: 'Take over the tab', resume: 'Resume the agent', focus: 'Focus the tab in Chrome' };
    try { await request(command); } catch (cause) { setActionError(rpcErrorMessage(cause, labels[kind])); } finally { setPending(null); }
  };

  const title = page?.title || target.title || page?.url || target.url;
  const held = control.holder?.holder === 'you' ? control.holder : null;
  const status = ended ? ENDED[ended] : !online ? 'This Chrome is offline. The tab comes back when it reconnects.' : !connected && !frame ? 'Connecting…' : !frame ? 'Waiting for the tab…' : null;
  const aspect = shown ?? { width: 16, height: 10 };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent size="lg" className="sm:max-w-[min(960px,calc(100vw-4rem))]">
    <DialogHeader>
      <DialogTitle className="truncate pr-8">{title}</DialogTitle>
      <DialogDescription>{target.label} · {ended ? 'ended' : connected ? 'live' : 'connecting'}</DialogDescription>
    </DialogHeader>
    {held ? <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-neutral-200 bg-white px-3 py-2 text-neutral-800 shadow-sm">
      <img src="/favicon.png" alt="" width={18} height={18} className="shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">You’re in control{input ? '' : held.by === 'chrome' ? ' in Chrome' : ' on another device'}</p>
        <p className="text-[12px] text-neutral-500">{PAUSED}</p>
      </div>
      {!input && takeover ? <button type="button" disabled={pending !== null} onClick={() => void act('takeOver')} className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-[12px] font-medium hover:bg-neutral-50 disabled:opacity-60">Control from here</button> : null}
      <button type="button" disabled={pending !== null} onClick={() => void act('resume')} className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60" style={{ background: BLUE }}>{pending === 'resume' ? 'Resuming…' : 'Resume agent'}</button>
    </div> : null}
    <div className="flex justify-center">
      <div
        ref={setScreen}
        role="application"
        aria-label={input ? `Remote control of ${title}` : `Live view of ${title}`}
        tabIndex={input ? 0 : -1}
        className={`relative overflow-hidden rounded-lg border bg-black/90 outline-none ${input ? 'touch-none select-none border-[#1a73e8] ring-2 ring-[#1a73e8]/40' : 'border-border'}`}
        style={{ aspectRatio: `${aspect.width} / ${aspect.height}`, width: `min(100%, calc(62dvh * ${aspect.width} / ${aspect.height}))` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={event => onPointerUp(event, false)} onPointerCancel={event => onPointerUp(event, true)}
        onKeyDown={event => onKey(event, true)} onKeyUp={event => onKey(event, false)} onContextMenu={event => { if (input) event.preventDefault(); }}
      >
        {frame ? <img className="size-full object-contain" src={`data:image/jpeg;base64,${frame.data}`} alt={`Live view of ${title}`} draggable={false} /> : null}
        {frame && pin ? <CommentPin n={pin.n} box={pin.box} resolved={false} highlighted /> : null}
        {status ? <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-caption text-white/80">{status}</p> : null}
      </div>
    </div>
    {input && touch ? <form aria-label="Type into the tab" onSubmit={typeText} className="mt-3 flex items-center gap-2">
      <input value={typed} onChange={event => setTyped(event.currentTarget.value)} placeholder="Type into the page" aria-label="Text for the page" autoCapitalize="off" autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-border bg-surface-1 px-3 py-2 text-body" />
      <Button type="submit" size="compact" variant="secondary" disabled={!typed}>Type</Button>
      <Button type="button" size="icon-compact" variant="ghost" aria-label="Press Enter" onClick={() => pressKey('Enter')}>⏎</Button>
      <Button type="button" size="icon-compact" variant="ghost" aria-label="Press Backspace" onClick={() => pressKey('Backspace')}>⌫</Button>
    </form> : null}
    {input && !touch ? <p className="mt-2 text-caption text-muted-foreground">Your pointer, scrolling and keys go to the tab. Click the page first to type into it.</p> : null}
    {notice && !ended ? <p role="alert" className="mt-2 text-caption text-destructive">{notice}</p> : null}
    {actionError ? <p role="alert" className="mt-2 text-caption text-destructive">{actionError}</p> : null}
    <DialogFooter className="flex-wrap">
      {focusInChrome ? <Button variant="ghost" loading={pending === 'focus'} disabled={pending !== null && pending !== 'focus'} onClick={() => void act('focus')}>Focus in Chrome</Button> : null}
      {held || ended ? null : takeover ? <Button variant="secondary" loading={pending === 'takeOver'} disabled={pending !== null && pending !== 'takeOver'} onClick={() => void act('takeOver')}>Take over</Button>
        : <span className="self-center text-caption text-muted-foreground">Update the extension to take over from here</span>}
      <Button variant="primary" onClick={onClose}>Done</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}
