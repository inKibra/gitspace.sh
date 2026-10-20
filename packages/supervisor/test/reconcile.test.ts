import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClientForProject } from '../src/client.js';
import { reconcileBrokers } from '../src/reconcile.js';
import { getDaemonRuntimeDir } from '../src/process-identity.js';
import type { DaemonStartSpec } from '../src/protocol.js';

const sleeper = (cwd: string): DaemonStartSpec => ({ name: 'dev-server', application: '/bin/sh', args: ['-c', 'exec sleep 300'], env: {}, cwd, pty: false, restart: 'no', persist: true, detached: false });
const running = (pid: number | null | undefined) => pid != null && existsSync(`/proc/${pid}`);

test('a machine start keeps brokers running processes, ends idle ones, stops those of deleted projects and prunes the rest', async () => {
  const base = await mkdtemp(join(tmpdir(), 'gitspace-reconcile-'));
  process.env.GITSPACE_SUPERVISOR_HOME = join(base, 'home');
  const [busy, idle, deleted] = ['busy', 'idle', 'deleted'].map(name => join(base, name));
  for (const project of [busy!, idle!, deleted!]) await mkdir(project);
  const busyClient = await daemonClientForProject(busy!);
  try {
    const kept = await busyClient.request({ op: 'start', spec: sleeper(busy!) });
    await daemonClientForProject(idle!);
    const doomed = await (await daemonClientForProject(deleted!)).request({ op: 'start', spec: sleeper(deleted!) });
    if (kept.op !== 'start' || doomed.op !== 'start') throw new Error('Unexpected start response');
    await rm(deleted!, { recursive: true });
    const stale = join(process.env.GITSPACE_SUPERVISOR_HOME, 'stale');
    await mkdir(stale);
    await writeFile(join(stale, 'broker.json'), JSON.stringify({ project: join(base, 'gone') }));

    const outcomes = await reconcileBrokers();
    expect(Object.fromEntries(outcomes.map(item => [item.project, [item.outcome, item.live]]))).toEqual({
      [busy!]: ['captured', ['dev-server']],
      [idle!]: ['shut-down', []],
      [deleted!]: ['stopped', ['dev-server']],
      [join(base, 'gone')]: ['pruned', []],
    });
    expect(running(kept.daemon.pid)).toBe(true);
    // The broker and the stopped process are separate OS processes: their exit is observed, not driven by a clock.
    for (let wait = 0; wait < 50 && (running(doomed.daemon.pid) || existsSync(join(getDaemonRuntimeDir(idle!), 'broker.sock'))); wait += 1) await Bun.sleep(100);
    expect(running(doomed.daemon.pid)).toBe(false);
    expect(existsSync(join(getDaemonRuntimeDir(idle!), 'broker.sock'))).toBe(false);
    expect(existsSync(stale)).toBe(false);
  } finally {
    await busyClient.request({ op: 'stop', name: 'dev-server' }).catch(() => null);
    await busyClient.request({ op: 'shutdown' }).catch(() => null);
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
