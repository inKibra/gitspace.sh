/**
 * Shared agent runtime event types.
 *
 * These model the runtime/session events GitSpace tracks for agent sessions,
 * independent of whichever local runtime implementation produces them.
 */

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'compacting' }
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

/** A provider and whether it currently has stored credentials. */
export interface AgentAuthProvider {
  provider: string;
  hasAuth: boolean;
}

/** An event in an in-progress OAuth provider sign-in flow. */
export interface AgentOAuthEvent {
  flowId: string;
  kind: 'auth' | 'prompt' | 'done';
  /** kind=auth: the URL to open to authorize. */
  url?: string;
  instructions?: string;
  /** kind=prompt: a value to collect from the user (e.g. a device code). */
  message?: string;
  placeholder?: string;
  /** kind=done */
  ok?: boolean;
  error?: string;
}

/** A single editable agent setting for the settings panel. */
export interface AgentSettingItem {
  path: string;
  label: string;
  kind: 'boolean' | 'enum';
  value: string | boolean | null;
  options?: string[];
}

/** A schema-derived setting (full SETTINGS_SCHEMA browser, grouped by tab). */
export interface AgentSettingSchemaItem {
  path: string;
  tab: string;
  label: string;
  description?: string;
  kind: 'boolean' | 'enum' | 'number' | 'string' | 'record' | 'other';
  value: string | number | boolean | null;
  options?: string[];
}

/** A user-message checkpoint in the session tree, for conversation rewind. */
export interface AgentHistoryEntry {
  entryId: string;
  text: string;
  current: boolean;
}

/** A tool available to the agent (for per-tool approval). */
export interface AgentToolInfo {
  name: string;
  tier: string;
  /** Current per-tool approval override ("allow"|"prompt"|"deny"), or "default". */
  approval: string;
}

/** Current context-window usage for a session. */
export interface AgentContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** A model role (default/smol/slow/...) resolved to its model, for the role cycle. */
export interface AgentRoleInfo {
  role: string;
  name: string;
  model: string | null;
  current: boolean;
}

/** Control-surface snapshot for an agent session (usage + model + thinking + approval). */
export interface AgentControlInfo {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; premiumRequests: number; cost: number } | null;
  /** Current model as "provider/id", or null if unset. */
  currentModel: string | null;
  models: AgentModelOption[];
  /** Resolved model roles for the role cycle (empty when none configured). */
  roles: AgentRoleInfo[];
  /** Current thinking/reasoning level (e.g. "auto", "high"), or null if unknown. */
  thinkingLevel: string | null;
  /** Selectable thinking levels. */
  thinkingLevels: string[];
  /** Current tool-approval mode ("always-ask" | "write" | "yolo"), or null. */
  approvalMode: string | null;
  approvalModes: string[];
  /** Current service tier for the active model's family ("priority" == fast
   *  mode), or null. Read from the per-family setting `serviceTierKey`. */
  serviceTier: string | null;
  /** The per-family service-tier setting key for the current model
   *  (e.g. "tier.openai" / "tier.anthropic" / "tier.google"), or null when the
   *  model has no serving-priority control. Used to toggle fast mode. */
  serviceTierKey?: string | null;
  /** Whether the current model supports fast/priority mode at all — the toggle
   *  is only shown when true. */
  fastCapable?: boolean;
  /** Live context-window usage (only for active sessions). */
  context: AgentContextUsage | null;
}
