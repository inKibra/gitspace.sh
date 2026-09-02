import { env } from 'cloudflare:test';
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

  it('pushes every persisted fleet transition to subscribers', async () => {
    const catalog = env.FLEET_CATALOG.getByName(`fleet-events-${crypto.randomUUID()}`);
    const response = await catalog.fetch('https://fleet.internal/events', { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const next = new Promise<Record<string, unknown>>((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true }));
    await catalog.putMachine({ id: 'sandbox-a', label: 'Build sandbox', state: 'resuming', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 2, operationId: 'resume-a', error: null });
    await expect(next).resolves.toMatchObject({ type: 'upsert', machineId: 'sandbox-a', machine: { state: 'resuming', operationId: 'resume-a' } });
    socket.close();
  });
});
