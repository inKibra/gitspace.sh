import type { SessionCreateHooks } from '../lib/tmux-lite/protocol.js';
import { escapeShellArg } from '../utils/shell-escape.js';

/**
 * Build generic tmux-lite session hooks for workspace-scoped shells.
 *
 * This keeps tmux-lite gssh-agnostic while allowing gssh to inject
 * workspace context and convenience commands.
 */
export function buildWorkspaceSessionHooks(
  projectName: string,
  workspaceName: string
): SessionCreateHooks {
  const escapedProject = escapeShellArg(projectName);
  const escapedWorkspace = escapeShellArg(workspaceName);

  // Keep defaults in env so Commander leaf subcommands can still parse
  // explicit --project/--workspace flags passed by users.
  const spaceFunction = `space() { GSSH_SPACE_PROJECT=${escapedProject} GSSH_SPACE_WORKSPACE=${escapedWorkspace} gssh space "$@"; }`;

  return {
    env: {
      GSSH_SESSION_MODE: 'workspace',
      GSSH_SPACE_PROJECT: projectName,
      GSSH_SPACE_WORKSPACE: workspaceName,
    },
    shellInit: {
      bash: spaceFunction,
      zsh: spaceFunction,
    },
  };
}
