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
