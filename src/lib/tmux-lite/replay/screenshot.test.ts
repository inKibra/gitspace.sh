import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
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

  test.if(findPngRasterizer() !== null)('writes terminal snapshot png output', () => {
    const outputPath = join(tmpdir(), `gitspace-replay-shot-${Date.now()}.png`);
    tempPaths.push(outputPath);

    const writtenPath = writeTerminalSnapshotPng(makeSnapshot(), outputPath, {
      title: 'demo screenshot',
    });

    expect(writtenPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);

    const dimensions = readPngDimensions(outputPath);
    expect(dimensions.width).toBeGreaterThan(200);
    expect(dimensions.height).toBeGreaterThan(100);
  });
});
