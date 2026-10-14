// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { LaunchMachineDialog } from './LaunchSheet.js';

const runtime = vi.hoisted((): { snapshot: RuntimeSnapshot | null; connected: boolean; error: string | null; retry: () => void } => ({ snapshot: null, connected: true, error: null, retry: vi.fn() }));
vi.mock('./useWorkspaceRuntime.js', () => ({ useWorkspaceRuntime: () => runtime }));
const launch = vi.fn(async (_machineId: string) => {});
const close = vi.fn();
let root: Root;
let container: HTMLDivElement;
function snapshot(ids: string[]): RuntimeSnapshot {
  const now = new Date().toISOString();
  return RuntimeSnapshotSchema.parse({
    version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], tasks: [], questions: [],
    documents: { 'gitspace.status': { cloud: { version: null, conflicts: [] }, machines: ids.map(machineId => ({ machineId, attachmentId: machineId, generation: 1, online: true, ready: true, setup: [], sync: { lastSyncAt: now, unsent: 0, unapplied: false, problem: null, conflicts: [] } })) } },
    attachments: ids.map(machineId => ({ projectId: 'project', workspaceId: 'workspace', attachmentId: machineId, machineId, generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'work' }, capabilities: [], updatedAt: now, heartbeatAt: now })),
  });
}
const render = () => root.render(<LaunchMachineDialog projectId="project" workspaceId="workspace" machines={[]} onClose={close} onLaunch={launch} />);
const launchButton = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Launch')!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  runtime.snapshot = snapshot([]); runtime.connected = true; runtime.error = null;
  launch.mockClear(); close.mockClear();
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

it('does not launch from a stale disconnected snapshot', async () => {
  runtime.snapshot = snapshot(['only']); runtime.connected = false;
  await act(render);
  expect(launchButton().disabled).toBe(true);
  await act(() => launchButton().click());
  expect(launch).not.toHaveBeenCalled();
});
