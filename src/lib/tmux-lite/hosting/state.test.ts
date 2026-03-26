import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function configureSandbox(): string {
  sandboxDir = mkdtempSync(join(tmpdir(), 'tmux-hosting-test-'));
  process.env.TMUX_LITE_SESSION_DIR = sandboxDir;
  process.env.TMUX_LITE_SOCKET = join(sandboxDir, 'tmux.sock');
  process.env.TMUX_LITE_PID_FILE = join(sandboxDir, 'tmux.pid');
  process.env.TMUX_LITE_REPLAY_DIR = join(sandboxDir, 'replays');
  return join(sandboxDir, '.gitspace-hosting.json');
}

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
    configureSandbox();

    const written = writeTmuxHostingState({
      baseHost: 'brad.gitspace.sh',
      machineName: 'My MacBook',
      enabled: true,
    });

    expect(written.baseHost).toBe('brad.gitspace.sh');
    expect(written.machineName).toBe('my-macbook');
    expect(readTmuxHostingState()).toMatchObject({
      baseHost: 'brad.gitspace.sh',
      machineName: 'my-macbook',
      enabled: true,
    });
  });

  it('repairs persisted double-serve hosts when reading state', () => {
    const statePath = configureSandbox();
    writeFileSync(statePath, `${JSON.stringify({
      baseHost: 'brad.serve.serve.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: 123,
    }, null, 2)}\n`, 'utf-8');

    expect(readTmuxHostingState()).toMatchObject({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: 123,
    });
    expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toMatchObject({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: 123,
    });
  });

  it('drops legacy router runtime state when reading persisted config', () => {
    const statePath = configureSandbox();
    writeFileSync(statePath, `${JSON.stringify({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      routerPid: 9999,
      updatedAt: 123,
    }, null, 2)}\n`, 'utf-8');

    expect(readTmuxHostingState()).toEqual({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: 123,
    });
    expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: 123,
    });
  });
});
