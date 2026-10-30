import type { ReleaseRecord } from '@gitspace/protocol/deployment';
import { platformDeploy, type WorkerSwap } from './tenant-platform.js';

/** Swaps the account's Worker to `record`'s. The platform reads its manifest and modules through this account
 * (`/__platform/objects`), from account storage or, for a published release, from the channel. */
export async function deployReleaseWorker(env: Env, userId: string, record: ReleaseRecord): Promise<WorkerSwap> {
  const worker = record.artifacts.worker;
  if (!worker || !record.worker) return { status: 'failed', error: 'Worker artifact and metadata are required' };
  return platformDeploy(env, { sha: record.sha, manifestKey: `users/${userId}/${worker.key}`, manifestHash: worker.hash, metadata: record.worker, accountId: userId });
}

/** Every workspace object hears of the new release; one still resident on older code restarts on it when idle. */
export async function restartSpacesForRelease(env: Env, userId: string, sha: string): Promise<void> {
  const definitions = await env.FLEET_CATALOG.getByName(userId).listSpaces();
  const outcomes = await Promise.all(definitions.map(definition => env.SPACE_AUTHORITY.getByName(`${userId}:${definition.spaceId}`).restartForRelease(sha).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'release_restart_failed', sha, workspaceId: definition.spaceId, message: error instanceof Error ? error.message : String(error) }));
    return 'failed';
  })));
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  console.info(JSON.stringify({ event: 'release_restarts', sha, ...counts }));
}
