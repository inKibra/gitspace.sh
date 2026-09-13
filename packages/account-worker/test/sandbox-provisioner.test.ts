import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from '../src/sandbox-provisioner.js';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';

describe('Cloudflare Sandbox tenant platform integration', () => {
  it('requests an enrolled runtime through the tenant provider and registers its fleet record', async () => {
    const userId = env.ACCOUNT_ID;
    const environment = { GITSPACE_MACHINE_ID: 'sandbox-build-a' };
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes`, ({ request }) => {
      if (request.headers.get('x-gitspace-provider-token') !== env.PLATFORM_TOKEN) return new HttpResponse(null, { status: 403 });
      return HttpResponse.json({ status: 'ok', machine: { id: 'sandbox-build-a', label: 'Cloudflare build-a', state: 'online', rpcEndpoint: 'https://sandbox.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'Machine runtime ready', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null } });
    }));
    const machine = await createCloudflareSandboxMachine({
      env,
      userId,
      machineId: 'sandbox-build-a',
      environment,
    });
    expect(machine).toMatchObject({ id: 'sandbox-build-a', kind: 'sandbox', state: 'online', rpcEndpoint: 'https://sandbox.example/rpc' });
    expect(await env.FLEET_CATALOG.getByName(userId).listMachines()).toContainEqual(machine);
  });

  it('does not register a failed service request', async () => {
    const userId = env.ACCOUNT_ID;
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes`, () => HttpResponse.json({ status: 'error', error: 'container failed readiness' }, { status: 503 })));
    await expect(createCloudflareSandboxMachine({
      env,
      userId,
      machineId: 'sandbox-broken',
      environment: { GITSPACE_MACHINE_ID: 'sandbox-broken' },
    })).rejects.toThrow(/failed readiness/u);
    expect(await env.FLEET_CATALOG.getByName(userId).listMachines()).toEqual([]);
  });
  it('routes sleep, resume, and destroy through the tenant provider', async () => {
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes/sandbox-a/:action`, ({ params, request }) => {
      if (request.headers.get('x-gitspace-provider-token') !== env.PLATFORM_TOKEN) return new HttpResponse(null, { status: 403 });
      const action = String(params.action);
      return HttpResponse.json({ status: 'ok', value: action === 'destroy' ? { machineId: 'sandbox-a' } : { id: 'sandbox-a', label: 'Sandbox A', state: action === 'sleep' ? 'offline' : 'online', rpcEndpoint: action === 'sleep' ? null : 'https://sandbox.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: action, desiredState: action === 'sleep' ? 'offline' : 'online', lifecycleRevision: 2, operationId: null, error: null } });
    }));
    expect(await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: 'sandbox-a', action: 'sleep' })).toMatchObject({ state: 'offline', rpcEndpoint: null });
    expect(await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: 'sandbox-a', action: 'resume' })).toMatchObject({ state: 'online', rpcEndpoint: 'https://sandbox.example/rpc' });
    expect(await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: 'sandbox-a', action: 'destroy' })).toBeNull();
  });
});
