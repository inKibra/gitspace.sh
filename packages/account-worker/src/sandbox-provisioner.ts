import type { FleetMachineDefinition } from './fleet-catalog.js';
import { tenantProvider } from './tenant-platform.js';

export interface SandboxProvisionerService { fetch(request: Request): Promise<Response> }

function providerFailure(error: unknown, fallback: string): Error {
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
  const response = await service.fetch(new Request('https://sandbox.internal/v1/sandboxes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: input.userId, machineId, environment: input.environment, image: input.image }),
  }));
  const payload = await response.json() as { status?: unknown; machine?: Partial<FleetMachineDefinition>; error?: unknown };
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
  const response = await service.fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(input.machineId)}/${input.action}`, {
    method: 'POST',
    headers: { 'x-gitspace-user-id': input.userId },
  }));
  const payload = await response.json() as { status?: unknown; value?: Partial<FleetMachineDefinition> & { machineId?: unknown }; error?: unknown };
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
}): Promise<void> {
  const service = input.service ?? tenantProvider(input.env);
  if (!service) throw new Error('Cloudflare Sandbox provisioner binding is unavailable');
  const response = await service.fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(input.machineId)}/${input.action}`, {
    method: 'POST',
    headers: { 'x-gitspace-user-id': input.userId },
  }));
  const payload = await response.json() as { prepared?: unknown; error?: unknown };
  if (!response.ok) throw providerFailure(payload.error, `Cloudflare Sandbox ${input.action} failed with ${response.status}`);
  if (payload.prepared !== (input.action === 'prepare-replacement')) throw new Error(`Cloudflare Sandbox ${input.action} returned no acknowledgement`);
}
