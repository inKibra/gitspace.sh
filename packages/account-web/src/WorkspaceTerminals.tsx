import { Badge, Button, TabsSubtle, TabsSubtleItem, type IconComponent } from '@gitspace/ui';
import { CpuChip01, Plus, RefreshCw01, Server01, Square, Terminal, TerminalSquare, XClose } from '@untitledui/icons';
import type { Terminal as GhosttyTerminalType } from 'ghostty-web';
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { glyph } from './glyph.js';
import { EmptyState } from './GitSpaceShell.js';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { terminalStreamResource, type ProtectedTerminalEvent, type ProtectedTerminalStep } from '@gitspace/protocol/rpc-contract';
import { useSynchronizedResource } from './SynchronizationProvider.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export type WorkspaceTerminalKind = 'user' | 'agent' | 'lifecycle' | 'service';
export type WorkspaceTerminalState = 'starting' | 'running' | 'ready' | 'restarting' | 'stopping' | 'exited' | 'failed';

export interface WorkspaceTerminalView {
  spaceId: string;
  name: string;
  id: string;
  kind: WorkspaceTerminalKind;
  state: WorkspaceTerminalState;
  machineId: string;
  owner: string | null;
  command: string;
  cwd: string;
  createdAt: Date;
  exitCode: number | null;
  protected?: boolean;
}

export interface WorkspaceTerminalOutput {
  spaceId: string;
  name: string;
  state: WorkspaceTerminalState;
  cursor: number;
  data: string;
}

/** A machine that may run this workspace's terminals: one attached to it as a ready cache. */
export interface WorkspaceTerminalMachine {
  id: string;
  label: string;
}

type ProtectedTerminalStream = AsyncIterable<{ status: 'ok'; value: ProtectedTerminalEvent } | { status: 'error'; error: Error }>;

/** Terminals run only on the machine the user picks; there is no implicit default machine. */
export interface WorkspaceTerminalsProps {
  spaceId: string;
  machines: readonly WorkspaceTerminalMachine[];
  /** The user's pick; terminals stay closed until it names one of `machines`. */
  machineId: string | null;
  onSelectMachine(machineId: string): void;
  /** Opens the workspace's machine controls, where a machine is attached. */
  onAttachMachine?: () => void;
  events(machineId: string, name: string | null, after: number | null, signal: AbortSignal): AsyncIterable<{ status: 'ok'; value: StreamEvent<{ terminals: readonly WorkspaceTerminalView[]; output: WorkspaceTerminalOutput | null }> } | { status: 'error'; error: Error }>;
  live(machineId: string, name: string, signal: AbortSignal): ProtectedTerminalStream;
  requestedName?: string | null;
  create(machineId: string): Promise<WorkspaceTerminalView>;
  send(machineId: string, name: string, data: string): Promise<void>;
  onClose?: () => void;
  stop(machineId: string, name: string): Promise<void>;
}

function isRunning(state: WorkspaceTerminalState): boolean {
  return state === 'starting' || state === 'running' || state === 'ready' || state === 'restarting';
}
const KIND: Record<WorkspaceTerminalKind, { label: string; icon: IconComponent }> = {
  user: { label: 'Terminal', icon: glyph(Terminal) },
  agent: { label: 'Agent opened', icon: glyph(CpuChip01) },
  lifecycle: { label: 'Lifecycle', icon: glyph(RefreshCw01) },
  service: { label: 'Service', icon: glyph(Server01) },
};
const PlusGlyph = glyph(Plus);
function KindBadge({ kind }: { kind: WorkspaceTerminalKind }) {
  const Icon = KIND[kind].icon;
  return <Badge color="gray" size="compact"><Icon size={12} strokeWidth={1.5} />{KIND[kind].label}</Badge>;
}
function stateColor(state: WorkspaceTerminalState): 'green' | 'amber' | 'red' | 'gray' {
  if (state === 'running' || state === 'ready') return 'green';
  if (state === 'starting' || state === 'restarting' || state === 'stopping') return 'amber';
  if (state === 'failed') return 'red';
  return 'gray';
}

type GhosttyModule = typeof import('ghostty-web');
let ghosttyModulePromise: Promise<GhosttyModule> | null = null;
function loadGhostty(): Promise<GhosttyModule> {
  if (!ghosttyModulePromise) {
    ghosttyModulePromise = import('ghostty-web').then(async (module) => {
      await module.init();
      return module;
    }).catch((error) => {
      ghosttyModulePromise = null;
      throw error;
    });
  }
  return ghosttyModulePromise;
}

const MAX_TERMINAL_WRITE_BYTES = 16_384;
const MAX_TERMINAL_DRAIN_BYTES = 64 * 1_024;
const MAX_TERMINAL_DRAIN_MS = 8;
const MIN_TERMINAL_WRITE_BYTES = 512;
const terminalEncoder = new TextEncoder();
// Clear both screens and scrollback. Ghostty.reset() alone can retain old cells.
const ERASE_TERMINAL = '\x1b[?1049h\x1b[3J\x1b[2J\x1b[H\x1b[?1049l\x1b[3J\x1b[2J\x1b[H';

function findUtf8SafeEnd(chunk: Uint8Array, offset: number, maxEnd: number): number {
  let end = maxEnd;
  if (end < chunk.length) {
    let safeEnd = end;
    while (safeEnd > offset && (chunk[safeEnd]! & 0xc0) === 0x80) safeEnd--;
    if (safeEnd > offset) end = safeEnd;
  }
  return end;
}

function writeTerminalSlice(terminal: GhosttyTerminalType, slice: Uint8Array, protectedOutput = false): boolean {
  try {
    terminal.write(slice);
    return true;
  } catch (error) {
    if (slice.byteLength > MIN_TERMINAL_WRITE_BYTES) {
      const midpoint = findUtf8SafeEnd(slice, 0, Math.floor(slice.byteLength / 2));
      if (midpoint > 0 && midpoint < slice.byteLength) {
        return writeTerminalSlice(terminal, slice.subarray(0, midpoint), protectedOutput)
          && writeTerminalSlice(terminal, slice.subarray(midpoint), protectedOutput);
      }
    }
    if (!protectedOutput) console.error('[workspace-terminal] dropping failed Ghostty write slice', {
      bytes: slice.byteLength,
      cols: terminal.cols,
      rows: terminal.rows,
      error,
    });
    return false;
  }
}

interface TerminalWritePump {
  enqueue(data: Uint8Array): void;
  replace(data: Uint8Array): void;
  dispose(): void;
}

function createTerminalWritePump(terminal: GhosttyTerminalType, onFatal: (error: Error) => void, bounded = false): TerminalWritePump {
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let frame: number | null = null;
  let disposed = false;
  let resetPending = false;
  const schedule = (): void => {
    if (frame !== null || disposed) return;
    frame = requestAnimationFrame(drain);
  };
  const drain = (): void => {
    frame = null;
    if (disposed) return;
    if (resetPending) {
      terminal.reset();
      terminal.write(ERASE_TERMINAL);
      resetPending = false;
    }
    const startedAt = performance.now();
    let written = 0;
    while (queue.length > 0) {
      const chunk = queue[0]!;
      let offset = 0;
      while (offset < chunk.length) {
        const remaining = Math.max(1, MAX_TERMINAL_DRAIN_BYTES - written);
        const maxEnd = Math.min(offset + MAX_TERMINAL_WRITE_BYTES, offset + remaining, chunk.length);
        const end = Math.max(offset + 1, findUtf8SafeEnd(chunk, offset, maxEnd));
        const slice = chunk.subarray(offset, end);
        if (!writeTerminalSlice(terminal, slice, bounded)) {
          disposed = true;
          queue.length = 0;
          queuedBytes = 0;
          onFatal(new Error('Ghostty rejected terminal output'));
          return;
        }
        offset = end;
        written += slice.byteLength;
        if (written >= MAX_TERMINAL_DRAIN_BYTES || performance.now() - startedAt >= MAX_TERMINAL_DRAIN_MS) {
          if (offset < chunk.length) {
            queuedBytes -= offset;
            queue[0] = chunk.subarray(offset);
          } else {
            queue.shift();
            queuedBytes -= chunk.length;
          }
          schedule();
          return;
        }
      }
      queue.shift();
      queuedBytes -= chunk.length;
    }
  };
  return {
    enqueue(data: Uint8Array) {
      if (disposed || data.byteLength === 0) return;
      if (bounded && queuedBytes + data.byteLength > 512 * 1_024) {
        queue.length = 0;
        queuedBytes = 0;
        resetPending = true;
        data = data.subarray(Math.max(0, data.byteLength - 512 * 1_024));
      }
      queue.push(new Uint8Array(data));
      queuedBytes += data.byteLength;
      schedule();
    },
    replace(data: Uint8Array) {
      if (disposed) return;
      queue.length = 0;
      queuedBytes = 0;
      resetPending = true;
      if (data.byteLength > 0) {
        queue.push(new Uint8Array(data));
        queuedBytes = data.byteLength;
      }
      schedule();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      queuedBytes = 0;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

function HubGhosttyTerminal({ data, disabled, onData, onError, protected: protectedOutput = false }: { data: string; disabled: boolean; onData: (data: string) => void; onError: (error: Error) => void; protected?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalType | null>(null);
  const pumpRef = useRef<TerminalWritePump | null>(null);
  const renderedRef = useRef('');
  const dataRef = useRef(data);
  dataRef.current = data;
  const disabledRef = useRef(disabled);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  const followOutputRef = useRef(true);

  useEffect(() => {
    const previous = renderedRef.current;
    const pump = pumpRef.current;
    if (!pump || data === previous) return;
    if (data.startsWith(previous)) pump.enqueue(terminalEncoder.encode(data.slice(previous.length)));
    else pump.replace(terminalEncoder.encode(data));
    renderedRef.current = data;
  }, [data]);
  disabledRef.current = disabled;
  onDataRef.current = onData;
  onErrorRef.current = onError;
  useEffect(() => {
    let disposed = false;
    let terminal: GhosttyTerminalType | null = null;
    void loadGhostty().then(({ Terminal: GhosttyTerminal }) => {
      if (disposed || !containerRef.current) return;
      const container = containerRef.current;
      const styles = getComputedStyle(document.documentElement);
      const color = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
      terminal = new GhosttyTerminal({
        cols: 120,
        rows: 40,
        scrollback: protectedOutput ? 1_000 : 10_000,
        fontSize: 13,
        fontFamily: color('--terminal-font', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
        cursorBlink: true,
        theme: {
          background: color('--terminal-bg', '#1f2228'),
          foreground: color('--terminal-fg', '#e8eaf0'),
          cursor: color('--terminal-cursor', '#8ca7ff'),
          cursorAccent: color('--terminal-cursor-accent', '#1f2228'),
          selectionBackground: color('--terminal-selection', '#465064'),
          black: color('--terminal-black', '#484f58'),
          red: color('--terminal-red', '#ff7b72'),
          green: color('--terminal-green', '#3fb950'),
          yellow: color('--terminal-yellow', '#d29922'),
          blue: color('--terminal-blue', '#58a6ff'),
          magenta: color('--terminal-magenta', '#bc8cff'),
          cyan: color('--terminal-cyan', '#39c5cf'),
          white: color('--terminal-white', '#b1bac4'),
          brightBlack: color('--terminal-bright-black', '#6e7681'),
          brightRed: color('--terminal-bright-red', '#ffa198'),
          brightGreen: color('--terminal-bright-green', '#56d364'),
          brightYellow: color('--terminal-bright-yellow', '#e3b341'),
          brightBlue: color('--terminal-bright-blue', '#79c0ff'),
          brightMagenta: color('--terminal-bright-magenta', '#d2a8ff'),
          brightCyan: color('--terminal-bright-cyan', '#56d4dd'),
          brightWhite: color('--terminal-bright-white', '#f0f6fc'),
        },
      });
      if (protectedOutput) {
        // Ghostty.open calls focus internally, including a deferred focus. Suppress
        // that call rather than restoring focus after it has interrupted typing.
        const focus = terminal.focus;
        terminal.focus = () => {};
        try { terminal.open(container); } finally { terminal.focus = focus; }
        terminal.write(ERASE_TERMINAL);
        container.setAttribute('autocorrect', 'off');
        container.setAttribute('autocapitalize', 'none');
        container.spellcheck = false;
      } else terminal.open(container);
      terminal.onData((value) => { if (!disabledRef.current) onDataRef.current(value); });
      terminalRef.current = terminal;

      const syncFollowState = (): void => {
        if (terminal) followOutputRef.current = terminal.viewportY === 0;
      };
      const originalScrollToBottom = terminal.scrollToBottom.bind(terminal);
      terminal.scrollToBottom = () => { if (followOutputRef.current) originalScrollToBottom(); };
      const scrollDisposable = terminal.onScroll(syncFollowState);

      const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Tab' && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          if (!disabledRef.current) onDataRef.current('\x1b[Z');
          return;
        }
        if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
        const direction = event.key === 'PageUp' ? -1 : 1;
        const baseY = terminal?.buffer.active.baseY ?? 0;
        const canScroll = direction < 0 ? (terminal?.viewportY ?? 0) < baseY : (terminal?.viewportY ?? 0) > 0;
        if (!canScroll || !terminal) return;
        event.preventDefault();
        event.stopPropagation();
        terminal.scrollLines(direction * Math.max(1, terminal.rows - 1));
        syncFollowState();
      };
      container.addEventListener('keydown', handleKeyDown, true);

      let wheelPixels = 0;
      const handleWheelCapture = (event: WheelEvent): void => {
        if (!container.contains(event.target as Node) || event.deltaMode !== 0 || event.deltaY === 0 || !terminal) return;
        if (terminal.wasmTerm?.isAlternateScreen?.()) return;
        event.preventDefault();
        event.stopPropagation();
        const rowHeight = terminal.renderer?.getMetrics().height ?? 20;
        wheelPixels += event.deltaY;
        const lines = Math.trunc(wheelPixels / rowHeight);
        wheelPixels -= lines * rowHeight;
        if (lines !== 0) terminal.scrollLines(lines);
        syncFollowState();
      };
      document.addEventListener('wheel', handleWheelCapture, { passive: false, capture: true });

      const touch = { lastY: 0, movement: 0, accumulated: 0, active: false };
      const handleTouchStart = (event: TouchEvent): void => {
        if (!event.touches[0]) return;
        touch.lastY = event.touches[0].clientY;
        touch.movement = 0;
        touch.accumulated = 0;
        touch.active = true;
      };
      const handleTouchMove = (event: TouchEvent): void => {
        if (!touch.active || !event.touches[0] || !terminal || window.getSelection()?.toString()) return;
        const currentY = event.touches[0].clientY;
        const delta = touch.lastY - currentY;
        touch.lastY = currentY;
        touch.movement += Math.abs(delta);
        if (touch.movement <= 10) return;
        event.preventDefault();
        touch.accumulated += delta;
        const lines = Math.trunc(touch.accumulated / 30);
        touch.accumulated -= lines * 30;
        if (lines !== 0) terminal.scrollLines(lines);
        syncFollowState();
      };
      const handleTouchEnd = (): void => {
        if (touch.active && touch.movement < 10) terminal?.focus();
        touch.active = false;
        syncFollowState();
      };
      container.addEventListener('touchstart', handleTouchStart, { passive: true });
      container.addEventListener('touchmove', handleTouchMove, { passive: false });
      container.addEventListener('touchend', handleTouchEnd, { passive: true });

      const helper = container.querySelector('textarea') as HTMLTextAreaElement | null;
      if (helper && protectedOutput) {
        helper.autocomplete = 'off';
        helper.setAttribute('autocorrect', 'off');
        helper.autocapitalize = 'none';
        helper.spellcheck = false;
      }
      const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      let composing = false;
      const handleCompositionStart = (): void => { composing = true; };
      const handleCompositionEnd = (): void => { composing = false; };
      const handleInput = (event: Event): void => {
        const inputEvent = event as InputEvent;
        if (!ios || !helper || composing || disabledRef.current || !['insertText', 'insertReplacementText', 'insertFromComposition'].includes(inputEvent.inputType)) return;
        if (helper.value.length <= 1) return;
        onDataRef.current(helper.value);
        helper.value = '';
      };
      if (helper && ios) {
        helper.autocorrect = !protectedOutput;
        helper.autocomplete = protectedOutput ? 'off' : 'on';
        helper.autocapitalize = 'none';
        helper.inputMode = 'text';
        helper.enterKeyHint = 'enter';
        helper.spellcheck = !protectedOutput;
        helper.addEventListener('compositionstart', handleCompositionStart);
        helper.addEventListener('compositionend', handleCompositionEnd);
        helper.addEventListener('input', handleInput);
      }

      const writePump = createTerminalWritePump(terminal, (error) => onErrorRef.current(error), protectedOutput);
      pumpRef.current = writePump;
      writePump.replace(terminalEncoder.encode(dataRef.current));
      renderedRef.current = dataRef.current;

      if (!protectedOutput) terminal.focus();

      const previousCleanup = () => {
        scrollDisposable.dispose();
        container.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('wheel', handleWheelCapture, true);
        container.removeEventListener('touchstart', handleTouchStart);
        container.removeEventListener('touchmove', handleTouchMove);
        container.removeEventListener('touchend', handleTouchEnd);
        helper?.removeEventListener('compositionstart', handleCompositionStart);
        helper?.removeEventListener('compositionend', handleCompositionEnd);
        helper?.removeEventListener('input', handleInput);
        writePump.dispose();
      };
      cleanupRef.current = previousCleanup;
    }).catch((cause) => onErrorRef.current(cause instanceof Error ? cause : new Error(String(cause))));
    const cleanupRef = { current: null as (() => void) | null };
    return () => {
      disposed = true;
      cleanupRef.current?.();
      pumpRef.current = null;
      const current = terminal;
      terminalRef.current = null;
      if (current && protectedOutput) {
        current.write(ERASE_TERMINAL);
        current.dispose();
      } else if (current) requestAnimationFrame(() => current.dispose());
    };
  }, []);
  return <div className="min-h-0 flex-1 overflow-auto" ref={containerRef} />;
}

class TerminalErrorBoundary extends Component<{ children: ReactNode; resetKey: string; onError: (error: Error) => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { this.props.onError(error); }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    return this.state.error
      ? <div className="flex min-h-0 flex-1 items-center justify-center p-6"><EmptyState icon={<TerminalSquare width={24} height={24} strokeWidth={1.5} />} title="Terminal renderer failed" description="Close and reopen the terminal pane to reconnect." /></div>
      : this.props.children;
  }
}


function ProtectedTerminal({ name, running, live, onData, onError, onDisconnect }: { name: string; running: boolean; live(name: string, signal: AbortSignal): ProtectedTerminalStream; onData(data: string): void; onError(error: Error): void; onDisconnect(): void }) {
  const [frame, setFrame] = useState<{ data: string; epoch: number; connected: boolean; steps: readonly ProtectedTerminalStep[]; exitCode: number | null; disconnected: boolean }>({ data: '', epoch: 0, connected: false, steps: [], exitCode: null, disconnected: false });
  const liveRef = useRef(live);
  liveRef.current = live;
  const runningRef = useRef(running);
  runningRef.current = running;
  const inputEnabledRef = useRef(false);
  const disconnectRef = useRef(onDisconnect);
  disconnectRef.current = onDisconnect;
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let retry: number | undefined;
    let completed = false;
    const attach = async (): Promise<void> => {
      try {
        for await (const result of liveRef.current(name, signal)) {
          if (signal.aborted) return;
          if (result.status === 'error') break;
          const event = result.value;
          if (event.type === 'state') {
            inputEnabledRef.current = true;
            setFrame((previous) => ({ ...previous, steps: event.steps, connected: true, disconnected: false }));
          } else if (event.type === 'output') {
            setFrame((previous) => {
              const data = previous.data + event.data;
              return data.length > 128 * 1_024
                ? { ...previous, data: data.slice(-128 * 1_024), epoch: previous.epoch + 1 }
                : { ...previous, data };
            });
          } else {
            completed = true;
            inputEnabledRef.current = false;
            disconnectRef.current();
            setFrame((previous) => ({ ...previous, connected: false, exitCode: event.exitCode }));
            return;
          }
        }
      } catch {
        // Transport errors may contain payloads; protected delivery only shows a generic notice.
      }
      if (signal.aborted || completed) return;
      inputEnabledRef.current = false;
      disconnectRef.current();
      setFrame((previous) => ({ ...previous, data: '', epoch: previous.epoch + 1, connected: false, disconnected: true }));
      if (runningRef.current) retry = window.setTimeout(() => {
        if (runningRef.current) void attach();
      }, 1_000);
    };
    // Attempt attachment once; only retry while status still reports an active run.
    // Status delivery can overtake private output: only unmount aborts this stream.
    void attach();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      inputEnabledRef.current = false;
      disconnectRef.current();
    };
  }, [name]);
  const completed = frame.exitCode !== null;
  return <>
    <p role="status" className="shrink-0 px-3 py-1.5 text-caption text-muted-foreground">{completed ? `Environment run ended (exit ${frame.exitCode}). Visible output is retained until this pane is closed or reloaded.` : frame.disconnected ? `Protected live output disconnected; previous output was cleared.${running ? ' Reconnecting to the same run without replay.' : ' The Environment run has ended.'}` : frame.connected ? running ? 'Protected live output · input is not echoed · history is cleared on disconnect or close.' : 'Environment run ended. Receiving its final live output; input is disabled.' : 'Connecting to the same Environment run. Previous output is not replayed; input is paused until connected.'}</p>
    {frame.steps.length > 0 ? <ol aria-label="Environment scripts" className="max-h-40 shrink-0 overflow-auto border-b border-border px-3 py-1 text-caption">
      {frame.steps.map((step) => <li key={step.id} className="flex items-baseline gap-3 py-0.5">
        <code className="min-w-0 flex-1 break-all font-mono text-foreground">{step.id}</code>
        <span className={`shrink-0 tabular-nums ${step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{completed && step.status === 'pending' ? 'not run' : step.status}{step.exitCode !== null ? ` · exit ${step.exitCode}` : ''}</span>
      </li>)}
    </ol> : null}
    <HubGhosttyTerminal key={`${name}:${frame.epoch}`} protected data={frame.data} disabled={!running || !frame.connected || completed} onData={(data) => { if (runningRef.current && inputEnabledRef.current) onData(data); }} onError={onError} />
  </>;
}

export function WorkspaceTerminals(props: WorkspaceTerminalsProps) {
  const machine = props.machines.find((item) => item.id === props.machineId);
  if (machine) return <MachineTerminals key={machine.id} {...props} machine={machine} />;
  return <section className="flex h-full min-h-0 flex-col bg-surface-1" aria-label="Hub terminals">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
      <strong className="flex-1 pl-1 text-caption font-semibold text-foreground">Hub terminals</strong>
      {props.onClose ? <Button variant="ghost" size="icon-compact" aria-label="Close terminals" onClick={props.onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button> : null}
    </header>
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">{props.machines.length > 0
      ? <EmptyState icon={<TerminalSquare width={24} height={24} strokeWidth={1.5} />} title="Choose a machine" description="Terminals run on one machine attached to this workspace. Choose where to open them."
          action={<div className="flex flex-wrap justify-center gap-2">{props.machines.map((item) => <Button key={item.id} variant="secondary" size="compact" onClick={() => props.onSelectMachine(item.id)}>{item.label}</Button>)}</div>} />
      : <EmptyState icon={<TerminalSquare width={24} height={24} strokeWidth={1.5} />} title="Attach a machine to open a terminal" description="Terminals run on a machine attached to this workspace as a ready cache. Cloud files and conversations stay available without one."
          action={props.onAttachMachine ? <Button variant="secondary" size="compact" onClick={props.onAttachMachine}>Attach a machine</Button> : undefined} />}</div>
  </section>;
}

function MachineTerminals(props: WorkspaceTerminalsProps & { machine: WorkspaceTerminalMachine }) {
  const { spaceId, machine, events, create: createTerminal, send, stop: stopTerminal } = props;
  const [selectedName, setSelectedName] = useState<string | null>(props.requestedName ?? null);
  const [created, setCreated] = useState<WorkspaceTerminalView | null>(null);
  const [stopped, setStopped] = useState<readonly string[]>([]);
  // The machine's list comes from the unnamed stream, which never depends on the selection. The
  // selected terminal's stream adds its output and keeps a completed lifecycle run listed; its list
  // never replaces the machine's, so switching streams cannot feed back into the selection.
  const listed = useSynchronizedResource(terminalStreamResource(spaceId, machine.id, null), (after, signal) => events(machine.id, null, after, signal));
  const streamed = useSynchronizedResource(terminalStreamResource(spaceId, machine.id, selectedName), (after, signal) => events(machine.id, selectedName, after, signal));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pendingInput = useRef<Array<{ name: string; chunks: string[]; send: WorkspaceTerminalsProps['send'] }>>([]);
  const sendingInput = useRef(false);
  const terminals = useMemo(() => {
    const machineTerminals = listed.value?.terminals ?? [];
    const retained = machineTerminals.some((terminal) => terminal.name === selectedName) ? undefined : streamed.value?.terminals.find((terminal) => terminal.name === selectedName);
    const visible = retained ? [...machineTerminals, retained]
      : created && created.name === selectedName && !machineTerminals.some((terminal) => terminal.name === created.name) ? [created, ...machineTerminals]
      : machineTerminals;
    return visible.filter((terminal) => !stopped.includes(terminal.id));
  }, [listed.value, streamed.value, selectedName, created, stopped]);
  const selected = useMemo(() => terminals.find((terminal) => terminal.name === selectedName) ?? (selectedName !== null && selectedName === props.requestedName ? null : terminals[0] ?? null), [terminals, selectedName, props.requestedName]);
  const output = streamed.value?.output && streamed.value.output.name === selected?.name ? streamed.value.output : null;
  const selectionRef = useRef(selected);
  selectionRef.current = selected;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; pendingInput.current.length = 0; };
  }, []);
  useEffect(() => { pendingInput.current.length = 0; }, [selected?.id, selected?.state]);
  useEffect(() => {
    if (props.requestedName) setSelectedName(props.requestedName);
  }, [props.requestedName]);

  // Commit the shown terminal as the selection so its stream supplies the output. The shown
  // terminal is always on the machine's list, so committing it settles in one step.
  useEffect(() => {
    if (!listed.value) return;
    const shown = selected?.name ?? (selectedName === props.requestedName ? selectedName : null);
    if (shown !== selectedName) setSelectedName(shown);
  }, [listed.value, selected, selectedName, props.requestedName]);

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const terminal = await createTerminal(machine.id);
      setCreated(terminal);
      setSelectedName(terminal.name);
      setError(null);
    } catch (cause) {
      setError(rpcErrorMessage(cause, 'Create terminal'));
    } finally {
      setCreating(false);
    }
  };

  const sendInput = (data: string): void => {
    if (!selected || selectionRef.current?.id !== selected.id || !isRunning(selected.state)) return;
    if (selected.protected && pendingInput.current.reduce((length, batch) => length + batch.chunks.reduce((size, chunk) => size + chunk.length, 0), data.length) > 64 * 1_024) {
      pendingInput.current.length = 0;
      setError('Input is arriving too quickly. Pending protected input was discarded.');
      return;
    }
    const tail = pendingInput.current.at(-1);
    if (tail?.name === selected.name && tail.send === send) tail.chunks.push(data);
    else pendingInput.current.push({ name: selected.name, chunks: [data], send });
    if (sendingInput.current) return;
    sendingInput.current = true;
    void (async () => {
      try {
        while (pendingInput.current.length > 0) {
          const next = pendingInput.current.shift()!;
          if (!mountedRef.current || selectionRef.current?.name !== next.name || !isRunning(selectionRef.current.state)) continue;
          await next.send(machine.id, next.name, next.chunks.join(''));
        }
        setError(null);
      } catch (cause) {
        pendingInput.current.length = 0;
        if (mountedRef.current) setError(selected.protected || selectionRef.current?.protected ? 'Protected input could not be delivered. It was not retried.' : rpcErrorMessage(cause, 'Send terminal input'));
      } finally {
        sendingInput.current = false;
      }
    })();
  };


  const stop = async (): Promise<void> => {
    if (!selected || !isRunning(selected.state)) return;
    try {
      await stopTerminal(machine.id, selected.name);
      if (selected.kind !== 'lifecycle') {
        setStopped((current) => [...current, selected.id]);
        setSelectedName(null);
      }
      setError(null);
    } catch (cause) {
      setError(rpcErrorMessage(cause, 'Stop terminal'));
    }
  };

  const running = terminals.filter((terminal) => isRunning(terminal.state)).length;
  const selectedIndex = selected ? terminals.indexOf(selected) : 0;
  const newTerminal = <Button variant="secondary" size="compact" leadingIcon={PlusGlyph} onClick={() => void create()} disabled={creating} loading={creating}>{creating ? 'Opening' : 'New terminal'}</Button>;

  return <section className="flex h-full min-h-0 flex-col bg-surface-1" aria-label="Hub terminals">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
      <span className="flex shrink-0 items-baseline gap-1.5 pl-1">
        <strong className="text-caption font-semibold text-foreground">Hub terminals</strong>
        <span className="text-caption tabular-nums text-muted-foreground">{running} running</span>
      </span>
      <select aria-label="Terminal machine" className="max-w-40 shrink-0 bg-transparent text-caption text-muted-foreground" value={machine.id} onChange={(event) => props.onSelectMachine(event.target.value)}>{props.machines.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      {terminals.length > 0
        ? <TabsSubtle size="compact" idPrefix="terminals" selectedIndex={selectedIndex} onSelect={(index) => setSelectedName(terminals[index]?.name ?? null)} className="min-w-0 flex-1">
            {terminals.map((terminal, index) => <TabsSubtleItem key={terminal.name} index={index} label={terminal.protected && terminal.kind === 'lifecycle' ? 'Environment' : terminal.name} icon={KIND[terminal.kind].icon} />)}
          </TabsSubtle>
        : <span className="flex-1" />}
      {newTerminal}
      {selected ? <Button variant="ghost" size="icon-compact" aria-label={`Terminate ${selected.name}`} onClick={() => void stop()} disabled={!isRunning(selected.state)}><Square width={16} height={16} strokeWidth={1.5} /></Button> : null}
      {props.onClose ? <Button variant="ghost" size="icon-compact" aria-label="Close terminals" onClick={props.onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button> : null}
    </header>
    {selected ? <>
      <div className="flex shrink-0 items-center gap-3 px-3 py-1 text-caption text-muted-foreground">
        <KindBadge kind={selected.kind} />
        <Badge variant="dot" color={stateColor(selected.state)} size="compact">{selected.state}</Badge>
        <code className="min-w-0 truncate font-mono text-foreground">{selected.command}</code>
        <span className="ml-auto shrink-0">Machine <span className="font-mono text-foreground">{selected.machineId}</span></span>
      </div>
      <TerminalErrorBoundary resetKey={selected.id} onError={() => setError('Terminal display unavailable. Close and reopen to reconnect.')}><div className="flex min-h-0 flex-1 flex-col" key={selected.id}>{selected.protected ? <ProtectedTerminal name={selected.name} running={isRunning(selected.state)} live={(name, signal) => props.live(machine.id, name, signal)} onData={sendInput} onDisconnect={() => { pendingInput.current.length = 0; }} onError={() => setError('Protected terminal display unavailable. Close and reopen to reconnect.')} /> : <HubGhosttyTerminal data={output?.data ?? ''} disabled={!isRunning(selected.state)} onData={sendInput} onError={(cause) => setError(cause.message)} />}</div></TerminalErrorBoundary>
    </> : <div className="flex min-h-0 flex-1 items-center justify-center p-6"><EmptyState icon={<TerminalSquare width={24} height={24} strokeWidth={1.5} />} title="No terminals" description={`Open a terminal on ${machine.label} in this workspace's checkout.`} action={newTerminal} /></div>}
    {error ? <div className="shrink-0 bg-destructive-light px-3 py-1.5 text-caption text-destructive" role="alert">{error}</div> : null}
    {listed.transportError ?? streamed.transportError ? <div className="shrink-0 px-3 py-1.5 text-caption text-muted-foreground" role="status">{selected?.protected ? 'Terminal status disconnected; reconnecting.' : 'Terminal delivery disconnected. Last received output is retained; reconnecting.'}</div> : null}
  </section>;
}
