/**
 * Workspace context resolution for CLI commands
 *
 * Two modes of context resolution:
 *
 * 1. **Explicit mode** (workspace commands): --project is required, --workspace optional.
 *    No CWD detection, no global config fallback.
 *
 * 2. **Session mode** (space command): reads GSSH_SPACE_PROJECT / GSSH_SPACE_WORKSPACE
 *    env vars first, then falls back to detecting the current workspace from CWD.
 *
 * @module workspace-context
 */

import { join } from 'path';
import { getProjectWorkspacesDir } from '../core/config.js';
import { getWorkspaceRoot } from '../core/paths.js';
import { detectWorkspaceContextFromCwd } from '../utils/workspace-id.js';
import { SpacesError } from '../types/errors.js';

// ============================================================================
// Types
// ============================================================================

/** Resolved workspace context */
export interface WorkspaceContext {
  /** Project name (always present) */
  project: string;
  /** Workspace name (present when resolved) */
  workspace?: string;
}

// ============================================================================
// Explicit Mode (workspace commands)
// ============================================================================

/**
 * Resolve workspace context from explicit CLI flags.
 *
 * Used by all `gssh workspace ...` commands. --project is required
 * (enforced by commander requiredOption), --workspace is optional
 * depending on the subcommand.
 *
 * @param options - CLI options containing project and optional workspace
 * @returns Resolved context
 * @throws {SpacesError} If project is missing (should not happen if requiredOption is set)
 */
export function resolveExplicitContext(options: {
  project: string;
  workspace?: string;
}): WorkspaceContext {
  if (!options.project) {
    throw new SpacesError('--project is required for workspace commands', 'USER_ERROR', 1);
  }
  return {
    project: options.project,
    workspace: options.workspace,
  };
}

// ============================================================================
// Session Mode (space command)
// ============================================================================

/**
 * Resolve workspace context from session environment variables or the current cwd.
 *
 * Used by the hidden `space` command inside workspace-aware shells and Pi sessions.
 * Env vars win; when absent we infer the workspace from the current directory.
 *
 * @returns Resolved context, or null if no workspace context can be determined
 */
export function resolveSessionContext(): WorkspaceContext | null {
  const project = process.env.GSSH_SPACE_PROJECT;
  const workspace = process.env.GSSH_SPACE_WORKSPACE;

  if (project) {
    return {
      project,
      workspace: workspace || undefined,
    };
  }

  const detected = detectWorkspaceContextFromCwd(process.cwd(), getWorkspaceRoot());
  if (!detected) {
    return null;
  }

  return {
    project: detected.projectName,
    workspace: detected.workspaceName,
  };
}

/**
 * Resolve explicit context from flags.
 *
 * @param options - CLI options containing project and optional workspace
 * @returns Resolved context
 */
export function useExplicitContext(options: {
  project: string;
  workspace?: string;
}): WorkspaceContext {
  return resolveExplicitContext(options);
}

/**
 * Resolve session/workspace context for `space` commands.
 *
 * @returns Resolved context, or null if no workspace context is available
 */
export function useSessionContext(): WorkspaceContext | null {
  return resolveSessionContext();
}

/**
 * Get the filesystem path for a workspace.
 *
 * @param project - Project name
 * @param workspace - Workspace name
 * @returns Absolute path to the workspace directory
 */
export function getWorkspacePath(project: string, workspace: string): string {
  return join(getProjectWorkspacesDir(project), workspace);
}
