import { describe, it, expect } from 'bun:test';
import { VirtualTerminal } from '../virtual-terminal.js';

describe('VirtualTerminal', () => {
  function createTerminal(cols = 80, rows = 24) {
    const written: string[] = [];
    const vt = new VirtualTerminal(cols, rows, (data) => written.push(data));
    return { vt, written };
  }

  // ---------------------------------------------------------------------------
  // Construction + dimensions
  // ---------------------------------------------------------------------------

  it('reports initial dimensions', () => {
    const { vt } = createTerminal(120, 40);
    expect(vt.columns).toBe(120);
    expect(vt.rows).toBe(40);
  });

  it('reports kittyProtocolActive as true', () => {
    const { vt } = createTerminal();
    expect(vt.kittyProtocolActive).toBe(true);
  });

  it('reports dark appearance by default', () => {
    const { vt } = createTerminal();
    expect(vt.appearance).toBe('dark');
  });

  it('starts in non-started state', () => {
    const { vt } = createTerminal();
    expect(vt.started).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  it('start() registers handlers and sets started flag', () => {
    const { vt } = createTerminal();
    const inputCalls: string[] = [];
    let resizeCount = 0;

    vt.start((data) => inputCalls.push(data), () => resizeCount++);
    expect(vt.started).toBe(true);

    // After start, inject should reach the handler
    vt.injectInput('hello');
    expect(inputCalls).toEqual(['hello']);

    // Resize should reach the handler
    vt.resize(100, 50);
    expect(resizeCount).toBe(1);
  });

  it('stop() clears handlers and resets started flag', () => {
    const { vt } = createTerminal();
    const inputCalls: string[] = [];
    let resizeCount = 0;

    vt.start((data) => inputCalls.push(data), () => resizeCount++);
    vt.stop();
    expect(vt.started).toBe(false);

    // After stop, inject/resize should be silent
    vt.injectInput('ignored');
    vt.resize(100, 50);
    expect(inputCalls).toEqual([]);
    expect(resizeCount).toBe(0);
  });

  it('drainInput() resolves immediately', async () => {
    const { vt } = createTerminal();
    await vt.drainInput();
    await vt.drainInput(500, 25);
  });

  // ---------------------------------------------------------------------------
  // Output routing (write → writer callback)
  // ---------------------------------------------------------------------------

  it('write() forwards data to the writer callback', () => {
    const { vt, written } = createTerminal();
    vt.write('hello world');
    expect(written).toEqual(['hello world']);
  });

  it('cursor helpers emit correct escape sequences', () => {
    const { vt, written } = createTerminal();
    vt.hideCursor();
    vt.showCursor();
    vt.moveBy(3);
    vt.moveBy(-2);
    vt.moveBy(0); // no-op
    vt.clearLine();
    vt.clearFromCursor();
    vt.clearScreen();
    expect(written).toEqual([
      '\x1b[?25l',     // hideCursor
      '\x1b[?25h',     // showCursor
      '\x1b[3B',       // moveBy(3) — down
      '\x1b[2A',       // moveBy(-2) — up
      // moveBy(0) emits nothing
      '\x1b[2K',       // clearLine
      '\x1b[J',        // clearFromCursor
      '\x1b[2J\x1b[H', // clearScreen
    ]);
  });

  it('setTitle() emits OSC title sequence', () => {
    const { vt, written } = createTerminal();
    vt.setTitle('My Session');
    expect(written).toEqual([`\x1b]0;My Session\x07`]);
  });

  // ---------------------------------------------------------------------------
  // Input injection
  // ---------------------------------------------------------------------------

  it('injectInput() is silent before start()', () => {
    const { vt } = createTerminal();
    // Should not throw
    vt.injectInput('data');
  });

  it('injectInput() forwards to onInput handler', () => {
    const { vt } = createTerminal();
    const received: string[] = [];
    vt.start((data) => received.push(data), () => {});

    vt.injectInput('\x1b[A'); // up arrow
    vt.injectInput('a');
    expect(received).toEqual(['\x1b[A', 'a']);
  });

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------

  it('resize() updates dimensions and fires handler', () => {
    const { vt } = createTerminal(80, 24);
    let resizeCount = 0;
    vt.start(() => {}, () => resizeCount++);

    vt.resize(120, 40);
    expect(vt.columns).toBe(120);
    expect(vt.rows).toBe(40);
    expect(resizeCount).toBe(1);
  });

  it('resize() skips notification when dimensions unchanged', () => {
    const { vt } = createTerminal(80, 24);
    let resizeCount = 0;
    vt.start(() => {}, () => resizeCount++);

    vt.resize(80, 24); // same dims
    expect(resizeCount).toBe(0);
  });

  it('resize() updates dimensions even without start()', () => {
    const { vt } = createTerminal(80, 24);
    vt.resize(100, 50);
    expect(vt.columns).toBe(100);
    expect(vt.rows).toBe(50);
  });

  // ---------------------------------------------------------------------------
  // Appearance
  // ---------------------------------------------------------------------------

  it('setAppearance() updates and notifies listeners', () => {
    const { vt } = createTerminal();
    const appearances: string[] = [];
    vt.onAppearanceChange((a) => appearances.push(a));

    vt.setAppearance('light');
    expect(vt.appearance).toBe('light');
    expect(appearances).toEqual(['light']);

    // Same value — no notification
    vt.setAppearance('light');
    expect(appearances).toEqual(['light']);

    vt.setAppearance('dark');
    expect(vt.appearance).toBe('dark');
    expect(appearances).toEqual(['light', 'dark']);
  });

  it('multiple appearance listeners all fire', () => {
    const { vt } = createTerminal();
    const a: string[] = [];
    const b: string[] = [];
    vt.onAppearanceChange((v) => a.push(v));
    vt.onAppearanceChange((v) => b.push(v));

    vt.setAppearance('light');
    expect(a).toEqual(['light']);
    expect(b).toEqual(['light']);
  });
});
