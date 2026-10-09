import { spawn, type ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { z } from 'zod';
import { DaemonSpecSchema, StoredDaemonSchema, SupervisorRequestError, type DaemonRequest, type DaemonResponse } from './protocol.js';
import { bootIdentity, descendants, processIdentity, sameProcess, signalIdentity } from './process-identity.js';
import { TerminalProjection } from './terminal-output.js';

type Stored = z.infer<typeof StoredDaemonSchema>;
type Running = { stored: Stored; bindings?: Record<string, string>; pipe?: ChildProcess; pty?: Bun.Subprocess; terminal?: Bun.Terminal; text: string; projection: TerminalProjection; listeners: Set<() => void>; writes: Promise<void>; launching?: Promise<void>; readinessTask?: Promise<void>; exitTask?: Promise<void>; stoppingTask?: Promise<void>; backgroundFailure?: Error; writing?: boolean; dirty?: boolean; stopping: boolean; recovered: boolean; restart?: NodeJS.Timeout; outputOffset?: number; outputTask?: Promise<void>; outputTimer?: NodeJS.Timeout; released?: boolean };
const MAX_LOG = 1024 * 1024;
const StoredOutputSchema = StoredDaemonSchema.extend({ output: z.string().max(MAX_LOG), outputOffset: z.number().int().nonnegative().optional() });
// Read legacy values only to retain their required names, never as launch bindings.
const RecoveryOutputSchema = StoredOutputSchema.extend({
  spec: StoredDaemonSchema.shape.spec.extend({ envNames: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
}).transform(({ spec: { env, envNames, ...spec }, daemon, ...record }) => ({
  ...record,
  daemon: env && daemon.failure ? { ...daemon, failure: 'Recovered legacy execution failure' } : daemon,
  spec: { ...spec, envNames: [...new Set([...(envNames ?? []), ...Object.keys(env ?? {})])] },
}));
const finished = (run: Running) => run.stored.daemon.state === 'exited' || run.stored.daemon.state === 'failed';

export class ProcessSupervisor {
  private readonly runs = new Map<string, Running>();
  private readonly completions = new Map<string, Extract<DaemonResponse, { op: 'describe' }>>();
  private closing = false;
  private readonly privatePipes = new Set<string>();
  /** Advances on every process start and state transition; `watch` callers long-poll on it. */
  private revision = 0;
  private readonly observers = new Set<() => void>();
  /** Native authority only: deliberately absent from the broker request schema. */
  async startPrivatePipe(request: Extract<DaemonRequest, { op: 'start' }>): Promise<DaemonResponse> {
    if (request.spec.pty || request.spec.detached || request.spec.restart !== 'no') throw new Error('Private pipes require a non-restarting owned process');
    this.privatePipes.add(request.spec.name);
    try { return await this.request({ ...request, spec: { ...request.spec, visibility: 'private' } }); } finally { this.privatePipes.delete(request.spec.name); }
  }
  privatePipe(name: string): { input: Duplex; output: Duplex } {
    const run = this.runs.get(name);
    const input = run?.pipe?.stdio[3], output = run?.pipe?.stdio[4];
    if (!input || !output || finished(run!)) throw new Error('Private process pipe unavailable');
    return { input: input as Duplex, output: output as Duplex };
  }
  /** Native recovery evidence. Unknown same-boot claims remain fenced; no PID is signalled. */
  async privateScopeAbsent(owner?: string): Promise<boolean> {
    for (const run of this.runs.values()) {
      if (owner !== undefined && run.stored.daemon.owner !== owner) continue;
      await run.launching;
      if (finished(run) && run.stored.daemon.pid === null) continue;
      if (!run.recovered || !await this.claimAbsent(run.stored)) return false;
    }
    return true;
  }
  constructor(readonly root: string) {}
  private async claimAbsent(stored: Stored): Promise<boolean> {
    if (stored.claimBoot) {
      const currentBoot = await bootIdentity();
      if (currentBoot && currentBoot !== stored.claimBoot) return true;
    }
    if (!stored.identity) return false;
    try { return !await sameProcess(stored.identity); } catch { return false; }
  }
  async recover(): Promise<void> {
    await mkdir(join(this.root, 'completions'), { recursive: true, mode: 0o700 });
    for (const file of await readdir(join(this.root, 'completions'))) {
      if (!file.endsWith('.json')) continue;
      const record = StoredDaemonSchema.parse(JSON.parse(await readFile(join(this.root, 'completions', file), 'utf8')));
      this.completions.set(`${record.daemon.id}:${record.daemon.restartCount}`, { op: 'describe', daemon: record.daemon, spec: record.spec });
    }
    await mkdir(join(this.root, 'daemons'), { recursive: true, mode: 0o700 });
    for (const directory of await readdir(join(this.root, 'daemons'), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const { output: text, outputOffset, ...stored } = RecoveryOutputSchema.parse(JSON.parse(await readFile(join(this.root, 'daemons', directory.name, 'meta.json'), 'utf8')));
      if (!stored.spec.persist) {
        await rm(join(this.root, 'daemons', directory.name), { recursive: true, force: true });
        continue;
      }
      const run: Running = { stored, text, outputOffset, projection: new TerminalProjection(), listeners: new Set(), writes: Promise.resolve(), stopping: false, recovered: true };
      run.projection.push(text);
      this.runs.set(stored.daemon.name, run);
      if (!finished(run)) {
        // A matching process is an unresolved effect, not a fresh launch. Keep it fenced until stop confirms cleanup.
        if (!await this.claimAbsent(stored)) {
          stored.daemon.state = 'stopping';
          stored.daemon.failure = 'Supervisor restarted; surviving execution requires explicit stop before restart';
        } else {
          stored.daemon.state = 'failed'; stored.daemon.pid = null;
          delete stored.daemon.nextRestartCount;
          stored.daemon.failure = 'Execution interrupted: recorded execution no longer exists; no automatic replay';
        }
      }
      if (stored.spec.detached) await this.readDetachedOutput(run);
      // Scrub even completed legacy records before making the supervisor available.
      await this.persist(run);
      if (stored.spec.detached && !finished(run)) this.monitorOutput(run);
    }
  }
  private persist(run: Running): Promise<void> {
    if (finished(run)) this.completions.set(`${run.stored.daemon.id}:${run.stored.daemon.restartCount}`, { op: 'describe', daemon: structuredClone(run.stored.daemon), spec: structuredClone(run.stored.spec) });
    if (!run.stored.spec.persist || run.released) return Promise.resolve();
    run.dirty = true;
    if (run.writing) return run.writes;
    run.writing = true;
    const directory = join(this.root, 'daemons', run.stored.daemon.name);
    run.writes = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      while (run.dirty) {
        run.dirty = false;
        const text = run.text;
        // Detached children own their log descriptor; never replace that inode.
        // Other output and its cursor share one atomic recovery record.
        const body = JSON.stringify({ ...run.stored, output: text, ...(run.stored.spec.detached ? { outputOffset: run.outputOffset ?? 0 } : {}) });
        if (finished(run)) {
          const completion = join(this.root, 'completions', `${run.stored.daemon.id}:${run.stored.daemon.restartCount}.json`);
          await mkdir(join(this.root, 'completions'), { recursive: true, mode: 0o700 });
          await writeFile(`${completion}.next`, JSON.stringify(run.stored), { mode: 0o600 });
          await rename(`${completion}.next`, completion);
        }
        if (!run.stored.spec.detached) {
          await writeFile(join(directory, 'output.log.next'), text, { mode: 0o600 });
          await rename(join(directory, 'output.log.next'), join(directory, 'output.log'));
        }
        await writeFile(join(directory, 'meta.json.next'), body, { mode: 0o600 });
        await rename(join(directory, 'meta.json.next'), join(directory, 'meta.json'));
      }
    })().finally(() => { run.writing = false; });
    return run.writes;
  }
  /** A start or state transition: advances the inventory revision. */
  private changed(run: Running): void { this.revision++; this.notify(run); }
  private notify(run: Running): void {
    for (const listener of run.listeners) listener();
    for (const observer of this.observers) observer();
  }
  private output(run: Running, text: string): void {
    run.text += text;
    run.stored.cursor += text.length;
    if (run.text.length > MAX_LOG) { const removed = run.text.length - MAX_LOG; run.text = run.text.slice(removed); run.stored.base += removed; }
    run.projection.push(text);
    void this.persist(run).catch(error => { run.stored.daemon.failure = `Log persistence failed: ${String(error)}`; this.changed(run); });
    this.notify(run);
  }
  private async readDetachedOutput(run: Running): Promise<void> {
    const file = await open(join(this.root, 'daemons', run.stored.daemon.name, 'output.log'), 'a+', 0o600);
    try {
      const size = (await file.stat()).size;
      const offset = Math.min(run.outputOffset ?? 0, size);
      if (size === offset) return;
      const start = Math.max(offset, size - MAX_LOG);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      run.outputOffset = start + bytesRead;
      if (start > offset) {
        run.stored.cursor += start - offset;
        run.stored.base += start - offset;
      }
      this.output(run, buffer.toString('utf8', 0, bytesRead));
    } finally { await file.close(); }
  }
  private monitorOutput(run: Running): void {
    const poll = () => {
      run.outputTask = this.readDetachedOutput(run).catch(error => {
        run.backgroundFailure = error instanceof Error ? error : new Error(String(error));
      }).finally(() => {
        if (!run.released && !finished(run)) {
          run.outputTimer = setTimeout(poll, 50);
          run.outputTimer.unref();
        }
      });
    };
    poll();
  }
  private async launch(run: Running): Promise<void> {
    const { spec, daemon } = run.stored;
    if (this.closing) return;
    if (spec.envNames.some(name => !run.bindings || !Object.hasOwn(run.bindings, name))) {
      throw new Error('Process environment bindings are unavailable; supply a fresh start after confirmed cleanup');
    }
    run.stopping = false; run.recovered = false; run.stoppingTask = undefined;
    daemon.state = 'starting'; daemon.exitCode = null; delete daemon.failure; delete daemon.readiness; delete daemon.nextRestartCount;
    const readinessCursor = run.stored.cursor;
    // Commit an unresolved claim before spawn. Recovery never replays this claim.
    run.stored.claimBoot = await bootIdentity();
    run.stored.identity = null;
    daemon.pid = null;
    await this.persist(run);
    const decoder = new TextDecoder();
    const inherited = spec.inheritEnv === false ? {} : Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITSPACE_')));
    const env = { ...inherited, ...run.bindings };
    try {
      if (spec.pty) {
        const child = Bun.spawn([spec.application, ...spec.args], {
          cwd: spec.cwd, env,
          terminal: { cols: 120, rows: 40, data: (_terminal, data) => this.output(run, decoder.decode(data, { stream: true })) },
        });
        run.pty = child; run.terminal = child.terminal;
        daemon.pid = child.pid;
        void child.exited.then(code => {
          run.exitTask = this.exited(run, code).catch(error => { run.backgroundFailure = error instanceof Error ? error : new Error(String(error)); });
        });
      } else {
        const output = spec.detached ? await open(join(this.root, 'daemons', daemon.name, 'output.log'), 'w', 0o600) : undefined;
        let child: ChildProcess;
        const spawned = Promise.withResolvers<void>();
        try {
          child = spawn(spec.application, spec.args, { cwd: spec.cwd, env, detached: true, stdio: this.privatePipes.has(daemon.name) ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : output ? ['ignore', output.fd, output.fd] : ['pipe', 'pipe', 'pipe'] });
          child.once('spawn', spawned.resolve); child.once('error', spawned.reject);
        } catch (error) { await output?.close(); throw error; }
        if (spec.detached) { child.unref(); run.outputOffset = 0; this.monitorOutput(run); }
        run.pipe = child;
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (data: string) => this.output(run, data));
        child.stderr?.on('data', (data: string) => this.output(run, data));
        child.once('close', code => {
          run.exitTask = this.exited(run, code ?? 128).catch(error => { run.backgroundFailure = error instanceof Error ? error : new Error(String(error)); });
        });
        try { await spawned.promise; } finally { await output?.close(); }
        daemon.pid = child.pid ?? null;
      }
      run.stored.identity = daemon.pid ? await processIdentity(daemon.pid) : null;
      if (!finished(run)) daemon.state = spec.ready ? 'running' : 'ready';
      await this.persist(run); this.changed(run);
      if (spec.ready && !finished(run) && !run.stopping) {
        run.readinessTask = this.readiness(run, readinessCursor).catch(error => { run.backgroundFailure = error instanceof Error ? error : new Error(String(error)); });
      }
    } catch {
      daemon.state = 'failed'; daemon.failure = 'Process launch failed'; daemon.pid = null;
      await this.persist(run); this.changed(run);
      // Spawn errors may contain resolved environment values; never persist or return them.
      throw new Error('Process launch failed');
    }
  }
  private async exited(run: Running, code: number): Promise<void> {
    if (run.released) return;
    clearTimeout(run.outputTimer);
    await run.outputTask;
    clearTimeout(run.outputTimer);
    if (run.released) return;
    if (run.stored.spec.detached) await this.readDetachedOutput(run);
    run.terminal?.close(); run.terminal = undefined;
    run.stored.daemon.exitCode = code;
    run.stored.daemon.pid = null;
    run.stored.identity = null;
    run.stored.daemon.state = run.stored.daemon.failure ? 'failed' : 'exited';
    const { restart } = run.stored.spec;
    const restarting = !this.closing && !run.stopping && (restart === 'always' || (restart === 'on-failure' && code !== 0));
    if (restarting) run.stored.daemon.nextRestartCount = run.stored.daemon.restartCount + 1;
    else delete run.stored.daemon.nextRestartCount;
    await this.persist(run); this.changed(run);
    if (restarting) {
      run.stored.daemon.state = 'restarting';
      run.stored.daemon.restartCount++;
      await this.persist(run); this.changed(run);
      if (!run.stopping && !this.closing) run.restart = setTimeout(() => {
        run.launching = this.launch(run);
        void run.launching.catch(error => { run.backgroundFailure = error instanceof Error ? error : new Error(String(error)); });
      }, Math.min(30_000, 250 * 2 ** Math.min(run.stored.daemon.restartCount, 7)));
    }
  }
  private async readiness(run: Running, cursor: number): Promise<void> {
    const ready = run.stored.spec.ready!;
    const deadline = Date.now() + (ready.timeoutMs ?? 30_000);
    const pattern = ready.log ? new RegExp(ready.log, 'u') : null;
    while (!finished(run) && !run.stopping && run.stored.daemon.state !== 'restarting') {
      const matched = pattern?.exec(run.text.slice(Math.max(0, cursor - run.stored.base)))?.[0];
      const logReady = !pattern || matched !== undefined;
      let portReady = !ready.port;
      if (ready.port) {
        const connected = Promise.withResolvers<boolean>();
        const socket = createConnection({ host: ready.host ?? '127.0.0.1', port: ready.port });
        const finish = (value: boolean) => { socket.destroy(); connected.resolve(value); };
        socket.setTimeout(200, () => finish(false)); socket.once('error', () => finish(false)); socket.once('connect', () => finish(true));
        portReady = await connected.promise;
      }
      if (run.stopping || finished(run) || this.closing) return;
      if (logReady && portReady) { run.stored.daemon.state = 'ready'; run.stored.daemon.readiness = { timedOut: false, ...(matched === undefined ? {} : { matched }) }; await this.persist(run); this.changed(run); return; }
      if (Date.now() >= deadline) {
        run.stored.daemon.readiness = { timedOut: true, ...(matched === undefined ? {} : { matched }) };
        await this.persist(run); this.changed(run); return;
      }
      await Bun.sleep(50);
    }
  }
  private stop(run: Running, timeoutMs: number): Promise<void> {
    if (!run.stoppingTask) run.stoppingTask = this.terminate(run, timeoutMs);
    return run.stoppingTask;
  }
  private async terminate(run: Running, timeoutMs: number): Promise<void> {
    run.stopping = true; clearTimeout(run.restart);
    if (finished(run)) return;
    await run.launching;
    const identity = run.stored.identity;
    if (finished(run)) return;
    if (run.recovered && !identity) throw new Error('Unresolved launch has no committed process identity; cleanup cannot be proven');
    run.stored.daemon.state = 'stopping'; await this.persist(run); this.changed(run);
    const tree = identity && await sameProcess(identity) ? await descendants(identity.pid) : [];
    // Let protected lifecycle wrappers perform their own private cleanup before hard termination.
    if (identity) await signalIdentity(identity, 'SIGTERM');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (await Promise.all(tree.map(sameProcess))).some(Boolean)) await Bun.sleep(25);
    for (const child of tree.reverse()) await signalIdentity(child, 'SIGKILL');
    const hardDeadline = Date.now() + 5000;
    while ((await Promise.all(tree.map(sameProcess))).some(Boolean)) {
      if (Date.now() >= hardDeadline) throw new Error('Process-tree termination could not be confirmed');
      await Bun.sleep(25);
    }
    if (!run.recovered && (run.pipe || run.pty) && !finished(run) && !await this.wait(run.listeners, () => finished(run), 5000)) throw new Error('Process exit stream did not close after termination');
    // Recovery's failure denotes an unresolved effect, not an execution failure.
    // Clear it only after the identity-verified cleanup barrier above succeeds.
    if (run.recovered) delete run.stored.daemon.failure;
    run.stored.daemon.state = run.stored.daemon.failure ? 'failed' : 'exited';
    run.stored.daemon.pid = null; run.stored.identity = null;
    delete run.stored.daemon.nextRestartCount;
    await this.persist(run); this.changed(run);
  }
  private async drain(run: Running): Promise<void> {
    await run.launching;
    await run.readinessTask;
    await run.stoppingTask;
    await run.exitTask;
    clearTimeout(run.outputTimer);
    await run.outputTask;
    clearTimeout(run.outputTimer);
    await run.writes;
    if (run.backgroundFailure) throw run.backgroundFailure;
  }
  private wait(listeners: Set<() => void>, predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    const result = Promise.withResolvers<boolean>();
    const finish = (value: boolean) => { clearTimeout(timer); listeners.delete(check); signal?.removeEventListener('abort', abort); result.resolve(value); };
    const check = () => { if (predicate()) finish(true); };
    const abort = () => { clearTimeout(timer); listeners.delete(check); result.reject(signal?.reason ?? new Error('Request aborted')); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    listeners.add(check); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else check();
    return result.promise;
  }
  async request(request: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
    if (request.op === 'list') return { op: 'list', daemons: [...this.runs.values()].map(run => ({ ...run.stored.daemon })) };
    if (request.op === 'shutdown') {
      this.closing = true;
      for (const run of this.runs.values()) { run.stopping = true; clearTimeout(run.restart); }
      for (const run of this.runs.values()) {
        await run.launching;
        if (run.stored.spec.detached && !run.stoppingTask && !finished(run) && run.stored.identity) {
          clearTimeout(run.outputTimer);
          run.released = true;
          await run.outputTask;
          await run.readinessTask;
          await run.writes;
          run.pipe?.unref();
        } else {
          await this.stop(run, 5000);
          await this.drain(run);
        }
      }
      return { op: 'shutdown' };
    }
    if (this.closing) throw new Error('Supervisor is shutting down');
    if (request.op === 'watch') {
      const cursor = () => request.name === undefined ? null : this.runs.get(request.name)?.stored.cursor ?? null;
      await this.wait(this.observers, () => request.revision !== this.revision || (request.name !== undefined && cursor() !== (request.cursor ?? null)), request.timeoutMs ?? 30_000, signal);
      return { op: 'watch', revision: this.revision, cursor: cursor() };
    }
    if ((request.op === 'describe' || request.op === 'stop') && request.instanceId !== undefined && request.restartCount !== undefined) {
      const completion = this.completions.get(`${request.instanceId}:${request.restartCount}`);
      if (completion && completion.daemon.name === request.name) return request.op === 'describe' ? structuredClone(completion) : { op: 'stop', daemon: structuredClone(completion.daemon) };
    }
    if (request.op === 'start') {
      if (request.spec.detached && !request.spec.persist) throw new SupervisorRequestError('DETACHED_REQUIRES_PERSISTENCE', 'Detached processes require persist:true; transient execution cannot retain detached output or recovery records');
      if (request.spec.ready?.log) new RegExp(request.spec.ready.log, 'u');
      if (request.spec.detached && request.spec.pty) throw new Error('A detached process cannot allocate a PTY');
      const existing = this.runs.get(request.spec.name);
      if (existing && !finished(existing)) throw new Error(`Process ${request.spec.name} is already active or unresolved`);
      if (existing) {
        await this.stop(existing, 5000);
        await this.drain(existing);
        if (this.closing || this.runs.get(request.spec.name) !== existing) throw new Error('Process ownership changed while draining the prior execution');
      }
      const { env, ...configuration } = request.spec;
      const stored: Stored = { spec: DaemonSpecSchema.parse({ ...configuration, envNames: Object.keys(env) }), daemon: { id: crypto.randomUUID(), name: request.spec.name, owner: request.owner, state: 'starting', createdAt: new Date().toISOString(), pid: null, exitCode: null, restartCount: 0 }, identity: null, cursor: existing?.stored.cursor ?? 0, base: existing?.stored.cursor ?? 0 };
      if (!stored.spec.persist) await rm(join(this.root, 'daemons', stored.daemon.name), { recursive: true, force: true });
      const run: Running = { stored, bindings: { ...env }, text: '', projection: new TerminalProjection(), listeners: new Set(), writes: Promise.resolve(), stopping: false, recovered: false };
      this.runs.set(request.spec.name, run);
      run.launching = this.launch(run);
      await run.launching;
      return { op: 'start', daemon: { ...stored.daemon } };
    }
    const run = this.runs.get(request.name);
    if ((request.op === 'describe' || request.op === 'stop') && request.instanceId !== undefined && request.restartCount === undefined && run?.stored.daemon.id !== request.instanceId) {
      let latest: Extract<DaemonResponse, { op: 'describe' }> | undefined;
      for (const completion of this.completions.values()) if (completion.daemon.id === request.instanceId && completion.daemon.name === request.name && (!latest || latest.daemon.restartCount < completion.daemon.restartCount)) latest = completion;
      if (latest) return request.op === 'describe' ? structuredClone(latest) : { op: 'stop', daemon: structuredClone(latest.daemon) };
    }
    if (!run) throw new Error(`Unknown process ${request.name}`);
    if ((request.op === 'describe' || request.op === 'stop') && (request.instanceId !== undefined && request.instanceId !== run.stored.daemon.id || request.restartCount !== undefined && request.restartCount !== run.stored.daemon.restartCount)) throw new Error('Process instance no longer matches the requested execution');
    switch (request.op) {
      case 'describe': return { op: 'describe', daemon: { ...run.stored.daemon }, spec: structuredClone(run.stored.spec) };
      case 'stop': await this.stop(run, request.timeoutMs ?? 5000); await this.drain(run); return { op: 'stop', daemon: { ...run.stored.daemon } };
      case 'restart':
        if (run.stored.spec.envNames.some(name => !run.bindings || !Object.hasOwn(run.bindings, name))) {
          throw new Error('Process environment bindings are unavailable; supply a fresh start after confirmed cleanup');
        }
        await this.stop(run, request.timeoutMs ?? 5000); await this.drain(run);
        run.stored.daemon.restartCount++;
        run.launching = this.launch(run); await run.launching;
        return { op: 'restart', daemon: { ...run.stored.daemon } };
      case 'send': {
        if (run.recovered || finished(run)) throw new Error('Process input is unavailable');
        const keys = { ENTER: '\r', TAB: '\t', ESCAPE: '\x1b', CTRL_C: '\x03', CTRL_D: '\x04', UP: '\x1b[A', DOWN: '\x1b[B', LEFT: '\x1b[D', RIGHT: '\x1b[C' } as const;
        const data = (request.data ?? '') + (request.text === undefined ? '' : request.text + (request.enter === false ? '' : '\n')) + (request.keys ?? []).map(key => keys[key]).join('');
        if (run.stored.spec.detached && (data || request.cols !== undefined || request.rows !== undefined)) throw new Error('Detached processes have no interactive input');
        if (request.signal && run.stored.identity) await signalIdentity(run.stored.identity, request.signal);
        if (request.cols && request.rows) run.terminal?.resize(request.cols, request.rows);
        if (data) {
          if (run.terminal) run.terminal.write(data);
          else if (run.pipe?.stdin) {
            const written = Promise.withResolvers<void>();
            run.pipe.stdin.write(data, error => error ? written.reject(error) : written.resolve());
            await written.promise;
          }
          else throw new Error('Process has no writable input');
        }
        return { op: 'send', daemon: { ...run.stored.daemon } };
      }
      case 'wait': {
        const regex = request.pattern ? new RegExp(request.pattern, 'u') : null;
        const observed = await this.wait(run.listeners, () => finished(run) || (regex ? regex.test(run.text) : request.for === 'ready' && (run.stored.daemon.state === 'ready' || run.stored.daemon.readiness?.timedOut === true)), request.timeoutMs ?? 30_000, signal);
        const matched = regex?.exec(run.text)?.[0];
        return { op: 'wait', daemon: { ...run.stored.daemon }, timedOut: !observed || (!regex && request.for === 'ready' && run.stored.daemon.readiness?.timedOut === true), ...(matched === undefined ? {} : { matched }) };
      }
      case 'logs': {
        if (request.follow && request.cursor === run.stored.cursor && !finished(run)) await this.wait(run.listeners, () => run.stored.cursor !== request.cursor || finished(run), request.timeoutMs ?? 30_000, signal);
        const resync = request.cursor !== undefined && request.cursor < run.stored.base ? 'cursor-expired' : request.cursor !== undefined && request.cursor > run.stored.cursor ? 'cursor-ahead' : undefined;
        const offset = request.cursor === undefined || resync ? 0 : request.cursor - run.stored.base;
        const pattern = request.grep ? new RegExp(request.grep, 'u') : null;
        const lines = run.text.slice(offset).split('\n').filter(line => !pattern || pattern.test(line));
        const count = request.lines ?? 1000;
        return { op: 'logs', state: run.stored.daemon.state, text: (request.head ? lines.slice(0, count) : lines.slice(-count)).join('\n'), cursor: run.stored.cursor, ...(resync ? { resync } : {}), ...(request.renderTerminalRows ? { terminalText: run.projection.text() } : {}) };
      }
    }
  }
}
