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
  idle: true,
  bell: true,
  title: true,
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
 * Global configuration stored in ~/gitspace/.config.json
 */
export interface GlobalConfig {
  /** Name of the currently active project */
  currentProject: string | null;
  /** Path to the projects directory (default: ~/gitspace) */
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
 * Information about an applied bundle
 */
export interface AppliedBundle {
  /** Bundle name */
  name: string;
  /** Bundle version */
  version: string;
  /** Source of the bundle (path or URL) */
  source: string;
  /** ISO timestamp when bundle was applied */
  appliedAt: string;
}

/**
 * Project-specific configuration stored in ~/gitspace/{PROJECT_NAME}/.config.json
 */
export interface ProjectConfig {
  /** Project name */
  name: string;
  /** GitHub repository in owner/repo format */
  repository: string;
  /** Base branch for creating worktrees */
  baseBranch: string;
  /**
   * @deprecated Use user-level Linear config instead.
   * Kept for backwards compatibility - will be migrated on first access.
   */
  linearApiKey?: string;
  /**
   * @deprecated Use linearTeams instead.
   * Kept for backwards compatibility - will be migrated on first access.
   */
  linearTeamKey?: string;
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
  /** Information about the bundle that was applied */
  appliedBundle?: AppliedBundle;
}

/**
 * Default global configuration values
 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  currentProject: null,
  projectsDir: '', // Will be set to ~/gitspace at runtime
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
  };
}
