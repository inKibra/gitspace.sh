import { SidebarProvider } from '@gitspace/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import { verticalSliceFixture } from './App.js';
import { AppSidebar, type AppSidebarProps, type SidebarDeploymentProps } from './AppSidebar.js';

const base: AppSidebarProps = {
  view: 'agent',
  onView: () => undefined,
  selected: { projectId: verticalSliceFixture.workspace.projectId, workspaceId: verticalSliceFixture.workspace.id },
  projects: [{ id: verticalSliceFixture.baseSpace.projectId, name: verticalSliceFixture.baseSpace.projectName, base: verticalSliceFixture.baseSpace, workspaces: verticalSliceFixture.workspaces.map((workspace) => ({ ...workspace, runtime: workspace })) }],
  machines: [],
  onSelectWorkspace: () => undefined,
  user: { name: 'Brad' },
};

function render(deployment: SidebarDeploymentProps | null): string {
  return renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} deployment={deployment} /></SidebarProvider>);
}

describe('AppSidebar Source pill', () => {
  it('is absent without deployment status', () => {
    const html = render(null);
    expect(html).not.toContain('aria-label="Source ·');
  });



  it('reserves the collapsed disclosure for archived spaces', () => {
    if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
    const archived = { ...verticalSliceFixture.workspace, closedAt: new Date('2026-09-01T00:00:00.000Z') };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} selected={null} projects={[{ ...base.projects[0]!, workspaces: [{ ...archived, runtime: archived }] }]} deployment={null} /></SidebarProvider>);
    expect(html).toContain('>Archived<');
    expect(html).not.toContain('>Closed<');
  });

  it('keeps workspace creation on the base-space row, not beside new project', () => {
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      onNewProject={() => undefined}
      onNewWorkspace={() => undefined}
      deployment={null}
    /></SidebarProvider>);
    expect(html).toContain('aria-label="New project"');
    expect(html).toContain('aria-label="New workspace in ');
    expect(html).not.toContain('aria-label="New workspace"');
  });

  it('keeps cloud projects and saved workspaces navigable without runtime scopes', () => {
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      selected={{ projectId: 'other-project', workspaceId: 'saved-workspace' }}
      projects={[
        { id: 'gitspace', name: 'Built-in GitSpace', lifecycle: 'cloud-only', workspaces: [] },
        { id: 'other-project', name: 'Other project', lifecycle: 'active', workspaces: [{ id: 'saved-workspace', projectId: 'other-project', name: 'Saved workspace', branch: 'feature', closedAt: null }] },
      ]}
      deployment={null}
    /></SidebarProvider>);
    expect(html).toContain('Built-in GitSpace');
    expect(html).toContain('Other project');
    expect(html).toContain('Saved workspace');
    expect(html).not.toContain('Space actions for');
    // Nothing has been read for these rows yet: no status is not a warning.
    expect(html).not.toContain('#f97316');
  });

  it('uses status circles for unknown and stale scopes, pulsing only freshly confirmed running status', () => {
    const status = { ...verticalSliceFixture.baseSpace.status, primaryColor: 'green' as const };
    const holder = { kind: 'held' as const, machineId: 'desk', label: 'Desk' };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      selected={null}
      projects={[
        { id: 'saved', name: 'Saved project', lifecycle: 'cloud-only', workspaces: [] },
        {
          id: 'active', name: 'Active project', error: 'Status read timed out',
          baseSummary: { holder, closedAt: null, status, freshness: 'fresh' },
          workspaces: [
            { id: 'stale', projectId: 'active', name: 'Stale workspace', branch: 'feature', closedAt: null, summary: { holder, closedAt: null, status, freshness: 'stale', detail: 'Status read timed out' } },
            { id: 'unknown', projectId: 'active', name: 'Unknown workspace', branch: 'other', closedAt: null },
          ],
        },
      ]}
      deployment={null}
    /></SidebarProvider>);
    expect(html.match(/class="status-dot"/g)).toHaveLength(4);
    expect(html.match(/data-pulse="true"/g)).toHaveLength(1);
    expect(html).toContain('data-freshness="stale"');
    expect(html).toContain('data-freshness="unknown"');
    expect(html).toContain('aria-description="Status read timed out"');
  });
});

describe('AppSidebar selected status', () => {
  it('renders the open pane status for the selected row, even when the directory last saw something else', () => {
    const status = { ...verticalSliceFixture.baseSpace.status, primaryColor: 'blue' as const };
    const holder = { kind: 'held' as const, machineId: 'desk', label: 'Desk' };
    const directoryRow = { id: 'open', projectId: 'active', name: 'Open workspace', branch: 'main', closedAt: null, summary: { holder, closedAt: null, status, freshness: 'fresh' as const } };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      selected={{ projectId: 'active', workspaceId: 'open' }}
      selectedSummary={{ holder: { kind: 'unknown' }, closedAt: null, status, freshness: 'fresh' }}
      projects={[{ id: 'active', name: 'Active project', workspaces: [directoryRow, { ...directoryRow, id: 'other', name: 'Other workspace' }] }]}
      deployment={null}
    /></SidebarProvider>);
    expect(html).toContain('title="main · Status unavailable"');
    expect(html).toContain('title="main · Waiting"');
  });

  it('never names a machine, and shows a cloud workspace by its runtime status alone', () => {
    const status = { ...verticalSliceFixture.baseSpace.status, primaryColor: 'blue' as const };
    const held = { kind: 'held' as const, machineId: 'cloudflare-1234', label: 'Cloudflare 1234' };
    const row = { projectId: 'active', branch: 'main', closedAt: null };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      selected={{ projectId: 'active', workspaceId: 'open' }}
      selectedSummary={{ holder: { kind: 'cloud' }, closedAt: null, status, freshness: 'fresh' }}
      projects={[{ id: 'active', name: 'Active project', baseSummary: { holder: held, closedAt: null, status, freshness: 'fresh' }, workspaces: [
        { ...row, id: 'open', name: 'Open cloud workspace' },
        { ...row, id: 'idle', name: 'Other cloud workspace', branch: 'idle', summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'unknown' } },
        { ...row, id: 'legacy', name: 'Legacy workspace', branch: 'legacy', summary: { holder: held, closedAt: null, status, freshness: 'fresh' } },
      ] }]}
      deployment={null}
    /></SidebarProvider>);
    expect(html).toContain('title="main · Waiting"');
    expect(html).toContain('title="idle · Cloud workspace"');
    expect(html).toContain('title="legacy · Waiting"');
    expect(html).toContain('title="Base · Waiting"');
    expect(html).not.toContain('Status unavailable');
    expect(html).not.toContain('Cloudflare 1234');
  });

  it('marks the projects and workspaces whose origin is ahead of their copy, apart from their status', () => {
    const checkedAt = '2026-10-17T12:00:00.000Z';
    const definition = (id: string, behind: boolean): CloudWorkspaceDefinition => ({
      id, projectId: 'tracked', kind: 'worktree', name: id, branch: `feature/${id}`, phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null,
      lifecycle: 'active', goalId: null, revision: 1, remote: { head: 'a'.repeat(40), checkedAt, behind }, archivedAt: null, createdAt: checkedAt, updatedAt: checkedAt,
    });
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} selected={null} deployment={null} projects={[
      { id: 'tracked', name: 'Tracked', lifecycle: 'active', remote: { head: 'b'.repeat(40), checkedAt, behind: true },
        workspaces: ['ahead', 'current'].map((id) => ({ id, projectId: 'tracked', name: id, branch: `feature/${id}`, closedAt: null, definition: definition(id, id === 'ahead') })) },
      { id: 'current', name: 'Current', lifecycle: 'active', remote: { head: 'c'.repeat(40), checkedAt, behind: false }, workspaces: [] },
    ]} /></SidebarProvider>);
    expect(html.match(/aria-label="Behind origin"/gu)).toHaveLength(2);
    expect(html).toContain('title="Behind origin/feature/ahead"');
    expect(html).not.toContain('title="Behind origin/feature/current"');
  });
});
