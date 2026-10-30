import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClientForProject } from '../src/client.js';
import { reconcileBrokers } from '../src/reconcile.js';
import { getDaemonRuntimeDir } from '../src/process-identity.js';
import { ProcessIdentitySchema, type DaemonStartSpec } from '../src/protocol.js';

const sleeper = (cwd: string): DaemonStartSpec => ({ name: 'dev-server', application: '/bin/sh', args: ['-c', 'exec sleep 300'], env: {}, cwd, pty: false, restart: 'no', persist: true, detached: false });
const running = (pid: number | null | undefined) => pid != null && existsSync(`/proc/${pid}`);

test('a machine start keeps brokers running processes, ends idle ones, stops those of deleted projects and prunes the rest', async () => {
  const base = await mkdtemp(join(tmpdir(), 'gitspace-reconcile-'));
  process.env.GITSPACE_SUPERVISOR_HOME = join(base, 'home');
  const [busy, idle, deleted, legacy] = ['busy', 'idle', 'deleted', 'legacy'].map(name => join(base, name));
  for (const project of [busy!, idle!, deleted!, legacy!]) await mkdir(project);
  const busyClient = await daemonClientForProject(busy!);
  try {
    const kept = await busyClient.request({ op: 'start', spec: sleeper(busy!) });
    await daemonClientForProject(idle!);
    // A broker started before brokers recorded their project.
    await daemonClientForProject(legacy!);
    await rm(join(getDaemonRuntimeDir(legacy!), 'broker.json'));
    const doomed = await (await daemonClientForProject(deleted!)).request({ op: 'start', spec: sleeper(deleted!) });
    if (kept.op !== 'start' || doomed.op !== 'start') throw new Error('Unexpected start response');
    await rm(deleted!, { recursive: true });
    const stale = join(process.env.GITSPACE_SUPERVISOR_HOME, 'stale');
    await mkdir(stale);
    await writeFile(join(stale, 'broker.json'), JSON.stringify({ project: join(base, 'gone') }));

    const outcomes = await reconcileBrokers();
    expect(Object.fromEntries(outcomes.map(item => [item.project ?? item.directory, [item.outcome, item.live]]))).toEqual({
      [busy!]: ['captured', ['dev-server']],
      [idle!]: ['shut-down', []],
      [deleted!]: ['stopped', ['dev-server']],
      [join(base, 'gone')]: ['pruned', []],
      [getDaemonRuntimeDir(legacy!)]: ['shut-down', []],
    });
    expect(running(kept.daemon.pid)).toBe(true);
    // The broker and the stopped process are separate OS processes: their exit is observed, not driven by a clock.
    for (let wait = 0; wait < 50 && (running(doomed.daemon.pid) || [idle!, legacy!].some(project => existsSync(join(getDaemonRuntimeDir(project), 'broker.sock')))); wait += 1) await Bun.sleep(100);
    expect(running(doomed.daemon.pid)).toBe(false);
    for (const project of [idle!, legacy!]) expect(existsSync(join(getDaemonRuntimeDir(project), 'broker.sock'))).toBe(false);
    expect(existsSync(stale)).toBe(false);
  } finally {
    await busyClient.request({ op: 'stop', name: 'dev-server' }).catch(() => null);
    await busyClient.request({ op: 'shutdown' }).catch(() => null);
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test('a request after its broker exited (idle or reconciled) starts a new broker instead of failing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'gitspace-broker-gone-'));
  process.env.GITSPACE_SUPERVISOR_HOME = join(base, 'home');
  const project = join(base, 'project');
  await mkdir(project);
  const client = await daemonClientForProject(project);
  try {
    await client.request({ op: 'shutdown' });
    const socket = join(getDaemonRuntimeDir(project), 'broker.sock');
    // The broker is a separate OS process: its exit is observed, not driven by a clock.
    for (let wait = 0; wait < 50 && existsSync(socket); wait += 1) await Bun.sleep(100);
    expect(existsSync(socket)).toBe(false);
    expect((await client.request({ op: 'list' })).op).toBe('list');
    expect(existsSync(socket)).toBe(true);
  } finally {
    await (await daemonClientForProject(project)).request({ op: 'shutdown' }).catch(() => null);
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test('a broker whose shutdown fails exits, and the next request reaches a new broker instead of being refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'gitspace-broker-stuck-'));
  process.env.GITSPACE_SUPERVISOR_HOME = join(base, 'home');
  const project = join(base, 'project');
  await mkdir(project);
  const orphan = join(base, 'orphan.pid');
  const client = await daemonClientForProject(project);
  try {
    // The shell exits at once; its setsid child keeps the output pipe open, so the shutdown cannot confirm the exit.
    await client.request({ op: 'start', spec: { ...sleeper(project), name: 'leaky', args: ['-c', `setsid sh -c 'echo $$ > ${orphan}; exec sleep 300' &`] } });
    const owner = ProcessIdentitySchema.parse(JSON.parse(await readFile(join(getDaemonRuntimeDir(project), 'broker.lock', 'owner.json'), 'utf8')));
    await expect(client.request({ op: 'shutdown' })).rejects.toThrow('Process exit stream did not close after termination');
    expect((await client.request({ op: 'watch', timeoutMs: 1 })).op).toBe('watch');
    expect(running(owner.pid)).toBe(false);
  } finally {
    const pid = Number(await readFile(orphan, 'utf8').catch(() => '0'));
    if (pid > 0) process.kill(pid, 'SIGKILL');
    await (await daemonClientForProject(project)).request({ op: 'shutdown' }).catch(() => null);
    await rm(base, { recursive: true, force: true });
  }
}, 60_000);
