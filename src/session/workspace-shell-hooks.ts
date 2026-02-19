import type { SessionCreateHooks } from '../lib/tmux-lite/protocol.js';
import { escapeShellArg } from '../utils/shell-escape.js';

/**
 * Build generic tmux-lite session hooks for workspace-scoped shells.
 *
 * This keeps tmux-lite gssh-agnostic while allowing gssh to inject
 * workspace context and convenience commands.
 *
 * Note: GSSH_SPACE_WORKSPACE stores the workspace ID (directory/worktree id),
 * not a display label.
 */
export function buildWorkspaceSessionHooks(
  projectName: string,
  workspaceId: string
): SessionCreateHooks {
  const escapedProject = escapeShellArg(projectName);
  const escapedWorkspace = escapeShellArg(workspaceId);

  // Keep defaults in env so Commander leaf subcommands can still parse
  // explicit --project/--workspace flags passed by users.
  const spaceFunction = `space() { GSSH_SPACE_PROJECT=${escapedProject} GSSH_SPACE_WORKSPACE=${escapedWorkspace} gssh space "$@"; }`;

  return {
    env: {
      GSSH_SESSION_MODE: 'workspace',
      GSSH_SPACE_PROJECT: projectName,
      GSSH_SPACE_WORKSPACE: workspaceId,
    },
    shellInit: {
      bash: spaceFunction,
      zsh: spaceFunction,
    },
  };
}
