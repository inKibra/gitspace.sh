// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InspectorView } from '@gitspace/protocol';
import type { WorkspaceEnvironmentView } from '@gitspace/protocol/rpc-contract';
import { emptyLifecycleState } from '@gitspace/protocol-environment';
import { deriveWorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import type * as Synchronization from './SynchronizationProvider.js';
import type { WorkspaceView } from './GitSpaceShell.js';
import { LiveInspector } from './LiveApp.js';
import { RuntimeSnapshotSchema, SessionControlSchema } from '@gitspace/protocol-runtime';
import type { EnvironmentViewProps } from './environment/types.js';
import type { InspectorProps } from './inspector/Inspector.js';

type Read = { state: 'success'; value: unknown; fetch: 'idle'; refetch: () => Promise<unknown> } | { state: 'pending'; fetch: 'idle'; refetch: () => Promise<unknown> };
// result-rpc keeps one cache entry per procedure and input: an unchanged request keeps serving the same accepted value.
const queries = vi.hoisted(() => new Map<string, Read>());
const runs = vi.hoisted(() => ({ checks: vi.fn(), phase: vi.fn() }));
const runtimeSession = vi.hoisted(() => vi.fn());
vi.mock('./rpc-client.js', () => ({
  homeRpcUrl: '/rpc',
  rpcClient: {
    inspector: { overview: 'overview', artifacts: { list: 'artifacts' }, journal: { list: 'journal' }, review: { list: 'threads' } },
    workspace: { stackStatus: 'stack' },
    environment: { get: 'environment', runChecks: runs.checks, runPhase: runs.phase },
    runtime: { snapshot: 'snapshot', session: runtimeSession },
  },
}));
vi.mock('result-rpc/react', () => ({
  ResultRpcProvider: () => null,
  useResultMutation: vi.fn(),
  useResultRuntime: () => ({}),
  useResultQuery: (procedure: string, input: unknown) => queries.get(`${procedure} ${JSON.stringify(input)}`) ?? queries.get(procedure) ?? { state: 'pending', fetch: 'idle', refetch: async () => {} },
}));
vi.mock('./SynchronizationProvider.js', async () => ({
  SynchronizationProvider: () => null,
  useAccountMachines: () => ({ state: 'pending', refetch: async () => {} }),
  useProjectSynchronization: () => ({ cursor: null }),
  useEnvironmentSynchronization: () => ({ value: undefined }),
  useEventRefresh: (await vi.importActual<typeof Synchronization>('./SynchronizationProvider.js')).useEventRefresh,
}));
vi.mock('./useRepositoryTree.js', () => ({ useRepositoryTree: () => ({ state: 'pending', fetch: 'idle', refetch: async () => {} }) }));
vi.mock('./environment/EnvironmentView.js', () => ({ EnvironmentView: (props: EnvironmentViewProps) => <><p>Environment ready</p><button disabled={!props.runtimeAvailable || props.busy} onClick={props.onRunChecks}>Run checks</button><button disabled={!props.runtimeAvailable || props.busy} onClick={() => props.onRunLifecycle('machine/prepare')}>Prepare machine</button></> }));
vi.mock('./inspector/index.js', () => ({ Inspector: ({ overview: shown, environment, usage }: Pick<InspectorProps, 'overview' | 'environment' | 'usage'>) => <><p>Inspector overview for {shown.spaceId}</p>{environment}<button onClick={usage.load}>Load usage</button>{usage.report ? <p>Session cost: {usage.report.totalsDeep.costUsd}</p> : null}</> }));

const overview = (revision: number): InspectorView['overview'] => ({
  projectId: 'project', spaceId: 'workspace', revision,
  goal: null, workflow: null, rubric: null, changeGuide: null,
  journal: { entries: 0, openPhaseRunId: null, recent: [] },
  review: { total: 0, unresolved: 0 },
});
const environment: WorkspaceEnvironmentView = {
  spaceId: 'workspace', projectId: 'project',
  bundleJson: JSON.stringify({ version: 1, defaultProfile: 'base', profiles: { base: { checks: [], secrets: [], values: [] } }, checks: {}, values: {}, browser: { origins: [] } }),
  selectedProfile: 'base', effective: { name: 'base', checks: [], secrets: [], values: [], notes: [] },
  configuredSecrets: [], secretMetadata: [], values: { global: {}, project: {}, workspace: {}, effective: {} },
  executions: [], runs: [], lifecycle: emptyLifecycleState('project', 'workspace'),
};
const scope = (possessedBy: string, generation: number): WorkspaceView => ({
  kind: 'workspace', id: 'workspace', projectId: 'project', projectName: 'Project', name: 'Work', branch: 'work', phase: 'code',
  generation, possessedBy, holder: { kind: 'cloud' }, status: deriveWorkspaceStatusSummary({ agents: [] }), closedAt: null,
  relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] },
});
let root: Root;
let container: HTMLDivElement;
const render = ({ possessedBy = '', generation = 0, refreshToken = 0 }: { possessedBy?: string; generation?: number; refreshToken?: number }) => {
  const workspace = scope(possessedBy, generation);
  const snapshotRead = queries.get('snapshot');
  const runtimeContext = {
    snapshot: RuntimeSnapshotSchema.parse(snapshotRead?.state === 'success' ? snapshotRead.value : { version: 1, projectId: 'project', workspaceId: 'workspace', cursor: refreshToken, conversations: [{ id: 'main', parentId: null, title: 'Main', status: 'idle', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} }),
    conversationId: 'main', sessionId: 'main', turns: [], scope: workspace, workspaces: [], onClose: () => {}, onAskAgent: async () => {},
  };
  root.render(<LiveInspector projectId="project" spaceId="workspace" generation={generation} reviewerId="device" sessionId="main" scope={workspace} workspaces={[]} onSelectWorkspace={() => {}} refreshToken={refreshToken} onClose={() => {}} runtimeAvailable runtimeContext={runtimeContext} />);
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queries.clear();
  runtimeSession.mockReset();
  runs.checks.mockReset(); runs.phase.mockReset();
  runs.checks.mockResolvedValue({ status: 'ok', value: {} });
  runs.phase.mockResolvedValue({ status: 'ok', value: {} });
  queries.set(`overview ${JSON.stringify({ spaceId: 'workspace', expectedGeneration: 0 })}`, { state: 'success', value: overview(1), fetch: 'idle', refetch: async () => {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('keeps showing the cloud workspace Inspector when a cache machine attaches or is swapped', async () => {
  await act(() => render({}));
  expect(container.textContent).toContain('Inspector overview for workspace');
  // The cloud answers Inspector reads; the attached cache only routes tools, so the overview request is unchanged.
  await act(() => render({ possessedBy: 'sandbox-a' }));
  expect(container.textContent).not.toContain('Loading Inspector authority state');
  expect(container.textContent).toContain('Inspector overview for workspace');
  await act(() => render({ possessedBy: 'sandbox-b' }));
  expect(container.textContent).toContain('Inspector overview for workspace');
});

it('keeps the loaded environment when the workspace generation changes, since environment.get does not depend on it', async () => {
  queries.set(`overview ${JSON.stringify({ spaceId: 'workspace', expectedGeneration: 1 })}`, { state: 'success', value: overview(2), fetch: 'idle', refetch: async () => {} });
  queries.set('environment', { state: 'success', value: environment, fetch: 'idle', refetch: async () => {} });
  await act(() => render({}));
  expect(container.textContent).toContain('Environment ready');
  await act(() => render({ generation: 1 }));
  expect(container.textContent).not.toContain('Loading environment');
  expect(container.textContent).toContain('Environment ready');
});

it('coalesces cursor refreshes instead of restarting Inspector reads that are still in flight', async () => {
  const read = Promise.withResolvers<void>();
  // A result-rpc refetch aborts the in-flight read of a loaded query and starts over.
  const refetch = vi.fn(() => read.promise);
  queries.set(`overview ${JSON.stringify({ spaceId: 'workspace', expectedGeneration: 0 })}`, { state: 'success', value: overview(1), fetch: 'idle', refetch });
  await act(() => render({ refreshToken: 1 }));
  expect(refetch).not.toHaveBeenCalled();
  for (const refreshToken of [2, 3, 4]) await act(() => render({ refreshToken }));
  expect(refetch).toHaveBeenCalledTimes(1);
  await act(async () => { read.resolve(); });
  // One follow-up read covers every cursor that arrived while the first was in flight.
  expect(refetch).toHaveBeenCalledTimes(2);
});

it('requires an attached machine and never substitutes another cache for a removed selection', async () => {
  queries.set('environment', { state: 'success', value: environment, fetch: 'idle', refetch: async () => {} });
  const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
  const save = () => queries.set('snapshot', { state: 'success', value: { ...snapshot }, fetch: 'idle', refetch: async () => {} });
  const checks = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Run checks')!;
  save();
  await act(() => render({}));
  expect(container.textContent).toContain('Attach a machine');
  expect(checks().disabled).toBe(true);
  const now = new Date().toISOString();
  snapshot.attachments = ['a', 'b'].map(machineId => RuntimeSnapshotSchema.shape.attachments.element.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: machineId, machineId, generation: 1, role: 'cache', state: 'ready',
    checkout: { kind: 'shared', branch: 'work' }, capabilities: [], updatedAt: now, heartbeatAt: now,
    cache: { state: 'live', platform: 'linux', activity: [], lastActivityAt: now, pausedAt: null, reclaimAt: null, lastSyncAt: now, localWorkOptIn: false, setup: [] },
  }));
  save();
  await act(() => render({}));
  expect(checks().disabled).toBe(true);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Environment run machine"]')!;
  await act(() => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(() => checks().click());
  expect(runs.checks).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'b', runId: expect.any(String) });
  await act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Prepare machine')!.click());
  expect(runs.phase).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'b', runId: expect.any(String), phase: 'machine/prepare', rerun: null, interactive: undefined });
  snapshot.attachments = snapshot.attachments.filter(attachment => attachment.machineId === 'a');
  save();
  await act(() => render({}));
  expect(checks().disabled).toBe(true);
  expect(select.value).toBe('');
  expect(runs.checks).toHaveBeenCalledTimes(1);
});

it('names the explicit paused default so cloud dispatch can resume that cache before running', async () => {
  const now = new Date().toISOString();
  const snapshot = RuntimeSnapshotSchema.parse({
    version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], tasks: [], questions: [], documents: { 'gitspace.execution': { defaultMachineId: 'paused' } },
    attachments: [{ projectId: 'project', workspaceId: 'workspace', attachmentId: 'paused', machineId: 'paused', generation: 1, role: 'cache', state: 'attaching', checkout: { kind: 'shared', branch: 'work' }, capabilities: [], updatedAt: now, heartbeatAt: now,
      cache: { state: 'paused', platform: 'linux', activity: [], lastActivityAt: now, pausedAt: now, reclaimAt: null, lastSyncAt: now, localWorkOptIn: false, setup: [] } }],
  });
  queries.set('snapshot', { state: 'success', value: snapshot, fetch: 'idle', refetch: async () => {} });
  queries.set('environment', { state: 'success', value: environment, fetch: 'idle', refetch: async () => {} });
  await act(() => render({}));
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Environment run machine"]')?.value).toBe('paused');
  expect(container.textContent).toContain('resume before the requested run');
  await act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Run checks')!.click());
  expect(runs.checks).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'paused', runId: expect.any(String) });
});

it('loads cloud session usage without a cache and retains it when a cache is attached', async () => {
  const totals = { requests: 2, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, reasoningTokens: 0, costUsd: 0.75 };
  const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0.75, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
  runtimeSession.mockResolvedValue({ status: 'ok', value: { control, usage: { sessionId: 'main', totals, totalsDeep: totals, childSessions: 0, byModel: [], byRole: [], byAgent: [], byCompletion: [], warnings: [] } } });
  await act(() => render({}));
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Load usage')!.click(); });
  expect(container.textContent).toContain('Session cost: 0.75');
  await act(() => render({ possessedBy: 'sandbox-a' }));
  expect(container.textContent).toContain('Session cost: 0.75');
});
