import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import {
  executableManifestPath,
  parseExecutableArtifactManifest,
  validateExecutableArtifact,
} from '@gitspace/account-omp/manifest';
import { alive, readJson, verifyMachine } from './machine-update.js';
import type { MachineSelection } from './machine-update.js';

/** Distribution trust anchors are compiled into host.js, not downloaded runtime code. */
export async function startMachineHost(): Promise<void> {
  const environment = process.env;
  const root = environment.GITSPACE_ENVIRONMENT_ROOT;
  if (!root) throw new Error('GITSPACE_ENVIRONMENT_ROOT is required');
  await mkdir(root, { recursive: true });
  environment.GITSPACE_CONTROL_TOKEN ??= (await readJson<{ token: string }>(join(root, 'host-control.json')))?.token;
  const bundleRoot = environment.GITSPACE_BUNDLE_ROOT ?? import.meta.dir;
  environment.GITSPACE_BUNDLE_ROOT = bundleRoot;
  environment.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH ??= process.env.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH;
  environment.GITSPACE_OMP_MANIFEST_HASH ??= process.env.GITSPACE_INITIAL_OMP_MANIFEST_HASH;
  environment.GITSPACE_OMP_RUNTIME_PATH ??= join(bundleRoot, 'omp', 'omp.js');
  const transaction = await readJson<{ pid: number; candidate: MachineSelection }>(join(root, 'machine-update.json'));
  if (transaction) {
    if (alive(transaction.pid)) return;
    await verifyMachine(transaction.candidate);
    const updater = await import(join(transaction.candidate.path, 'machine-update.js'));
    await updater.runMachineUpdate();
    return;
  }
  let selection = await readJson<MachineSelection>(join(root, 'host-selection.json'));
  if (!selection) {
    const path = join(bundleRoot, 'machine');
    const manifestHash = environment.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH;
    if (!manifestHash) throw new Error('Initial machine manifest trust anchor is required');
    const manifest = parseExecutableArtifactManifest(await readFile(executableManifestPath(path)), {
      target: 'machine',
      manifestHash,
    });
    await validateExecutableArtifact(path, { target: 'machine', hash: manifest.treeHash, manifestHash });
    selection = { version: 1, path, hash: manifest.treeHash, releaseSha: null };
  }
  await verifyMachine(selection);
  environment.GITSPACE_HOST_SELECTION = JSON.stringify(selection);
  await import(join(selection.path, 'host-runtime.js'));
}
if (import.meta.main) await startMachineHost();
