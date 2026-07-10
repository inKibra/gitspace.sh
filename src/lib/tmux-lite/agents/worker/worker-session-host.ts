/**
 * WorkerSessionHost — daemon-side AgentSessionHost proxy over a per-session
 * child process (Bun.spawn + ipc). The child runs agent-worker.ts, which owns
 * a LocalSessionHost; every method here forwards as an RPC or cast, and the
 * child's sink callbacks arrive as push messages.
 */

import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import type {
  AgentControlInfo,
  AgentHistoryEntry,
  AgentToolInfo,
  AgentTreeNode,
} from '../../../../agents/agent-runtime-types.js';
import type { TranscriptPage } from '../../../../blocks/agent/transcript-source.js';
import type { AgentPromptImage } from '../../protocol.js';
import type { HostUIDialogResponse } from '../host-ui-bridge.js';
import type {
  AgentSessionHost,
  SessionCommandInfo,
  SessionHostBoot,
  SessionHostSinks,
  SessionHostTarget,
} from '../session-host.js';
import {
  isWorkerNotification,
  type WorkerCastMethod,
  type WorkerRequest,
  type WorkerRpcMethod,
} from './protocol.js';

/** Session boot: SDK import + session open + model-registry refresh (network). */
const BOOT_TIMEOUT_MS = 120_000;
/** Default RPC deadline. */
const RPC_TIMEOUT_MS = 120_000;
/** Compaction runs an LLM summarization turn — allow much longer. */
const COMPACT_TIMEOUT_MS = 600_000;
/** Grace between 'shutdown' and SIGKILL on dispose. */
const SHUTDOWN_GRACE_MS = 10_000;

const WORKER_SCRIPT = fileURLToPath(new URL('./agent-worker.ts', import.meta.url));

function getWorkerCommand(): string[] {
  // Mirror tmux-lite cli.getServerCommand(): compiled binaries re-exec
  // themselves with an internal flag; dev invokes the script directly.
  const isCompiled = !process.execPath.endsWith('bun');
  const cmd = isCompiled
    ? [process.execPath, '--internal-agent-worker']
    : ['bun', WORKER_SCRIPT];
  // Own session per worker (Linux): an agent's group-wide signal (`kill 0`,
  // ctrl-c semantics, stray `kill -- -pgid`) from a bash-tool child then hits
  // ONLY that worker's session, never the daemon/relay/other sessions. A
  // fresh spawn is never a group leader, so setsid execs in place — same pid,
  // IPC fd and proc.kill() untouched.
  if (process.platform === 'linux' && Bun.which('setsid')) {
    return ['setsid', ...cmd];
  }
  return cmd;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WorkerSessionHostConfig {
  enableUI?: boolean;
  /** Fired when the child exits without dispose() having been requested. */
  onUnexpectedExit?: (sessionId: string, detail: string) => void;
}

export class WorkerSessionHost implements AgentSessionHost {
  readonly sessionId: string;
  readonly target: SessionHostTarget;

  private readonly proc: Subprocess;
  private readonly pending = new Map<number, PendingRpc>();
  private nextRpcId = 1;
  private disposed = false;
  private exited = false;
  private uiOn: boolean;

  private constructor(args: {
    sessionId: string;
    target: SessionHostTarget;
    proc: Subprocess;
    config: WorkerSessionHostConfig;
  }) {
    this.sessionId = args.sessionId;
    this.target = args.target;
    this.proc = args.proc;
    this.uiOn = args.config.enableUI ?? false;
  }

  static async boot(
    target: SessionHostTarget,
    boot: SessionHostBoot,
    sinks: SessionHostSinks,
    config: WorkerSessionHostConfig = {},
  ): Promise<WorkerSessionHost> {
    let hostRef: WorkerSessionHost | null = null;
    let readyResolve!: (sessionId: string) => void;
    let readyReject!: (err: Error) => void;
    const ready = new Promise<string>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const proc = Bun.spawn({
      cmd: getWorkerCommand(),
      env: process.env as Record<string, string>,
      // Worker logs interleave into the daemon's log (the daemon's stdio is
      // already the daemon log file).
      stdout: 'inherit',
      stderr: 'inherit',
      ipc(rawMessage) {
        if (!isWorkerNotification(rawMessage)) return;
        const msg = rawMessage;
        switch (msg.t) {
          case 'ready':
            readyResolve(msg.sessionId);
            return;
          case 'init-error':
            readyReject(new Error(msg.error));
            return;
          case 'rpc-result':
            hostRef?.settleRpc(msg.id, msg.ok, msg.ok ? msg.result : msg.error);
            return;
          case 'event':
            sinks.onEvent(msg.event);
            return;
          case 'dialog-request':
            sinks.onDialogRequest(msg.request);
            return;
          case 'ui-event':
            sinks.onUiEvent(msg.event);
            return;
          case 'terminal-output':
            sinks.onTerminalOutput(msg.data);
            return;
        }
      },
    });

    void proc.exited.then((code) => {
      readyReject(new Error(`agent worker exited during boot (code ${code})`));
      hostRef?.handleExit(code, config);
    });

    proc.send({
      t: 'init',
      target,
      boot,
      enableUI: config.enableUI ?? false,
    } satisfies WorkerRequest);

    const bootTimer = setTimeout(() => {
      readyReject(new Error(`agent worker boot timed out after ${BOOT_TIMEOUT_MS}ms`));
      proc.kill();
    }, BOOT_TIMEOUT_MS);

    let sessionId: string;
    try {
      sessionId = await ready;
    } catch (err) {
      proc.kill();
      throw err;
    } finally {
      clearTimeout(bootTimer);
    }

    hostRef = new WorkerSessionHost({ sessionId, target, proc, config });
    return hostRef;
  }

  // --- conversation ---------------------------------------------------------

  async prompt(text: string, images?: AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    await this.rpc('prompt', [text, images, options]);
  }

  interrupt(): Promise<boolean> {
    return this.rpc('interrupt', []) as Promise<boolean>;
  }

  compact(instructions?: string): Promise<boolean> {
    return this.rpc('compact', [instructions], COMPACT_TIMEOUT_MS) as Promise<boolean>;
  }

  removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<string | null> {
    return this.rpc('removeQueuedMessage', [kind, index]) as Promise<string | null>;
  }

  // --- control surface --------------------------------------------------------

  setModel(provider: string, modelId: string): Promise<boolean> {
    return this.rpc('setModel', [provider, modelId]) as Promise<boolean>;
  }

  getControlInfo(): Promise<AgentControlInfo> {
    return this.rpc('getControlInfo', []) as Promise<AgentControlInfo>;
  }

  cycleRole(direction: 'forward' | 'backward'): Promise<boolean> {
    return this.rpc('cycleRole', [direction]) as Promise<boolean>;
  }

  applyRole(role: string): Promise<boolean> {
    return this.rpc('applyRole', [role]) as Promise<boolean>;
  }

  setThinkingLevel(level: string): Promise<boolean> {
    return this.rpc('setThinkingLevel', [level]) as Promise<boolean>;
  }

  setApprovalMode(mode: string): Promise<boolean> {
    return this.rpc('setApprovalMode', [mode]) as Promise<boolean>;
  }

  setSetting(path: string, value: string | number | boolean | string[]): Promise<boolean> {
    return this.rpc('setSetting', [path, value]) as Promise<boolean>;
  }

  getTools(): Promise<AgentToolInfo[]> {
    return this.rpc('getTools', []) as Promise<AgentToolInfo[]>;
  }

  getHistory(): Promise<AgentHistoryEntry[]> {
    return this.rpc('getHistory', []) as Promise<AgentHistoryEntry[]>;
  }

  navigateHistory(entryId: string, mode: 'redo' | 'jump'): Promise<{ ok: boolean; editorText?: string }> {
    return this.rpc('navigateHistory', [entryId, mode]) as Promise<{ ok: boolean; editorText?: string }>;
  }

  getSessionTree(): Promise<AgentTreeNode[]> {
    return this.rpc('getSessionTree', []) as Promise<AgentTreeNode[]>;
  }

  readTranscriptRange(opts: { before?: string; limit: number }): Promise<TranscriptPage> {
    return this.rpc('readTranscriptRange', [opts]) as Promise<TranscriptPage>;
  }

  listSessionCommands(reservedNames: string[]): Promise<SessionCommandInfo[]> {
    return this.rpc('listSessionCommands', [reservedNames]) as Promise<SessionCommandInfo[]>;
  }

  // --- host-UI bridge -----------------------------------------------------

  enableUI(): void {
    this.uiOn = true;
    this.cast('enableUI', []);
  }

  get uiEnabled(): boolean {
    return this.uiOn;
  }

  resolveDialog(response: HostUIDialogResponse): Promise<boolean> {
    return this.rpc('resolveDialog', [response]) as Promise<boolean>;
  }

  setEditorTextFromClient(text: string): void {
    this.cast('setEditorTextFromClient', [text]);
  }

  setTitle(title: string | undefined): void {
    this.cast('setTitle', [title]);
  }

  // --- interactive terminal --------------------------------------------------

  async startTerminal(cols: number, rows: number): Promise<void> {
    await this.rpc('startTerminal', [cols, rows]);
  }

  async stopTerminal(): Promise<void> {
    if (this.exited) return;
    await this.rpc('stopTerminal', []);
  }

  injectTerminalInput(data: string): void {
    this.cast('injectTerminalInput', [data]);
  }

  resizeTerminal(cols: number, rows: number): void {
    this.cast('resizeTerminal', [cols, rows]);
  }

  // --- lifecycle -----------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.exited) return;
    try {
      this.proc.send({ t: 'shutdown' } satisfies WorkerRequest);
    } catch {
      this.proc.kill();
      return;
    }
    const graceful = await Promise.race([
      this.proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
    ]);
    if (!graceful) {
      console.error(`[worker-session-host] worker for ${this.sessionId} ignored shutdown; killing`);
      this.proc.kill();
    }
  }

  /** Signal-handler-safe teardown: ask nicely, then SIGTERM. The worker's SDK
   *  postmortem handlers run cleanup and exit; the ppid watchdog + IPC
   *  disconnect cover the SIGKILL/crash cases. */
  kill(): void {
    this.disposed = true;
    try {
      this.proc.send({ t: 'shutdown' } satisfies WorkerRequest);
    } catch {
      /* channel already gone */
    }
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }

  // --- internals -----------------------------------------------------------

  private rpc(method: WorkerRpcMethod, args: unknown[], timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.exited || this.disposed) {
      return Promise.reject(new Error(`agent worker for ${this.sessionId} is not running`));
    }
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent worker rpc '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.send({ t: 'rpc', id, method, args } satisfies WorkerRequest);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private cast(method: WorkerCastMethod, args: unknown[]): void {
    if (this.exited || this.disposed) return;
    try {
      this.proc.send({ t: 'cast', method, args } satisfies WorkerRequest);
    } catch (err) {
      console.error(`[worker-session-host] cast ${method} failed for ${this.sessionId}:`, err);
    }
  }

  private settleRpc(id: number, ok: boolean, payload: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(payload);
    else pending.reject(new Error(String(payload)));
  }

  private handleExit(code: number | null, config: WorkerSessionHostConfig): void {
    if (this.exited) return;
    this.exited = true;
    const detail = `agent worker exited (code ${code ?? 'unknown'})`;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    if (!this.disposed) {
      config.onUnexpectedExit?.(this.sessionId, detail);
    }
  }
}
