// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import type { InspectorView } from '@gitspace/protocol';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from '@gitspace/protocol/project-authority';
import type { GitSpaceShellProps } from './GitSpaceShell.js';
import { RuntimeWorkspaceShell } from './RuntimeWorkspace.js';

const mocks = vi.hoisted(() => ({ setRelations: vi.fn(), refresh: vi.fn(), shell: null as unknown, saved: null as unknown, failed: false, pending: false }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { providers: { list: 'providers' }, skills: { list: 'skills' }, deployment: { status: 'deployment' }, space: { view: 'relations' }, workspace: { setRelations: mocks.setRelations } }, createGitSpaceBrowserClient: vi.fn() }));
vi.mock('result-rpc/react', () => ({ useResultQuery: (procedure: string) => ({ state: procedure === 'relations' && mocks.failed ? 'failure' : procedure === 'relations' && mocks.pending ? 'pending' : 'success', error: new Error('relations unavailable'), value: procedure === 'relations' ? mocks.saved : undefined, refetch: mocks.refresh }) }));
vi.mock('./InferenceContext.js', () => ({ useInference: () => null }));
vi.mock('./useCloudSessionControls.js', () => ({ useCloudSessionControls: () => ({ result: null, run: vi.fn(), error: null }) }));
vi.mock('./useTranscriptHistory.js', () => ({ useTranscriptHistory: () => ({ refresh: vi.fn() }) }));
vi.mock('./RuntimeMachines.js', () => ({ RuntimeMachines: () => null }));
vi.mock('./GitSpaceShell.js', () => ({ GitSpaceShell: (props: GitSpaceShellProps) => { mocks.shell = props; return <div>{props.workspaces[0]?.relations.dependsOn.join(',')}</div>; }, EmptyState: () => null, StatusDot: () => null }));
const stamp = '2026-10-03T00:00:00.000Z';
const project = cloudProjectSummarySchema.parse({ id: 'project', name: 'Project', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, archivedAt: null, updatedAt: stamp });
const workspace = cloudWorkspaceDefinitionSchema.parse({ id: 'workspace', projectId: project.id, kind: 'worktree', name: 'Work', branch: 'work', phase: 'code', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp });
const inspection: InspectorView = {
  identity: { projectId: project.id, spaceId: workspace.id },
  project, workspace, workspaces: [workspace], machines: [], placement: null,
  overview: {
    projectId: project.id, spaceId: workspace.id, revision: 1,
    goal: null, workflow: null, rubric: null, changeGuide: null,
    journal: { entries: 0, openPhaseRunId: null, recent: [] },
    review: { total: 0, unresolved: 0 },
  },
  artifacts: [], checkpoint: null, creation: null,
  savedTranscript: { status: 'none', reason: null },
};
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: project.id, workspaceId: workspace.id, cursor: 0, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
const refreshInspection = vi.fn();
let root: Root;
let container: HTMLDivElement;
const render = () => root.render(<RuntimeWorkspaceShell projectId={project.id} workspaceId={workspace.id} snapshot={snapshot} inspection={inspection} connected refreshInspection={refreshInspection} onOpenSettings={() => {}} onSelectWorkspace={() => {}} onSelectProject={() => {}} renderInspector={() => null} />);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.setRelations.mockReset(); mocks.refresh.mockReset(); refreshInspection.mockReset(); mocks.failed = false; mocks.pending = false;
  snapshot.documents = {};
  mocks.saved = { workspaces: [{ id: workspace.id, relations: { dependsOn: ['parent'], relatedTo: [], stackedOn: 'parent' }, stack: { blockedBy: ['parent'], blocking: [], findings: [] } }] };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('edits the real saved relation graph and refreshes it after accepted writes', async () => {
  await act(render);
  expect(container.textContent).toContain('parent');
  const relations = { dependsOn: [], relatedTo: ['parent'], stackedOn: null };
  mocks.setRelations.mockImplementation(async () => {
    mocks.saved = { workspaces: [{ id: workspace.id, relations, stack: { blockedBy: [], blocking: [], findings: [] } }] };
    return { status: 'ok', value: {} };
  });
  await act(async () => { await (mocks.shell as GitSpaceShellProps).onSetWorkspaceRelations!(workspace.id, relations); });
  await act(render);
  expect(mocks.setRelations).toHaveBeenCalledWith({ workspaceId: workspace.id, ...relations });
  expect(mocks.refresh).toHaveBeenCalled();
  expect(refreshInspection).toHaveBeenCalled();
  expect((mocks.shell as GitSpaceShellProps).workspaces[0]?.relations).toEqual(relations);
  expect((mocks.shell as GitSpaceShellProps).workspaces[0]?.stack.blockedBy).toEqual([]);
});
it('propagates rejected edits to the existing relation writer and refreshes canonical state', async () => {
  await act(render);
  mocks.setRelations.mockResolvedValue({ status: 'error', error: new Error('Dependency cycle') });
  await expect((mocks.shell as GitSpaceShellProps).onSetWorkspaceRelations!(workspace.id, { dependsOn: ['child'], relatedTo: [], stackedOn: null })).rejects.toThrow('Dependency cycle');
  expect(mocks.refresh).toHaveBeenCalled();
  expect(refreshInspection).toHaveBeenCalled();
  expect((mocks.shell as GitSpaceShellProps).workspaces[0]?.relations.dependsOn).toEqual(['parent']);
});
it('never offers relation writes before canonical relations arrive', async () => {
  mocks.saved = null;
  mocks.pending = true;
  await act(render);
  expect((mocks.shell as GitSpaceShellProps).onSetWorkspaceRelations).toBeUndefined();
  mocks.pending = false;
  mocks.failed = true;
  await act(render);
  expect((mocks.shell as GitSpaceShellProps).onSetWorkspaceRelations).toBeUndefined();
  expect(mocks.setRelations).not.toHaveBeenCalled();
});
it('retains the accepted graph read-only and rejects stale edit callbacks during refresh or failure', async () => {
  await act(render);
  const stale = (mocks.shell as GitSpaceShellProps).onSetWorkspaceRelations!;
  mocks.pending = true;
  await act(render);
  expect(container.textContent).toContain('parent');
  expect((mocks.shell as GitSpaceShellProps).onSetWorkspaceRelations).toBeUndefined();
  await expect(stale(workspace.id, { dependsOn: [], relatedTo: [], stackedOn: null })).rejects.toThrow('finish loading');
  mocks.pending = false;
  mocks.failed = true;
  await act(render);
  expect(container.textContent).toContain('parent');
  await expect(stale(workspace.id, { dependsOn: [], relatedTo: [], stackedOn: null })).rejects.toThrow('finish loading');
  expect(mocks.setRelations).not.toHaveBeenCalled();
});

it('announces persistent cloud merge conflicts while the machines dialog is closed', async () => {
  const commit = 'a'.repeat(40);
  snapshot.documents['gitspace.code'] = { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit, conflicts: ['src/shared.ts', 'assets/config.json'] };
  await act(render);
  const alert = container.querySelector('[role="alert"][aria-label="Workspace merge conflicts"]');
  expect(alert?.textContent).toContain('src/shared.ts');
  expect(alert?.textContent).toContain('assets/config.json');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(render);
  expect(container.querySelector('[aria-label="Workspace merge conflicts"]')).not.toBeNull();
  snapshot.documents['gitspace.code'] = { ...RuntimeGitCheckpointSchema.parse(snapshot.documents['gitspace.code']), conflicts: [] };
  await act(render);
  expect(container.querySelector('[aria-label="Workspace merge conflicts"]')).toBeNull();
});
