import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Terminal as XTerminal } from '@xterm/headless';
import {
  extractStyledRows,
  findPngRasterizer,
  readPngDimensions,
  renderTerminalSnapshotSvg,
  writeTerminalSnapshotPng,
} from './screenshot.js';
import type { TerminalSnapshot } from './types.js';

const tempPaths: string[] = [];

afterEach(() => {
  for (const filePath of tempPaths.splice(0)) {
    rmSync(filePath, { force: true });
  }
});

function makeSnapshot(): TerminalSnapshot {
  return {
    version: 1,
    replayId: 'replay-demo',
    sessionId: 'session-demo',
    source: 'replay',
    timeMs: 420,
    seq: 3,
    terminal: {
      cols: 40,
      rows: 4,
      cursorX: 5,
      cursorY: 1,
      viewportY: 0,
      baseY: 0,
    },
    metadata: {
      processTitle: 'bun test',
      exitCode: 0,
    },
    screen: {
      visible: ['first line', 'second <line>', '', 'done'],
      scrollbackTail: ['older line'],
      currentLine: 'second <line>',
    },
  };
}

describe('replay screenshot rendering', () => {
  test('renders terminal snapshot as svg markup', () => {
    const svg = renderTerminalSnapshotSvg(makeSnapshot(), {
      title: 'demo',
      subtitle: 'frame 1',
      includeScrollback: true,
    });

    expect(svg).toContain('<svg');
    expect(svg).toContain('demo');
    expect(svg).toContain('frame 1');
    expect(svg).toContain('older line');
    expect(svg).toContain('second &lt;line&gt;');
  });

  test.if(findPngRasterizer() !== null)('writes terminal snapshot png output', async () => {
    const outputPath = join(tmpdir(), `gitspace-replay-shot-${Date.now()}.png`);
    tempPaths.push(outputPath);

    const writtenPath = await writeTerminalSnapshotPng(makeSnapshot(), outputPath, {
      title: 'demo screenshot',
    });

    expect(writtenPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);

    const dimensions = readPngDimensions(outputPath);
    expect(dimensions.width).toBeGreaterThan(200);
    expect(dimensions.height).toBeGreaterThan(100);
  });

  test('extracts scrollback rows when requested', async () => {
    const xterm = new XTerminal({ cols: 20, rows: 2, allowProposedApi: true, scrollback: 100 });
    await new Promise<void>((resolve) => xterm.write('one\r\ntwo\r\nthree', () => resolve()));

    const visibleRows = extractStyledRows(xterm, { trimTrailingBlank: true });
    const scrollbackRows = extractStyledRows(xterm, {
      trimTrailingBlank: true,
      includeScrollback: true,
      scrollbackLines: 5,
    });

    expect(visibleRows.map((row) => row.map((span) => span.text).join('').trimEnd())).toEqual(['two', 'three']);
    expect(scrollbackRows.map((row) => row.map((span) => span.text).join('').trimEnd())).toEqual(['one', 'two', 'three']);

    xterm.dispose();
  });
});
