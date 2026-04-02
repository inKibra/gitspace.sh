import { describe, expect, it } from 'bun:test';
import { buildMachineSnapshot } from './build.js';
import type { WorkspaceRuntimeRecord } from '../protocol.js';
import type { WorkspaceAgentState } from '../agent-event-manager.js';
import type { Session } from '../protocol.js';

function makeWorkspace(): WorkspaceRuntimeRecord {
  return {
    id: 'demo:ws-1',
    name: 'ws-1',
    path: '/tmp/demo/ws-1',
    projectName: 'demo',
    status: 'code',
    sessionCount: 0,
    terminals: { sessionCount: 0, attachedCount: 0, runningCount: 0, failedCount: 0 },
    agents: { sessionCount: 1, busyCount: 0, waitingCount: 1, needsPermissionCount: 0, errorCount: 0, closedCount: 0, archivedCount: 0 },
    processSummary: { configuredCount: 0, runningCount: 0, failedCount: 0 },
    processes: [],
  };
}

function makeAgentTerminalSession(id = 'pty-1', agentSessionId = 'agent-1'): Session {
  return {
    id,
    name: `agent:ws-1:${agentSessionId.slice(-8)}`,
    socketPath: `/tmp/${id}.sock`,
    pid: 123,
    attached: true,
    cwd: '/tmp/demo/ws-1',
    createdAt: Date.now(),
    kind: 'agent',
    hidden: true,
    metadata: {
      workspaceId: 'demo:ws-1',
      agentSessionId,
    },
  };
}

describe('buildMachineSnapshot', () => {
  it('does not mark an agent running only because its linked PTY is attached', () => {
    const snapshot = buildMachineSnapshot({
      snapshotNonce: 1,
      terminalSessions: [makeAgentTerminalSession()],
      workspaces: [makeWorkspace()],
      agentStateByWorkspaceId: {
        'demo:ws-1': {
          workspaceId: 'demo:ws-1',
          sessions: [{ id: 'agent-1', title: 'Agent 1' }],
          statuses: {},
          pendingPermissions: {},
          pendingQuestions: {},
          lastMessages: {},
          errorMessages: {},
          todoPhases: {},
          modelInfo: {},
        } satisfies WorkspaceAgentState,
      },
    });

    expect(snapshot.agentSessionsById['agent-1']?.state).toBe('waiting');
    expect(snapshot.workspacesById['demo:ws-1']?.summary.runningAgentCount).toBe(0);
    expect(snapshot.workspacesById['demo:ws-1']?.summary.waitingAgentCount).toBe(1);
  });
  it('marks an agent permission-needed when external permission or question state is present', () => {
    const snapshot = buildMachineSnapshot({
      snapshotNonce: 1,
      terminalSessions: [],
      workspaces: [makeWorkspace()],
      agentStateByWorkspaceId: {
        'demo:ws-1': {
          workspaceId: 'demo:ws-1',
          sessions: [{ id: 'agent-1', title: 'Agent 1' }],
          statuses: { 'agent-1': { type: 'busy' } },
          pendingPermissions: {
            'agent-1': [{
              id: 'perm-1',
              type: 'permission',
              sessionID: 'agent-1',
              messageID: 'msg-1',
              title: 'Confirm command',
              metadata: {},
              time: { created: Date.now() },
            }],
          },
          pendingQuestions: {
            'agent-1': [{
              id: 'question-1',
              sessionID: 'agent-1',
              questions: [{ question: 'Continue?', header: 'Question', options: [], custom: true }],
              tool: { messageID: 'msg-1', callID: 'call-1' },
            }],
          },
          lastMessages: {},
          errorMessages: {},
          todoPhases: {},
          modelInfo: {},
        } satisfies WorkspaceAgentState,
      },
    });

    expect(snapshot.agentSessionsById['agent-1']?.state).toBe('permission-needed');
    expect(snapshot.agentSessionsById['agent-1']?.pendingPermissionCount).toBe(1);
    expect(snapshot.agentSessionsById['agent-1']?.pendingQuestionCount).toBe(1);
    expect(snapshot.workspacesById['demo:ws-1']?.summary.permissionAgentCount).toBe(1);
    expect(snapshot.workspacesById['demo:ws-1']?.summary.runningAgentCount).toBe(0);
  });

  it('keeps PTY linkage per terminal when one PTY forks to a new Pi session', () => {
    const snapshot = buildMachineSnapshot({
      snapshotNonce: 1,
      terminalSessions: [
        makeAgentTerminalSession('pty-a', 'agent-old'),
        makeAgentTerminalSession('pty-b', 'agent-new'),
      ],
      workspaces: [makeWorkspace()],
      agentStateByWorkspaceId: {
        'demo:ws-1': {
          workspaceId: 'demo:ws-1',
          sessions: [
            { id: 'agent-old', title: 'Original session' },
            { id: 'agent-new', title: 'Forked session' },
          ],
          statuses: { 'agent-new': { type: 'busy' } },
          pendingPermissions: {},
          pendingQuestions: {},
          lastMessages: {},
          errorMessages: {},
          todoPhases: {},
          modelInfo: {},
        } satisfies WorkspaceAgentState,
      },
    });

    expect(snapshot.terminalSessionsById['pty-a']?.linkedAgentSessionId).toBe('agent-old');
    expect(snapshot.terminalSessionsById['pty-b']?.linkedAgentSessionId).toBe('agent-new');
    expect(snapshot.agentSessionsById['agent-old']?.linkedTerminalSessionId).toBe('pty-a');
    expect(snapshot.agentSessionsById['agent-new']?.linkedTerminalSessionId).toBe('pty-b');
    expect(snapshot.workspacesById['demo:ws-1']?.agentSessionIds).toEqual(['agent-old', 'agent-new']);
  });

});
