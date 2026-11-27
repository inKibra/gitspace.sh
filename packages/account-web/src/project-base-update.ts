import { rpcClient } from './rpc-client.js';

/**
 * Update base, one action wherever the project page offers it. A private GitHub repository the App does not cover is
 * read only by its bridge, the machine attached to the project's base workspace: that machine fast-forwards the
 * project's copy of the base branch first (`project.seed`), then the cloud moves the base workspace and records the
 * origin's head the machine read, without reading the origin itself. Any other origin the cloud reads itself.
 */
export async function updateProjectBase(projectId: string): Promise<void> {
  const access = await rpcClient.github.projectAccess({ projectId });
  if (access.status === 'error') throw access.error;
  const blocked = access.value;
  if (blocked.state === 'ready' || blocked.state === 'awaits-copy') {
    const updated = await rpcClient.project.updateBase({ projectId });
    if (updated.status === 'error') throw updated.error;
    return;
  }
  const { bridge } = blocked;
  if (bridge === null) throw new Error(`GitSpace can't read ${blocked.repository}: attach one of your machines to the project's base workspace to read it with the account SSH key, or install the GitHub App on ${blocked.organization}, then update again.`);
  if (!bridge.online) throw new Error(`Update base reads ${blocked.repository} through ${bridge.label}, which is offline: bring ${bridge.label} online, then update again.`);
  const copied = await rpcClient.project.seed({ projectId, machineId: bridge.machineId });
  if (copied.status === 'error') throw copied.error;
  const updated = await rpcClient.project.updateBase({ projectId, copied: copied.value });
  if (updated.status === 'error') throw updated.error;
}
