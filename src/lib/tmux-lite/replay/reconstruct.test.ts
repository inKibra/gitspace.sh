import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendReplayEvent,
  initializeReplay,
  updateReplayManifest,
  writeReplayCheckpoint,
} from './store.js';
import { reconstructReplayAt } from './reconstruct.js';
import { getReplayMarkdown, getReplaySnapshot, getReplayText } from './snapshot.js';
import { styledRowsToAnsi } from './service.js';
import type { ReplayCheckpoint, ReplayManifest } from './types.js';

describe('replay reconstruction', () => {
  let replayRoot: string;
  const originalReplayDir = process.env.TMUX_LITE_REPLAY_DIR;

  beforeEach(() => {
    replayRoot = mkdtempSync(join(tmpdir(), 'gitspace-replay-reconstruct-'));
    process.env.TMUX_LITE_REPLAY_DIR = replayRoot;
  });

  afterEach(() => {
    rmSync(replayRoot, { recursive: true, force: true });
    if (originalReplayDir === undefined) {
      delete process.env.TMUX_LITE_REPLAY_DIR;
    } else {
      process.env.TMUX_LITE_REPLAY_DIR = originalReplayDir;
    }
  });

  function seedReplay(): void {
    const manifest: ReplayManifest = {
      version: 1,
      replayId: 'replay_seed',
      sessionId: 'session_seed',
      sessionName: 'project:workspace:1',
      cwd: '/tmp/project/workspace',
      workspaceId: 'project:workspace',
      projectName: 'project',
      workspaceName: 'workspace',
      startedAt: 1000,
      endedAt: 1060,
      status: 'closed',
      initialTerminal: {
        cols: 80,
        rows: 24,
      },
      metadata: {
        processTitle: 'bun test',
        exitCode: 0,
      },
      stats: {
        lastSeq: 5,
        eventCount: 5,
        checkpointCount: 1,
        durationMs: 60,
      },
    };

    initializeReplay(manifest);

    const checkpoint: ReplayCheckpoint = {
      version: 1,
      checkpointId: '000000',
      seq: 1,
      t: 10,
      terminal: {
        cols: 80,
        rows: 24,
      },
      metadata: {},
      serializer: {
        kind: 'xterm-serialize',
        scrollbackLines: 1000,
      },
      ansiPath: 'checkpoints/000000.ansi',
    };
    writeReplayCheckpoint('replay_seed', checkpoint, 'hello');

    appendReplayEvent('replay_seed', {
      v: 1,
      seq: 2,
      t: 20,
      type: 'output',
      encoding: 'base64',
      data: Buffer.from('\r\nworld').toString('base64'),
    });
    appendReplayEvent('replay_seed', {
      v: 1,
      seq: 3,
      t: 30,
      type: 'resize',
      cols: 100,
      rows: 30,
    });
    appendReplayEvent('replay_seed', {
      v: 1,
      seq: 4,
      t: 40,
      type: 'process-title',
      processTitle: 'bun test',
    });
    appendReplayEvent('replay_seed', {
      v: 1,
      seq: 5,
      t: 50,
      type: 'exit',
      code: 0,
    });

    updateReplayManifest('replay_seed', (current) => ({
      ...current,
      stats: {
        ...current.stats,
        lastSeq: 5,
        eventCount: 5,
        checkpointCount: 1,
        durationMs: 60,
      },
    }));
  }

  it('reconstructs latest replay state from checkpoints and events', async () => {
    seedReplay();

    const state = await reconstructReplayAt('replay_seed');

    expect(state.seq).toBe(5);
    expect(state.cols).toBe(100);
    expect(state.rows).toBe(30);
    expect(state.processTitle).toBe('bun test');
    expect(state.exitCode).toBe(0);

    const buffer = state.xterm.buffer.active;
    expect(buffer.getLine(0)?.translateToString(true)).toBe('hello');
    expect(buffer.getLine(1)?.translateToString(true)).toBe('world');
  });

  it('reconstructs earlier timestamps without later events', async () => {
    seedReplay();

    const state = await reconstructReplayAt('replay_seed', 25);

    expect(state.seq).toBe(2);
    expect(state.cols).toBe(80);
    expect(state.rows).toBe(24);
    expect(state.exitCode).toBeUndefined();

    const buffer = state.xterm.buffer.active;
    expect(buffer.getLine(0)?.translateToString(true)).toBe('hello');
    expect(buffer.getLine(1)?.translateToString(true)).toBe('world');
  });

  it('clamps requested timestamps beyond available replay duration', async () => {
    seedReplay();

    const state = await reconstructReplayAt('replay_seed', 9999);

    expect(state.timeMs).toBe(60);
    expect(state.seq).toBe(5);
    expect(state.exitCode).toBe(0);
  });

  it('projects replay state to snapshot text and markdown', async () => {
    seedReplay();

    const snapshot = await getReplaySnapshot('replay_seed');
    const text = await getReplayText('replay_seed');
    const markdown = await getReplayMarkdown('replay_seed');

    expect(snapshot.metadata.processTitle).toBe('bun test');
    expect(snapshot.screen.visible[0]).toBe('hello');
    expect(snapshot.screen.visible[1]).toBe('world');
    expect(text).toContain('hello\nworld');
    expect(markdown).toContain('```terminal');
    expect(markdown).toContain('Process: bun test');
  });

  it('uses latest event time for running replays by default', async () => {
    const manifest: ReplayManifest = {
      version: 1,
      replayId: 'replay_running',
      sessionId: 'session_running',
      sessionName: 'project:workspace:1',
      cwd: '/tmp/project/workspace',
      workspaceId: 'project:workspace',
      projectName: 'project',
      workspaceName: 'workspace',
      startedAt: 1000,
      status: 'running',
      initialTerminal: { cols: 80, rows: 24 },
      metadata: {},
      stats: {
        lastSeq: 1,
        eventCount: 1,
        checkpointCount: 0,
        durationMs: 0,
      },
    };

    initializeReplay(manifest);
    appendReplayEvent('replay_running', {
      v: 1,
      seq: 1,
      t: 50,
      type: 'output',
      encoding: 'base64',
      data: Buffer.from('latest-output').toString('base64'),
    });

    const state = await reconstructReplayAt('replay_running');
    expect(state.timeMs).toBe(50);
    expect(state.seq).toBe(1);
    expect(state.xterm.buffer.active.getLine(0)?.translateToString(true)).toBe('latest-output');
  });

  it('tracks currentLine against the viewport when scrollback exists', async () => {
    const manifest: ReplayManifest = {
      version: 1,
      replayId: 'replay_scrollback',
      sessionId: 'session_scrollback',
      sessionName: 'project:workspace:1',
      cwd: '/tmp/project/workspace',
      workspaceId: 'project:workspace',
      projectName: 'project',
      workspaceName: 'workspace',
      startedAt: 1000,
      endedAt: 1100,
      status: 'closed',
      initialTerminal: { cols: 80, rows: 2 },
      metadata: {},
      stats: { lastSeq: 1, eventCount: 1, checkpointCount: 0, durationMs: 100 },
    };

    initializeReplay(manifest);
    appendReplayEvent('replay_scrollback', {
      v: 1,
      seq: 1,
      t: 50,
      type: 'output',
      encoding: 'base64',
      data: Buffer.from('line-1\r\nline-2\r\nline-3').toString('base64'),
    });

    const snapshot = await getReplaySnapshot('replay_scrollback');
    expect(snapshot.screen.visible).toEqual(['line-2', 'line-3']);
    expect(snapshot.screen.currentLine).toBe('line-3');
  });

  it('preserves unicode text when re-encoding styled rows to ansi', () => {
    const buffer = styledRowsToAnsi([
      [{
        text: 'hello 你好 😀',
        cells: 'hello 你好 😀'.length,
        fg: '#ffffff',
        bg: null,
        bold: false,
        italic: false,
        underline: false,
        dim: false,
        strikethrough: false,
      }],
    ]);

    const text = buffer.toString('utf8');
    expect(text).toContain('你好');
    expect(text).toContain('😀');
  });
});
