import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Server, Subprocess } from 'bun';

const CLI = join(import.meta.dir, '..', 'src', 'index.ts');
const READY_URL = 'http://127.0.0.1:8081';
const roots: string[] = [];
const processes: Subprocess[] = [];
const detachedPids: number[] = [];
let server: Server<undefined>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => new URL(request.url).pathname === '/v1/control'
      ? Response.json({ status: 'ok', value: { key: Buffer.alloc(32, 7).toString('base64') } })
      : new Response('ok'),
  });
});
afterAll(() => server.stop(true));
afterEach(async () => {
  for (const child of processes.splice(0)) child.kill('SIGKILL');
  for (const pid of detachedPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function liveProcess(): Subprocess {
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  processes.push(child);
  return child;
}
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}
async function configRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-cli-host-'));
  roots.push(root);
  await mkdir(join(root, 'machine'), { recursive: true });
  await mkdir(join(root, 'tools'));
  // requireSystemTools only checks that these commands resolve on PATH.
  for (const tool of ['git', 'ssh', 'ssh-agent', 'ssh-add', 'ssh-keygen']) {
    await writeFile(join(root, 'tools', tool), '#!/bin/sh\nexit 0\n');
    await chmod(join(root, 'tools', tool), 0o755);
  }
  const origin = `http://127.0.0.1:${server.port}`;
  await writeFile(join(root, 'config.json'), JSON.stringify({
    version: 4, apiUrl: origin, accountUrl: origin, handle: 'tester', userId: 'u-test', relayUrl: origin, rootPublicKey: 'root',
    machine: { id: 'm-test', label: 'Test machine', signingPrivateKey: Buffer.alloc(32, 3).toString('base64'), exchangePrivateKey: Buffer.alloc(32, 4).toString('base64'), grant: {} },
  }));
  return root;
}
async function writeHostReady(root: string, pid: number): Promise<void> {
  await writeFile(join(root, 'machine', 'host-ready.json'), JSON.stringify({ pid, hash: 'sha256:test', url: READY_URL }));
}
/** Installs a runtime whose host.js is the given bootstrap script; `bin/bun` is this test's Bun. */
async function installRuntime(root: string, bootstrap: string, extra: Record<string, string> = {}): Promise<void> {
  const runtime = join(root, 'runtime');
  await mkdir(join(runtime, 'bin'), { recursive: true });
  await mkdir(join(runtime, 'machine'));
  await symlink(process.execPath, join(runtime, 'bin', 'bun'));
  await writeFile(join(runtime, 'machine', 'machine-native.json'), '{}');
  await writeFile(join(runtime, 'host.js'), bootstrap);
  for (const [name, source] of Object.entries(extra)) await writeFile(join(runtime, name), source);
  await writeFile(join(root, 'runtime-selection.json'), JSON.stringify({ path: runtime }));
}
async function gitspace(root: string, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GITSPACE_CONFIG_HOME: root, PATH: `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}` },
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

it('reports the host from host-ready.json as running while machine.pid is stale', async () => {
  const root = await configRoot();
  const host = liveProcess();
  await writeHostReady(root, host.pid);
  await writeFile(join(root, 'machine.pid'), String(await deadPid()));
  const result = await gitspace(root, 'machine', 'status');
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(`Daemon: running (pid ${host.pid}, rpc ${READY_URL})`);
});

it('reports stopped when the host-ready pid is dead even if machine.pid names a live process', async () => {
  const root = await configRoot();
  await writeHostReady(root, await deadPid());
  await writeFile(join(root, 'machine.pid'), String(liveProcess().pid));
  const result = await gitspace(root, 'machine', 'status');
  expect(result.stdout).toContain('Daemon: stopped');
});

it('refuses to start a second host while the host-ready host is alive', async () => {
  const root = await configRoot();
  const host = liveProcess();
  await writeHostReady(root, host.pid);
  await writeFile(join(root, 'machine.pid'), String(await deadPid()));
  const result = await gitspace(root, 'machine', 'start');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Machine is already running (pid ${host.pid})`);
});

it('treats a detached successor that wrote host-ready.json as started after the spawned bootstrap exited', async () => {
  const root = await configRoot();
  // Mirrors bootstrap recovery: the updater launches a detached successor, waits for its readiness record,
  // leaves machine.pid naming itself, and exits.
  await installRuntime(root, `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const successor = spawn(process.execPath, [join(import.meta.dir, 'successor.js')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
await once(successor.stdout, 'data');
successor.unref();
writeFileSync(process.env.GITSPACE_MACHINE_PID_PATH, String(process.pid));
process.exit(0);
`, {
    'successor.js': `
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ready = join(process.env.GITSPACE_ENVIRONMENT_ROOT, 'host-ready.json');
writeFileSync(ready + '.tmp', JSON.stringify({ pid: process.pid, hash: 'sha256:test', url: '${READY_URL}' }));
renameSync(ready + '.tmp', ready);
console.log('ready');
// Keeps the fake host alive until the test kills it.
setInterval(() => {}, 60_000);
`,
  });
  const result = await gitspace(root, 'machine', 'start');
  const ready: unknown = JSON.parse(await readFile(join(root, 'machine', 'host-ready.json'), 'utf8'));
  if (typeof ready !== 'object' || ready === null || !('pid' in ready) || typeof ready.pid !== 'number') throw new Error('Successor did not record readiness');
  detachedPids.push(ready.pid);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Machine runtime ready (pid ${ready.pid})`);
  expect(alive(ready.pid)).toBe(true);
  expect(alive(Number(await readFile(join(root, 'machine.pid'), 'utf8')))).toBe(false);
});

it('starts a legacy host that only records machine.pid and announces readiness in the log', async () => {
  const root = await configRoot();
  await installRuntime(root, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.GITSPACE_MACHINE_PID_PATH, String(process.pid));
console.log('GitSpace host ready pid=' + process.pid + ' rpc=127.0.0.1:8081');
// Keeps the fake host alive until the test kills it.
setInterval(() => {}, 60_000);
`);
  const result = await gitspace(root, 'machine', 'start');
  const pid = Number(await readFile(join(root, 'machine.pid'), 'utf8'));
  detachedPids.push(pid);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(`Machine runtime ready (pid ${pid})`);
  expect(existsSync(join(root, 'machine', 'host-ready.json'))).toBe(false);
});

it('stops the host named by host-ready.json, not the process in a stale machine.pid', async () => {
  const root = await configRoot();
  const host = liveProcess();
  const unrelated = liveProcess();
  await writeHostReady(root, host.pid);
  await writeFile(join(root, 'machine.pid'), String(unrelated.pid));
  const result = await gitspace(root, 'machine', 'stop');
  expect(result.stdout).toContain('Machine stopped');
  expect(await host.exited).not.toBe(0);
  expect(alive(unrelated.pid)).toBe(true);
  expect(existsSync(join(root, 'machine.pid'))).toBe(false);
});

it('reports and stops a legacy machine.pid-only host', async () => {
  const root = await configRoot();
  const host = liveProcess();
  await writeFile(join(root, 'machine.pid'), String(host.pid));
  expect((await gitspace(root, 'machine', 'status')).stdout).toContain(`Daemon: running (pid ${host.pid})`);
  const result = await gitspace(root, 'machine', 'stop');
  expect(result.stdout).toContain('Machine stopped');
  expect(await host.exited).not.toBe(0);
  expect((await gitspace(root, 'machine', 'status')).stdout).toContain('Daemon: stopped');
});
