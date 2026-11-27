import { rpcClient } from './rpc-client.js';

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

/** Update base, one action wherever the project page offers it, its failed card's Retry included. For an origin its
 * bridge reads, that machine fast-forwards the project's copy of the base branch first (`project.seed`), then the cloud
 * moves the base workspace and records the origin's head the machine read, without reading the origin itself. */
export async function updateProjectBase(projectId: string): Promise<void> {
  const machineId = await originReader(projectId, 'Update base');
  if (machineId === null) {
    const updated = await rpcClient.project.updateBase({ projectId });
    if (updated.status === 'error') throw updated.error;
    return;
  }
  const copied = await rpcClient.project.seed({ projectId, machineId });
  if (copied.status === 'error') throw copied.error;
  const updated = await rpcClient.project.updateBase({ projectId, copied: copied.value });
  if (updated.status === 'error') throw updated.error;
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
