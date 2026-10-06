import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from '@gitspace/protocol/project-authority';
import { runtimeScope, runtimeSubagents, runtimeTurns } from './runtime-shell-adapter.js';
import { GitSpaceShell } from './GitSpaceShell.js';
import type { SpaceViewCodec } from '@gitspace/protocol/rpc-contract';
import type { InputOf } from 'result-rpc';

const stamp = '2026-10-03T00:00:00.000Z';
const project = cloudProjectSummarySchema.parse({ id: 'project', name: 'GitSpace', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, archivedAt: null, updatedAt: stamp });
const workspace = cloudWorkspaceDefinitionSchema.parse({ id: 'workspace', projectId: project.id, kind: 'worktree', name: 'Runtime restoration', branch: 'runtime', phase: 'review', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp });
function fixture() {
  return RuntimeSnapshotSchema.parse({ version: 1, projectId: project.id, workspaceId: workspace.id, cursor: 3, attachments: [], tasks: [], questions: [], documents: {}, conversations: [{ id: 'root', parentId: null, title: 'Main agent', status: 'idle', messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Keep working without a machine' }], createdAt: stamp }, { id: 'answer-1', role: 'assistant', content: [{ type: 'text', text: 'The cloud conversation remains available.' }], createdAt: stamp }] }] });
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

  it('preserves role, generation and canonical phase without treating loss as ownership transfer', () => {
    const snapshot = fixture();
    snapshot.attachments = [RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: project.id, workspaceId: workspace.id, attachmentId: 'primary', machineId: 'offline', generation: 8, role: 'primary', checkout: { kind: 'shared', branch: 'runtime' }, state: 'lost', capabilities: [], updatedAt: stamp })];
    const scope = runtimeScope(snapshot, inspection);
    expect(scope.workspace.holder).toEqual({ kind: 'held', machineId: 'offline', label: 'offline' });
    expect(scope.workspace.generation).toBe(8);
    expect(scope.workspace.phase).toBe('review');
    snapshot.documents['gitspace.workspace'] = { phase: 'ship' };
    expect(runtimeScope(snapshot, inspection).workspace.phase).toBe('ship');
  });

  it('uses authoritative relations and stack findings instead of erasing the graph', () => {
    const parent = { ...workspace, id: 'parent', name: 'Parent' };
    const saved: InputOf<typeof SpaceViewCodec>['workspaces'][number] = {
      id: workspace.id, projectId: project.id, projectName: project.name, name: workspace.name, branch: workspace.branch, rootPath: '/workspace',
      phase: 'review', possessedBy: '', spaceGeneration: 0, possessionGeneration: 0, closedAt: null,
      status: { primaryColor: 'dim', agents: { green: 0, blue: 0, orange: 0, red: 0 }, services: { green: 0, red: 0 }, terminals: { green: 0, red: 0 } },
      relations: { dependsOn: ['parent'], relatedTo: ['related'], stackedOn: 'parent' },
      stack: { blockedBy: ['parent'], blocking: ['child'], findings: [{ code: 'dependency-open', message: 'Blocked by Parent (code)', workspaceId: 'parent' }] },
    };
    const scope = runtimeScope(fixture(), { ...inspection, workspaces: [workspace, parent] }, [saved]);
    expect(scope.workspaces.find(item => item.id === workspace.id)?.relations).toEqual(saved.relations);
    expect(scope.workspaces.find(item => item.id === workspace.id)?.stack).toEqual(saved.stack);
    const changed = { ...saved, relations: { dependsOn: [], relatedTo: ['parent'], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] } };
    const refreshed = runtimeScope(fixture(), inspection, [changed]);
    expect(refreshed.workspaces[0]?.relations).toEqual(changed.relations);
    expect(refreshed.workspaces[0]?.stack.blockedBy).toEqual([]);
  });

  it('projects subagent status and report content into the existing Inspector blocks', () => {
    const snapshot = fixture();
    snapshot.conversations.push({ id: 'child', parentId: 'root', title: 'Security review', status: 'waiting', messages: [{ id: 'report', role: 'assistant', createdAt: stamp, content: [{ type: 'text', text: 'Waiting for approval' }] }] });
    expect(runtimeSubagents(snapshot)).toEqual([{ id: 'agent:child', type: 'side-agent', agentId: 'child', label: 'Security review', status: 'blocked', summary: 'Waiting for approval' }]);
    expect(runtimeTurns(snapshot, 'root').at(-1)?.sideAgents).toEqual(runtimeSubagents(snapshot));
    expect(runtimeTurns(snapshot, 'child').flatMap(turn => turn.items)).toMatchObject([{ type: 'message', text: 'Waiting for approval' }]);
  });
});
