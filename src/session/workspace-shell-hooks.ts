import type { SessionCreateHooks } from '../lib/tmux-lite/protocol.js';
import { escapeShellArg } from '../utils/shell-escape.js';

export function resolveWorkspaceSessionLauncherArgs(): string[] {
  const execPath = process.execPath;
  const scriptPath = process.argv[1];

  if (execPath.endsWith('bun') && scriptPath) {
    return [execPath, scriptPath];
  }

  if (execPath && !execPath.endsWith('/node') && !execPath.endsWith('node')) {
    return [execPath];
  }

  return ['gssh'];
}

function buildShellCommand(args: string[]): string {
  return args
    .map((arg) => (/^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : escapeShellArg(arg)))
    .join(' ');
}

export function buildWorkspaceSessionCommand(spaceArgs: string[], launcherArgs: string[] = resolveWorkspaceSessionLauncherArgs()): {
  command: string;
  args: string[];
} {
  const [command, ...args] = [...launcherArgs, 'space', ...spaceArgs];
  if (!command) {
    throw new Error('Workspace session launcher command is missing.');
  }

  return { command, args };
}

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
  workspaceId: string,
  launcherArgs: string[] = resolveWorkspaceSessionLauncherArgs()
): SessionCreateHooks {
  const escapedProject = escapeShellArg(projectName);
  const escapedWorkspace = escapeShellArg(workspaceId);
  const launcherCommand = buildShellCommand(launcherArgs);

  // Keep defaults in env so Commander leaf subcommands can still parse
  // explicit --project/--workspace flags passed by users.
  const spaceFunction = `space() { GSSH_SPACE_PROJECT=${escapedProject} GSSH_SPACE_WORKSPACE=${escapedWorkspace} ${launcherCommand} space "$@"; }`;

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
