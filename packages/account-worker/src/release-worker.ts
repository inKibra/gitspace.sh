import type { ReleaseRecord } from '@gitspace/protocol/deployment';
import { platformDeploy, type WorkerSwap } from './tenant-platform.js';
import type { BudgetedDurableObject } from './storage-quarantine.js';

/** Swaps the account's Worker to `record`'s. The platform reads its manifest and modules through this account
 * (`/__platform/objects`), from account storage or, for a published release, from the channel. */
export async function deployReleaseWorker(env: Env, userId: string, record: ReleaseRecord): Promise<WorkerSwap> {
  const worker = record.artifacts.worker;
  if (!worker || !record.worker) return { status: 'failed', error: 'Worker artifact and metadata are required', startupTimeMs: null };
  return platformDeploy(env, { sha: record.sha, manifestKey: `users/${userId}/${worker.key}`, manifestHash: worker.hash, metadata: record.worker, accountId: userId });
}

type ReleaseObject = [DurableObjectNamespace<BudgetedDurableObject>, string];

/**
 * A release went live: the account's objects, its projects' and its workspaces' hear of it, and each one still
 * running older code restarts on the new code (a workspace once its running work ends). An object that was not
 * running starts on the new code to answer, so only the ones Cloudflare left on older code restart. The release object
 * itself is told last, once every other object has answered: its caller finishes the launch before this.
 */
export async function restartObjectsForRelease(env: Env, userId: string, sha: string): Promise<void> {
  const [spaces, projects] = await Promise.all([env.FLEET_CATALOG.getByName(userId).listSpaces(), env.USER_PROJECTS.getByName(userId).list()]);
  const objects: ReleaseObject[] = [
    [env.RELAY, env.RELAY_NAME], [env.CREDENTIALS, userId], [env.USER_STORAGE, userId], [env.FLEET_CATALOG, userId], [env.USER_SETTINGS, userId],
    [env.PROJECT_SECRETS, userId], [env.USER_SKILLS, userId], [env.USER_PROJECTS, userId], [env.USER_MCP_CONNECTIONS, userId], [env.GITHUB_APP, userId],
    [env.ACCOUNT_STATE, 'account'], [env.ACCOUNT_STATE, userId],
    ...projects.flatMap((project): ReleaseObject[] => [[env.PROJECT_AUTHORITY, `${userId}:${project.id}`], [env.PROJECT_AUTOMATIONS, `${userId}:${project.id}`]]),
    ...spaces.map((definition): ReleaseObject => [env.SPACE_AUTHORITY, `${userId}:${definition.spaceId}`]),
  ];
  const counts: Record<string, number> = {};
  for (const batch of [objects, [[env.TENANT_RELEASES, userId]] satisfies ReleaseObject[]]) {
    const outcomes = await Promise.all(batch.map(([namespace, name]) => namespace.getByName(name).restartForRelease(sha).catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'release_restart_failed', sha, name, message: error instanceof Error ? error.message : String(error) }));
      return 'failed';
    })));
    for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  console.info(JSON.stringify({ event: 'release_restarts', sha, ...counts }));
}

/** Thrown by `acrossRelease` when the object called still runs code from before the release that added the method. */
export class ReleaseUpdatingError extends Error {
  override readonly name = 'ReleaseUpdatingError';
  constructor() { super('GitSpace is finishing an update. Try again in a minute.'); }
}

/** Waits before each retry; the restart after a release lands an object on the new code within a second. */
const RELEASE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000];

/**
 * Calls a method of another Durable Object that a recent release added. Right after a release the object can still
 * run the previous code, whose RPC receiver answers "does not implement the method" without running anything, so the
 * call is safe to repeat: it is retried a few times, then fails with `ReleaseUpdatingError`. Any other error is thrown
 * at once.
 */
export async function acrossRelease<T>(call: () => Promise<T>): Promise<T> {
  for (const delay of [...RELEASE_RETRY_DELAYS_MS, null]) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('does not implement the method'))) throw error;
      console.warn(JSON.stringify({ event: 'rpc_receiver_outdated', message: error.message, retrying: delay !== null }));
      if (delay === null) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delay);
      await promise;
    }
  }
  throw new ReleaseUpdatingError();
}
