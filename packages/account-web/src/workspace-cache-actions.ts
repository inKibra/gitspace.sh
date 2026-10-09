import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { rpcClient } from './rpc-client.js';
import { runtimeLfsHeldBack, type ConfirmLfsTransition } from './LfsTransition.js';

/** Release disposable caches, not the cloud workspace or its conversations. Each detach retains the
 * attachment's generation fence and the machine's publication and execution-drain barriers. */
export async function releaseWorkspaceCaches(
  snapshot: RuntimeSnapshot,
  confirm: ConfirmLfsTransition,
  onCommit: () => void | Promise<void>,
  detach: (input: Parameters<typeof rpcClient.runtime.attachment.detach>[0]) => Promise<void>,
): Promise<void> {
  const caches = snapshot.attachments.filter(attachment => attachment.role === 'cache' && attachment.state !== 'lost' && attachment.state !== 'detached' && attachment.state !== 'draining');
  if (!caches.length) throw new Error('No machine caches need a release request. Check Environment for any drains already in progress; the cloud workspace remains available.');
  const heldBack = runtimeLfsHeldBack(snapshot);
  const blockedReason = caches.flatMap(attachment => attachment.cache?.reclaimBlocked ? [attachment.cache.reclaimBlocked] : []).join('\n');
  if (!await confirm(heldBack, onCommit, blockedReason || null)) return;
  const identity = RuntimeIdentitySchema.parse(snapshot);
  for (const attachment of caches) {
    await detach({
      ...identity, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation,
      ...(heldBack.length || attachment.cache?.reclaimBlocked ? { discardHeldBack: true } : {}),
    });
  }
}
