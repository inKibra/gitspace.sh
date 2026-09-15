import { z } from 'zod';
import {
  cloudImageDiscardReceiptSchema, cloudImagePreparedSchema, cloudImageProviderStatusSchema, cloudImageReferenceSchema,
  type CloudImageChoice, type CloudImageSelection, type CloudImageState,
} from '@gitspace/protocol/cloud-image';
import type { FleetMachineDefinition, PortableSpaceDefinition } from './fleet-catalog.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import { controlCloudflareSandboxMachine, controlCloudflareSandboxReplacement } from './sandbox-provisioner.js';
import { tenantProvider } from './tenant-platform.js';

export async function cloudImageProviderCall(env: Env, path: string, body?: object): Promise<unknown> {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  let status: number | undefined;
  let cfRay: string | null = null;
  console.info(JSON.stringify({ event: 'cloud_image_provider_request', requestId, path, outcome: 'start' }));
  try {
    const response = await tenantProvider(env).fetch(new Request(`https://sandbox.internal${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gitspace-request-id': requestId },
      body: body ? JSON.stringify(body) : undefined,
    }));
    status = response.status;
    cfRay = response.headers.get('cf-ray');
    const payload = await response.json() as { status?: string; value?: unknown; error?: { code?: string; message?: string } | string };
    if (!response.ok || payload.status !== 'ok') throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message ?? `Cloud image provider request failed (HTTP ${response.status})`);
    console.info(JSON.stringify({ event: 'cloud_image_provider_request', requestId, path, outcome: 'success', status, cfRay, elapsedMs: Date.now() - started }));
    return payload.value;
  } catch (error) {
    // Provider response bodies can include arbitrary image output. Keep correlation
    // and transport evidence in logs, not enrollment material or raw payloads.
    console.error(JSON.stringify({ event: 'cloud_image_provider_request', requestId, path, outcome: 'failure', status, cfRay, elapsedMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UnknownError' }));
    throw error;
  }
}

export async function resolveCloudImage(env: Env, selection: CloudImageSelection): Promise<CloudImageChoice> {
  const image = selection.kind === 'custom' ? selection.image
    : z.object({ image: cloudImageReferenceSchema }).parse(await cloudImageProviderCall(env, '/v1/images/default')).image;
  return { kind: selection.kind, image };
}

export async function prepareCloudImage(env: Env, image: string): Promise<void> {
  const prepared = cloudImagePreparedSchema.parse(await cloudImageProviderCall(env, '/v1/images/prepare', { image }));
  if (prepared.image !== image) throw new Error('Provider prepared a different image');
}

export interface CloudImageOperationStore {
  saveCloudImage(state: CloudImageState): CloudImageState;
  listSpaces(): Promise<PortableSpaceDefinition[]>;
  getMachine(machineId: string): FleetMachineDefinition | null;
  putMachine(machine: FleetMachineDefinition): FleetMachineDefinition;
}

/** Resumes from durable intent. In particular, a lost switch response is never permission to cancel. */
export async function runCloudImageOperation(env: Env, store: CloudImageOperationStore, initial: CloudImageState): Promise<void> {
  let state = initial;
  const operation = state.operation!;
  const machineId = state.machineId;
  const path = `/v1/sandboxes/${encodeURIComponent(machineId)}`;
  const authorities = env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>;
  const attemptStarted = Date.now();
  console.info(JSON.stringify({ event: 'cloud_image_operation', machineId, operationId: operation.id, phase: operation.phase, barrier: operation.barrier, outcome: 'start' }));
  const save = (phase: NonNullable<CloudImageState['operation']>['phase'], barrier = operation.barrier) => {
    operation.phase = phase;
    operation.barrier = barrier;
    operation.updatedAt = Date.now();
    operation.error = null;
    state = store.saveCloudImage({ ...state, operation });
    console.info(JSON.stringify({ event: 'cloud_image_operation', machineId, operationId: operation.id, phase, barrier, resumeSpaceIds: operation.resumeSpaceIds, elapsedMs: Date.now() - attemptStarted, outcome: phase === 'complete' || phase === 'cancelled' ? 'success' : 'transition' }));
  };
  const placements = async () => Promise.all((await store.listSpaces()).map(async ({ spaceId }) => ({ spaceId, placement: await authorities.getByName(`${env.ACCOUNT_ID}:${spaceId}`).get() })));
  try {
    if (operation.phase === 'resuming' || operation.phase === 'confirming' || operation.phase === 'cancelling') {
      // Canonical restart markers survive an interrupted or incomplete recovery intent.
      const previousCount = operation.resumeSpaceIds.length;
      for (const { spaceId, placement } of await placements()) {
        if (placement?.state === 'closed' && placement.resumeMachineId === machineId && !operation.resumeSpaceIds.includes(spaceId)) operation.resumeSpaceIds.push(spaceId);
      }
      if (operation.resumeSpaceIds.length !== previousCount) save(operation.phase, true);
    }
    if (operation.phase === 'staging') {
      if (!state.desiredImage) state.desiredImage = (await resolveCloudImage(env, state.selection)).image;
      save('staging', !!operation.recoveryOf);
      await prepareCloudImage(env, state.desiredImage);
      const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(env, `${path}/image/status`));
      if (!operation.recoveryOf) state.currentImage = provider.image;
      // Commit the admission barrier before asking the source to quiesce and checkpoint.
      save('checkpointing', true);
    }
    if (operation.phase === 'checkpointing') {
      for (const { spaceId, placement } of await placements()) {
        if (placement?.machineId === machineId || placement?.resumeMachineId === machineId) {
          if (!operation.resumeSpaceIds.includes(spaceId)) operation.resumeSpaceIds.push(spaceId);
        }
      }
      save('checkpointing', true);
      try {
        // The provider may reuse the inherited checkpoint only when its durable
        // runtimeStarted=false proves no container start was attempted, including ENTRYPOINT/CMD.
        // Otherwise this must checkpoint the actual candidate, not its predecessor.
        await controlCloudflareSandboxReplacement({ env, userId: env.ACCOUNT_ID, machineId, action: 'prepare-replacement' });
        for (const { spaceId, placement } of await placements()) {
          if (placement?.machineId === machineId && placement.state !== 'closed') throw new Error(`Machine still owns uncheckpointed workspace ${spaceId}`);
          if (placement?.resumeMachineId === machineId && !operation.resumeSpaceIds.includes(spaceId)) operation.resumeSpaceIds.push(spaceId);
          if (operation.resumeSpaceIds.includes(spaceId) && (!placement || placement.state !== 'closed' || !placement.manifestHash)) throw new Error(`Workspace ${spaceId} has no durable closed checkpoint`);
        }
        // This is the point of no cancellation: selection may succeed without a response.
        save('replacing', true);
      } catch (error) {
        if (!operation.recoveryOf || !operation.discardApproval) throw error;
        // Explicit discard can return only to real previously committed manifests.
        // Never stop the candidate first and then discover recovery is impossible.
        for (const spaceId of operation.resumeSpaceIds) {
          const placement = await authorities.getByName(`${env.ACCOUNT_ID}:${spaceId}`).get();
          if (!placement?.manifestKey || !placement.manifestHash || placement.publishedRevision < 1
            || (placement.machineId !== machineId && placement.resumeMachineId !== machineId)) throw new Error(`Workspace ${spaceId} has no owned committed checkpoint for explicit discard recovery`);
        }
        const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(env, `${path}/image/status`));
        if (!provider.operationId) throw new Error('Provider cannot bind a stopped-candidate receipt to this failed image operation');
        operation.discardOperationId = provider.operationId;
        save('discarding', true);
      }
    }
    if (operation.phase === 'discarding') {
      if (!operation.discardApproval || !operation.discardOperationId) throw new Error('Explicit candidate discard approval or identity is missing');
      const receipt = cloudImageDiscardReceiptSchema.parse(await cloudImageProviderCall(env, `${path}/image/discard`, { operationId: operation.discardOperationId, recoveryOperationId: operation.id }));
      if (receipt.machineId !== machineId || receipt.operationId !== operation.discardOperationId || receipt.recoveryOperationId !== operation.id) throw new Error('Provider stop receipt does not match the approved candidate recovery');
      operation.discardReceipt = receipt;
      save('fencing', true);
    }
    if (operation.phase === 'fencing') {
      if (!operation.discardApproval || !operation.discardReceipt) throw new Error('Recovery requires explicit approval and a verified stopped-candidate receipt');
      for (const spaceId of operation.resumeSpaceIds) {
        const authority = authorities.getByName(`${env.ACCOUNT_ID}:${spaceId}`);
        const placement = await authority.get();
        if (!placement) throw new Error(`Recovery workspace ${spaceId} is unavailable`);
        const recovered = await authority.recoverStoppedImage({ userId: env.ACCOUNT_ID, expectedGeneration: placement.generation, receipt: operation.discardReceipt });
        if (recovered.status === 'error') throw new Error(recovered.failure.message);
      }
      save('replacing', true);
    }
    if (operation.phase === 'replacing') {
      const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(env, `${path}/image/status`));
      if (provider.operationId !== operation.id || provider.image !== state.desiredImage) {
        if (!provider.prepared) throw new Error('Provider has not acknowledged source preparation; image selection remains fenced');
        await cloudImageProviderCall(env, `${path}/image`, { image: state.desiredImage, operationId: operation.id });
      }
      save('resuming', true);
    }
    if (operation.phase === 'resuming' || operation.phase === 'confirming') {
      save('resuming', true);
      const resumed = await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId, action: 'resume' });
      if (!resumed || resumed.state !== 'online') throw new Error('Replacement machine is not ready; retry recovery');
      save('confirming', true);
      const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(env, `${path}/image/status`));
      if (provider.image !== state.desiredImage || provider.operationId !== operation.id || provider.prepared) throw new Error('Provider has not confirmed the selected image is running and ready');
      for (const spaceId of operation.resumeSpaceIds) {
        const placement = await authorities.getByName(`${env.ACCOUNT_ID}:${spaceId}`).get();
        if (placement?.state !== 'open' || placement.machineId !== machineId) throw new Error(`Workspace ${spaceId} has not recovered on the replacement machine; retry recovery`);
      }
      const current = store.getMachine(machineId)!;
      store.putMachine({ ...resumed, notes: current.notes, lifecycleRevision: Math.max(current.lifecycleRevision, resumed.lifecycleRevision) + 1 });
      state.currentImage = provider.image;
      save('complete', false);
    }
    if (operation.phase === 'cancelling') {
      await controlCloudflareSandboxReplacement({ env, userId: env.ACCOUNT_ID, machineId, action: 'cancel-replacement' });
      const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(env, `${path}/image/status`));
      if (provider.prepared || provider.operationId === operation.id || provider.image !== state.currentImage) throw new Error('Cancellation cannot confirm the original image; admission remains fenced');
      const resumed = await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId, action: 'status' });
      if (!resumed || resumed.state !== 'online') throw new Error('Original machine is not ready after cancellation');
      for (const spaceId of operation.resumeSpaceIds) {
        const placement = await authorities.getByName(`${env.ACCOUNT_ID}:${spaceId}`).get();
        if (placement?.state !== 'open' || placement.machineId !== machineId) throw new Error(`Workspace ${spaceId} still needs cancellation recovery`);
      }
      state.desiredImage = state.currentImage;
      save('cancelled', false);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'cloud_image_operation', machineId, operationId: operation.id, phase: operation.phase, barrier: operation.barrier, resumeSpaceIds: operation.resumeSpaceIds, elapsedMs: Date.now() - attemptStarted, outcome: 'failure', errorName: error instanceof Error ? error.name : 'UnknownError' }));
    operation.error = error instanceof Error ? error.message : String(error);
    operation.updatedAt = Date.now();
    store.saveCloudImage({ ...state, operation });
  }
}
