// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InspectorView } from '@gitspace/protocol';
import type { WorkspaceEnvironmentView } from '@gitspace/protocol/rpc-contract';
import { emptyLifecycleState } from '@gitspace/protocol-environment';
import { emptyWorkspaceStatus } from '@gitspace/protocol-workspace';
import type * as Synchronization from './SynchronizationProvider.js';
import type { WorkspaceView } from './GitSpaceShell.js';
import { LiveInspector } from './LiveApp.js';
import { RuntimeSnapshotSchema, SessionControlSchema } from '@gitspace/protocol-runtime';
import type { InspectorProps } from './inspector/Inspector.js';

type Read = { state: 'success'; value: unknown; fetch: 'idle'; refetch: () => Promise<unknown> } | { state: 'pending'; fetch: 'idle'; refetch: () => Promise<unknown> };
// result-rpc keeps one cache entry per procedure and input: an unchanged request keeps serving the same accepted value.
const queries = vi.hoisted(() => new Map<string, Read>());
const runtimeSession = vi.hoisted(() => vi.fn());
vi.mock('./rpc-client.js', () => ({
  homeRpcUrl: '/rpc',
  rpcClient: {
    inspector: { overview: 'overview', artifacts: { list: 'artifacts' }, journal: { list: 'journal' }, review: { list: 'threads' } },
    workspace: { stackStatus: 'stack' },
    environment: { get: 'environment' },
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
vi.mock('./environment/EnvironmentView.js', () => ({ EnvironmentView: () => <p>Environment ready</p> }));
vi.mock('./inspector/index.js', () => ({ Inspector: ({ overview: shown, environment, usage }: Pick<InspectorProps, 'overview' | 'environment' | 'usage'>) => <><p>Inspector overview for {shown.spaceId}</p>{environment?.(() => {})}<button onClick={usage.load}>Load usage</button>{usage.report ? <p>Session cost: {usage.report.totalsDeep.costUsd}</p> : null}</> }));

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
  generation, possessedBy, holder: { kind: 'cloud' }, status: emptyWorkspaceStatus, closedAt: null,
  relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] },
});
let root: Root;
let container: HTMLDivElement;
const render = ({ possessedBy = '', generation = 0, refreshToken = 0 }: { possessedBy?: string; generation?: number; refreshToken?: number }) => {
  const workspace = scope(possessedBy, generation);
  const snapshotRead = queries.get('snapshot');
  const runtimeContext = {
    snapshot: RuntimeSnapshotSchema.parse(snapshotRead?.state === 'success' ? snapshotRead.value : { version: 1, projectId: 'project', workspaceId: 'workspace', cursor: refreshToken, conversations: [{ id: 'main', parentId: null, title: 'Main', status: 'idle', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} }),
    conversationId: 'main', sessionId: 'main', turns: [], scope: workspace, workspaces: [], onClose: () => {}, onOpenTerminal: () => {}, onAskAgent: async () => {},
  };
  root.render(<LiveInspector projectId="project" spaceId="workspace" generation={generation} reviewerId="device" sessionId="main" scope={workspace} workspaces={[]} onSelectWorkspace={() => {}} refreshToken={refreshToken} onClose={() => {}} runtimeAvailable runtimeContext={runtimeContext} />);
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queries.clear();
  runtimeSession.mockReset();
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
