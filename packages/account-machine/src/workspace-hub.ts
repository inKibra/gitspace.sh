import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { watch } from 'node:fs';
import { streamCursorSchema, type StreamEvent } from '@gitspace/protocol-sync';
import { ProtectedTerminalTail, TerminalSnapshotJournal, type TerminalSnapshot } from './terminal-stream.js';
import { PROTECTED_LIFECYCLE_SOCKET, protectedLifecycleLive, protectedLifecycleWrapper, sendProtectedLifecycleInput } from './protected-lifecycle.js';
import { terminalLiveResource, terminalStreamResource, type MachineLiveNotice, type ProtectedTerminalBatch } from '@gitspace/protocol';
import { DEFAULT_LIFECYCLE_TIMEOUT_MS, LifecycleLogReader, type LifecycleRun, type LifecycleRunPhase } from '@gitspace/protocol-environment';
import { checkoutTerminalEnvironment, inheritedCommandEnvironment } from '@gitspace/runtime-machine';
import {
  daemonClientForProject,
  type DaemonBrokerClient,
} from '@gitspace/supervisor';
import type {
  DaemonSnapshot,
  DaemonSpec,
  DaemonStartSpec,
  DaemonState,
} from '@gitspace/supervisor';

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
  protected?: boolean;
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

/** Checkouts this machine holds, by workspace id (the executor's ready attachments). */
export interface WorkspaceCheckouts {
  /** Root of the ready checkout for a workspace, or null when this machine holds none. */
  path(spaceId: string): string | null;
  /** Project of a held workspace, or null. */
  projectId(spaceId: string): string | null;
  /** Workspace ids with a ready checkout. */
  list(): string[];
  use(spaceId: string): Promise<void>;
}

type HubClientFactory = (projectDirectory: string) => Promise<DaemonBrokerClient>;

interface HubScope {
  space: { rootPath: string };
  client: DaemonBrokerClient;
}
/** An observer runs from a tab's first read until the relay reports nobody watches it; `lastRead` is the cursor a read
 * last returned. */
interface TerminalObserver { spaceId: string; controller: AbortController; ready: Promise<void>; failure: Error | null; lastRead: number }
interface ProtectedObserver { spaceId: string; controller: AbortController; tail: ProtectedTerminalTail; ended: boolean; failure: Error | null; lastRead: number }
/** Ended protected attachments kept for tabs still to read their completion; older ones are dropped. */
const RETAINED_ENDED_PROTECTED = 8;
/** Announces that a resource this machine observes changed, for the relay to tell the tabs watching it. */
export type TerminalLiveNotify = (notice: MachineLiveNotice) => void;

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
  private readonly terminalJournal = new TerminalSnapshotJournal((resource, cursor) => {
    const observer = this.terminalObservers.get(resource);
    if (observer) this.notify?.({ workspace: observer.spaceId, resource, cursor });
  });
  private readonly terminalObservers = new Map<string, TerminalObserver>();
  private readonly protectedObservers = new Map<string, ProtectedObserver>();
  private protectedRevision = 0;
  private readonly protectedSockets = new Map<string, string>();
  constructor(
    private readonly machineId: string,
    private readonly checkouts: WorkspaceCheckouts,
    private readonly clientForProject: HubClientFactory = daemonClientForProject,
    private readonly notify?: TerminalLiveNotify,
  ) {}

  async list(spaceId: string): Promise<WorkspaceTerminalView[]> {
    const scope = await this.scope(spaceId);
    const listed = await scope.client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('Supervisor returned an invalid list response');
    const activeDaemons = listed.daemons.filter((daemon) => daemon.state !== 'exited' && daemon.state !== 'failed');
    const terminals = await Promise.all(activeDaemons.map(async (daemon) => {
      const described = await scope.client.request({ op: 'describe', name: daemon.name });
      if (described.op !== 'describe') throw new Error(`Supervisor returned an invalid describe response for ${daemon.name}`);
      return isInside(scope.space.rootPath, described.spec.cwd)
        ? this.view(spaceId, described.daemon, described.spec)
        : null;
    }));
    return terminals.filter((terminal): terminal is WorkspaceTerminalView => terminal !== null)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  /** Starts (or keeps) observing the resource and returns its journal after `after`. The observer announces each commit
   * through `notify` until `unwatched` stops it; a failed observer fails this read, and the next read starts another. */
  async events(spaceId: string, name: string | null, after: number | null): Promise<StreamEvent<TerminalSnapshot>[]> {
    if (after !== null) streamCursorSchema.parse(after);
    const scope = await this.scope(spaceId);
    const resource = terminalStreamResource(spaceId, this.machineId, name);
    const observer = this.terminalObservers.get(resource) ?? this.observe(spaceId, name, resource, scope);
    await observer.ready;
    if (observer.failure) {
      if (this.terminalObservers.get(resource) === observer) this.terminalObservers.delete(resource);
      throw observer.failure;
    }
    observer.lastRead = this.terminalJournal.cursor(resource);
    return this.terminalJournal.replay(resource, after);
  }

  /** The relay reports no tab watched `resource` at `cursor`. Unless a read has returned that change since (its reader
   * may still be subscribing), stop observing it; the next read starts again. */
  unwatched(resource: string, cursor: number): void {
    const terminal = this.terminalObservers.get(resource);
    if (terminal && terminal.lastRead < cursor) {
      terminal.controller.abort();
      this.terminalObservers.delete(resource);
    }
    const live = this.protectedObservers.get(resource);
    if (live && live.lastRead < cursor) {
      live.controller.abort();
      this.protectedObservers.delete(resource);
    }
  }

  /** `ready` settles once the first observation is committed or the observer stops. */
  private observe(spaceId: string, name: string | null, resource: string, scope: HubScope): TerminalObserver {
    const ready = Promise.withResolvers<void>();
    const observer: TerminalObserver = { spaceId, controller: new AbortController(), ready: ready.promise, failure: null, lastRead: 0 };
    this.terminalObservers.set(resource, observer);
    void this.observeTerminals(spaceId, name, resource, scope, observer.controller.signal, ready.resolve).catch((error: unknown) => {
      if (observer.controller.signal.aborted) return;
      observer.failure = error instanceof Error ? error : new Error(String(error));
      // Watching tabs read again and see the failure; their next read starts a new observer.
      this.notify?.({ workspace: spaceId, resource, cursor: this.terminalJournal.cursor(resource) });
    }).finally(ready.resolve);
    return observer;
  }

  private async observeTerminals(spaceId: string, name: string | null, resource: string, scope: HubScope, signal: AbortSignal, observed: () => void): Promise<void> {
    let dirty = true;
    let failure: Error | null = null;
    let wake: (() => void) | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    signal.addEventListener('abort', notify, { once: true });
    // The supervisor confirms every start, state transition, and the selected terminal's output.
    // Transient shells keep no runtime files, so file notifications cannot observe them.
    void (async () => {
      let revision: number | undefined;
      let cursor: number | null = null;
      while (!signal.aborted) {
        const observed = await scope.client.request({
          op: 'watch',
          ...(revision === undefined ? {} : { revision }),
          ...(name === null ? {} : { name, ...(cursor === null ? {} : { cursor }) }),
        }, signal);
        if (observed.op !== 'watch') throw new Error('Supervisor returned an invalid watch response');
        if (observed.revision === revision && observed.cursor === cursor) continue;
        revision = observed.revision;
        cursor = observed.cursor;
        dirty = true;
        notify();
      }
    })().catch((error: unknown) => {
      if (signal.aborted) return;
      failure = error instanceof Error ? error : new Error(String(error));
      notify();
    });
    try {
      while (!signal.aborted) {
        const changed = Promise.withResolvers<void>();
        wake = changed.resolve;
        if (failure) throw failure;
        if (dirty) {
          dirty = false;
          const terminals = await this.list(spaceId);
          // Keep only the selected completed lifecycle terminal visible, rather
          // than replaying an unbounded list of historical runs.
          if (name !== null && !terminals.some((terminal) => terminal.name === name)) {
            const described = await scope.client.request({ op: 'describe', name }).catch(() => null);
            if (described?.op === 'describe' && isInside(scope.space.rootPath, described.spec.cwd)
              && terminalKind(spaceId, described.daemon.owner) === 'lifecycle') {
              terminals.push(this.view(spaceId, described.daemon, described.spec));
            }
          }
          const output = name !== null && terminals.some((terminal) => terminal.name === name) ? await this.read(spaceId, name, null) : null;
          if (signal.aborted) return;
          this.terminalJournal.commit(resource, { terminals, output });
          observed();
        }
        if (dirty) continue;
        await changed.promise;
      }
    } finally {
      signal.removeEventListener('abort', notify);
    }
  }

  /** A user shell in the space's ready checkout on this machine,
   * with the checkout's `.gitspace/bundle.json` terminal PATH and variables applied. */
  async createShell(spaceId: string): Promise<WorkspaceTerminalView> {
    await this.checkouts.use(spaceId);
    const scope = await this.scope(spaceId);
    const shell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined) || '/bin/bash';
    const spec: DaemonStartSpec = {
      name: `gitspace-${spaceId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
      application: shell,
      args: [],
      env: await checkoutTerminalEnvironment(scope.space.rootPath, inheritedCommandEnvironment()),
      cwd: scope.space.rootPath,
      pty: true,
      restart: 'no',
      persist: false,
      detached: false,
    };
    const started = await scope.client.request({ op: 'start', spec, owner: ownerFor(spaceId, 'user') });
    if (started.op !== 'start') throw new Error('Supervisor returned an invalid start response');
    const { env, ...configuration } = spec;
    return this.view(spaceId, started.daemon, { ...configuration, envNames: Object.keys(env) });
  }

  async startService(
    spaceId: string,
    serviceName: string,
    application: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<WorkspaceTerminalView> {
    await this.checkouts.use(spaceId);
    const scope = await this.scope(spaceId);
    if (!isInside(scope.space.rootPath, cwd)) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const name = `gitspace-svc-${spaceId.slice(0, 12)}-${serviceName}`;
    try {
      const described = await scope.client.request({ op: 'describe', name });
      if (described.op === 'describe' && described.daemon.state !== 'exited' && described.daemon.state !== 'failed') {
        return this.view(spaceId, described.daemon, described.spec);
      }
    } catch { /* Service is not running yet. */ }
    const spec: DaemonStartSpec = {
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
    if (started.op !== 'start') throw new Error(`Supervisor returned an invalid start response for service ${serviceName}`);
    const { env: bindings, ...configuration } = spec;
    return this.view(spaceId, started.daemon, { ...configuration, envNames: Object.keys(bindings) });
  }

  async runLifecyclePlan(
    spaceId: string,
    phase: LifecycleRunPhase,
    steps: readonly WorkspaceLifecyclePlanStep[],
    env: Record<string, string>,
    options: { interactive?: boolean; runId?: string; deadlineAt?: string; redactNames?: readonly string[]; onStarted?: () => Promise<void>; onOutput?: (output: string) => Promise<void>; directory?: string } = {},
  ): Promise<WorkspaceLifecyclePlanResult> {
    if (options.interactive && options.directory && options.directory !== this.checkouts.path(spaceId)) throw new Error('Interactive lifecycle execution cannot run in a detached recovery checkout');
    if (options.interactive && (!['linux', 'darwin'].includes(process.platform) || steps.some((step) => step.kind !== 'script'))) throw new Error('Protected interactive lifecycle execution requires a POSIX script phase');
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
    const privateRoot = options.interactive ? await mkdtemp(join(tmpdir(), 'gitspace-pty-')) : null;
    const socketPath = privateRoot ? join(privateRoot, 'live.sock') : null;
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
    const spec: DaemonStartSpec = {
      name,
      application: process.execPath,
      args: ['-e', socketPath ? protectedLifecycleWrapper({ socketPath, spoolPath, cwd: scope.space.rootPath, deadline, envNames: Object.keys(env), steps }) : wrapper],
      env: socketPath ? { ...env, [PROTECTED_LIFECYCLE_SOCKET]: socketPath } : env,
      cwd: scope.space.rootPath,
      pty: false,
      ...(socketPath ? { ready: { log: 'Protected lifecycle terminal ready\\.', timeoutMs: Math.max(1, deadline - Date.now()) } } : {}),
      restart: 'no',
      persist: true,
      detached: false,
    };
    let finished = false;
    if (socketPath) this.protectedSockets.set(name, socketPath);
    try {
      const started = await scope.client.request({ op: 'start', spec, owner: `${ownerFor(spaceId, 'lifecycle')}:${phase}` });
      if (started.op !== 'start') throw new Error(`Supervisor returned an invalid lifecycle start response for ${phase}`);
      if (socketPath) {
        const ready = await scope.client.request({ op: 'wait', name, for: 'ready', timeoutMs: Math.max(1, deadline - Date.now()) });
        if (ready.op !== 'wait' || ready.timedOut || ready.daemon.state !== 'ready') throw new Error('Protected lifecycle terminal did not become ready');
      }
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
      if (socketPath && !output.includes('__GITSPACE_PROTECTED_CLEAN__')) throw new Error('Protected lifecycle process cleanup was not confirmed; explicit recovery is required');
      return { terminalName: name, exitCode: daemon.exitCode ?? 1, output, steps: scriptLog.results.map((step) => ({ ...step, output: step.output.trimEnd() })) };
    } finally {
      this.protectedSockets.delete(name);
      await spool.close();
      if (ownSpool && finished) await rm(spoolRoot, { recursive: true, force: true });
      if (privateRoot && finished) await rm(privateRoot, { recursive: true, force: true });
    }
  }

  async cancelLifecycleRun(spaceId: string, terminalName: string, directory?: string): Promise<void> {
    // Recovery runs name their checkout; others run in the held checkout.
    const root = directory ?? this.checkouts.path(spaceId);
    if (!root) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const client = await this.clientForProject(root);
    const listed = await client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('Unable to verify lifecycle runner existence');
    if (!listed.daemons.some((daemon) => daemon.name === terminalName)) return;
    const described = await client.request({ op: 'describe', name: terminalName });
    if (described.op !== 'describe' || !described.daemon.owner?.startsWith(`${ownerFor(spaceId, 'lifecycle')}:`)) {
      throw new Error('Cannot prove lifecycle runner ownership; explicit recovery is required');
    }
    if (described.daemon.state !== 'exited' && described.daemon.state !== 'failed') {
      const stopped = await client.request({ op: 'stop', name: terminalName, timeoutMs: 5_000 });
      if (stopped.op !== 'stop') throw new Error('Unable to confirm lifecycle runner stopped');
    }
    const verified = await client.request({ op: 'describe', name: terminalName });
    if (verified.op !== 'describe' || (verified.daemon.state !== 'exited' && verified.daemon.state !== 'failed')) throw new Error('Lifecycle runner is still active');
    if (described.spec.envNames.includes(PROTECTED_LIFECYCLE_SOCKET)) {
      const logs = await client.request({ op: 'logs', name: terminalName, lines: 1_000, head: false, follow: false, renderTerminalRows: false, timeoutMs: 5_000 });
      if (logs.op !== 'logs' || !logs.text.includes('__GITSPACE_PROTECTED_CLEAN__')) throw new Error('Protected lifecycle process cleanup was not confirmed; explicit recovery is required');
    }
  }

  async stopOwned(spaceId: string): Promise<void> {
    const root = this.checkouts.path(spaceId);
    if (!root) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const client = await this.clientForProject(root);
    const listed = await client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('Supervisor returned an invalid list response');
    for (const daemon of listed.daemons) {
      if (daemon.state === 'exited' || daemon.state === 'failed') continue;
      const described = await client.request({ op: 'describe', name: daemon.name });
      if (described.op !== 'describe' || !described.daemon.owner?.startsWith(`gitspace:${spaceId}:`)) continue;
      if (terminalKind(spaceId, described.daemon.owner) === 'lifecycle') {
        await this.cancelLifecycleRun(spaceId, daemon.name);
        continue;
      }
      const stopped = await client.request({ op: 'stop', name: daemon.name, timeoutMs: 5_000 });
      if (stopped.op !== 'stop') throw new Error(`Supervisor returned an invalid stop response for ${daemon.name}`);
      const verified = await client.request({ op: 'describe', name: daemon.name });
      if (verified.op !== 'describe' || (verified.daemon.state !== 'exited' && verified.daemon.state !== 'failed')) {
        throw new Error(`Terminal ${daemon.name} is still active`);
      }
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
    if (result.op !== 'logs') throw new Error(`Supervisor returned an invalid logs response for ${name}`);
    return {
      spaceId,
      name,
      state: result.state,
      cursor: result.cursor,
      data: result.terminalText ?? result.text,
    };
  }

  /** Attaches (or keeps) this machine's private connection to a protected terminal and returns its events after `after`.
   * Output stays in this process's memory, bounded; the attachment lasts until `unwatched` or the run ends, and a failed
   * one fails this read so the next read attaches again. */
  async live(spaceId: string, name: string, after: number | null): Promise<ProtectedTerminalBatch> {
    const resource = terminalLiveResource(this.machineId, name);
    const existing = this.protectedObservers.get(resource);
    if (existing && existing.spaceId !== spaceId) throw new WorkspaceHubTerminalUnavailable(spaceId, name);
    if (existing?.failure) {
      this.protectedObservers.delete(resource);
      throw existing.failure;
    }
    let observer = existing;
    if (!observer) {
      const { spec } = await this.terminal(spaceId, name);
      const path = spec.envNames.includes(PROTECTED_LIFECYCLE_SOCKET) ? this.protectedSockets.get(name) : undefined;
      if (!path) throw new Error('Protected live stream is unavailable; its owning lifecycle coordinator must still be running');
      observer = this.protectedObservers.get(resource) ?? this.attachProtected(spaceId, resource, path);
    }
    observer.lastRead = observer.tail.head;
    return observer.tail.read(after);
  }

  private attachProtected(spaceId: string, resource: string, path: string): ProtectedObserver {
    const controller = new AbortController();
    const observer: ProtectedObserver = { spaceId, controller, tail: new ProtectedTerminalTail(() => ++this.protectedRevision, this.protectedRevision), ended: false, failure: null, lastRead: 0 };
    this.protectedObservers.set(resource, observer);
    void (async () => {
      for await (const event of protectedLifecycleLive(path, controller.signal)) this.notify?.({ workspace: spaceId, resource, cursor: observer.tail.append(event) });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      observer.failure = error instanceof Error ? error : new Error(String(error));
      // Watching tabs read again and see the failure; their next read attaches again.
      this.notify?.({ workspace: spaceId, resource, cursor: observer.tail.head });
    }).finally(() => {
      if (controller.signal.aborted) return;
      observer.ended = true;
      // An ended attachment holds only its bounded tail, for tabs still to read its completion; keep the latest few.
      const ended = [...this.protectedObservers].filter(([, entry]) => entry.ended);
      for (const [key] of ended.slice(0, -RETAINED_ENDED_PROTECTED)) this.protectedObservers.delete(key);
    });
    return observer;
  }

  async send(spaceId: string, name: string, data: string): Promise<WorkspaceTerminalView> {
    const { client, spec } = await this.terminal(spaceId, name);
    const path = this.protectedSockets.get(name);
    if (spec.envNames.includes(PROTECTED_LIFECYCLE_SOCKET)) {
      if (!path) throw new Error('Protected live stream is unavailable; its owning lifecycle coordinator must still be running');
      await sendProtectedLifecycleInput(path, data);
      const described = await client.request({ op: 'describe', name });
      if (described.op !== 'describe') throw new Error('Unable to confirm protected terminal identity');
      return this.view(spaceId, described.daemon, spec);
    }
    const result = await client.request({ op: 'send', name, data });
    if (result.op !== 'send') throw new Error(`Supervisor returned an invalid send response for ${name}`);
    return this.view(spaceId, result.daemon, spec);
  }


  async stop(spaceId: string, name: string): Promise<WorkspaceTerminalView> {
    const { client, spec } = await this.terminal(spaceId, name);
    const described = await client.request({ op: 'describe', name });
    if (described.op !== 'describe') throw new Error('Unable to confirm terminal ownership');
    if (terminalKind(spaceId, described.daemon.owner) === 'lifecycle') throw new Error('Lifecycle terminals must be cancelled through their environment run');
    const result = await client.request({ op: 'stop', name, timeoutMs: 5_000 });
    if (result.op !== 'stop') throw new Error(`Supervisor returned an invalid stop response for ${name}`);
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
    const root = this.checkouts.path(spaceId);
    if (!root) throw new WorkspaceHubSpaceUnavailable(spaceId);
    return { space: { rootPath: root }, client: await this.clientForProject(root) };
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
      command: spec.envNames.includes(PROTECTED_LIFECYCLE_SOCKET) ? 'Protected lifecycle script' : displayCommand(spec),
      cwd: spec.cwd,
      createdAt: new Date(daemon.createdAt),
      exitCode: daemon.exitCode ?? null,
      ...(spec.envNames.includes(PROTECTED_LIFECYCLE_SOCKET) ? { protected: true } : {}),
    };
  }
}
