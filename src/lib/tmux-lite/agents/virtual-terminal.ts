/**
 * VirtualTerminal — an in-process Terminal adapter for pi-tui.
 *
 * Instead of reading from process.stdin and writing to process.stdout
 * (like ProcessTerminal), this adapter routes I/O through callbacks:
 *
 *   - `write()` calls the `writer` callback, which feeds bytes into
 *     xterm-headless for state tracking and client fan-out.
 *   - `injectInput()` forwards client keystrokes to pi-tui's input handler.
 *   - `resize()` updates dimensions and notifies pi-tui to re-render.
 *
 * This allows pi-tui (and InteractiveMode on top of it) to render into
 * the same xterm-headless instance that tmux-lite already uses for
 * PTY sessions, reusing the entire transport/attach/snapshot pipeline.
 */

import type { Terminal, TerminalAppearance } from '@oh-my-pi/pi-tui';

export class VirtualTerminal implements Terminal {
  private _cols: number;
  private _rows: number;
  private _onInput: ((data: string) => void) | null = null;
  private _onResize: (() => void) | null = null;
  private readonly _writer: (data: string) => void;
  private _appearance: TerminalAppearance = 'dark';
  private _appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
  private _started = false;

  constructor(cols: number, rows: number, writer: (data: string) => void) {
    this._cols = cols;
    this._rows = rows;
    this._writer = writer;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this._onInput = onInput;
    this._onResize = onResize;
    this._started = true;
  }

  stop(): void {
    this._onInput = null;
    this._onResize = null;
    this._started = false;
  }

  drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
    return Promise.resolve();
  }

  write(data: string): void {
    this._writer(data);
  }

  get columns(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  get kittyProtocolActive(): boolean {
    return true;
  }

  // 16.x Terminal interface: the raw enable sequence. Virtual terminals don't
  // emit a kitty-keyboard enable escape, so there's nothing to expose.
  get kittyEnableSequence(): string | null {
    return null;
  }

  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    else if (lines < 0) this.write(`\x1b[${-lines}A`);
  }

  hideCursor(): void {
    this.write('\x1b[?25l');
  }

  showCursor(): void {
    this.write('\x1b[?25h');
  }

  clearLine(): void {
    this.write('\x1b[2K');
  }

  clearFromCursor(): void {
    this.write('\x1b[J');
  }

  clearScreen(): void {
    this.write('\x1b[2J\x1b[H');
  }

  setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`);
  }

  setProgress(_active: boolean): void {
    // Virtual terminals render in-process for remote clients; there is no host
    // terminal progress indicator to update.
  }

  onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
    this._appearanceCallbacks.push(callback);
  }

  get appearance(): TerminalAppearance {
    return this._appearance;
  }

  get started(): boolean {
    return this._started;
  }

  injectInput(data: string): void {
    this._onInput?.(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this._onResize?.();
  }

  setAppearance(appearance: TerminalAppearance): void {
    if (appearance === this._appearance) return;
    this._appearance = appearance;
    for (const cb of this._appearanceCallbacks) cb(appearance);
  }
}
