// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeServiceMachineSchema, RuntimeServiceSchema, type RuntimeService, type RuntimeServiceResult } from '@gitspace/protocol-runtime/services';
import { RuntimeServices } from './RuntimeServices.js';
const rpc = vi.hoisted(() => ({ services: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); rpc.services.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], attachments: [], tasks: [], questions: [], documents: {} });
it('routes duplicate service names to the chosen machine and renders its logs', async () => {
  const machines = ['a', 'b'].map(machineId => ({ machineId, attachmentId: `cache-${machineId}`, generation: 4, available: true, error: null, services: [{ name: 'web', source: 'declared', terminalName: 'web', state: 'ready', url: `https://web--workspace-${machineId}--test-srv.gssh.dev` }] }));
  rpc.services.mockResolvedValue({ status: 'ok', value: { op: 'list', machines } });
  await act(async () => root.render(<RuntimeServices snapshot={snapshot} machines={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]} />));
  const beta = container.querySelector('[aria-label="Services on Beta"]')!;
  expect(beta.querySelector('a')?.getAttribute('href')).toBe('https://web--workspace-b--test-srv.gssh.dev');
  rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'logs', target: machines[1], log: { name: 'web', text: 'Beta service output' } } });
  await act(async () => [...beta.querySelectorAll('button')].find(button => button.textContent === 'Logs')!.click());
  expect(rpc.services).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', command: { op: 'logs', name: 'web', source: 'declared', machineId: 'b', attachmentId: 'cache-b', generation: 4 } });
  expect(container.querySelector('[aria-label="Service logs"]')?.textContent).toContain('Beta service output');
});
it('shows unavailable machines without controls and clears inventory when no machines remain', async () => {
  rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'list', machines: [{ machineId: 'offline', attachmentId: 'cache', generation: 1, available: false, error: 'Machine offline', services: [] }] } });
  await act(async () => root.render(<RuntimeServices snapshot={snapshot} machines={[]} />));
  expect(container.querySelector('[aria-label="Services on offline"]')?.textContent).toContain('Machine offline');
  expect(container.querySelector('[aria-label="Services on offline"]')?.querySelector('button')).toBeNull();
  rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'list', machines: [] } });
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh')!.click());
  expect(container.querySelector('[aria-label="Services on offline"]')).toBeNull();
  expect([...container.querySelectorAll('button')].map(item => item.textContent)).toEqual(['Refresh']);
});

const stateControls = {
  running: { enabled: ['Stop', 'Restart', 'Logs'], progress: false },
  ready: { enabled: ['Stop', 'Restart', 'Logs'], progress: false },
  stopped: { enabled: ['Start', 'Logs'], progress: false },
  exited: { enabled: ['Start', 'Logs'], progress: false },
  failed: { enabled: ['Start', 'Logs'], progress: false },
  starting: { enabled: ['Logs'], progress: true },
  stopping: { enabled: ['Logs'], progress: true },
  restarting: { enabled: ['Logs'], progress: true },
} satisfies Record<RuntimeService['state'], { enabled: string[]; progress: boolean }>;

function inventory(source: RuntimeService['source'], state: RuntimeService['state'], available = true) {
  return RuntimeServiceMachineSchema.parse({
    machineId: 'alpha', attachmentId: 'attachment-alpha', generation: 1,
    available, error: available ? null : 'Machine offline',
    services: [{ name: 'web', source, terminalName: 'web', state, url: null }],
  });
}
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}
async function renderInventory(machine: Extract<RuntimeServiceResult, { op: 'list' }>['machines'][number]) {
  rpc.services.mockResolvedValue({ status: 'ok', value: { op: 'list', machines: [machine] } });
  await act(async () => root.render(<RuntimeServices snapshot={snapshot} machines={[{ id: 'alpha', label: 'Alpha' }]} />));
}
for (const source of RuntimeServiceSchema.shape.source.options) {
  for (const [rawState, expected] of Object.entries(stateControls)) {
    const state = RuntimeServiceSchema.shape.state.parse(rawState);
    it(`offers only state-appropriate actions for ${source} ${state}`, async () => {
      await renderInventory(inventory(source, state));
      for (const label of ['Start', 'Stop', 'Restart', 'Logs']) {
        expect(button(label).disabled, label).toBe(!expected.enabled.includes(label));
      }
      const progress = container.querySelector('[role="status"]');
      if (expected.progress) expect(progress?.textContent?.toLowerCase()).toContain(state);
      else expect(progress).toBeNull();
    });
  }
  it(`disables every ${source} service control offline while allowing inventory refresh`, async () => {
    await renderInventory(inventory(source, 'ready', false));
    for (const label of ['Start', 'Stop', 'Restart', 'Logs']) expect(button(label).disabled, label).toBe(true);
    expect(container.textContent).toContain('Machine offline');
    expect(button('Refresh').disabled).toBe(false);
    rpc.services.mockClear();
    await act(async () => button('Refresh').click());
    expect(rpc.services).toHaveBeenCalledTimes(1);
  });
  it(`blocks conflicting controls while a ${source} operation is pending and refreshes availability afterward`, async () => {
    await renderInventory(inventory(source, 'stopped'));
    const operation = Promise.withResolvers<{ status: 'ok'; value: RuntimeServiceResult }>();
    rpc.services.mockImplementationOnce(() => operation.promise);
    rpc.services.mockResolvedValue({ status: 'ok', value: { op: 'list', machines: [inventory(source, 'running')] } });
    await act(async () => button('Start').click());
    for (const label of ['Start', 'Stop', 'Restart', 'Refresh']) expect(button(label).disabled, label).toBe(true);
    expect(button('Logs').disabled).toBe(false);
    rpc.services.mockResolvedValueOnce({ status: 'ok', value: { op: 'logs', target: inventory(source, 'starting'), log: { name: 'web', text: 'Listening for startup progress' } } });
    await act(async () => button('Logs').click());
    expect(container.querySelector('[aria-label="Service logs"]')?.textContent).toContain('Listening for startup progress');
    expect(button('Start').disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Starting');
    await act(async () => { operation.resolve({ status: 'ok', value: { op: 'start', target: inventory(source, 'running'), service: RuntimeServiceSchema.parse({ name: 'web', source, terminalName: 'web', state: 'running', url: null }) } }); });
    expect(button('Start').disabled).toBe(true);
    for (const label of ['Stop', 'Restart', 'Logs', 'Refresh']) expect(button(label).disabled, label).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
}
