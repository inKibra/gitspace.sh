import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';
import { controlFleetMachine } from '../src/application.js';
import { CLOUD_IMAGE_OPERATION_DEADLINE_MS, type FleetCatalogDO, type FleetMachineDefinition } from '../src/fleet-catalog.js';
import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';

const originalImage = `docker.io/example/original@sha256:${'a'.repeat(64)}`;
const selectedImage = `ghcr.io/tenant/independent-base@sha256:${'b'.repeat(64)}`;
const sandbox: FleetMachineDefinition = { id: 'sandbox-a', label: 'A', state: 'online', rpcEndpoint: '/__sandbox/a/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'Keep these notes', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null };

async function fixture() {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  await catalog.putMachine(sandbox);
  await catalog.putMachine({ ...sandbox, id: 'sandbox-b', label: 'B' });
  const projectAuthority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:project-a`);
  const project = await projectAuthority.bootstrap({ id: 'project-a', name: 'A', repositoryReference: null, baseBranch: 'main', createdBy: sandbox.id });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await projectAuthority.setProjectLifecycle(project.revision, 'active'));
  await projectAuthority.putWorkspace({ id: 'space-a', projectId: 'project-a', kind: 'worktree', name: 'A', branch: 'work', phase: 'code', sourceKind: 'branch', sourceRef: 'work', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const authority = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:space-a`);
  const identity = { projectId: 'project-a', spaceId: 'space-a', machineId: sandbox.id };
  await authority.bootstrap(identity);
  const resource = { image: originalImage, operationId: null as string | null, prepared: false, runtimeStarted: true };
  const faults = { stage: false, checkpoint: false, checkpointBeforeSave: false, lostSwitchResponse: false, restore: false, confirm: false, discardReceipt: false };
  const calls: string[] = [];
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, async ({ request }) => {
    const authority = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:space-a`);
    const path = new URL(request.url).pathname.split('/provider/compute')[1]!;
    calls.push(path);
    if (path === '/v1/images/prepare') {
      const { image } = await request.json() as { image: string };
      return faults.stage
        ? HttpResponse.json({ status: 'error', error: { code: 'IMAGE_PULL_REJECTED', message: 'Registry denied pull' } }, { status: 409 })
        : HttpResponse.json({ status: 'ok', value: { image, deploymentId: 'tenant-image-deployment' } });
    }
    if (path === '/v1/sandboxes/sandbox-a/image/status') return HttpResponse.json({ status: 'ok', value: faults.confirm && !resource.prepared && resource.image === selectedImage ? { ...resource, operationId: null } : resource });
    if (path === '/v1/sandboxes/sandbox-a/prepare-replacement') {
      if (faults.checkpointBeforeSave) return HttpResponse.json({ error: 'Candidate control runtime cannot checkpoint' }, { status: 503 });
      resource.prepared = true;
      const placement = await authority.get();
      if (placement?.state === 'open') {
        const closing = await authority.beginClose({ ...identity, expectedGeneration: placement.generation });
        if (closing.status === 'error') throw new Error(closing.failure.message);
        const closed = await authority.commitClosed({ ...identity, expectedGeneration: placement.generation, revision: closing.value.revision, ...await persistPortableCheckpoint(identity.projectId, identity.spaceId, closing.value.revision), resumeOnMachineRestart: true });
        if (closed.status === 'error') throw new Error(closed.failure.message);
      }
      return faults.checkpoint ? HttpResponse.json({ error: 'Writer flush failed after checkpoint' }, { status: 503 }) : HttpResponse.json({ prepared: true });
    }
    if (path === '/v1/sandboxes/sandbox-a/image') {
      const body = await request.json() as { image: string; operationId: string };
      resource.image = body.image;
      resource.operationId = body.operationId;
      resource.runtimeStarted = false;
      return faults.lostSwitchResponse ? HttpResponse.json({ status: 'error', error: { code: 'TIMEOUT', message: 'Switch response lost' } }, { status: 504 }) : HttpResponse.json({ status: 'ok', value: resource });
    }
    if (path === '/v1/sandboxes/sandbox-a/image/discard') {
      const body = await request.json() as { operationId: string; recoveryOperationId: string };
      expect(body.operationId).toBe(resource.operationId);
      resource.prepared = true;
      return HttpResponse.json({ status: 'ok', value: { ...body, machineId: sandbox.id, stopped: true, recoveryOperationId: faults.discardReceipt ? crypto.randomUUID() : body.recoveryOperationId } });
    }
    if (path === '/v1/sandboxes/sandbox-a/resume' || path === '/v1/sandboxes/sandbox-a/cancel-replacement') {
      resource.runtimeStarted = true;
      const operation = (await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).cloudImage(sandbox.id))?.operation;
      if (!operation?.resumeSpaceIds.includes('space-a')) return HttpResponse.json({ status: 'error', error: 'Workspace admission remains closed' }, { status: 503 });
      if (!faults.restore) {
        const placement = await authority.get();
        if (placement?.state === 'closed') {
          const opening = await authority.beginOpen({ ...identity, expectedGeneration: placement.generation, resumeOnMachineRestart: true });
          if (opening.status === 'error') throw new Error(opening.failure.message);
          await authority.commitOpen({ ...identity, expectedGeneration: placement.generation, revision: opening.value.revision });
        }
      }
      resource.prepared = false;
      return path.endsWith('/cancel-replacement') ? HttpResponse.json({ prepared: false }) : HttpResponse.json({ status: 'ok', value: sandbox });
    }
    if (path === '/v1/sandboxes/sandbox-a/status') return HttpResponse.json({ status: 'ok', value: sandbox });
    throw new Error(`Unexpected provider mutation ${path}`);
  }));
  const operationId = crypto.randomUUID();
  const input = { userId: env.ACCOUNT_ID, machineId: sandbox.id, operationId, selection: { kind: 'custom' as const, image: selectedImage } };
  return { catalog, authority, resource, faults, calls, input };
}

it('pins the tenant default and preserves it when a new image cannot be pulled', async () => {
  await runInDurableObject(env.FLEET_CATALOG.getByName(env.ACCOUNT_ID), async (catalog: FleetCatalogDO) => {
    let platformDefault = originalImage;
    let rejected = false;
    let preflights = 0;
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/images/:action`, async ({ params }) => {
      if (params.action === 'default') return HttpResponse.json({ status: 'ok', value: { image: platformDefault } });
      preflights += 1;
      return rejected ? HttpResponse.json({ status: 'error', error: { code: 'IMAGE_PULL_REJECTED', message: 'No compatible image available' } }, { status: 409 })
        : HttpResponse.json({ status: 'ok', value: { image: selectedImage, deploymentId: 'prepared-deployment' } });
    }));
    expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
    platformDefault = selectedImage;
    expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
    expect(preflights).toBe(0);
    rejected = true;
    await expect(catalog.setCloudImageDefault({ kind: 'custom', image: selectedImage })).rejects.toThrow('No compatible image available');
    expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
    rejected = false;
    expect(await catalog.setCloudImageDefault({ kind: 'platform-default' })).toEqual({ kind: 'platform-default', image: selectedImage });
  });
});

it('atomically pins concurrent first-default reads without preparing a VM', async () => {
  await runInDurableObject(env.FLEET_CATALOG.getByName(env.ACCOUNT_ID), async (catalog: FleetCatalogDO) => {
    const gate = Promise.withResolvers<void>();
    let resolutions = 0;
    let preflights = 0;
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/images/:action`, async ({ params }) => {
      if (params.action === 'prepare') {
        preflights += 1;
        return HttpResponse.json({ status: 'ok', value: { image: originalImage, deploymentId: 'prepared' } });
      }
      const selected = resolutions++ === 0 ? originalImage : selectedImage;
      await gate.promise;
      return HttpResponse.json({ status: 'ok', value: { image: selected } });
    }));
    const first = catalog.cloudImageDefault();
    const second = catalog.cloudImageDefault();
    try {
      await expect.poll(() => resolutions).toBe(1);
    } finally { gate.resolve(); }
    expect(await Promise.all([first, second])).toEqual([{ kind: 'platform-default', image: originalImage }, { kind: 'platform-default', image: originalImage }]);
    expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
    expect(preflights).toBe(0);
  });
});

it('accepts the first explicit image selection while default initialization is pending', async () => {
  await runInDurableObject(env.FLEET_CATALOG.getByName(env.ACCOUNT_ID), async (catalog: FleetCatalogDO) => {
    const lookupStarted = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    const preparationStarted = Promise.withResolvers<void>();
    const preparation = Promise.withResolvers<void>();
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/images/:action`, async ({ params }) => {
      if (params.action === 'default') {
        lookupStarted.resolve();
        await lookup.promise;
        return HttpResponse.json({ status: 'ok', value: { image: originalImage } });
      }
      preparationStarted.resolve();
      await preparation.promise;
      return HttpResponse.json({ status: 'ok', value: { image: selectedImage, deploymentId: 'prepared' } });
    }));
    const initialRead = catalog.cloudImageDefault();
    const selection = { kind: 'custom', image: selectedImage } as const;
    try {
      await Promise.race([lookupStarted.promise, initialRead]);
      const selected = catalog.setCloudImageDefault(selection);
      try {
        await Promise.race([preparationStarted.promise, selected]);
        // Two real writes still conflict; the delayed initial read must not own or clear this lock.
        lookup.resolve();
        expect(await initialRead).toEqual({ kind: 'platform-default', image: originalImage });
        await expect(catalog.setCloudImageDefault({ kind: 'platform-default' })).rejects.toThrow('already in progress');
        preparation.resolve();
        expect(await selected).toEqual(selection);
        expect(await catalog.cloudImageDefault()).toEqual(selection);
      } finally {
        preparation.resolve();
        await selected;
      }
    } finally {
      lookup.resolve();
      await initialRead;
    }
  });
});

it('does not overwrite a verified first selection when the initial platform lookup finishes later', async () => {
  await runInDurableObject(env.FLEET_CATALOG.getByName(env.ACCOUNT_ID), async (catalog: FleetCatalogDO) => {
    const lookupStarted = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/images/:action`, async ({ params }) => {
      if (params.action === 'prepare') return HttpResponse.json({ status: 'ok', value: { image: selectedImage, deploymentId: 'prepared' } });
      lookupStarted.resolve();
      await lookup.promise;
      return HttpResponse.json({ status: 'ok', value: { image: originalImage } });
    }));
    const initialRead = catalog.cloudImageDefault();
    const selection = { kind: 'custom', image: selectedImage } as const;
    try {
      await Promise.race([lookupStarted.promise, initialRead]);
      expect(await catalog.setCloudImageDefault(selection)).toEqual(selection);
    } finally {
      lookup.resolve();
      await initialRead;
    }
    expect(await initialRead).toEqual(selection);
    expect(await catalog.cloudImageDefault()).toEqual(selection);
  });
});
