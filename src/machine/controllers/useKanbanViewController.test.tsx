import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { useKanbanViewController } from './useKanbanViewController.js';
import type { MultiMachineState } from '../multi/types.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

describe('useKanbanViewController', () => {
  it('keeps planned goals in the plan lane regardless of goal phase', () => {
    const state: MultiMachineState = {
      activeBackendKey: 'local',
      backendOrder: ['local'],
      byBackend: {
        local: {
          status: 'connected',
          label: 'local',
          workspaces: [],
          snapshot: {
            machine: { id: 'machine-1', label: 'local' },
            projectsById: {},
            projectOrder: [],
            workspacesById: {},
            workspaceOrder: [],
            sessionsById: {},
            sessionOrder: [],
            agentsById: {},
            agentOrder: [],
            processesById: {},
            processOrder: [],
            replaysById: {},
            replayOrder: [],
            goalsById: {
              'demo:ui': {
                id: 'demo:ui',
                chainId: 'billing',
                chainTitle: 'Billing rollout',
                title: 'Billing UI',
                projectName: 'demo',
                phase: 'code',
                plannedWorkspaceName: 'billing-ui',
                status: 'planned',
                chainPosition: 2,
                chainLength: 3,
                validation: {
                  reqOrder: ['req-note'],
                  requirements: {
                    'req-note': {
                      id: 'req-note',
                      title: 'UI review note',
                      kind: 'note',
                      required: true,
                      rubric: 'Planned artifact propagates to the board.',
                      status: 'review',
                      generation: { kind: 'manual' },
                      judgment: { kind: 'human' },
                      evidence: [{ id: 'ev-1', name: 'UI review note', meta: 'inline note', source: 'manual', createdAt: new Date(0).toISOString() }],
                      reviews: [],
                    },
                  },
                  events: [],
                },
              },
            },
            goalOrder: ['demo:ui'],
            goalIdsByProjectId: { demo: ['demo:ui'] },
            goalByWorkspace: {},
          },
        },
      },
    } as unknown as MultiMachineState;

    const { result } = renderHook(() => useKanbanViewController({
      state,
      selectedRef: null,
      onSelectRef: mock(() => undefined),
    }));

    expect(result.current.groups.find((group) => group.phase === 'plan')?.plannedGoals).toHaveLength(1);
    expect(result.current.groups.find((group) => group.phase === 'code')?.plannedGoals).toHaveLength(0);
    expect(result.current.groups.find((group) => group.phase === 'plan')?.plannedGoals?.[0]?.validation?.requirements['req-note']?.title).toBe('UI review note');
  });
});
