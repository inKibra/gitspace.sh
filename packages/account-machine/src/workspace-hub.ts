import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { watch, type FSWatcher } from 'node:fs';
import { getDaemonRuntimeDir } from '@oh-my-pi/pi-utils';
import { streamCursorSchema, type StreamEvent } from '@gitspace/protocol-sync';
import { TerminalSnapshotJournal, type TerminalSnapshot } from './terminal-stream.js';
import type { GitSpaceDatabase } from '@gitspace/core';
import { DEFAULT_LIFECYCLE_TIMEOUT_MS, LifecycleLogReader, type LifecycleRun, type LifecycleRunPhase } from '@gitspace/protocol-environment';
import {
  daemonClientForProject,
  type DaemonBrokerClient,
} from '@oh-my-pi/pi-coding-agent/launch/client';
import type {
  DaemonSnapshot,
  DaemonSpec,
  DaemonState,
} from '@oh-my-pi/pi-coding-agent/launch/protocol';

export type WorkspaceTerminalKind = 'user' | 'agent' | 'lifecycle' | 'service';

export interface WorkspaceTerminalView {
  spaceId: string;
  name: string;
  id: string;
  kind: WorkspaceTerminalKind;
  state: DaemonState;
  machineId: string;
  owner: string | null;
  command: string;
  cwd: string;
  createdAt: Date;
  exitCode: number | null;
}

export interface WorkspaceTerminalOutput {
  spaceId: string;
  name: string;
  state: DaemonState;
  cursor: number;
  data: string;
}

export interface WorkspaceLifecyclePlanStep {
  id: string;
  kind: 'check' | 'script';
  command: string;
  /** Frozen approved bytes, never re-open a mutable script path during execution. */
  content?: string;
}

export interface WorkspaceLifecyclePlanResult {
  terminalName: string;
  exitCode: number;
  output: string;
  steps: LifecycleRun['results'];
}

export class WorkspaceHubSpaceUnavailable extends Error {
  constructor(readonly spaceId: string) {
    super(`Space ${spaceId} is unavailable on this machine`);
  }
}

export class WorkspaceHubTerminalUnavailable extends Error {
  constructor(readonly spaceId: string, readonly name: string) {
    super(`Terminal ${name} does not belong to space ${spaceId}`);
  }
}

type HubClientFactory = (projectDirectory: string) => Promise<DaemonBrokerClient>;

interface HubScope {
  space: NonNullable<ReturnType<GitSpaceDatabase['getSpace']>>;
  client: DaemonBrokerClient;
}
interface TerminalObserver { controller: AbortController; references: number; failure: Error | null }

function isInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function ownerFor(spaceId: string, kind: 'user' | 'lifecycle' | 'service'): string {
  return `gitspace:${spaceId}:${kind}`;
}

function terminalKind(spaceId: string, owner: string | undefined): WorkspaceTerminalKind {
  if (owner === ownerFor(spaceId, 'lifecycle') || owner?.startsWith(`${ownerFor(spaceId, 'lifecycle')}:`)) return 'lifecycle';
  if (owner === ownerFor(spaceId, 'service') || owner?.startsWith(`${ownerFor(spaceId, 'service')}:`)) return 'service';
  if (owner === ownerFor(spaceId, 'user') || owner === undefined) return 'user';
  return 'agent';
}

function displayCommand(spec: DaemonSpec): string {
  return [spec.application, ...spec.args].join(' ');
}

export class WorkspaceHubTerminalCoordinator {
  private readonly terminalJournal: TerminalSnapshotJournal;
  private readonly terminalObservers = new Map<string, TerminalObserver>();
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly machineId: string,
    private readonly clientForProject: HubClientFactory = daemonClientForProject,
  ) { this.terminalJournal = new TerminalSnapshotJournal(database); }

  async list(spaceId: string): Promise<WorkspaceTerminalView[]> {
    const scope = await this.scope(spaceId);
    const listed = await scope.client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('OMP Hub returned an invalid list response');
    const activeDaemons = listed.daemons.filter((daemon) => daemon.state !== 'exited' && daemon.state !== 'failed');
    const terminals = await Promise.all(activeDaemons.map(async (daemon) => {
      const described = await scope.client.request({ op: 'describe', name: daemon.name });
      if (described.op !== 'describe') throw new Error(`OMP Hub returned an invalid describe response for ${daemon.name}`);
      return isInside(scope.space.rootPath, described.spec.cwd)
        ? this.view(spaceId, described.daemon, described.spec)
        : null;
    }));
    return terminals.filter((terminal): terminal is WorkspaceTerminalView => terminal !== null)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async *events(spaceId: string, name: string | null, after: number | null, signal: AbortSignal): AsyncGenerator<StreamEvent<TerminalSnapshot>> {
    if (after !== null) streamCursorSchema.parse(after);
    const scope = await this.scope(spaceId);
    if (signal.aborted) return;
    const resource = `terminals:${spaceId}:${name ?? ''}`;
    let observer = this.terminalObservers.get(resource);
    if (!observer) {
      observer = { controller: new AbortController(), references: 0, failure: null };
      this.terminalObservers.set(resource, observer);
      const selected = observer;
      void this.observeTerminals(spaceId, name, resource, scope, selected.controller.signal).catch((error: unknown) => {
        if (selected.controller.signal.aborted) return;
        selected.failure = error instanceof Error ? error : new Error(String(error));
        for (const listener of this.terminalJournal.listeners) listener(resource);
      });
    }
    observer.references++;
    let cursor = after;
    let initial = true;
    let wake: (() => void) | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    const committed = (changed: string) => { if (changed === resource) notify(); };
    this.terminalJournal.listeners.add(committed);
    signal.addEventListener('abort', notify, { once: true });
    try {
      while (!signal.aborted) {
        const changed = Promise.withResolvers<void>();
        wake = changed.resolve;
        if (observer.failure) throw observer.failure;
        for (const event of this.terminalJournal.replay(resource, cursor, initial)) {
          if (signal.aborted) return;
          yield event;
          if (event.type !== 'resync') { cursor = event.cursor; initial = false; }
        }
        await changed.promise;
      }
    } finally {
      this.terminalJournal.listeners.delete(committed);
      signal.removeEventListener('abort', notify);
      if (--observer.references === 0) {
        observer.controller.abort();
        this.terminalObservers.delete(resource);
      }
    }
  }

  private async observeTerminals(spaceId: string, name: string | null, resource: string, scope: HubScope, signal: AbortSignal): Promise<void> {
    let dirty = true;
    let failure: Error | null = null;
    let wake: (() => void) | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    const runtimeDir = getDaemonRuntimeDir(scope.client.projectDir);
    const daemonsDir = join(runtimeDir, 'daemons');
    const watchers = new Map<string, FSWatcher>();
    const changed = () => { dirty = true; notify(); };
    const install = (path: string, relevant: (file: string | null) => boolean) => {
      if (watchers.has(path)) return;
      try {
        const watcher = watch(path, (_event, file) => { if (relevant(file?.toString() ?? null)) changed(); });
        watcher.on('error', (error) => { failure = error; notify(); });
        watchers.set(path, watcher);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    };
    signal.addEventListener('abort', notify, { once: true });
    try {
      await scope.client.request({ op: 'list' });
      install(runtimeDir, (file) => file === null || file === 'daemons');
      while (!signal.aborted) {
        const changed = Promise.withResolvers<void>();
        wake = changed.resolve;
        if (failure) throw failure;
        if (dirty) {
          dirty = false;
          install(daemonsDir, () => true);
          const directories = await readdir(daemonsDir, { withFileTypes: true }).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
            throw error;
          });
          const currentDirectories = new Set<string>();
          for (const directory of directories) {
            if (!directory.isDirectory()) continue;
            const path = join(daemonsDir, directory.name);
            currentDirectories.add(path);
            install(path, (file) => file === null || file === 'meta.json' || (name === directory.name && file === 'output.log'));
          }
          for (const [path, watcher] of watchers) {
            if (path !== runtimeDir && path !== daemonsDir && !currentDirectories.has(path)) { watcher.close(); watchers.delete(path); }
          }
          const terminals = await this.list(spaceId);
          const output = name !== null && terminals.some((terminal) => terminal.name === name) ? await this.read(spaceId, name, null) : null;
          if (signal.aborted) return;
          this.terminalJournal.commit(resource, { terminals, output });
        }
        if (dirty) continue;
        await changed.promise;
      }
    } finally {
      for (const watcher of watchers.values()) watcher.close();
      signal.removeEventListener('abort', notify);
    }
  }

  async createShell(spaceId: string): Promise<WorkspaceTerminalView> {
    const scope = await this.scope(spaceId);
    const shell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined) || '/bin/bash';
    const spec: DaemonSpec = {
      name: `gitspace-${spaceId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
      application: shell,
      args: [],
      env: {},
      cwd: scope.space.rootPath,
      pty: true,
      restart: 'no',
      persist: false,
      detached: false,
    };
    const started = await scope.client.request({ op: 'start', spec, owner: ownerFor(spaceId, 'user') });
    if (started.op !== 'start') throw new Error('OMP Hub returned an invalid start response');
    return this.view(spaceId, started.daemon, spec);
  }

  async startService(
    spaceId: string,
    serviceName: string,
    application: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<WorkspaceTerminalView> {
    const scope = await this.scope(spaceId);
    if (!isInside(scope.space.rootPath, cwd)) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const name = `gitspace-svc-${spaceId.slice(0, 12)}-${serviceName}`;
    try {
      const described = await scope.client.request({ op: 'describe', name });
      if (described.op === 'describe' && described.daemon.state !== 'exited' && described.daemon.state !== 'failed') {
        return this.view(spaceId, described.daemon, described.spec);
      }
    } catch { /* Service is not running yet. */ }
    const spec: DaemonSpec = {
      name,
      application,
      args,
      env,
      cwd,
      pty: false,
      restart: 'no',
      persist: true,
      detached: false,
    };
    const started = await scope.client.request({ op: 'start', spec, owner: `${ownerFor(spaceId, 'service')}:${serviceName}` });
    if (started.op !== 'start') throw new Error(`OMP Hub returned an invalid start response for service ${serviceName}`);
    return this.view(spaceId, started.daemon, spec);
  }

  async runLifecyclePlan(
    spaceId: string,
    phase: LifecycleRunPhase,
    steps: readonly WorkspaceLifecyclePlanStep[],
    env: Record<string, string>,
    options: { runId?: string; deadlineAt?: string; redactNames?: readonly string[]; onStarted?: () => Promise<void>; onOutput?: (output: string) => Promise<void>; directory?: string } = {},
  ): Promise<WorkspaceLifecyclePlanResult> {
    if (options.directory && phase.startsWith('workspace/')) throw new Error('Workspace hooks cannot run in a detached recovery checkout');
    const scope = options.directory
      ? { space: { rootPath: options.directory }, client: await this.clientForProject(options.directory) }
      : await this.scope(spaceId);
    const name = `life-${options.runId ?? crypto.randomUUID()}`;
    const marker = (kind: 'START' | 'END', id: string) => `__GITSPACE_${kind}__${Buffer.from(id).toString('base64url')}`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const plan = steps.flatMap((step) => {
      const start = marker('START', step.id);
      const end = marker('END', step.id);
      if (step.kind === 'script' && step.content === undefined) throw new Error('Lifecycle scripts require frozen approved content');
      const command = step.kind === 'script'
        ? `/bin/bash -c ${quote(step.content!)} ${quote(step.command)}`
        : `/bin/sh -c ${quote(step.command)}`;
      return [
        `printf '%s\\n' ${quote(start)}`,
        command,
        '__gitspace_status=$?',
        `printf '%s:%s\\n' ${quote(end)} \"$__gitspace_status\"`,
        'if [ \"$__gitspace_status\" -ne 0 ]; then exit \"$__gitspace_status\"; fi',
      ];
    }).join('\n');
    const ownSpool = !env.GITSPACE_LIFECYCLE_OUTPUT;
    const spoolRoot = ownSpool ? await mkdtemp(join(tmpdir(), 'gitspace-lifecycle-log-')) : dirname(env.GITSPACE_LIFECYCLE_OUTPUT!);
    const spoolPath = join(spoolRoot, 'runner.log');
    const spool = await open(spoolPath, 'wx+', 0o600);
    const deadline = options.deadlineAt ? Date.parse(options.deadlineAt) : Date.now() + DEFAULT_LIFECYCLE_TIMEOUT_MS;
    // Forward the caller's machine-user environment snapshot and explicit overrides,
    // not additional bootstrap credentials inherited by Hub. Redact granted secrets before spooling.
    const wrapper = `
      import { openSync, writeFileSync, closeSync } from 'node:fs';
      const log = openSync(${JSON.stringify(spoolPath)}, 'a');
      const emit = text => { writeFileSync(log, text); process.stdout.write(text); };
      const names = ${JSON.stringify(Object.keys(env))};
      const childEnv = Object.fromEntries(names.map(name => [name, process.env[name] ?? '']));
      const secrets = ${JSON.stringify(options.redactNames ?? [])}.map(name => childEnv[name]).filter(Boolean).sort((a, b) => b.length - a.length);
      const retained = Math.max(256, ...secrets.map(value => value.length));
      const clean = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value)
        .replace(/(https?:\\/\\/)[^\\s/@]+:[^\\s/@]+@/g, '$1[redacted]@');
      const child = Bun.spawn(['/bin/sh', '-c', ${JSON.stringify(`exec 2>&1\n${plan}`)}], {cwd: ${JSON.stringify(scope.space.rootPath)}, env: childEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
      let deadlineTimer;
      const enforceDeadline = () => {
        const remaining = ${deadline} - Date.now();
        if (remaining <= 0) child.kill('SIGKILL');
        else deadlineTimer = setTimeout(enforceDeadline, Math.min(remaining, 2147483647));
      };
      enforceDeadline();
      const pump = async stream => {
        const decoder = new TextDecoder(); let pending = '';
        for await (const bytes of stream) {
          pending = clean(pending + decoder.decode(bytes, {stream: true}));
          if (pending.length > retained) { emit(pending.slice(0, -retained)); pending = pending.slice(-retained); }
        }
        emit(clean(pending + decoder.decode()));
      };
      const [, , code] = await Promise.all([pump(child.stdout), pump(child.stderr), child.exited]);
      clearTimeout(deadlineTimer);
      closeSync(log);
      process.exit(code);
    `;
    const spec: DaemonSpec = {
      name,
      application: process.execPath,
      args: ['-e', wrapper],
      env,
      cwd: scope.space.rootPath,
      pty: false,
      restart: 'no',
      persist: true,
      detached: false,
    };
    let finished = false;
    try {
      const started = await scope.client.request({ op: 'start', spec, owner: `${ownerFor(spaceId, 'lifecycle')}:${phase}` });
      if (started.op !== 'start') throw new Error(`OMP Hub returned an invalid lifecycle start response for ${phase}`);
      await options.onStarted?.();
      let output = '';
      let daemon = started.daemon;
      let position = 0;
      const buffer = Buffer.allocUnsafe(65_536);
      const decoder = new TextDecoder();
      const stepPreviewLimit = Math.min(16_000, Math.floor(64_000 / Math.max(1, steps.length)));
      const scriptLog = new LifecycleLogReader({ ids: steps.map((step) => step.id), outputLimit: stepPreviewLimit });
      const consume = (chunk: string, final = false) => {
        output = (output + chunk).slice(-16_000);
        scriptLog.push(chunk, { final });
      };
      let logChanged = true;
      let notify: (() => void) | undefined;
      let waitFailure: unknown;
      const waitController = new AbortController();
      const spoolWatcher = watch(spoolPath, () => { logChanged = true; notify?.(); });
      spoolWatcher.on('error', (error) => { waitFailure = error; notify?.(); });
      // A single event-driven wait supervises completion. Log delivery follows
      // durable file notifications and never scans the spool on a sleep timer.
      void scope.client.request({ op: 'wait', name, for: 'exit', timeoutMs: Math.max(1, deadline - Date.now() + 5_000) }, waitController.signal).then((waited) => {
        if (waited.op !== 'wait' || waited.timedOut) waitFailure = new Error(`Lifecycle runner did not confirm exit by its deadline: ${phase}`);
        else { daemon = waited.daemon; finished = true; }
        notify?.();
      }).catch((error: unknown) => { waitFailure = error; notify?.(); });
      try {
        for (;;) {
          const changed = Promise.withResolvers<void>();
          notify = changed.resolve;
          if (waitFailure) throw waitFailure;
          logChanged = false;
          for (;;) {
            const { bytesRead } = await spool.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
            consume(chunk);
            if (chunk) await options.onOutput?.(chunk);
          }
          if (finished) {
            const final = decoder.decode();
            consume(final, true);
            if (final) await options.onOutput?.(final);
            break;
          }
          if (!logChanged) await changed.promise;
        }
      } finally { spoolWatcher.close(); waitController.abort(); }
      return { terminalName: name, exitCode: daemon.exitCode ?? 1, output, steps: scriptLog.results.map((step) => ({ ...step, output: step.output.trimEnd() })) };
    } finally {
      await spool.close();
      if (ownSpool && finished) await rm(spoolRoot, { recursive: true, force: true });
    }
  }

  async cancelLifecycleRun(spaceId: string, terminalName: string, directory?: string): Promise<void> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const client = await this.clientForProject(directory ?? space.rootPath);
    const listed = await client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('Unable to verify lifecycle runner existence');
    if (!listed.daemons.some((daemon) => daemon.name === terminalName)) return;
    const described = await client.request({ op: 'describe', name: terminalName });
    if (described.op !== 'describe' || !described.daemon.owner?.startsWith(`${ownerFor(spaceId, 'lifecycle')}:`)) {
      throw new Error('Cannot prove lifecycle runner ownership; explicit recovery is required');
    }
    if (described.daemon.state === 'exited' || described.daemon.state === 'failed') return;
    const stopped = await client.request({ op: 'stop', name: terminalName, timeoutMs: 5_000 });
    if (stopped.op !== 'stop') throw new Error('Unable to confirm lifecycle runner stopped');
    const verified = await client.request({ op: 'describe', name: terminalName });
    if (verified.op !== 'describe' || (verified.daemon.state !== 'exited' && verified.daemon.state !== 'failed')) throw new Error('Lifecycle runner is still active');
  }

  async stopOwned(spaceId: string): Promise<void> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const client = await this.clientForProject(space.rootPath);
    const listed = await client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('OMP Hub returned an invalid list response');
    for (const daemon of listed.daemons) {
      if (daemon.state === 'exited' || daemon.state === 'failed') continue;
      const described = await client.request({ op: 'describe', name: daemon.name });
      if (described.op !== 'describe' || !described.daemon.owner?.startsWith(`gitspace:${spaceId}:`)) continue;
      const stopped = await client.request({ op: 'stop', name: daemon.name, timeoutMs: 5_000 });
      if (stopped.op !== 'stop') throw new Error(`OMP Hub returned an invalid stop response for ${daemon.name}`);
    }
  }

  async read(spaceId: string, name: string, cursor: number | null): Promise<WorkspaceTerminalOutput> {
    const { client } = await this.terminal(spaceId, name);
    const result = await client.request({
      op: 'logs',
      name,
      lines: 1_000,
      head: false,
      follow: false,
      ...(cursor === null ? {} : { cursor }),
      renderTerminalRows: false,
      timeoutMs: 30_000,
    });
    if (result.op !== 'logs') throw new Error(`OMP Hub returned an invalid logs response for ${name}`);
    return {
      spaceId,
      name,
      state: result.state,
      cursor: result.cursor,
      data: result.terminalText ?? result.text,
    };
  }

  async send(spaceId: string, name: string, data: string): Promise<WorkspaceTerminalView> {
    const { client, spec } = await this.terminal(spaceId, name);
    const result = await client.request({ op: 'send', name, data });
    if (result.op !== 'send') throw new Error(`OMP Hub returned an invalid send response for ${name}`);
    return this.view(spaceId, result.daemon, spec);
  }


  async stop(spaceId: string, name: string): Promise<WorkspaceTerminalView> {
    const { client, spec } = await this.terminal(spaceId, name);
    const result = await client.request({ op: 'stop', name, timeoutMs: 5_000 });
    if (result.op !== 'stop') throw new Error(`OMP Hub returned an invalid stop response for ${name}`);
    return this.view(spaceId, result.daemon, spec);
  }

  private async terminal(spaceId: string, name: string): Promise<{ client: DaemonBrokerClient; spec: DaemonSpec }> {
    const scope = await this.scope(spaceId);
    try {
      const result = await scope.client.request({ op: 'describe', name });
      if (result.op !== 'describe' || !isInside(scope.space.rootPath, result.spec.cwd)) {
        throw new WorkspaceHubTerminalUnavailable(spaceId, name);
      }
      return { client: scope.client, spec: result.spec };
    } catch (error) {
      if (error instanceof WorkspaceHubTerminalUnavailable) throw error;
      throw new WorkspaceHubTerminalUnavailable(spaceId, name);
    }
  }

  private async scope(spaceId: string): Promise<HubScope> {
    const space = this.database.getSpace(spaceId);
    if (!space || space.placementState === 'closed' || space.holderId !== this.machineId) {
      throw new WorkspaceHubSpaceUnavailable(spaceId);
    }
    return { space, client: await this.clientForProject(space.rootPath) };
  }

  private view(spaceId: string, daemon: DaemonSnapshot, spec: DaemonSpec): WorkspaceTerminalView {
    return {
      spaceId,
      name: daemon.name,
      id: daemon.id,
      kind: terminalKind(spaceId, daemon.owner),
      state: daemon.state,
      machineId: this.machineId,
      owner: daemon.owner ?? null,
      command: displayCommand(spec),
      cwd: spec.cwd,
      createdAt: new Date(daemon.createdAt),
      exitCode: daemon.exitCode ?? null,
    };
  }
}
