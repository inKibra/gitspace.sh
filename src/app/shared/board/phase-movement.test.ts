import { describe, expect, it } from 'bun:test';
import { getShiftArrowPhaseChange } from './phase-movement.js';
import type { WorkspaceBoardGroup } from './types.js';

const groups: WorkspaceBoardGroup[] = [
  {
    phase: 'plan',
    workspaces: [
      {
        id: 'proj:alpha',
        selectionKey: '["local","proj:alpha"]',
        name: 'alpha',
        path: '/tmp/proj/alpha',
        projectName: 'proj',
        sessionCount: 0,
        agentCount: 0,
        pendingPermissionCount: 0,
        phase: 'plan',
        backendKey: 'local',
        machineLabel: 'Local',
        isRemote: false,
      },
    ],
  },
  {
    phase: 'code',
    workspaces: [
      {
        id: 'proj:beta',
        selectionKey: '["local","proj:beta"]',
        name: 'beta',
        path: '/tmp/proj/beta',
        projectName: 'proj',
        sessionCount: 0,
        agentCount: 0,
        pendingPermissionCount: 0,
        phase: 'code',
        backendKey: 'local',
        machineLabel: 'Local',
        isRemote: false,
      },
    ],
  },
  { phase: 'review', workspaces: [] },
  { phase: 'ship', workspaces: [] },
];

describe('getShiftArrowPhaseChange', () => {
  it('moves the selected workspace right to the next phase', () => {
    expect(getShiftArrowPhaseChange({
      groups,
      selectedWorkspaceId: '["local","proj:alpha"]',
      direction: 1,
    })).toEqual({
      workspaceKey: '["local","proj:alpha"]',
      phase: 'code',
    });
  });

  it('moves the selected workspace left to the previous phase', () => {
    expect(getShiftArrowPhaseChange({
      groups,
      selectedWorkspaceId: '["local","proj:beta"]',
      direction: -1,
    })).toEqual({
      workspaceKey: '["local","proj:beta"]',
      phase: 'plan',
    });
  });

  it('returns null at lane boundaries', () => {
    expect(getShiftArrowPhaseChange({
      groups,
      selectedWorkspaceId: '["local","proj:alpha"]',
      direction: -1,
    })).toBeNull();
  });
});
