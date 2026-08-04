/**
 * FD-leak regression test: churning PTY sessions through create+terminate must
 * not grow the daemon's open file-descriptor count. Bun.Terminal holds the PTY
 * master (/dev/ptmx) and its pts slave; if those aren't closed on cleanup the
 * daemon leaks ~4 fds per session and eventually fails posix_spawn with EBADF
 * (acute on macOS where the default soft NOFILE limit is 256).
 *
 * Linux-only: it reads /proc/<pid>/fd to count descriptors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { readdirSync } from 'fs';
import { join } from 'path';
import { getTmuxLitePathsForSandbox, removeTmuxLiteSandbox } from './protocol';

const isLinux = process.platform === 'linux';
const SANDBOX = `fdleak-${process.pid}`;
const SERVER_SCRIPT = join(import.meta.dir, 'server.ts');

const paths = getTmuxLitePathsForSandbox(SANDBOX);

function applyEnv(): void {
  process.env.TMUX_LITE_SANDBOX = SANDBOX;
  process.env.TMUX_LITE_SOCKET = paths.routerSocket;
  process.env.TMUX_LITE_SESSION_DIR = paths.sessionDir;
  process.env.TMUX_LITE_PID_FILE = paths.pidFile;
}

function cleanup(): void {
  removeTmuxLiteSandbox(SANDBOX);
  delete process.env.TMUX_LITE_SANDBOX;
  delete process.env.TMUX_LITE_SOCKET;
  delete process.env.TMUX_LITE_SESSION_DIR;
  delete process.env.TMUX_LITE_PID_FILE;
}

function fdCount(pid: number): number {
  return readdirSync(`/proc/${pid}/fd`).length;
}

let daemon: Subprocess | null = null;
let send!: (cmd: any) => Promise<any>;

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await send({ type: 'list' });
      if (r && r.type) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  return false;
}

async function churn(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await send({ type: 'new', name: `fdl-${i}-${Date.now()}`, cwd: '/tmp' });
    const id = res.session?.id ?? res.session;
    if (!id) continue;
    await Bun.sleep(50);
    await send({ type: 'terminate', id, mode: 'force' });
    await Bun.sleep(50);
  }
}

describe.if(isLinux)('tmux-lite daemon fd-leak regression', () => {
  beforeAll(async () => {
    cleanup();
    applyEnv();
    ({ send } = await import('./cli'));
    daemon = spawn({
      cmd: ['bun', SERVER_SCRIPT],
      env: { ...process.env } as Record<string, string>,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const up = await waitForServer();
    if (!up) throw new Error('daemon failed to start for fd-leak test');
    await Bun.sleep(400);
  });

  afterAll(async () => {
    try { await send({ type: 'kill-server' }); } catch {}
    await Bun.sleep(200);
    try { daemon?.kill(); } catch {}
    cleanup();
  });

  it('does not grow the daemon fd count across create+terminate cycles', async () => {
    const pid = daemon!.pid;
    // Warm-up: first sessions allocate lazily-created shared resources.
    await churn(3);
    await Bun.sleep(500);
    const before = fdCount(pid);

    const N = 20;
    await churn(N);
    await Bun.sleep(700);
    const after = fdCount(pid);

    // No live sessions should remain.
    const list = await send({ type: 'list' });
    expect((list.sessions ?? []).length).toBe(0);

    // Allow a tiny amount of slack for unrelated daemon bookkeeping, but the
    // pre-fix leak was ~4 fds/cycle (≈80 over 20 cycles) — must stay bounded.
    expect(after - before).toBeLessThanOrEqual(4);
  }, 60_000);
});
