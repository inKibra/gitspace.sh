// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeBrowserApprovalCard } from '@gitspace/protocol-runtime';
import { BrowserApprovalCard } from './RuntimeBrowser.js';
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { session: vi.fn() } } }));
let root: Root;
let container: HTMLDivElement;
const request = (): RuntimeBrowserApprovalCard => ({
  id: 'preparation', groupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', machineId: 'machine', attachmentId: 'attachment', generation: 1,
  groupName: '<script>workspace</script>', origins: ['example.test'], source: 'relay', expiresAt: new Date(Date.now() + 60_000).toISOString(), action: 'open', requiresApproval: true,
});
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function button(label: string) { const result = [...container.querySelectorAll('button')].find(item => item.textContent === label); if (!result) throw new Error(`Missing ${label}`); return result; }
it('renders approved group scope as text and permits rejection without selecting a tab', async () => {
  const answer = vi.fn(async (_approved: boolean) => {});
  await act(() => root.render(<BrowserApprovalCard request={request()} connected machineName="My workstation" onAnswer={answer} />));
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('select')).toBeNull();
  expect(container.textContent).toContain('<script>workspace</script>');
  expect(container.textContent).toContain('example.test');
  await act(() => button('Reject').click());
  expect(answer.mock.calls).toEqual([[false]]);
});
it('prevents expired or disconnected approval while preserving retry after an answer request fails', async () => {
  const answer = vi.fn(async (_approved: boolean): Promise<void> => { throw new Error('Approval service unavailable'); });
  const card = request();
  await act(() => root.render(<BrowserApprovalCard request={card} connected onAnswer={answer} />));
  await act(() => button('Create browser group').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Approval service unavailable');
  expect(button('Create browser group').disabled).toBe(false);
  answer.mockResolvedValue(undefined);
  await act(() => button('Create browser group').click());
  expect(answer.mock.calls).toEqual([[true], [true]]);
  await act(() => root.render(<BrowserApprovalCard request={{ ...card, expiresAt: new Date(Date.now() - 60_000).toISOString() }} connected onAnswer={answer} />));
  expect(button('Create browser group').disabled).toBe(true);
  await act(() => button('Create browser group').click());
  expect(answer).toHaveBeenCalledTimes(2);
  await act(() => root.render(<BrowserApprovalCard request={card} connected={false} onAnswer={answer} />));
  expect(button('Create browser group').disabled).toBe(true);
  expect(button('Reject').disabled).toBe(true);
});
