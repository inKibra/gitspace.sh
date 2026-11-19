import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { verticalSliceFixture } from './App.js';
import type { WorkspaceView } from './GitSpaceShell.js';
import { layoutWorkspaces, WorkspaceGraph, type WorkspaceGraphItem } from './WorkspaceGraph.js';
import { OverviewView } from './inspector/OverviewView.js';

const [alpha, beta, gamma] = verticalSliceFixture.workspaces as [WorkspaceView, WorkspaceView, WorkspaceView];
const unstacked: WorkspaceView['stack'] = { waitsOn: [], blocks: [], findings: [], position: null };
function workspace(overrides: Partial<WorkspaceView> & { id: string }): WorkspaceView {
  return { ...alpha, name: overrides.id, branch: overrides.id, ...overrides };
}
const position = (parentId: string, parentAhead: number, parentMerged: 'merged' | 'not-merged', parentBranch: string | null = null): NonNullable<WorkspaceView['stack']['position']> =>
  ({ parentId, parentBranch, baseBranch: 'main', mergeBase: null, parentAhead, parentMerged, baseRewritten: false, instruction: null });

describe('layoutWorkspaces', () => {
  const relations = (dependsOn: string[], stackedOn: string | null = null) => ({ relations: { dependsOn, relatedTo: [], stackedOn }, stack: unstacked });

  it('columns by stack and waits-on depth so edges flow left to right, rows by name independent of input order', () => {
    const positions = layoutWorkspaces([
      workspace({ id: 'b', phase: 'code', ...relations([]) }),
      workspace({ id: 'a', phase: 'code', ...relations([]) }),
      // Stacked on a: its waits-on never includes its stack parent.
      workspace({ id: 'c', phase: 'plan', ...relations([], 'a') }),
      workspace({ id: 'd', phase: 'ship', ...relations(['c']) }),
    ]);
    const at = (id: string) => positions.get(id)!;
    // Roots share the left column regardless of phase; each sits one column right of the deepest it is on or waits on.
    expect(at('a').x).toBe(0);
    expect(at('b').x).toBe(0);
    expect(at('c').x).toBeGreaterThan(at('a').x);
    expect(at('d').x).toBeGreaterThan(at('c').x);
    expect(at('a').y).toBe(0);
    expect(at('b').y).toBeGreaterThan(at('a').y);
    expect(at('c').y).toBe(0);
  });

  it('orders a column by the rows of what it waits on to keep edges short', () => {
    const positions = layoutWorkspaces([
      workspace({ id: 'a', ...relations([]) }),
      workspace({ id: 'b', ...relations([]) }),
      // Named to sort first, but it waits on the lower root, so it takes the lower row.
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
  });
});

describe('OverviewView', () => {
  const related = { ...gamma, projectId: alpha.projectId };
  // agent-blame is stacked on relay-hardening and related to release; member sits on agent-blame; waiter waits on it.
  const scope: WorkspaceView = { ...alpha, relations: { dependsOn: [], relatedTo: [related.id], stackedOn: beta.id }, stack: { ...unstacked, blocks: ['waiter'], position: position(beta.id, 2, 'not-merged', beta.branch) } };
  const member = workspace({ id: 'member', name: 'receipt-printer', relations: { dependsOn: [], relatedTo: [], stackedOn: alpha.id }, stack: unstacked });
  const waiter = workspace({ id: 'waiter', name: 'gift-cards', relations: { dependsOn: [alpha.id], relatedTo: [], stackedOn: null }, stack: { ...unstacked, waitsOn: [alpha.id] } });
  const bottom = { ...beta, relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: unstacked };

  it('splits relations into the Stack (merge order and branch content) and Planning labels that never block anything', () => {
    const html = renderToStaticMarkup(<OverviewView scope={scope} workspaces={[scope, bottom, related, member, waiter]} onSelectWorkspace={() => undefined} onSetRelations={async () => undefined} />);
    const at = (text: string) => html.indexOf(text);
    expect(at('Stack</span> · merge order and branch content')).toBeGreaterThan(-1);
    expect(at('Planning labels</span> · they never block anything')).toBeGreaterThan(-1);
    // Stacked on and Stacked on this sit in the Stack group; Waits on, Blocks and Related to in Planning labels.
    const stack = at('aria-label="Stack"');
    const labels = at('aria-label="Planning labels"');
    expect(stack).toBeLessThan(at('Stacked on · 1'));
    expect(at('Stacked on · 1')).toBeLessThan(at('Stacked on this · 1'));
    expect(at('Stacked on this · 1')).toBeLessThan(labels);
    expect(html.slice(at('Stacked on this · 1'), at('workspaces, merged in this order'))).toContain('Open receipt-printer');
    expect(html.slice(stack, labels)).not.toContain('gift-cards');
    expect(labels).toBeLessThan(at('Waits on nothing.'));
    expect(labels).toBeLessThan(at('Blocks · 1'));
    expect(html.slice(labels)).toContain('gift-cards');
    expect(labels).toBeLessThan(at('Related to · 1'));
    expect(html).toContain('Search workspaces this waits on');
    expect(html).toContain('aria-label="Stacked on"');
    expect(html).toContain('2 behind');
    // Nothing calls a stack edge or a waits-on "blocked".
    expect(html).not.toMatch(/blocked|Blocking/u);
  });

  it('surfaces a member already ahead of its parent as a notice, and the parent position as information', () => {
    const ahead = { ...scope, phase: 'ship' as const, stack: { ...scope.stack, findings: [{ code: 'ahead-of-parent', message: 'Ahead of its parent: in Ship while relay-hardening, which it is stacked on, is in Review', workspaceId: beta.id }] } };
    const html = renderToStaticMarkup(<OverviewView scope={ahead} workspaces={[ahead, bottom, related]} onSelectWorkspace={() => undefined} />);
    expect(html).toContain('Ahead of its parent</span>');
    expect(html).toContain('Ahead of its parent: in Ship while relay-hardening, which it is stacked on, is in Review');
    expect(html).toContain('merges after relay-hardening · 2 commits behind relay-hardening');
    expect(html).toContain(`optional: <code class="font-mono [overflow-wrap:anywhere]">git rebase ${beta.branch}</code>`);
    expect(html).not.toContain('Findings ·');
  });

  it('chains a forked stack bottom first, each branch of the fork whole before the next, with every link’s position', () => {
    const stacked = (base: WorkspaceView, id: string, name: string, parent: string, at: WorkspaceView['stack']['position']): WorkspaceView => ({ ...base, id, name, branch: name, projectId: alpha.projectId, relations: { dependsOn: [], relatedTo: [], stackedOn: parent }, stack: { ...unstacked, position: at } });
    // Listed out of stacking order: the chain orders by the stack, siblings of a fork in list order.
    const fork = stacked(gamma, 'fork', 'fork-branch', bottom.id, position(bottom.id, 0, 'merged'));
    const middle = stacked(alpha, alpha.id, alpha.name, bottom.id, position(bottom.id, 3, 'not-merged'));
    const top = stacked(alpha, 'top', 'top-branch', middle.id, position(middle.id, 0, 'not-merged'));
    const html = renderToStaticMarkup(<OverviewView scope={top} workspaces={[top, middle, fork, bottom]} onSelectWorkspace={() => undefined} />);
    expect(html).toContain('4 workspaces, merged in this order');
    expect([...html.matchAll(/data-stack-link="([^"]+)"/gu)].map((match) => match[1])).toEqual([bottom.id, middle.id, top.id, fork.id]);
    expect(html).toContain('bottom of the stack · merges into main');
    expect(html).toContain('merges after relay-hardening · 3 commits behind relay-hardening');
    expect(html).toContain('optional: <code class="font-mono [overflow-wrap:anywhere]">git rebase relay-hardening</code>');
    expect(html).toContain('merges after agent-blame · up to date with agent-blame');
    expect(html).toContain('merges after relay-hardening · relay-hardening merged into main; Restack measures this against main');
    expect(html).toContain('git rebase --onto main relay-hardening');
  });

  it('is read-only without a relations writer', () => {
    const html = renderToStaticMarkup(<OverviewView scope={scope} workspaces={[scope, bottom, related]} onSelectWorkspace={() => undefined} />);
    expect(html).not.toContain('Search workspaces this waits on');
    expect(html).not.toContain('aria-label="Stacked on"');
    expect(html).not.toContain('Remove release');
  });

  it('lists a project’s open workspaces with the relation graph, counting those with waits-on', () => {
    const html = renderToStaticMarkup(<OverviewView scope={verticalSliceFixture.baseSpace} workspaces={[scope, beta, gamma, waiter]} onSelectWorkspace={() => undefined} />);
    expect(html).toContain('3 open workspaces · 1 with waits-on');
    expect(html).toContain('waits on · 1');
    expect(html).not.toContain('release/1.0');
    expect(html).toContain('Relation graph');
  });
});
