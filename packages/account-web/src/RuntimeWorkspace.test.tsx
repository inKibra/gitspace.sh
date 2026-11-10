// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import type { RuntimeSessionResult, SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { emptyWorkspaceStatus } from '@gitspace/protocol-workspace';
import type { InspectorView } from '@gitspace/protocol';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from '@gitspace/protocol/project-authority';
import type { GitSpaceShellProps } from './GitSpaceShell.js';
import { RuntimeWorkspaceShell } from './RuntimeWorkspace.js';

const mocks = vi.hoisted((): { setRelations: Mock; refresh: Mock; cancelRun: Mock; session: { result: RuntimeSessionResult | null; run: Mock }; shell: GitSpaceShellProps | null; saved: unknown; access: unknown; failed: boolean; pending: boolean } => ({ setRelations: vi.fn(), refresh: vi.fn(), cancelRun: vi.fn(), session: { result: null, run: vi.fn() }, shell: null, saved: null, access: undefined, failed: false, pending: false }));
const createTerminal = vi.hoisted(() => vi.fn(async (_input: { spaceId: string; machineId: string }) => ({ status: 'ok' as const, value: {} })));
const copyCalls = vi.hoisted(() => ({ seed: vi.fn(async (_input: { projectId: string; machineId: string }) => ({ status: 'ok' as const, value: { baseBranch: 'main', commit: 'c'.repeat(40) } })), attach: vi.fn(async (_input: { projectId: string; workspaceId: string; machineId: string }) => ({ status: 'ok' as const, value: {} })) }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { providers: { list: 'providers' }, skills: { list: 'skills' }, deployment: { status: 'deployment' }, space: { view: 'relations' }, github: { projectAccess: 'projectAccess' }, workspace: { setRelations: mocks.setRelations }, terminals: { create: createTerminal }, project: { seed: copyCalls.seed }, runtime: { attachment: { cache: { request: copyCalls.attach } } }, automations: { cancelRun: mocks.cancelRun } } }));
vi.mock('result-rpc/react', () => ({ useResultQuery: (procedure: string) => ({ state: procedure === 'relations' && mocks.failed ? 'failure' : procedure === 'relations' && mocks.pending ? 'pending' : 'success', error: new Error('relations unavailable'), value: procedure === 'relations' ? mocks.saved : procedure === 'projectAccess' ? mocks.access : undefined, refetch: mocks.refresh }) }));
vi.mock('./InferenceContext.js', () => ({ useInference: () => null }));
vi.mock('./useCloudSessionControls.js', () => ({ useCloudSessionControls: () => ({ result: mocks.session.result, run: mocks.session.run, error: null }) }));
vi.mock('./useTranscriptHistory.js', () => ({ useTranscriptHistory: () => ({ refresh: vi.fn() }) }));
vi.mock('./GitSpaceShell.js', () => ({ GitSpaceShell: (props: GitSpaceShellProps) => { mocks.shell = props; return <div>{props.workspaces[0]?.relations.dependsOn.join(',')}{props.renderEnvironmentStatus?.(inspectEnvironment, () => {})}{props.accessBanner}{props.access?.card(inspectEnvironment)}</div>; }, EmptyState: () => null, StatusDot: ({ color }: { color: string }) => <span data-status-color={color} /> }));
const stamp = '2026-10-03T00:00:00.000Z';
const inspectEnvironment = vi.fn();
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
  artifacts: [], creation: null,
};
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: project.id, workspaceId: workspace.id, cursor: 0, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
const listedBase = { id: project.id, status: emptyWorkspaceStatus };
const refreshInspection = vi.fn();
let root: Root;
let container: HTMLDivElement;
const render = () => root.render(<RuntimeWorkspaceShell projectId={project.id} workspaceId={workspace.id} snapshot={snapshot} inspection={inspection} connected refreshInspection={refreshInspection} onOpenSettings={() => {}} onSelectWorkspace={() => {}} onSelectProject={() => {}} renderInspector={() => null} />);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.setRelations.mockReset(); mocks.refresh.mockReset(); mocks.cancelRun.mockReset(); refreshInspection.mockReset(); mocks.failed = false; mocks.pending = false; mocks.access = undefined;
  mocks.session = { result: null, run: vi.fn() };
  snapshot.documents = {};
  snapshot.conversations = [];
  snapshot.attachments = [];
  inspectEnvironment.mockReset();
  mocks.saved = { baseSpace: listedBase, workspaces: [{ id: workspace.id, relations: { dependsOn: ['parent'], relatedTo: [], stackedOn: 'parent' }, stack: { blockedBy: ['parent'], blocking: [], findings: [] } }] };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('edits the real saved relation graph and refreshes it after accepted writes', async () => {
  await act(render);
  expect(container.textContent).toContain('parent');
  const relations = { dependsOn: [], relatedTo: ['parent'], stackedOn: null };
  mocks.setRelations.mockImplementation(async () => {
    mocks.saved = { baseSpace: listedBase, workspaces: [{ id: workspace.id, relations, stack: { blockedBy: [], blocking: [], findings: [] } }] };
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
  const status = (conflicts: string[]) => ({ summary: emptyWorkspaceStatus, cloud: { version: null, conflicts }, machines: [] });
  snapshot.documents['gitspace.status'] = status(['src/shared.ts', 'assets/config.json']);
  await act(render);
  const alert = container.querySelector('[role="alert"][aria-label="Workspace merge conflicts"]');
  expect(alert?.textContent).toContain('src/shared.ts');
  expect(alert?.textContent).toContain('assets/config.json');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(render);
  expect(container.querySelector('[aria-label="Workspace merge conflicts"]')).not.toBeNull();
  snapshot.documents['gitspace.status'] = status([]);
  await act(render);
  expect(container.querySelector('[aria-label="Workspace merge conflicts"]')).toBeNull();
});

it('opens Inspector Environment from the single environment chip instead of a machines dialog', async () => {
  await act(render);
  const chip = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Environment'));
  expect(chip?.textContent).toContain('0 machines');
  await act(() => chip?.click());
  expect(inspectEnvironment).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain('Workspace machines');
});

it('keeps the workspace view on its main agent without a conversation picker', async () => {
  snapshot.conversations = [
    { id: 'child', parentId: 'main', title: 'Research child', status: 'running', messages: [] },
    { id: 'main', parentId: null, title: 'Workspace agent', status: 'running', messages: [] },
  ];
  await act(async () => { render(); });
  expect(container.querySelector('select[aria-label="Conversation"]')).toBeNull();
  expect(mocks.shell?.mainAgent?.title).toBe('Workspace agent');
});

it('renders a brand-new workspace whose code document is still null', async () => {
  snapshot.documents = { 'gitspace.code': null };
  await act(async () => { render(); });
  expect(mocks.shell).not.toBeNull();
  expect(container.querySelector('button[aria-label^="Environment"]')).not.toBeNull();
});

const baseInspection: InspectorView = { ...inspection, project: { ...project, repositoryReference: 'git@github.com:octo-labs/portal.git' }, workspace: { ...workspace, id: project.id, kind: 'base', phase: null } };
const renderProject = () => root.render(<RuntimeWorkspaceShell projectId={project.id} workspaceId={project.id} snapshot={snapshot} inspection={baseInspection} connected refreshInspection={refreshInspection} onOpenSettings={() => {}} onSelectWorkspace={() => {}} onSelectProject={() => {}} renderInspector={() => null} />);
const needsApp = { state: 'needs-app', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX' };

it('syncs a project through its bridging machine under a banner instead of walling it off', async () => {
  mocks.access = { ...needsApp, bridge: { machineId: 'machine-1', label: 'studio-mac', online: true } };
  await act(async () => { renderProject(); });
  expect(mocks.shell?.access).toBeUndefined();
  expect(container.querySelector('[aria-label="GitHub sync"]')?.textContent).toContain('Syncs with GitHub through studio-mac, using your own access. Install GitSpace BrandByX on octo-labs');
  expect(container.querySelector('[aria-label="Repository access"]')).toBeNull();
});

it('walls off a project no machine bridges with a card whose machine button opens the Environment', async () => {
  mocks.access = { ...needsApp, bridge: null };
  await act(async () => { renderProject(); });
  expect(mocks.shell?.accessBanner).toBeUndefined();
  expect(mocks.shell?.access?.notice).toBe('The project agent starts once GitSpace can read octo-labs/portal.');
  const attach = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Repository access"] button')].find(button => button.textContent === 'Attach a machine');
  await act(() => attach?.click());
  expect(inspectEnvironment).toHaveBeenCalledTimes(1);
});

it('copies a refused repository in through the chosen online machine, then attaches it to the project', async () => {
  mocks.access = { ...needsApp, bridge: { machineId: 'machine-old', label: 'old-laptop', online: false }, awaitsCopy: true };
  const machine = (id: string, label: string, state: 'online' | 'offline'): InspectorView['machines'][number] => ({ id, label, state, kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null, rpcEndpoint: null });
  const machines = [machine('machine-off', 'attic-box', 'offline'), machine('machine-on', 'studio-mac', 'online')];
  await act(async () => { root.render(<RuntimeWorkspaceShell projectId={project.id} workspaceId={project.id} snapshot={snapshot} inspection={{ ...baseInspection, machines }} connected refreshInspection={refreshInspection} onOpenSettings={() => {}} onSelectWorkspace={() => {}} onSelectProject={() => {}} renderInspector={() => null} />); });
  // A repository still waiting for its copy stays walled even with a machine attached.
  expect(mocks.shell?.accessBanner).toBeUndefined();
  const labels = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Repository access"] button')].map(button => button.textContent);
  expect(labels).toContain('Copy through studio-mac');
  expect(labels).not.toContain('Copy through attic-box');
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Repository access"] button')].find(button => button.textContent === 'Copy through studio-mac')?.click(); });
  expect(copyCalls.seed).toHaveBeenCalledWith({ projectId: project.id, machineId: 'machine-on' });
  expect(copyCalls.attach).toHaveBeenCalledWith({ projectId: project.id, workspaceId: project.id, machineId: 'machine-on' });
  expect(mocks.refresh).toHaveBeenCalled();
});

it('rereads the queue only once a dismissed automation run is cancelled, and not when the cancel is refused', async () => {
  const control: SessionControlView = { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null };
  mocks.session = { result: { control }, run: vi.fn(async () => ({ control })) };
  const cancel = Promise.withResolvers<{ status: 'ok'; value: object }>();
  mocks.cancelRun.mockReturnValueOnce(cancel.promise);
  await act(() => render());

  const dismissed = mocks.shell?.sessionControls?.onDismissAutomationRun('run-41');
  expect(mocks.cancelRun).toHaveBeenCalledExactlyOnceWith({ projectId: project.id, runId: 'run-41' });
  expect(mocks.session.run).not.toHaveBeenCalled();
  cancel.resolve({ status: 'ok', value: {} });
  await dismissed;
  expect(mocks.session.run).toHaveBeenCalledExactlyOnceWith({ type: 'control' });

  mocks.session.run.mockClear();
  const refused = new Error('This run has ended');
  mocks.cancelRun.mockResolvedValueOnce({ status: 'error', error: refused });
  await expect(mocks.shell?.sessionControls?.onDismissAutomationRun('run-42')).rejects.toBe(refused);
  expect(mocks.session.run).not.toHaveBeenCalled();
});

