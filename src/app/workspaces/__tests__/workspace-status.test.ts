import { describe, expect, it } from 'bun:test';

import { deriveWorkspacePrimaryColorFromMachineSummary, deriveWorkspaceStatusSummary } from '../workspace-status.js';
import type { WorkspaceStatusInput } from '../workspace-status.js';
import type { AgentSessionInfo, SessionInfo } from '../../../machine/api/list-types.js';

function makeWorkspace(overrides: Partial<WorkspaceStatusInput> = {}): WorkspaceStatusInput {
  return {
    id: 'proj:ws',
    processes: [
      {
        name: 'web',
        instances: 1,
      },
    ],
    ...overrides,
  };
}

describe('deriveWorkspaceStatusSummary', () => {
  it('prioritizes orange over all other workspace colors', () => {
    const workspace = makeWorkspace();
    const sessions: SessionInfo[] = [
      {
        id: 'sess-1',
        name: 'proj:ws:1',
        workspaceId: 'proj:ws',
        attached: true,
        createdAt: 1,
        exitCode: 2,
      },
    ];
    const agents: AgentSessionInfo[] = [
      {
        id: 'agent-1',
        workspaceId: 'proj:ws',
        title: 'Claude',
        pendingPermissionCount: 1,
        status: { type: 'busy' },
      },
    ];

    const summary = deriveWorkspaceStatusSummary(workspace, sessions, agents);

    expect(summary.primaryColor).toBe('orange');
    expect(summary.agents.orange).toBe(1);
    expect(summary.terminals.red).toBe(1);
  });

  it('elevates blue above red when agents are only waiting', () => {
    const workspace = makeWorkspace();
    const sessions: SessionInfo[] = [
      {
        id: 'sess-1',
        name: 'proj:ws:1',
        workspaceId: 'proj:ws',
        attached: false,
        createdAt: 1,
        processName: 'web',
        processInstance: 1,
        exitCode: 2,
      },
    ];
    const agents: AgentSessionInfo[] = [
      {
        id: 'agent-1',
        workspaceId: 'proj:ws',
        title: 'Claude',
        status: { type: 'idle' },
      },
    ];

    const summary = deriveWorkspaceStatusSummary(workspace, sessions, agents);

    expect(summary.primaryColor).toBe('blue');
    expect(summary.agents.blue).toBe(1);
    expect(summary.services.red).toBe(1);
  });

  it('marks retrying agents red', () => {
    const workspace = makeWorkspace();
    const summary = deriveWorkspaceStatusSummary(workspace, [], [
      {
        id: 'agent-1',
        workspaceId: 'proj:ws',
        title: 'Claude',
        status: { type: 'retry', attempt: 2, message: 'provider failed', next: Date.now() + 1000 },
      },
    ]);

    expect(summary.agents.red).toBe(1);
    expect(summary.primaryColor).toBe('red');
  });

  it('keeps a not-running (closed/dormant) agent grey, never red — even with a stale error', () => {
    // Red is reserved for a live, currently-erroring session. A session whose
    // worker is gone is returned to the dormant (closed) state; a lingering
    // error on it must not colour the workspace red.
    const workspace = makeWorkspace({ processes: [] });
    const summary = deriveWorkspaceStatusSummary(workspace, [], [
      {
        id: 'agent-1',
        workspaceId: 'proj:ws',
        title: 'Claude',
        closedAt: '2026-01-01T00:00:00.000Z',
        errorMessage: 'rate limit exceeded',
        status: { type: 'retry', attempt: 1, message: 'rate limit exceeded', next: Date.now() },
      },
    ]);

    expect(summary.agents.red).toBe(0);
    expect(summary.primaryColor).toBe('dim');
  });

  it('does not count managed process sessions as terminals', () => {
    const workspace = makeWorkspace();
    const sessions: SessionInfo[] = [
      {
        id: 'proc-1',
        name: 'proj:ws:web#1',
        workspaceId: 'proj:ws',
        attached: false,
        createdAt: 1,
        processName: 'web',
        processInstance: 1,
      },
      {
        id: 'shell-1',
        name: 'proj:ws:shell',
        workspaceId: 'proj:ws',
        attached: true,
        createdAt: 2,
      },
    ];

    const summary = deriveWorkspaceStatusSummary(workspace, sessions, []);

    expect(summary.services.green).toBe(1);
    expect(summary.terminals.green).toBe(1);
  });

  it('treats pending Pi questions as orange attention state', () => {
    const workspace = makeWorkspace();
    const summary = deriveWorkspaceStatusSummary(workspace, [], [
      {
        id: 'agent-1',
        workspaceId: 'proj:ws',
        title: 'Claude',
        pendingQuestionCount: 1,
        status: { type: 'idle' },
      },
    ]);

    expect(summary.agents.orange).toBe(1);
    expect(summary.primaryColor).toBe('orange');
  });

  it('greens a compacting agent (active work), like busy', () => {
    const workspace = makeWorkspace({ processes: [] });
    const summary = deriveWorkspaceStatusSummary(workspace, [], [
      { id: 'agent-1', workspaceId: 'proj:ws', title: 'Claude', status: { type: 'compacting' } },
    ]);

    expect(summary.agents.green).toBe(1);
    expect(summary.primaryColor).toBe('green');
  });

  it('shows green when any agent is busy even if another is idle', () => {
    const workspace = makeWorkspace();
    const summary = deriveWorkspaceStatusSummary(workspace, [], [
      { id: 'agent-busy', workspaceId: 'proj:ws', title: 'Busy', status: { type: 'busy' } },
      { id: 'agent-idle', workspaceId: 'proj:ws', title: 'Idle', status: { type: 'idle' } },
    ]);

    expect(summary.agents.green).toBe(1);
    expect(summary.agents.blue).toBe(1);
    expect(summary.primaryColor).toBe('green');
  });
  it('prefers idle agent blue over running service green', () => {
    const workspace = makeWorkspace();
    const sessions: SessionInfo[] = [
      {
        id: 'proc-1',
        name: 'proj:ws:web#1',
        workspaceId: 'proj:ws',
        attached: false,
        createdAt: 1,
        processName: 'web',
        processInstance: 1,
      },
    ];
    const summary = deriveWorkspaceStatusSummary(workspace, sessions, [
      { id: 'agent-idle', workspaceId: 'proj:ws', title: 'Idle', status: { type: 'idle' } },
    ]);

    expect(summary.services.green).toBe(1);
    expect(summary.agents.blue).toBe(1);
    expect(summary.primaryColor).toBe('blue');
  });

  it('keeps service-only and terminal-only activity dim', () => {
    const workspace = makeWorkspace();
    const serviceOnly = deriveWorkspaceStatusSummary(workspace, [
      {
        id: 'proc-1',
        name: 'proj:ws:web#1',
        workspaceId: 'proj:ws',
        attached: false,
        createdAt: 1,
        processName: 'web',
        processInstance: 1,
      },
    ], []);
    const terminalOnly = deriveWorkspaceStatusSummary(makeWorkspace({ processes: [] }), [
      {
        id: 'shell-1',
        name: 'proj:ws:shell',
        workspaceId: 'proj:ws',
        attached: true,
        createdAt: 1,
      },
    ], []);

    expect(serviceOnly.services.green).toBe(1);
    expect(serviceOnly.primaryColor).toBe('dim');
    expect(terminalOnly.terminals.green).toBe(1);
    expect(terminalOnly.primaryColor).toBe('dim');
  });

  it('prefers idle agent blue over running process in machine summary', () => {
    expect(deriveWorkspacePrimaryColorFromMachineSummary({
      permissionAgentCount: 0,
      retryingAgentCount: 0,
      failedProcessCount: 0,
      failedTerminalCount: 0,
      waitingAgentCount: 1,
      runningAgentCount: 0,
      runningProcessCount: 1,
    })).toBe('blue');
  });
  it('keeps running-process-only machine summary dim', () => {
    expect(deriveWorkspacePrimaryColorFromMachineSummary({
      permissionAgentCount: 0,
      retryingAgentCount: 0,
      failedProcessCount: 0,
      failedTerminalCount: 0,
      waitingAgentCount: 0,
      runningAgentCount: 0,
      runningProcessCount: 1,
    })).toBe('dim');
  });
});
