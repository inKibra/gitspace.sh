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

/**
 * Why a session is not idle. "Idle" is only safe to claim when NOTHING is owed:
 * a session with no turn in flight may still be waiting on a human, holding an
 * unconsumed queued message, or supervising subagents that are still working.
 * `SessionStatus` alone cannot express any of those — it only describes the
 * current LLM turn — which is why several call sites independently concluded
 * "not busy" meant "idle" and disagreed with each other.
 */
export type ActivityReason =
  | { kind: 'turn' }
  | { kind: 'compacting' }
  | { kind: 'retry'; attempt: number; next: number }
  | { kind: 'human'; questions: number; permissions: number }
  | { kind: 'queued'; steering: number; followUp: number }
  | { kind: 'subagents'; count: number };

/**
 * Canonical activity for one agent session.
 *
 * Produced in EXACTLY ONE place (`AgentEventManager.getSessionActivity`) and
 * carried on the machine snapshot so no consumer re-derives it. `active: false`
 * with an empty reason list is the only state where a session owes nothing.
 */
export type SessionActivity = {
  active: boolean;
  reasons: ActivityReason[];
};

/**
 * Project activity back onto a `SessionStatus`.
 *
 * Several call sites need a status-shaped value but only have a snapshot record.
 * They used to invert the `state` label by hand, which lost information twice
 * over: 'running' collapsed `compacting` into `busy`, and 'permission-needed'
 * became `idle` — so a session blocked on a human read as idle. Deriving from
 * activity keeps both distinctions. Returns undefined when activity is absent
 * (a peer predating this field) so callers can fall back.
 */
export function sessionStatusFromActivity(
  activity: SessionActivity | undefined,
  errorMessage?: string,
): SessionStatus | undefined {
  if (!activity) return undefined;
  if (activity.reasons.some((reason) => reason.kind === 'turn')) return { type: 'busy' };
  if (activity.reasons.some((reason) => reason.kind === 'compacting')) return { type: 'compacting' };
  const retry = activity.reasons.find((reason) => reason.kind === 'retry');
  if (retry?.kind === 'retry') {
    return { type: 'retry', attempt: retry.attempt, message: errorMessage ?? 'retrying', next: retry.next };
  }
  return { type: 'idle' };
}

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
  /** The provider's account pool (multiple sibling credentials; the SDK
   *  auto-rotates across them on rate-limit/401). Absent on legacy responses. */
  accounts?: Array<{ id: number; type: string; label: string; disabled: boolean }>;
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

/** A message node in the conversation tree (flat list; `parentId` links to the
 *  nearest user/assistant message ancestor — tool results and other entry types
 *  are skipped). Powers the branch-explorer tree view. */
export interface AgentTreeNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'other';
  /** Short preview of the message text (empty for tool-only turns). */
  preview: string;
  /** Number of tool calls in the turn (labels text-less assistant turns). */
  tools?: number;
  /** Real creation order of the entry in the session (file order). */
  seq?: number;
  /** This node is the current leaf (where the conversation sits now). */
  current: boolean;
  /** This node is on the current branch (leaf → root path). */
  onPath: boolean;
}

/** Result of a rewind/jump. `editorText` is the message text to drop back into
 *  the composer (re-do), present only for a user-message rewind. */
export interface AgentNavigateResult {
  ok: boolean;
  editorText?: string;
}

/** How a navigation targets a node: `redo` rewinds to the message's parent and
 *  returns its text (edit + re-send); `jump` makes the node itself the leaf
 *  (return to a fork, non-destructive). */
export type AgentNavigateMode = 'redo' | 'jump';

/** A discovered subagent definition (task-tool agent) for the workspace. */
export interface AgentDefinitionInfo {
  name: string;
  /** First line of the frontmatter description. */
  description: string;
  /** Where the definition came from. */
  source: 'bundled' | 'user' | 'project';
  /** Definition file path (null for embedded bundled agents). */
  filePath: string | null;
  /** Raw `model:` frontmatter (comma-joined pattern list), or null when unset. */
  model: string | null;
  /** Per-agent override from task.agentModelOverrides, or null. */
  overrideModel: string | null;
  /** Model pattern(s) the agent will actually use (override > frontmatter >
   *  session default), with pi/<role> aliases expanded against settings. */
  resolvedModel: string | null;
}

/** A tool available to the agent (for per-tool approval). */
export interface AgentToolInfo {
  name: string;
  tier: string;
  /** Current per-tool approval override ("allow"|"prompt"|"deny"), or "default". */
  approval: string;
}

/** Session-local OMP Goal Mode status. It is intentionally never persisted. */
export type AgentGoalModeInfo =
  | {
    enabled: true;
    /** `enabled` implies the live OMP runtime supports Goal Mode. */
    available: true;
    /** Present only when an operation completed with a recoverable warning. */
    message?: string;
  }
  | {
    enabled: false;
    /** The live runtime can enable Goal Mode when true. */
    available: boolean;
    /** Explicit reason when unavailable or when the last transition was incomplete. */
    message?: string;
  };

/** The two deliberate OMP context-reduction operations. */
export type AgentShakeMode = 'elide' | 'images';

/** Exact outcome of a session-local OMP Shake operation. */
export interface AgentShakeResult {
  mode: AgentShakeMode;
  /** Whole tool-call results removed from the active context. */
  toolResultsDropped: number;
  /** Large fenced/XML regions removed from the active context. */
  blocksDropped: number;
  /** Image blocks removed by `images`; not reported by `elide`. */
  imagesDropped?: number;
  /** Estimated context tokens reclaimed; `images` deliberately reports zero. */
  tokensFreed: number;
  /** Recoverable original-output artifact for `elide`, when OMP persisted one. */
  artifactId?: string;
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

/** A role in the full catalog (for configuration): its assigned model, if any. */
export interface AgentRoleCatalogItem {
  role: string;
  name: string;
  description?: string;
  /** The explicitly-assigned model selector ("provider/id"), or null when unset
   *  (the role falls back to the default role). */
  model: string | null;
}

/**
 * Per-session usage ATTRIBUTION (core/session-usage-report.ts), computed from
 * the session transcript. Complements `AgentControlInfo.usage`, which is a
 * single flat total: this says which providers/models/roles/subagent paths the
 * spend actually went to. Type-only import — erased at compile time, so the
 * core module's `fs` never reaches the web bundle.
 */
export interface AgentSessionUsageReport {
  /** This session alone. */
  totals: import('../core/session-usage-report.js').UsageTotals;
  /** This session + every subagent transcript beneath it. */
  totalsDeep: import('../core/session-usage-report.js').UsageTotals;
  byProviderModel: import('../core/session-usage-report.js').ProviderModelRow[];
  byRole: import('../core/session-usage-report.js').RoleRow[];
  /** Fast (priority) vs standard spend — empty when the session never set a tier. */
  byServiceTier: import('../core/session-usage-report.js').ServiceTierRow[];
  /** Chronological (role, model) eras — dates the spend so lifetime rollups
   *  that mix eras can be read correctly. */
  segments: import('../core/session-usage-report.js').UsageSegment[];
  /** agent × selection × model, with spawn counts — "what burned the budget". */
  paths: import('../core/session-usage-report.js').PathRollupRow[];
  /** How many subagent transcripts were folded into totalsDeep. */
  childSessions: number;
  warnings: string[];
}

/** Control-surface snapshot for an agent session (usage + model + thinking + approval). */
export interface AgentControlInfo {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; premiumRequests: number; cost: number } | null;
  /** Current model as "provider/id", or null if unset. */
  currentModel: string | null;
  models: AgentModelOption[];
  /** Resolved model roles for the role cycle (empty when none configured). */
  roles: AgentRoleInfo[];
  /** Full role catalog (all roles + their assignment) for the config UI. */
  roleCatalog?: AgentRoleCatalogItem[];
  /** The quick-cycle membership + order (the `cycleOrder` setting). Roles in
   *  this list are visited by the role cycle; the settings UI toggles
   *  membership by rewriting it. Absent when settings are unavailable. */
  cycleOrder?: string[];
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
