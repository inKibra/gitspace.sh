import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckpointBlobStore } from '@gitspace/account-machine';
import { currentDistributionPlatform } from '@gitspace/deployment/distribution';
import { assembleMachineGeneration } from '@gitspace/deployment/machine-assembly';
import { parseInstallMetadata } from '@gitspace/protocol/install-script';
import { nativeMirrorKey, PORTABLE_MANIFEST_FILE, portableFileKey, portableManifestSchema } from '@gitspace/protocol/machine-release';

/** The host entry of a runtime built here: the generation's own bootstrap, trusting the generation built with it. */
function hostEntry(manifestHash: string): string {
  return [
    '// Written by gitspace machine setup: starts the machine host of the generation installed beside this file, loaded',
    '// from where it was installed (a runtime path, so imported dynamically).',
    'process.env.GITSPACE_BUNDLE_ROOT ??= import.meta.dir;',
    `process.env.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH ??= ${JSON.stringify(manifestHash)};`,
    "const { startMachineHost } = await import('./machine/machine-bootstrap.js');",
    'await startMachineHost();',
    '',
  ].join('\n');
}

/**
 * Builds this computer's machine runtime from its account's release, which the account names at
 * `distribution/v1/install/<platform>.txt`: `bin/bun` (the Bun this client runs on, the release's pinned one as the
 * installer verified it), `machine/` (a generation built here from the release's portable files and the account's copy
 * of its native tools, read through the signed data endpoint: `assembleMachineGeneration`), and `host.js`, starting that
 * generation's bootstrap with its manifest as the host's trust anchor. Records the runtime in `runtime-selection.json`
 * and returns its path. Nothing comes from anywhere but the account.
 */
export async function installRuntime(configRoot: string, account: { accountUrl: string; blobs: Pick<CheckpointBlobStore, 'get'> }): Promise<string> {
  const platform = currentDistributionPlatform();
  const response = await fetch(new URL(`/distribution/v1/install/${platform}.txt`, account.accountUrl), { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Your account has no machine release to install (HTTP ${response.status}). Launch a release with the machine target, then run gitspace machine start.`);
  const install = parseInstallMetadata(await response.text());
  const key = `releases/${install.release}/${PORTABLE_MANIFEST_FILE}`;
  const bytes = await account.blobs.get(key, `sha256:${install.portableSha256}`);
  if (!bytes) throw new Error(`Release ${install.release} has no portable files in your account`);
  const manifest = portableManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const root = join(configRoot, 'runtimes', `${install.release}-${platform}-${Bun.version}`);
  if (!existsSync(join(root, 'host.js'))) {
    const staging = `${root}.staging-${randomUUID()}`;
    await mkdir(join(staging, 'bin'), { recursive: true });
    try {
      await copyFile(process.execPath, join(staging, 'bin', 'bun'));
      await chmod(join(staging, 'bin', 'bun'), 0o755);
      await mkdir(join(staging, 'machine'));
      const built = await assembleMachineGeneration({
        manifest, output: join(staging, 'machine'),
        file: async file => {
          const content = await account.blobs.get(portableFileKey(key, file.path), `sha256:${file.sha256}`);
          if (!content) throw new Error(`Release file ${file.path} is missing from your account`);
          return content;
        },
        archive: async pin => {
          const content = await account.blobs.get(nativeMirrorKey(pin.sha256), `sha256:${pin.sha256}`);
          if (!content) throw new Error(`Your account holds no copy of ${pin.url}`);
          return new Response(content.slice());
        },
      });
      await writeFile(join(staging, 'host.js'), hostEntry(built.manifestHash));
      await rename(staging, root);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const selection = join(configRoot, 'runtime-selection.json');
  const temporary = `${selection}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ path: root }), { mode: 0o600 });
  await rename(temporary, selection);
  return root;
}
