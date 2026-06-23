import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { LocalSessionBackend, type LocalSessionBackendDependencies } from '../backends/local-session-backend';
import type { BackendDescriptor } from '../backend';
import type { BackendEvent } from '../events';
import type { NotificationConfig } from '../../notifications/types';
import { applyTmuxLiteSandboxEnvironment, getTmuxLitePathsForSandbox } from '../../lib/tmux-lite/protocol.js';
import { killServer } from '../../lib/tmux-lite/cli.js';
import { rmSync } from 'node:fs';
import type { MachineSnapshot } from '../../lib/tmux-lite/machine/protocol.js';
import type { Session as TmuxSession, WorkspaceRuntimeRecord } from '../../lib/tmux-lite/protocol.js';
import { PortConflictError } from '../../lib/processes/port-conflicts.js';
const notificationConfig: NotificationConfig = {
  enabled: true,
  minCommandDurationMs: 1000,
  types: {
    exit: true,
    idle: true,
    bell: true,
    title: true,
    osc: true,
  },
  toast: {
    enabled: true,
    holdWhenIdleMs: 5000,
  },
};

let sandboxCounter = 0;
let currentSandboxName: string | null = null;
let previousTmuxEnv: Record<string, string | undefined> | null = null;

function captureTmuxEnv(): Record<string, string | undefined> {
  return {
    TMUX_LITE_SANDBOX: process.env.TMUX_LITE_SANDBOX,
    TMUX_LITE_SOCKET: process.env.TMUX_LITE_SOCKET,
    TMUX_LITE_SESSION_DIR: process.env.TMUX_LITE_SESSION_DIR,
    TMUX_LITE_PID_FILE: process.env.TMUX_LITE_PID_FILE,
    TMUX_LITE_REPLAY_DIR: process.env.TMUX_LITE_REPLAY_DIR,
  };
}

function restoreTmuxEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function cleanupSandbox(name: string): void {
  const paths = getTmuxLitePathsForSandbox(name);
  rmSync(paths.sessionDir, { recursive: true, force: true });
  rmSync(paths.replayDir, { recursive: true, force: true });
  try { rmSync(paths.routerSocket, { force: true }); } catch {}
  try { rmSync(paths.pidFile, { force: true }); } catch {}
}

beforeEach(() => {
  previousTmuxEnv = captureTmuxEnv();
  currentSandboxName = `local-backend-${process.pid}-${sandboxCounter++}`;
  cleanupSandbox(currentSandboxName);
  applyTmuxLiteSandboxEnvironment(currentSandboxName);
});

afterEach(async () => {
  try { await killServer(); } catch {}
  if (currentSandboxName) {
    cleanupSandbox(currentSandboxName);
  }
  if (previousTmuxEnv) {
    restoreTmuxEnv(previousTmuxEnv);
  }
  currentSandboxName = null;
  previousTmuxEnv = null;
});

function toCanonicalWorkspaceId(projectName: string, workspaceId: string): string {
  return workspaceId.includes(':') ? workspaceId : `${projectName}:${workspaceId}`;
}

function toRuntimeWorkspace(workspace: {
  id: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount?: number;
  isStale?: boolean;
  processes?: WorkspaceRuntimeRecord['processes'];
}): WorkspaceRuntimeRecord {
  const sessionCount = workspace.sessionCount ?? 0;
  const canonicalId = toCanonicalWorkspaceId(workspace.projectName, workspace.id);
  const configuredProcessCount = workspace.processes?.length ?? 0;
  return {
    id: canonicalId,
    name: workspace.name,
    path: workspace.path,
    projectName: workspace.projectName,
    branch: workspace.branch,
    sessionCount,
    isStale: workspace.isStale,
    processes: workspace.processes,
    status: 'code',
    terminals: {
      sessionCount,
      attachedCount: 0,
      runningCount: sessionCount,
      failedCount: 0,
    },
    agents: {
      sessionCount: 0,
      busyCount: 0,
      waitingCount: 0,
      needsPermissionCount: 0,
      errorCount: 0,
      closedCount: 0,
      archivedCount: 0,
    },
    processSummary: {
      configuredCount: configuredProcessCount,
      runningCount: 0,
      failedCount: 0,
    },
  };
}

function toTerminalSession(session: {
  id: string;
  name: string;
  socketPath: string;
  pid: number;
  attached: boolean;
  cwd: string;
  createdAt: number;
  kind?: TmuxSession['kind'];
  hidden?: boolean;
  metadata?: Record<string, string>;
  exitCode?: number;
  processTitle?: string;
  terminalTitle?: string;
  lastAlertKind?: TmuxSession['lastAlertKind'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
}): TmuxSession {
  return {
    ...session,
    kind: session.kind ?? 'shell',
    hidden: session.hidden ?? false,
  };
}

async function buildSnapshotForDeps(deps: Partial<LocalSessionBackendDependencies>): Promise<MachineSnapshot> {
  const workspaces = await (deps.scanWorkspaces?.() ?? Promise.resolve([]));
  const sessions = await (deps.listSessions?.() ?? Promise.resolve([]));
  const terminalSessions = sessions.map((session) => toTerminalSession(session as Parameters<typeof toTerminalSession>[0]));
  const runtimeWorkspaces = workspaces.map((workspace) => {
    const visibleSessionCount = terminalSessions.filter((session) => {
      const sameWorkspace = session.cwd === workspace.path || session.cwd.startsWith(`${workspace.path}/`);
      return sameWorkspace && session.kind !== 'agent' && session.hidden !== true;
    }).length;
    return toRuntimeWorkspace({
      ...(workspace as Parameters<typeof toRuntimeWorkspace>[0]),
      sessionCount: visibleSessionCount,
    });
  });
  const projectSummaries = deps.listProjectSummaries?.() ?? [];
  const projectsById = Object.fromEntries(
    projectSummaries.map((project) => [project.name, {
      id: project.name,
      name: project.name,
      repository: project.repository,
      isCurrent: project.isCurrent,
      workspaceIds: runtimeWorkspaces.filter((workspace) => workspace.projectName === project.name).map((workspace) => workspace.id),
      workspaceCount: runtimeWorkspaces.filter((workspace) => workspace.projectName === project.name).length,
    }]),
  );
  const workspaceIdsByProjectId = Object.fromEntries(
    Object.keys(projectsById).map((projectId) => [projectId, runtimeWorkspaces.filter((workspace) => workspace.projectName === projectId).map((workspace) => workspace.id)]),
  );
  const workspacesById = Object.fromEntries(runtimeWorkspaces.map((workspace) => [workspace.id, {
    id: workspace.id,
    name: workspace.name,
    projectId: workspace.projectName,
    projectName: workspace.projectName,
    path: workspace.path,
    branch: workspace.branch,
    phase: workspace.status,
    isStale: workspace.isStale,
    serveDomain: workspace.serveDomain,
    processes: workspace.processes,
    processConfigError: workspace.processConfigError,
    notesSummary: workspace.notesSummary,
    terminalSessionIds: terminalSessions.filter((session) => (session.cwd === workspace.path || session.cwd.startsWith(`${workspace.path}/`)) && session.kind !== 'agent' && session.hidden !== true).map((session) => session.id),
    agentSessionIds: [],
    processIds: [],
    replayIds: [],
    summary: {
      terminalCount: workspace.terminals.sessionCount,
      attachedTerminalCount: workspace.terminals.attachedCount,
      runningTerminalCount: workspace.terminals.runningCount,
      failedTerminalCount: workspace.terminals.failedCount,
      agentCount: 0,
      runningAgentCount: 0,
      waitingAgentCount: 0,
      permissionAgentCount: 0,
      retryingAgentCount: 0,
      closedAgentCount: 0,
      archivedAgentCount: 0,
      configuredProcessCount: workspace.processSummary.configuredCount,
      runningProcessCount: workspace.processSummary.runningCount,
      failedProcessCount: workspace.processSummary.failedCount,
    },
  }]));
  const terminalSessionsById = Object.fromEntries(terminalSessions.map((session) => {
    const workspace = runtimeWorkspaces.find((item) => session.cwd === item.path || session.cwd.startsWith(`${item.path}/`));
    const isAgentSession = session.kind === 'agent';
    return [session.id, {
      id: session.id,
      name: session.name,
      workspaceId: workspace?.id,
      projectId: workspace?.projectName,
      socketPath: session.socketPath,
      cwd: session.cwd,
      kind: (isAgentSession ? 'agent' : 'shell') as 'agent' | 'shell',
      hidden: session.hidden ?? false,
      state: (session.attached ? 'attached' : 'running') as 'attached' | 'running',
      attached: session.attached,
      createdAt: session.createdAt,
      exitCode: session.exitCode,
      processTitle: session.processTitle,
      terminalTitle: session.terminalTitle,
      lastAlertKind: session.lastAlertKind,
      lastAlertPreview: session.lastAlertPreview,
      lastAlertAt: session.lastAlertAt,
      unreadAlertCount: session.unreadAlertCount,
      processName: undefined,
      processInstance: undefined,
      linkedAgentSessionId: session.metadata?.agentSessionId,
      metadata: session.metadata,
    }];
  }));
  const terminalSessionIdsByWorkspaceId = Object.fromEntries(runtimeWorkspaces.map((workspace) => [workspace.id, terminalSessions.filter((session) => (session.cwd === workspace.path || session.cwd.startsWith(`${workspace.path}/`)) && session.kind !== 'agent' && session.hidden !== true).map((session) => session.id)]));
  return {
    snapshotNonce: 1,
    generatedAt: new Date().toISOString(),
    projectsById,
    projectOrder: Object.keys(projectsById),
    workspacesById,
    workspaceOrder: runtimeWorkspaces.map((workspace) => workspace.id),
    workspaceIdsByProjectId,
    terminalSessionsById,
    terminalSessionIdsByWorkspaceId,
    agentSessionsById: {},
    agentSessionIdsByWorkspaceId: {},
    processesById: {},
    processIdsByWorkspaceId: {},
    replaysById: {},
    replayIdsByWorkspaceId: {},
    notificationsById: {},
    notificationOrder: [],
  };
}

function createBackend(
  deps: Partial<LocalSessionBackendDependencies>,
  options: {
    descriptor?: BackendDescriptor;
  } = {},
) {
  const effectiveDeps: Partial<LocalSessionBackendDependencies> = {
    ...deps,
    getMachineSnapshot: deps.getMachineSnapshot ?? (() => buildSnapshotForDeps(deps)),
    watchMachineEvents: deps.watchMachineEvents ?? (async () => () => {}),
    sendTmuxCommand: deps.sendTmuxCommand ?? (async (command) => {
      switch (command.type) {
        case 'inbox': {
          const items = await ((deps as { getInbox?: () => Promise<unknown> }).getInbox?.() ?? Promise.resolve([]));
          return {
            type: 'inbox' as const,
            items: Array.isArray(items) ? items : ((items as { items?: unknown[] }).items ?? []),
          };
        }
        case 'inbox-clear':
          await (deps as { clearInbox?: (id?: string) => Promise<void> }).clearInbox?.(command.id);
          return { type: 'ok' as const };
        case 'inbox-read':
          await (deps as { markInboxRead?: (id: string) => Promise<void> }).markInboxRead?.(command.id);
          return { type: 'ok' as const };
        case 'notification-config-get': {
          const result = await ((deps as { getNotificationConfig?: () => Promise<unknown> }).getNotificationConfig?.() ?? Promise.resolve({ config: notificationConfig }));
          return {
            type: 'notification-config' as const,
            config: (result && typeof result === 'object' && 'config' in result ? result.config : result) as NotificationConfig,
          };
        }
        case 'notification-config-update': {
          const result = await ((deps as { updateNotificationConfig?: (config: NotificationConfig) => Promise<unknown> }).updateNotificationConfig?.(command.config) ?? Promise.resolve({ config: command.config }));
          return {
            type: 'notification-config' as const,
            config: (result && typeof result === 'object' && 'config' in result ? result.config : result) as NotificationConfig,
          };
        }
        default:
          throw new Error(`Unhandled tmux command in test helper: ${command.type}`);
      }
    }),
    prepareAttachSession: deps.prepareAttachSession ?? (async (params) => {
      const workspaceList = await (deps.scanWorkspaces?.() ?? Promise.resolve([]));
      const workspace = workspaceList.find((item) => item.id === params.workspaceId || toCanonicalWorkspaceId(item.projectName, item.id) === params.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${params.workspaceId}`);
      }
      const requestId = 'test-request';
      params.onRequestId?.(requestId);
      let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
      const prep = await ((deps.prepareWorkspaceForSession as ((options: any) => Promise<any>) | undefined)?.({
        projectName: workspace.projectName,
        workspacePath: workspace.path,
        workspaceName: workspace.name,
        scriptPolicy: params.scriptPolicy,
        onPhaseStart: (phase: 'pre' | 'setup' | 'select') => {
          currentPhase = phase;
          params.onScriptOutput?.({
            type: 'attach-script-output',
            requestId,
            phase,
            data: Buffer.from(`\r\n==> ${phase} scripts...\r\n`).toString('base64'),
            done: false,
          });
        },
        onOutput: (data: Uint8Array) => {
          params.onScriptOutput?.({
            type: 'attach-script-output',
            requestId,
            phase: currentPhase,
            data: Buffer.from(data).toString('base64'),
            done: false,
          });
        },
      }) ?? Promise.resolve({ success: true }));
      if (!prep.success) {
        const phase = prep.phase ?? 'setup';
        const code = phase === 'pre' ? 'PRE_SCRIPT_FAILED' : phase === 'select' ? 'SELECT_SCRIPT_FAILED' : 'SETUP_SCRIPT_FAILED';
        throw Object.assign(new Error(prep.error ?? `${phase} failed`), { code });
      }
      params.onScriptOutput?.({ type: 'attach-script-output', requestId, phase: 'select', data: '', done: true });
      const sessions = await (deps.listSessions?.() ?? Promise.resolve([]));
      const existingCount = sessions.filter((session) => session.cwd === workspace.path && !session.hidden).length;
      const nextIndex = existingCount + 1;
      const sessionName = params.sessionName ?? `${workspace.projectName}:${workspace.id}:${nextIndex}`;
      const createSessionDep = deps.createSession as typeof deps.createSession | undefined;
      const session = await (createSessionDep
        ? createSessionDep(sessionName, workspace.path, { command: params.command, args: params.args, env: params.env })
        : Promise.resolve({ id: 'sess-new', name: sessionName, socketPath: '/tmp/socket-new', pid: 1, attached: false, cwd: workspace.path, createdAt: Date.now() }));
      return { type: 'attach-prepared' as const, requestId, session, workspaceId: toCanonicalWorkspaceId(workspace.projectName, workspace.id), viewOnly: params.viewOnly };
    }),
    cancelPrepareAttachSession: deps.cancelPrepareAttachSession ?? (async () => undefined),
    deleteTmuxWorkspace: deps.deleteTmuxWorkspace ?? (async ({ projectName, workspaceId, scriptPolicy, onScriptOutput }) => {
      const result = await (deps.deleteWorkspaceCore?.(projectName, workspaceId, {
        removeScriptPolicy: scriptPolicy === 'skip' ? 'skip' : 'enforce',
        onScriptOutput: (data) => onScriptOutput?.({
          type: 'workspace-delete-output',
          requestId: 'test-request',
          data: Buffer.from(data).toString('base64'),
          done: false,
        }),
      }) ?? Promise.resolve({ success: true, workspaceName: workspaceId, branchDeleted: false, sessionsKilled: 0 }));
      if (!result.success) {
        onScriptOutput?.({ type: 'workspace-delete-output', requestId: 'test-request', data: '', done: true, error: result.error });
        throw Object.assign(new Error(result.error ?? 'Delete failed'), { code: result.errorCode });
      }
      onScriptOutput?.({ type: 'workspace-delete-output', requestId: 'test-request', data: '', done: true });
    }),
  };
  return new LocalSessionBackend({ descriptor: options.descriptor, deps: effectiveDeps });
}

describe('LocalSessionBackend', () => {
  it('emits local project/workspace/session/inbox and attach events', async () => {
    const createdSessions: Array<{ name: string; cwd: string }> = [];
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [
        {
          name: 'alpha',
          repository: 'org/alpha',
          workspaceCount: 1,
          isCurrent: true,
        },
      ],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          branch: 'main',
          sessionCount: 0,
          isStale: false,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async (name, cwd) => {
        createdSessions.push({ name, cwd });
        return {
          id: 'sess-new',
          name,
          socketPath: '/tmp/socket-new',
          pid: 456,
          attached: false,
          cwd,
          createdAt: 456,
        };
      },
      prepareWorkspaceForSession: async (options) => {
        options.onPhaseStart?.('pre');
        options.onOutput?.(Buffer.from('pre-output'));
        options.onPhaseStart?.('setup');
        options.onOutput?.(Buffer.from('setup-output'));
        options.onPhaseStart?.('select');
        options.onOutput?.(Buffer.from('select-output'));
        return { success: true };
      },
      getInbox: async () => [
        {
          id: 'inbox-1',
          sessionId: 'sess-1',
          sessionName: 'alpha:ws-1:1',
          type: 'bell',
          timestamp: Date.now(),
          context: 'ding',
          read: false,
        },
      ],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: async (updates: NotificationConfig) => ({
        ...notificationConfig,
        ...updates,
      }),
      connectSessionSocket: async (_socketPath, handlers) => {
        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps, {
      descriptor: {
        key: 'local',
        kind: 'local',
        label: 'Local',
      },
    });

    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.listProjects();
    await backend.listWorkspaces();
    await backend.listSessions();
    await backend.requestInbox();
    await backend.getNotificationConfig();
    await backend.attachSession({ workspaceId: 'ws-1' });

    expect(events).toContainEqual({ type: 'status', status: 'connected' });
    expect(events).toContainEqual({
      type: 'projects',
      projects: [
        {
          name: 'alpha',
          repository: 'org/alpha',
          workspaceCount: 1,
          isCurrent: true,
        },
      ],
    });

    expect(events).toContainEqual({
      type: 'sessions',
      sessions: [
        expect.objectContaining({
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          workspaceId: 'alpha:ws-1',
          attached: false,
          createdAt: 123,
          processTitle: undefined,
          exitCode: undefined,
          socketPath: '/tmp/socket-1',
          cwd: '/tmp/ws-1',
          pid: 123,
        }),
      ],
    });

    expect(events).toContainEqual({
      type: 'inbox',
      items: [
        expect.objectContaining({
          id: 'inbox-1',
          sessionId: 'sess-1',
          read: false,
        }),
      ],
      unreadCount: 1,
    });

    expect(events).toContainEqual({
      type: 'notification_config',
      config: notificationConfig,
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'attached',
      sessionId: 'sess-new',
      sessionName: 'alpha:ws-1:2',
      viewOnly: false,
      workspaceId: 'alpha:ws-1',
    }));

    const scriptStreamChunks = events
      .filter((event): event is Extract<BackendEvent, { type: 'script_output' }> =>
        event.type === 'script_output' && !event.done && event.data.length > 0
      )
      .map((event) => new TextDecoder().decode(event.data));

    expect(scriptStreamChunks).toEqual([
      '\r\n==> pre scripts...\r\n',
      'pre-output',
      '\r\n==> setup scripts...\r\n',
      'setup-output',
      '\r\n==> select scripts...\r\n',
      'select-output',
    ]);

    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'select',
      data: new Uint8Array(0),
      done: true,
      error: undefined,
      workspaceId: 'ws-1',
    });

    expect(createdSessions).toEqual([
      {
        name: 'alpha:ws-1:2',
        cwd: '/tmp/ws-1',
      },
    ]);
  });

  it('does not include saved filters in workspace list payloads', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 0,
        },
      ],
      listSessions: async () => [],
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.listWorkspaces();

    const workspaceEvent = events.find((event) => event.type === 'workspaces');
    expect(workspaceEvent).toBeDefined();
    if (workspaceEvent && workspaceEvent.type === 'workspaces') {
      expect('savedEventFilters' in workspaceEvent).toBe(false);
    }
  });

  it('streams PTY data and control frames through local socket transport', async () => {
    const events: BackendEvent[] = [];
    const sentControls: Array<{
      type: string;
      cols?: number;
      rows?: number;
      clientType?: 'cli' | 'web';
    }> = [];
    const sentPty: Uint8Array[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => ({
        sendControl: (control) => {
          sentControls.push(control);
          if (control.type === 'attach-init') {
            handlers.onControl({ type: 'attached' });
          }
          if (control.type === 'detach') {
            handlers.onClose();
          }
        },
        sendPty: (data) => {
          sentPty.push(data);
        },
        close: () => {
          handlers.onClose();
        },
      }),
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1', cols: 120, rows: 40 });
    await backend.writePtyData(new Uint8Array([0x41]));
    await backend.resizePty(100, 30);
    await backend.detachSession();

    expect(sentControls).toContainEqual({ type: 'attach-init', cols: 120, rows: 40, clientType: 'cli' });
    expect(sentControls).toContainEqual({ type: 'resize', cols: 100, rows: 30 });
    expect(sentControls).toContainEqual({ type: 'detach' });
    expect(sentPty).toEqual([new Uint8Array([0x41])]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'attached', sessionId: 'sess-1', sessionName: 'alpha:ws-1:1', viewOnly: false, workspaceId: 'alpha:ws-1' }));
    expect(events).toContainEqual({ type: 'detached' });
  });

  it('buffers PTY output while no callback is registered and flushes on restore', async () => {
    let socketHandlers:
      | {
          onPtyData: (data: Uint8Array) => void;
          onControl: (event: any) => void;
          onClose: () => void;
          onError: (error: Error) => void;
        }
      | undefined;
    const output: string[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        socketHandlers = handlers;
        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onPtyData(new TextEncoder().encode('snapshot-before-handler'));
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps);
    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    backend.setPtyOutputHandler((data) => {
      output.push(new TextDecoder().decode(data));
    });

    socketHandlers?.onPtyData(new TextEncoder().encode('live-after-handler'));

    expect(output).toEqual(['snapshot-before-handler', 'live-after-handler']);
  });

  it('re-buffers PTY output after callback is cleared and flushes on re-register', async () => {
    let socketHandlers:
      | {
          onPtyData: (data: Uint8Array) => void;
          onControl: (event: any) => void;
          onClose: () => void;
          onError: (error: Error) => void;
        }
      | undefined;
    const callbackOneOutput: string[] = [];
    const callbackTwoOutput: string[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        socketHandlers = handlers;
        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps);
    await backend.connect();

    backend.setPtyOutputHandler((data) => {
      callbackOneOutput.push(new TextDecoder().decode(data));
    });

    await backend.attachSession({ sessionId: 'sess-1' });

    socketHandlers?.onPtyData(new TextEncoder().encode('before-clear'));
    backend.setPtyOutputHandler(null);
    socketHandlers?.onPtyData(new TextEncoder().encode('while-cleared'));

    backend.setPtyOutputHandler((data) => {
      callbackTwoOutput.push(new TextDecoder().decode(data));
    });
    socketHandlers?.onPtyData(new TextEncoder().encode('after-restore'));

    expect(callbackOneOutput).toEqual(['before-clear']);
    expect(callbackTwoOutput).toEqual(['before-clearwhile-cleared', 'after-restore']);
  });

  it('handles attach/detach/reattach sequencing without losing attach snapshot output', async () => {
    let attachAttempt = 0;
    const handlersByAttempt: Array<{
      onPtyData: (data: Uint8Array) => void;
      onControl: (event: any) => void;
      onClose: () => void;
      onError: (error: Error) => void;
    }> = [];
    const firstAttachOutput: string[] = [];
    const secondAttachOutput: string[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        attachAttempt += 1;
        handlersByAttempt.push(handlers);

        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onPtyData(
                new TextEncoder().encode(
                  attachAttempt === 1 ? 'snapshot-first-attach' : 'snapshot-second-attach'
                )
              );
              handlers.onControl({ type: 'attached' });
              return;
            }

            if (control.type === 'detach') {
              handlers.onClose();
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps);
    await backend.connect();

    backend.setPtyOutputHandler((data) => {
      firstAttachOutput.push(new TextDecoder().decode(data));
    });
    await backend.attachSession({ sessionId: 'sess-1' });

    backend.setPtyOutputHandler(null);
    await backend.detachSession();

    await backend.attachSession({ sessionId: 'sess-1' });

    backend.setPtyOutputHandler((data) => {
      secondAttachOutput.push(new TextDecoder().decode(data));
    });
    handlersByAttempt[1]?.onPtyData(new TextEncoder().encode('live-second-attach'));

    expect(firstAttachOutput).toEqual(['snapshot-first-attach']);
    expect(secondAttachOutput).toEqual(['snapshot-second-attach', 'live-second-attach']);
  });

  it('emits detached when switching sessions and new attach fails', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 2,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
        {
          id: 'sess-2',
          name: 'alpha:ws-1:2',
          socketPath: '/tmp/socket-2',
          pid: 456,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 456,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (socketPath, handlers) => {
        if (socketPath === '/tmp/socket-2') {
          throw new Error('socket connect failed');
        }

        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    await expect(backend.attachSession({ sessionId: 'sess-2' })).rejects.toThrow(
      'socket connect failed'
    );

    const attachedEvents = events.filter((event) => event.type === 'attached');
    const detachedEvents = events.filter((event) => event.type === 'detached');

    expect(attachedEvents).toEqual([
      expect.objectContaining({
        type: 'attached',
        sessionId: 'sess-1',
        sessionName: 'alpha:ws-1:1',
        viewOnly: false,
        workspaceId: 'alpha:ws-1',
      }),
    ]);
    expect(detachedEvents).toEqual([{ type: 'detached' }]);
  });

  it('retries once when local session socket closes during attach', async () => {
    const events: BackendEvent[] = [];
    let connectAttempts = 0;

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        connectAttempts += 1;
        return {
          sendControl: (control) => {
            if (control.type !== 'attach-init') {
              return;
            }

            if (connectAttempts === 1) {
              handlers.onClose();
              return;
            }

            handlers.onControl({ type: 'attached' });
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    expect(connectAttempts).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'attached',
      sessionId: 'sess-1',
      sessionName: 'alpha:ws-1:1',
      viewOnly: false,
      workspaceId: 'alpha:ws-1',
    }));
  });

  it('fails fast when attaching to an exited session', async () => {
    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [],
      listSessions: async () => [
        {
          id: 'sess-exited',
          name: 'alpha:ws-1:old',
          socketPath: '/tmp/socket-old',
          pid: 999,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 100,
          exitCode: 1,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async () => {
        throw new Error('should not connect');
      },
    };

    const backend = createBackend(deps);

    await backend.connect();
    await expect(backend.attachSession({ sessionId: 'sess-exited' })).rejects.toThrow(
      'Session has already exited'
    );
  });

  it('ignores stale close callbacks from previous attach attempt', async () => {
    const handlersByAttempt: Array<{
      onPtyData: (data: Uint8Array) => void;
      onControl: (event: any) => void;
      onClose: () => void;
      onError: (error: Error) => void;
    }> = [];
    let connectAttempts = 0;

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        connectAttempts += 1;
        handlersByAttempt.push(handlers);

        return {
          sendControl: (control) => {
            if (control.type !== 'attach-init') {
              return;
            }

            if (connectAttempts === 1) {
              handlers.onError(new Error('Local session socket error: transient'));
              return;
            }

            handlers.onControl({ type: 'attached' });
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = createBackend(deps);
    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    // Simulate delayed close callback from first (failed) attach attempt.
    handlersByAttempt[0]?.onClose();

    // If stale callback was not ignored, this would throw "No attached local session".
    await expect(backend.writePtyData(new Uint8Array([0x41]))).resolves.toBeUndefined();
  });

  it('emits phase-specific command_error when setup scripts fail', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 0,
        },
      ],
      listSessions: async () => [],
      createSession: async () => {
        throw new Error('should not create session');
      },
      prepareWorkspaceForSession: async () => ({
        success: false,
        phase: 'setup',
        error: 'install failed',
      }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async () => {
        throw new Error('should not connect');
      },
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await expect(backend.attachSession({ workspaceId: 'ws-1' })).rejects.toThrow('install failed');

    expect(events).toContainEqual({
      type: 'command_error',
      code: 'SETUP_SCRIPT_FAILED',
      message: 'install failed',
    });
  });

  it('skips workspace scripts when scriptPolicy is skip', async () => {
    let prepareCalls = 0;

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 0,
        },
      ],
      listSessions: async () => [],
      createSession: async () => ({
        id: 'sess-1',
        name: 'alpha:ws-1:1',
        socketPath: '/tmp/socket-1',
        pid: 123,
        attached: false,
        cwd: '/tmp/ws-1',
        createdAt: 100,
      }),
      prepareWorkspaceForSession: async () => {
        prepareCalls += 1;
        return { success: true };
      },
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      terminateSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => ({
        sendControl: (control) => {
          if (control.type === 'attach-init') {
            handlers.onControl({ type: 'attached' });
          }
        },
        sendPty: () => {},
        close: () => {
          handlers.onClose();
        },
      }),
    };

    const backend = createBackend(deps);
    await backend.connect();
    await backend.attachSession({ workspaceId: 'ws-1', scriptPolicy: 'skip' });

    expect(prepareCalls).toBe(1);
  });

  it('streams remove script output and emits completion when deleting workspace', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      deleteWorkspaceCore: async (_projectName, workspaceId, options) => {
        options?.onScriptOutput?.(Buffer.from(`remove:${workspaceId}`));
        return {
          success: true,
          workspaceName: workspaceId,
          branchDeleted: false,
          sessionsKilled: 0,
        };
      },
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.deleteWorkspace('alpha', 'alpha:ws-1');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'script_output',
      phase: 'remove',
      data: new TextEncoder().encode('remove:ws-1'),
    }));
    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'remove',
      data: new Uint8Array(0),
      done: true,
      error: undefined,
      workspaceId: 'ws-1',
    });
  });

  it('allows retrying delete with scriptPolicy skip after remove script failure', async () => {
    const events: BackendEvent[] = [];
    const observedPolicies: Array<'enforce' | 'best-effort' | 'skip' | undefined> = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      deleteWorkspaceCore: async (_projectName, workspaceId, options) => {
        observedPolicies.push(options?.removeScriptPolicy);
        if (options?.removeScriptPolicy === 'skip') {
          return {
            success: true,
            workspaceName: workspaceId,
            branchDeleted: false,
            sessionsKilled: 0,
          };
        }

        options?.onScriptOutput?.(Buffer.from('cleanup failed'));
        return {
          success: false,
          workspaceName: workspaceId,
          branchDeleted: false,
          sessionsKilled: 0,
          errorCode: 'REMOVE_SCRIPT_FAILED',
          error: 'Remove scripts failed: cleanup failed',
          removeScriptError: 'cleanup failed',
        };
      },
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await expect(backend.deleteWorkspace('alpha', 'ws-1')).rejects.toMatchObject({
      message: 'Remove scripts failed: cleanup failed',
      code: 'REMOVE_SCRIPT_FAILED',
    });

    await expect(
      backend.deleteWorkspace('alpha', 'ws-1', { scriptPolicy: 'skip' })
    ).resolves.toBeUndefined();

    expect(observedPolicies).toEqual(['enforce', 'skip']);
    expect(events).toContainEqual({
      type: 'command_error',
      code: 'REMOVE_SCRIPT_FAILED',
      message: 'Remove scripts failed: cleanup failed',
    });
    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'remove',
      data: new Uint8Array(0),
      done: true,
      error: 'Remove scripts failed: cleanup failed',
      workspaceId: 'ws-1',
    });
  });

  it('preserves workspace delete error code and throws typed error', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      deleteWorkspaceCore: async (_projectName, workspaceId) => ({
        success: false,
        workspaceName: workspaceId,
        branchDeleted: false,
        sessionsKilled: 0,
        errorCode: 'WORKSPACE_NOT_FOUND',
        error: 'Workspace "ws-missing" does not exist',
      }),
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await expect(backend.deleteWorkspace('alpha', 'ws-missing')).rejects.toMatchObject({
      name: 'WorkspaceDeleteError',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace "ws-missing" does not exist',
    });

    expect(events).toContainEqual({
      type: 'command_error',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace "ws-missing" does not exist',
    });
  });

  it('emits replay lists and respects includeDismissed filters', async () => {
    const events: BackendEvent[] = [];
    const listReplaysCalls: Array<{ workspaceId?: string; includeDismissed?: boolean }> = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      listReplays: (filter = {}) => {
        listReplaysCalls.push(filter);
        return filter.includeDismissed
          ? [
              {
                replayId: 'replay-visible',
                sessionId: 'sess-1',
                sessionName: 'visible',
                cwd: '/tmp/ws-1',
                workspaceId: 'ws-1',
                projectName: 'alpha',
                workspaceName: 'ws-1',
                startedAt: 1,
                endedAt: 2,
                status: 'closed',
                durationMs: 1,
                eventCount: 1,
                checkpointCount: 1,
                lastSeq: 1,
              },
              {
                replayId: 'replay-hidden',
                sessionId: 'sess-2',
                sessionName: 'hidden',
                cwd: '/tmp/ws-1',
                workspaceId: 'ws-1',
                projectName: 'alpha',
                workspaceName: 'ws-1',
                startedAt: 3,
                endedAt: 4,
                status: 'closed',
                durationMs: 1,
                eventCount: 1,
                checkpointCount: 1,
                lastSeq: 1,
                dismissedAt: 10,
              },
            ]
          : [
              {
                replayId: 'replay-visible',
                sessionId: 'sess-1',
                sessionName: 'visible',
                cwd: '/tmp/ws-1',
                workspaceId: 'ws-1',
                projectName: 'alpha',
                workspaceName: 'ws-1',
                startedAt: 1,
                endedAt: 2,
                status: 'closed',
                durationMs: 1,
                eventCount: 1,
                checkpointCount: 1,
                lastSeq: 1,
              },
              {
                replayId: 'replay-agent',
                sessionId: 'sess-agent',
                sessionName: 'agent:ws-1:abcd1234',
                cwd: '/tmp/ws-1',
                workspaceId: 'ws-1',
                projectName: 'alpha',
                workspaceName: 'ws-1',
                startedAt: 5,
                endedAt: 6,
                status: 'closed',
                durationMs: 1,
                eventCount: 1,
                checkpointCount: 1,
                lastSeq: 1,
              },
            ];
      },
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.listReplays('ws-1');
    await backend.listReplays('ws-1', true);

    expect(listReplaysCalls).toEqual([
      { workspaceId: 'ws-1', includeDismissed: undefined },
      { workspaceId: 'ws-1', includeDismissed: true },
    ]);

    const replayEvents = events.filter((event) => event.type === 'replays');
    expect(replayEvents).toHaveLength(2);
    expect(replayEvents[0]).toEqual({
      type: 'replays',
      replays: [expect.objectContaining({ replayId: 'replay-visible' })],
    });
    expect(replayEvents[1]).toEqual({
      type: 'replays',
      replays: [
        expect.objectContaining({ replayId: 'replay-visible' }),
        expect.objectContaining({ replayId: 'replay-hidden', dismissedAt: 10 }),
      ],
    });
    expect(JSON.stringify(replayEvents)).not.toContain('replay-agent');
  });

  it('returns replay frame and delegates dismiss / undismiss', async () => {
    const dismissCalls: string[] = [];
    const undismissCalls: string[] = [];
    const mockFrame = {
      replayId: 'replay-1',
      checkpoint: null,
      events: [{ seq: 1, t: 10, type: 'output' as const, data: 'dGVzdA==' }],
    };
    const deps: Partial<LocalSessionBackendDependencies> = {
      getReplayFrame: () => mockFrame,
      dismissReplay: (replayId) => { dismissCalls.push(replayId); },
      undismissReplay: (replayId) => { undismissCalls.push(replayId); },
    };

    const backend = createBackend(deps);
    const frame = await backend.getReplayFrame('replay-1');
    expect(frame.replayId).toBe('replay-1');
    expect(frame.events).toHaveLength(1);

    await backend.dismissReplay('replay-1');
    await backend.undismissReplay('replay-1');

    expect(dismissCalls).toEqual(['replay-1']);
    expect(undismissCalls).toEqual(['replay-1']);
  });

  it('hides agent tmux sessions from workspace counts and normal session list', async () => {
    const events: BackendEvent[] = [];
    const deps: Partial<LocalSessionBackendDependencies> = {
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          branch: 'main',
          sessionCount: 0,
          isStale: false,
        },
      ],
      listSessions: async () => [
        {
          id: 'shell-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-shell',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 1,
          kind: 'shell',
          hidden: false,
        },
        {
          id: 'agent-pty-1',
          name: 'agent:ws-1:abcd1234',
          socketPath: '/tmp/socket-agent',
          pid: 456,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 2,
          kind: 'agent',
          hidden: true,
          metadata: { workspaceId: 'alpha:ws-1', agentSessionId: 'agent-ses-1' },
        },
      ],
    };

    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.listWorkspaces();
    await backend.listSessions();

    expect(events).toContainEqual({
      type: 'workspaces',
      workspaces: [expect.objectContaining({ id: 'alpha:ws-1', sessionCount: 1 })],
    });
    expect(events).toContainEqual({
      type: 'sessions',
      sessions: [expect.objectContaining({ id: 'shell-1' })],
    });
  });

  it('refreshes machine state before listing workspaces', async () => {
    const events: BackendEvent[] = [];
    const workspace = {
      id: 'ws-1',
      name: 'ws-1',
      path: '/tmp/ws-1',
      projectName: 'alpha',
      branch: 'main',
      sessionCount: 0,
      isStale: false,
    };
    const staleSnapshot = await buildSnapshotForDeps({
      scanWorkspaces: async () => [],
      listSessions: async () => [],
    });
    const refreshedSnapshot = await buildSnapshotForDeps({
      scanWorkspaces: async () => [workspace],
      listSessions: async () => [],
    });
    const snapshots = [staleSnapshot, refreshedSnapshot];
    const getMachineSnapshot = mock(async () => snapshots.shift() ?? refreshedSnapshot);
    const backend = createBackend({
      getMachineSnapshot,
      watchMachineEvents: async () => () => {},
    });
    backend.onEvent((event) => events.push(event));
    await backend.connect();
    await backend.listWorkspaces();
    expect(events).toContainEqual({
      type: 'workspaces',
      workspaces: [expect.objectContaining({ id: 'alpha:ws-1' })],
    });
  });

  it('refreshes machine state before attaching a newly created agent session terminal', async () => {
    const events: BackendEvent[] = [];
    const agentTerminalSession = {
      id: 'tmux-agent-1',
      name: 'agent:ws-1:abcd1234',
      socketPath: '/tmp/socket-agent',
      pid: 999,
      attached: false,
      cwd: '/tmp/ws-1',
      createdAt: 10,
      kind: 'agent' as const,
      hidden: true,
      metadata: { workspaceId: 'alpha:ws-1', agentSessionId: 'agent-ses-1' },
    };
    const ensureAgentTerminalSession = mock(async (_target: unknown, _agentSessionId: string) => agentTerminalSession);
    const workspace = {
      id: 'ws-1',
      name: 'ws-1',
      path: '/tmp/ws-1',
      projectName: 'alpha',
      branch: 'main',
      sessionCount: 0,
      isStale: false,
    };
    const staleSnapshot = await buildSnapshotForDeps({
      scanWorkspaces: async () => [workspace],
      listSessions: async () => [],
    });
    const refreshedSnapshot = await buildSnapshotForDeps({
      scanWorkspaces: async () => [workspace],
      listSessions: async () => [agentTerminalSession],
    });
    const snapshots = [staleSnapshot, refreshedSnapshot];
    const getMachineSnapshot = mock(async () => snapshots.shift() ?? refreshedSnapshot);

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      getMachineSnapshot,
      watchMachineEvents: async () => () => {},
      scanWorkspaces: async () => [workspace],
      listSessions: async () => [agentTerminalSession],
      sendTmuxCommand: mock(async (command): Promise<any> => {
        if (command.type === 'agent-attach') {
          return { type: 'session' as const, session: await ensureAgentTerminalSession(command.target, command.agentSessionId) };
        }
        if (command.type === 'inbox') {
          return { type: 'inbox' as const, items: [] };
        }
        if (command.type === 'notification-config-get') {
          return { type: 'notification-config' as const, config: notificationConfig };
        }
        throw new Error(`Unexpected command: ${command.type}`);
      }),
      connectSessionSocket: async (_socketPath, handlers) => ({
        sendControl: (control) => {
          if (control.type === 'attach-init') {
            handlers.onControl({ type: 'attached' });
          }
        },
        sendPty: () => {},
        close: () => handlers.onClose(),
      }),
    };
    const backend = createBackend(deps);
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachAgentSession('alpha:ws-1', 'agent-ses-1');

    expect(getMachineSnapshot).toHaveBeenCalledTimes(2);
    expect(ensureAgentTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'alpha:ws-1', workspacePath: '/tmp/ws-1' }),
      'agent-ses-1',
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'attached',
        sessionId: 'tmux-agent-1',
        workspaceId: 'alpha:ws-1',
      }),
    );
  });
  it('rethrows structured service-start conflicts as PortConflictError', async () => {
    const conflict = { port: 3000, protocol: 'http' as const, pid: 1234, command: 'node' };
    const backend = createBackend({
      sendTmuxCommand: async (command) => {
        if (command.type === 'service-start') {
          return {
            type: 'error' as const,
            code: 'PORT_CONFLICT',
            message: 'Failed to start service: Cannot start web; port already in use: :3000 -> node (pid 1234)',
            processName: 'web',
            portConflicts: [conflict],
          };
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
    });

    let thrown: unknown;
    try {
      await backend.startProcess('alpha:ws-1', 'web', 1);
      expect.unreachable('Expected startProcess to throw');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PortConflictError);
    expect(thrown).toMatchObject({
      name: 'PortConflictError',
      code: 'PORT_CONFLICT',
      conflicts: [conflict],
    });
  });

});
