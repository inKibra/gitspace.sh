/**
 * AgentSessionHost — the per-session seam between the daemon's PiCoordinator
 * (a router) and the code that actually owns a live OMP AgentSession.
 *
 * Two implementations:
 *   - LocalSessionHost: owns the SDK session in the current process. Used
 *     directly by the daemon (in-process mode) AND inside the per-session
 *     worker child process (worker mode) — same logic, different process.
 *   - WorkerSessionHost: a proxy that spawns `agent-worker.ts` as a child
 *     process (Bun.spawn + ipc) and forwards every call as an RPC. The child
 *     runs a LocalSessionHost and streams callbacks back over IPC.
 *
 * Why a child process per session (not worker threads, not in-process):
 *   - The SDK's AsyncJobManager is a module-graph singleton gated by
 *     `!parentTaskPrefix && !AsyncJobManager.instance()` — only the FIRST
 *     top-level session in a process gets background bash/task jobs.
 *   - pi-utils/dirs.ts mutates process.chdir and process.env
 *     (PI_CODING_AGENT_DIR, profile) — process-global, so worker threads
 *     cannot isolate sessions in different workspaces.
 *   - Crash containment: a session that segfaults or process.exit()s must not
 *     take down the daemon (today we shim process.exit around dispose).
 *
 * Every method's args and results are JSON-serializable — they already cross
 * the daemon→client frame boundary today, so the IPC boundary adds no new
 * serialization constraints.
 */

import type { AgentEvent } from '../../../agents/backend.js';
import type {
  AgentControlInfo,
  AgentHistoryEntry,
  AgentToolInfo,
  AgentTreeNode,
} from '../../../agents/agent-runtime-types.js';
import type { TranscriptPage } from '../../../blocks/agent/transcript-source.js';
import type { AgentPromptImage } from '../protocol.js';
import type { HostUIDialogRequest, HostUIDialogResponse, HostUIEvent } from './host-ui-bridge.js';

/** Workspace identity a host is bound to (serializable subset of PiWorkspaceTarget). */
export interface SessionHostTarget {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  projectName: string;
}

/** How to obtain the session: create a fresh one or reopen a session file. */
export type SessionHostBoot =
  | { mode: 'create'; title?: string }
  | { mode: 'open'; sessionFilePath: string; title?: string };

/**
 * Callbacks the host fires as the session runs. All payloads are
 * JSON-serializable so they can cross the worker IPC boundary unchanged.
 */
export interface SessionHostSinks {
  /** Session lifecycle/transcript/status events (same union clients receive). */
  onEvent(event: AgentEvent): void;
  /** Extension dialog request (host-UI bridge) — needs a resolveDialog() reply. */
  onDialogRequest(request: HostUIDialogRequest): void;
  /** Fire-and-forget host-UI event (status/notify/widget/editor-text/title). */
  onUiEvent(event: HostUIEvent): void;
  /** Rendered terminal bytes from the session's interactive mode. */
  onTerminalOutput(data: string): void;
}

/** Commands contributed by the live session (skills, extensions, custom). */
export interface SessionCommandInfo {
  name: string;
  description: string;
  kind: 'file' | 'custom' | 'extension';
}

export interface AgentSessionHost {
  readonly sessionId: string;

  // --- lifecycle ---------------------------------------------------------
  /** Tear down interactive mode, unsubscribe, dispose the SDK session. */
  dispose(): Promise<void>;

  // --- conversation ------------------------------------------------------
  /**
   * Send a user turn. Resolves on ACCEPTANCE (the prompt was dispatched);
   * completion/errors surface through onEvent like every other turn.
   */
  prompt(text: string, images?: AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  /** Interrupt the current turn (SDK abort). Session stays alive. */
  interrupt(): Promise<boolean>;
  /** Start compaction. Resolves on acceptance; completion flows via events. */
  compact(instructions?: string): Promise<boolean>;
  removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<string | null>;

  // --- control surface ----------------------------------------------------
  setModel(provider: string, modelId: string): Promise<boolean>;
  /** Full control snapshot (usage, models, roles, thinking, context, tier). */
  getControlInfo(): Promise<AgentControlInfo>;
  cycleRole(direction: 'forward' | 'backward'): Promise<boolean>;
  applyRole(role: string): Promise<boolean>;
  setThinkingLevel(level: string): Promise<boolean>;
  setApprovalMode(mode: string): Promise<boolean>;
  getTools(): Promise<AgentToolInfo[]>;
  getHistory(): Promise<AgentHistoryEntry[]>;
  navigateHistory(entryId: string, mode: 'redo' | 'jump'): Promise<{ ok: boolean; editorText?: string }>;
  getSessionTree(): Promise<AgentTreeNode[]>;
  readTranscriptRange(opts: { before?: string; limit: number }): Promise<TranscriptPage>;
  /** Session-contributed slash commands (skills + extension + custom). */
  listSessionCommands(reservedNames: string[]): Promise<SessionCommandInfo[]>;

  // --- host-UI bridge -----------------------------------------------------
  /** Install the host-UI bridge context so extension dialogs route to
   *  onDialogRequest (instead of the Pi TUI fallback). Idempotent. */
  enableUI(): void;
  readonly uiEnabled: boolean;
  /** Resolve a pending extension dialog with the client's response. */
  resolveDialog(response: HostUIDialogResponse): Promise<boolean>;
  /** Mirror of composer text so extensions' getEditorText() stays accurate. */
  setEditorTextFromClient(text: string): void;
  /** Display title used in message-event payloads. */
  setTitle(title: string | undefined): void;

  // --- interactive terminal ------------------------------------------------
  /** Boot pi-tui InteractiveMode rendering to onTerminalOutput. */
  startTerminal(cols: number, rows: number): Promise<void>;
  stopTerminal(): Promise<void>;
  injectTerminalInput(data: string): void;
  resizeTerminal(cols: number, rows: number): void;
}
