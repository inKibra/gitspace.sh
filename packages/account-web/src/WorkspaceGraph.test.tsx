import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, type WorkspaceView } from './GitSpaceShell.js';
import { isBlocking, layoutWorkspaces } from './WorkspaceGraph.js';
import { OverviewView } from './inspector/OverviewView.js';

const [alpha, beta, gamma] = verticalSliceFixture.workspaces as [WorkspaceView, WorkspaceView, WorkspaceView];
function workspace(overrides: Partial<WorkspaceView> & { id: string }): WorkspaceView {
  return { ...alpha, name: overrides.id, branch: overrides.id, ...overrides };
}

describe('layoutWorkspaces', () => {
  const relations = (dependsOn: string[], stackedOn: string | null = null) => ({ relations: { dependsOn, relatedTo: [], stackedOn }, stack: { blockedBy: [], blocking: [], findings: [] } });

  it('columns by dependency depth so edges flow left to right, rows by name independent of input order', () => {
    const positions = layoutWorkspaces([
      workspace({ id: 'b', phase: 'code', ...relations([]) }),
      workspace({ id: 'a', phase: 'code', ...relations([]) }),
      workspace({ id: 'c', phase: 'plan', ...relations(['a'], 'a') }),
      workspace({ id: 'd', phase: 'ship', ...relations(['c']) }),
    ]);
    const at = (id: string) => positions.get(id)!;
    // Roots share the left column regardless of phase; each dependent sits one column right of its deepest dependency.
    expect(at('a').x).toBe(0);
    expect(at('b').x).toBe(0);
    expect(at('c').x).toBeGreaterThan(at('a').x);
    expect(at('d').x).toBeGreaterThan(at('c').x);
    expect(at('a').y).toBe(0);
    expect(at('b').y).toBeGreaterThan(at('a').y);
    expect(at('c').y).toBe(0);
  });

  it('orders a column by the rows of its dependencies to keep edges short', () => {
    const positions = layoutWorkspaces([
      workspace({ id: 'a', ...relations([]) }),
      workspace({ id: 'b', ...relations([]) }),
      // Named to sort first, but it depends on the lower root, so it takes the lower row.
      workspace({ id: '0-child-of-b', ...relations(['b']) }),
      workspace({ id: 'child-of-a', ...relations(['a']) }),
    ]);
    const at = (id: string) => positions.get(id)!;
    expect(at('child-of-a').y).toBe(at('a').y);
    expect(at('0-child-of-b').y).toBeGreaterThan(at('child-of-a').y);
  });

  it('lays out a stale cycle without looping', () => {
    const positions = layoutWorkspaces([workspace({ id: 'a', ...relations(['b']) }), workspace({ id: 'b', ...relations(['a']) })]);
    expect(positions.size).toBe(2);
  });
});

describe('isBlocking', () => {
  it('treats open, unshipped dependencies as blocking', () => {
    expect(isBlocking(workspace({ id: 'x', phase: 'code' }))).toBe(true);
    expect(isBlocking(workspace({ id: 'x', phase: 'ship' }))).toBe(false);
    expect(isBlocking(workspace({ id: 'x', phase: 'code', closedAt: new Date(0) }))).toBe(false);
  });
});

describe('Kanban relations', () => {
  it('offers Board and Graph views and flags blocked cards', () => {
    const blocked = { ...alpha, relations: { dependsOn: [beta.id], relatedTo: [], stackedOn: beta.id }, stack: { blockedBy: [beta.id], blocking: [], findings: [{ code: 'dependency-open', message: 'relay-hardening is still open', workspaceId: beta.id }] } };
    const html = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} activeView="kanban" workspace={blocked} workspaces={[blocked, beta, gamma]} onCreateWorkspace={async () => undefined} />);
    expect(html).toContain('Board');
    expect(html).toContain('Graph');
    expect(html).toContain('blocked · 1');
    expect(html).toContain('1 blocked');
    expect(html).toContain('title="Stacked on relay-hardening"');
    expect(html).toContain('aria-label="New workspace in Plan"');
  });
});

describe('OverviewView', () => {
  const scope: WorkspaceView = {
    ...alpha,
    relations: { dependsOn: [beta.id], relatedTo: [gamma.id], stackedOn: beta.id },
    stack: { blockedBy: [beta.id], blocking: [], findings: [{ code: 'dependency-open', message: 'relay-hardening is still in review', workspaceId: beta.id }] },
  };
  const blockedByAlpha = { ...gamma, projectId: alpha.projectId, relations: { dependsOn: [alpha.id], relatedTo: [], stackedOn: null }, stack: { blockedBy: [alpha.id], blocking: [], findings: [] } };
  const withBlocking = { ...scope, stack: { ...scope.stack, blocking: [gamma.id] } };

  it('breaks a workspace down into blocked by, blocking, related, and findings', () => {
    const html = renderToStaticMarkup(<OverviewView scope={withBlocking} workspaces={[withBlocking, beta, blockedByAlpha]} onSelectWorkspace={() => undefined} onSetRelations={async () => undefined} />);
    expect(html).toContain('Blocked by · 1');
    expect(html).toContain('Blocking · 1');
    expect(html).toContain('Related to · 1');
    expect(html).toContain('relay-hardening');
    expect(html).toContain('release');
    expect(html).toContain('relay-hardening is still in review');
    expect(html).toContain('Search workspaces this depends on');
    expect(html).toContain('aria-label="Stacked on"');
    expect(html).toContain('aria-label="Remove relay-hardening"');
    expect(html).toContain('>parent<');
  });

  it('surfaces the phase ceiling as a notice and the parent position with its agent instruction', () => {
    const ceiling = { ...scope, phase: 'review' as const, stack: { ...scope.stack, findings: [{ code: 'phase-ceiling', message: 'Ahead of relay-hardening (code)', workspaceId: beta.id }] } };
    const html = renderToStaticMarkup(<OverviewView
      scope={ceiling}
      workspaces={[ceiling, beta, gamma]}
      onSelectWorkspace={() => undefined}
      stackStatus={{ parentId: beta.id, parentBranch: beta.branch, baseBranch: 'main', mergeBase: 'abcdef0123456789', parentAhead: 2, parentMerged: 'not-merged', instruction: `Rebase onto the parent: \`git rebase ${beta.branch}\`` }}
    />);
    expect(html).toContain('Phase ceiling');
    expect(html).toContain('Ahead of relay-hardening (code)');
    expect(html).toContain('Parent is 2 commits ahead');
    expect(html).toContain(`git rebase ${beta.branch}`);
    expect(html).not.toContain('Findings ·');
  });

  it('is read-only without a relations writer', () => {
    const html = renderToStaticMarkup(<OverviewView scope={scope} workspaces={[scope, beta, gamma]} onSelectWorkspace={() => undefined} />);
    expect(html).not.toContain('Search workspaces this depends on');
    expect(html).not.toContain('aria-label="Stacked on"');
    expect(html).not.toContain('Remove relay-hardening');
  });

  it('lists a project’s open workspaces with the dependency graph', () => {
    const html = renderToStaticMarkup(<OverviewView scope={verticalSliceFixture.baseSpace} workspaces={[scope, beta, gamma]} onSelectWorkspace={() => undefined} />);
    expect(html).toContain('2 open workspaces · 1 blocked');
    expect(html).toContain('agent-blame');
    expect(html).toContain('relay-hardening');
    expect(html).not.toContain('release/1.0');
    expect(html).toContain('Dependency graph');
  });
});
