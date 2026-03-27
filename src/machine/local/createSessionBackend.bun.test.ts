import { beforeEach, describe, expect, it, mock } from 'bun:test';

let machineIdentity: { machineId: string } | null = null;
let relayConfig: { machineId?: string } | null = null;

mock.module('../../core/identity.js', () => ({
  readMachineIdentity: mock(() => machineIdentity),
  readRelayConfig: mock(() => relayConfig),
}));

const { createBunLocalSessionBackend } = await import('./createSessionBackend.bun.js');

describe('createBunLocalSessionBackend', () => {
  beforeEach(() => {
    machineIdentity = null;
    relayConfig = null;
  });

  it('uses machine identity machineId when available', () => {
    machineIdentity = { machineId: 'machine-from-identity' };
    relayConfig = { machineId: 'machine-from-relay' };

    const backend = createBunLocalSessionBackend('local');

    expect(backend.descriptor.machineId).toBe('machine-from-identity');
  });

  it('falls back to relay config machineId when machine identity is absent', () => {
    relayConfig = { machineId: 'machine-from-relay' };

    const backend = createBunLocalSessionBackend('local');

    expect(backend.descriptor.machineId).toBe('machine-from-relay');
  });
});
