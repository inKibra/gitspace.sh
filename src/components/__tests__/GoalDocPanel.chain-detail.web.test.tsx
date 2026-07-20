import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { GoalDocPanel, type GoalLike } from '../GoalDocPanel.web.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

/** Slim snapshot goal (ticket #42): `bodyMarkdown` is emptied by slimGoalDoc
 *  until `goal-detail` resolves. */
function slimGoal(overrides: Partial<GoalLike> & { id: string; chainPosition: number }): GoalLike {
  return {
    title: overrides.id,
    status: 'planned',
    doc: { bodyMarkdown: '', updatedAt: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  } as GoalLike;
}

describe('GoalDocPanel — chain goals owned by other workspaces', () => {
  const chain: GoalLike[] = [
    slimGoal({ id: 'own', chainPosition: 0, title: 'own goal' }),
    slimGoal({ id: 'other', chainPosition: 1, title: 'other workspace goal' }),
  ];

  it('shows a loading state (not "No goal doc yet") while detail is in flight', () => {
    const { container } = render(
      <GoalDocPanel goals={chain} currentGoalId="other" onSelectGoal={() => {}} docLoading />,
    );
    expect(container.textContent).toContain('Loading goal doc…');
    expect(container.textContent).not.toContain('No goal doc yet');
  });

  it('renders the fetched doc body once detail arrives for the other workspace goal', () => {
    const enriched = chain.map((g) =>
      g.id === 'other'
        ? { ...g, doc: { bodyMarkdown: '# Ship validation pass', updatedAt: '2026-07-01T00:00:00.000Z' } }
        : g,
    );
    const { container } = render(
      <GoalDocPanel goals={enriched} currentGoalId="other" onSelectGoal={() => {}} docLoading={false} />,
    );
    expect(container.textContent).toContain('Ship validation pass');
    expect(container.textContent).not.toContain('No goal doc yet');
    expect(container.textContent).not.toContain('Loading goal doc…');
  });

  it('still reports a genuinely unauthored doc when detail has loaded', () => {
    const { container } = render(
      <GoalDocPanel goals={chain} currentGoalId="other" onSelectGoal={() => {}} docLoading={false} />,
    );
    expect(container.textContent).toContain('No goal doc yet');
  });

  it('asks the parent to select another chain goal via the chain nav', () => {
    const selected: string[] = [];
    const { container } = render(
      <GoalDocPanel goals={chain} currentGoalId="own" onSelectGoal={(id) => selected.push(id)} />,
    );
    const navButtons = Array.from(container.getElementsByTagName('button')).filter((b) =>
      (b.textContent ?? '').includes('down') || (b.textContent ?? '').includes('›'),
    );
    expect(navButtons.length).toBeGreaterThan(0);
    fireEvent.click(navButtons[0]!);
    expect(selected).toContain('other');
  });
});
