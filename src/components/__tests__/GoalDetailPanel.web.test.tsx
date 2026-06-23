import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { GoalDetailPanel } from '../GoalDetailPanel.web.js';
import type { KanbanGoalItem } from '../../app/shared/board/types.js';
import type { GoalValidation, Requirement } from '../../types/goals.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

function emptyValidation(): GoalValidation {
  return { reqOrder: [], requirements: {}, events: [] };
}

function requirement(overrides: Partial<Requirement> & { id: string; title: string }): Requirement {
  return {
    id: overrides.id,
    title: overrides.title,
    kind: overrides.kind ?? 'screenshot',
    required: overrides.required ?? true,
    rubric: overrides.rubric ?? 'Acceptance criteria.',
    status: overrides.status ?? 'missing',
    generation: overrides.generation ?? { kind: 'manual' },
    judgment: overrides.judgment ?? { kind: 'human' },
    evidence: overrides.evidence ?? [],
    reviews: overrides.reviews ?? [],
  };
}

function goal(overrides: Partial<KanbanGoalItem> = {}): KanbanGoalItem {
  return {
    id: 'demo:api',
    selectionKey: 'local:goal:demo:api',
    chainId: 'billing',
    chainTitle: 'Billing rollout',
    title: 'Billing API',
    projectName: 'demo',
    phase: 'code',
    plannedWorkspaceName: 'billing-api',
    workspaceName: 'billing-api',
    status: 'workspace-backed',
    chainPosition: 1,
    chainLength: 1,
    backendKey: 'local',
    machineLabel: 'local',
    isRemote: false,
    doc: { bodyMarkdown: '# Billing API\n\n## Objective\n\nShip the API.', updatedAt: new Date(0).toISOString() },
    validation: emptyValidation(),
    ...overrides,
  };
}

function renderPanel(active: KanbanGoalItem, overrides: Partial<React.ComponentProps<typeof GoalDetailPanel>> = {}) {
  return render(
    <GoalDetailPanel
      goal={active}
      chainGoals={[active]}
      onClose={() => undefined}
      onSaveDoc={() => undefined}
      onCreateWorkspace={() => undefined}
      onSaveChainOrder={() => undefined}
      onRefreshStackStatus={() => undefined}
      onAddRequirement={() => undefined}
      onUpdateRequirement={() => undefined}
      onRemoveRequirement={() => undefined}
      onReorderRequirement={() => undefined}
      onReopenRequirement={() => undefined}
      onAttachEvidence={() => undefined}
      onRunGeneration={() => undefined}
      onRunJudgment={() => undefined}
      onRecordHumanReview={() => undefined}
      {...overrides}
    />,
  );
}

function clickByText(view: ReturnType<typeof render>, text: string) {
  const button = Array.from(view.container.getElementsByTagName('button')).find((b) => {
    const t = (b.textContent ?? '').trim();
    return t === text || t.startsWith(text);
  });
  if (!button) throw new Error(`Button not found: ${text}`);
  fireEvent.click(button);
}

describe('GoalDetailPanel', () => {
  it('renders the readiness summary in plain language and the goal title', () => {
    const view = renderPanel(goal({
      validation: {
        reqOrder: ['r1'],
        requirements: { r1: requirement({ id: 'r1', title: 'Hover screenshot' }) },
        events: [],
      },
    }));
    expect(view.container.textContent).toContain('Billing API');
    expect(view.container.textContent).toContain('1 required artifact missing.');
    expect(view.container.textContent).toContain('At a glance');
    expect(view.container.textContent).toContain('Hover screenshot');
  });

  it('renders the goal doc tab with rendered markdown by default', () => {
    const view = renderPanel(goal());
    act(() => clickByText(view, 'Goal doc'));
    expect(view.container.innerHTML).toMatch(/<h1[^>]*>Billing API<\/h1>/);
    expect(view.container.textContent).toContain('Ship the API.');
  });

  it('toggles to split mode showing both editor and preview', () => {
    const view = renderPanel(goal());
    act(() => clickByText(view, 'Goal doc'));
    act(() => clickByText(view, 'split'));
    expect(view.container.getElementsByTagName('textarea').length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain('Ship the API.');
  });

  it('exposes preview/edit/split toggles and save/discard on the doc tab', () => {
    const view = renderPanel(goal());
    act(() => clickByText(view, 'Goal doc'));
    const buttons = Array.from(view.container.getElementsByTagName('button')).map((b) => b.textContent?.trim() ?? '');
    expect(buttons).toContain('preview');
    expect(buttons).toContain('edit');
    expect(buttons).toContain('split');
    expect(buttons).toContain('Save');
    expect(buttons).toContain('Discard');
  });

  it('shows the add-requirement empty state and CTA', () => {
    const view = renderPanel(goal());
    act(() => clickByText(view, 'Requirements'));
    expect(view.container.textContent).toContain('No requirements yet');
    expect(view.container.textContent).toContain('Add the first requirement');
  });

  it('renders requirement detail with the right evidence affordance for command generation', () => {
    const view = renderPanel(goal({
      validation: {
        reqOrder: ['r1'],
        requirements: {
          r1: requirement({
            id: 'r1',
            title: 'Focused tests',
            kind: 'test-output',
            generation: { kind: 'command', command: 'bun test foo.test.ts' },
            judgment: { kind: 'command', command: 'bun test foo.test.ts', expect: { kind: 'exit-zero' } },
          }),
        },
        events: [],
      },
    }));
    act(() => clickByText(view, 'Requirements'));
    expect(view.container.textContent).toContain('Run command to produce evidence');
    expect(view.container.textContent).toContain('bun test foo.test.ts');
  });

  it('renders the human review action only for human-judged requirements in review state', () => {
    const view = renderPanel(goal({
      validation: {
        reqOrder: ['r1'],
        requirements: {
          r1: requirement({
            id: 'r1',
            title: 'Hover',
            status: 'review',
            evidence: [{ id: 'ev', name: 'shot', meta: 'manual', source: 'manual', createdAt: new Date(0).toISOString() }],
          }),
        },
        events: [],
      },
    }));
    act(() => clickByText(view, 'Requirements'));
    expect(view.container.textContent).toContain('Pass');
    expect(view.container.textContent).toContain('Fail');
    expect(view.container.textContent).toContain('Needs changes');
  });

  it('blocks fail/changes without a note', async () => {
    const onRecordHumanReview = mock(() => undefined);
    const view = renderPanel(goal({
      validation: {
        reqOrder: ['r1'],
        requirements: {
          r1: requirement({
            id: 'r1',
            title: 'Hover',
            status: 'review',
            evidence: [{ id: 'ev', name: 'shot', meta: 'manual', source: 'manual', createdAt: new Date(0).toISOString() }],
          }),
        },
        events: [],
      },
    }), { onRecordHumanReview });
    act(() => clickByText(view, 'Requirements'));
    await act(async () => clickByText(view, 'Fail'));
    expect(onRecordHumanReview).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('A note is required');
  });

  it('shows the timeline events with their tones', () => {
    const view = renderPanel(goal({
      validation: {
        reqOrder: ['r1'],
        requirements: { r1: requirement({ id: 'r1', title: 'Hover', status: 'accepted' }) },
        events: [
          { id: 'e1', requirementId: 'r1', tone: 'blue', kind: 'contract', title: 'Requirement added', body: 'gen+judge', payload: 'p', createdAt: new Date(0).toISOString() },
          { id: 'e2', requirementId: 'r1', tone: 'green', kind: 'review', title: 'Review passed', body: 'ok', payload: 'p', createdAt: new Date(0).toISOString() },
        ],
      },
    }));
    act(() => clickByText(view, 'Timeline'));
    expect(view.container.textContent).toContain('Requirement added');
    expect(view.container.textContent).toContain('Review passed');
  });

  it('does not render legacy "Save review" / "needs evidence" copy', () => {
    const view = renderPanel(goal());
    expect(view.container.textContent).not.toContain('Save review');
    expect(view.container.textContent).not.toContain('Save judgment');
    expect(view.container.textContent).not.toContain('Validation contract');
  });
});
