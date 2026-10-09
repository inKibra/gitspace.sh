import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { controlFleetMachine, reconcileFleetMachines } from '../src/index.js';
import { PhysicalMachineProvider } from '../src/machine-providers.js';
import type { FleetMachineDefinition } from '../src/fleet-catalog.js';
import { http } from 'msw';
import { network } from './network.js';
import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';
import { MachineDiscardRequired } from '@gitspace/protocol/machine-discard';

function mockProvider(fetch: (request: Pick<Request, 'url'>) => Promise<Response>) {
  network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => fetch(request)));
}

const physical = { id: 'machine-a', label: 'Machine A', state: 'online' as const, rpcEndpoint: 'https://machine.example/rpc', kind: 'physical' as const, provider: 'physical' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 0, operationId: null, error: null };
const sandbox = { id: 'sandbox-a', label: 'Sandbox A', state: 'online' as const, rpcEndpoint: 'https://sandbox.example/rpc', kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 1, operationId: null, error: null };

describe('machine provider lifecycle contract', () => {
  it('keeps physical power control behind the physical adapter', async () => {
    const provider = new PhysicalMachineProvider();
    await expect(provider.sleep(physical)).rejects.toThrow(/not remotely managed/u);
    await expect(provider.resume(physical)).rejects.toThrow(/not remotely managed/u);
    await expect(provider.destroy(physical)).rejects.toThrow(/must be unenrolled/u);
  });
});

it('keeps failed pristine source retry generations fenced without inventing a checkpoint', async () => {
  const { authority, identity } = await openSpaceMachine();
  expect((await authority.releaseUnpublishedSource({ ...identity, expectedGeneration: 0 })).status).toBe('error');
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
  expect((await authority.releaseUnpublishedSource({ ...identity, expectedGeneration: 1 })).status).toBe('ok');
  expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, generation: 2, publishedRevision: 0, manifestKey: null });
  const retry = await authority.bootstrapUnpublishedSource(identity);
  expect(retry).toMatchObject({ status: 'ok', value: { state: 'open', machineId: sandbox.id, generation: 3, publishedRevision: 0 } });
  expect((await authority.beginClose({ ...identity, expectedGeneration: 1 })).status).toBe('error');
  expect(await authority.get()).toMatchObject({ state: 'open', generation: 3 });
});

it('hands an unpublished source left open by a removed machine to the next machine, and only that one', async () => {
  const { authority, identity } = await openSpaceMachine();
  const next = { ...identity, machineId: 'sandbox-b' };
  expect((await authority.bootstrapUnpublishedSource(next)).status).toBe('error');
  expect((await authority.bootstrapUnpublishedSource(next, 'sandbox-other')).status).toBe('error');
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
  expect(await authority.bootstrapUnpublishedSource(next, sandbox.id)).toMatchObject({ status: 'ok', value: { state: 'open', machineId: 'sandbox-b', generation: 2, publishedRevision: 0 } });
  expect((await authority.beginClose({ ...identity, expectedGeneration: 1 })).status).toBe('error');
});

it('recovers an externally stopped sandbox to its desired online state', async () => {
  let current: FleetMachineDefinition = { ...sandbox, state: 'resuming', operationId: 'interrupted-resume', lifecycleRevision: 4 };
  const actions: string[] = [];
  const service = {
    fetch: async (request: Pick<Request, 'url'>) => {
      const action = new URL(request.url).pathname.split('/').at(-1)!;
      actions.push(action);
      if (action === 'cancel-replacement') return Response.json({ prepared: false });
      return Response.json({ status: 'ok', value: { ...sandbox, state: action === 'status' ? (current.state === 'resuming' ? 'offline' : current.state) : 'online', lifecycleRevision: 5 } });
    },
  };
  const catalog = {
    listMachines: async () => [current],
    listSpaces: async () => [],
    putMachine: async (machine: FleetMachineDefinition) => (current = machine),
    removeMachine: async () => true,
  };
  mockProvider(service.fetch);
  await reconcileFleetMachines(env, env.ACCOUNT_ID, catalog);
  const result = await reconcileFleetMachines(env, env.ACCOUNT_ID, catalog);
  expect(actions.filter(action => action === 'resume')).toEqual(['resume']);
  expect(result[0]).toMatchObject({ state: 'online', desiredState: 'online', lifecycleRevision: 6, operationId: null, error: null });
});

async function openSpaceMachine(desiredState: 'online' | 'offline' = 'online') {
  const userId = env.ACCOUNT_ID;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  await catalog.putMachine({ ...sandbox, desiredState });
  const projectAuthority = env.PROJECT_AUTHORITY.getByName(`${userId}:project-a`);
  const project = await projectAuthority.bootstrap({ id: 'project-a', name: 'Project A', repositoryReference: null, baseBranch: 'main', createdBy: sandbox.id });
  await env.USER_PROJECTS.getByName(userId).put(await projectAuthority.setProjectLifecycle(project.revision, 'active'));
  await projectAuthority.putWorkspace({ id: 'project-a', projectId: 'project-a', kind: 'base', name: 'Project A', branch: 'main', phase: null, sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:project-a`);
  const identity = { projectId: 'project-a', spaceId: 'project-a', machineId: sandbox.id };
  await authority.bootstrap(identity);
  return { userId, catalog, authority, identity };
}

it('does not acknowledge resume from a stale online catalog entry', async () => {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  await catalog.putMachine(sandbox);
  let ready = false;
  mockProvider(async (request) => {
    if (new URL(request.url).pathname.endsWith('/cancel-replacement')) return Response.json({ prepared: false });
    return ready
      ? Response.json({ status: 'ok', value: sandbox })
      : Response.json({ error: 'Runtime has no admitted generation' }, { status: 503 });
  });
  await expect(controlFleetMachine(env, env.ACCOUNT_ID, sandbox.id, 'resume')).rejects.toThrow('Runtime has no admitted generation');
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'error', desiredState: 'online' });
  ready = true;
  expect(await controlFleetMachine(env, env.ACCOUNT_ID, sandbox.id, 'resume')).toMatchObject({ state: 'online', operationId: null, error: null });
});

it('checkpoints an open workspace before stopping and preserves its restart checkpoint', async () => {
  const { userId, catalog, authority, identity } = await openSpaceMachine();
  const manifest = await persistPortableCheckpoint(identity.projectId, identity.spaceId, 1);
  const actions: string[] = [];
  const service = { fetch: async (request: Pick<Request, 'url'>) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') {
      expect((await catalog.getMachine(sandbox.id))?.desiredState).toBe('online');
      const checkpoint = await authority.beginClose({ ...identity, expectedGeneration: 1 });
      if (checkpoint.status === 'error') throw new Error(checkpoint.failure.message);
      const closed = await authority.commitClosed({
        ...identity, expectedGeneration: 1, revision: checkpoint.value.revision,
        ...manifest, resumeOnMachineRestart: true,
      });
      if (closed.status === 'error') throw new Error(closed.failure.message);
      return Response.json({ prepared: true });
    }
    if (action === 'sleep') {
      expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, resumeMachineId: sandbox.id, checkpointRevision: 1, publishedRevision: 1 });
      return Response.json({ status: 'ok', value: { ...sandbox, state: 'offline', desiredState: 'offline', rpcEndpoint: null } });
    }
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  mockProvider(service.fetch);
  const result = await controlFleetMachine(env, userId, sandbox.id, 'sleep');
  expect(result).toMatchObject({ state: 'offline', desiredState: 'offline', operationId: null, error: null });
  expect(actions).toEqual(['status', 'prepare-replacement', 'sleep']);
  expect(await authority.get()).toMatchObject({ state: 'closed', resumeMachineId: sandbox.id, manifestHash: manifest.manifestHash });
});

it.each(['sleep', 'destroy'] as const)('returns an actionable local-work discard refusal for %s without stopping or deleting', async (action) => {
  const { userId, catalog, authority } = await openSpaceMachine();
  const actions: string[] = [];
  const confirmation = { machineId: sandbox.id, action, token: 'local-work-fingerprint' };
  mockProvider(async (request) => {
    const operation = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(operation);
    if (operation === 'prepare-replacement') return Response.json({
      error: {
        _tag: 'MachineDiscardRequired',
        message: 'Checkpoint failed; unpublished local work is retained.',
        confirmation,
        workspaces: [{ projectId: 'project-a', workspaceId: 'project-a', generation: 1, reason: 'unpublished-local-work' }],
      },
    }, { status: 409 });
    if (operation === 'cancel-replacement') return Response.json({ prepared: false });
    if (operation === 'status') return Response.json({ status: 'ok', value: sandbox });
    throw new Error(`Destructive provider operation must not run: ${operation}`);
  });
  await expect(controlFleetMachine(env, userId, sandbox.id, action)).rejects.toMatchObject({
    _tag: 'MachineDiscardRequired',
    confirmation,
    workspaces: [{ projectId: 'project-a', workspaceId: 'project-a', generation: 1, reason: 'unpublished-local-work' }],
  });
  expect(actions).not.toContain('sleep');
  expect(actions).not.toContain('destroy');
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ desiredState: 'online', operationId: null });
});

it.each(['sleep', 'destroy'] as const)('fences discarded ownership only after verified provider stop for %s', async action => {
  const { userId, authority } = await openSpaceMachine();
  const actions: string[] = [];
  const confirmation = { machineId: sandbox.id, action, token: 'issued-by-runtime' };
  mockProvider(async request => {
    const operation = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(operation);
    if (operation === 'status') return Response.json({ status: 'ok', value: sandbox });
    if (operation === 'prepare-replacement') return Response.json({ prepared: true,
      discard: [{ projectId: 'project-a', workspaceId: 'project-a', generation: 1, reason: 'unpublished-local-work' }] });
    if (operation === 'sleep') {
      expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
      return Response.json({ status: 'ok', value: { ...sandbox, state: 'offline', desiredState: 'offline', rpcEndpoint: null } });
    }
    if (operation === 'destroy') {
      expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, generation: 2 });
      return Response.json({ status: 'ok', value: { machineId: sandbox.id } });
    }
    throw new Error(`Unexpected provider operation ${operation}`);
  });
  await controlFleetMachine(env, userId, sandbox.id, action, confirmation);
  expect(actions).toEqual(action === 'sleep' ? ['status', 'prepare-replacement', 'sleep'] : ['status', 'prepare-replacement', 'sleep', 'destroy']);
  expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, generation: 2, publishedRevision: 0 });
  expect(await env.PROJECT_AUTHORITY.getByName(`${userId}:project-a`).getProject()).toMatchObject({ lifecycle: 'active' });
});

it('destroys a cloud machine whose runtime can never checkpoint once the user approves loss back to the last checkpoint', async () => {
  const { userId, catalog, authority } = await openSpaceMachine();
  const actions: string[] = [];
  mockProvider(async request => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    // The live failure: the runtime refuses every checkpoint attempt.
    if (action === 'prepare-replacement') return Response.json({ error: 'Session is quiescing' }, { status: 409 });
    if (action === 'cancel-replacement') return Response.json({ prepared: false });
    if (action === 'destroy') {
      expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
      return Response.json({ status: 'ok', value: { machineId: sandbox.id } });
    }
    throw new Error(`Unexpected provider operation ${action}`);
  });
  const refusal = await controlFleetMachine(env, userId, sandbox.id, 'destroy').then(() => null, (error: unknown) => error);
  if (!(refusal instanceof MachineDiscardRequired)) throw new Error(`Expected an explicit discard choice, got ${String(refusal)}`);
  expect(refusal.message).toContain('Session is quiescing');
  expect(refusal.workspaces).toEqual([{ projectId: 'project-a', workspaceId: 'project-a', generation: 1, reason: 'unpublished-local-work' }]);
  expect(actions).not.toContain('destroy');
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
  await expect(controlFleetMachine(env, userId, sandbox.id, 'destroy', { ...refusal.confirmation, token: 'cloud:forged' })).rejects.toMatchObject({ _tag: 'MachineDiscardRequired', confirmation: refusal.confirmation });
  expect(actions).not.toContain('destroy');
  expect(await controlFleetMachine(env, userId, sandbox.id, 'destroy', refusal.confirmation)).toEqual({ machineId: sandbox.id, removed: true });
  expect(actions.filter(action => action === 'destroy')).toHaveLength(1);
  expect(actions).not.toContain('sleep');
  expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, generation: 2 });
  expect(await catalog.getMachine(sandbox.id)).toBeNull();
  expect(await catalog.wasMachineDestroyed(sandbox.id)).toBe(true);
});

it('does not fence or destroy when an explicitly approved provider stop has an uncertain outcome', async () => {
  const { userId, authority, catalog } = await openSpaceMachine();
  const actions: string[] = [];
  let verifiedStopped = false;
  mockProvider(async request => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'status') return Response.json({ status: 'ok', value: verifiedStopped ? { ...sandbox, state: 'offline', desiredState: 'offline', rpcEndpoint: null } : sandbox });
    if (action === 'prepare-replacement') return Response.json({ prepared: true,
      discard: [{ projectId: 'project-a', workspaceId: 'project-a', generation: 1, reason: 'unpublished-local-work' }] });
    if (action === 'sleep') return Response.json({ error: 'Provider stop acknowledgement lost' }, { status: 503 });
    throw new Error(`Unsafe follow-up ${action}`);
  });
  await expect(controlFleetMachine(env, userId, sandbox.id, 'destroy', { machineId: sandbox.id, action: 'destroy', token: 'issued-by-runtime' })).rejects.toThrow('acknowledgement lost');
  expect(actions).toEqual(['status', 'prepare-replacement', 'sleep']);
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'error', desiredState: 'offline' });
  await expect(controlFleetMachine(env, userId, sandbox.id, 'resume')).rejects.toThrow();
  expect(actions).toEqual(['status', 'prepare-replacement', 'sleep']);
  verifiedStopped = true;
  await reconcileFleetMachines(env, userId, catalog);
  expect(actions).toEqual(['status', 'prepare-replacement', 'sleep', 'status']);
  expect(await authority.get()).toMatchObject({ state: 'closed', machineId: null, generation: 2 });
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'offline', desiredState: 'offline', error: null });
  expect(await catalog.pendingMachineDiscard(sandbox.id)).toBeNull();
});

it.each([
  { state: 'online' as const, desiredState: 'offline' as const },
  { state: 'offline' as const, desiredState: 'online' as const },
])('refuses to fence or destroy after a contradictory successful stop receipt: %s', async receipt => {
  const { userId, authority, catalog } = await openSpaceMachine();
  const actions: string[] = [];
  const confirmation = { machineId: sandbox.id, action: 'destroy' as const, token: 'issued-by-runtime' };
  mockProvider(async request => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    if (action === 'prepare-replacement') return Response.json({ prepared: true,
      discard: [{ projectId: 'project-a', workspaceId: 'project-a', generation: 1, reason: 'unpublished-local-work' }] });
    if (action === 'sleep') return Response.json({ status: 'ok', value: { ...sandbox, ...receipt } });
    if (action === 'destroy') return Response.json({ status: 'ok', value: { machineId: sandbox.id } });
    throw new Error(`Unexpected provider operation ${action}`);
  });
  await expect(controlFleetMachine(env, userId, sandbox.id, 'destroy', confirmation)).rejects.toThrow();
  expect(actions).toEqual(['status', 'prepare-replacement', 'sleep']);
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 1 });
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'error', desiredState: 'offline' });
  expect(await catalog.pendingMachineDiscard(sandbox.id)).toMatchObject({ confirmation });
});

it.each(['control', 'reconciliation'] as const)('restores admission after a failed checkpoint through %s without leaving a deferred stop', async (entry) => {
  const { userId, catalog, authority, identity } = await openSpaceMachine(entry === 'control' ? 'online' : 'offline');
  const manifest = await persistPortableCheckpoint(identity.projectId, identity.spaceId, 1);
  let admitted = true;
  let stopped = false;
  const actions: string[] = [];
  const service = { fetch: async (request: Pick<Request, 'url'>) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') {
      admitted = false;
      // One space may already be durable when a later upload or writer flush fails.
      const checkpoint = await authority.beginClose({ ...identity, expectedGeneration: 1 });
      if (checkpoint.status === 'error') throw new Error(checkpoint.failure.message);
      const closed = await authority.commitClosed({
        ...identity, expectedGeneration: 1, revision: checkpoint.value.revision,
        ...manifest, resumeOnMachineRestart: true,
      });
      if (closed.status === 'error') throw new Error(closed.failure.message);
      return Response.json({ error: 'Checkpoint upload failed' }, { status: 503 });
    }
    if (action === 'cancel-replacement') {
      const opening = await authority.beginOpen({ ...identity, expectedGeneration: 2, resumeOnMachineRestart: true });
      if (opening.status === 'error') throw new Error(opening.failure.message);
      const opened = await authority.commitOpen({ ...identity, expectedGeneration: 2, revision: opening.value.revision });
      if (opened.status === 'error') throw new Error(opened.failure.message);
      admitted = true;
      return Response.json({ prepared: false });
    }
    if (action === 'sleep') stopped = true;
    if (action === 'status' || action === 'sleep') return Response.json({
      status: 'ok', value: { ...sandbox, state: stopped || !admitted ? 'offline' : 'online', desiredState: stopped ? 'offline' : 'online' },
    });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  mockProvider(service.fetch);
  const environment = env;
  if (entry === 'control') await expect(controlFleetMachine(environment, userId, sandbox.id, 'sleep')).rejects.toThrow('Checkpoint upload failed');
  else await reconcileFleetMachines(environment, userId, catalog);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online', operationId: null, error: 'Checkpoint upload failed' });
  expect(admitted).toBe(true);
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 3, publishedRevision: 1, manifestHash: manifest.manifestHash });
  await reconcileFleetMachines(environment, userId, catalog);
  expect(stopped).toBe(false);
  expect(actions).toEqual(['status', 'prepare-replacement', 'cancel-replacement', 'status', 'status']);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online', error: null });
});

it('never trusts preparation while cloud ownership still has an open space', async () => {
  const { userId, catalog, authority } = await openSpaceMachine();
  const actions: string[] = [];
  const service = { fetch: async (request: Pick<Request, 'url'>) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    actions.push(action);
    if (action === 'prepare-replacement') return Response.json({ prepared: true });
    if (action === 'cancel-replacement') return Response.json({ prepared: false });
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    throw new Error(`Unexpected provider action ${action}`);
  } };
  mockProvider(service.fetch);
  await expect(controlFleetMachine(env, userId, sandbox.id, 'sleep')).rejects.toThrow();
  expect(actions).toEqual(['status', 'prepare-replacement', 'cancel-replacement', 'status']);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
  expect(await authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id });
});

it('keeps failed cancellation online-intended and retries saving an unready but still running machine', async () => {
  const { userId, catalog, authority } = await openSpaceMachine();
  let admitted = true;
  let cancelFails = true;
  const actions: string[] = [];
  const service = { fetch: async (request: Pick<Request, 'url'>) => {
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
  mockProvider(service.fetch);
  const environment = env;
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
  const userId = env.ACCOUNT_ID;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  const stopped = { ...sandbox, state: 'offline' as const, desiredState: 'offline' as const, rpcEndpoint: null };
  await catalog.putMachine(stopped);
  let contacted = false;
  mockProvider(async () => {
    contacted = true;
    return new Response(null, { status: 503 });
  });
  expect(await controlFleetMachine(env, userId, sandbox.id, 'sleep')).toEqual(stopped);
  expect(contacted).toBe(false);
});

it('rejects a missing checkpoint acknowledgement without stopping', async () => {
  const userId = env.ACCOUNT_ID;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  await catalog.putMachine(sandbox);
  let stopped = false;
  let cancelled = false;
  const service = { fetch: async (request: Pick<Request, 'url'>) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    if (action === 'prepare-replacement') return Response.json({});
    if (action === 'cancel-replacement') {
      cancelled = true;
      return Response.json({ prepared: false });
    }
    if (action === 'sleep') stopped = true;
    return Response.json({ status: 'ok', value: sandbox });
  } };
  mockProvider(service.fetch);
  const environment = env;
  await expect(controlFleetMachine(environment, userId, sandbox.id, 'sleep')).rejects.toThrow();
  await reconcileFleetMachines(environment, userId, catalog);
  expect(stopped).toBe(false);
  expect(cancelled).toBe(true);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
});
