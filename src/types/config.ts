/**
 * Type definitions for GitSpace CLI configuration
 */

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
  /** Optional Linear API key for issue integration */
  linearApiKey?: string;
  /** Optional Linear team key for filtering issues (e.g., "ENG") */
  linearTeamKey?: string;
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
  baseBranch: string,
  linearApiKey?: string,
  linearTeamKey?: string
): ProjectConfig {
  const now = new Date().toISOString();
  return {
    name,
    repository,
    baseBranch,
    linearApiKey,
    linearTeamKey,
    createdAt: now,
    lastAccessed: now,
  };
}
