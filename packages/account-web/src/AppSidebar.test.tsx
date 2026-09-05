import { SidebarProvider } from '@gitspace/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { AppSidebar, type AppSidebarProps, type SidebarDeploymentProps } from './AppSidebar.js';

const base: AppSidebarProps = {
  view: 'agent',
  onView: () => undefined,
  selected: verticalSliceFixture.workspace,
  projects: [{ base: verticalSliceFixture.baseSpace, workspaces: verticalSliceFixture.workspaces }],
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
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} selected={released} projects={[{ base: verticalSliceFixture.baseSpace, workspaces: [released] }]} onClose={() => undefined} onReopen={() => undefined} deployment={null} /></SidebarProvider>);
    expect(html).toContain('· released');
    expect(html).not.toContain('>Closed<');
    expect(html).not.toContain('>Archived<');
  });

  it('reserves the collapsed disclosure for archived spaces', () => {
    if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
    const archived = { ...verticalSliceFixture.workspace, closedAt: new Date('2026-09-01T00:00:00.000Z') };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} projects={[{ base: verticalSliceFixture.baseSpace, workspaces: [archived] }]} deployment={null} /></SidebarProvider>);
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
});
