import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { controlFleetMachine } from '../src/application.js';
import { PhysicalMachineProvider } from '../src/machine-providers.js';
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
  expect(stopped).toBe(false);
  expect(cancelled).toBe(true);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
});
