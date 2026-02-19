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

  const spaceFunction = `space() { gssh space --project ${escapedProject} --workspace ${escapedWorkspace} "$@"; }`;

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
