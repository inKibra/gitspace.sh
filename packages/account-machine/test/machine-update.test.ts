import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExecutableArtifactManifest, nativeHostAbi } from '@gitspace/account-omp/manifest';
import { nativeFileDigest } from '../../deployment/src/native-runtime.js';
import { alive, atomicJson, readJson, type MachineSelection } from '../src/machine-update.js';

const source = (name: string) => pathToFileURL(resolve(import.meta.dir, '../src', name)).href;
const fixtures: Array<{ root: string; child: Bun.Subprocess }> = [];
const token = 'disposable-update-control';
type Ready = { pid: number; hash: string; url: string };

async function eventually<T>(action: () => Promise<T | null | false>, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(async () => {
  for (const { root, child } of fixtures.splice(0)) {
    const update = await readJson<{ pid: number }>(join(root, 'machine-update.json'));
    if (update && alive(update.pid)) {
      process.kill(update.pid, 'SIGTERM');
      await eventually(async () => !alive(update.pid), 'fixture updater shutdown');
    }
    const ready = await readJson<Ready>(join(root, 'host-ready.json'));
    if (ready && alive(ready.pid)) {
      process.kill(ready.pid, 'SIGTERM');
      await eventually(async () => !alive(ready.pid), 'fixture host shutdown');
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

async function artifact(root: string, label: string, healthy = true, paused = false) {
  const path = join(root, 'bundles', label);
  await mkdir(join(path, 'native'), { recursive: true });
  await writeFile(join(path, 'native/walgit'), '#!/bin/sh\necho fixture-walgit\n', { mode: 0o755 });
  await writeFile(
    join(path, 'machine-native.json'),
    JSON.stringify({
      version: 1,
      bunVersion: Bun.version,
      abi: nativeHostAbi(),
      walgit: {
        source: 'release',
        path: 'native/walgit',
        ...(await nativeFileDigest(join(path, 'native/walgit'))),
        provenance: null,
      },
    }),
  );
  await writeFile(
    join(path, 'host-runtime.js'),
    `
    await Bun.write(process.env.GITSPACE_ENVIRONMENT_ROOT + '/host-code', ${JSON.stringify(label)});
    await import(${JSON.stringify(source('host.ts'))});
  `,
  );
  await writeFile(
    join(path, 'machine-update.js'),
    `
    import { runMachineUpdate } from ${JSON.stringify(source('machine-update.ts'))};
    export { runMachineUpdate };
    if (import.meta.main) await runMachineUpdate();
  `,
  );
  await writeFile(
    join(path, 'machine-bootstrap.js'),
    `
    import { startMachineHost } from ${JSON.stringify(source('machine-bootstrap.ts'))};
    export { startMachineHost };
    if (import.meta.main) await startMachineHost();
  `,
  );
  await writeFile(
    join(path, 'machine.js'),
    `
    import { Database } from 'bun:sqlite';
    import { appendFile } from 'node:fs/promises';
    const { requestMachineUpdate } = await import(${JSON.stringify(source('machine-update.ts'))});
    const root = process.env.GITSPACE_ENVIRONMENT_ROOT;
    // An OS-owned lock rejects overlap but disappears even after SIGKILL.
    const exclusive = new Database(root + '/fixture-writer.sqlite');
    exclusive.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    await appendFile(root + '/lifecycle', 'start ${label} ' + process.pid + '\\n');
    const db = new Database(root + '/gitspace.db');
    db.exec('CREATE TABLE IF NOT EXISTS retained(value TEXT)');
    db.exec("INSERT INTO retained SELECT 'user-work' WHERE NOT EXISTS (SELECT 1 FROM retained)");
    if (!${healthy}) db.exec("UPDATE retained SET value = 'failed-candidate'");
    let retired = false;
    let stopping = false;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/__control/retire') { retired = true; return Response.json({ stopMode: 'replace' }); }
      if (path === '/fixture/update') {
        const selection = await request.json();
        setTimeout(() => void requestMachineUpdate(selection, process.env.GITSPACE_HOST_URL, process.env.GITSPACE_CONTROL_TOKEN).catch(async error => {
          await Bun.write(root + '/request-error', String(error));
        }), 0);
        return Response.json({ accepted: true });
      }
      if (path === '/fixture/state') return Response.json({ label: ${JSON.stringify(label)}, pid: process.pid, value: db.query('SELECT value FROM retained').get().value });
      return new Response('health', { status: ${healthy ? 200 : 503} });
    }});
    process.env.GITSPACE_MACHINE_LOCAL_URL = 'http://127.0.0.1:' + server.port;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await appendFile(root + '/lifecycle', 'stop ${label} ' + process.pid + ' retired=' + retired + '\\n');
      db.close();
      await server.stop(true);
      exclusive.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    if (${paused}) {
      await Bun.write(root + '/candidate-waiting', String(process.pid));
      await Promise.withResolvers().promise;
    }
    console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
  `,
  );
  const built = await createExecutableArtifactManifest(path, 'machine', null, nativeHostAbi());
  return {
    selection: { version: 1, path, hash: built.manifest.treeHash, releaseSha: label } satisfies MachineSelection,
    manifestHash: built.manifestHash,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-whole-update-'));
  const initial = await artifact(root, 'initial');
  const next = await artifact(root, 'next');
  const bad = await artifact(root, 'unhealthy', false);
  await atomicJson(join(root, 'host-selection.json'), initial.selection);
  await atomicJson(join(root, 'machine-selection.json'), initial.selection);
  const environment = {
    // A fixture is a fresh installation, not a successor of the hosting machine.
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITSPACE_'))),
    GITSPACE_ENVIRONMENT_ROOT: root,
    GITSPACE_HOST_SELECTION: JSON.stringify(initial.selection),
    GITSPACE_BUNDLE_ROOT: root,
    GITSPACE_INITIAL_MACHINE_MANIFEST_HASH: initial.manifestHash,
    GITSPACE_MACHINE_ID: 'disposable-whole-machine',
    GITSPACE_ARTIFACT_KEY: Buffer.alloc(32, 1).toString('base64'),
    GITSPACE_OMP_AGENT_DIR: join(root, 'omp'),
    GITSPACE_CONTROL_TOKEN: token,
    GITSPACE_RPC_HOST: '127.0.0.1',
    GITSPACE_RPC_PORT: '0',
    GITSPACE_WEB_PORT: '0',
    GITSPACE_RELAY_URL: '',
    GITSPACE_MACHINE_PID_PATH: join(root, 'machine.pid'),
  };
  const child = Bun.spawn([process.execPath, join(initial.selection.path, 'host-runtime.js')], {
    cwd: root,
    stdout: 'ignore',
    stderr: Bun.file(join(root, 'host.log')),
    env: environment,
  });
  fixtures.push({ root, child });
  const ready = await eventually(async () => {
    const value = await readJson<Ready>(join(root, 'host-ready.json'));
    return value?.hash === initial.selection.hash && value;
  }, 'initial complete host');
  return { root, initial, next, bad, ready, environment };
}

async function request(ready: Ready, selection: MachineSelection) {
  const response = await fetch(`${ready.url}/fixture/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(selection),
  });
  expect(response.ok).toBe(true);
}

it('replaces both host and machine, preserves work, and supports a reverse update', async () => {
  const { root, initial, next, ready } = await fixture();
  await request(ready, next.selection);
  const updated = await eventually(async () => {
    const selected = await readJson<MachineSelection>(join(root, 'host-selection.json'));
    const current = await readJson<Ready>(join(root, 'host-ready.json'));
    return (
      selected?.hash === next.selection.hash &&
      current?.hash === selected.hash &&
      !(await readJson(join(root, 'machine-update.json'))) &&
      current
    );
  }, 'whole release commit and updater exit');
  expect(updated.pid).not.toBe(ready.pid);
  expect(alive(ready.pid)).toBe(false);
  expect(await readFile(join(root, 'host-code'), 'utf8')).toBe('next');
  expect(await (await fetch(`${updated.url}/fixture/state`)).json()).toMatchObject({
    label: 'next',
    value: 'user-work',
  });
  expect(await readFile(join(root, 'lifecycle'), 'utf8')).toContain('retired=true');

  await request(updated, initial.selection);
  const reverted = await eventually(async () => {
    const current = await readJson<Ready>(join(root, 'host-ready.json'));
    return current?.hash === initial.selection.hash && !(await readJson(join(root, 'machine-update.json'))) && current;
  }, 'reverse complete update');
  expect(reverted.pid).not.toBe(ready.pid);
  expect(alive(updated.pid)).toBe(false);
  expect(await readFile(join(root, 'host-code'), 'utf8')).toBe('initial');
  expect(await (await fetch(`${reverted.url}/fixture/state`)).json()).toMatchObject({
    label: 'initial',
    value: 'user-work',
  });
}, 60_000);

it('restores the whole predecessor and its data after an unhealthy candidate', async () => {
  const { root, initial, bad, ready } = await fixture();
  await request(ready, bad.selection);
  const reverted = await eventually(async () => {
    const failure = await readJson<{ sha: string }>(join(root, 'machine-update-failure.json'));
    const current = await readJson<Ready>(join(root, 'host-ready.json'));
    return (
      failure?.sha === bad.selection.releaseSha &&
      current?.hash === initial.selection.hash &&
      !(await readJson(join(root, 'machine-update.json'))) &&
      current
    );
  }, 'failed candidate rollback');
  expect(reverted.pid).not.toBe(ready.pid);
  expect(await readFile(join(root, 'host-code'), 'utf8')).toBe('initial');
  expect(await (await fetch(`${reverted.url}/fixture/state`)).json()).toMatchObject({
    label: 'initial',
    value: 'user-work',
  });
  const database = new Database(join(root, 'gitspace.db'), { readonly: true });
  try {
    expect(database.query('SELECT value FROM retained').get()).toEqual({ value: 'user-work' });
  } finally {
    database.close();
  }
}, 60_000);

it('recovers an updater crash after the candidate starts without admitting two writers', async () => {
  const { root, initial, ready, environment } = await fixture();
  const interrupted = await artifact(root, 'interrupted', false, true);
  await request(ready, interrupted.selection);
  const transaction = await eventually(async () => {
    const pending = await readJson<{ pid: number; phase: string; successorPid?: number }>(
      join(root, 'machine-update.json'),
    );
    const waiting = await readFile(join(root, 'candidate-waiting'), 'utf8').catch(() => null);
    return pending?.phase === 'starting' && pending.successorPid && waiting && pending;
  }, 'candidate mutation before health gate');
  // Kill only the disposable updater. Its replacement must stop the surviving
  // candidate before restoring the checkpoint and starting the predecessor.
  process.kill(transaction.pid, 'SIGKILL');
  await eventually(async () => !alive(transaction.pid), 'updater death');
  const recovery = Bun.spawn([process.execPath, join(initial.selection.path, 'machine-bootstrap.js')], {
    cwd: root,
    env: environment,
    stdout: 'ignore',
    stderr: Bun.file(join(root, 'recovery.log')),
  });
  const code = await recovery.exited;
  if (code !== 0)
    throw new Error(
      `Recovery exited ${code}:\n${await readFile(join(root, 'recovery.log'), 'utf8')}\n${await readFile(join(root, 'machine.log'), 'utf8')}`,
    );
  expect(code).toBe(0);
  const restored = await eventually(async () => {
    const current = await readJson<Ready>(join(root, 'host-ready.json'));
    return current?.hash === initial.selection.hash && !(await readJson(join(root, 'machine-update.json'))) && current;
  }, 'restart recovery');
  expect(alive(transaction.successorPid!)).toBe(false);
  expect(await (await fetch(`${restored.url}/fixture/state`)).json()).toMatchObject({
    label: 'initial',
    value: 'user-work',
  });
  expect(await readFile(join(root, 'host-code'), 'utf8')).toBe('initial');
}, 60_000);
