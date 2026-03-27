import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockWriteMachineIdentity = mock(() => undefined);

mock.module('../../core/identity.js', () => ({
  readMachineIdentity: mock(() => null),
  writeMachineIdentity: mockWriteMachineIdentity,
}));

const { persistMachineIdentityFromServe } = await import('../serve-machine-identity.js');

describe('persistMachineIdentityFromServe', () => {
  beforeEach(() => {
    mockWriteMachineIdentity.mockReset();
  });

  it('uses the existing machine name and registration time when present', () => {
    persistMachineIdentityFromServe({
      existingIdentity: {
        machineId: 'old-machine',
        machineName: 'Darktop',
        relayUrl: 'ws://old-relay/ws',
        registeredAt: '2026-01-01T00:00:00.000Z',
      },
      machineId: 'machine-1',
      relayUrl: 'ws://127.0.0.1:4480/ws',
      publicIdentity: {
        id: 'machine-1',
        signingPublicKey: 'signing',
        keyExchangePublicKey: 'exchange',
        label: 'Lightbook',
      },
    });

    expect(mockWriteMachineIdentity).toHaveBeenCalledWith({
      machineId: 'machine-1',
      machineName: 'Darktop',
      relayUrl: 'ws://127.0.0.1:4480/ws',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('falls back to the public identity label when no machine identity exists yet', () => {
    persistMachineIdentityFromServe({
      existingIdentity: null,
      machineId: 'machine-1',
      relayUrl: 'ws://127.0.0.1:4480/ws',
      publicIdentity: {
        id: 'machine-1',
        signingPublicKey: 'signing',
        keyExchangePublicKey: 'exchange',
        label: 'Lightbook',
      },
    });

    expect(mockWriteMachineIdentity).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      machineName: 'Lightbook',
      relayUrl: 'ws://127.0.0.1:4480/ws',
    }));
    expect(mockWriteMachineIdentity).toHaveBeenCalledTimes(1);
    const persistedIdentity = ((mockWriteMachineIdentity.mock.calls as unknown as Array<[ { registeredAt?: string } ]>)[0]?.[0]);
    expect(typeof persistedIdentity?.registeredAt).toBe('string');
  });
});
