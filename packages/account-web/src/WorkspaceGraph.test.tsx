import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { verticalSliceFixture } from './App.js';
import type { WorkspaceView } from './GitSpaceShell.js';
import { isBlocking, layoutWorkspaces, WorkspaceGraph, type WorkspaceGraphItem } from './WorkspaceGraph.js';
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

  it('retains directory-only nodes without inventing relations or phase and keeps other-project references separate', () => {
    const unknown: WorkspaceGraphItem = { id: 'unknown', projectId: alpha.projectId, projectName: alpha.projectName, name: 'unknown', branch: 'offline', closedAt: null, holder: { kind: 'unknown' }, phase: null };
    const foreign = workspace({ id: 'foreign', projectId: 'another-project', ...relations(['unknown']) });
    const positions = layoutWorkspaces([unknown, foreign]);
    expect([...positions.keys()].sort()).toEqual(['foreign', 'unknown']);
    expect(positions.get('unknown')?.x).toBe(positions.get('foreign')?.x);
    const html = renderToStaticMarkup(<WorkspaceGraph workspaces={[unknown, foreign]} onSelect={() => undefined} height={500} />);
    expect(html).toContain('Relation coverage is incomplete');
    expect(isBlocking(unknown)).toBeNull();
  });
});

describe('isBlocking', () => {
  it('treats open, unshipped dependencies as blocking', () => {
    expect(isBlocking(workspace({ id: 'x', phase: 'code' }))).toBe(true);
    expect(isBlocking(workspace({ id: 'x', phase: 'ship' }))).toBe(false);
    expect(isBlocking(workspace({ id: 'x', phase: 'code', closedAt: new Date(0) }))).toBe(false);
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
    expect(html).toContain('Stack · 2 workspaces, merged in this order');
  });

  it('surfaces the phase ceiling as a notice and the parent position as information', () => {
    const ceiling = { ...scope, phase: 'review' as const, stack: { ...scope.stack, findings: [{ code: 'phase-ceiling', message: 'Ahead of relay-hardening (code)', workspaceId: beta.id }] } };
    const html = renderToStaticMarkup(<OverviewView
      scope={ceiling}
      workspaces={[ceiling, beta, gamma]}
      onSelectWorkspace={() => undefined}
      stackStatus={new Map([[ceiling.id, { parentId: beta.id, parentBranch: beta.branch, baseBranch: 'main', mergeBase: 'abcdef0123456789', parentAhead: 2, parentMerged: 'not-merged', instruction: null }]])}
    />);
    expect(html).toContain('Phase ceiling');
    expect(html).toContain('Ahead of relay-hardening (code)');
    expect(html).toContain('merges after relay-hardening · 2 commits behind relay-hardening');
    expect(html).toContain(`optional: <code class="font-mono [overflow-wrap:anywhere]">git rebase ${beta.branch}</code>`);
    expect(html).not.toContain('Findings ·');
  });

  it('chains a forked stack bottom first, each branch of the fork whole before the next, with every link’s position', () => {
    const stacked = (base: WorkspaceView, id: string, name: string, parent: string): WorkspaceView => ({ ...base, id, name, branch: name, projectId: alpha.projectId, relations: { dependsOn: [parent], relatedTo: [], stackedOn: parent }, stack: { blockedBy: [], blocking: [], findings: [] } });
    const bottom = { ...beta, relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] } };
    // Listed out of stacking order: the chain orders by the stack, siblings of a fork in list order.
    const fork = stacked(gamma, 'fork', 'fork-branch', bottom.id);
    const middle = stacked(alpha, alpha.id, alpha.name, bottom.id);
    const top = stacked(alpha, 'top', 'top-branch', middle.id);
    const position = (parentId: string, parentAhead: number, parentMerged: 'merged' | 'not-merged') => ({ parentId, parentBranch: null, baseBranch: 'main', mergeBase: null, parentAhead, parentMerged, instruction: null });
    const html = renderToStaticMarkup(<OverviewView scope={top} workspaces={[top, middle, fork, bottom]} onSelectWorkspace={() => undefined}
      stackStatus={new Map([[middle.id, position(bottom.id, 3, 'not-merged')], [top.id, position(middle.id, 0, 'not-merged')], [fork.id, position(bottom.id, 0, 'merged')]])} />);
    expect(html).toContain('Stack · 4 workspaces, merged in this order');
    expect([...html.matchAll(/data-stack-link="([^"]+)"/gu)].map((match) => match[1])).toEqual([bottom.id, middle.id, top.id, fork.id]);
    expect(html).toContain('bottom of the stack · merges into main');
    expect(html).toContain('merges after relay-hardening · 3 commits behind relay-hardening');
    expect(html).toContain('optional: <code class="font-mono [overflow-wrap:anywhere]">git rebase relay-hardening</code>');
    expect(html).toContain('merges after agent-blame · up to date with agent-blame');
    expect(html).toContain('merges after relay-hardening · relay-hardening merged into main');
    expect(html).toContain('git rebase --onto main relay-hardening');
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
