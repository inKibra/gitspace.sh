import { SidebarProvider } from '@gitspace/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import { verticalSliceFixture } from './App.js';
import { AppSidebar, type AppSidebarProps, type SidebarDeploymentProps, type SidebarProject } from './AppSidebar.js';
import type { GraphRelations } from './sidebar/project-graph.js';

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
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} selected={null} projects={[{ ...base.projects[0]!, workspaces: [archived] }]} deployment={null} /></SidebarProvider>);
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
    expect(html.slice(html.indexOf('>Projects<'))).not.toContain('#f97316');
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
    expect(html).toContain('title="Active project · project agent · Waiting"');
    expect(html).not.toContain('Status unavailable');
    expect(html).not.toContain('Cloudflare 1234');
  });

  it('keeps a long project name on one line, cut with an ellipsis before the counts, its whole name in the title', () => {
    const status = { ...verticalSliceFixture.baseSpace.status, primaryColor: 'blue' as const };
    const name = 'Bakery Wholesale Ordering / Supplier Portal';
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      projects={[{ id: 'long', name, baseSummary: { holder: { kind: 'cloud' }, closedAt: null, status, freshness: 'fresh' }, workspaces: [] }]}
      deployment={null}
    /></SidebarProvider>);
    const [, classes, text] = /<span data-project-name="" class="([^"]*)">([^<]*)<\/span>/u.exec(html) ?? [];
    expect(text).toBe(name);
    expect(classes?.split(' ')).toEqual(expect.arrayContaining(['truncate', 'min-w-0']));
    expect(html).toContain(`title="${name} · project agent · `);
  });

  it('shows each workspace\'s last-message preview on its second line, the selected one\'s too, truncated in place', () => {
    const status = { ...verticalSliceFixture.baseSpace.status, primaryColor: 'blue' as const };
    const row = { projectId: 'active', branch: 'main', closedAt: null };
    const html = renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar
      {...base}
      selected={{ projectId: 'active', workspaceId: 'open' }}
      selectedSummary={{ holder: { kind: 'cloud' }, closedAt: null, status, freshness: 'fresh' }}
      projects={[{ id: 'active', name: 'Active project', workspaces: [
        { ...row, id: 'open', name: 'Open workspace', summary: { holder: { kind: 'cloud' }, closedAt: null, status, freshness: 'fresh', preview: 'The migration failed. · Timeline: Deploy' } },
        { ...row, id: 'other', name: 'Other workspace', branch: 'other', summary: { holder: { kind: 'cloud' }, closedAt: null, status, freshness: 'fresh', preview: 'Tests pass. · Tradeoffs: Where do replies live?' } },
      ] }]}
      deployment={null}
    /></SidebarProvider>);
    const previews = [...html.matchAll(/<span data-workspace-preview="" class="([^"]*)">([^<]*)<\/span>/gu)];
    expect(previews.map((match) => match[2])).toEqual(['The migration failed. · Timeline: Deploy', 'Tests pass. · Tradeoffs: Where do replies live?']);
    expect(previews.every((match) => match[1]?.includes('truncate'))).toBe(true);
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

const position = (parentId: string, parentAhead: number, extra: Partial<NonNullable<GraphRelations['position']>> = {}): GraphRelations['position'] =>
  ({ parentId, parentBranch: `feature/${parentId}`, baseBranch: 'develop', mergeBase: null, parentAhead, parentMerged: 'not-merged', baseRewritten: false, instruction: null, ...extra });
const stackedOn = (parent: string | null, extra: Partial<GraphRelations> = {}): GraphRelations => ({ dependsOn: [], relatedTo: [], stackedOn: parent, position: null, aheadOfParent: null, ...extra });

/** A bakery's stacks: bakery-api on bakery-core (and bakery-web on bakery-api), a fork bakery-admin on bakery-core;
 * bakery-payments waits on bakery-stock. Listed out of stacking order, as the directory lists them. */
const stackedProject: SidebarProject = {
  id: 'stacks', name: 'Stacks',
  workspaces: ['bakery-web', 'bakery-payments', 'bakery-api', 'bakery-core', 'bakery-admin', 'bakery-stock'].map((id) => ({ id, projectId: 'stacks', name: id, branch: `feature/${id}`, closedAt: null, phase: id === 'bakery-payments' ? 'review' : 'code' })),
  graph: {
    baseBranch: 'develop',
    relations: {
      'bakery-api': stackedOn('bakery-core', { position: position('bakery-core', 2) }),
      'bakery-web': stackedOn('bakery-api', { position: position('bakery-api', 0) }),
      'bakery-admin': stackedOn('bakery-core'),
      'bakery-payments': stackedOn(null, { dependsOn: ['bakery-stock'] }),
    },
    pullRequests: { 'bakery-payments': [
      { number: 42, title: 'Card payments at checkout', url: null, state: 'open', checks: 'failing' },
      { number: 40, title: 'Card payments, first try', url: null, state: 'merged', checks: 'passing' },
    ] },
  },
};

const renderStacks = (project: SidebarProject, selected: AppSidebarProps['selected'] = null) => renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} selected={selected} deployment={null} projects={[project]} /></SidebarProvider>);
/** One row's markup: from its item to the end of its item. */
const rowOf = (html: string, id: string) => {
  const start = html.indexOf(`data-workspace="${id}"`);
  return html.slice(start, html.indexOf('</li>', start));
};

describe('AppSidebar stacks', () => {
  it('nests each stack under the workspace it builds on, depth-first through a fork, never deeper than one level', () => {
    const html = renderStacks(stackedProject);
    // Each row in sidebar order with its left inset.
    expect([...html.matchAll(/data-workspace="([^"]+)"[^>]*><button[^>]*?style="padding-left:(\d+)px"/gu)].map((match) => [match[1], Number(match[2])]))
      .toEqual([['bakery-payments', 14], ['bakery-core', 14], ['bakery-admin', 30], ['bakery-api', 30], ['bakery-web', 30], ['bakery-stock', 14]]);
    expect(html).toContain('title="Stacked on bakery-core: it merges after it');
    expect(html).toContain('title="Stacked on bakery-api: it merges after it');
    // Its open pull request with failing checks first, the merged one counted after it.
    expect(html).toMatch(/data-pr-state="open"[^>]*>#42<svg[^>]*aria-label="checks fail"/u);
    expect(html).toContain('+1');
    expect(html).not.toContain('#40');
  });

  it('orders the workspaces stacked on the same one furthest phase first (Ship, Review, Code, Plan), then by name', () => {
    const workspace = (id: string, name: string, phase: 'plan' | 'code' | 'review' | 'ship') => ({ id, projectId: 'oven', name, branch: `feature/${id}`, closedAt: null, phase });
    // Ids run against the names, so only the names can put Apple pie before Bagels.
    const html = renderStacks({ id: 'oven', name: 'Oven',
      workspaces: [workspace('w1', 'Rye', 'plan'), workspace('w2', 'Bagels', 'code'), workspace('w3', 'Oven core', 'ship'), workspace('w4', 'Croissants', 'review'), workspace('w5', 'Apple pie', 'code'), workspace('w6', 'Scones', 'plan')],
      graph: { baseBranch: 'develop', pullRequests: {}, relations: {
        w1: stackedOn('w3'), w2: stackedOn('w3'), w4: stackedOn('w3'), w5: stackedOn('w3'), w6: stackedOn('w2'),
      } } });
    // Oven core, then Croissants (Review), Apple pie and Bagels (Code; Scones on Bagels), Rye (Plan).
    expect([...html.matchAll(/data-workspace="([^"]+)"/gu)].map((match) => match[1])).toEqual(['w3', 'w4', 'w5', 'w2', 'w6', 'w1']);
  });

  it('tags the head of a stack that has members, and puts "on <parent>" on the name line with the full text in its title', () => {
    const html = renderStacks(stackedProject);
    expect(rowOf(html, 'bakery-core')).toContain('>head</span>');
    for (const id of ['bakery-api', 'bakery-web', 'bakery-payments', 'bakery-stock']) expect(rowOf(html, id)).not.toContain('>head</span>');
    const api = rowOf(html, 'bakery-api');
    // After the name and before the phase pips that open the second line; it gives way before the name does.
    expect(api.indexOf('>bakery-api</span>')).toBeLessThan(api.indexOf('>on bakery-core</span>'));
    expect(api.indexOf('>on bakery-core</span>')).toBeLessThan(api.indexOf('aria-label="Phase: Code"'));
    expect(api).toMatch(/shrink-\[1000\][^>]*title="Stacked on bakery-core: it merges after it\. 2 commits behind bakery-core\. to take it in: git rebase feature\/bakery-core"/u);
    // How far behind sits on the second line; the row's title says it all.
    expect(api.indexOf('aria-label="Phase: Code"')).toBeLessThan(api.indexOf('title="2 commits behind bakery-core">2 behind</span>'));
    expect(api).toContain('title="feature/bakery-api · Status unknown · on bakery-core · 2 behind"');
    // Up to date: no marker.
    expect(rowOf(html, 'bakery-web')).not.toContain(' behind</span>');
  });

  it('marks a merged parent before a rewritten base before commits behind, and a legacy member ahead of its parent as a warning', () => {
    const ahead = 'Ahead of its parent: in Review while bakery-core, which it is stacked on, is in Code';
    const html = renderStacks({ ...stackedProject, graph: { baseBranch: 'develop', pullRequests: {}, relations: {
      'bakery-api': stackedOn('bakery-core', { position: position('bakery-core', 4, { parentMerged: 'merged', baseRewritten: true }) }),
      'bakery-web': stackedOn('bakery-api', { position: position('bakery-api', 3, { baseRewritten: true }) }),
      'bakery-admin': stackedOn('bakery-core', { position: position('bakery-core', 0), aheadOfParent: ahead }),
    } } });
    const api = rowOf(html, 'bakery-api');
    expect(api).toContain('>merged — restack onto develop</span>');
    expect(api).not.toContain('base rewritten');
    expect(api).not.toContain('4 behind');
    const web = rowOf(html, 'bakery-web');
    expect(web).toContain('>base rewritten</span>');
    expect(web).not.toContain('3 behind');
    const admin = rowOf(html, 'bakery-admin');
    expect(admin).toMatch(new RegExp(`title="${ahead}"[^>]*>ahead of its parent</span>`, 'u'));
  });

  it('says "waits on" and "blocks" as planning labels whatever the phase, never "blocked"', () => {
    const shipped: SidebarProject = { ...stackedProject, workspaces: stackedProject.workspaces.map((workspace) => workspace.id === 'bakery-stock' ? { ...workspace, phase: 'ship' } : workspace) };
    for (const html of [renderStacks(stackedProject), renderStacks(shipped)]) {
      expect(rowOf(html, 'bakery-payments')).toContain('waits on bakery-stock');
      expect(rowOf(html, 'bakery-stock')).toContain('blocks bakery-payments');
      expect(html).not.toMatch(/blocked by|blocking/u);
    }
  });

  it('lists a member of an archived merged parent at the top level, still on its parent and asking to restack', () => {
    const archivedParent = { id: 'bakery-old', projectId: 'stacks', name: 'bakery-old', branch: 'feature/bakery-old', closedAt: new Date('2026-11-01T00:00:00.000Z'), phase: 'ship' as const };
    const html = renderStacks({ ...stackedProject, workspaces: [...stackedProject.workspaces, archivedParent], graph: { baseBranch: 'develop', pullRequests: {}, relations: {
      'bakery-api': stackedOn('bakery-old', { position: position('bakery-old', 0, { parentMerged: 'merged' }) }),
    } } });
    expect(html).toMatch(/data-workspace="bakery-api"[^>]*><button[^>]*?style="padding-left:14px"/u);
    const api = rowOf(html, 'bakery-api');
    expect(api).toContain('>on bakery-old</span>');
    expect(api).toContain('>merged — restack onto develop</span>');
  });

  it('shows each workspace once, in the same order with one open', () => {
    const rows = (html: string) => [...html.matchAll(/data-workspace="([^"]+)"/gu)].map((match) => match[1]);
    const closed = renderStacks(stackedProject);
    const html = renderStacks(stackedProject, { projectId: 'stacks', workspaceId: 'bakery-api' });
    expect(rows(html)).toEqual(rows(closed));
    expect(new Set(rows(html)).size).toBe(rows(html).length);
  });
});

describe('AppSidebar archived projects', () => {
  const status = { ...verticalSliceFixture.baseSpace.status, primaryColor: 'green' as const };
  const running = { holder: { kind: 'cloud' as const }, closedAt: null, status, freshness: 'fresh' as const };
  const projects: SidebarProject[] = [
    { id: 'live', name: 'Live project', lifecycle: 'active', workspaces: [{ id: 'live-work', projectId: 'live', name: 'Live work', branch: 'live', closedAt: null }] },
    { id: 'import-check', name: 'Import check', lifecycle: 'archived', workspaces: [{ id: 'import-work', projectId: 'import-check', name: 'Import work', branch: 'import', closedAt: null, summary: running }] },
    { id: 'block-fluency', name: 'Block fluency eval', lifecycle: 'deleting', workspaces: [{ id: 'fluency-work', projectId: 'block-fluency', name: 'Fluency work', branch: 'fluency', closedAt: null, summary: running }] },
  ];
  const render = (selected: AppSidebarProps['selected']) => renderToStaticMarkup(<SidebarProvider persist={false}><AppSidebar {...base} selected={selected} projects={projects} onNewWorkspace={() => undefined} deployment={null} /></SidebarProvider>);
  const count = (html: string, label: string) => Number(html.match(new RegExp(`${label}<span[^>]*>(\\d+)<`, 'u'))?.[1]);

  it('folds archived and deleting projects into one collapsed group after the project list, with their count', () => {
    const html = render(null);
    expect(html).toContain('Live project');
    expect(html).not.toContain('Import check');
    expect(html).not.toContain('Block fluency eval');
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*?Archived projects.*?data-sidebar="menu-badge"[^>]*>2</u);
    expect(html.indexOf('Live project')).toBeLessThan(html.indexOf('Archived projects'));
  });

  it('opens the group on its selected project, dimmed, folded, without a new workspace button', () => {
    const html = render({ projectId: 'import-check', workspaceId: null });
    expect(html).toMatch(/aria-expanded="true"[^>]*>.*?Archived projects/u);
    expect(html).toContain('Import check');
    expect(html).toContain('Block fluency eval');
    expect(html).toContain('aria-label="New workspace in Live project"');
    expect(html).not.toContain('aria-label="New workspace in Import check"');
    expect(html).toContain('aria-label="Expand Import check"');
    expect(html).toMatch(/<button[^>]*class="[^"]*opacity-60[^"]*"[^>]*>(?:(?!<\/button>).)*Import check/u);
  });

  it('opens the group on a selected workspace of an archived project', () => {
    const html = render({ projectId: 'import-check', workspaceId: 'import-work' });
    expect(html).toMatch(/aria-expanded="true"[^>]*>.*?Archived projects/u);
    expect(html).toContain('data-workspace="import-work"');
  });

  it('leaves archived projects and their workspaces out of the header counts', () => {
    const html = render({ projectId: 'import-check', workspaceId: null });
    expect(count(html, 'All')).toBe(1);
    expect(count(html, 'Running')).toBe(0);
  });
});
