import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DaemonBrokerClient } from './client.js';
import { ProcessIdentitySchema } from './protocol.js';
import { sameProcess, supervisorHome } from './process-identity.js';

/** A broker's runtime-directory record of the project it supervises. */
export const BROKER_RECORD = 'broker.json';
const BrokerRecordSchema = z.object({ project: z.string() });
const FINISHED = ['exited', 'failed'];

export interface BrokerReconciliation {
  /** The broker's runtime directory. */
  directory: string;
  /** Null for a broker from before `broker.json`: it is kept or shut down, never stopped or pruned. */
  project: string | null;
  /**
   * `captured`: it still runs processes, which carry on under it. `shut-down`: it ran nothing and exited; the next
   * caller starts one on current code. `stopped`: its project is gone, so its processes were stopped and it exited.
   * `pruned`: no broker ran there, its project is gone and nothing recorded is alive, so the directory was removed.
   */
  outcome: 'captured' | 'shut-down' | 'stopped' | 'pruned';
  live: string[];
}

async function identityAlive(raw: unknown): Promise<boolean> {
  const identity = ProcessIdentitySchema.safeParse(raw);
  return identity.success && await sameProcess(identity.data).catch(() => false);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Whether any process recorded in a broker's directory is still running. */
async function recordsLive(directory: string): Promise<boolean> {
  const daemons = join(directory, 'daemons');
  if (!existsSync(daemons)) return false;
  for (const name of await readdir(daemons)) {
    const stored = z.object({ daemon: z.object({ state: z.string() }), identity: z.unknown() })
      .safeParse(await readJson(join(daemons, name, 'meta.json')).catch(() => null));
    if (stored.success && !FINISHED.includes(stored.data.daemon.state) && await identityAlive(stored.data.identity)) return true;
  }
  return false;
}

/**
 * Brokers outlive the machine process that started them, running the code of the release that started them. A machine
 * calls this when it starts: brokers still running processes are kept, the rest exit so the next caller starts one on
 * current code, brokers of deleted projects stop their processes, and directories nothing uses any more are removed.
 * A broker from before `broker.json` existed is kept while it runs something and shut down once it does not.
 */
export async function reconcileBrokers(home = supervisorHome()): Promise<BrokerReconciliation[]> {
  if (!existsSync(home)) return [];
  const results: BrokerReconciliation[] = [];
  for (const name of await readdir(home)) {
    const directory = join(home, name);
    const record = BrokerRecordSchema.safeParse(await readJson(join(directory, BROKER_RECORD)).catch(() => null));
    const project = record.success ? record.data.project : null;
    const projectGone = project !== null && !existsSync(project);
    if (!await identityAlive(await readJson(join(directory, 'broker.lock', 'owner.json')).catch(() => null))) {
      if (projectGone && !await recordsLive(directory)) {
        await rm(directory, { recursive: true, force: true });
        results.push({ directory, project, outcome: 'pruned', live: [] });
      }
      continue;
    }
    const client = new DaemonBrokerClient(directory);
    const listed = await client.request({ op: 'list' }).catch(() => null);
    if (listed?.op !== 'list') continue;
    const live = listed.daemons.filter(daemon => !FINISHED.includes(daemon.state)).map(daemon => daemon.name);
    if (!projectGone && live.length > 0) {
      results.push({ directory, project, outcome: 'captured', live });
      continue;
    }
    if (projectGone) for (const daemon of live) await client.request({ op: 'stop', name: daemon }).catch(() => null);
    await client.request({ op: 'shutdown' }).catch(() => null);
    results.push({ directory, project, outcome: projectGone ? 'stopped' : 'shut-down', live });
  }
  return results;
}
