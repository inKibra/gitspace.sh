import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { controlFleetMachine, reconcileFleetMachines } from '../src/index.js';
import { PhysicalMachineProvider } from '../src/machine-providers.js';
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

  it('blocks destroy while the machine still owns an open space', async () => {
    const userId = `provider-space-${crypto.randomUUID()}`;
    const catalog = env.FLEET_CATALOG.getByName(userId);
    await catalog.putMachine(sandbox);
    await catalog.putSpace({ projectId: 'project-a', projectName: 'Project A', repositoryReference: null, baseBranch: 'main', spaceId: 'project-a', kind: 'base', name: 'Project A', branch: 'main', phase: null });
    await env.SPACE_AUTHORITY.getByName(`${userId}:project-a`).bootstrap({ projectId: 'project-a', spaceId: 'project-a', machineId: 'sandbox-a' });
    await expect(controlFleetMachine(env, userId, sandbox.id, 'destroy')).rejects.toThrow(/still owns open space/u);
    expect(await catalog.getMachine(sandbox.id)).toEqual(sandbox);
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

async function openSpaceMachine(desiredState: 'online' | 'offline' = 'online') {
  const userId = `machine-stop-${crypto.randomUUID()}`;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  await catalog.putMachine({ ...sandbox, desiredState });
  await catalog.putSpace({ projectId: 'project-a', projectName: 'Project A', repositoryReference: null, baseBranch: 'main', spaceId: 'project-a', kind: 'base', name: 'Project A', branch: 'main', phase: null });
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:project-a`);
  const identity = { projectId: 'project-a', spaceId: 'project-a', machineId: sandbox.id };
  await authority.bootstrap(identity);
  return { userId, catalog, authority, identity };
}

it('checkpoints an open workspace before stopping and preserves its restart checkpoint', async () => {
  const { userId, catalog, authority, identity } = await openSpaceMachine();
  const actions: string[] = [];
  const service = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') {
      expect((await catalog.getMachine(sandbox.id))?.desiredState).toBe('online');
      const checkpoint = await authority.beginClose({ ...identity, expectedGeneration: 1 });
      await authority.commitClosed({
        ...identity, expectedGeneration: 1, revision: checkpoint.revision,
        manifestKey: 'projects/project-a/spaces/project-a/checkpoints/1/manifest.enc',
        manifestHash: `sha256:${'a'.repeat(64)}`, resumeOnMachineRestart: true,
      });
      return Response.json({ prepared: true });
    }
    if (action === 'sleep') {
      expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, resumeMachineId: sandbox.id, checkpointRevision: 1 });
      return Response.json({ status: 'ok', value: { ...sandbox, state: 'offline', desiredState: 'offline', rpcEndpoint: null } });
    }
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  const result = await controlFleetMachine({ ...env, SANDBOX_PROVISIONER: service } as unknown as Env, userId, sandbox.id, 'sleep');
  expect(result).toMatchObject({ state: 'offline', desiredState: 'offline', operationId: null, error: null });
  expect(actions).toEqual(['status', 'prepare-replacement', 'sleep']);
  expect(await authority.get()).toMatchObject({ state: 'closed', resumeMachineId: sandbox.id, manifestHash: `sha256:${'a'.repeat(64)}` });
});

it.each(['control', 'reconciliation'] as const)('restores admission after a failed checkpoint through %s without leaving a deferred stop', async (entry) => {
  const { userId, catalog, authority, identity } = await openSpaceMachine(entry === 'control' ? 'online' : 'offline');
  let admitted = true;
  let stopped = false;
  const actions: string[] = [];
  const service = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') {
      admitted = false;
      // One space may already be durable when a later upload or writer flush fails.
      const checkpoint = await authority.beginClose({ ...identity, expectedGeneration: 1 });
      await authority.commitClosed({
        ...identity, expectedGeneration: 1, revision: checkpoint.revision,
        manifestKey: 'projects/project-a/spaces/project-a/checkpoints/1/manifest.enc',
        manifestHash: `sha256:${'b'.repeat(64)}`, resumeOnMachineRestart: true,
      });
      return Response.json({ error: 'Checkpoint upload failed' }, { status: 503 });
    }
    if (action === 'cancel-replacement') {
      const opening = await authority.beginOpen({ ...identity, expectedGeneration: 2, resumeOnMachineRestart: true });
      await authority.commitOpen({ ...identity, expectedGeneration: 2, revision: opening.revision });
      admitted = true;
      return Response.json({ prepared: false });
    }
    if (action === 'sleep') stopped = true;
    if (action === 'status' || action === 'sleep') return Response.json({
      status: 'ok', value: { ...sandbox, state: stopped || !admitted ? 'offline' : 'online', desiredState: stopped ? 'offline' : 'online' },
    });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  const environment = { ...env, SANDBOX_PROVISIONER: service } as unknown as Env;
  if (entry === 'control') await expect(controlFleetMachine(environment, userId, sandbox.id, 'sleep')).rejects.toThrow('Checkpoint upload failed');
  else await reconcileFleetMachines(environment, userId, catalog);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online', operationId: null, error: 'Checkpoint upload failed' });
  expect(admitted).toBe(true);
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 3 });
  await reconcileFleetMachines(environment, userId, catalog);
  expect(stopped).toBe(false);
  expect(actions).toEqual(['status', 'prepare-replacement', 'cancel-replacement', 'status', 'status']);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online', error: null });
});

it('never trusts preparation while cloud ownership still has an open space', async () => {
  const { userId, catalog, authority } = await openSpaceMachine();
  const actions: string[] = [];
  const service = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') return Response.json({ prepared: true });
    if (action === 'cancel-replacement') return Response.json({ prepared: false });
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  await expect(controlFleetMachine({ ...env, SANDBOX_PROVISIONER: service } as unknown as Env, userId, sandbox.id, 'sleep')).rejects.toThrow(/still owns open space/u);
  expect(actions).toEqual(['status', 'prepare-replacement', 'cancel-replacement', 'status']);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id });
});

it('keeps failed cancellation online-intended and retries saving an unready but still running machine', async () => {
  const { userId, catalog, authority } = await openSpaceMachine();
  let admitted = true;
  let cancelFails = true;
  const actions: string[] = [];
  const service = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') {
      admitted = false;
      return Response.json({ error: 'Checkpoint upload failed' }, { status: 503 });
    }
    if (action === 'cancel-replacement') {
      if (cancelFails) return Response.json({ error: 'Recovery unavailable' }, { status: 503 });
      admitted = true;
      return Response.json({ prepared: false });
    }
    if (action === 'status') return Response.json({ status: 'ok', value: { ...sandbox, state: admitted ? 'online' : 'offline' } });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  const environment = { ...env, SANDBOX_PROVISIONER: service } as unknown as Env;
  await expect(controlFleetMachine(environment, userId, sandbox.id, 'sleep')).rejects.toThrow(/Recovery unavailable/u);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'error', desiredState: 'online' });
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id });
  cancelFails = false;
  await expect(controlFleetMachine(environment, userId, sandbox.id, 'sleep')).rejects.toThrow('Checkpoint upload failed');
  expect(admitted).toBe(true);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
  expect(actions).toEqual(['status', 'prepare-replacement', 'cancel-replacement', 'status', 'prepare-replacement', 'cancel-replacement', 'status']);
});

it('leaves an already stopped machine alone', async () => {
  const userId = `machine-stopped-${crypto.randomUUID()}`;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  const stopped = { ...sandbox, state: 'offline' as const, desiredState: 'offline' as const, rpcEndpoint: null };
  await catalog.putMachine(stopped);
  const environment = { ...env, SANDBOX_PROVISIONER: { fetch: async () => { throw new Error('Stopped machines must not be contacted'); } } } as unknown as Env;
  expect(await controlFleetMachine(environment, userId, sandbox.id, 'sleep')).toEqual(stopped);
});

it('rejects a missing checkpoint acknowledgement without stopping', async () => {
  const userId = `machine-no-ack-${crypto.randomUUID()}`;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  await catalog.putMachine(sandbox);
  let stopped = false;
  let cancelled = false;
  const service = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    if (action === 'prepare-replacement') return Response.json({});
    if (action === 'cancel-replacement') {
      cancelled = true;
      return Response.json({ prepared: false });
    }
    if (action === 'sleep') stopped = true;
    return Response.json({ status: 'ok', value: sandbox });
  } };
  const environment = { ...env, SANDBOX_PROVISIONER: service } as unknown as Env;
  await expect(controlFleetMachine(environment, userId, sandbox.id, 'sleep')).rejects.toThrow(/no acknowledgement/u);
  await reconcileFleetMachines(environment, userId, catalog);
  expect(stopped).toBe(false);
  expect(cancelled).toBe(true);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
});
