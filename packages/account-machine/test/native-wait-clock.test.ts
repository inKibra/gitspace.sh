import { expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { protectedLifecycleWrapper } from '../src/protected-lifecycle.js';

const source = (name: string) => resolve(import.meta.dir, '../src', name);

// Each fixture has its own JS globals and module mocks. Only the clocks and
// external ownership/readiness boundaries are simulated; the wait loops run
// from their production modules, with their full production budgets intact.
async function isolated(program: string) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-clock-wait-'));
  try {
    const file = join(root, 'fixture.ts');
    await writeFile(file, `const root = ${JSON.stringify(root)};\n${program}`);
    const child = Bun.spawn([process.execPath, file], {
      stdout: 'pipe', stderr: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITSPACE_'))),
    });
    // A watchdog only bounds a broken fixture; it never drives the tested wait.
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return z.object({
        error: z.string().nullable().optional(),
        elapsed: z.number(),
        sleeps: z.number().optional(),
        code: z.number().optional(),
      }).parse(JSON.parse(stdout.trim().split('\n').at(-1)!));
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function clock(direction: number, timeout: boolean) {
  return `
    let elapsed = 0, sleeps = 0;
    const epoch = Date.now();
    Date.now = () => epoch + (sleeps ? ${direction} * 86400000 : 0);
    Object.defineProperty(performance, 'now', { value: () => elapsed });
    Bun.sleep = async () => {
      if (++sleeps > 20) throw new Error('Wait exceeded its original elapsed budget');
      elapsed += ${timeout ? 10_001 : 100};
      await onSleep();
    };
    let onSleep = async () => {};
  `;
}

for (const category of ['drain', 'successor', 'handoff', 'lock'] as const) {
  for (const timeout of [false, true]) {
    it(`${category} ${timeout ? 'expires after elapsed time despite a backward wall-clock jump' : 'completes despite a forward wall-clock jump'}`, async () => {
      const result = await isolated(`
        import { mock } from 'bun:test';
        import { readFile, writeFile } from 'node:fs/promises';
        ${clock(timeout ? -1 : 1, timeout)}
        const category = ${JSON.stringify(category)};
        const timeout = ${timeout};
        process.env.GITSPACE_ENVIRONMENT_ROOT = root;
        process.env.GITSPACE_UPDATE_HANDOFF = '1';
        mock.module(${JSON.stringify(resolve(import.meta.dir, '../../deployment/src/native-runtime.js'))}, () => ({ prepareMachineNativeRuntime() {} }));
        mock.module(${JSON.stringify(import.meta.resolve('@gitspace/deployment'))}, () => ({
          hashArtifactPath: async () => 'fixture',
          prepareBootstrapMigration() { throw new Error('Unexpected migration'); },
          DeploymentSqliteConnection: class {
            database = { exec() {
              if (category === 'lock' && (timeout || sleeps < 3)) throw new Error('locked');
            }};
            close() {}
          },
        }));
        // Expose private entry points only in this disposable runtime; no
        // production API is added merely to make the tests reach a wait.
        Bun.plugin({ name: 'private-wait-entrypoints', setup(build) {
          build.onLoad({ filter: /machine-update\\.ts$/ }, async ({ path }) => ({
            contents: await readFile(path, 'utf8') + '\\nexport { waitDead, startHost, children };', loader: 'ts',
          }));
        }});
        // The runtime loader hook must be installed before this module loads.
        const update = await import(${JSON.stringify(source('machine-update.ts'))});
        const selection = { version: 1, path: root, hash: 'fixture', releaseSha: null };
        for (const name of ['host-runtime.js', 'machine-update.js', 'machine-bootstrap.js', 'machine.js', 'machine-worker.js'])
          await writeFile(root + '/' + name, '');
        // Readiness tests need a live owned process, not an empty entrypoint
        // that can exit before the parent polls it. This timer only keeps the
        // disposable process alive; the parent still drives elapsed time.
        await writeFile(root + '/host-runtime.js', 'setInterval(() => {}, 60000);');
        const transaction = { version: 1, pid: process.pid, successorPid: process.pid,
          candidate: selection, predecessor: selection, phase: 'committed', checkpoint: root + '/checkpoint' };
        if (category !== 'handoff') await update.atomicJson(root + '/machine-update.json', transaction);
        if (category === 'drain') {
          process.kill = () => {
            if (!timeout && sleeps >= 3) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
            return true;
          };
        }
        globalThis.fetch = async () => new Response('healthy');
        onSleep = async () => {
          if (timeout || sleeps !== 3) return;
          if (category === 'handoff') await update.atomicJson(root + '/machine-update.json', transaction);
          if (category === 'successor') await update.atomicJson(root + '/host-ready.json', {
            pid: transaction.successorPid, hash: 'fixture', url: 'http://fixture.invalid',
          });
        };
        let error = null;
        try {
          if (category === 'drain') await update.waitDead(process.pid);
          else if (category === 'successor') await update.startHost(root, selection, transaction);
          else await update.runMachineUpdate();
        } catch (caught) { error = String(caught); }
        finally {
          const child = update.children.get(transaction.successorPid);
          if (child) {
            const exited = Promise.withResolvers();
            child.once('exit', exited.resolve);
            child.kill('SIGKILL');
            await exited.promise;
          }
        }
        console.log(JSON.stringify({ error, elapsed, sleeps }));
      `);
      if (timeout) {
        const message = {
          drain: 'did not drain; replacement remains fenced',
          successor: 'Complete successor host failed readiness',
          handoff: 'Updater handoff was not durably acknowledged',
          lock: 'Another update process owns this machine',
        }[category];
        expect(result.error).toContain(message);
        const budget = category === 'drain' || category === 'successor' ? 150_000 : 30_000;
        expect(result.elapsed).toBeGreaterThan(budget);
        expect(result.elapsed).toBeLessThanOrEqual(budget + 10_001);
      } else {
        expect(result).toEqual({ error: null, elapsed: 300, sleeps: 3 });
      }
    });
  }
}

for (const category of ['owner', 'orphan'] as const) {
  for (const timeout of [false, true]) {
    it(`host ${category} ${timeout ? 'retains its elapsed timeout across a backward clock jump' : 'accepts completion across a forward clock jump'}`, async () => {
      const result = await isolated(`
        import { mock } from 'bun:test';
        ${clock(timeout ? -1 : 1, timeout)}
        const timeout = ${timeout};
        const category = ${JSON.stringify(category)};
        process.env.GITSPACE_ENVIRONMENT_ROOT = root;
        process.env.GITSPACE_HOST_SELECTION = '{}';
        process.env.GITSPACE_ARTIFACT_KEY = Buffer.alloc(32).toString('base64');
        process.env.GITSPACE_MACHINE_ID = 'clock-fixture';
        process.env.GITSPACE_UPDATE_OWNER = category === 'owner' ? '123' : '';
        mock.module(${JSON.stringify(source('machine-update.ts'))}, () => ({
          verifyMachine: async () => {}, acquireMachineLock: () => () => {}, atomicJson: async () => {},
          alive: pid => pid === 123 || (pid === 456 && (timeout || sleeps < 3)),
          readJson: async path => {
            if (path.endsWith('machine-update.json'))
              return category === 'owner' && !timeout && sleeps >= 3 ? { pid: 123, successorPid: process.pid } : null;
            if (path.endsWith('host-machine.json') && category === 'orphan')
              return { pid: 456, hostPid: 789, url: 'http://fixture.invalid' };
            return null;
          },
        }));
        mock.module(${JSON.stringify(source('replacement-environment.ts'))}, () => ({
          ReplacementEnvironment: class { constructor() { throw new Error('Reached boot after fencing'); } },
        }));
        mock.module(${JSON.stringify(source('relay-connector.ts'))}, () => ({ MachineRelayConnector: class {} }));
        process.kill = () => true;
        globalThis.fetch = async () => Response.json({ stopMode: 'replace' });
        let error;
        // Load only after installing isolated boot-boundary mocks.
        try { await import(${JSON.stringify(source('host.ts'))}); }
        catch (caught) { error = String(caught); }
        console.log(JSON.stringify({ error, elapsed, sleeps }));
      `);
      if (timeout) {
        expect(result.error).toContain(category === 'owner'
          ? 'Complete-host launch was not durably authorized'
          : 'Orphan machine did not drain; startup remains fenced');
        const budget = category === 'owner' ? 30_000 : 150_000;
        expect(result.elapsed).toBeGreaterThan(budget);
        expect(result.elapsed).toBeLessThanOrEqual(budget + 10_001);
      } else {
        expect(result).toEqual({ error: 'Error: Reached boot after fencing', elapsed: 300, sleeps: 3 });
      }
    });
  }
}

for (const direction of [-1, 1]) {
  it(`protected runner uses its entry-time remaining budget after a ${direction < 0 ? 'backward' : 'forward'} wall-clock jump`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitspace-protected-clock-'));
    try {
      const spoolPath = join(root, 'runner.log');
      const wrapper = protectedLifecycleWrapper({
        socketPath: join(root, 'live.sock'), spoolPath, cwd: root,
        deadline: 1_000_250, envNames: [], steps: [],
      });
      // This is a real generated program and socket server. Exercise the
      // platform deadline timer while the runner waits for its first observer.
      const result = await isolated(`
        let wall = 1_000_000;
        Date.now = () => wall;
        queueMicrotask(() => { wall += ${direction} * 86400000; });
        const started = performance.now();
        const originalExit = process.exit;
        process.exit = code => {
          console.log(JSON.stringify({ code, elapsed: performance.now() - started }));
          originalExit(0);
        };
        ${wrapper}
      `);
      expect(result.code).toBe(124);
      expect(result.elapsed).toBeGreaterThanOrEqual(200);
      expect(result.elapsed).toBeLessThan(5_000);
      expect(await readFile(spoolPath, 'utf8')).toContain('__GITSPACE_PROTECTED_CLEAN__');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const direction of [-1, 1]) {
  it(`protected runner completes an attached plan after a ${direction < 0 ? 'backward' : 'forward'} wall-clock jump`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitspace-protected-clock-'));
    try {
      const socketPath = join(root, 'live.sock');
      const wrapper = protectedLifecycleWrapper({
        socketPath, spoolPath: join(root, 'runner.log'), cwd: root,
        deadline: 1_030_000, envNames: [], steps: [],
      });
      const result = await isolated(`
        import { connect } from 'node:net';
        let wall = 1_000_000;
        Date.now = () => wall;
        const started = performance.now();
        const originalExit = process.exit;
        process.exit = code => {
          console.log(JSON.stringify({ code, elapsed: performance.now() - started }));
          originalExit(0);
        };
        // listen() binds before the generated runner awaits its readiness
        // promise. Attach through the actual socket, rather than guessing a delay.
        queueMicrotask(() => {
          wall += ${direction} * 86400000;
          const peer = connect(${JSON.stringify(socketPath)});
          peer.on('connect', () => {
            peer.write('{"op":"live"}\\n');
          });
          peer.resume();
        });
        ${wrapper}
      `);
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
