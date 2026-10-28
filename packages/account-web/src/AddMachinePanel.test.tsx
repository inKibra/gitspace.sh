// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeMachinePairingToken } from '@gitspace/protocol';
import { AddMachinePanel } from './AddMachinePanel.js';

const userId = `u-${'1'.repeat(32)}`;
const pairingId = '00000000-0000-4000-8000-000000000001';
const expiresAt = Date.now() + 600_000;
vi.mock('./device.js', () => ({
  DeviceRejectedError: class extends Error {},
  loadDevice: async () => ({ userId, deviceId: 'browser', canDelegate: true }),
  createDeviceSignedFetch: () => async (input: URL) => {
    const action = input.pathname.split('/').at(-1);
    const value = action === 'create' ? { pairingId, token: 'a'.repeat(43), expiresAt }
      : { pairingId, state: 'created', expiresAt, machine: null, grant: null, issuerChain: [] };
    return Response.json({ status: 'ok', value });
  },
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/settings?section=machines');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows one command that installs from this account and pairs with the generated token', async () => {
  await act(() => root.render(<AddMachinePanel machines={[]} onClose={() => {}} />));
  expect(container.textContent).toContain('Install Git and the OpenSSH client first.');
  const generate = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Generate pairing command');
  await act(async () => { generate!.click(); });
  const commands = [...container.querySelectorAll('mark')].map(mark => mark.textContent ?? '');
  expect(commands).toHaveLength(1);
  const match = /^curl -fsSL (\S+)\/install \| sh -s -- --pair (gsp_\S+)$/u.exec(commands[0]!);
  expect(match?.[1]).toBe(window.location.origin);
  expect(decodeMachinePairingToken(match![2]!)).toEqual({ version: 1, userId, pairingId, token: 'a'.repeat(43), apiUrl: `${window.location.origin}/`, expiresAt });
});
