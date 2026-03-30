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

  /**
   * @param cols    Initial column count (from client or default).
   * @param rows    Initial row count.
   * @param writer  Receives all terminal output from pi-tui. Typically
   *                wired to `xtermInstance.write(data)`.
   */
  constructor(cols: number, rows: number, writer: (data: string) => void) {
    this._cols = cols;
    this._rows = rows;
    this._writer = writer;
  }

  // ---------------------------------------------------------------------------
  // Terminal interface — lifecycle
  // ---------------------------------------------------------------------------

  start(onInput: (data: string) => void, onResize: () => void): void {
    this._onInput = onInput;
    this._onResize = onResize;
    this._started = true;
  }

  stop(): void {
    // No process state to restore. Clear handlers to prevent further delivery.
    this._onInput = null;
    this._onResize = null;
    this._started = false;
  }

  drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
    // No real stdin to drain — clients are remote and we don't buffer.
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Terminal interface — output
  // ---------------------------------------------------------------------------

  write(data: string): void {
    this._writer(data);
  }

  // ---------------------------------------------------------------------------
  // Terminal interface — dimensions
  // ---------------------------------------------------------------------------

  get columns(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  // ---------------------------------------------------------------------------
  // Terminal interface — capabilities
  // ---------------------------------------------------------------------------

  /**
   * Report Kitty keyboard protocol as active. pi-tui uses this to decide
   * whether to emit disambiguated key sequences. ghostty (web and TUI) and
   * xterm-headless both understand Kitty sequences, so this is safe.
   */
  get kittyProtocolActive(): boolean {
    return true;
  }

  // ---------------------------------------------------------------------------
  // Terminal interface — cursor / clear / title helpers
  //
  // These emit ANSI escape sequences through `write()`. pi-tui calls them
  // for rendering operations. The sequences flow through xterm-headless
  // and ultimately to the client's terminal emulator.
  // ---------------------------------------------------------------------------

  moveBy(lines: number): void {
    if (lines > 0) {
      this.write(`\x1b[${lines}B`);
    } else if (lines < 0) {
      this.write(`\x1b[${-lines}A`);
    }
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

  // ---------------------------------------------------------------------------
  // Terminal interface — appearance
  // ---------------------------------------------------------------------------

  onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
    this._appearanceCallbacks.push(callback);
  }

  get appearance(): TerminalAppearance {
    return this._appearance;
  }

  // ---------------------------------------------------------------------------
  // GitSpace-side API — these are NOT part of the Terminal interface.
  // tmux-lite calls these to route client events into pi-tui.
  // ---------------------------------------------------------------------------

  /** Whether start() has been called and stop() hasn't. */
  get started(): boolean {
    return this._started;
  }

  /**
   * Route client keystroke data into pi-tui's input handler.
   * Called by tmux-lite when a client sends an input frame.
   */
  injectInput(data: string): void {
    this._onInput?.(data);
  }

  /**
   * Update terminal dimensions and notify pi-tui to re-render.
   * Called by tmux-lite when a client sends a resize frame.
   */
  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this._onResize?.();
  }

  /**
   * Change the reported appearance and notify all listeners.
   * Can be called when a client reports its color scheme.
   */
  setAppearance(appearance: TerminalAppearance): void {
    if (appearance === this._appearance) return;
    this._appearance = appearance;
    for (const cb of this._appearanceCallbacks) {
      cb(appearance);
    }
  }
}
