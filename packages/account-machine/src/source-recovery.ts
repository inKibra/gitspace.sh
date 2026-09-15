import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import type { Workspace } from '@gitspace/core';
import { CloudSpaceCheckpointAuthority, CloudDataCheckpointBlobStore } from './cloud-space-authority.js';
import { DeploymentLauncher } from './deployment-launcher.js';

/** CLI recovery uses the same tenant deployment transaction, never host pointer edits or direct activation. */
export async function recoverMachineFromSource(sourceRoot: string, workspaceId: string): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Source recovery requires ${name}; run gitspace machine recover on the linked machine`);
    return value;
  };
  const environmentRoot = required('GITSPACE_ENVIRONMENT_ROOT');
  const machineId = required('GITSPACE_MACHINE_ID');
  const signingPrivateKey = new Uint8Array(Buffer.from(required('GITSPACE_MACHINE_SIGNING_PRIVATE_KEY'), 'base64'));
  if (signingPrivateKey.byteLength !== 32) throw new Error('Source recovery machine signing key is invalid');
  const control = { baseUrl: required('GITSPACE_CONTROL_URL'), userId: required('GITSPACE_USER_ID'), machineId, signingPrivateKey };
  const authority = new CloudSpaceCheckpointAuthority(control);
  // The old process owns this database until health/commit. Do not run this source tree's migrations.
  const database = new GitSpaceDatabase(join(environmentRoot, 'gitspace.db'), { readonly: true });
  let workspace: Workspace;
  try {
    const selected = database.getWorkspace(workspaceId);
    if (!selected || selected.holderId !== machineId || selected.placementState !== 'open') throw new Error('Recovery source must be an open workspace held by this machine');
    if (await realpath(selected.rootPath) !== await realpath(sourceRoot)) throw new Error('Recovery source path does not match the account workspace');
    workspace = selected;
  } finally {
    database.close();
  }
  const selectedWorkspace = workspace;
  let progress = Promise.resolve();
  const launcher = new DeploymentLauncher({
    database: { getWorkspace: (id) => id === selectedWorkspace.id ? selectedWorkspace : null },
    machineId, authority, blobs: new CloudDataCheckpointBlobStore(control),
    buildRoot: join(environmentRoot, 'recovery-builds'),
    events: {
      append: (event) => {
        const eventId = crypto.randomUUID();
        progress = progress.then(async () => {
          await authority.appendProjectEvent({
            eventId, projectId: event.projectId, scope: event.scope, entity: event.entity,
            entityId: event.entityId, revision: event.revision, operation: event.operation, payload: event.payload ?? {},
          });
        });
        void progress.catch(() => undefined);
      },
    },
  });
  const record = await launcher.launchAndWait({ workspaceId, targets: ['machine'] }).finally(() => progress);
  console.log(`Recovery staged tenant machine release ${record.sha}; waiting for the existing host's health gate. The host and runtime selections have not been replaced by this command.`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const status = await authority.deploymentStatus();
    const release = status.releases.find((candidate) => candidate.sha === record.sha);
    if (release?.status.machines[machineId] === 'failed') throw new Error(`Recovery activation failed; the host retains its predecessor: ${release.error ?? record.sha}`);
    if (status.desired.machine !== record.sha) throw new Error('Another account selection superseded recovery; no host or runtime selection was changed by this command');
    const running = status.current.machines[machineId];
    if (running?.sha === record.sha && release?.status.machines[machineId] === 'applied') {
      console.log(JSON.stringify({ status: 'applied', machineId, sha: record.sha, generation: running.generation }));
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Recovery release ${record.sha} is still pending. Inspect ordinary deployment progress in the account; the host/bootstrap selection was not changed.`);
}

if (import.meta.main) {
  const workspaceId = process.argv[2];
  const sourceRoot = process.argv[3];
  if (!workspaceId || !sourceRoot) throw new Error('Use gitspace machine recover --workspace <id> --source <checkout>');
  await recoverMachineFromSource(sourceRoot, workspaceId);
}
