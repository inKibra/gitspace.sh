import type { RuntimeAttachment } from '@gitspace/protocol-runtime';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
import type { AttachmentMachineKind } from '@gitspace/runtime-workspace-do';

/** A sandbox is a cloud machine: it costs money while held and gets short, reapable attachment leases. */
export function attachmentMachineKind(machine: Pick<FleetMachineDefinition, 'kind'>): AttachmentMachineKind {
  return machine.kind === 'sandbox' ? 'cloud' : 'computer';
}

/**
 * Before a machine's credentials are removed, every live attachment it holds in any workspace becomes `lost`, its
 * unresolved attempts end interrupted and every lifecycle claim it holds is released. Idempotent. One unreachable
 * workspace never blocks the removal: its own lease sweep later finds the machine gone from the fleet and loses it.
 */
export async function releaseMachineAttachments(env: Env, userId: string, machineId: string, reason: 'machine-destroyed' | 'machine-revoked'): Promise<void> {
  for (const space of await env.FLEET_CATALOG.getByName(userId).listSpaces()) {
    try {
      await env.SPACE_AUTHORITY.getByName(`${userId}:${space.spaceId}`).runtimeLoseMachine(machineId, reason);
      await env.PROJECT_AUTHORITY.getByName(`${userId}:${space.projectId}`).releaseLostLifecycleClaims(space.spaceId, { machineId, reason });
    } catch (error) {
      console.error('Machine attachment release deferred to the workspace lease sweep', { spaceId: space.spaceId, machineId, error });
    }
  }
}

/** Every attachment record of the machine across the account's workspaces, read without starting any runtime. */
export async function listMachineAttachments(env: Env, userId: string, machineId: string): Promise<RuntimeAttachment[]> {
  const attachments: RuntimeAttachment[] = [];
  for (const space of await env.FLEET_CATALOG.getByName(userId).listSpaces()) {
    attachments.push(...await env.SPACE_AUTHORITY.getByName(`${userId}:${space.spaceId}`).runtimeMachineAttachments(machineId));
  }
  return attachments;
}

/**
 * Attachments of machines destroyed or revoked before attachment leases existed hold their fences forever. One sweep
 * of every workspace resolves them (a machine missing from the fleet is lost) and starts the leases of the rest.
 * Each workspace also sweeps itself when its runtime first opens with unsettled leases; this covers the others.
 */
export async function backfillRuntimeLeases(env: Env, userId: string): Promise<void> {
  const catalog = env.FLEET_CATALOG.getByName(userId);
  if (!await catalog.runtimeLeaseBackfillPending()) return;
  const spaces = await catalog.listSpaces();
  const failed: string[] = [];
  for (const space of spaces) {
    try { await env.SPACE_AUTHORITY.getByName(`${userId}:${space.spaceId}`).runtimeSweepLeases(); }
    catch (error) {
      failed.push(space.spaceId);
      console.error('Runtime lease backfill will retry this workspace', { spaceId: space.spaceId, error });
    }
  }
  if (!failed.length) await catalog.completeRuntimeLeaseBackfill();
  console.info('Runtime lease backfill', { spaces: spaces.length, failed, complete: failed.length === 0 });
}
