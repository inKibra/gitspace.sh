import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { emptyWorkspaceStatus as idle, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from '@gitspace/protocol/project-authority';
import { runtimeScope, runtimeSubagents, runtimeTurns } from './runtime-shell-adapter.js';
import { GitSpaceShell, workspaceStatusColor, workspaceStatusLabel } from './GitSpaceShell.js';
import type { SpaceViewCodec } from '@gitspace/protocol/rpc-contract';
import type { InputOf } from 'result-rpc';

const stamp = '2026-10-03T00:00:00.000Z';
const project = cloudProjectSummarySchema.parse({ id: 'project', name: 'GitSpace', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, archivedAt: null, updatedAt: stamp });
const workspace = cloudWorkspaceDefinitionSchema.parse({ id: 'workspace', projectId: project.id, kind: 'worktree', name: 'Runtime restoration', branch: 'runtime', phase: 'review', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp });
const waiting: WorkspaceStatusSummary = { ...idle, primaryColor: 'blue', agents: { green: 0, blue: 1, orange: 0, red: 0 } };
const working: WorkspaceStatusSummary = { ...idle, primaryColor: 'green', agents: { green: 1, blue: 0, orange: 0, red: 0 } };
function fixture(summary = waiting) {
  return RuntimeSnapshotSchema.parse({ version: 1, projectId: project.id, workspaceId: workspace.id, cursor: 3, attachments: [], tasks: [], questions: [], documents: { 'gitspace.status': { summary, cloud: { version: null, conflicts: [] }, machines: [] } }, conversations: [{ id: 'root', parentId: null, title: 'Main agent', status: 'idle', messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Keep working without a machine' }], createdAt: stamp }, { id: 'answer-1', role: 'assistant', content: [{ type: 'text', text: 'The cloud conversation remains available.' }], createdAt: stamp }] }] });
}
const inspection = { project, workspace, workspaces: [workspace], machines: [], placement: null };

describe('runtime to existing shell adapter', () => {
  it('keeps the real composer and transcript available without an attached machine', () => {
    const snapshot = fixture();
    const scope = runtimeScope(snapshot, inspection);
    const html = renderToStaticMarkup(<GitSpaceShell {...scope} project={{ name: project.name, repository: '', connected: true }} mainAgent={{ id: 'root', title: 'Main agent', state: 'waiting', model: '', controlsAvailable: true }} turns={runtimeTurns(snapshot, 'root')} transport={[]} artifacts={[]} onSend={async () => {}} onSetWorkspacePhase={async () => {}} renderInspector={() => null} />);
    expect(html).toContain('Ask the workspace agent');
    expect(html).toContain('Keep working without a machine');
    expect(html).toContain('The cloud conversation remains available.');
    expect(html).toContain('aria-label="Workspace phase"');
    expect(html).toContain('aria-label="Open Inspector"');
    expect(html).not.toContain('Open on machine');
  });

  it('reports the summary the runtime published for a cloud workspace with no attached machine, ignoring a stale legacy placement', () => {
    const machine = { id: 'desk', label: 'Desk', kind: 'physical' as const, provider: 'physical' as const, state: 'online' as const, desiredState: 'online' as const, rpcEndpoint: 'https://desk.test/rpc', notes: '', lifecycleRevision: 1, operationId: null, error: null };
    const stale = { ...inspection, machines: [machine], placement: { state: 'open' as const, machineId: 'desk', generation: 4, updatedAt: stamp } };
    const scope = runtimeScope(fixture(), stale).workspace;
    expect(scope.holder).toEqual({ kind: 'cloud' });
    expect(workspaceStatusLabel({ ...scope, freshness: 'fresh' })).toBe('Waiting');
    expect(workspaceStatusColor({ ...scope, freshness: 'fresh' })).toBe('blue');
    expect(workspaceStatusLabel({ ...runtimeScope(fixture({ ...idle, primaryColor: 'red', agents: { green: 0, blue: 0, orange: 0, red: 1 } }), stale).workspace, freshness: 'fresh' })).toBe('Failed');
    // A conversation an interrupted turn left flagged running is not live work; only the published summary decides.
    const stuck = fixture();
    stuck.conversations[0]!.status = 'running';
    expect(workspaceStatusColor({ ...runtimeScope(stuck, stale).workspace, freshness: 'fresh' })).toBe('blue');
  });

  const listedBase: InputOf<typeof SpaceViewCodec>['baseSpace'] = { id: project.id, projectId: project.id, kind: 'base', name: project.name, branch: 'main', possessedBy: null, spaceGeneration: 0, closedAt: null, status: idle };
  function listed(id: string, status: InputOf<typeof SpaceViewCodec>['workspaces'][number]['status'] = idle): InputOf<typeof SpaceViewCodec>['workspaces'][number] {
    return {
      id, projectId: project.id, projectName: project.name, name: id, branch: id, rootPath: '', phase: 'code', possessedBy: null, spaceGeneration: 0, possessionGeneration: null, closedAt: null, status,
      relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] },
    };
  }

  it('uses authoritative relations and stack findings instead of erasing the graph', () => {
    const parent = { ...workspace, id: 'parent', name: 'Parent' };
    const saved = {
      ...listed(workspace.id),
      relations: { dependsOn: ['parent'], relatedTo: ['related'], stackedOn: 'parent' },
      stack: { blockedBy: ['parent'], blocking: ['child'], findings: [{ code: 'dependency-open' as const, message: 'Blocked by Parent (code)', workspaceId: 'parent' }] },
    };
    const scope = runtimeScope(fixture(), { ...inspection, workspaces: [workspace, parent] }, { baseSpace: listedBase, workspaces: [saved] });
    expect(scope.workspaces.find(item => item.id === workspace.id)?.relations).toEqual(saved.relations);
    expect(scope.workspaces.find(item => item.id === workspace.id)?.stack).toEqual(saved.stack);
    const changed = { ...saved, relations: { dependsOn: [], relatedTo: ['parent'], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] } };
    const refreshed = runtimeScope(fixture(), inspection, { baseSpace: listedBase, workspaces: [changed] });
    expect(refreshed.workspaces[0]?.relations).toEqual(changed.relations);
    expect(refreshed.workspaces[0]?.stack.blockedBy).toEqual([]);
  });

  it('paints only the open workspace with its live status; the project and siblings keep their listed status', () => {
    const sibling = { ...workspace, id: 'sibling', name: 'Sibling' };
    const running = fixture(working);
    const failedBase = { ...idle, primaryColor: 'red' as const, agents: { green: 0, blue: 0, orange: 0, red: 1 } };
    const scope = runtimeScope(running, { ...inspection, workspaces: [workspace, sibling] }, { baseSpace: { ...listedBase, status: failedBase }, workspaces: [listed(workspace.id), listed(sibling.id, waiting)] });
    expect(scope.workspace.status.primaryColor).toBe('green');
    expect(scope.workspaces.find(item => item.id === sibling.id)?.status).toEqual(waiting);
    expect(scope.baseSpace.status).toEqual(failedBase);
    const opening = runtimeScope(running, { ...inspection, workspaces: [workspace, sibling] });
    expect(opening.workspaces.find(item => item.id === sibling.id)?.status.primaryColor).toBe('dim');
    expect(opening.baseSpace.status.primaryColor).toBe('dim');
    const base = { ...workspace, id: project.id, kind: 'base' as const, phase: null };
    const baseOpen = runtimeScope(RuntimeSnapshotSchema.parse({ ...running, workspaceId: project.id }), { ...inspection, workspace: base, workspaces: [base, workspace] }, { baseSpace: listedBase, workspaces: [listed(workspace.id, waiting)] });
    expect(baseOpen.workspace.status.primaryColor).toBe('green');
    expect(baseOpen.workspaces[0]?.status).toEqual(waiting);
  });

  it('shows incoming sender-labelled messages before a child has answered', () => {
    const snapshot = fixture();
    const incoming = 'Message from Parent (root):\nPlease review the changed contract.';
    snapshot.conversations.push({ id: 'child', parentId: 'root', title: 'Security review', status: 'waiting', messages: [{ id: 'incoming', role: 'user', createdAt: stamp, content: [{ type: 'text', text: incoming }] }] });
    expect(runtimeSubagents(snapshot)[0]?.summary).toBe(incoming);
    expect(runtimeTurns(snapshot, 'child')[0]?.user?.text).toBe(incoming);
    snapshot.conversations[1]?.messages.push({ id: 'answer', role: 'assistant', createdAt: stamp, content: [{ type: 'text', text: 'Review complete.' }] });
    expect(runtimeSubagents(snapshot)[0]?.summary).toBe('Review complete.');
    expect(runtimeSubagents(snapshot)[0]?.messages?.[0]?.text).toBe(incoming);
  });

  it('uses the spawn address, then definition name, then role instead of a generic child title', () => {
    const snapshot = fixture();
    snapshot.conversations.push({ id: 'child', parentId: 'root', title: 'child', status: 'idle', messages: [] });
    const metadata = { conversationId: 'child', parentId: 'root', name: 'Boundary reviewer', attemptId: 'spawn', definition: { name: 'Repository Scout', description: '', source: 'workspace', path: '.agents/agents/repository.md', editable: true, content: 'Review', revision: 'a'.repeat(64), modelSelectors: ['pi/scout'], role: 'scout', provider: 'anthropic', model: 'claude-sonnet-4', thinking: null, selection: 'definition', tools: ['read'], spawns: null }, selection: { kind: 'role', role: 'scout' }, role: 'scout', thinking: null, tools: ['read'], model: { provider: 'anthropic', modelId: 'claude-sonnet-4' } };
    snapshot.documents['gitspace.agents'] = [metadata];
    expect(runtimeSubagents(snapshot)[0]?.label).toBe('Boundary reviewer');
    snapshot.documents['gitspace.agents'] = [{ ...metadata, name: 'Repository Scout-spawn', requestedName: null }];
    expect(runtimeSubagents(snapshot)[0]?.label).toBe('Repository Scout');
    snapshot.documents['gitspace.agents'] = [{ ...metadata, name: 'scout-spawn', requestedName: null, definition: null }];
    expect(runtimeSubagents(snapshot)[0]?.label).toBe('scout');
  });
});
