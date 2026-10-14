import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64 } from '@gitspace/protocol';
import { describe, expect, it } from 'vitest';

describe('fleet machine metadata', () => {
  it('persists shared machine notes, sandbox kind and whether agents may attach it', async () => {
    const catalog = env.FLEET_CATALOG.getByName(`fleet-${crypto.randomUUID()}`);
    await catalog.putMachine({ id: 'machine-a', label: 'Darktop', state: 'online', rpcEndpoint: null, kind: 'physical', provider: 'physical', notes: 'Bun and Android SDK', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null });
    await catalog.putMachine({ id: 'sandbox-a', label: 'Build sandbox', state: 'offline', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'No production credentials', desiredState: 'offline', lifecycleRevision: 1, operationId: null, error: null });
    expect(await catalog.listMachines()).toEqual([
      { id: 'machine-a', label: 'Darktop', state: 'online', rpcEndpoint: null, kind: 'physical', provider: 'physical', notes: 'Bun and Android SDK', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null },
      { id: 'sandbox-a', label: 'Build sandbox', state: 'offline', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'No production credentials', desiredState: 'offline', lifecycleRevision: 1, operationId: null, error: null },
    ]);
    const darktop = await catalog.getMachine('machine-a');
    if (!darktop) throw new Error('Darktop missing');
    // Forbidding agents is a change of its own, and so is allowing them again.
    await catalog.putMachine({ ...darktop, agentsMayAttach: false });
    expect(await catalog.getMachine('machine-a')).toMatchObject({ agentsMayAttach: false });
    await catalog.putMachine({ ...darktop, agentsMayAttach: true });
    expect(await catalog.getMachine('machine-a')).toMatchObject({ agentsMayAttach: true });
  });

});
