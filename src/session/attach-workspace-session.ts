import type { Session as TmuxSession } from '../lib/tmux-lite/protocol.js';
import { buildSessionName } from './session-name.js';
import { buildWorkspaceSessionHooks } from './workspace-shell-hooks.js';
import { SpacesError } from '../types/errors.js';
import { matchesWorkspaceId } from '../utils/workspace-id.js';

type ScriptPhase = 'pre' | 'setup' | 'select';

interface WorkspaceRecord {
  id: string;
  path: string;
  projectName: string;
}

interface ExistingSessionRecord {
  name: string;
}

interface ScriptResultSuccess {
  success: true;
}

interface ScriptResultFailure {
  success: false;
  phase: ScriptPhase;
  error: string;
  bundleNeedsRefresh?: boolean;
  cancelled?: boolean;
}

type ScriptResult = ScriptResultSuccess | ScriptResultFailure;

interface AttachWorkspaceSessionDeps {
  scanWorkspaces: () => Promise<WorkspaceRecord[]>;
  listSessions: () => Promise<ExistingSessionRecord[]>;
  createSession: (
    name: string,
    cwd: string,
    options?: {
      hooks?: { env?: Record<string, string>; shellInit?: { all?: string; bash?: string; zsh?: string; sh?: string } };
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    },
  ) => Promise<TmuxSession>;
  prepareWorkspaceForSession: (args: {
    projectName: string;
    workspacePath: string;
    workspaceName: string;
    interactiveScripts: false;
    bundleMode: 'error-if-changed';
    scriptPolicy: 'auto' | 'skip';
    signal: AbortSignal;
    onOutput: (data: Uint8Array) => void;
    onPhaseStart: (phase: ScriptPhase) => void;
  }) => Promise<ScriptResult>;
}

interface AttachWorkspaceSessionArgs {
  workspaceId: string;
  sessionName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  scriptPolicy?: 'auto' | 'skip';
  onOutput?: (data: Uint8Array, phase: ScriptPhase) => void;
  onPhaseStart?: (phase: ScriptPhase) => void;
  onAbortController?: (controller: AbortController | null) => void;
}

function scriptFailureCodeForPhase(phase: ScriptPhase): string {
  switch (phase) {
    case 'pre':
      return 'PRE_SCRIPT_FAILED';
    case 'setup':
      return 'SETUP_SCRIPT_FAILED';
    case 'select':
    default:
      return 'SELECT_SCRIPT_FAILED';
  }
}

function toScriptFailureError(result: ScriptResultFailure): Error & { code?: string } {
  const scriptsCancelled = result.cancelled === true;
  const bundleNeedsRefresh = result.bundleNeedsRefresh === true;
  const error = new SpacesError(
    `Workspace scripts failed during ${result.phase}: ${result.error}`,
  ) as Error & { code?: string };
  if (bundleNeedsRefresh) {
    error.code = 'BUNDLE_REFRESH_REQUIRED';
  } else if (scriptsCancelled) {
    error.code = 'SCRIPT_CANCELLED';
  } else {
    error.code = scriptFailureCodeForPhase(result.phase);
  }
  return error;
}

export async function attachWorkspaceSession(
  deps: AttachWorkspaceSessionDeps,
  args: AttachWorkspaceSessionArgs,
): Promise<{ session: TmuxSession; workspace: WorkspaceRecord }> {
  const workspaces = await deps.scanWorkspaces();
  const workspace = workspaces.find((item) => matchesWorkspaceId(item, args.workspaceId));
  if (!workspace) {
    throw new SpacesError(`Workspace not found: ${args.workspaceId}`, 'USER_ERROR', 1);
  }

  const sessions = await deps.listSessions();
  const fullName = buildSessionName({
    projectName: workspace.projectName,
    workspaceName: workspace.id,
    requestedName: args.sessionName,
    sessions,
  });

  if (args.command) {
    const workspaceHooks = buildWorkspaceSessionHooks(workspace.projectName, workspace.id);
    const session = await deps.createSession(fullName, workspace.path, {
      command: args.command,
      args: args.args,
      env: { ...workspaceHooks.env, ...(args.env ?? {}) },
    });
    return { session, workspace };
  }

  let currentPhase: ScriptPhase = 'pre';
  const attachAbortController = new AbortController();
  args.onAbortController?.(attachAbortController);

  const scriptResult = await deps.prepareWorkspaceForSession({
    projectName: workspace.projectName,
    workspacePath: workspace.path,
    workspaceName: workspace.id,
    interactiveScripts: false,
    bundleMode: 'error-if-changed',
    scriptPolicy: args.scriptPolicy ?? 'auto',
    signal: attachAbortController.signal,
    onOutput: (data) => {
      args.onOutput?.(data, currentPhase);
    },
    onPhaseStart: (phase) => {
      currentPhase = phase;
      args.onPhaseStart?.(phase);
    },
  }).finally(() => {
    args.onAbortController?.(null);
  });

  if (!scriptResult.success) {
    throw toScriptFailureError(scriptResult);
  }

  const session = await deps.createSession(fullName, workspace.path, {
    hooks: buildWorkspaceSessionHooks(workspace.projectName, workspace.id),
  });
  return { session, workspace };
}

export { scriptFailureCodeForPhase };
