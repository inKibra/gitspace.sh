// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeServices } from './RuntimeServices.js';
const rpc = vi.hoisted(() => ({ services: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); rpc.services.mockReset(); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], attachments: [], tasks: [], questions: [], documents: {} });
it('routes duplicate service names to the chosen cache and renders its logs', async () => {
  const machines = ['a', 'b'].map(machineId => ({ machineId, attachmentId: `cache-${machineId}`, generation: 4, available: true, error: null, services: [{ name: 'web', source: 'declared', terminalName: 'web', state: 'ready', url: `https://web--workspace-${machineId}--test-srv.gssh.dev` }] }));
  rpc.services.mockResolvedValue({ status: 'ok', value: { op: 'list', machines } });
  await act(() => root.render(<RuntimeServices snapshot={snapshot} machines={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]} />));
  const beta = container.querySelector('[aria-label="Services on Beta"]')!;
  expect(beta.querySelector('a')?.getAttribute('href')).toBe('https://web--workspace-b--test-srv.gssh.dev');
  rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'logs', target: machines[1], log: { name: 'web', text: 'Beta service output' } } });
  await act(() => [...beta.querySelectorAll('button')].find(button => button.textContent === 'Logs')!.click());
  expect(rpc.services).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', command: { op: 'logs', name: 'web', source: 'declared', machineId: 'b', attachmentId: 'cache-b', generation: 4 } });
  expect(container.querySelector('[aria-label="Service logs"]')?.textContent).toContain('Beta service output');
});
it('shows unavailable machines without controls and an empty state with no caches', async () => {
  rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'list', machines: [{ machineId: 'offline', attachmentId: 'cache', generation: 1, available: false, error: 'Machine offline', services: [] }] } });
  await act(() => root.render(<RuntimeServices snapshot={snapshot} machines={[]} />));
  expect(container.querySelector('[aria-label="Services on offline"]')?.textContent).toContain('Machine offline');
  expect(container.querySelector('[aria-label="Services on offline"]')?.querySelector('button')).toBeNull();
  rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'list', machines: [] } });
  await act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh')!.click());
  expect(container.textContent).toContain('No machine caches attached');
});
