import type { FleetMachineDefinition } from './fleet-catalog.js';
import { tenantProvider } from './tenant-platform.js';
import { MachineDiscardRequired, machineDiscardRequiredSchema, machineReplacementPreparedSchema, type MachineDiscardConfirmation, type MachineDiscardScope } from '@gitspace/protocol/machine-discard';
import { z } from 'zod';

export interface SandboxProvisionerService { fetch(request: Request): Promise<Response> }
export type SandboxProviderAction = 'create' | 'status' | 'sleep' | 'resume' | 'destroy' | 'prepare-replacement' | 'cancel-replacement' | 'image-default' | 'image-status' | 'image-prepare' | 'image-switch' | 'image-discard';
const SECOND = 1_000;
/** Every provider call has a deadline: a hung provider (for example a container stuck starting) fails the call, which
 * the caller records on the machine. Observations are short; prepare-replacement covers a full workspace checkpoint.
 * The machine operation lease (`MACHINE_OPERATION_LEASE_MS`) exceeds the longest chain of these calls. */
export const SANDBOX_PROVIDER_DEADLINE_MS: Record<SandboxProviderAction, number> = {
  status: 30 * SECOND, 'cancel-replacement': 30 * SECOND, destroy: 120 * SECOND, sleep: 120 * SECOND, create: 180 * SECOND, resume: 180 * SECOND, 'prepare-replacement': 600 * SECOND,
  'image-default': 30 * SECOND, 'image-status': 30 * SECOND, 'image-discard': 120 * SECOND, 'image-switch': 300 * SECOND, 'image-prepare': 600 * SECOND,
};
export class SandboxProviderTimeout extends Error {
  constructor(action: SandboxProviderAction) {
    super(`Cloudflare Sandbox ${action} timed out after ${SANDBOX_PROVIDER_DEADLINE_MS[action] / SECOND} s`);
    this.name = 'SandboxProviderTimeout';
  }
}

/** One provider round trip, response body included, bounded by the action's deadline. The request is aborted too, but
 * the deadline holds even when the transport ignores cancellation. */
export async function callProvider(service: SandboxProvisionerService, action: SandboxProviderAction, url: string, init: RequestInit): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    const timeout = new SandboxProviderTimeout(action);
    controller.abort(timeout);
    expired.reject(timeout);
  }, SANDBOX_PROVIDER_DEADLINE_MS[action]);
  try {
    return await Promise.race([(async () => {
      const response = await service.fetch(new Request(url, { ...init, signal: controller.signal }));
      const payload: unknown = await response.json();
      return { response, payload };
    })(), expired.promise]);
  } finally { clearTimeout(timer); }
}

function providerFailure(error: unknown, fallback: string): Error {
  const discard = machineDiscardRequiredSchema.safeParse(error);
  if (discard.success) return new MachineDiscardRequired(discard.data);
  if (typeof error === 'string') return new Error(error);
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return new Error(error.message);
  return new Error(fallback);
}

export async function createCloudflareSandboxMachine(input: {
  env: Env;
  userId: string;
  machineId: string;
  image: string;
  environment: Record<string, string>;
  service?: SandboxProvisionerService;
}): Promise<FleetMachineDefinition> {
  const machineId = input.machineId;
  if (!/^sandbox-[a-z0-9-]{1,64}$/u.test(machineId)) throw new Error('Sandbox machine id is invalid');
  const service = input.service ?? tenantProvider(input.env);
  if (!service) throw new Error('Cloudflare Sandbox provisioner binding is unavailable');
  const { response, payload: raw } = await callProvider(service, 'create', 'https://sandbox.internal/v1/sandboxes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: input.userId, machineId, environment: input.environment, image: input.image }),
  });
  const payload = raw as { status?: unknown; machine?: Partial<FleetMachineDefinition>; error?: unknown };
  if (!response.ok || payload.status !== 'ok') throw providerFailure(payload.error, `Cloudflare Sandbox provisioner failed with ${response.status}`);
  const machine = payload.machine;
  if (!machine || machine.id !== machineId || machine.kind !== 'sandbox' || machine.provider !== 'cloudflare-sandbox' || (machine.state !== 'online' && machine.state !== 'offline') || typeof machine.label !== 'string' || typeof machine.notes !== 'string' || (machine.desiredState !== 'online' && machine.desiredState !== 'offline') || typeof machine.lifecycleRevision !== 'number') {
    throw new Error('Cloudflare Sandbox provisioner returned an invalid machine record');
  }
  return { id: machine.id, label: machine.label, state: machine.state, rpcEndpoint: typeof machine.rpcEndpoint === 'string' ? machine.rpcEndpoint : null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: machine.notes, desiredState: machine.desiredState, lifecycleRevision: machine.lifecycleRevision, operationId: null, error: null };
}
export async function controlCloudflareSandboxMachine(input: {
  env: Env;
  userId: string;
  machineId: string;
  action: 'status' | 'sleep' | 'resume' | 'destroy';
  service?: SandboxProvisionerService;
}): Promise<FleetMachineDefinition | null> {
  const service = input.service ?? tenantProvider(input.env);
  if (!service) throw new Error('Cloudflare Sandbox provisioner binding is unavailable');
  const { response, payload: raw } = await callProvider(service, input.action, `https://sandbox.internal/v1/sandboxes/${encodeURIComponent(input.machineId)}/${input.action}`, {
    method: 'POST',
    headers: { 'x-gitspace-user-id': input.userId },
  });
  const payload = raw as { status?: unknown; value?: Partial<FleetMachineDefinition> & { machineId?: unknown }; error?: unknown };
  if (!response.ok || payload.status !== 'ok') throw providerFailure(payload.error, `Cloudflare Sandbox ${input.action} failed with ${response.status}`);
  if (input.action === 'destroy') return null;
  const machine = payload.value;
  if (!machine || machine.id !== input.machineId || machine.kind !== 'sandbox' || machine.provider !== 'cloudflare-sandbox' || (machine.state !== 'online' && machine.state !== 'offline') || typeof machine.label !== 'string' || typeof machine.notes !== 'string' || (machine.desiredState !== 'online' && machine.desiredState !== 'offline') || typeof machine.lifecycleRevision !== 'number') {
    throw new Error(`Cloudflare Sandbox ${input.action} returned an invalid machine record`);
  }
  if (input.action === 'resume' && machine.state === 'online') {
    await controlCloudflareSandboxReplacement({ env: input.env, userId: input.userId, machineId: input.machineId, action: 'cancel-replacement', service });
  }
  return { id: machine.id, label: machine.label, state: machine.state, rpcEndpoint: typeof machine.rpcEndpoint === 'string' ? machine.rpcEndpoint : null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: machine.notes, desiredState: machine.desiredState, lifecycleRevision: machine.lifecycleRevision, operationId: null, error: null };
}

export async function controlCloudflareSandboxReplacement(input: {
  env: Env;
  userId: string;
  machineId: string;
  action: 'prepare-replacement' | 'cancel-replacement';
  service?: SandboxProvisionerService;
  machineAction?: 'sleep' | 'destroy';
  discardConfirmation?: MachineDiscardConfirmation;
}): Promise<{ discard?: MachineDiscardScope[] }> {
  const service = input.service ?? tenantProvider(input.env);
  if (!service) throw new Error('Cloudflare Sandbox provisioner binding is unavailable');
  const { response, payload } = await callProvider(service, input.action, `https://sandbox.internal/v1/sandboxes/${encodeURIComponent(input.machineId)}/${input.action}`, {
    method: 'POST',
    headers: { 'x-gitspace-user-id': input.userId, 'content-type': 'application/json' },
    body: JSON.stringify({ action: input.machineAction, discardConfirmation: input.discardConfirmation }),
  });
  if (!response.ok) {
    const failure = z.object({ error: z.unknown() }).safeParse(payload);
    throw providerFailure(failure.success ? failure.data.error : payload, `Cloudflare Sandbox ${input.action} failed with ${response.status}`);
  }
  const receipt = machineReplacementPreparedSchema.parse(payload);
  if (receipt.prepared !== (input.action === 'prepare-replacement')) throw new Error(`Cloudflare Sandbox ${input.action} returned no acknowledgement`);
  return receipt;
}
