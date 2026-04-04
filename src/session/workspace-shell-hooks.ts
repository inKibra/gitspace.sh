import type { SessionCreateHooks } from '../lib/tmux-lite/protocol.js';
import { escapeShellArg } from '../utils/shell-escape.js';

export function resolveWorkspaceSessionLauncherArgs(): string[] {
  const execPath = process.execPath;

  if (execPath.endsWith('bun')) {
    const indexPath = new URL('../index.ts', import.meta.url).pathname;
    return [execPath, indexPath];
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

export function buildWorkspaceSessionEnv(projectName: string, workspaceId: string): Record<string, string> {
  return {
    GSSH_SESSION_MODE: 'workspace',
    GSSH_SPACE_PROJECT: projectName,
    GSSH_SPACE_WORKSPACE: workspaceId,
  };
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

export function buildWorkspaceScopedExecCommand(
  projectName: string,
  workspaceId: string,
  spaceArgs: string[],
  launcherArgs: string[] = resolveWorkspaceSessionLauncherArgs()
): {
  command: string;
  args: string[];
} {
  const workspaceCommand = buildWorkspaceSessionCommand(spaceArgs, launcherArgs);
  const envAssignments = Object.entries(buildWorkspaceSessionEnv(projectName, workspaceId))
    .map(([key, value]) => `${key}=${value}`);

  return {
    command: 'env',
    args: [...envAssignments, workspaceCommand.command, ...workspaceCommand.args],
  };
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
  const workspaceEnv = buildWorkspaceSessionEnv(projectName, workspaceId);
  const escapedProject = escapeShellArg(projectName);
  const escapedWorkspace = escapeShellArg(workspaceId);
  const launcherCommand = buildShellCommand(launcherArgs);

  // Keep defaults in env so Commander leaf subcommands can still parse
  // explicit --project/--workspace flags passed by users.
  const spaceFunction = `space() { GSSH_SPACE_PROJECT=${escapedProject} GSSH_SPACE_WORKSPACE=${escapedWorkspace} ${launcherCommand} space "$@"; }`;

  return {
    env: workspaceEnv,
    shellInit: {
      bash: spaceFunction,
      zsh: spaceFunction,
    },
  };
}
