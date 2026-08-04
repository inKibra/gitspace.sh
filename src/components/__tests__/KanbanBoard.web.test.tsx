import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { buildChainConnector, buildVisibleChainConnectors, countConnectorCrossings, KanbanBoardWeb } from '../KanbanBoard.web.js';
import type { KanbanGoalItem, WorkspaceBoardGroup } from '../../app/shared/board/types.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

const plannedGoal = {
  id: 'demo:goal-ui',
  selectionKey: 'local:goal:demo:goal-ui',
  chainId: 'billing',
  chainTitle: 'Billing rollout',
  title: 'Billing UI',
  projectName: 'demo',
  phase: 'code' as const,
  plannedWorkspaceName: 'billing-ui',
  status: 'planned' as const,
  chainPosition: 2,
  chainLength: 3,
  previousWorkspaceName: 'billing-api',
  backendKey: 'local',
  machineLabel: 'local',
  isRemote: false,
};

const plannedGoalTwo = {
  ...plannedGoal,
  id: 'demo:goal-e2e',
  selectionKey: 'local:goal:demo:goal-e2e',
  title: 'Billing E2E',
  plannedWorkspaceName: 'billing-e2e',
  chainPosition: 3,
};

const secondChainGoal = {
  ...plannedGoal,
  id: 'demo:deploy-docs',
  selectionKey: 'local:goal:demo:deploy-docs',
  chainId: 'b',
  chainTitle: 'Deploy rollout',
  title: 'Deploy Docs',
  plannedWorkspaceName: 'deploy-docs',
  chainPosition: 1,
  chainLength: 1,
};

const workspaceLeadGoal = {
  ...plannedGoal,
  id: 'demo:goal-api',
  selectionKey: 'local:goal:demo:goal-api',
  title: 'Billing API',
  plannedWorkspaceName: 'billing-api',
  workspaceName: 'billing-api',
  status: 'workspace-backed' as const,
  chainPosition: 1,
};

const workspaceLead = {
  id: 'local:workspace:billing-api',
  selectionKey: 'local:workspace:billing-api',
  name: 'billing-api',
  path: '/tmp/billing-api',
  projectName: 'demo',
  branch: 'goal/billing-api',
  sessionCount: 0,
  agentCount: 0,
  pendingPermissionCount: 0,
  phase: 'code' as const,
  goal: workspaceLeadGoal,
  backendKey: 'local',
  machineLabel: 'local',
  isRemote: false,
  terminalSessionIds: [],
  agentSessionIds: [],
  processIds: [],
};



function makeGroups(): WorkspaceBoardGroup[] {
  return [
    { phase: 'plan', workspaces: [], plannedGoals: [plannedGoal] },
    { phase: 'code', workspaces: [], plannedGoals: [] },
    { phase: 'review', workspaces: [], plannedGoals: [] },
    { phase: 'ship', workspaces: [], plannedGoals: [] },
  ];
}

function makeOverlayGroups(): WorkspaceBoardGroup[] {
  return [
    { phase: 'plan', workspaces: [], plannedGoals: [plannedGoal, plannedGoalTwo] },
    { phase: 'code', workspaces: [], plannedGoals: [] },
    { phase: 'review', workspaces: [], plannedGoals: [] },
    { phase: 'ship', workspaces: [], plannedGoals: [] },
  ];
}

function makeWorkspaceLeadGroups(): WorkspaceBoardGroup[] {
  return [
    { phase: 'plan', workspaces: [], plannedGoals: [plannedGoal, plannedGoalTwo] },
    { phase: 'code', workspaces: [workspaceLead], plannedGoals: [] },
    { phase: 'review', workspaces: [], plannedGoals: [] },
    { phase: 'ship', workspaces: [], plannedGoals: [] },
  ];
}

describe('KanbanBoardWeb planned goals', () => {
  it('selects a planned goal from the card body without card-level create callouts', async () => {
    const onSelect = mock(() => undefined);

    const view = render(
      <KanbanBoardWeb
        groups={makeGroups()}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
        onSelectPlannedGoal={onSelect}
      />,
    );

    const plannedCards = Array.from(view.container.getElementsByTagName('*')).filter((element) => element.getAttribute('role') === 'button') as HTMLElement[];
    const plannedCard = plannedCards.find((element) => element.textContent?.includes('billing-ui')) as HTMLElement;
    expect(plannedCard).toBeTruthy();
    await act(async () => {
      fireEvent.click(plannedCard);
    });
    expect(onSelect).toHaveBeenCalledWith(plannedGoal);
    expect(view.container.textContent).not.toContain('create workspace');
    expect(view.container.textContent).not.toContain('planned');
    expect(view.container.textContent).not.toContain('prev billing-api');
    expect(view.container.textContent).not.toContain('not created');
  });

  it('stages chain reorder in overlay and saves on explicit action', async () => {
    // Typed parameter: an untyped `mock(() => undefined)` records calls as the
    // empty tuple, so reading `calls[0][0]` below is an index-out-of-range error.
    const onSave = mock((_goals: KanbanGoalItem[]) => undefined);
    const view = render(
      <KanbanBoardWeb
        groups={makeOverlayGroups()}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
        onSelectPlannedGoal={() => undefined}
        onSaveChainOrder={onSave}
      />,
    );

    const plannedCards = Array.from(view.container.getElementsByTagName('*')).filter((element) => element.getAttribute('role') === 'button') as HTMLElement[];
    const firstCard = plannedCards.find((element) => element.textContent?.includes('billing-ui')) as HTMLElement;
    await act(async () => {
      fireEvent.mouseEnter(firstCard);
    });
    expect(Array.from(view.container.getElementsByTagName('button')).some((button) => button.textContent?.includes('Save order'))).toBe(false);
    const chainButton = Array.from(firstCard.getElementsByTagName('button')).find((button) => button.getAttribute('title')?.includes('Rearrange chain order')) as HTMLButtonElement;
    expect(chainButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(chainButton);
    });
    const downButtons = Array.from(view.container.getElementsByTagName('button')).filter((button) => button.textContent === '↓');
    await act(async () => {
      fireEvent.click(downButtons[0] as HTMLButtonElement);
    });
    expect(onSave).not.toHaveBeenCalled();

    const saveButton = Array.from(view.container.getElementsByTagName('button')).find((button) => button.textContent?.includes('Save order')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const reordered = onSave.mock.calls[0][0];
    expect(reordered.map((goal) => goal.plannedWorkspaceName)).toEqual(['billing-e2e', 'billing-ui']);
  });

  it('renders aligned stack status without marking the goal blocked', () => {
    const view = render(
      <KanbanBoardWeb
        groups={[
          { phase: 'plan', workspaces: [], plannedGoals: [{ ...plannedGoal, stackStatus: 'aligned' }] },
          { phase: 'code', workspaces: [], plannedGoals: [] },
          { phase: 'review', workspaces: [], plannedGoals: [] },
          { phase: 'ship', workspaces: [], plannedGoals: [] },
        ]}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
      />,
    );

    expect(view.container.textContent).toContain('aligned');
    expect(view.container.textContent).not.toContain('blocked');
  });

  it('activates the full stack when hovering the lead workspace card', async () => {
    const view = render(
      <KanbanBoardWeb
        groups={makeWorkspaceLeadGroups()}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
      />,
    );
    const rectsByKey = new Map<string, Partial<DOMRect>>([
      ['local:goal:demo:goal-api', { left: 130, right: 230, top: 100, bottom: 180, width: 100, height: 80 }],
      ['local:goal:demo:goal-ui', { left: 10, right: 110, top: 190, bottom: 270, width: 100, height: 80 }],
      ['local:goal:demo:goal-e2e', { left: 10, right: 110, top: 290, bottom: 370, width: 100, height: 80 }],
    ]);
    const elementPrototype = window.HTMLElement.prototype;
    const originalRect = elementPrototype.getBoundingClientRect;
    elementPrototype.getBoundingClientRect = function getTestRect() {
      const key = this.getAttribute('data-goal-card-key');
      const rect = key ? rectsByKey.get(key) : null;
      return rect ? { x: rect.left ?? 0, y: rect.top ?? 0, ...rect, toJSON: () => rect } as DOMRect : originalRect.call(this);
    };

    try {
      const leadCard = Array.from(view.container.getElementsByTagName('*'))
        .find((element) => element.getAttribute('data-goal-card-key') && element.textContent?.includes('billing-api')) as HTMLElement;
      expect(leadCard).toBeTruthy();

      await act(async () => {
        fireEvent.mouseEnter(leadCard);
      });

      expect(view.container.getElementsByTagName('g')).toHaveLength(2);
      const polylines = Array.from(view.container.getElementsByTagName('polyline'));
      expect(polylines.some((polyline) => polyline.getAttribute('points') === '110,215.6 180,215.6 180,180')).toBe(true);
    } finally {
      elementPrototype.getBoundingClientRect = originalRect;
    }
  });

  it('surfaces chain evidence above the board when goals exist', () => {
    const view = render(
      <KanbanBoardWeb
        groups={makeOverlayGroups()}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
      />,
    );

    expect(view.container.textContent).toContain('Goal Chains');
    expect(view.container.textContent).toContain('Billing rollout');
  });

  it('keeps the chain badge visible at rest and numbers each position', () => {
    const view = render(
      <KanbanBoardWeb
        groups={makeGroups()}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
      />,
    );

    const chainHandle = Array.from(view.container.getElementsByTagName('*')).find((element) => element.getAttribute('data-chain-anchor') === 'true') as HTMLElement;
    expect(chainHandle).toBeTruthy();
    // The position lives in the title, never spelled out as card text.
    expect(chainHandle.getAttribute('title')).toBe('Goal chain position 2 of 3');
    expect(view.container.textContent).not.toContain('chain 2/3');

    // The badge no longer hides at rest: KanbanBoard.web.tsx chainHoverClass()
    // pins it to opacity-100 and dims the whole card instead. Hovering a
    // related card must not change the badge's own visibility.
    expect(chainHandle.className).toContain('opacity-100');

    const plannedCards = Array.from(view.container.getElementsByTagName('*')).filter((element) => element.getAttribute('role') === 'button') as HTMLElement[];
    const plannedCard = plannedCards.find((element) => element.textContent?.includes('billing-ui')) as HTMLElement;
    act(() => {
      fireEvent.mouseEnter(plannedCard);
    });
    expect(chainHandle.className).toContain('opacity-100');
    act(() => {
      fireEvent.mouseLeave(plannedCard);
    });
    expect(chainHandle.className).toContain('opacity-100');
  });


  it('sorts cards from the same lane by chain position', () => {
    const view = render(
      <KanbanBoardWeb
        groups={[
          { phase: 'plan', workspaces: [], plannedGoals: [plannedGoalTwo, plannedGoal] },
          { phase: 'code', workspaces: [], plannedGoals: [] },
          { phase: 'review', workspaces: [], plannedGoals: [] },
          { phase: 'ship', workspaces: [], plannedGoals: [] },
        ]}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
      />,
    );

    const cardNames = Array.from(view.container.getElementsByTagName('*'))
      .filter((element) => element.getAttribute('data-goal-card-key'))
      .map((element) => element.textContent ?? '');

    expect(cardNames[0]).toContain('billing-ui');
    expect(cardNames[1]).toContain('billing-e2e');
  });
  it('assigns deterministic colors per chain', () => {
    const view = render(
      <KanbanBoardWeb
        groups={[
          { phase: 'plan', workspaces: [], plannedGoals: [{ ...plannedGoal, chainId: 'a', chainTitle: 'Billing rollout' }, secondChainGoal] },
          { phase: 'code', workspaces: [], plannedGoals: [] },
          { phase: 'review', workspaces: [], plannedGoals: [] },
          { phase: 'ship', workspaces: [], plannedGoals: [] },
        ]}
        selectedWorkspaceId={null}
        onSelectWorkspace={() => undefined}
      />,
    );

    const chainButtons = Array.from(view.container.getElementsByTagName('button')).filter((button) => button.title.includes('Click to rearrange this chain'));
    expect(chainButtons).toHaveLength(2);
    expect(chainButtons[0]!.style.color).not.toBe(chainButtons[1]!.style.color);
    expect(chainButtons[0]!.title).toMatch(/\d+\./);
  });

  it('uses separate right-side in and out ports for same-lane connectors', () => {
    const connector = buildChainConnector(
      { left: 10, right: 110, top: 100, bottom: 180, width: 100, height: 80 },
      { left: 10, right: 110, top: 190, bottom: 270, width: 100, height: 80 },
    );

    expect(connector.from.x).toBe(110);
    expect(connector.to.x).toBe(110);
    expect(connector.from.y).toBe(125.6);
    expect(connector.to.y).toBe(244.4);
    expect(connector.from.y).not.toBe(connector.to.y);
    expect(connector.points).toBe('110,125.6 110,244.4');
  });

  it('lands left-to-right connectors on the nearest vertical middle port', () => {
    const connector = buildChainConnector(
      { left: 10, right: 110, top: 100, bottom: 180, width: 100, height: 80 },
      { left: 130, right: 230, top: 100, bottom: 180, width: 100, height: 80 },
    );

    expect(connector.from.x).toBe(110);
    expect(connector.to.x).toBe(180);
    expect(connector.from.y).toBe(125.6);
    expect(connector.to.y).toBe(100);
    expect(connector.points).toBe('110,125.6 180,125.6 180,100');

    const lowerConnector = buildChainConnector(
      { left: 10, right: 110, top: 300, bottom: 380, width: 100, height: 80 },
      { left: 130, right: 230, top: 100, bottom: 180, width: 100, height: 80 },
    );

    expect(lowerConnector.to.x).toBe(180);
    expect(lowerConnector.to.y).toBe(180);
    expect(lowerConnector.points).toBe('110,325.6 180,325.6 180,180');
  });

  it('renders visible connectors from descendants back toward the chain head', () => {
    const connectors = buildVisibleChainConnectors([
      { left: 130, right: 230, top: 100, bottom: 180, width: 100, height: 80 },
      { left: 10, right: 110, top: 190, bottom: 270, width: 100, height: 80 },
    ]);

    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.from.x).toBe(110);
    expect(connectors[0]!.from.y).toBe(215.6);
    expect(connectors[0]!.to.x).toBe(180);
    expect(connectors[0]!.to.y).toBe(180);
    expect(connectors[0]!.points).toBe('110,215.6 180,215.6 180,180');
  });


  it('rejects connector layouts with geometric crossings when routing mixed lanes', () => {
    const connectors = buildVisibleChainConnectors([
      { left: 130, right: 230, top: 100, bottom: 180, width: 100, height: 80 },
      { left: 10, right: 110, top: 330, bottom: 410, width: 100, height: 80 },
      { left: 10, right: 110, top: 430, bottom: 510, width: 100, height: 80 },
    ]);

    expect(connectors).toHaveLength(2);
    expect(countConnectorCrossings(connectors)).toBe(0);
  });
});
