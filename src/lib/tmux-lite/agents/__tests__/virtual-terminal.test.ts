import { describe, it, expect } from 'bun:test';
import { VirtualTerminal } from '../virtual-terminal.js';

describe('VirtualTerminal', () => {
  function createTerminal(cols = 80, rows = 24) {
    const written: string[] = [];
    const vt = new VirtualTerminal(cols, rows, (data) => written.push(data));
    return { vt, written };
  }

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

  it('start() registers handlers and stop() clears them', () => {
    const { vt } = createTerminal();
    const inputCalls: string[] = [];
    let resizeCount = 0;

    vt.start((data) => inputCalls.push(data), () => resizeCount++);
    vt.injectInput('hello');
    vt.resize(100, 50);
    expect(inputCalls).toEqual(['hello']);
    expect(resizeCount).toBe(1);

    vt.stop();
    vt.injectInput('ignored');
    vt.resize(120, 60);
    expect(inputCalls).toEqual(['hello']);
    expect(resizeCount).toBe(1);
  });

  it('cursor helpers emit escape sequences', () => {
    const { vt, written } = createTerminal();
    vt.hideCursor();
    vt.showCursor();
    vt.moveBy(3);
    vt.moveBy(-2);
    vt.clearLine();
    vt.clearFromCursor();
    vt.clearScreen();
    expect(written).toEqual([
      '\x1b[?25l',
      '\x1b[?25h',
      '\x1b[3B',
      '\x1b[2A',
      '\x1b[2K',
      '\x1b[J',
      '\x1b[2J\x1b[H',
    ]);
  });

  it('setTitle() emits OSC title sequence', () => {
    const { vt, written } = createTerminal();
    vt.setTitle('My Session');
    expect(written).toEqual([`\x1b]0;My Session\x07`]);
  });

  it('setAppearance() updates and notifies listeners', () => {
    const { vt } = createTerminal();
    const seen: string[] = [];
    vt.onAppearanceChange((value) => seen.push(value));
    vt.setAppearance('light');
    vt.setAppearance('light');
    vt.setAppearance('dark');
    expect(seen).toEqual(['light', 'dark']);
  });
});
