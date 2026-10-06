// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectCronView, ProjectCronRunView } from '@gitspace/protocol/cron-contract';
import { formatProjectCronTime, ProjectCronsPage } from './ProjectCronsPage.js';

function cronFixture(): ProjectCronView {
  return {
    id: 'cron-a',
    projectId: 'project-a',
    revision: 4,
    name: 'release-readiness',
    schedule: 'every 6h',
    description: 'Check release readiness and record blockers.',
    prompt: 'Review the release goal and current repository state.',
    target: { scope: 'workspace', projectId: 'project-a', spaceId: 'space-a' },
    readScopes: ['repository/**', 'local://workspace/goal/**'],
    writeScopes: ['local://workspace/reports/**'],
    enabled: true,
    state: 'blocked',
    nextRunAt: new Date('2026-09-01T06:00:00.000Z'),
    lastRunAt: new Date('2026-09-01T00:00:00.000Z'),
    lastRunState: 'blocked',
    statusMessage: 'Workspace is closed and has no canonical agent',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

const callbacks = {
  onCreateCron: async () => { throw new Error('not called during server render'); },
  onUpdateCron: async () => { throw new Error('not called during server render'); },
  onDeleteCron: async () => undefined,
  onRunNow: async () => { throw new Error('not called during server render'); },
  onListRuns: async () => [],
  onCancelRun: async () => { throw new Error('not called during server render'); },
};

describe('ProjectCronsPage', () => {
  it('renders production records, stable targets, scopes, state, and actions without fixtures in the component', () => {
    const html = renderToStaticMarkup(<ProjectCronsPage
      projects={[{ id: 'project-a', name: 'GitSpace' }]}
      holders={{ "project-a": "machine-a" }}
      crons={[cronFixture()]}
      targetOptions={[{ target: { scope: 'workspace', projectId: 'project-a', spaceId: 'space-a' }, label: 'Workspace agent · release-work' }]}
      {...callbacks}
    />);
    expect(html).toContain('release-readiness');
    expect(html).toContain('Check release readiness and record blockers.');
    expect(html).toContain('Workspace agent · release-work');
    expect(html).toContain('repository/**, local://workspace/goal/**');
    expect(html).toContain('local://workspace/reports/**');
    expect(html).toContain('Workspace is closed and has no canonical agent');
    expect(html).toContain('Talk to for release-readiness');
    expect(html).toContain('Run history');
    expect(html).toContain('Actions for release-readiness');
    expect(html).not.toContain('nightly-triage');
    expect(html).not.toContain('inspector-digest');
  });


  it('formats next and last times without installing a browser scheduler', () => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    expect(formatProjectCronTime(new Date(now + 4 * 3_600_000 + 12 * 60_000), now)).toBe('in 4h 12m');
    expect(formatProjectCronTime(new Date(now + 5 * 3_600_000 + 59.6 * 60_000), now)).toBe('in 6h');
    expect(formatProjectCronTime(new Date(now - 17 * 60_000), now)).toBe('17m ago');
    expect(formatProjectCronTime(null, now)).toBe('Never');
  });
});

it('withdraws queued runs directly but requires a separate confirmed action to stop the shared workspace agent', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const cron = cronFixture();
  const base: ProjectCronRunView = { id: 'queued', projectId: cron.projectId, cronId: cron.id, cronRevision: cron.revision, cronName: cron.name, schedule: cron.schedule, description: cron.description, trigger: 'manual', state: 'running', target: cron.target, prompt: cron.prompt, readScopes: cron.readScopes, writeScopes: cron.writeScopes, resolvedSpaceId: null, resolvedGeneration: null, scheduledFor: new Date(), claimedAt: new Date(), startedAt: null, completedAt: null, message: null, createdAt: new Date() };
  let runs: ProjectCronRunView[] = [base, { ...base, id: 'running', startedAt: new Date() }];
  const cancelled: Array<{ id: string; confirmed: boolean }> = [];
  const button = (label: string) => {
    const value = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
    if (!value) throw new Error(`Missing button ${label}`);
    return value;
  };
  try {
    await act(() => root.render(<ProjectCronsPage projects={[{ id: cron.projectId, name: 'Project' }]} crons={[cron]} targetOptions={[]} {...callbacks}
      onListRuns={async () => runs}
      onCancelRun={async (_projectId, id, confirmed) => {
        cancelled.push({ id, confirmed });
        const run = runs.find(run => run.id === id)!;
        const complete = { ...run, state: 'blocked' as const, completedAt: new Date(), message: 'Cancelled' };
        runs = runs.map(run => run.id === id ? complete : run);
        return complete;
      }}
    />));
    await act(() => button('Run history').click());
    await act(() => button('Cancel queued run').click());
    expect(cancelled).toEqual([{ id: 'queued', confirmed: false }]);
    await act(() => button('Stop workspace agent').click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('other work in progress');
    expect(cancelled).toHaveLength(1);
    await act(() => button('Keep running').click());
    expect(cancelled).toHaveLength(1);
    await act(() => button('Stop workspace agent').click());
    await act(() => button('Confirm Stop workspace agent').click());
    expect(cancelled).toEqual([{ id: 'queued', confirmed: false }, { id: 'running', confirmed: true }]);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  }
});
