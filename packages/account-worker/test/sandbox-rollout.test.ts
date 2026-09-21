import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';
import { controlFleetMachine, reconcileFleetMachines } from '../src/application.js';
import type { FleetMachineDefinition } from '../src/fleet-catalog.js';

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
        const closed = await authority.commitClosed({ ...identity, expectedGeneration: placement.generation, revision: closing.value.revision, manifestKey: `projects/project-a/spaces/space-a/checkpoints/${closing.value.revision}/manifest.enc`, manifestHash: `sha256:${'c'.repeat(64)}`, resumeOnMachineRestart: true });
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

it('binds image operations to the account machine before contacting the provider', async () => {
  const f = await fixture();
  await expect(Promise.resolve(f.catalog.startCloudImage({ ...f.input, userId: 'another-account' }))).rejects.toThrow();
  await expect(Promise.resolve(f.catalog.startCloudImage({ ...f.input, machineId: 'sandbox-foreign' }))).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(await f.catalog.listCloudImages()).toEqual([]);
});

it('keeps the current image and admission unchanged when the registry rejects preparation', async () => {
  const f = await fixture();
  f.faults.stage = true;
  await f.catalog.startCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'staging', barrier: false, error: 'Registry denied pull' } });
  expect(f.resource.image).toBe(originalImage);
  expect(f.calls).toEqual(['/v1/images/prepare']);
  expect(await f.authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id });
});

it('never replaces after checkpoint failure and releases admission only after cancellation restores workspaces', async () => {
  const f = await fixture();
  f.faults.checkpoint = true;
  await f.catalog.startCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'checkpointing', barrier: true, error: expect.any(String) } });
  expect(f.resource.image).toBe(originalImage);
  expect(f.calls).not.toContain('/v1/sandboxes/sandbox-a/image');
  await expect(Promise.resolve(controlFleetMachine(env, env.ACCOUNT_ID, sandbox.id, 'destroy'))).rejects.toThrow();
  f.faults.restore = true;
  await f.catalog.retryCloudImage({ ...f.input, cancel: true });
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'cancelling', barrier: true, error: expect.any(String) } });
  f.faults.restore = false;
  await f.catalog.retryCloudImage({ ...f.input, cancel: true });
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ currentImage: originalImage, operation: { phase: 'cancelled', barrier: false, error: null } });
  expect(await f.authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 3 });
});

it('recovers canonical restart checkpoints when interrupted intent omitted their identities', async () => {
  const f = await fixture();
  f.faults.restore = true;
  await f.catalog.startCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'confirming', barrier: true, error: expect.any(String) } });
  const interrupted = await f.catalog.cloudImage(sandbox.id);
  if (!interrupted?.operation) throw new Error('Recovery intent is missing');
  await f.catalog.saveCloudImage({ ...interrupted, operation: { ...interrupted.operation, resumeSpaceIds: [] } });
  f.faults.restore = false;
  await f.catalog.retryCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'complete', barrier: false, error: null } });
  expect(await f.authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 3 });
  expect(f.calls.filter(path => path === '/v1/sandboxes/sandbox-a/image')).toEqual(['/v1/sandboxes/sandbox-a/image']);
});

it('retains an uncertain switch barrier and recovers the same operation without replacing again', async () => {
  const f = await fixture();
  f.faults.lostSwitchResponse = true;
  await f.catalog.startCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ currentImage: originalImage, operation: { phase: 'replacing', barrier: true, error: 'Switch response lost' } });
  expect(f.resource.image).toBe(selectedImage);
  await expect(Promise.resolve(f.catalog.retryCloudImage({ ...f.input, cancel: true }))).rejects.toThrow();
  await expect(Promise.resolve(f.catalog.startCloudImage({ ...f.input, operationId: crypto.randomUUID() }))).rejects.toThrow();
  // Background machine reconciliation must not start or stop this prepared machine.
  const before = f.calls.length;
  await reconcileFleetMachines(env, env.ACCOUNT_ID, { listMachines: async () => [sandbox], listSpaces: () => f.catalog.listSpaces(), putMachine: machine => f.catalog.putMachine(machine), removeMachine: id => f.catalog.removeMachine(id) });
  expect(f.calls.length).toBe(before);
  f.faults.restore = true;
  await f.catalog.retryCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'confirming', barrier: true, error: expect.any(String) } });
  f.faults.restore = false;
  await f.catalog.retryCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ currentImage: selectedImage, desiredImage: selectedImage, operation: { phase: 'complete', barrier: false, error: null } });
  expect(f.calls.filter(path => path === '/v1/sandboxes/sandbox-a/image')).toHaveLength(1);
  expect(f.calls.some(path => path.includes('sandbox-b'))).toBe(false);
  expect(await f.catalog.cloudImage('sandbox-b')).toBeNull();
  await expect(Promise.resolve(f.catalog.startCloudImage({ ...f.input, machineId: 'sandbox-b' }))).rejects.toThrow();
  expect(await f.authority.get()).toMatchObject({ state: 'open', machineId: sandbox.id, generation: 3 });
});

it('recovers to a different image by checkpointing candidate work without lifting admission', async () => {
  const f = await fixture();
  f.faults.confirm = true;
  await f.catalog.startCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'confirming', barrier: true, error: expect.any(String) } });
  expect(await f.authority.get()).toMatchObject({ state: 'open', generation: 3, publishedRevision: 1 });
  f.faults.stage = true;
  const recovery = { ...f.input, approvedBy: 'account-device', recoveryOperationId: crypto.randomUUID(), selection: { kind: 'custom' as const, image: originalImage } };
  await f.catalog.recoverCloudImage(recovery);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'staging', recoveryOf: f.input.operationId, barrier: true, error: expect.any(String) } });
  await expect(Promise.resolve(f.catalog.retryCloudImage({ ...f.input, operationId: recovery.recoveryOperationId, cancel: true }))).rejects.toThrow();
  expect(f.resource.image).toBe(selectedImage);
  f.faults.stage = false; f.faults.confirm = false;
  await f.catalog.retryCloudImage({ ...f.input, operationId: recovery.recoveryOperationId });
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ currentImage: originalImage, operation: { phase: 'complete', barrier: false, error: null } });
  expect(await f.authority.get()).toMatchObject({ state: 'open', generation: 5, publishedRevision: 2, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/2/manifest.enc' });
  expect(f.calls).not.toContain('/v1/sandboxes/sandbox-a/image/discard');
});

it('requires explicit discard consent and a bound stop receipt before fencing an unbootable candidate', async () => {
  const f = await fixture();
  f.faults.confirm = true;
  await f.catalog.startCloudImage(f.input);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'confirming', error: expect.any(String) } });
  f.faults.confirm = false; f.faults.checkpointBeforeSave = true;
  const preserved = { ...f.input, approvedBy: 'account-device', recoveryOperationId: crypto.randomUUID(), selection: { kind: 'custom' as const, image: originalImage } };
  await f.catalog.recoverCloudImage(preserved);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'checkpointing', barrier: true, error: expect.any(String) } });
  expect(f.calls).not.toContain('/v1/sandboxes/sandbox-a/image/discard');
  expect(await f.authority.get()).toMatchObject({ state: 'open', generation: 3 });
  const approved = { ...preserved, operationId: preserved.recoveryOperationId, recoveryOperationId: crypto.randomUUID(), discardUncheckpointedCandidate: true };
  f.faults.discardReceipt = true;
  await f.catalog.recoverCloudImage(approved);
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ operation: { phase: 'discarding', barrier: true, discardApproval: { deviceId: 'account-device' }, error: expect.any(String) } });
  expect(await f.authority.get()).toMatchObject({ state: 'open', generation: 3 });
  expect(f.resource.image).toBe(selectedImage);
  f.faults.discardReceipt = false;
  await f.catalog.retryCloudImage({ ...f.input, operationId: approved.recoveryOperationId });
  await expect.poll(() => f.catalog.cloudImage(sandbox.id)).toMatchObject({ currentImage: originalImage, operation: { phase: 'complete', barrier: false, discardReceipt: { operationId: f.input.operationId, recoveryOperationId: approved.recoveryOperationId, stopped: true }, error: null } });
  expect(await f.authority.get()).toMatchObject({ state: 'open', generation: 5, publishedRevision: 1 });
  expect(await f.authority.beginClose({ projectId: 'project-a', spaceId: 'space-a', machineId: sandbox.id, expectedGeneration: 3 })).toMatchObject({ status: 'error' });
  const receipt = (await f.catalog.cloudImage(sandbox.id))!.operation!.discardReceipt!;
  expect(await f.authority.recoverStoppedImage({ userId: env.ACCOUNT_ID, expectedGeneration: 5, receipt })).toMatchObject({ status: 'ok', value: { state: 'open', generation: 5 } });
  await expect(Promise.resolve(f.authority.recoverStoppedImage({ userId: 'another-account', expectedGeneration: 5, receipt }))).rejects.toThrow();
  await expect(Promise.resolve(f.authority.recoverStoppedImage({ userId: env.ACCOUNT_ID, expectedGeneration: 5, receipt: { ...receipt, machineId: 'sandbox-b' } }))).rejects.toThrow();
});

it('pins the tenant default and preserves it when a new image cannot be pulled', async () => {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  let platformDefault = originalImage;
  let rejected = false;
  let preflights = 0;
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/images/:action`, async ({ request, params }) => {
    if (params.action === 'default') return HttpResponse.json({ status: 'ok', value: { image: platformDefault } });
    preflights += 1;
    const { image } = await request.json() as { image: string };
    return rejected ? HttpResponse.json({ status: 'error', error: { code: 'IMAGE_PULL_REJECTED', message: 'No compatible image available' } }, { status: 409 })
      : HttpResponse.json({ status: 'ok', value: { image, deploymentId: 'prepared-deployment' } });
  }));
  expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
  platformDefault = selectedImage;
  expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
  expect(preflights).toBe(0);
  rejected = true;
  await expect(Promise.resolve(catalog.setCloudImageDefault({ kind: 'custom', image: selectedImage }))).rejects.toThrow();
  expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
  rejected = false;
  expect(await catalog.setCloudImageDefault({ kind: 'platform-default' })).toEqual({ kind: 'platform-default', image: selectedImage });
});

it('atomically pins concurrent first-default reads without preparing a VM', async () => {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
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
    await expect(Promise.resolve(catalog.setCloudImageDefault({ kind: 'custom', image: selectedImage }))).rejects.toThrow();
  } finally { gate.resolve(); }
  expect(await Promise.all([first, second])).toEqual([{ kind: 'platform-default', image: originalImage }, { kind: 'platform-default', image: originalImage }]);
  expect(await catalog.cloudImageDefault()).toEqual({ kind: 'platform-default', image: originalImage });
  expect(preflights).toBe(0);
});
