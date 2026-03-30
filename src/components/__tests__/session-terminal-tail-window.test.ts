import { describe, expect, it } from 'bun:test';
import { getTailWindowOffset } from '../session-terminal-tail-window.js';

describe('getTailWindowOffset', () => {
  it('returns zero when total lines fit inside the window', () => {
    expect(getTailWindowOffset(120, 5_000)).toBe(0);
  });

  it('returns the start of the tail window when scrollback exceeds the limit', () => {
    expect(getTailWindowOffset(5_750, 5_000)).toBe(750);
  });

  it('guards invalid totals and limits', () => {
    expect(getTailWindowOffset(-1, 5_000)).toBe(0);
    expect(getTailWindowOffset(10_000, 0)).toBe(0);
    expect(getTailWindowOffset(Number.NaN, 5_000)).toBe(0);
  });
});
