import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutorJournal, type LocalAttachment } from '@gitspace/runtime-machine';
import { releaseTargetSchema, type ReleaseTarget } from '@gitspace/protocol';
import { CloudSpaceCheckpointAuthority, CloudDataCheckpointBlobStore } from './cloud-space-authority.js';
import { DeploymentLauncher, deploymentSource } from './deployment-launcher.js';

/** CLI recovery uses the same tenant deployment transaction, never host pointer edits or direct activation. */
export async function recoverReleaseFromSource(sourceRoot: string, workspaceId: string, targets: ReleaseTarget[]): Promise<void> {
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
  // The old process owns this journal until health/commit. Recovery only reads its durable cache assignment.
  const journal = new ExecutorJournal(join(environmentRoot, 'executor', 'attempts.sqlite'), { readonly: true });
  let attachments: LocalAttachment[];
  try {
    attachments = journal.attachments();
    const selected = deploymentSource(attachments, machineId, workspaceId);
    if (await realpath(selected.rootPath) !== await realpath(sourceRoot)) throw new Error('Recovery source path does not match the account workspace cache');
  } finally {
    journal.close();
  }
  const launcher = new DeploymentLauncher({
    attachments: () => attachments,
    machineId, authority, blobs: new CloudDataCheckpointBlobStore(control),
    buildRoot: join(environmentRoot, 'recovery-builds'),
  });
  const record = await launcher.launchAndWait({ workspaceId, targets });
  console.log(`Recovery staged tenant release ${record.sha}; waiting for ${targets.join(', ')} activation.`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const status = await authority.deploymentStatus();
    const release = status.releases.find((candidate) => candidate.sha === record.sha);
    let applied = true;
    for (const target of targets) {
      const state = target === 'machine' ? release?.status.machines[machineId] : release?.status[target];
      if (state === 'failed') throw new Error(`Recovery ${target} activation failed; inspect deployment rollback status: ${release?.error ?? record.sha}`);
      if (status.desired[target] !== record.sha) throw new Error(`Another account ${target} selection superseded recovery; this command will not override it`);
      if (state !== 'applied') applied = false;
      if (target === 'machine' && status.current.machines[machineId]?.sha !== record.sha) applied = false;
      if (target === 'worker' && status.current.worker.sha !== record.sha) applied = false;
    }
    if (applied) {
      console.log(JSON.stringify({ status: 'applied', machineId, sha: record.sha, targets, generation: targets.includes('machine') ? status.current.machines[machineId]?.generation : undefined }));
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Recovery release ${record.sha} is still pending. Inspect ordinary deployment progress in the account before taking further action.`);
}

if (import.meta.main) {
  const workspaceId = process.argv[2];
  const sourceRoot = process.argv[3];
  if (!workspaceId || !sourceRoot) throw new Error('Use gitspace machine recover --workspace <id> --source <checkout>');
  const targets = (process.argv[4] ?? 'machine').split(',').map(target => releaseTargetSchema.parse(target.trim()));
  await recoverReleaseFromSource(sourceRoot, workspaceId, targets);
}
