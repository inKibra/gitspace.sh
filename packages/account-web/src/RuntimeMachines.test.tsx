// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeMachines } from './RuntimeMachines.js';

const rpc = vi.hoisted(() => ({ request: vi.fn(), primary: vi.fn(), detach: vi.fn(), placement: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { attachment: { request: rpc.request, primary: { request: rpc.primary }, detach: rpc.detach }, placement: rpc.placement } } }));
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
  const machine = container.querySelector<HTMLSelectElement>('select');
  expect(machine).not.toBeNull();
  await act(() => { machine!.value = 'runner'; machine!.dispatchEvent(new Event('change', { bubbles: true })); });
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(submit?.disabled).toBe(false);
  await act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(rpc.request).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', workspaceId: 'workspace', machineId: 'runner', sourceRef: 'refs/gitspace/checkpoint', checkout: { kind: 'snapshot', commit } }));
});

it('does not silently move a conversation after its executor disconnects', async () => {
  const snapshot = fixture();
  snapshot.attachments.push(RuntimeSnapshotSchema.shape.attachments.element.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'fixed', machineId: 'runner', generation: 4, role: 'runner', checkout: { kind: 'snapshot', commit }, state: 'lost', capabilities: [], updatedAt: stamp }));
  snapshot.conversations.push({ id: 'agent', parentId: null, title: 'Review agent', status: 'idle', placement: { attachmentId: 'fixed', generation: 4 }, messages: [] });
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Working copy for Review agent"]')?.disabled).toBe(true);
  expect(container.textContent).toContain('runner · lost');
  expect(rpc.placement).not.toHaveBeenCalled();
});

it('requests primary without inventing a checkpoint or moving canonical ownership', async () => {
  const snapshot = fixture();
  snapshot.documents = {};
  await act(() => root.render(<RuntimeMachines snapshot={snapshot} onSelectConversation={() => {}} />));
  const selects = container.querySelectorAll<HTMLSelectElement>('select');
  await act(() => {
    selects[0]!.value = 'runner'; selects[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    selects[1]!.value = 'primary'; selects[1]!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  rpc.primary.mockResolvedValueOnce({ status: 'error', error: new Error('Canonical holder does not match') });
  await act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Canonical holder does not match');
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
