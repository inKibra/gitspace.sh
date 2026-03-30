import { describe, expect, it } from 'bun:test';
import { deriveWorkspaceRuntimeModel } from './derive.js';
import { createEmptyMachineSnapshot } from '../../../machine/state/client.js';
import type { MultiMachineState } from '../../../machine/multi/types.js';
import type { MachineAgentSessionRecord, MachineWorkspaceRecord } from '../../../lib/tmux-lite/machine/types.js';
import { toBackendScopedWorkspaceKey } from '../../../machine/multi/types.js';

function makeWorkspace(summaryOverrides: Partial<MachineWorkspaceRecord['summary']> = {}): MachineWorkspaceRecord {
  return {
    id: 'ws-1',
    name: 'ws-1',
    projectId: 'demo',
    projectName: 'demo',
    path: '/tmp/demo/ws-1',
    phase: 'code',
    terminalSessionIds: [],
    agentSessionIds: ['agent-running', 'agent-idle'],
    processIds: [],
    replayIds: [],
    summary: {
      terminalCount: 0,
      attachedTerminalCount: 0,
      runningTerminalCount: 0,
      failedTerminalCount: 0,
      agentCount: 2,
      runningAgentCount: 1,
      waitingAgentCount: 1,
      permissionAgentCount: 0,
      retryingAgentCount: 0,
      closedAgentCount: 0,
      archivedAgentCount: 0,
      configuredProcessCount: 0,
      runningProcessCount: 0,
      failedProcessCount: 0,
      ...summaryOverrides,
    },
  };
}

function makeAgent(id: string, state: MachineAgentSessionRecord['state']): MachineAgentSessionRecord {
  return {
    id,
    workspaceId: 'ws-1',
    projectId: 'demo',
    title: id,
    state,
    pendingPermissionIds: [],
    pendingPermissionCount: 0,
    pendingQuestionIds: [],
    pendingQuestionCount: 0,
  };
}

describe('deriveWorkspaceRuntimeModel', () => {
  it('keeps a workspace green when any agent is running even if another is idle', () => {
    const snapshot = createEmptyMachineSnapshot();
    const workspace = makeWorkspace();
    snapshot.projectsById.demo = {
      id: 'demo',
      name: 'demo',
      repository: 'demo/demo',
      isCurrent: true,
      workspaceIds: ['ws-1'],
      workspaceCount: 1,
    };
    snapshot.projectOrder = ['demo'];
    snapshot.workspacesById['ws-1'] = workspace;
    snapshot.workspaceOrder = ['ws-1'];
    snapshot.workspaceIdsByProjectId.demo = ['ws-1'];
    snapshot.agentSessionsById['agent-running'] = makeAgent('agent-running', 'running');
    snapshot.agentSessionsById['agent-idle'] = makeAgent('agent-idle', 'waiting');
    snapshot.agentSessionIdsByWorkspaceId['ws-1'] = ['agent-running', 'agent-idle'];

    const state: MultiMachineState = {
      backendOrder: ['local'],
      activeBackendKey: 'local',
      byBackend: {
        local: {
          status: 'connected',
          snapshot,
          label: 'Local',
          lastError: null,
        },
      },
    };

    const model = deriveWorkspaceRuntimeModel(state);
    const selectionKey = toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'ws-1' });

    expect(model.workspaceStatusById[selectionKey]?.primaryColor).toBe('green');
    expect(model.runtimeByWorkspace[selectionKey]?.statusSummary.primaryColor).toBe('green');
  });
  it('surfaces only the sessions present in the machine snapshot after PTY reassignment', () => {
    const snapshot = createEmptyMachineSnapshot();
    const workspace = makeWorkspace({ agentCount: 1, runningAgentCount: 0, waitingAgentCount: 1 });
    workspace.agentSessionIds = ['agent-new'];
    snapshot.projectsById.demo = {
      id: 'demo',
      name: 'demo',
      repository: 'demo/demo',
      isCurrent: true,
      workspaceIds: ['ws-1'],
      workspaceCount: 1,
    };
    snapshot.projectOrder = ['demo'];
    snapshot.workspacesById['ws-1'] = workspace;
    snapshot.workspaceOrder = ['ws-1'];
    snapshot.workspaceIdsByProjectId.demo = ['ws-1'];
    snapshot.agentSessionsById['agent-new'] = makeAgent('agent-new', 'waiting');
    snapshot.agentSessionIdsByWorkspaceId['ws-1'] = ['agent-new'];

    const state: MultiMachineState = {
      backendOrder: ['local'],
      activeBackendKey: 'local',
      byBackend: {
        local: {
          status: 'connected',
          snapshot,
          label: 'Local',
          lastError: null,
        },
      },
    };

    const model = deriveWorkspaceRuntimeModel(state);
    const selectionKey = toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'ws-1' });

    expect(model.runtimeByWorkspace[selectionKey]?.agentSessionCount).toBe(1);
    expect(model.runtimeByWorkspace[selectionKey]?.agentSessions.map((session) => session.id)).toEqual(['agent-new']);
  });

});
