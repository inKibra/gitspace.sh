import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildMachineSnapshot, buildGoalRecordsForProject, buildAgentSessionRecordsForWorkspace, ARCHIVED_SNAPSHOT_LIMIT } from './build.js';
import { bindGoalToWorkspace, getGoalRecord, upsertGoalChain, writePlannedGoal } from '../../../core/goal-chain.js';
import { addRequirement, attachManualEvidence, defaultValidation, runGenerationCommand } from '../../../core/goal-validation.js';
import { upsertArchivedSession } from '../../../agents/agent-db.js';
import type { GoalValidation } from '../../../types/goals.js';
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
  it('caps an oversized snapshot below the reassembly ceiling by trimming heavy fields', () => {
    // A single session with ~30 MiB of queued text would push the snapshot past
    // the client's frame reassembly cap and kill the connection. The build must
    // shed it down under budget instead.
    const huge = 'x'.repeat(30 * 1024 * 1024);
    const snapshot = buildMachineSnapshot({
      snapshotNonce: 1,
      terminalSessions: [],
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
          queuedMessages: { 'agent-1': { steering: [huge], followUp: [] } },
        } satisfies WorkspaceAgentState,
      },
    });

    // Session still present (existence preserved), heavy text trimmed.
    expect(snapshot.agentSessionsById['agent-1']).toBeDefined();
    expect((snapshot.agentSessionsById['agent-1']?.queuedMessages?.steering[0]?.length ?? 0)).toBeLessThanOrEqual(200);
    expect(JSON.stringify(snapshot).length).toBeLessThan(128 * 1024 * 1024);
  });
  it('treats a compacting agent as running (active), so the board green-pulses it', () => {
    const snapshot = buildMachineSnapshot({
      snapshotNonce: 1,
      terminalSessions: [],
      workspaces: [makeWorkspace()],
      agentStateByWorkspaceId: {
        'demo:ws-1': {
          workspaceId: 'demo:ws-1',
          sessions: [{ id: 'agent-1', title: 'Agent 1' }],
          statuses: { 'agent-1': { type: 'compacting' } },
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

    expect(snapshot.agentSessionsById['agent-1']?.state).toBe('running');
    expect(snapshot.workspacesById['demo:ws-1']?.summary.runningAgentCount).toBe(1);
    expect(snapshot.workspacesById['demo:ws-1']?.summary.waitingAgentCount).toBe(0);
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

  it('slims the goal projection for the snapshot but keeps the full record for goal-detail (ticket #42)', () => {
    const root = join(tmpdir(), `machine-slim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const previousWorkspaceRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;

    try {
      mkdirSync(join(root, 'demo', 'workspaces'), { recursive: true });
      writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({
        name: 'demo', repository: 'owner/repo', baseBranch: 'main',
        createdAt: new Date(0).toISOString(), lastAccessed: new Date(0).toISOString(),
      }), 'utf-8');
      upsertGoalChain('demo', {
        id: 'billing', title: 'Billing', projectName: 'demo', goalIds: ['heavy'],
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      });

      // A goal fat with the fields that grow unbounded with machine uptime:
      // evidence output, review trails, and a timeline event log.
      const bigStdout = 'x'.repeat(40_000);
      const validation: GoalValidation = {
        reqOrder: ['req-1'],
        requirements: {
          'req-1': {
            id: 'req-1', title: 'Tests pass', kind: 'test-output', required: true,
            rubric: 'bun test is green', status: 'accepted',
            generation: { kind: 'command', command: 'bun test' },
            judgment: { kind: 'command', command: 'bun test', expect: { kind: 'exit-zero' } },
            evidence: [
              { id: 'ev-old', name: 'run 1', meta: 'cmd', source: 'command', createdAt: new Date(1000).toISOString(), command: 'bun test', stdout: bigStdout, stderr: bigStdout, exitCode: 0 },
              { id: 'ev-new', name: 'run 2', meta: 'cmd', source: 'command', createdAt: new Date(2000).toISOString(), command: 'bun test', stdout: bigStdout, stderr: bigStdout, exitCode: 0 },
            ],
            reviews: [
              { id: 'rv-1', tone: 'green', who: 'human', note: 'looks good', createdAt: new Date(3000).toISOString() },
            ],
          },
        },
        events: [
          { id: 'e1', requirementId: 'req-1', tone: 'green', kind: 'review', title: 'passed', body: 'ok', payload: 'p', createdAt: new Date(3000).toISOString() },
          { id: 'e2', requirementId: 'req-1', tone: 'blue', kind: 'contract', title: 'added', body: 'x', payload: 'p', createdAt: new Date(1000).toISOString() },
        ],
      };
      writePlannedGoal('demo', {
        version: 2, id: 'heavy', chainId: 'billing', title: 'Heavy goal', projectName: 'demo',
        phase: 'review', plannedWorkspaceName: 'heavy-ws',
        doc: { bodyMarkdown: '# Heavy\n\n'.repeat(500), updatedAt: new Date(0).toISOString(), blocks: [{ id: 'b1', type: 'intent', data: {} }] },
        validation,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      });

      const [slim] = buildGoalRecordsForProject('demo');
      const slimReq = slim.validation!.requirements['req-1'];

      // Board fallback inputs survive: status + readiness totals.
      expect(slimReq.status).toBe('accepted');
      expect(slim.validation!.readiness?.totals.total).toBe(1);
      expect(slim.validation!.readiness?.totals.accepted).toBe(1);

      // Unbounded-with-uptime content is dropped from the snapshot.
      expect(slim.validation!.events).toEqual([]);
      expect(slimReq.reviews).toEqual([]);
      // Evidence deduped to latest-per-command with heavy streams stripped.
      expect(slimReq.evidence).toHaveLength(1);
      expect(slimReq.evidence[0].id).toBe('ev-new');
      expect(slimReq.evidence[0].stdout).toBeUndefined();
      expect(slimReq.evidence[0].stderr).toBeUndefined();
      // Doc body + blocks dropped.
      expect(slim.doc!.bodyMarkdown).toBe('');
      expect(slim.doc!.blocks).toBeUndefined();

      // The measured payload shrinks by orders of magnitude.
      const slimBytes = JSON.stringify(slim).length;
      const fullRecord = getGoalRecord('demo', 'heavy')!;
      const fullBytes = JSON.stringify({ ...slim, doc: fullRecord.doc, validation: fullRecord.validation }).length;
      expect(slimBytes * 10).toBeLessThan(fullBytes);

      // goal-detail's source (goal store) still carries the full record.
      expect(fullRecord.validation.events).toHaveLength(2);
      expect(fullRecord.validation.requirements['req-1'].reviews).toHaveLength(1);
      expect(fullRecord.validation.requirements['req-1'].evidence[0].stdout).toBe(bigStdout);
      expect(fullRecord.doc.bodyMarkdown.length).toBeGreaterThan(1000);
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.GITSPACE_WORKSPACE_ROOT;
      } else {
        process.env.GITSPACE_WORKSPACE_ROOT = previousWorkspaceRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a not-running (dormant/closed) session as closed, never retrying — even with a stale error', () => {
    // A live worker that hit a retry surfaces as 'retrying' (the red-worthy
    // state): this is the current-error case that SHOULD show red.
    const liveRetry: WorkspaceAgentState = {
      workspaceId: 'demo:ws-1',
      sessions: [{ id: 's1', title: 'Claude' }],
      statuses: { s1: { type: 'retry', attempt: 2, message: 'rate limit', next: 0 } },
      pendingPermissions: {},
      pendingQuestions: {},
      lastMessages: {},
      errorMessages: {},
      todoPhases: {},
      modelInfo: {},
      queuedMessages: {},
    };
    const live = buildAgentSessionRecordsForWorkspace({
      workspaceId: 'demo:ws-1',
      projectId: 'demo',
      workspace: liveRetry,
      terminalSessionsById: {},
    });
    expect(live.records.find((r) => r.id === 's1')?.state).toBe('retrying');

    // Once the worker is gone, the coordinator returns the session to the
    // dormant state (closedAt set, transient status/error cleared). Even if a
    // stale error somehow lingered, a closed session must never read 'retrying'.
    const dormant: WorkspaceAgentState = {
      workspaceId: 'demo:ws-1',
      sessions: [{ id: 's1', title: 'Claude', closedAt: '2026-01-01T00:00:00.000Z' }],
      statuses: {},
      pendingPermissions: {},
      pendingQuestions: {},
      lastMessages: {},
      errorMessages: { s1: 'rate limit' },
      todoPhases: {},
      modelInfo: {},
      queuedMessages: {},
    };
    const closed = buildAgentSessionRecordsForWorkspace({
      workspaceId: 'demo:ws-1',
      projectId: 'demo',
      workspace: dormant,
      terminalSessionsById: {},
    });
    expect(closed.records.find((r) => r.id === 's1')?.state).toBe('closed');
  });

  it('caps inline archived agent sessions and reports archivedMoreCount (ticket #42)', () => {
    const root = join(tmpdir(), `machine-archived-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const previousWorkspaceRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;
    try {
      mkdirSync(root, { recursive: true });
      const workspaceId = 'demo:archive-heavy';
      const total = ARCHIVED_SNAPSHOT_LIMIT + 7;
      for (let i = 0; i < total; i++) {
        upsertArchivedSession({
          workspaceId,
          sessionId: `arch-${String(i).padStart(2, '0')}`,
          title: `Archived ${i}`,
          archivedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        });
      }

      const { records, archivedMoreCount } = buildAgentSessionRecordsForWorkspace({
        workspaceId,
        projectId: 'demo',
        workspace: undefined,
        terminalSessionsById: {},
      });

      const archivedRecords = records.filter((r) => r.state === 'archived');
      expect(archivedRecords).toHaveLength(ARCHIVED_SNAPSHOT_LIMIT);
      expect(archivedMoreCount).toBe(7);
      // Newest are the ones kept inline.
      expect(archivedRecords.some((r) => r.id === `arch-${String(total - 1).padStart(2, '0')}`)).toBe(true);
      expect(archivedRecords.some((r) => r.id === 'arch-00')).toBe(false);
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
