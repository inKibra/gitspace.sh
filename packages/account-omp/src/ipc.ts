import type { SessionActivity, SkillView } from '@gitspace/protocol';
import type { CustomTool } from '@oh-my-pi/pi-coding-agent';
import type { MCPPrompt, MCPResource, MCPResourceTemplate, MCPResourceReadResult, MCPGetPromptResult } from '@oh-my-pi/pi-coding-agent/mcp';
import type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpTranscriptEvent } from './contracts.js';

export const OMP_IPC_VERSION = 1;
export type OmpToolDescriptor = Pick<CustomTool, 'name' | 'label' | 'description' | 'parameters' | 'strict' | 'hidden' | 'loadMode' | 'deferrable' | 'approval' | 'mcpServerName' | 'mcpToolName'>;
export type OmpSessionInput = Parameters<OmpRuntime['create']>[0] & { sessionFile?: string };
export interface OmpMcpCatalog {
  servers: string[];
  instructions: Array<[string, string]>;
  prompts: Record<string, MCPPrompt[]>;
  resources: Record<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>;
}
export interface OmpChildInit {
  agentDir: string;
  sessionRoot: string;
  skills: readonly SkillView[];
  input: OmpSessionInput;
  tools: OmpToolDescriptor[];
  mcpCatalog: OmpMcpCatalog;
  namespaces: { space?: string; mcp?: string };
}
export type SessionMethod = Exclude<keyof OmpRuntimeSession, 'id' | 'sessionFile' | 'subscribe' | 'subscribeActivity' | 'activity' | 'reloadSettings' | 'instructionsChanged'>;
export type OmpChildApi = Pick<OmpRuntimeSession, SessionMethod> & {
  health(): Promise<{ protocolVersion: number; platform: string; arch: string; bunVersion: string; pid: number }>;
  initialize(input: OmpChildInit): Promise<{ id: string; sessionFile: string; activity: SessionActivity }>;
  reloadSettings(): Promise<void>;
  reloadAuth(): Promise<void>;
  instructionsChanged(): Promise<void>;
  refreshMcp(tools: OmpToolDescriptor[], catalog: OmpMcpCatalog): Promise<void>;
  transcript(input: { sessionFile: string } | { bytes: Uint8Array }): Promise<OmpTranscriptEvent[]>;
};
export interface OmpMachineApi {
  namespace(input: { namespace: 'space' | 'mcp'; method: string; args: unknown }, signal?: AbortSignal): Promise<unknown>;
  executeTool(input: { name: string; callId: string; args: unknown }, signal?: AbortSignal): Promise<unknown>;
  mcpResources(server: string): Promise<{ resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined>;
  mcpReadResource(server: string, uri: string): Promise<MCPResourceReadResult | undefined>;
  mcpPrompt(server: string, name: string, args?: Record<string, string>): Promise<MCPGetPromptResult | undefined>;
}
export type OmpNotification =
  | { type: 'event'; event: OmpRuntimeEvent }
  | { type: 'activity'; activity: SessionActivity; errorMessage?: string }
  | { type: 'mcpNotification'; server: string; method: string; params: unknown }
  | { type: 'toolUpdate'; callId: string; update: unknown };

type FunctionShape = (...args: never[]) => unknown;
type HandlerMap<Api extends { [K in keyof Api]: FunctionShape }> = { [K in keyof Api]: (args: Parameters<Api[K]>, signal: AbortSignal) => Awaited<ReturnType<Api[K]>> | Promise<Awaited<ReturnType<Api[K]>>> };
interface RemoteError { name: string; message: string; code?: string }
type Envelope =
  | { kind: 'request'; id: number; method: string; args: unknown[] }
  | { kind: 'response'; id: number; result?: unknown; error?: RemoteError }
  | { kind: 'cancel'; id: number }
  | { kind: 'notification'; notification: OmpNotification };

/** One private Bun IPC channel; unlike stdio, agent/tool output cannot corrupt frames. */
export class OmpRpcPeer<Remote extends { [K in keyof Remote]: FunctionShape }, Local extends { [K in keyof Local]: FunctionShape }> {
  private sequence = 0;
  private closed: Error | null = null;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private readonly executing = new Map<number, AbortController>();
  constructor(
    private readonly send: (message: Envelope) => void,
    private readonly handlers: HandlerMap<Local>,
    private readonly notify: (notification: OmpNotification) => void = () => undefined,
  ) {}

  call<K extends keyof Remote & string>(method: K, args: Parameters<Remote[K]>, signal?: AbortSignal): Promise<Awaited<ReturnType<Remote[K]>>> {
    if (this.closed) return Promise.reject(this.closed);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('OMP request aborted'));
    const id = ++this.sequence;
    const { promise, resolve, reject } = Promise.withResolvers<Awaited<ReturnType<Remote[K]>>>();
    const abort = (): void => {
      this.pending.delete(id);
      try { this.send({ kind: 'cancel', id }); } catch { /* The caller is already cancelling. */ }
      reject(signal?.reason ?? new Error('OMP request aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.pending.set(id, { resolve: (value) => resolve(value as Awaited<ReturnType<Remote[K]>>), reject, cleanup: () => signal?.removeEventListener('abort', abort) });
    try { this.send({ kind: 'request', id, method, args }); }
    catch (error) {
      this.pending.delete(id);
      signal?.removeEventListener('abort', abort);
      reject(error);
    }
    return promise;
  }

  publish(notification: OmpNotification): void {
    if (!this.closed) this.send({ kind: 'notification', notification });
  }

  receive(raw: unknown): void {
    if (this.closed || !raw || typeof raw !== 'object' || !('kind' in raw)) return;
    const message = raw as Envelope;
    if (message.kind === 'notification') { this.notify(message.notification); return; }
    if (!Number.isSafeInteger(message.id)) return;
    if (message.kind === 'cancel') { this.executing.get(message.id)?.abort(); return; }
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        const error = Object.assign(new Error(message.error.message), { name: message.error.name }, message.error.code ? { code: message.error.code } : {});
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.kind !== 'request' || !Array.isArray(message.args)) return;
    const controller = new AbortController();
    this.executing.set(message.id, controller);
    void Promise.resolve().then(() => {
      if (!Object.hasOwn(this.handlers, message.method)) throw new Error(`Unknown OMP IPC operation: ${message.method}`);
      const handler = this.handlers[message.method as keyof Local];
      return handler(message.args as Parameters<Local[keyof Local]>, controller.signal);
    }).then(
      (result) => this.send({ kind: 'response', id: message.id, result }),
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.send({ kind: 'response', id: message.id, error: { name: error.name, message: error.message, ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}) } });
      },
    ).catch((error) => this.close(error instanceof Error ? error : new Error(String(error)))).finally(() => this.executing.delete(message.id));
  }

  close(error = new Error('OMP process disconnected')): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const controller of this.executing.values()) controller.abort(error);
    this.executing.clear();
  }
}
