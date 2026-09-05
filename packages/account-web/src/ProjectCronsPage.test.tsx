import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectCronView } from '@gitspace/protocol/cron-contract';
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
};

describe('ProjectCronsPage', () => {
  it('renders production records, stable targets, scopes, state, and actions without fixtures in the component', () => {
    const html = renderToStaticMarkup(<ProjectCronsPage
      projectId="project-a"
      projectName="GitSpace"
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

  it('renders an honest empty authority state and create action', () => {
    const html = renderToStaticMarkup(<ProjectCronsPage
      projectId="project-a"
      projectName="GitSpace"
      crons={[]}
      targetOptions={[]}
      {...callbacks}
    />);
    expect(html).toContain('No project crons');
    expect(html).toContain('Create the first cron');
    expect(html).toMatch(/<strong[^>]*>0<\/strong><span[^>]*>Armed/u);
  });

  it('formats next and last times without installing a browser scheduler', () => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    expect(formatProjectCronTime(new Date(now + 4 * 3_600_000 + 12 * 60_000), now)).toBe('in 4h 12m');
    expect(formatProjectCronTime(new Date(now + 5 * 3_600_000 + 59.6 * 60_000), now)).toBe('in 6h');
    expect(formatProjectCronTime(new Date(now - 17 * 60_000), now)).toBe('17m ago');
    expect(formatProjectCronTime(null, now)).toBe('Never');
  });
});
