// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, RuntimeWorkspaceStatusSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { MachineStatus } from './workspace-status.js';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeMachines } from './RuntimeMachines.js';

const rpc = vi.hoisted(() => ({ cache: vi.fn(), detach: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { attachment: { cache: { request: rpc.cache }, detach: rpc.detach } } } }));
vi.mock('./SynchronizationProvider.js', () => ({ useAccountMachines: () => ({ state: 'success', value: [{ id: 'runner', label: 'Runner workstation', state: 'online' }], refetch: vi.fn() }) }));
const stamp = '2026-10-03T00:00:00.000Z';
const commit = 'a'.repeat(40);
function fixture() { return RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, conversations: [], attachments: [], tasks: [], questions: [], documents: { 'gitspace.code': { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit } } }); }
function attach(snapshot: RuntimeSnapshot, status: Partial<Omit<MachineStatus, 'machineId'>> = {}) {
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp }));
  snapshot.documents['gitspace.status'] = RuntimeWorkspaceStatusSchema.parse({ cloud: { version: null, conflicts: [] }, machines: [{ machineId: 'runner', attachmentId: 'fixed', generation: 4, online: true, ready: true, setup: [], sync: { lastSyncAt: stamp, unsent: 0, unapplied: false, problem: null, conflicts: [] }, ...status }] });
}
let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  for (const mock of Object.values(rpc)) mock.mockReset().mockResolvedValue({ status: 'ok', value: {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('requires explicit LFS consent on an offline machine and cancels detach when committing first', async () => {
  const snapshot = fixture();
  const checkpoint = RuntimeGitCheckpointSchema.parse(snapshot.documents['gitspace.code']);
  snapshot.documents['gitspace.code'] = { ...checkpoint, lfs: { objects: [], heldBack: [{ path: 'assets/local.psd', kind: 'modified' }] } };
  attach(snapshot, { online: false, ready: false });
  const commitFirst = vi.fn();
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onCommitFirst={commitFirst} />));
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  await click('Detach');
  expect(document.body.textContent).toContain('assets/local.psd');
  expect(rpc.detach).not.toHaveBeenCalled();
  await click('Cancel');
  expect(rpc.detach).not.toHaveBeenCalled();
  await click('Detach');
  await click('Commit first');
  expect(commitFirst).toHaveBeenCalledTimes(1);
  expect(rpc.detach).not.toHaveBeenCalled();
  await click('Detach');
  await click('Continue without them');
  expect(rpc.detach).toHaveBeenCalledTimes(1);
  expect(rpc.detach).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4 });
});

it('shows setup failures and sync state from the workspace status without reporting ready', async () => {
  const snapshot = fixture();
  attach(snapshot, { ready: false, setup: [{ phase: 'machine/prepare', state: 'failed', runId: null, error: 'Workspace Hub lifecycle execution is unavailable' }], sync: { lastSyncAt: null, unsent: 2, unapplied: true, problem: 'push rejected', conflicts: ['src/a.ts'] } });
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  expect(container.querySelector('[aria-label="Machine setup results"] li')?.textContent).toBe('machine/prepare · failed · Workspace Hub lifecycle execution is unavailable');
  expect(container.querySelector('header [role="status"]')?.textContent).toContain('0 ready / 1 machines · Starting');
  expect(container.querySelector('[aria-label="Machine sync"]')?.textContent).toContain('2 unsent changes');
  expect(container.querySelector('[aria-label="Machine sync"]')?.textContent).toContain('Sync problem · push rejected');
  expect(container.querySelector('[aria-label="Sync conflicts"] li')?.textContent).toBe('src/a.ts');
});
