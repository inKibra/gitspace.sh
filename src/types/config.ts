/**
 * Type definitions for GitSpace CLI configuration
 */

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
