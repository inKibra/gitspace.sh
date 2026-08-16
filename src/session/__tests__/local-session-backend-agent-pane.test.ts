import { describe, expect, it } from 'bun:test';
import { LocalSessionBackend, type LocalSessionBackendDependencies } from '../backends/local-session-backend.js';
import type { BackendEvent } from '../events.js';
import type { MachineSnapshot } from '../../lib/tmux-lite/machine/protocol.js';
import type { Command as TmuxCommand, Response as TmuxResponse } from '../../lib/tmux-lite/protocol.js';

const workspace = {
  id: 'ws-1',
  name: 'ws-1',
  path: '/tmp/local-agent-pane-workspace',
  projectName: 'alpha',
  sessionCount: 0,
};

const emptySnapshot: MachineSnapshot = {
  snapshotNonce: 1,
  generatedAt: '2026-08-01T00:00:00.000Z',
  projectsById: {},
  projectOrder: [],
  workspacesById: {},
  workspaceOrder: [],
  workspaceIdsByProjectId: {},
  terminalSessionsById: {},
  terminalSessionIdsByWorkspaceId: {},
  agentSessionsById: {},
  agentSessionIdsByWorkspaceId: {},
  processesById: {},
  processIdsByWorkspaceId: {},
  replaysById: {},
  replayIdsByWorkspaceId: {},
  notificationsById: {},
  notificationOrder: [],
};

function createBackendHarness(responseForOpen: TmuxResponse = {
  type: 'agent-opened',
  agentSessionId: 'agent-1',
  workspaceId: 'alpha:ws-1',
  leaseCount: 1,
}): { backend: LocalSessionBackend; commands: TmuxCommand[]; events: BackendEvent[] } {
  const commands: TmuxCommand[] = [];
  const events: BackendEvent[] = [];
  const deps: Partial<LocalSessionBackendDependencies> = {
    scanWorkspaces: async () => [workspace],
    listSessions: async () => [],
    listProjectSummaries: () => [],
    getMachineSnapshot: async () => emptySnapshot,
    watchMachineEvents: async () => () => {},
    sendTmuxCommand: async (command) => {
      commands.push(command);
      if (command.type === 'agent-open') return responseForOpen;
      if (command.type === 'agent-release') return { type: 'ok' };
      return { type: 'error', message: `unexpected command: ${command.type}` };
    },
  };
  const backend = new LocalSessionBackend({ deps });
  backend.onEvent((event) => events.push(event));
  return { backend, commands, events };
}

describe('LocalSessionBackend native agent panes', () => {
  it('opens a stream-less pane with its pane id and emits one null-stream attachment', async () => {
    const { backend, commands, events } = createBackendHarness();

    await backend.openAgentSession('alpha:ws-1', 'agent-1', { paneId: 'pane-1' });

    expect(commands[0]).toEqual({
      type: 'agent-open',
      target: {
        workspaceId: 'alpha:ws-1',
        workspaceName: 'ws-1',
        workspacePath: workspace.path,
        projectName: 'alpha',
      },
      agentSessionId: 'agent-1',
      paneId: 'pane-1',
    });
    const paneAttachedEvents = events.filter((event) => event.type === 'pane_attached');
    expect(paneAttachedEvents).toEqual([
      {
        type: 'pane_attached',
        paneId: 'pane-1',
        streamId: null,
        sessionId: null,
        workspaceId: 'alpha:ws-1',
        agentSessionId: 'agent-1',
      },
    ]);
    const commandTypes = commands.map((command) => String(command.type));
    expect(commandTypes).not.toContain('attach');
    expect(commandTypes).not.toContain('agent-attach');
  });

  it('rejects an error response without emitting a pane event', async () => {
    const { backend, commands, events } = createBackendHarness({ type: 'error', message: 'session is stale' });

    await expect(backend.openAgentSession('alpha:ws-1', 'agent-1', { paneId: 'pane-1' })).rejects.toThrow('session is stale');
    expect(events.filter((event) => event.type === 'pane_attached' || event.type === 'pane_detached')).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe('agent-open');
  });

  it('detaches and releases a pane once, making a repeated close a no-op', async () => {
    const { backend, commands, events } = createBackendHarness();

    await backend.openAgentSession('alpha:ws-1', 'agent-1', { paneId: 'pane-1' });
    await backend.closeAgentPane('pane-1');
    await backend.closeAgentPane('pane-1');

    expect(events.filter((event) => event.type === 'pane_detached')).toEqual([
      { type: 'pane_detached', paneId: 'pane-1' },
    ]);
    expect(commands.filter((command) => command.type === 'agent-release')).toEqual([
      { type: 'agent-release', agentSessionId: 'agent-1', paneId: 'pane-1' },
    ]);
  });
});
