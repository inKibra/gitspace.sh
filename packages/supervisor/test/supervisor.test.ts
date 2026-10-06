import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../src/supervisor.js';
import { DaemonResponseSchema, type DaemonStartSpec } from '../src/protocol.js';
import { TerminalProjection } from '../src/terminal-output.js';
import * as identities from '../src/process-identity.js';
const fixtures: { root: string; supervisor: ProcessSupervisor }[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-supervisor-test-'));
  const supervisor = new ProcessSupervisor(root);
  await supervisor.recover();
  fixtures.push({ root, supervisor });
  return supervisor;
}
function spec(name: string, script: string): DaemonStartSpec {
  return { name, application: '/bin/sh', args: ['-c', script], env: {}, cwd: tmpdir(), pty: false, restart: 'no', persist: true, detached: false };
}
afterEach(async () => {
  for (const { root, supervisor } of fixtures.splice(0)) {
    await supervisor.request({ op: 'shutdown' });
    await rm(root, { recursive: true, force: true });
  }
});
for (const evidence of ['prior', 'same', 'legacy', 'unavailable', 'unrecorded'] as const) {
  test(`identityless recovery uses positive boot evidence: ${evidence}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-boot-'));
    const supervisor = new ProcessSupervisor(root);
    const currentBoot = spyOn(identities, 'bootIdentity').mockResolvedValue(evidence === 'unavailable' ? null : 'current-boot');
    const claimBoot = evidence === 'legacy' ? undefined : evidence === 'unrecorded' ? null : evidence === 'same' ? 'current-boot' : 'prior-boot';
    try {
      await mkdir(join(root, 'daemons', 'claim'), { recursive: true });
      await writeFile(join(root, 'daemons', 'claim', 'meta.json'), JSON.stringify({
        daemon: { id: 'claim', name: 'claim', owner: 'browser', state: 'starting', createdAt: new Date().toISOString(), pid: null, exitCode: null, restartCount: 0 },
        spec: { ...spec('claim', 'exit 99'), envNames: [] },
        identity: null, claimBoot, cursor: 0, base: 0, output: '',
      }));
      await supervisor.recover();
      const result = await supervisor.request({ op: 'describe', name: 'claim' });
      if (result.op !== 'describe') throw new Error('Unexpected response');
      expect(result.daemon.state).toBe(evidence === 'prior' ? 'failed' : 'stopping');
      expect(await supervisor.privateScopeAbsent('browser')).toBe(evidence === 'prior');
      if (evidence === 'prior') {
        const stopped = await supervisor.request({ op: 'stop', name: 'claim', timeoutMs: 1 });
        if (stopped.op !== 'stop') throw new Error('Unexpected response');
        expect(stopped.daemon.pid).toBeNull();
      } else {
        await expect(supervisor.request({ op: 'stop', name: 'claim', timeoutMs: 1 })).rejects.toThrow('cleanup cannot be proven');
      }
    } finally {
      currentBoot.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
}
test('each restart commits fresh boot evidence before the child can run', async () => {
  const supervisor = await fixture();
  const currentBoot = spyOn(identities, 'bootIdentity').mockResolvedValue('first-boot');
  const metadata = join(supervisor.root, 'daemons', 'boot-claim', 'meta.json');
  try {
    await supervisor.request({ op: 'start', spec: {
      ...spec('boot-claim', ''),
      application: process.execPath,
      args: ['-e', `const record = JSON.parse(await Bun.file(${JSON.stringify(metadata)}).text()); console.log(record.claimBoot);`],
    } });
    await supervisor.request({ op: 'wait', name: 'boot-claim', for: 'exit', timeoutMs: 5000 });
    currentBoot.mockResolvedValue('second-boot');
    await supervisor.request({ op: 'restart', name: 'boot-claim' });
    await supervisor.request({ op: 'wait', name: 'boot-claim', for: 'exit', timeoutMs: 5000 });
    const logs = await supervisor.request({ op: 'logs', name: 'boot-claim' });
    if (logs.op !== 'logs') throw new Error('Unexpected response');
    expect(logs.text).toBe('first-boot\nsecond-boot\n');
  } finally {
    await supervisor.request({ op: 'shutdown' });
    currentBoot.mockRestore();
  }
});
test('native inherited control pipes are separate from public process input and logs', async () => {
  const supervisor = await fixture();
  const started = await supervisor.startPrivatePipe({ op: 'start', owner: 'browser-test', spec: spec('private-pipe', 'read -r command <&3; printf "private:%s\\n" "$command" >&4; sleep 300') });
  if (started.op !== 'start') throw new Error('Unexpected response');
  const pipe = supervisor.privatePipe('private-pipe');
  const response = Promise.withResolvers<string>();
  const timer = setTimeout(() => response.reject(new Error('Private pipe did not respond')), 5000);
  pipe.output.once('data', data => { clearTimeout(timer); response.resolve(String(data)); });
  pipe.input.write('secret-control\n');
  expect(await response.promise).toBe('private:secret-control\n');
  const logs = await supervisor.request({ op: 'logs', name: 'private-pipe' });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.text).not.toContain('secret-control');
  const stopped = await supervisor.request({ op: 'stop', name: 'private-pipe', timeoutMs: 5000 });
  if (stopped.op !== 'stop') throw new Error('Unexpected response');
  expect(stopped.daemon.id).toBe(started.daemon.id);
  expect(stopped.daemon.pid).toBeNull();
  expect(() => supervisor.privatePipe('private-pipe')).toThrow('unavailable');
}, 15000);
test('readiness timeout leaves the process alive for inspection and explicit stop', async () => {
  const supervisor = await fixture();
  await supervisor.request({ op: 'start', spec: { ...spec('never-ready', 'read line; printf "received:%s\\n" "$line"; sleep 30'), ready: { log: '^missing$', timeoutMs: 50 } } });
  const waited = await supervisor.request({ op: 'wait', name: 'never-ready', for: 'ready', timeoutMs: 150 });
  if (waited.op !== 'wait') throw new Error('Unexpected response');
  expect(waited.timedOut).toBe(true);
  expect(waited.daemon.state).toBe('running');
  await supervisor.request({ op: 'send', name: 'never-ready', data: 'alive\n' });
  const output = await supervisor.request({ op: 'wait', name: 'never-ready', pattern: 'received:alive', timeoutMs: 1000 });
  if (output.op !== 'wait') throw new Error('Unexpected response');
  expect(output.timedOut).toBe(false);
  const stopped = await supervisor.request({ op: 'stop', name: 'never-ready', timeoutMs: 1000 });
  if (stopped.op !== 'stop') throw new Error('Unexpected response');
  expect(stopped.daemon.state).toBe('exited');
}, 5000);
test('bounded logs identify an expired cursor and preserve the final output', async () => {
  const supervisor = await fixture();
  await supervisor.request({ op: 'start', spec: { ...spec('large', ''), application: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(1100000) + "\\ncomplete\\n")'] } });
  await supervisor.request({ op: 'wait', name: 'large', for: 'exit', timeoutMs: 5000 });
  const logs = await supervisor.request({ op: 'logs', name: 'large', cursor: 0 });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.resync).toBe('cursor-expired');
  expect(logs.text.endsWith('complete\n')).toBe(true);
  expect(logs.text.length).toBeLessThanOrEqual(1024 * 1024);
  expect(logs.cursor).toBeGreaterThan(logs.text.length);
});
test('recovery fences surviving processes and never restarts the retained launch', async () => {
  const recovered = await fixture();
  const launchMarker = join(recovered.root, 'launches');
  const launchSpec = {
    ...spec('survivor', 'printf "launch\\n" >> "$MARKER"; printf "ready\\n"; exec sleep 300'),
    detached: true, env: { TOKEN: 'surviving-binding', MARKER: launchMarker },
  };
  // Exit the owning process, not just its client: recovery must not race an old writer.
  const broker = Bun.spawn([process.execPath, '-e', `
    import { ProcessSupervisor } from ${JSON.stringify(new URL('../src/supervisor.ts', import.meta.url).href)};
    const supervisor = new ProcessSupervisor(${JSON.stringify(recovered.root)});
    await supervisor.recover();
    const started = await supervisor.request({ op: 'start', spec: ${JSON.stringify(launchSpec)} });
    const ready = await supervisor.request({ op: 'wait', name: 'survivor', pattern: 'ready', timeoutMs: 5000 });
    if (ready.op !== 'wait' || ready.timedOut) throw new Error('Child never became ready');
    process.stdout.write(JSON.stringify(started));
    process.exit(0);
  `], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    broker.exited, new Response(broker.stdout).text(), new Response(broker.stderr).text(),
  ]);
  await recovered.recover();
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  const started = DaemonResponseSchema.parse(JSON.parse(stdout));
  if (started.op !== 'start') throw new Error('Unexpected response');
  const observed = await recovered.request({ op: 'describe', name: 'survivor' });
  if (observed.op !== 'describe') throw new Error('Unexpected response');
  expect(observed.daemon.id).toBe(started.daemon.id);
  expect(observed.daemon.pid).toBe(started.daemon.pid);
  expect(observed.daemon.state).toBe('stopping');
  await expect(recovered.request({ op: 'start', spec: { ...spec('survivor', 'exit 0'), env: { TOKEN: 'fresh-binding' } } })).rejects.toThrow('unresolved');
  expect(await readFile(launchMarker, 'utf8')).toBe('launch\n');
  const stopped = await recovered.request({ op: 'stop', name: 'survivor', timeoutMs: 20 });
  if (stopped.op !== 'stop') throw new Error('Unexpected response');
  expect(stopped.daemon.state).toBe('exited');
  expect(stopped.daemon.pid).toBeNull();
  expect(stopped.daemon.failure).toBeUndefined();
  await recovered.request({ op: 'shutdown' });
});
test('terminal projection handles carriage-return replacement and split escape sequences', () => {
  const terminal = new TerminalProjection();
  terminal.push('progress 10%\rprogress 20%\x1b[');
  terminal.push('K\n\x1b[31mcomplete\x1b[0m');
  expect(terminal.text()).toBe('progress 20%\ncomplete');
  terminal.push('\rOK');
  expect(terminal.text()).toBe('progress 20%\nOKmplete');
  const bounded = new TerminalProjection();
  bounded.push(`${'a'.repeat(20000)}\rEND`);
  expect(bounded.text()).toBe(`END${'a'.repeat(16381)}`);
});
test('isolated commands receive explicit environment without supervisor credentials', async () => {
  const supervisor = await fixture();
  const previous = process.env.GITSPACE_SUPERVISOR_TEST_SECRET;
  process.env.GITSPACE_SUPERVISOR_TEST_SECRET = 'private-supervisor-canary';
  try {
    await supervisor.request({ op: 'start', spec: {
      ...spec('isolated', ''),
      application: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({secret:process.env.GITSPACE_SUPERVISOR_TEST_SECRET,explicit:process.env.EXPLICIT}))'],
      inheritEnv: false, env: { EXPLICIT: 'allowed' },
    } });
    await supervisor.request({ op: 'wait', name: 'isolated', for: 'exit', timeoutMs: 5000 });
    const logs = await supervisor.request({ op: 'logs', name: 'isolated' });
    if (logs.op !== 'logs') throw new Error('Unexpected response');
    expect(JSON.parse(logs.text)).toEqual({ explicit: 'allowed' });
  } finally {
    if (previous === undefined) delete process.env.GITSPACE_SUPERVISOR_TEST_SECRET;
    else process.env.GITSPACE_SUPERVISOR_TEST_SECRET = previous;
  }
});
test('spawn bindings reach children and same-process restarts but never describe or metadata', async () => {
  const supervisor = await fixture();
  const secret = crypto.randomUUID();
  const digest = new Bun.CryptoHasher('sha256').update(secret).digest('hex');
  await supervisor.request({ op: 'start', spec: {
    ...spec('bindings', ''), application: process.execPath,
    args: ['-e', 'process.stdout.write(new Bun.CryptoHasher("sha256").update(process.env.TOKEN).digest("hex")+"\\n")'],
    env: { TOKEN: secret }, inheritEnv: false,
  } });
  await supervisor.request({ op: 'wait', name: 'bindings', for: 'exit', timeoutMs: 5000 });
  await supervisor.request({ op: 'restart', name: 'bindings' });
  await supervisor.request({ op: 'wait', name: 'bindings', for: 'exit', timeoutMs: 5000 });
  await supervisor.request({ op: 'stop', name: 'bindings' });
  const logs = await supervisor.request({ op: 'logs', name: 'bindings' });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.text).toBe(`${digest}\n${digest}\n`);
  const described = await supervisor.request({ op: 'describe', name: 'bindings' });
  if (described.op !== 'describe') throw new Error('Unexpected response');
  expect(described.spec.envNames).toEqual(['TOKEN']);
  expect(JSON.stringify(described)).not.toContain(secret);
  expect(described.spec).not.toHaveProperty('env');
  const metadata = await readFile(join(supervisor.root, 'daemons', 'bindings', 'meta.json'), 'utf8');
  expect(metadata).not.toContain(secret);
  expect(JSON.parse(metadata).spec).not.toHaveProperty('env');
});

test('recovery requires fresh bindings even when ambient environment supplies the same names', async () => {
  const supervisor = await fixture();
  const initial = { ...spec('recover-bindings', 'test "$TOKEN" = "$EXPECTED"'), env: { TOKEN: 'old-binding', EXPECTED: 'old-binding' } };
  await supervisor.request({ op: 'start', spec: initial });
  await supervisor.request({ op: 'wait', name: initial.name, for: 'exit', timeoutMs: 5000 });
  await supervisor.request({ op: 'shutdown' });
  const recovered = new ProcessSupervisor(supervisor.root);
  fixtures.push({ root: supervisor.root, supervisor: recovered });
  await recovered.recover();
  const previous = process.env.TOKEN;
  process.env.TOKEN = 'ambient-is-not-a-binding';
  try {
    await expect(recovered.request({ op: 'restart', name: initial.name })).rejects.toThrow('bindings are unavailable');
    await recovered.request({ op: 'start', spec: { ...initial, env: { TOKEN: 'fresh-binding', EXPECTED: 'fresh-binding' } } });
    const waited = await recovered.request({ op: 'wait', name: initial.name, for: 'exit', timeoutMs: 5000 });
    if (waited.op !== 'wait') throw new Error('Unexpected response');
    expect(waited.daemon.exitCode).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.TOKEN;
    else process.env.TOKEN = previous;
  }
});

test('completed legacy records are scrubbed on recovery without executing their command', async () => {
  const supervisor = await fixture();
  const directory = join(supervisor.root, 'daemons', 'legacy');
  const marker = join(supervisor.root, 'must-not-exist');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'meta.json'), JSON.stringify({
    spec: { ...spec('legacy', `touch '${marker}'`), env: { TOKEN: 'legacy-secret-canary' } },
    daemon: { id: 'legacy', name: 'legacy', state: 'exited', createdAt: new Date().toISOString(), pid: null, exitCode: 0, restartCount: 0, failure: 'legacy error containing legacy-secret-canary' },
    identity: null, cursor: 0, base: 0, output: '',
  }));
  await supervisor.recover();
  const metadata = await readFile(join(directory, 'meta.json'), 'utf8');
  expect(metadata).not.toContain('legacy-secret-canary');
  expect(JSON.parse(metadata).spec.envNames).toEqual(['TOKEN']);
  await expect(supervisor.request({ op: 'restart', name: 'legacy' })).rejects.toThrow('bindings are unavailable');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('transient output remains bounded and never reaches storage or cold recovery', async () => {
  const supervisor = await fixture();
  await supervisor.request({ op: 'start', spec: {
    ...spec('transient', ''), persist: false, application: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(1100000) + "\\ntransient-complete\\n")'],
  } });
  await supervisor.request({ op: 'wait', name: 'transient', for: 'exit', timeoutMs: 5000 });
  await supervisor.request({ op: 'stop', name: 'transient' });
  const logs = await supervisor.request({ op: 'logs', name: 'transient', cursor: 0 });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.text.endsWith('transient-complete\n')).toBe(true);
  expect(logs.text.length).toBeLessThanOrEqual(1024 * 1024);
  expect(logs.resync).toBe('cursor-expired');
  expect(await readdir(join(supervisor.root, 'daemons'))).toEqual([]);
  await supervisor.request({ op: 'shutdown' });
  const recovered = new ProcessSupervisor(supervisor.root);
  await recovered.recover();
  expect(await recovered.request({ op: 'list' })).toEqual({ op: 'list', daemons: [] });
});

test('persistent completion survives recovery but a transient replacement removes stale evidence', async () => {
  const supervisor = await fixture();
  const started = await supervisor.request({ op: 'start', owner: 'durable-owner', spec: spec('retained', 'printf persistent') });
  await supervisor.request({ op: 'wait', name: 'retained', for: 'exit', timeoutMs: 5000 });
  await supervisor.request({ op: 'stop', name: 'retained' });
  const recovered = new ProcessSupervisor(supervisor.root);
  await recovered.recover();
  const description = await recovered.request({ op: 'describe', name: 'retained' });
  if (description.op !== 'describe' || started.op !== 'start') throw new Error('Unexpected response');
  expect(description.daemon.id).toBe(started.daemon.id);
  expect(description.daemon.owner).toBe('durable-owner');
  expect(description.daemon.exitCode).toBe(0);
  const logs = await recovered.request({ op: 'logs', name: 'retained' });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.text).toBe('persistent');
  await supervisor.request({ op: 'start', spec: { ...spec('retained', 'printf transient'), persist: false } });
  await supervisor.request({ op: 'wait', name: 'retained', for: 'exit', timeoutMs: 5000 });
  await supervisor.request({ op: 'stop', name: 'retained' });
  expect(await readdir(join(supervisor.root, 'daemons'))).toEqual([]);
});

test('legacy transient metadata is discarded without recovery or replay', async () => {
  const supervisor = await fixture();
  const directory = join(supervisor.root, 'daemons', 'transient-legacy');
  await mkdir(directory);
  await writeFile(join(directory, 'meta.json'), JSON.stringify({
    spec: { ...spec('transient-legacy', 'exit 99'), persist: false, envNames: [] },
    daemon: { id: 'transient-legacy', name: 'transient-legacy', state: 'starting', createdAt: new Date().toISOString(), pid: null, exitCode: null, restartCount: 0 },
    identity: null, cursor: 6, base: 0, output: 'secret',
  }));
  await writeFile(join(directory, 'output.log'), 'secret');
  await supervisor.recover();
  expect(await supervisor.request({ op: 'list' })).toEqual({ op: 'list', daemons: [] });
  expect(await readdir(join(supervisor.root, 'daemons'))).toEqual([]);
});

test('rejects contradictory detached transient requests without launching or retaining output', async () => {
  const supervisor = await fixture();
  const marker = join(supervisor.root, 'unapproved-effect');
  await expect(supervisor.request({ op: 'start', spec: {
    ...spec('contradictory', ''), detached: true, persist: false, application: process.execPath,
    args: ['-e', 'await Bun.write(process.argv[1], "launched")', marker],
  } })).rejects.toMatchObject({ code: 'DETACHED_REQUIRES_PERSISTENCE' });
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await supervisor.request({ op: 'list' })).toEqual({ op: 'list', daemons: [] });
  expect(await readdir(join(supervisor.root, 'daemons'))).toEqual([]);
});

test('detached execution rejects PTYs, has no input, and survives shutdown with file-backed output', async () => {
  // Real subprocess lifetime crosses supervisor shutdown; fake timers cannot drive the child.
  const supervisor = await fixture();
  await expect(supervisor.request({ op: 'start', spec: { ...spec('invalid-detached', 'exit 0'), detached: true, pty: true } })).rejects.toThrow('PTY');
  const gate = join(supervisor.root, 'release');
  const completed = join(supervisor.root, 'completed');
  await supervisor.request({ op: 'start', owner: 'detached-owner', spec: {
    ...spec('detached', ''), detached: true, persist: true, application: process.execPath,
    args: ['-e', 'const [gate,done]=process.argv.slice(1); console.log("waiting"); const deadline=Date.now()+5000; while(!await Bun.file(gate).exists()){if(Date.now()>deadline)process.exit(2);await Bun.sleep(10)} console.log("after-shutdown"); await Bun.write(done,"done");', gate, completed],
  } });
  const ready = await supervisor.request({ op: 'wait', name: 'detached', pattern: 'waiting', timeoutMs: 5000 });
  if (ready.op !== 'wait') throw new Error('Unexpected response');
  expect(ready.timedOut).toBe(false);
  await expect(supervisor.request({ op: 'send', name: 'detached', data: 'input' })).rejects.toThrow('interactive input');
  await supervisor.request({ op: 'shutdown' });
  await writeFile(gate, '');
  const deadline = Date.now() + 5000;
  while (!await Bun.file(completed).exists() && Date.now() < deadline) await Bun.sleep(10);
  expect(await readFile(completed, 'utf8')).toBe('done');
  expect(await readFile(join(supervisor.root, 'daemons', 'detached', 'output.log'), 'utf8')).toContain('after-shutdown');
  const recovered = new ProcessSupervisor(supervisor.root);
  await recovered.recover();
  const logs = await recovered.request({ op: 'logs', name: 'detached' });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.text).toBe('waiting\nafter-shutdown\n');
  await recovered.request({ op: 'stop', name: 'detached', timeoutMs: 20 });
  await recovered.request({ op: 'shutdown' });
}, 10000);

test('interactive text enters by default, keys stay ordered, and matched logs are observable', async () => {
  const supervisor = await fixture();
  await supervisor.request({ op: 'start', spec: { ...spec('interactive', 'printf "READY 4321\\n"; read line; printf "answer:%s\\n" "$line"; read line; printf "second:%s\\n" "$line"'), ready: { log: 'READY \\d+', timeoutMs: 1000 } } });
  const ready = await supervisor.request({ op: 'wait', name: 'interactive', for: 'ready', timeoutMs: 1000 });
  if (ready.op !== 'wait') throw new Error('Unexpected response');
  expect(ready.daemon.readiness).toEqual({ timedOut: false, matched: 'READY 4321' });
  await supervisor.request({ op: 'send', name: 'interactive', text: 'first' });
  const first = await supervisor.request({ op: 'wait', name: 'interactive', pattern: 'answer:first', timeoutMs: 1000 });
  if (first.op !== 'wait') throw new Error('Unexpected response');
  expect(first.matched).toBe('answer:first');
  await supervisor.request({ op: 'send', name: 'interactive', text: 'last', enter: false, keys: ['TAB'] });
  await supervisor.request({ op: 'send', name: 'interactive', text: 'value' });
  await supervisor.request({ op: 'wait', name: 'interactive', for: 'exit', timeoutMs: 1000 });
  const logs = await supervisor.request({ op: 'logs', name: 'interactive', grep: '^(answer|second):', head: true, lines: 2 });
  if (logs.op !== 'logs') throw new Error('Unexpected response');
  expect(logs.text).toBe('answer:first\nsecond:last\tvalue');
  const empty = await supervisor.request({ op: 'logs', name: 'interactive', cursor: logs.cursor });
  if (empty.op !== 'logs') throw new Error('Unexpected response');
  expect(empty.text).toBe('');
}, 5000);

test('completed process identity survives replacement and supervisor recovery', async () => {
  const supervisor = await fixture();
  const first = await supervisor.request({ op: 'start', spec: spec('reused-name', 'exit 7') });
  if (first.op !== 'start') throw new Error('Unexpected response');
  await supervisor.request({ op: 'wait', name: 'reused-name', for: 'exit', timeoutMs: 1000 });
  await supervisor.request({ op: 'start', spec: spec('reused-name', 'exit 0') });
  await supervisor.request({ op: 'wait', name: 'reused-name', for: 'exit', timeoutMs: 1000 });
  await supervisor.request({ op: 'shutdown' });
  const recovered = new ProcessSupervisor(supervisor.root);
  await recovered.recover();
  try {
    const previous = await recovered.request({ op: 'describe', name: 'reused-name', instanceId: first.daemon.id, restartCount: 0 });
    if (previous.op !== 'describe') throw new Error('Unexpected response');
    expect(previous.daemon.id).toBe(first.daemon.id);
    expect(previous.daemon.exitCode).toBe(7);
  } finally { await recovered.request({ op: 'shutdown' }); }
}, 5000);
