import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildMachineSnapshot } from './build.js';
import { bindGoalToWorkspace, upsertGoalChain, writePlannedGoal } from '../../../core/goal-chain.js';
import { addRequirement, attachManualEvidence, defaultValidation, runGenerationCommand } from '../../../core/goal-validation.js';
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
          queuedMessages: {},
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
          queuedMessages: {},
        } satisfies WorkspaceAgentState,
      },
    });

    expect(snapshot.agentSessionsById['agent-1']?.state).toBe('permission-needed');
    expect(snapshot.agentSessionsById['agent-1']?.pendingPermissionCount).toBe(1);
    expect(snapshot.agentSessionsById['agent-1']?.pendingQuestionCount).toBe(1);
    expect(snapshot.workspacesById['demo:ws-1']?.summary.permissionAgentCount).toBe(1);
    expect(snapshot.workspacesById['demo:ws-1']?.summary.runningAgentCount).toBe(0);
  });

  it('projects SDK queued steering and follow-up messages into the machine snapshot', () => {
    const snapshot = buildMachineSnapshot({
      snapshotNonce: 1,
      terminalSessions: [],
      workspaces: [makeWorkspace()],
      agentStateByWorkspaceId: {
        'demo:ws-1': {
          workspaceId: 'demo:ws-1',
          sessions: [{ id: 'agent-1', title: 'Agent 1' }],
          statuses: { 'agent-1': { type: 'busy' } },
          pendingPermissions: {},
          pendingQuestions: {},
          lastMessages: {},
          errorMessages: {},
          todoPhases: {},
          modelInfo: {},
          queuedMessages: {
            'agent-1': {
              steering: ['tighten the scope'],
              followUp: ['summarize the result'],
            },
          },
        } satisfies WorkspaceAgentState,
      },
    });

    expect(snapshot.agentSessionsById['agent-1']?.queuedMessages).toEqual({
      steering: ['tighten the scope'],
      followUp: ['summarize the result'],
    });
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
          queuedMessages: {},
        } satisfies WorkspaceAgentState,
      },
    });

    expect(snapshot.terminalSessionsById['pty-a']?.linkedAgentSessionId).toBe('agent-old');
    expect(snapshot.terminalSessionsById['pty-b']?.linkedAgentSessionId).toBe('agent-new');
    expect(snapshot.agentSessionsById['agent-old']?.linkedTerminalSessionId).toBe('pty-a');
    expect(snapshot.agentSessionsById['agent-new']?.linkedTerminalSessionId).toBe('pty-b');
    expect(snapshot.workspacesById['demo:ws-1']?.agentSessionIds).toEqual(['agent-old', 'agent-new']);
  });

  it('projects planned and workspace-backed goals into the machine snapshot', () => {
    const root = join(tmpdir(), `machine-goals-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const previousWorkspaceRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;

    try {
      mkdirSync(join(root, 'demo', 'workspaces', 'ws-1'), { recursive: true });
      writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({
        name: 'demo',
        repository: 'owner/repo',
        baseBranch: 'main',
        createdAt: new Date(0).toISOString(),
        lastAccessed: new Date(0).toISOString(),
      }), 'utf-8');
      upsertGoalChain('demo', {
        id: 'billing',
        title: 'Billing rollout',
        projectName: 'demo',
        goalIds: ['schema', 'api'],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      writePlannedGoal('demo', {
        version: 2,
        id: 'schema',
        chainId: 'billing',
        title: 'Schema goal',
        projectName: 'demo',
        phase: 'plan',
        plannedWorkspaceName: 'ws-1',
        doc: { bodyMarkdown: '# Schema', updatedAt: new Date(0).toISOString() },
        validation: defaultValidation(),
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      const apiValidation = addRequirement(defaultValidation(), {
        title: 'Planned URL',
        kind: 'url',
        rubric: 'Reference URL must resolve.',
        generation: { kind: 'manual' },
        judgment: { kind: 'human' },
      });
      const plannedGoal = writePlannedGoal('demo', {
        version: 2,
        id: 'api',
        chainId: 'billing',
        title: 'API goal',
        projectName: 'demo',
        phase: 'code',
        plannedWorkspaceName: 'ws-2',
        doc: { bodyMarkdown: '# API', updatedAt: new Date(0).toISOString() },
        validation: apiValidation.validation,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      const apiAttached = attachManualEvidence('demo', plannedGoal, apiValidation.requirement.id, {
        url: 'http://localhost:5173/planned-artifact',
        name: 'Planned URL',
      });
      writePlannedGoal('demo', { ...plannedGoal, validation: apiAttached.goal.validation });
      bindGoalToWorkspace('demo', 'schema', 'ws-1');

      const snapshot = buildMachineSnapshot({
        snapshotNonce: 1,
        terminalSessions: [],
        workspaces: [makeWorkspace()],
        agentStateByWorkspaceId: {},
      });

      expect(snapshot.workspacesById['demo:ws-1']?.goal?.id).toBe('demo:schema');
      expect(snapshot.workspacesById['demo:ws-1']?.phase).toBe('plan');
      expect(snapshot.goalsById?.['demo:api']?.status).toBe('planned');
      expect(snapshot.goalIdsByProjectId?.demo).toEqual(['demo:schema', 'demo:api']);
      const apiGoal = snapshot.goalsById?.['demo:api'];
      const apiReq = apiGoal?.validation?.requirements[apiValidation.requirement.id];
      expect(apiReq?.evidence?.[0]).toMatchObject({ name: 'Planned URL', url: 'http://localhost:5173/planned-artifact' });
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.GITSPACE_WORKSPACE_ROOT;
      } else {
        process.env.GITSPACE_WORKSPACE_ROOT = previousWorkspaceRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

});
