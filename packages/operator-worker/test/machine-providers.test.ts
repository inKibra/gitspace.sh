import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { assertMachineHasNoOpenSpaces } from '../src/index.js';
import { CloudflareSandboxMachineProvider, PhysicalMachineProvider } from '../src/machine-providers.js';
import { reconcileFleetMachines } from '../src/index.js';
import type { FleetMachineDefinition } from '../src/fleet-catalog.js';

const physical = { id: 'machine-a', label: 'Machine A', state: 'online' as const, rpcEndpoint: 'https://machine.example/rpc', kind: 'physical' as const, provider: 'physical' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 0, operationId: null, error: null };
const sandbox = { id: 'sandbox-a', label: 'Sandbox A', state: 'online' as const, rpcEndpoint: 'https://sandbox.example/rpc', kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 1, operationId: null, error: null };

describe('machine provider lifecycle contract', () => {
  it('keeps physical power control behind the physical adapter', async () => {
    const provider = new PhysicalMachineProvider();
    await expect(provider.sleep(physical)).rejects.toThrow(/not remotely managed/u);
    await expect(provider.resume(physical)).rejects.toThrow(/not remotely managed/u);
    await expect(provider.destroy(physical)).rejects.toThrow(/must be unenrolled/u);
  });

  it('maps the same contract to Cloudflare Sandbox lifecycle operations', async () => {
    const actions: string[] = [];
    const service = { fetch: async (request: Request) => {
      const action = new URL(request.url).pathname.split('/').at(-1)!;
      actions.push(action);
      return Response.json({ status: 'ok', value: action === 'destroy' ? { machineId: sandbox.id } : { ...sandbox, state: action === 'sleep' ? 'offline' : 'online', rpcEndpoint: action === 'sleep' ? null : sandbox.rpcEndpoint } });
    } };
    const provider = new CloudflareSandboxMachineProvider(env, 'user-a', service);
    expect((await provider.sleep(sandbox)).state).toBe('offline');
    expect((await provider.resume(sandbox)).state).toBe('online');
    await provider.destroy(sandbox);
    expect(actions).toEqual(['sleep', 'resume', 'destroy']);
  });
  it('blocks sleep or destroy while the machine still owns an open space', async () => {
    const userId = `provider-space-${crypto.randomUUID()}`;
    const catalog = env.FLEET_CATALOG.getByName(userId);
    await catalog.putSpace({ projectId: 'project-a', projectName: 'Project A', repositoryReference: null, baseBranch: 'main', spaceId: 'project-a', kind: 'base', name: 'Project A', branch: 'main', phase: null });
    await env.SPACE_AUTHORITY.getByName(`${userId}:project-a`).bootstrap({ projectId: 'project-a', spaceId: 'project-a', machineId: 'sandbox-a' });
    await expect(assertMachineHasNoOpenSpaces(env, userId, catalog, 'sandbox-a')).rejects.toThrow(/still owns open space/u);
    await expect(assertMachineHasNoOpenSpaces(env, userId, catalog, 'other-machine')).resolves.toBeUndefined();
  });
});

it('recovers an externally stopped sandbox to its desired online state', async () => {
  let current: FleetMachineDefinition = { ...sandbox, state: 'resuming', operationId: 'interrupted-resume', lifecycleRevision: 4 };
  const actions: string[] = [];
  const service = {
    fetch: async (request: Request) => {
      const action = new URL(request.url).pathname.split('/').at(-1)!;
      actions.push(action);
      return Response.json({ status: 'ok', value: { ...sandbox, state: action === 'status' ? (current.state === 'resuming' ? 'offline' : current.state) : 'online', lifecycleRevision: 5 } });
    },
  };
  const catalog = {
    listMachines: async () => [current],
    listSpaces: async () => [],
    putMachine: async (machine: FleetMachineDefinition) => (current = machine),
    removeMachine: async () => true,
  };
  await reconcileFleetMachines({ SANDBOX_PROVISIONER: service } as unknown as Env, 'user-a', catalog);
  const result = await reconcileFleetMachines({ SANDBOX_PROVISIONER: service } as unknown as Env, 'user-a', catalog);
  expect(actions).toEqual(['status', 'resume', 'status']);
  expect(result[0]).toMatchObject({ state: 'online', desiredState: 'online', lifecycleRevision: 6, operationId: null, error: null });
});
