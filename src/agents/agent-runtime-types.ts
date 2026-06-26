/**
 * Shared agent runtime event types.
 *
 * These model the runtime/session events GitSpace tracks for agent sessions,
 * independent of whichever local runtime implementation produces them.
 */

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number };

export interface Permission {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface PendingQuestion {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
}

// -- SDK-derived structured state (available when session runs in-process) --

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  details?: string;
  notes?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface AgentModelInfo {
  /** Display name of the current model (e.g., "Claude 4 Sonnet") */
  name: string;
  /** Provider identifier (e.g., "anthropic") */
  provider: string;
  /** Current role identifier (e.g., "default", "code", "plan") */
  role?: string;
}

/** A selectable model for the chrome model switcher. */
export interface AgentModelOption {
  provider: string;
  id: string;
  contextWindow: number | null;
}

/** Current context-window usage for a session. */
export interface AgentContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Control-surface snapshot for an agent session (usage + model + thinking + approval). */
export interface AgentControlInfo {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; premiumRequests: number; cost: number } | null;
  /** Current model as "provider/id", or null if unset. */
  currentModel: string | null;
  models: AgentModelOption[];
  /** Current thinking/reasoning level (e.g. "auto", "high"), or null if unknown. */
  thinkingLevel: string | null;
  /** Selectable thinking levels. */
  thinkingLevels: string[];
  /** Current tool-approval mode ("always-ask" | "write" | "yolo"), or null. */
  approvalMode: string | null;
  approvalModes: string[];
  /** Live context-window usage (only for active sessions). */
  context: AgentContextUsage | null;
}
