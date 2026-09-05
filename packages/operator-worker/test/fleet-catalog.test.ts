import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64 } from '@gitspace/protocol';
import { describe, expect, it } from 'vitest';

describe('fleet machine metadata', () => {
  it('persists shared machine notes and sandbox kind', async () => {
    const catalog = env.FLEET_CATALOG.getByName(`fleet-${crypto.randomUUID()}`);
    await catalog.putMachine({ id: 'machine-a', label: 'Darktop', state: 'online', rpcEndpoint: null, kind: 'physical', provider: 'physical', notes: 'Bun and Android SDK', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null });
    await catalog.putMachine({ id: 'sandbox-a', label: 'Build sandbox', state: 'offline', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'No production credentials', desiredState: 'offline', lifecycleRevision: 1, operationId: null, error: null });
    expect(await catalog.listMachines()).toEqual([
      { id: 'machine-a', label: 'Darktop', state: 'online', rpcEndpoint: null, kind: 'physical', provider: 'physical', notes: 'Bun and Android SDK', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null },
      { id: 'sandbox-a', label: 'Build sandbox', state: 'offline', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'No production credentials', desiredState: 'offline', lifecycleRevision: 1, operationId: null, error: null },
    ]);
  });

  it('pushes a persisted fleet transition to an authenticated subscriber', async () => {
    const userId = `fleet-events-${crypto.randomUUID()}`;
    const signingPrivateKey = ed25519.utils.randomSecretKey();
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey())),
      vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))),
    });
    await vault.registerManagedDevice({
      userId,
      machineId: 'subscriber-machine',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(x25519.utils.randomSecretKey())),
      capabilities: ['space.control'],
    });
    await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle: `fleet-${crypto.randomUUID().slice(0, 8)}` });
    await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
    const catalog = env.FLEET_CATALOG.getByName(userId);
    const proof = createSignedControlRequest({ userId, machineId: 'subscriber-machine', operation: 'catalog.machine.subscribe', payload: {}, signingPrivateKey });
    const response = await SELF.fetch(`https://auth.test/v1/fleet/events?control=${encodeURIComponent(btoa(JSON.stringify(proof)))}`, { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const { promise: next, resolve } = Promise.withResolvers<Record<string, unknown>>();
    socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    await catalog.putMachine({ id: 'sandbox-a', label: 'Build sandbox', state: 'resuming', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 2, operationId: 'resume-a', error: null });
    await expect(next).resolves.toMatchObject({ type: 'upsert', machineId: 'sandbox-a', machine: { state: 'resuming', operationId: 'resume-a' } });
    socket.close();
  });
});
