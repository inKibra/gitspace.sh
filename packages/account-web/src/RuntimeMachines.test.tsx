// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeMachines } from './RuntimeMachines.js';

const rpc = vi.hoisted(() => ({ request: vi.fn(), primary: vi.fn(), detach: vi.fn(), executionMachine: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { attachment: { request: rpc.request, primary: { request: rpc.primary }, detach: rpc.detach }, executionMachine: rpc.executionMachine } } }));
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
  vi.unstubAllGlobals();
});

it('attaches a private runner from the published runtime code checkpoint', async () => {
  const snapshot = fixture();
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
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
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'replica', machineId: 'runner', generation: 4, role: 'replica', checkout: { kind: 'branch', branch: 'main', commit }, state: 'ready', capabilities: [], updatedAt: stamp }));
  snapshot.conversations.push({ id: 'agent', parentId: null, title: 'Review agent', status: 'idle', messages: [] });
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-describedby="execution-machine-help"]')!;
  await act(() => { select.value = 'runner'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(rpc.executionMachine).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: 'runner' });
  expect(select.value).toBe('');
  snapshot.documents['gitspace.execution'] = { defaultMachineId: 'runner' };
  await act(() => root.render(<RuntimeMachines snapshot={{ ...snapshot, cursor: 2 }} onSelectConversation={() => {}} />));
  expect(select.value).toBe('runner');
  expect(container.querySelector('[aria-label="Working copy for Review agent"]')).toBeNull();
  await act(() => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(rpc.executionMachine).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: null });
});

it('offers syncing replicas but excludes pinned runners from the workspace default', async () => {
  const snapshot = fixture();
  for (const [machineId, role] of [['replica-machine', 'replica'], ['pinned-machine', 'runner']] as const) {
    snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: machineId, machineId, generation: 1, role, checkout: role === 'replica' ? { kind: 'branch', branch: 'replica', commit } : { kind: 'snapshot', commit }, state: 'ready', capabilities: [], updatedAt: stamp }));
  }
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-describedby="execution-machine-help"]')!;
  expect([...select.options].map(option => option.value)).toEqual(['', 'replica-machine']);
  await act(() => { select.value = 'replica-machine'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(rpc.executionMachine).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: 'replica-machine' });
});

it('attaches a private syncing replica from the cloud checkpoint rather than a pinned runner', async () => {
  await act(() => root.render(<RuntimeMachines snapshot={fixture()} onSelectConversation={() => {}} />));
  const machine = container.querySelector<HTMLSelectElement>('[aria-label="Enrolled machine"]')!;
  const checkout = container.querySelector<HTMLSelectElement>('[aria-label="Working copy"]')!;
  await act(() => { machine.value = 'runner'; machine.dispatchEvent(new Event('change', { bubbles: true })); checkout.value = 'replica'; checkout.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(rpc.request).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', workspaceId: 'workspace', machineId: 'runner', role: 'replica', sourceRef: 'refs/gitspace/checkpoint', checkout: { kind: 'branch', commit, branch: expect.stringMatching(/^gitspace\/replica\//u) } }));
});

it('retains the accepted default and reports a rejected execution change', async () => {
  const snapshot = fixture();
  snapshot.documents['gitspace.execution'] = { defaultMachineId: 'runner' };
  rpc.executionMachine.mockResolvedValueOnce({ status: 'error', error: new Error('Replica is not ready') });
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-describedby="execution-machine-help"]')!;
  await act(() => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(select.value).toBe('runner');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Replica is not ready');
});

it('requests a program replica without inventing a checkpoint', async () => {
  const snapshot = fixture();
  snapshot.documents = {};
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  const machine = container.querySelector<HTMLSelectElement>('[aria-label="Enrolled machine"]')!;
  const checkout = container.querySelector<HTMLSelectElement>('[aria-label="Working copy"]')!;
  await act(() => {
    machine.value = 'runner'; machine.dispatchEvent(new Event('change', { bubbles: true }));
    checkout.value = 'primary'; checkout.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  rpc.primary.mockResolvedValueOnce({ status: 'error', error: new Error('Machine is not ready') });
  await act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Machine is not ready');
  expect(rpc.request).not.toHaveBeenCalled();
  expect(snapshot.attachments).toEqual([]);
});

it('requests fenced detach and retains the working copy until the runtime confirms cleanup', async () => {
  const snapshot = fixture();
  const attachment = RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, role: 'runner', checkout: { kind: 'snapshot', commit }, state: 'ready', capabilities: [], updatedAt: stamp });
  snapshot.attachments.push(attachment);
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  const detach = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Detach')!;
  await act(() => detach.click());
  expect(rpc.detach).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4 });
  expect(container.textContent).toContain('runner · ready');
  attachment.state = 'draining';
  await act(() => root.render(<RuntimeMachines snapshot={{ ...snapshot, cursor: 2 }} onSelectConversation={() => {}} />));
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Detaching…')?.disabled).toBe(true);
});

it('requires explicit LFS consent on a lost machine and cancels detach when committing first', async () => {
  const snapshot = fixture();
  const checkpoint = RuntimeGitCheckpointSchema.parse(snapshot.documents['gitspace.code']);
  snapshot.documents['gitspace.code'] = { ...checkpoint, lfs: { objects: [], heldBack: [{ path: 'assets/local.psd', kind: 'modified' }] } };
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, role: 'runner', checkout: { kind: 'snapshot', commit }, state: 'lost', capabilities: [], updatedAt: stamp }));
  const commitFirst = vi.fn();
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} onCommitFirst={commitFirst} />));
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
