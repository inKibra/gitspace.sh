import { describe, expect, it } from 'bun:test';

import { deriveWorkspaceStatusSummary } from '../workspace-status.js';
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
});
