/**
 * A chain node's dot must report its workspace's STATUS, not the mere fact that
 * a workspace exists.
 *
 * Before this, `chainNodesFromGoals` marked every workspace-backed goal 'active'
 * and the rail drew 'active' in accent green. So green meant only "this goal has
 * a workspace" — while the same workspace could be showing red or amber in the
 * strip two panels away. Two surfaces, one workspace, disagreeing colours.
 */
import { describe, expect, it } from 'bun:test';
import { chainNodesFromGoals } from '../WorkspaceSidebarChrome.web.js';
import type { KanbanGoalItem } from '../../app/shared/board/types.js';
import type { WorkspaceStatusColor } from '../../app/workspaces/workspace-status.js';

function goal(over: Partial<KanbanGoalItem> & { id: string; chainPosition: number }): KanbanGoalItem {
  return {
    selectionKey: `core:${over.id}`,
    chainId: 'chain-1',
    chainTitle: 'Chain',
    title: over.id,
    projectName: 'core',
    phase: 'code',
    status: 'workspace-backed',
    chainLength: 3,
    backendKey: 'local',
    machineLabel: 'this machine',
    isRemote: false,
    ...over,
  };
}

describe('chainNodesFromGoals status colour', () => {
  it('carries the workspace status colour for a workspace-backed goal', () => {
    const goals = [goal({ id: 'g1', chainPosition: 1, workspaceName: 'ws-red' })];
    const nodes = chainNodesFromGoals(goals, 'other-ws', () => ({ selectionKey: '["local","ws-red"]', statusColor: 'red' }));
    expect(nodes[0]?.statusColor).toBe('red');
  });

  it('reports each node\'s own status rather than one colour for all', () => {
    const goals = [
      goal({ id: 'g1', chainPosition: 1, workspaceName: 'ws-a' }),
      goal({ id: 'g2', chainPosition: 2, workspaceName: 'ws-b' }),
      goal({ id: 'g3', chainPosition: 3, workspaceName: 'ws-c' }),
    ];
    const byWorkspace: Record<string, WorkspaceStatusColor> = { 'ws-a': 'orange', 'ws-b': 'blue', 'ws-c': 'dim' };
    const nodes = chainNodesFromGoals(goals, 'nope', (g) => ({
      selectionKey: `["local","${g.workspaceName}"]`,
      statusColor: byWorkspace[g.workspaceName ?? ''] ?? 'dim',
    }));
    expect(nodes.map((n) => n.statusColor)).toEqual(['orange', 'blue', 'dim']);
  });

  it('leaves a goal with no workspace colourless — it has no status to report', () => {
    const goals = [goal({ id: 'planned', chainPosition: 1, status: 'planned', workspaceName: undefined })];
    const nodes = chainNodesFromGoals(goals, 'other', () => ({ selectionKey: '["local","x"]', statusColor: 'green' }));
    expect(nodes[0]?.statusColor).toBeUndefined();
    expect(nodes[0]?.status).toBe('planned');
  });

  it('does not invent a colour when no resolver is supplied', () => {
    const goals = [goal({ id: 'g1', chainPosition: 1, workspaceName: 'ws-a' })];
    expect(chainNodesFromGoals(goals, 'other')[0]?.statusColor).toBeUndefined();
  });

  it('still marks the current goal as active for its own emphasis', () => {
    const goals = [goal({ id: 'g1', chainPosition: 1, workspaceName: 'mine' })];
    const nodes = chainNodesFromGoals(goals, 'mine', () => ({ selectionKey: '["local","mine"]', statusColor: 'green' }));
    expect(nodes[0]?.status).toBe('active');
    // The current node is not navigable — you are already there.
    expect(nodes[0]?.workspaceSelectionKey).toBeUndefined();
  });
});
