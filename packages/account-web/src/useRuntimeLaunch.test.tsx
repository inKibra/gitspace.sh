// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeploymentStatusView } from '@gitspace/protocol';
import { deploymentStatusFixture } from './App.js';
import { LaunchSheet, LaunchedBanner, RevertSheet, LAUNCHED_STORAGE_KEY } from './LaunchSheet.js';
import { REVERT_ACTIVATION_TIMEOUT_MS, useRuntimeLaunch, type RuntimeLaunch } from './useRuntimeLaunch.js';

const rpc = vi.hoisted(() => ({ launch: vi.fn(), revert: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { deployment: rpc } }));
let root: Root;
let container: HTMLDivElement;
let state: RuntimeLaunch;
const refresh = vi.fn();
const reload = vi.fn();
function View({ status }: { status: DeploymentStatusView }) {
  state = useRuntimeLaunch(status, refresh, reload);
  return <>{state.launch ? <LaunchSheet launch={state.launch} open={state.open} onOpenChange={state.setOpen} onRetry={() => state.start(state.launch!.workspaceId, state.launch!.targets)} /> : null}{state.revertProgress ? <RevertSheet progress={state.revertProgress} open={state.open} onOpenChange={state.setOpen} onRetry={() => state.revert().catch(() => {})} /> : null}{state.mark ? <LaunchedBanner mark={state.mark} onRevert={() => state.revert().catch(() => {})} onDismiss={state.dismiss} /> : null}</>;
}
function initial(): DeploymentStatusView {
  const value = structuredClone(deploymentStatusFixture);
  return {
    ...value,
    launch: { ...value.launch!, launchId: 'attempt-1', status: 'running', phase: 'build', message: 'building tenant worker', sha: value.releases[0]!.sha },
    thisMachine: { ...value.thisMachine, sha: null },
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  sessionStorage.clear();
  refresh.mockReset(); reload.mockReset(); rpc.launch.mockReset(); rpc.revert.mockReset();
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
  // A restarted machine can lose its local launch record. The accepted track survives.
  status = { ...status, launch: null, thisMachine: { ...status.thisMachine, sha: state.launch!.sha }, desired: { ...status.desired, frontend: null } };
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
  expect(rpc.launch).toHaveBeenCalledWith({ workspaceId: status.launch!.workspaceId, targets: status.launch!.targets });
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
it('propagates rejected launch and revert actions without reloading', async () => {
  await act(() => root.render(<View status={initial()} />));
  rpc.launch.mockResolvedValue({ status: 'error', error: new Error('launch denied') });
  rpc.revert.mockResolvedValue({ status: 'error', error: new Error('revert denied') });
  await act(async () => { await expect(state.start('workspace', ['frontend'])).rejects.toThrow('launch denied'); });
  await act(async () => { await expect(state.revert()).rejects.toThrow('revert denied'); });
  expect(reload).not.toHaveBeenCalled();
});

it('waits for observed stable worker activation before reloading channel frontend assets', async () => {
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() }));
  let status: DeploymentStatusView = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValue({ status: 'ok', value: status });
  await act(async () => { await state.revert(); });
  expect(reload).not.toHaveBeenCalled();
  status = { ...status, desired: { ...status.desired, worker: null, frontend: null } };
  await act(() => root.render(<View status={status} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
  status = { ...status, current: { ...status.current, worker: { sha: null, version: null } } };
  await act(() => root.render(<View status={status} />));
  expect(reload).not.toHaveBeenCalled();
  status = { ...status, current: { ...status.current, worker: { sha: null, version: 'channel-1' } } };
  await act(() => root.render(<View status={status} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).toHaveBeenCalledTimes(2);
});
it.each(['Launch denied', 'Launch busy', 'Workspace not found'])('opens a retryable failure sheet for %s before a launch track exists', async message => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.launch.mockRejectedValueOnce(new Error(message));
  await act(async () => { await expect(state.start('requested-workspace', ['frontend'])).rejects.toThrow(message); });
  expect(container.querySelector('[aria-label="Launch progress"]')).not.toBeNull();
  expect(container.textContent).toContain(message);
  expect(state.launch).toMatchObject({ workspaceId: 'requested-workspace', targets: ['frontend'], status: 'failed' });
  rpc.launch.mockResolvedValueOnce({ status: 'ok', value: { ...initial().launch!, workspaceId: 'requested-workspace', targets: ['frontend'] } });
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(rpc.launch).toHaveBeenLastCalledWith({ workspaceId: 'requested-workspace', targets: ['frontend'] });
  expect(state.launch?.status).toBe('running');
});
it('cancels stable activation polling when another launch supersedes revert', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: status });
  await act(async () => { await state.revert(); });
  rpc.launch.mockRejectedValueOnce(new Error('busy'));
  await act(async () => { await expect(state.start('workspace', ['frontend'])).rejects.toThrow('busy'); });
  const stable = { ...status, desired: { ...status.desired, worker: null, frontend: null }, current: { ...status.current, worker: { sha: null, version: 'stable' } } };
  await act(() => root.render(<View status={stable} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});
it('does not resume polling or reload after unmount while revert is in flight', async () => {
  await act(() => root.render(<View status={{ ...initial(), launch: null }} />));
  const reply = Promise.withResolvers<{ status: 'ok'; value: DeploymentStatusView }>();
  rpc.revert.mockReturnValueOnce(reply.promise);
  let pending: Promise<void>;
  await act(() => { pending = state.revert(); });
  await act(() => root.render(null));
  await act(async () => { reply.resolve({ status: 'ok', value: initial() }); await pending!; await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
it('cleans up stable activation polling on unmount', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: status });
  await act(async () => { await state.revert(); await vi.advanceTimersByTimeAsync(1500); });
  const beforeUnmount = refresh.mock.calls.length;
  await act(() => root.render(null));
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(refresh).toHaveBeenCalledTimes(beforeUnmount);
  expect(reload).not.toHaveBeenCalled();
});

it('bounds activation polling, preserves the banner, and retries revert through stable success', async () => {
  const mark = JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() });
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, mark);
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValue({ status: 'ok', value: status });
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Back to stable')!.click(); });
  expect(container.textContent).toContain('Now running');
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBe(mark);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS - 1); });
  expect(state.revertProgress?.status).toBe('running');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(state.revertProgress?.status).toBe('failed');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('60 seconds');
  const polls = refresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(refresh).toHaveBeenCalledTimes(polls);
  const stable = { ...status, desired: { ...status.desired, worker: null, frontend: null }, current: { ...status.current, worker: { sha: null, version: 'stable' } } };
  await act(() => root.render(<View status={stable} />));
  expect(reload).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Now running');
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBe(mark);
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(rpc.revert).toHaveBeenCalledTimes(2);
  expect(rpc.launch).not.toHaveBeenCalled();
  expect(state.revertProgress?.status).toBe('running');
  await act(() => root.render(<View status={{ ...stable }} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBeNull();
  expect(container.textContent).not.toContain('Now running');
  const completedPolls = refresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(refresh).toHaveBeenCalledTimes(completedPolls);
  expect(state.revertProgress).toBeNull();
});

it('keeps the banner on RPC rejection and exposes a functional revert Retry', async () => {
  const mark = JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() });
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, mark);
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockRejectedValueOnce(new Error('Revert denied'));
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Back to stable')!.click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Revert denied');
  expect(container.textContent).toContain('Now running');
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBe(mark);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(refresh).not.toHaveBeenCalled();
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: status });
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(rpc.revert).toHaveBeenCalledTimes(2);
  expect(rpc.launch).not.toHaveBeenCalled();
  expect(state.revertProgress?.status).toBe('running');
});

it('keeps the activation budget at sixty elapsed seconds through forward and backward wall-clock jumps', async () => {
  const wall = Date.now();
  const mark = JSON.stringify({ sha: 'launched', label: 'Launched', at: wall });
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, mark);
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValue({ status: 'ok', value: status });
  await act(async () => { await state.revert(); });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(wall + 3_600_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(state.revertProgress?.status).toBe('running');
  clock.mockReturnValue(wall - 3_600_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
  expect(state.revertProgress?.status).toBe('running');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(state.revertProgress?.status).toBe('failed');
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBe(mark);
  const completedPolls = refresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).toHaveBeenCalledTimes(completedPolls);
  expect(reload).not.toHaveBeenCalled();
});

it('accepts stable activation within the elapsed budget after the wall clock jumps forward', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValue({ status: 'ok', value: status });
  await act(async () => { await state.revert(); });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
  const stable = { ...status, desired: { ...status.desired, worker: null, frontend: null }, current: { ...status.current, worker: { sha: null, version: 'stable' } } };
  await act(() => root.render(<View status={stable} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(state.revertProgress).toBeNull();
});

it('ignores a superseded revert RPC reply and cancels its deadline for a new launch', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  const reply = Promise.withResolvers<{ status: 'ok'; value: DeploymentStatusView }>();
  rpc.revert.mockReturnValueOnce(reply.promise);
  let pending: Promise<void>;
  await act(() => { pending = state.revert(); });
  rpc.launch.mockRejectedValueOnce(new Error('Launch denied'));
  await act(async () => { await expect(state.start('workspace', ['frontend'])).rejects.toThrow('Launch denied'); });
  await act(async () => { reply.resolve({ status: 'ok', value: status }); await pending!; await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(state.revertProgress).toBeNull();
  expect(state.launch?.error).toContain('Launch denied');
  expect(refresh).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it('still expires when status refresh rejects instead of leaving an unhandled polling failure', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: status });
  refresh.mockRejectedValue(new Error('Disconnected during activation'));
  await act(async () => { await state.revert(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(state.revertProgress?.status).toBe('failed');
  const polls = refresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERT_ACTIVATION_TIMEOUT_MS); });
  expect(refresh).toHaveBeenCalledTimes(polls);
  expect(reload).not.toHaveBeenCalled();
});
