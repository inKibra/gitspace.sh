import { SidebarProvider } from '@gitspace/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture, launchTrackFixture, sidebarDeploymentFixture, verticalSliceFixture } from './App.js';
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
    expect(html).not.toContain('GitSpace is running from this workspace');
  });

  it('reads stable on the channel build and the running release otherwise', () => {
    const stable: SidebarDeploymentProps = {
      ...sidebarDeploymentFixture,
      launch: null,
      status: { ...deploymentStatusFixture, desired: { ...deploymentStatusFixture.desired, sha: null }, current: { ...deploymentStatusFixture.current, machines: { studio: { sha: null, generation: 'gen-77ab21' } } }, launch: null },
    };
    expect(render(stable)).toContain('aria-label="Source · stable"');

    const sha = deploymentStatusFixture.desired.sha!;
    const running: SidebarDeploymentProps = {
      ...stable,
      status: { ...deploymentStatusFixture, launch: null, thisMachine: { ...deploymentStatusFixture.thisMachine, sha }, current: { ...deploymentStatusFixture.current, machines: { studio: { sha, generation: 'gen-77ab21' } } } },
    };
    expect(render(running)).toContain('aria-label="Source · agent-blame @ a1b2c3d"');
  });

  it('shows the launch phase while a launch runs, convergence afterwards, and a sticky failure', () => {
    const runningHtml = render(sidebarDeploymentFixture);
    expect(runningHtml).toContain('aria-label="Source · Building machine…"');
    expect(runningHtml).toContain('data-launch="running"');

    const convergingHtml = render({ ...sidebarDeploymentFixture, launch: null });
    expect(convergingHtml).toContain('aria-label="Source · converging 1/2 machines"');

    const failedHtml = render({ ...sidebarDeploymentFixture, launch: { ...launchTrackFixture, status: 'failed', error: 'bun install failed' } });
    expect(failedHtml).toContain('aria-label="Source · Launch failed"');
    expect(failedHtml).toContain('data-launch="failed"');
  });

  it('marks the workspace GitSpace runs from', () => {
    const html = render(sidebarDeploymentFixture);
    expect(html).toMatch(/agent-blame<\/span><\/span><span[^>]*title="GitSpace is running from this workspace"/u);
    expect(html).not.toMatch(/relay-hardening<\/span><\/span><span[^>]*title="GitSpace is running/u);
    expect(render({ ...sidebarDeploymentFixture, status: { ...deploymentStatusFixture, desired: { ...deploymentStatusFixture.desired, sha: null } } })).not.toContain('GitSpace is running from this workspace');
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
});
