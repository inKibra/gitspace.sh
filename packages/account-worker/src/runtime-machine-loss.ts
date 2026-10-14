import type { RuntimeAttachment } from '@gitspace/protocol-runtime';

/**
 * Before a machine's credentials are removed, its attachments in every workspace are detached and every lifecycle
 * claim it holds is released. Idempotent. One unreachable workspace never blocks the removal.
 */
export async function releaseMachineAttachments(env: Env, userId: string, machineId: string, reason: 'machine-destroyed' | 'machine-revoked'): Promise<void> {
  for (const space of await env.FLEET_CATALOG.getByName(userId).listSpaces()) {
    try {
      await env.SPACE_AUTHORITY.getByName(`${userId}:${space.spaceId}`).runtimeRemoveMachine(machineId);
      await env.PROJECT_AUTHORITY.getByName(`${userId}:${space.projectId}`).releaseLostLifecycleClaims(space.spaceId, { machineId, reason });
    } catch (error) {
      console.error('Machine attachment release failed for a workspace', { spaceId: space.spaceId, machineId, error });
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
