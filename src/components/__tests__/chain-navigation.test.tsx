/**
 * Chain navigation: clicking a chain node must land on that node's workspace.
 *
 * It didn't. A chain node carried the GOAL's selection key (`local:goal:<id>`) in
 * `workspaceSelectionKey`, while a workspace's key is a backend-scoped JSON pair
 * (`["local","<workspaceId>"]`). The two formats can never match, so every click
 * resolved to no workspace — and the board selector treated "no match" as
 * "deselect", so the click ejected you instead of doing nothing.
 *
 * Same bug class as the chain dots, one layer over: the goal key was used where a
 * workspace key was required.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { ChainStack, chainNodesFromGoals } from '../WorkspaceSidebarChrome.web.js';
import { toBackendScopedWorkspaceKey } from '../../machine/multi/types.js';
import type { KanbanGoalItem } from '../../app/shared/board/types.js';

function goal(over: Partial<KanbanGoalItem>): KanbanGoalItem {
  return {
    id: 'g',
    selectionKey: `local:goal:${over.id ?? 'g'}`,
    chainId: 'c',
    chainTitle: 'Chain',
    title: 'Goal',
    projectName: 'proj',
    phase: 'code',
    status: 'workspace-backed',
    chainPosition: 1,
    chainLength: 1,
    backendKey: 'local',
    machineLabel: 'local',
    isRemote: false,
    ...over,
  };
}

describe('chain node navigation key', () => {
  it('carries the WORKSPACE key, not the goal key', () => {
    const wsKey = toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'ws-1' });
    const nodes = chainNodesFromGoals([goal({ id: 'g1', workspaceName: 'billing-api' })], 'other', () => ({
      selectionKey: wsKey,
      statusColor: 'green',
    }));
    expect(nodes[0]?.workspaceSelectionKey).toBe(wsKey);
    // The regression itself: a goal key here is unresolvable downstream.
    expect(nodes[0]?.workspaceSelectionKey).not.toBe('local:goal:g1');
  });

  it('is not navigable when the goal has no workspace to go to', () => {
    const nodes = chainNodesFromGoals([goal({ id: 'p', status: 'planned', workspaceName: undefined })], 'other', () => undefined);
    expect(nodes[0]?.workspaceSelectionKey).toBeUndefined();
  });

  it('is not navigable when the workspace cannot be resolved', () => {
    // A goal naming a workspace this client cannot see (other backend, filtered
    // out) must not produce a key that would deselect the current workspace.
    const nodes = chainNodesFromGoals([goal({ id: 'g1', workspaceName: 'gone' })], 'other', () => undefined);
    expect(nodes[0]?.workspaceSelectionKey).toBeUndefined();
  });

  it('never marks the current node navigable — you are already there', () => {
    const nodes = chainNodesFromGoals([goal({ id: 'g1', workspaceName: 'mine' })], 'mine', () => ({
      selectionKey: toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'ws-mine' }),
      statusColor: 'green',
    }));
    expect(nodes[0]?.workspaceSelectionKey).toBeUndefined();
  });

  it('resolves key and status from ONE lookup so they cannot disagree', () => {
    const nodes = chainNodesFromGoals(
      [goal({ id: 'a', chainPosition: 1, workspaceName: 'ws-a' }), goal({ id: 'b', chainPosition: 2, workspaceName: 'ws-b' })],
      'other',
      (g) => ({
        selectionKey: toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: `id-${g.workspaceName}` }),
        statusColor: g.workspaceName === 'ws-a' ? 'red' : 'blue',
      }),
    );
    expect(nodes.map((n) => n.statusColor)).toEqual(['red', 'blue']);
    expect(nodes.map((n) => n.workspaceSelectionKey)).toEqual([
      toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'id-ws-a' }),
      toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'id-ws-b' }),
    ]);
  });
});


describe('chain node click', () => {
  beforeAll(() => setupTestDom());
  afterAll(() => teardownTestDom());

  const wsKey = toBackendScopedWorkspaceKey({ backendKey: 'local', workspaceId: 'ws-2' });

  /** Row order: [0] current, [1] workspace-backed elsewhere, [2] planned. */
  function renderChain(onSwitchWorkspace: (key: string) => void, onOpenGoal: (id: string) => void) {
    const nodes = chainNodesFromGoals(
      [
        goal({ id: 'here', chainPosition: 1, title: 'Here', workspaceName: 'mine' }),
        goal({ id: 'other', chainPosition: 2, title: 'Other', workspaceName: 'billing-api' }),
        goal({ id: 'planned', chainPosition: 3, title: 'Planned', status: 'planned', workspaceName: undefined }),
      ],
      'mine',
      (g) => (g.workspaceName === 'billing-api' ? { selectionKey: wsKey, statusColor: 'green' } : undefined),
    );
    const { container } = render(
      <ChainStack title="Chain" nodes={nodes} currentGoalId="here" onSwitchWorkspace={onSwitchWorkspace} onOpenGoal={onOpenGoal} />,
    );
    // The clickable row is the node container two levels above its title.
    return (title: string) => {
      const label = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === title);
      if (!label) throw new Error(`no chain node titled ${title}`);
      return label.parentElement!.parentElement!;
    };
  }

  it('navigates with the workspace key when the node has a workspace', () => {
    const switched: string[] = [];
    const rowFor = renderChain((key) => switched.push(key), () => undefined);
    // Through the DOM, so the `navigable` gate is exercised, not just the key.
    fireEvent.click(rowFor('Other'));
    expect(switched).toEqual([wsKey]);
  });

  it('opens the goal instead when there is no workspace to switch to', () => {
    const switched: string[] = [];
    const opened: string[] = [];
    const rowFor = renderChain((key) => switched.push(key), (id) => opened.push(id));
    fireEvent.click(rowFor('Planned'));
    expect(switched).toEqual([]);
    expect(opened).toEqual(['planned']);
  });

  it('does nothing when you click the node you are already on', () => {
    const switched: string[] = [];
    const opened: string[] = [];
    const rowFor = renderChain((key) => switched.push(key), (id) => opened.push(id));
    fireEvent.click(rowFor('Here'));
    expect(switched).toEqual([]);
    expect(opened).toEqual([]);
  });
});