// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeploymentStatusView } from '@gitspace/protocol';
import { deploymentStatusFixture } from './App.js';
import { LaunchSheet, LaunchedBanner, RevertSheet, LAUNCHED_STORAGE_KEY } from './LaunchSheet.js';
import { useRuntimeLaunch, type RuntimeLaunch } from './useRuntimeLaunch.js';

const rpc = vi.hoisted(() => ({ launch: vi.fn(), revert: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { deployment: rpc } }));
let root: Root;
let container: HTMLDivElement;
let state: RuntimeLaunch;
const refresh = vi.fn();
const reload = vi.fn();
function View({ status }: { status: DeploymentStatusView }) {
  state = useRuntimeLaunch(status, refresh, reload);
  return <>{state.launch ? <LaunchSheet launch={state.launch} open={state.open} onOpenChange={state.setOpen} onRetry={() => state.start(state.launch!.source, 'builder', state.launch!.targets)} onDiscard={() => state.discard(state.launch!.launchId)} /> : null}{state.revertProgress ? <RevertSheet progress={state.revertProgress} open={state.open} onOpenChange={state.setOpen} onRetry={() => state.revert().catch(() => {})} /> : null}{state.mark ? <LaunchedBanner mark={state.mark} onRevert={() => state.revert().catch(() => {})} onDismiss={state.dismiss} /> : null}</>;
}
function initial(): DeploymentStatusView {
  const value = structuredClone(deploymentStatusFixture);
  return {
    ...value,
    launch: { ...value.launch!, launchId: 'attempt-1', status: 'running', phase: 'build', message: 'building tenant worker', sha: value.releases[0]!.sha },
  };
}
/** `status` with the account's latest Back to stable in the given state. */
function withRevert(status: DeploymentStatusView, revertStatus: 'running' | 'succeeded' | 'failed', error: string | null = null, revertId = 'revert-1'): DeploymentStatusView {
  return { ...status, revert: { revertId, status: revertStatus, error, startedAt: '2026-08-30T10:06:00.000Z', updatedAt: '2026-08-30T10:06:30.000Z' } };
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label);
  if (!found) throw new Error(`No ${label} button`);
  return found;
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
it('propagates rejected launch and revert actions without reloading', async () => {
  await act(() => root.render(<View status={initial()} />));
  rpc.launch.mockResolvedValue({ status: 'error', error: new Error('launch denied') });
  rpc.revert.mockResolvedValue({ status: 'error', error: new Error('revert denied') });
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'workspace' }, 'builder', ['frontend'])).rejects.toThrow('launch denied'); });
  await act(async () => { await expect(state.revert()).rejects.toThrow('revert denied'); });
  expect(reload).not.toHaveBeenCalled();
});

it('follows the account\'s revert in status and reloads into stable only once the account records it succeeded', async () => {
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() }));
  const status: DeploymentStatusView = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValue({ status: 'ok', value: withRevert(status, 'running') });
  await act(async () => { await state.revert(); });
  expect(state.revertProgress).toEqual({ status: 'running', error: null });
  expect(container.textContent).toContain('Swapping the worker to the stable build');
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(() => root.render(<View status={withRevert(status, 'running')} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
  await act(() => root.render(<View status={withRevert(status, 'succeeded')} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBeNull();
  expect(state.revertProgress).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).toHaveBeenCalledTimes(2);
});
it('follows a Back to stable already running when the page opens, but not one that already ended', async () => {
  const status: DeploymentStatusView = { ...initial(), launch: null };
  await act(() => root.render(<View status={withRevert(status, 'failed', 'Platform reported channel:1 unhealthy', 'revert-0')} />));
  expect(container.querySelector('[aria-label="Back to stable progress"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).not.toHaveBeenCalled();
  await act(() => root.render(<View status={withRevert(status, 'running')} />));
  expect(container.querySelector('[aria-label="Back to stable progress"]')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(() => root.render(<View status={withRevert(status, 'succeeded')} />));
  expect(reload).toHaveBeenCalledTimes(1);
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
it('stops following Back to stable when a launch takes the page over', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: withRevert(status, 'running') });
  await act(async () => { await state.revert(); });
  rpc.launch.mockRejectedValueOnce(new Error('busy'));
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'workspace' }, 'builder', ['frontend'])).rejects.toThrow('busy'); });
  await act(() => root.render(<View status={withRevert(status, 'succeeded')} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  expect(state.revertProgress).toBeNull();
});
it('does not resume polling or reload after unmount while revert is in flight', async () => {
  await act(() => root.render(<View status={{ ...initial(), launch: null }} />));
  const reply = Promise.withResolvers<{ status: 'ok'; value: DeploymentStatusView }>();
  rpc.revert.mockReturnValueOnce(reply.promise);
  let pending: Promise<void>;
  await act(() => { pending = state.revert(); });
  await act(() => root.render(null));
  await act(async () => { reply.resolve({ status: 'ok', value: withRevert(initial(), 'running') }); await pending!; await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
it('stops polling on unmount while following a revert', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: withRevert(status, 'running') });
  await act(async () => { await state.revert(); await vi.advanceTimersByTimeAsync(1500); });
  const beforeUnmount = refresh.mock.calls.length;
  await act(() => root.render(null));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(refresh).toHaveBeenCalledTimes(beforeUnmount);
  expect(reload).not.toHaveBeenCalled();
});

it('shows the failure the account recorded, keeps the banner, and Retry follows a new revert to success', async () => {
  const mark = JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() });
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, mark);
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: withRevert(status, 'running') });
  await act(async () => { button('Back to stable').click(); });
  expect(state.revertProgress?.status).toBe('running');
  await act(() => root.render(<View status={withRevert(status, 'failed', 'Platform reported channel:1 unhealthy')} />));
  expect(state.revertProgress).toEqual({ status: 'failed', error: 'Platform reported channel:1 unhealthy' });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('unhealthy');
  expect(container.textContent).toContain('Now running');
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBe(mark);
  const polls = refresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).toHaveBeenCalledTimes(polls);
  expect(reload).not.toHaveBeenCalled();

  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: withRevert(status, 'running', null, 'revert-2') });
  await act(async () => { button('Retry').click(); });
  expect(rpc.revert).toHaveBeenCalledTimes(2);
  expect(rpc.launch).not.toHaveBeenCalled();
  expect(state.revertProgress?.status).toBe('running');
  // The earlier revert's record settles nothing about this one.
  await act(() => root.render(<View status={withRevert(status, 'failed', 'Platform reported channel:1 unhealthy')} />));
  expect(state.revertProgress?.status).toBe('running');
  await act(() => root.render(<View status={withRevert(status, 'succeeded', null, 'revert-2')} />));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBeNull();
  expect(container.textContent).not.toContain('Now running');
});

it('keeps the banner on RPC rejection and exposes a functional revert Retry', async () => {
  const mark = JSON.stringify({ sha: 'launched', label: 'Launched', at: Date.now() });
  sessionStorage.setItem(LAUNCHED_STORAGE_KEY, mark);
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockRejectedValueOnce(new Error('Revert denied'));
  await act(async () => { button('Back to stable').click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Revert denied');
  expect(container.textContent).toContain('Now running');
  expect(sessionStorage.getItem(LAUNCHED_STORAGE_KEY)).toBe(mark);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(refresh).not.toHaveBeenCalled();
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: withRevert(status, 'running') });
  await act(async () => { button('Retry').click(); });
  expect(rpc.revert).toHaveBeenCalledTimes(2);
  expect(rpc.launch).not.toHaveBeenCalled();
  expect(state.revertProgress?.status).toBe('running');
});

it('ignores a superseded revert RPC reply when a launch takes the page over', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  const reply = Promise.withResolvers<{ status: 'ok'; value: DeploymentStatusView }>();
  rpc.revert.mockReturnValueOnce(reply.promise);
  let pending: Promise<void>;
  await act(() => { pending = state.revert(); });
  rpc.launch.mockRejectedValueOnce(new Error('Launch denied'));
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'workspace' }, 'builder', ['frontend'])).rejects.toThrow('Launch denied'); });
  await act(async () => { reply.resolve({ status: 'ok', value: withRevert(status, 'running') }); await pending!; await vi.advanceTimersByTimeAsync(15_000); });
  expect(state.revertProgress).toBeNull();
  expect(state.launch?.error).toContain('Launch denied');
  expect(refresh).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it('keeps following through status reads that fail, without an unhandled rejection', async () => {
  const status = { ...initial(), launch: null };
  await act(() => root.render(<View status={status} />));
  rpc.revert.mockResolvedValueOnce({ status: 'ok', value: withRevert(status, 'running') });
  refresh.mockRejectedValue(new Error('Disconnected during the swap'));
  await act(async () => { await state.revert(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(state.revertProgress?.status).toBe('running');
  await act(() => root.render(<View status={withRevert(status, 'succeeded')} />));
  expect(reload).toHaveBeenCalledTimes(1);
});

it('refuses an empty machine before dispatch and exposes the failure in the launch sheet', async () => {
  await act(() => root.render(<View status={{ ...initial(), launch: null }} />));
  await act(async () => { await expect(state.start({ kind: 'workspace', workspaceId: 'workspace' }, '', ['frontend'])).rejects.toThrow('choose a machine'); });
  expect(rpc.launch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('choose a machine');
});
