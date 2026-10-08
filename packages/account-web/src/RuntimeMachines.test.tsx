// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeMachines } from './RuntimeMachines.js';

const rpc = vi.hoisted(() => ({ request: vi.fn(), cache: vi.fn(), action: vi.fn(), detach: vi.fn(), executionMachine: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { attachment: { request: rpc.request, cache: { request: rpc.cache }, action: rpc.action, detach: rpc.detach }, executionMachine: rpc.executionMachine } } }));
vi.mock('./SynchronizationProvider.js', () => ({ useAccountMachines: () => ({ state: 'success', value: [{ id: 'runner', label: 'Runner workstation', state: 'online' }], refetch: vi.fn() }) }));
const stamp = '2026-10-03T00:00:00.000Z';
const commit = 'a'.repeat(40);
function fixture() { return RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, conversations: [], attachments: [], tasks: [], questions: [], documents: { 'gitspace.code': { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit } } }); }
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

it('attaches a private runner from the published runtime code checkpoint', async () => {
  const snapshot = fixture();
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  const source = container.querySelector<HTMLSelectElement>('[aria-label="Working copy"]')!;
  await act(() => { source.value = 'snapshot'; source.dispatchEvent(new Event('change', { bubbles: true })); });
  const machine = container.querySelector<HTMLSelectElement>('[aria-label="Enrolled machine"]');
  expect(machine).not.toBeNull();
  await act(() => { machine!.value = 'runner'; machine!.dispatchEvent(new Event('change', { bubbles: true })); });
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(submit?.disabled).toBe(false);
  await act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(rpc.request).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', workspaceId: 'workspace', machineId: 'runner', sourceRef: 'refs/gitspace/checkpoint', checkout: { kind: 'snapshot', commit } }));
});

it('changes the workspace default without assigning a conversation and restores automatic selection', async () => {
  const snapshot = fixture();
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'runner', generation: 4, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp }));
  snapshot.conversations.push({ id: 'agent', parentId: null, title: 'Review agent', status: 'idle', messages: [] });
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-describedby="execution-machine-help"]')!;
  await act(() => { select.value = 'runner'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(rpc.executionMachine).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: 'runner' });
  expect(select.value).toBe('');
  snapshot.documents['gitspace.execution'] = { defaultMachineId: 'runner' };
  await act(() => root.render(<RuntimeMachines snapshot={{ ...snapshot, cursor: 2 }} />));
  expect(select.value).toBe('runner');
  expect(container.querySelector('[aria-label="Working copy for Review agent"]')).toBeNull();
  await act(() => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(rpc.executionMachine).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: null });
});

it('offers syncing caches but excludes pinned runners from the workspace default', async () => {
  const snapshot = fixture();
  for (const [machineId, role] of [['cache-machine', 'cache'], ['pinned-machine', 'runner']] as const) {
    snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: machineId, machineId, generation: 1, role, checkout: role === 'cache' ? { kind: 'shared', branch: 'main' } : { kind: 'snapshot', commit }, state: 'ready', capabilities: [], updatedAt: stamp }));
  }
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-describedby="execution-machine-help"]')!;
  expect([...select.options].map(option => option.value)).toEqual(['', 'cache-machine']);
  await act(() => { select.value = 'cache-machine'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(rpc.executionMachine).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: 'cache-machine' });
});

it('retains the accepted default and reports a rejected execution change', async () => {
  const snapshot = fixture();
  snapshot.documents['gitspace.execution'] = { defaultMachineId: 'runner' };
  rpc.executionMachine.mockResolvedValueOnce({ status: 'error', error: new Error('Cache is not ready') });
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-describedby="execution-machine-help"]')!;
  await act(() => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(select.value).toBe('runner');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Cache is not ready');
});

it('requests a workspace cache without inventing a checkpoint', async () => {
  const snapshot = fixture();
  snapshot.documents = {};
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  const machine = container.querySelector<HTMLSelectElement>('[aria-label="Enrolled machine"]')!;
  const checkout = container.querySelector<HTMLSelectElement>('[aria-label="Working copy"]')!;
  await act(() => {
    machine.value = 'runner'; machine.dispatchEvent(new Event('change', { bubbles: true }));
    checkout.value = 'cache'; checkout.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  rpc.cache.mockResolvedValueOnce({ status: 'error', error: new Error('Machine is not ready') });
  await act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Machine is not ready');
  expect(rpc.request).not.toHaveBeenCalled();
  expect(snapshot.attachments).toEqual([]);
});

it('requests fenced detach and retains the working copy until the runtime confirms cleanup', async () => {
  const snapshot = fixture();
  const attachment = RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, role: 'runner', checkout: { kind: 'snapshot', commit }, state: 'ready', capabilities: [], updatedAt: stamp });
  snapshot.attachments.push(attachment);
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  const detach = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Detach')!;
  await act(() => detach.click());
  expect(rpc.detach).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4 });
  expect(container.textContent).toContain('Runner workstation');
  attachment.state = 'draining';
  await act(() => root.render(<RuntimeMachines snapshot={{ ...snapshot, cursor: 2 }} />));
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Detaching…')?.disabled).toBe(true);
});

it('requires explicit LFS consent on a lost machine and cancels detach when committing first', async () => {
  const snapshot = fixture();
  const checkpoint = RuntimeGitCheckpointSchema.parse(snapshot.documents['gitspace.code']);
  snapshot.documents['gitspace.code'] = { ...checkpoint, lfs: { objects: [], heldBack: [{ path: 'assets/local.psd', kind: 'modified' }] } };
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, role: 'runner', checkout: { kind: 'snapshot', commit }, state: 'lost', capabilities: [], updatedAt: stamp }));
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
  expect(rpc.detach).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, discardHeldBack: true });
});

it('shows paused cache and setup approval blockers beside its machine without reporting ready', async () => {
  const snapshot = fixture();
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'runner', generation: 4,
    role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp,
    cache: { state: 'paused', platform: 'linux', activity: [], lastActivityAt: stamp, pausedAt: stamp, reclaimAt: '2026-10-04T00:00:00.000Z', lastSyncAt: stamp, localWorkOptIn: false, setup: [{ phase: 'checks', state: 'waiting-for-approval', runId: null }] },
  }));
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  expect(container.textContent).toContain('Paused since');
  expect(container.textContent).toContain('Waiting approval');
  expect(container.textContent).toContain('checks');
  expect(container.textContent).toContain('Last sync');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Work locally on Runner workstation"]')?.checked).toBe(false);
  const click = async (label: string) => { await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click()); };
  await click('Setup again');
  expect(rpc.action).toHaveBeenLastCalledWith(expect.objectContaining({ attachmentId: 'cache', generation: 4, action: { kind: 'setup' } }));
  await click('Reclaim now');
  expect(rpc.action).toHaveBeenLastCalledWith(expect.objectContaining({ attachmentId: 'cache', generation: 4, action: { kind: 'reclaim' } }));
  await act(() => container.querySelector<HTMLInputElement>('[aria-label="Work locally on Runner workstation"]')!.click());
  expect(rpc.action).toHaveBeenLastCalledWith(expect.objectContaining({ attachmentId: 'cache', generation: 4, action: { kind: 'local-work', enabled: true } }));
});

it('shows why a machine setup step failed', async () => {
  const snapshot = fixture();
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'runner', generation: 4,
    role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: [], updatedAt: stamp, heartbeatAt: stamp,
    cache: { state: 'setup', platform: 'linux', activity: [], lastActivityAt: stamp, pausedAt: null, reclaimAt: null, lastSyncAt: stamp, localWorkOptIn: false, setup: [{ phase: 'machine/prepare', state: 'failed', runId: null, error: 'Workspace Hub lifecycle execution is unavailable' }] },
  }));
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} />));
  expect(container.querySelector('[aria-label="Machine setup progress"] [role="status"]')?.textContent).toBe('Workspace Hub lifecycle execution is unavailable');
});


it('requires an explicit continue for reclaim and never reuses consent on the next request', async () => {
  const snapshot = fixture();
  const checkpoint = RuntimeGitCheckpointSchema.parse(snapshot.documents['gitspace.code']);
  snapshot.documents['gitspace.code'] = { ...checkpoint, lfs: { objects: [], heldBack: [{ path: 'assets/local.psd', kind: 'modified' }] } };
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'runner', generation: 4, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp, cache: { state: 'paused', platform: 'linux', activity: [], lastActivityAt: stamp, pausedAt: stamp, reclaimAt: null, lastSyncAt: stamp, localWorkOptIn: false, setup: [], reclaimBlocked: 'Uncommitted LFS changes prevent safe reclamation' } }));
  const commitFirst = vi.fn();
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onCommitFirst={commitFirst} />));
  expect(container.querySelector('[aria-label="Machine Runner workstation"] [role="alert"]')?.textContent).toContain('Uncommitted LFS changes prevent safe reclamation');
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  await click('Reclaim now');
  expect(rpc.action).not.toHaveBeenCalled();
  await click('Commit first');
  expect(commitFirst).toHaveBeenCalledTimes(1);
  expect(rpc.action).not.toHaveBeenCalled();
  await click('Reclaim now');
  await click('Continue without them');
  expect(rpc.action).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'cache', generation: 4, action: { kind: 'reclaim', discardHeldBack: true } }));
  await click('Reclaim now');
  await click('Cancel');
  expect(rpc.action).toHaveBeenCalledTimes(1);
  snapshot.documents['gitspace.code'] = checkpoint;
  const cache = snapshot.attachments[0]!.cache!;
  cache.reclaimBlocked = null;
  await act(() => root.render(<RuntimeMachines snapshot={{ ...snapshot, cursor: 2 }} onCommitFirst={commitFirst} />));
  await click('Reclaim now');
  expect(rpc.action).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: 'reclaim' } }));
});

it.each(['Reclaim now', 'Detach'])('requires fresh consent for %s when only the local cache reports held-back LFS', async label => {
  const snapshot = fixture();
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'runner', generation: 4, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp, cache: { state: 'paused', platform: 'linux', activity: [], lastActivityAt: stamp, pausedAt: stamp, reclaimAt: null, lastSyncAt: stamp, localWorkOptIn: false, setup: [], reclaimBlocked: 'Uncommitted LFS changes: assets/local-only.psd' } }));
  const commitFirst = vi.fn();
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onCommitFirst={commitFirst} />));
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  await click(label);
  expect(rpc.action).not.toHaveBeenCalled();
  expect(rpc.detach).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('assets/local-only.psd');
  await click('Commit first');
  expect(commitFirst).toHaveBeenCalledTimes(1);
  expect(rpc.action).not.toHaveBeenCalled();
  expect(rpc.detach).not.toHaveBeenCalled();
  await click(label);
  await click('Continue without them');
  if (label === 'Detach') expect(rpc.detach).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'cache', discardHeldBack: true }));
  else expect(rpc.action).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'cache', action: { kind: 'reclaim', discardHeldBack: true } }));
  await click(label);
  await click('Cancel');
  expect(rpc.action.mock.calls.length + rpc.detach.mock.calls.length).toBe(1);
});
