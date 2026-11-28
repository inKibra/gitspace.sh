import type { ProjectCopyOperation } from '@gitspace/protocol';
import { rpcClient } from './rpc-client.js';

/** How often a page reads a machine's copy while it runs. */
const COPY_POLL_MS = 2_000;
/** How long a page keeps reading a copy its machine does not answer for: a machine restarting for a release update
 * continues the copy once it is back. */
const COPY_UNREACHABLE_MS = 3 * 60_000;

/**
 * The machine that reads a project's origin for `action`, or null when the cloud reads it itself. A private GitHub
 * repository the App does not cover is read only by its bridge, the machine attached to the project's base workspace;
 * no bridge, or an offline one, is an error saying what is needed.
 */
async function originReader(projectId: string, action: string): Promise<string | null> {
  const access = await rpcClient.github.projectAccess({ projectId });
  if (access.status === 'error') throw access.error;
  const blocked = access.value;
  if (blocked.state === 'ready' || blocked.state === 'awaits-copy') return null;
  const { bridge } = blocked;
  if (bridge === null) throw new Error(`GitSpace can't read ${blocked.repository}: attach one of your machines to the project's base workspace to read it with the account SSH key, or install the GitHub App on ${blocked.organization}, then try again.`);
  if (!bridge.online) throw new Error(`${action} reads ${blocked.repository} through ${bridge.label}, which is offline: bring ${bridge.label} online, then try again.`);
  return bridge.machineId;
}

/**
 * Copies a project's base branch in through `machineId` with that machine's git identity, or fast-forwards the copy
 * there (`project.seed`): the machine runs the copy in the background, joining one it already runs for the project, and
 * this reads it (`project.seedOperation`) until it ends, handing each read to `progress`. The copy goes on with the page
 * closed, and with `then: 'updateBase'` so does the Update base the machine runs after it. Resolves to the copy once it
 * moved or was already current; rejects with the reason it did not.
 */
export async function copyProjectThroughMachine(projectId: string, machineId: string, progress: (copy: ProjectCopyOperation) => void = () => {}, then?: 'updateBase'): Promise<ProjectCopyOperation> {
  const started = await rpcClient.project.seed({ projectId, machineId, ...then ? { then } : {} });
  if (started.status === 'error') throw started.error;
  let copy = started.value;
  let answered = Date.now();
  while (copy.state === 'running') {
    progress(copy);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, COPY_POLL_MS);
    await promise;
    const read = await rpcClient.project.seedOperation({ projectId, machineId, operationId: copy.operationId });
    if (read.status === 'ok') { copy = read.value; answered = Date.now(); }
    else if (Date.now() - answered > COPY_UNREACHABLE_MS) throw read.error;
  }
  progress(copy);
  if (copy.state === 'moved' || copy.state === 'current') return copy;
  throw new Error(copy.error ?? `The copy ended ${copy.state}`);
}

/** Update base, one action wherever the project page offers it, its failed card's Retry included. For an origin its
 * bridge reads, that machine fast-forwards the project's copy of the base branch (`copyProjectThroughMachine`, whose
 * reads go to `progress`) and then asks the account for Update base with that copy itself, so the update finishes
 * whether or not this page stays open; the cloud moves the base workspace without reading the origin. */
export async function updateProjectBase(projectId: string, progress?: (copy: ProjectCopyOperation) => void): Promise<void> {
  const machineId = await originReader(projectId, 'Update base');
  if (machineId === null) {
    const updated = await rpcClient.project.updateBase({ projectId });
    if (updated.status === 'error') throw updated.error;
    return;
  }
  const copy = await copyProjectThroughMachine(projectId, machineId, progress, 'updateBase');
  if (copy.updatedBase?.state !== 'done') throw new Error(copy.updatedBase?.message ?? 'The machine copied the base branch but did not ask for Update base');
}

/** Check origin. For an origin its bridge reads, that machine reads its branches (`project.remote.branches`) and the
 * cloud records them without reading the origin itself. */
export async function checkProjectOrigin(projectId: string): Promise<void> {
  const machineId = await originReader(projectId, 'Check origin');
  if (machineId === null) {
    const checked = await rpcClient.project.remote.refresh({ projectId });
    if (checked.status === 'error') throw checked.error;
    return;
  }
  const branches = await rpcClient.project.remote.branches({ projectId, machineId });
  if (branches.status === 'error') throw branches.error;
  const checked = await rpcClient.project.remote.refresh({ projectId, branches: branches.value });
  if (checked.status === 'error') throw checked.error;
}
