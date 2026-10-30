// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeploymentStatusView, LaunchProgressView } from '@gitspace/protocol';
import { deploymentStatusFixture } from './App.js';
import { LaunchSheet, LaunchedBanner, LAUNCHED_STORAGE_KEY } from './LaunchSheet.js';
import { useRuntimeLaunch, type RuntimeLaunch } from './useRuntimeLaunch.js';

const rpc = vi.hoisted(() => ({ launch: vi.fn(), backToDefault: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { deployment: rpc } }));
let root: Root;
let container: HTMLDivElement;
let state: RuntimeLaunch;
const refresh = vi.fn();
const reload = vi.fn();
function View({ status }: { status: DeploymentStatusView }) {
  state = useRuntimeLaunch(status, refresh, reload);
  return <>{state.launch ? <LaunchSheet launch={state.launch} open={state.open} onOpenChange={state.setOpen} onRetry={() => state.launch!.source.kind === 'release' ? state.backToDefault().catch(() => {}) : state.start(state.launch!.source, 'builder', state.launch!.targets)} onDiscard={() => state.discard(state.launch!.launchId)} /> : null}{state.mark ? <LaunchedBanner mark={state.mark} onBackToDefault={() => state.backToDefault().catch(() => {})} onDismiss={state.dismiss} /> : null}</>;
}
function initial(): DeploymentStatusView {
  const value = structuredClone(deploymentStatusFixture);
  return {
    ...value,
    launch: { ...value.launch!, launchId: 'attempt-1', status: 'running', phase: 'build', message: 'building tenant worker', sha: value.releases[0]!.sha },
  };
}
const DEFAULT_SHA = deploymentStatusFixture.defaultRelease ?? '';
/** The account's Back to default, as status reports it: the launch of the default release to every target. */
function backToDefaultLaunch(status: LaunchProgressView['status'], error: string | null = null): LaunchProgressView {
  return { launchId: 'back-to-default', source: { kind: 'release', sha: DEFAULT_SHA }, targets: ['worker', 'machine', 'frontend'], sha: DEFAULT_SHA, phase: status === 'running' ? 'launch' : status === 'failed' ? 'failed' : 'launched', message: 'launching into worker, machine, frontend', status, error, startedAt: '2026-08-30T10:06:00.000Z', updatedAt: '2026-08-30T10:06:30.000Z' };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  sessionStorage.clear();
  refresh.mockReset(); reload.mockReset(); rpc.launch.mockReset(); rpc.backToDefault.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('retains launch history and polls through restart until the selected frontend is ready', async () => {
  let status = initial();
  await act(() => root.render(<View status={status} />));
  expect(container.querySelector('[aria-label="Launch progress"]')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(refresh).toHaveBeenCalledTimes(1);
  status = { ...status, launch: { ...status.launch!, status: 'succeeded', phase: 'launched', message: 'Launch selected' } };
  await act(() => root.render(<View status={status} />));
  expect(state.launch?.log.map(entry => entry.phase)).toEqual(['build', 'launched', 'restart']);
  expect(reload).not.toHaveBeenCalled();
  // Every fleet machine swaps; the accepted track survives a status that no longer carries launch progress.
  status = { ...status, launch: null, current: { ...status.current, machines: Object.fromEntries(Object.entries(status.current.machines).map(([machineId, machine]) => [machineId, { ...machine, sha: state.launch!.sha }])) }, desired: { ...status.desired, frontend: null } };
  await act(() => root.render(<View status={status} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
  status = { ...status, desired: { ...status.desired, frontend: state.launch!.sha }, current: { ...status.current, worker: { ...status.current.worker, sha: state.launch!.sha } } };
  await act(() => root.render(<View status={status} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(state.launch?.log.at(-1)?.phase).toBe('reload');
  expect(JSON.parse(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)!)).toMatchObject({ sha: state.launch!.sha });
  await act(() => root.render(null));
  await act(() => root.render(<View status={status} />));
  expect(container.textContent).toContain('Now running');
  expect(reload).toHaveBeenCalledTimes(1);
});
it('shows failures and retries the original workspace and targets without inventing completion', async () => {
  let status = initial();
  await act(() => root.render(<View status={status} />));
  status = { ...status, launch: { ...status.launch!, status: 'failed', phase: 'failed', error: 'Build failed', message: 'Build failed' } };
  await act(() => root.render(<View status={status} />));
  expect(container.textContent).toContain('Build failed');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).not.toHaveBeenCalled();
  const next = { ...status.launch!, launchId: 'attempt-2', status: 'running' as const, phase: 'queued', message: 'Queued', error: null };
  rpc.launch.mockResolvedValue({ status: 'ok', value: next });
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(rpc.launch).toHaveBeenCalledWith({ source: status.launch!.source, machineId: 'builder', targets: status.launch!.targets });
  expect(state.launch?.status).toBe('running');
  expect(state.launch?.log.map(entry => entry.phase)).toEqual(['queued']);
  expect(reload).not.toHaveBeenCalled();
});
it('does not reload an old completed launch merely by visiting the workspace', async () => {
  const value = initial();
  const status: DeploymentStatusView = { ...value, launch: { ...value.launch!, status: 'succeeded' } };
  await act(() => root.render(<View status={status} />));
  expect(reload).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});
it('propagates rejected launch and Back to default actions without reloading', async () => {
  await act(() => root.render(<View status={initial()} />));
  rpc.launch.mockResolvedValue({ status: 'error', error: new Error('launch denied') });
  rpc.backToDefault.mockResolvedValue({ status: 'error', error: new Error('no default release') });
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'workspace' }, 'builder', ['frontend'])).rejects.toThrow('launch denied'); });
  await act(async () => { await expect(state.backToDefault()).rejects.toThrow('no default release'); });
  expect(reload).not.toHaveBeenCalled();
});
it('follows Back to default as the launch the account returns, and reloads once every target runs the default', async () => {
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() }));
  let status: DeploymentStatusView = { ...initial(), launch: null, releases: [...deploymentStatusFixture.releases, { ...deploymentStatusFixture.releases[0]!, sha: DEFAULT_SHA, label: 'v0.2.0-rc.41', status: { worker: 'applied', frontend: 'applied', machines: {} } }] };
  await act(() => root.render(<View status={status} />));
  rpc.backToDefault.mockResolvedValue({ status: 'ok', value: { ...status, launch: backToDefaultLaunch('running') } });
  await act(async () => { await state.backToDefault(); });
  expect(rpc.backToDefault).toHaveBeenCalledWith({});
  expect(state.launch).toMatchObject({ source: { kind: 'release', sha: DEFAULT_SHA }, status: 'running' });
  expect(container.querySelector('[aria-label="Launch progress"]')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(refresh).toHaveBeenCalled();
  // The swap is done, but a machine still runs the trial: no reload yet.
  status = { ...status, launch: backToDefaultLaunch('succeeded'), desired: { worker: DEFAULT_SHA, machine: DEFAULT_SHA, frontend: DEFAULT_SHA, updatedAt: '2026-08-30T10:07:00.000Z' }, current: { ...status.current, worker: { sha: DEFAULT_SHA, version: DEFAULT_SHA } } };
  await act(() => root.render(<View status={status} />));
  expect(reload).not.toHaveBeenCalled();
  status = { ...status, current: { ...status.current, machines: Object.fromEntries(Object.keys(status.current.machines).map(machineId => [machineId, { sha: DEFAULT_SHA, generation: 'default' }])) } };
  await act(() => root.render(<View status={status} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)!)).toMatchObject({ sha: DEFAULT_SHA, label: 'v0.2.0-rc.41' });
});
it('shows a refused Back to default in the launch sheet, and Retry asks the account again', async () => {
  await act(() => root.render(<View status={{ ...initial(), launch: null }} />));
  rpc.backToDefault.mockRejectedValueOnce(new Error('This account has no default release yet'));
  await act(async () => { await expect(state.backToDefault()).rejects.toThrow('no default release'); });
  expect(container.querySelector('[aria-label="Launch progress"]')?.textContent).toContain('This account has no default release yet');
  rpc.backToDefault.mockResolvedValueOnce({ status: 'ok', value: { ...initial(), launch: backToDefaultLaunch('running') } });
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(rpc.backToDefault).toHaveBeenCalledTimes(2);
  expect(state.launch).toMatchObject({ launchId: 'back-to-default', status: 'running' });
});
it.each(['Launch denied', 'Launch busy', 'Workspace not found'])('opens a retryable failure sheet for %s before a launch track exists', async message => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.launch.mockRejectedValueOnce(new Error(message));
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'requested-workspace' }, 'builder', ['frontend'])).rejects.toThrow(message); });
  expect(container.querySelector('[aria-label="Launch progress"]')).not.toBeNull();
  expect(container.textContent).toContain(message);
  expect(state.launch).toMatchObject({ source: { kind: 'workspace', workspaceId: 'requested-workspace' }, targets: ['frontend'], status: 'failed' });
  rpc.launch.mockResolvedValueOnce({ status: 'ok', value: { ...initial().launch!, source: { kind: 'workspace', workspaceId: 'requested-workspace' }, targets: ['frontend'] } });
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(rpc.launch).toHaveBeenLastCalledWith({ source: { kind: 'workspace', workspaceId: 'requested-workspace' }, machineId: 'builder', targets: ['frontend'] });
  expect(state.launch?.status).toBe('running');
});
it('refuses an empty machine before dispatch and exposes the failure in the launch sheet', async () => {
  await act(() => root.render(<View status={{ ...initial(), launch: null }} />));
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'workspace' }, '', ['frontend'])).rejects.toThrow('choose a machine'); });
  expect(rpc.launch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('choose a machine');
});
