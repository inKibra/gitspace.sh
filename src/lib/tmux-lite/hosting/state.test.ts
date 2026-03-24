import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearTmuxHostingState,
  readTmuxHostingState,
  writeTmuxHostingState,
} from './state.js';

const originalSessionDir = process.env.TMUX_LITE_SESSION_DIR;
const originalSocket = process.env.TMUX_LITE_SOCKET;
const originalPid = process.env.TMUX_LITE_PID_FILE;
const originalReplay = process.env.TMUX_LITE_REPLAY_DIR;

let sandboxDir: string | null = null;

afterEach(() => {
  clearTmuxHostingState();
  if (sandboxDir) {
    rmSync(sandboxDir, { recursive: true, force: true });
    sandboxDir = null;
  }
  process.env.TMUX_LITE_SESSION_DIR = originalSessionDir;
  process.env.TMUX_LITE_SOCKET = originalSocket;
  process.env.TMUX_LITE_PID_FILE = originalPid;
  process.env.TMUX_LITE_REPLAY_DIR = originalReplay;
});

describe('tmux hosting state', () => {
  it('persists selected base host and machine name', () => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'tmux-hosting-test-'));
    process.env.TMUX_LITE_SESSION_DIR = sandboxDir;
    process.env.TMUX_LITE_SOCKET = join(sandboxDir, 'tmux.sock');
    process.env.TMUX_LITE_PID_FILE = join(sandboxDir, 'tmux.pid');
    process.env.TMUX_LITE_REPLAY_DIR = join(sandboxDir, 'replays');

    const written = writeTmuxHostingState({
      baseHost: 'brad.serve.gitspace.sh',
      machineName: 'My MacBook',
      enabled: true,
    });

    expect(written.baseHost).toBe('brad.serve.gitspace.sh');
    expect(written.machineName).toBe('my-macbook');
    expect(readTmuxHostingState()).toMatchObject({
      baseHost: 'brad.serve.gitspace.sh',
      machineName: 'my-macbook',
      enabled: true,
    });
  });
});
