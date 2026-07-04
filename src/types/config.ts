/**
 * Type definitions for GitSpace CLI configuration
 */

/**
 * Notification type toggles
 */
export interface NotificationTypeConfig {
  /** Notify on process exit (default: true) */
  exit: boolean;
  /** Notify when terminal goes idle after activity (default: true) */
  idle: boolean;
  /** Notify on terminal bell (default: true) */
  bell: boolean;
  /** Notify on terminal title change (default: true) */
  title: boolean;
  /** Notify on OSC sequences (9, 99, 777) (default: true) */
  osc: boolean;
}

/**
 * Toast notification settings
 */
export interface NotificationToastConfig {
  /** Whether toast notifications are enabled (default: true) */
  enabled: boolean;
  /** Hold toasts when user is idle for this duration (ms). 0 = disabled. (default: 15000) */
  holdWhenIdleMs: number;
}

/**
 * Notification configuration
 */
export interface NotificationConfig {
  /** Whether notifications are enabled globally (default: true) */
  enabled: boolean;
  /** Minimum command duration (ms) before notifying on completion (default: 10000) */
  minCommandDurationMs: number;
  /** Which notification types are enabled */
  types: NotificationTypeConfig;
  /** Toast notification settings */
  toast: NotificationToastConfig;
}

/**
 * Default notification type config
 */
export const DEFAULT_NOTIFICATION_TYPES: NotificationTypeConfig = {
  exit: true,
  idle: false,
  bell: true,
  title: false,
  osc: true,
};

/**
 * Default notification config
 */
export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  minCommandDurationMs: 10000,
  types: { ...DEFAULT_NOTIFICATION_TYPES },
  toast: { enabled: true, holdWhenIdleMs: 15000 },
};

/**
 * Wide event ingestion mode
 */
/**
 * Wide event ingestion mode — the capture gate (which lines become events):
 * - `prefix`: only lines starting with the marker (`@event`)
 * - `json`: only lines that are JSON objects
 * - `all`: every non-empty line (JSON parsed structurally, others as string logs)
 * Each captured line is parsed with graceful fidelity (string / json /
 * json+correlation) — missing fields are defaulted, never dropped.
 */
export type EventsIngestionMode = 'prefix' | 'json' | 'all';

/**
 * Field mapping for wide events
 */
export interface EventsFieldConfig {
  /** Field name for the event name */
  name: string;
  /** Field name for the event ID */
  id: string;
  /** Field name for the event level */
  level: string;
  /** Field name for the timestamp */
  timestamp: string;
  /** Field name for the message */
  message: string;
}

/**
 * Rotation settings for wide event logs
 */
export interface EventsRotationConfig {
  /** Max file size in bytes before rotation */
  maxBytes: number;
  /** Max file age in minutes before rotation */
  maxMinutes: number;
  /** Number of files to retain */
  keepFiles: number;
}

/**
 * Wide event configuration
 */
export interface EventsConfig {
  /** Enable wide event collection */
  enabled: boolean;
  /** Ingestion mode (prefix required or json matching) */
  mode: EventsIngestionMode;
  /** Prefix for event lines when mode is prefix */
  prefix: string;
  /** Field mapping */
  fields: EventsFieldConfig;
  /** Rotation settings */
  rotation: EventsRotationConfig;
  /** Correlation field for aggregating wide events */
  correlationField?: string;
  /** Aggregate wide events as source events stream in */
  aggregateMode?: 'stream';
  /** Max timeline entries per wide event */
  maxTimeline?: number;
  /** Minimum interval between wide event updates (ms) */
  updateIntervalMs?: number;
  /** Snapshot cache size per workspace (bytes) */
  snapshotCacheMaxBytes?: number;
}

/**
 * Default wide event configuration
 */
export const DEFAULT_EVENTS_CONFIG: EventsConfig = {
  enabled: true,
  // Capture everything by default and extract structure per line (string / json
  // / json+correlation). The `@event` prefix is still honored (a marked line
  // with a JSON payload parses structurally), but is no longer required.
  mode: 'all',
  prefix: '@event',
  fields: {
    name: 'event',
    id: 'eventId',
    level: 'level',
    timestamp: 'timestamp',
    message: 'message',
  },
  rotation: {
    maxBytes: 25_000_000,
    maxMinutes: 60,
    keepFiles: 20,
  },
  correlationField: 'requestId',
  aggregateMode: 'stream',
  maxTimeline: 200,
  updateIntervalMs: 250,
  snapshotCacheMaxBytes: 64 * 1024 * 1024,
};

/**
 * Linear team info stored in config
 */
export interface LinearTeamInfo {
  /** Team ID from Linear */
  id: string;
  /** Team key (e.g., "ENG") */
  key: string;
  /** Team name (e.g., "Engineering") */
  name: string;
}

/**
 * Global configuration stored in the configured config root as `.config.json`.
 */
export interface GlobalConfig {
  /** Name of the currently active project */
  currentProject: string | null;
  /** Path to the projects/workspace root (default: ~/gitspace) */
  projectsDir: string;
  /** Default base branch for new projects (default: "main") */
  defaultBaseBranch: string;
  /** Number of days before a workspace is considered stale (default: 30) */
  staleDays: number;
  /** Linear teams the user has access to (user-level config) */
  linearTeams?: LinearTeamInfo[];
  /** Default Linear team key for new projects */
  linearDefaultTeam?: string;
  /** Notification settings */
  notifications?: NotificationConfig;
}

/**
 * Persisted per-workspace bundle metadata.
 */
export interface WorkspaceBundleState {
  /** Key used for this scope (workspace name or "__base__") */
  scope: string;
  /** Hash of the bundle that was last processed for this scope */
  bundleHash: string;
  /** Input config keys required by this workspace bundle */
  requiredInputKeys: string[];
  /** Secret config keys required by this workspace bundle */
  requiredSecretKeys: string[];
  /** Confirm-step fingerprints currently referenced by this workspace bundle */
  confirmFingerprints: string[];
  /** ISO timestamp when this state was last updated */
  updatedAt: string;
}

/**
 * Persisted history for a confirm/check step.
 */
export interface BundleConfirmHistoryEntry {
  /** Fingerprint hash of the confirm step definition */
  fingerprint: string;
  /** Step id from bundle.json */
  stepId: string;
  /** checkCommand value, if present */
  checkCommand?: string;
  /** Last known status */
  status: 'passed' | 'skipped';
  /** Scope that last evaluated this step */
  scope: string;
  /** Bundle hash that produced this history entry */
  bundleHash: string;
  /** ISO timestamp when this was checked */
  checkedAt: string;
}

/**
 * GitSpace-internal kanban phase for a workspace.
 * Stored per workspace in workspace-local metadata and synced via owner-sync.
 */
export type WorkspacePhase = 'plan' | 'code' | 'review' | 'ship';

/**
 * Project-specific configuration stored at <workspace-root>/{PROJECT_NAME}/.config.json
 */
export interface ProjectConfig {
  /** Project name */
  name: string;
  /** GitHub repository in owner/repo format */
  repository: string;
  /** Base branch for creating worktrees */
  baseBranch: string;
  /** Wide events configuration */
  events?: EventsConfig;
  /** Linear teams this project uses (subset of user's teams) */
  linearTeams?: string[];
  /** ISO timestamp when project was created */
  createdAt: string;
  /** ISO timestamp when project was last accessed */
  lastAccessed: string;
  /** Custom values collected during bundle onboarding (from input steps) */
  bundleValues?: Record<string, string>;
  /** Keys of secrets stored in OS keychain via Bun.secrets (from secret steps) */
  bundleSecretKeys?: string[];
  /** Per-workspace bundle metadata keyed by workspace scope */
  bundleWorkspaceState?: Record<string, WorkspaceBundleState>;
  /** History of confirm/check steps keyed by step fingerprint */
  bundleConfirmHistory?: Record<string, BundleConfirmHistoryEntry>;
}

/**
 * Default global configuration values
 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  currentProject: null,
  projectsDir: '', // Set to the resolved workspace root at runtime
  defaultBaseBranch: 'main',
  staleDays: 30,
  notifications: { ...DEFAULT_NOTIFICATION_CONFIG },
};

/**
 * Create default project configuration
 */
export function createDefaultProjectConfig(
  name: string,
  repository: string,
  baseBranch: string
): ProjectConfig {
  const now = new Date().toISOString();
  return {
    name,
    repository,
    baseBranch,
    createdAt: now,
    lastAccessed: now,
    events: { ...DEFAULT_EVENTS_CONFIG },
  };
}
