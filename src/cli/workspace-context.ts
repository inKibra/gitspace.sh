/**
 * Workspace context resolution for CLI commands
 *
 * Two modes of context resolution:
 *
 * 1. **Explicit mode** (workspace commands): --project is required, --workspace optional.
 *    No CWD detection, no global config fallback.
 *
 * 2. **Session mode** (space command): reads GSSH_SPACE_PROJECT / GSSH_SPACE_WORKSPACE
 *    env vars set by tmux-lite when spawning workspace sessions.
 *
 * @module workspace-context
 */

import { join } from 'path';
import { getProjectWorkspacesDir } from '../core/config.js';

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
 * @throws {Error} If project is missing (should not happen if requiredOption is set)
 */
export function resolveExplicitContext(options: {
  project: string;
  workspace?: string;
}): WorkspaceContext {
  if (!options.project) {
    throw new Error('--project is required for workspace commands');
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
 * Resolve workspace context from session environment variables.
 *
 * Used by the hidden `space` command inside tmux-lite workspace sessions.
 * Reads GSSH_SPACE_PROJECT and GSSH_SPACE_WORKSPACE env vars.
 *
 * @returns Resolved context, or null if not in a workspace session
 */
export function resolveSessionContext(): WorkspaceContext | null {
  const project = process.env.GSSH_SPACE_PROJECT;
  const workspace = process.env.GSSH_SPACE_WORKSPACE;

  if (!project) {
    return null;
  }

  return {
    project,
    workspace: workspace || undefined,
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
 * Resolve session context from env vars.
 *
 * @returns Resolved context, or null if not in a workspace session
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
