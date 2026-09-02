import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from '../src/sandbox-provisioner.js';

describe('Cloudflare Sandbox service integration', () => {
  it('requests an enrolled runtime through the service binding and registers its fleet record', async () => {
    const userId = `sandbox-user-${crypto.randomUUID()}`;
    const requests: Array<Record<string, unknown>> = [];
    const environment = { GITSPACE_MACHINE_ID: 'sandbox-build-a' };
    const machine = await createCloudflareSandboxMachine({
      env,
      userId,
      machineId: 'sandbox-build-a',
      environment,
      service: { fetch: async (request) => {
        requests.push(await request.json() as Record<string, unknown>);
        return Response.json({ status: 'ok', machine: { id: 'sandbox-build-a', label: 'Cloudflare build-a', state: 'online', rpcEndpoint: 'https://sandbox.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'Machine runtime ready', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null } });
      } },
    });
    expect(requests).toEqual([{ userId, machineId: 'sandbox-build-a', environment }]);
    expect(machine).toMatchObject({ id: 'sandbox-build-a', kind: 'sandbox', state: 'online', rpcEndpoint: 'https://sandbox.example/rpc' });
    expect(await env.FLEET_CATALOG.getByName(userId).listMachines()).toContainEqual(machine);
  });

  it('does not register a failed service request', async () => {
    const userId = `sandbox-fail-${crypto.randomUUID()}`;
    await expect(createCloudflareSandboxMachine({
      env,
      userId,
      machineId: 'sandbox-broken',
      environment: { GITSPACE_MACHINE_ID: 'sandbox-broken' },
      service: { fetch: async () => Response.json({ status: 'error', error: 'container failed readiness' }, { status: 503 }) },
    })).rejects.toThrow(/failed readiness/u);
    expect(await env.FLEET_CATALOG.getByName(userId).listMachines()).toEqual([]);
  });
  it('routes sleep, resume, and destroy through the same provider binding', async () => {
    const requests: Array<{ path: string; userId: string | null }> = [];
    const service = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, userId: request.headers.get('x-gitspace-user-id') });
      const action = url.pathname.split('/').at(-1);
      return Response.json({ status: 'ok', value: action === 'destroy' ? { machineId: 'sandbox-a' } : { id: 'sandbox-a', label: 'Sandbox A', state: action === 'sleep' ? 'offline' : 'online', rpcEndpoint: action === 'sleep' ? null : 'https://sandbox.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: action, desiredState: action === 'sleep' ? 'offline' : 'online', lifecycleRevision: 2, operationId: null, error: null } });
    } };
    expect(await controlCloudflareSandboxMachine({ env, userId: 'user-a', machineId: 'sandbox-a', action: 'sleep', service })).toMatchObject({ state: 'offline' });
    expect(await controlCloudflareSandboxMachine({ env, userId: 'user-a', machineId: 'sandbox-a', action: 'resume', service })).toMatchObject({ state: 'online' });
    expect(await controlCloudflareSandboxMachine({ env, userId: 'user-a', machineId: 'sandbox-a', action: 'destroy', service })).toBeNull();
    expect(requests).toEqual([
      { path: '/v1/sandboxes/sandbox-a/sleep', userId: 'user-a' },
      { path: '/v1/sandboxes/sandbox-a/resume', userId: 'user-a' },
      { path: '/v1/sandboxes/sandbox-a/destroy', userId: 'user-a' },
    ]);
  });
});
