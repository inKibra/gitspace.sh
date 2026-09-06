import { SidebarProvider } from '@gitspace/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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


  it('keeps released spaces inline and visually marks them as released', () => {
    if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
    const released = { ...verticalSliceFixture.workspace, holder: { kind: 'released' as const } };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} projects={[{ ...base.projects[0]!, workspaces: [{ ...released, runtime: released }] }]} onClose={() => undefined} onReopen={() => undefined} deployment={null} /></SidebarProvider>);
    expect(html).toContain('· released');
    expect(html).not.toContain('>Closed<');
    expect(html).not.toContain('>Archived<');
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
  });
});
