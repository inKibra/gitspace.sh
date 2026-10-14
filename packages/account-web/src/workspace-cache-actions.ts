import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { rpcClient } from './rpc-client.js';
import { runtimeLfsHeldBack, type ConfirmLfsTransition } from './LfsTransition.js';

/** Detach every attached machine, not the cloud workspace or its conversations. */
export async function releaseWorkspaceCaches(
  snapshot: RuntimeSnapshot,
  confirm: ConfirmLfsTransition,
  onCommit: () => void | Promise<void>,
  detach: (input: Parameters<typeof rpcClient.runtime.attachment.detach>[0]) => Promise<void>,
): Promise<void> {
  const attached = snapshot.attachments.filter(attachment => attachment.state !== 'detached');
  if (!attached.length) throw new Error('No machines are attached to this workspace. The cloud workspace remains available.');
  if (!await confirm(runtimeLfsHeldBack(snapshot), onCommit)) return;
  const identity = RuntimeIdentitySchema.parse(snapshot);
  for (const attachment of attached) {
    await detach({ ...identity, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation });
  }
}
