import { Badge, Button, TabsSubtle, TabsSubtleItem, type IconComponent } from '@gitspace/ui';
import { CpuChip01, Plus, RefreshCw01, Server01, Square, Terminal, TerminalSquare, XClose } from '@untitledui/icons';
import type { Terminal as GhosttyTerminalType } from 'ghostty-web';
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { glyph } from './glyph.js';
import { EmptyState } from './GitSpaceShell.js';

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
}

export interface WorkspaceTerminalOutput {
  spaceId: string;
  name: string;
  state: WorkspaceTerminalState;
  cursor: number;
  data: string;
}

export interface WorkspaceTerminalsProps {
  list(): Promise<readonly WorkspaceTerminalView[]>;
  create(): Promise<WorkspaceTerminalView>;
  read(name: string, cursor: number | null): Promise<WorkspaceTerminalOutput>;
  send(name: string, data: string): Promise<void>;
  onClose?: () => void;
  stop(name: string): Promise<void>;
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

function findUtf8SafeEnd(chunk: Uint8Array, offset: number, maxEnd: number): number {
  let end = maxEnd;
  if (end < chunk.length) {
    let safeEnd = end;
    while (safeEnd > offset && (chunk[safeEnd]! & 0xc0) === 0x80) safeEnd--;
    if (safeEnd > offset) end = safeEnd;
  }
  return end;
}

function writeTerminalSlice(terminal: GhosttyTerminalType, slice: Uint8Array): boolean {
  try {
    terminal.write(slice);
    return true;
  } catch (error) {
    if (slice.byteLength > MIN_TERMINAL_WRITE_BYTES) {
      const midpoint = findUtf8SafeEnd(slice, 0, Math.floor(slice.byteLength / 2));
      if (midpoint > 0 && midpoint < slice.byteLength) {
        return writeTerminalSlice(terminal, slice.subarray(0, midpoint))
          && writeTerminalSlice(terminal, slice.subarray(midpoint));
      }
    }
    console.error('[workspace-terminal] dropping failed Ghostty write slice', {
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

function createTerminalWritePump(terminal: GhosttyTerminalType, onFatal: (error: Error) => void): TerminalWritePump {
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
        if (!writeTerminalSlice(terminal, slice)) {
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

function HubGhosttyTerminal({ data, disabled, onData, onError }: { data: string; disabled: boolean; onData: (data: string) => void; onError: (error: Error) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalType | null>(null);
  const pumpRef = useRef<TerminalWritePump | null>(null);
  const renderedRef = useRef('');
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
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { onDataRef.current = onData; }, [onData]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
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
        scrollback: 10_000,
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
      terminal.open(container);
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

      const helper = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
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
        helper.autocorrect = true;
        helper.autocomplete = 'on';
        helper.autocapitalize = 'none';
        helper.inputMode = 'text';
        helper.enterKeyHint = 'enter';
        helper.spellcheck = true;
        helper.addEventListener('compositionstart', handleCompositionStart);
        helper.addEventListener('compositionend', handleCompositionEnd);
        helper.addEventListener('input', handleInput);
      }

      const writePump = createTerminalWritePump(terminal, (error) => onErrorRef.current(error));
      pumpRef.current = writePump;
      writePump.replace(terminalEncoder.encode(data));
      renderedRef.current = data;

      terminal.focus();

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
      if (current) requestAnimationFrame(() => current.dispose());
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
      ? <div className="flex min-h-0 flex-1 items-center justify-center p-6"><EmptyState icon={<TerminalSquare width={24} height={24} strokeWidth={1.5} />} title="Terminal renderer failed" description={this.state.error.message} /></div>
      : this.props.children;
  }
}


export function WorkspaceTerminals(props: WorkspaceTerminalsProps) {
  const { list, create: createTerminal, read, send, stop: stopTerminal } = props;
  const [terminals, setTerminals] = useState<WorkspaceTerminalView[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [output, setOutput] = useState<WorkspaceTerminalOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pendingInput = useRef<Array<{ name: string; chunks: string[]; send: WorkspaceTerminalsProps['send'] }>>([]);
  const sendingInput = useRef(false);
  const selected = useMemo(() => terminals.find((terminal) => terminal.name === selectedName) ?? terminals[0] ?? null, [terminals, selectedName]);

  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await list();
        if (disposed) return;
        setTerminals([...next]);
        setSelectedName((current) => current && next.some((terminal) => terminal.name === current) ? current : next[0]?.name ?? null);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [list]);

  useEffect(() => {
    if (!selected) { setOutput(null); return; }
    let disposed = false;
    let cursor: number | null = null;
    const refresh = async (): Promise<void> => {
      try {
        const next = await read(selected.name, cursor);
        if (disposed) return;
        cursor = next.cursor;
        setOutput(next);
        setError(null);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 750);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [read, selected?.name]);

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const terminal = await createTerminal();
      setTerminals((current) => [terminal, ...current.filter((item) => item.name !== terminal.name)]);
      setSelectedName(terminal.name);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const sendInput = (data: string): void => {
    if (!selected || !isRunning(selected.state)) return;
    const tail = pendingInput.current.at(-1);
    if (tail?.name === selected.name && tail.send === send) tail.chunks.push(data);
    else pendingInput.current.push({ name: selected.name, chunks: [data], send });
    if (sendingInput.current) return;
    sendingInput.current = true;
    void (async () => {
      try {
        while (pendingInput.current.length > 0) {
          const next = pendingInput.current.shift()!;
          await next.send(next.name, next.chunks.join(''));
        }
        setError(null);
      } catch (cause) {
        pendingInput.current.length = 0;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        sendingInput.current = false;
      }
    })();
  };


  const stop = async (): Promise<void> => {
    if (!selected || !isRunning(selected.state)) return;
    try {
      await stopTerminal(selected.name);
      const next = await list();
      setTerminals([...next]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
      {terminals.length > 0
        ? <TabsSubtle size="compact" idPrefix="terminals" selectedIndex={selectedIndex} onSelect={(index) => setSelectedName(terminals[index]?.name ?? null)} className="min-w-0 flex-1">
            {terminals.map((terminal, index) => <TabsSubtleItem key={terminal.name} index={index} label={terminal.name} icon={KIND[terminal.kind].icon} />)}
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
      <TerminalErrorBoundary resetKey={selected.name} onError={(cause) => setError(cause.message)}><HubGhosttyTerminal data={output?.data ?? ''} disabled={!isRunning(selected.state)} onData={sendInput} onError={(cause) => setError(cause.message)} /></TerminalErrorBoundary>
    </> : <div className="flex min-h-0 flex-1 items-center justify-center p-6"><EmptyState icon={<TerminalSquare width={24} height={24} strokeWidth={1.5} />} title="No terminals" description="Open a terminal in this workspace to start an OMP Hub PTY." action={newTerminal} /></div>}
    {error ? <div className="shrink-0 bg-destructive-light px-3 py-1.5 text-caption text-destructive" role="alert">{error}</div> : null}
  </section>;
}
