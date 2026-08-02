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
  AgentGoalModeInfo,
  AgentHistoryEntry,
  AgentShakeMode,
  AgentShakeResult,
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
 * An agent-originated problem report, captured when the agent invokes the
 * OMP SDK's `report_tool_issue` tool. Routed into GitSpace's report-a-problem
 * pipeline (docs/REPORT-A-PROBLEM.md) with origin 'agent'. JSON-serializable
 * so it crosses the worker IPC boundary unchanged.
 */
export interface AgentReportPayload {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  projectName: string;
  sessionTitle?: string;
  /** The agent's active model (provider/id) at report time, if known. */
  model?: string;
  /** The tool the agent is reporting about (the SDK tool's `tool` param). */
  tool: string;
  /** The agent's description of the unexpected behavior. */
  report: string;
}

/**
 * Pure extraction of a `report_tool_issue` invocation from an SDK session
 * event (`tool_execution_end` / `tool_result`). Returns null for any other
 * tool or an empty report. Exported for protocol-level unit tests.
 */
export function extractAgentReportInput(
  piEvent: Record<string, unknown>,
): { toolCallId: string; tool: string; report: string } | null {
  const toolName = piEvent.toolName ?? piEvent.tool_name;
  if (toolName !== 'report_tool_issue') return null;
  const input = piEvent.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const report = typeof record.report === 'string' ? record.report.trim() : '';
  if (!report) return null;
  return {
    toolCallId: String(piEvent.toolCallId ?? piEvent.tool_call_id ?? ''),
    tool: typeof record.tool === 'string' && record.tool.length > 0 ? record.tool : 'unknown',
    report,
  };
}

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
  /** The agent invoked the SDK's report tool — route into the report pipeline. */
  onAgentReport(payload: AgentReportPayload): void;
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
  /** Synchronous best-effort teardown for daemon shutdown paths that cannot
   *  await (signal handlers). Worker mode: SIGTERM the child (its SDK
   *  postmortem handlers run cleanup + exit). */
  kill(): void;

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
  /** Write a single setting on the session's OWN Settings singleton (worker
   *  processes each have one). Global persistence happens daemon-side; this
   *  keeps the live session's in-memory view in sync. */
  setSetting(path: string, value: string | number | boolean | string[]): Promise<boolean>;
  getTools(): Promise<AgentToolInfo[]>;
  getHistory(): Promise<AgentHistoryEntry[]>;
  navigateHistory(entryId: string, mode: 'redo' | 'jump'): Promise<{ ok: boolean; editorText?: string }>;
  getSessionTree(): Promise<AgentTreeNode[]>;
  readTranscriptRange(opts: { before?: string; limit: number }): Promise<TranscriptPage>;
  /** Session-contributed slash commands (skills + extension + custom). */
  listSessionCommands(reservedNames: string[]): Promise<SessionCommandInfo[]>;
  /** Read the session-local Goal Mode state. Fresh/reopened sessions are off. */
  getGoalMode(): Promise<AgentGoalModeInfo>;
  /** Toggle session-local Goal Mode using an already-resolved workspace objective. */
  setGoalMode(input: { enabled: boolean; objective?: string }): Promise<AgentGoalModeInfo>;
  /** Destructively reduce active context without disturbing a live turn. */
  shake(mode: AgentShakeMode): Promise<AgentShakeResult>;

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
}
