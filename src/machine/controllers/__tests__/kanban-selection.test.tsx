/**
 * The board selector's deselect contract.
 *
 * `setSelectedWorkspaceId` used to call `onSelectRef(null)` whenever a key failed
 * to resolve. That turned every failed navigation into an eviction: a chain click
 * carrying an unresolvable key did not merely fail, it threw you out of the
 * workspace you were reading. That is what made chain navigation look flaky
 * instead of broken.
 *
 * Only an explicit `null` deselects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { useKanbanViewController } from '../useKanbanViewController.js';
import { toBackendScopedWorkspaceKey } from '../../multi/types.js';
import type { BackendScopedWorkspaceRef, MultiMachineState } from '../../multi/types.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

/** A snapshot with a single local workspace, shaped as the selectors read it. */
function stateWithWorkspace(): MultiMachineState {
  const workspace = {
    id: 'ws-1',
    name: 'billing-api',
    path: '/tmp/ws-1',
    projectName: 'proj',
    branch: 'main',
    phase: 'code',
    summary: { terminalCount: 0, agentCount: 0, permissionAgentCount: 0 },
    isStale: false,
    processes: [],
  };
  return {
    backendOrder: ['local'],
    byBackend: {
      local: {
        label: 'local',
        snapshot: {
          projectOrder: ['proj'],
          projectsById: { proj: { id: 'proj', name: 'proj' } },
          workspaceOrder: ['ws-1'],
          workspacesById: { 'ws-1': workspace },
          goalsById: {},
          goalOrder: [],
        },
      },
    },
  } as unknown as MultiMachineState;
}

function harness() {
  const calls: (BackendScopedWorkspaceRef | null)[] = [];
  const view = renderHook(() =>
    useKanbanViewController({
      state: stateWithWorkspace(),
      selectedRef: { backendKey: 'local', workspaceId: 'ws-1' },
      onSelectRef: (ref) => calls.push(ref),
    }),
  );
  return { calls, view };
}

describe('kanban selection', () => {
  it('selects the workspace a resolvable key names', () => {
    const { calls, view } = harness();
    act(() => view.result.current.setSelectedWorkspaceId(toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'ws-1' })));
    expect(calls).toEqual([{ backendKey: 'local', workspaceId: 'ws-1' }]);
  });

  it('does NOT deselect when a key resolves to nothing', () => {
    const { calls, view } = harness();
    // Exactly the old chain-click payload: a goal key, not a workspace key.
    act(() => view.result.current.setSelectedWorkspaceId('local:goal:g1'));
    expect(calls).toEqual([]);
  });

  it('deselects only on an explicit null', () => {
    const { calls, view } = harness();
    act(() => view.result.current.setSelectedWorkspaceId(null));
    expect(calls).toEqual([null]);
  });
});
