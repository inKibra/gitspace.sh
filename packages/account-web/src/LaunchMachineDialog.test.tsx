// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { LaunchMachineDialog } from './LaunchSheet.js';

const runtime = vi.hoisted((): { snapshot: RuntimeSnapshot | null; connected: boolean; error: string | null; retry: () => void } => ({ snapshot: null, connected: true, error: null, retry: vi.fn() }));
const requestCache = vi.hoisted(() => vi.fn());
vi.mock('./useWorkspaceRuntime.js', () => ({ useWorkspaceRuntime: () => runtime }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { attachment: { cache: { request: requestCache } } } } }));
const launch = vi.fn(async (_machineId: string) => {});
const close = vi.fn();
let root: Root;
let container: HTMLDivElement;
function snapshot(ids: string[], preferred: string | null = null): RuntimeSnapshot {
  const now = new Date().toISOString();
  return RuntimeSnapshotSchema.parse({
    version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], tasks: [], questions: [], documents: { 'gitspace.execution': { defaultMachineId: preferred } },
    attachments: ids.map(machineId => ({ projectId: 'project', workspaceId: 'workspace', attachmentId: machineId, machineId, generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'work' }, capabilities: [], updatedAt: now, heartbeatAt: now,
      cache: { state: 'live', platform: 'linux', activity: [], lastActivityAt: now, pausedAt: null, reclaimAt: null, lastSyncAt: now, localWorkOptIn: false, setup: [] } })),
  });
}
const render = () => root.render(<LaunchMachineDialog projectId="project" workspaceId="workspace" machines={[]} onClose={close} onLaunch={launch} />);
const launchButton = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Launch')!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  runtime.snapshot = snapshot([]); runtime.connected = true; runtime.error = null;
  launch.mockClear(); close.mockClear(); requestCache.mockReset();
  requestCache.mockResolvedValue({ status: 'ok', value: {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('blocks a machine-less launch and requires a choice when two caches are ready', async () => {
  await act(render);
  expect(document.body.textContent).toContain('Attach a machine');
  expect(launchButton().disabled).toBe(true);
  await act(() => launchButton().click());
  expect(launch).not.toHaveBeenCalled();
  runtime.snapshot = snapshot(['first', 'chosen']);
  await act(render);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Build machine"]')!;
  expect(select.value).toBe('');
  expect(launchButton().disabled).toBe(true);
  await act(() => { select.value = 'chosen'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(() => launchButton().click());
  expect(launch).toHaveBeenCalledExactlyOnceWith('chosen');
});

it('preselects the explicit default, allows an override, and never replaces a lost choice', async () => {
  runtime.snapshot = snapshot(['first', 'preferred'], 'preferred');
  await act(render);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Build machine"]')!;
  expect(select.value).toBe('preferred');
  await act(() => { select.value = 'first'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(() => launchButton().click());
  expect(launch).toHaveBeenCalledExactlyOnceWith('first');
  runtime.snapshot = snapshot(['preferred'], 'preferred');
  await act(render);
  expect(select.value).toBe('');
  expect(launchButton().disabled).toBe(true);
});

it('preselects only the sole ready cache and disables it when its heartbeat expires', async () => {
  vi.useFakeTimers();
  runtime.snapshot = snapshot(['only']);
  await act(render);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Build machine"]')!;
  expect(select.value).toBe('only');
  expect(launchButton().disabled).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(select.value).toBe('');
  expect(launchButton().disabled).toBe(true);
});

it('resumes an explicitly selected paused cache and waits for live authority before launch', async () => {
  runtime.snapshot = snapshot(['paused'], 'paused');
  const cache = runtime.snapshot.attachments[0]!;
  runtime.snapshot.attachments = [{ ...cache, state: 'attaching', cache: { ...cache.cache!, state: 'paused', pausedAt: new Date().toISOString() } }];
  await act(render);
  expect(launchButton().disabled).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Build machine"]')?.value).toBe('paused');
  expect(requestCache).not.toHaveBeenCalled();
  await act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Resume cache')!.click());
  expect(requestCache).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: 'paused', requestId: expect.any(String) });
  expect(launchButton().disabled).toBe(true);
  expect(launch).not.toHaveBeenCalled();
  runtime.snapshot = snapshot(['paused'], 'paused');
  await act(render);
  await act(() => launchButton().click());
  expect(launch).toHaveBeenCalledExactlyOnceWith('paused');
});

it('does not launch from a stale disconnected snapshot', async () => {
  runtime.snapshot = snapshot(['only']); runtime.connected = false;
  await act(render);
  expect(launchButton().disabled).toBe(true);
  await act(() => launchButton().click());
  expect(launch).not.toHaveBeenCalled();
});
