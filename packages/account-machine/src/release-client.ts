import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ReleaseRecord } from '@gitspace/protocol';
import { portableFileKey, portableManifestSchema } from '@gitspace/protocol/machine-release';

/** The account's verified blob store, as the release follower reads it. */
export interface ReleaseClientBlobs { get(key: string, hash: string): Promise<Uint8Array | null> }

const CLIENT = 'cli/gitspace.js';

/**
 * Points this computer's `gitspace` command at `release`'s client, as the account's installer does
 * (`protocol/src/install-script.ts`): the client at `<data>/releases/<sha>/gitspace.js`, run through `<install>/gitspace`
 * on the Bun this machine runs on. The command then follows the release the machine runs instead of staying on the one
 * it was installed with. Only a computer that has the command is changed. Answers whether anything was written.
 */
export async function followReleaseClient(release: ReleaseRecord, blobs: ReleaseClientBlobs, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const portable = release.artifacts.portable;
  const launcher = join(environment.GITSPACE_INSTALL_DIR ?? join(homedir(), '.local', 'bin'), 'gitspace');
  if (!portable || !existsSync(launcher)) return false;
  const client = join(environment.GITSPACE_DATA_DIR ?? join(homedir(), '.local', 'share', 'gitspace'), 'releases', release.sha, 'gitspace.js');
  // The installer refuses such directories too: a quote would end the launcher's quoted paths.
  if (client.includes("'") || process.execPath.includes("'")) throw new Error('The GitSpace client path must not contain a single quote');
  const script = `#!/bin/sh\nexec '${process.execPath}' '${client}' "$@"\n`;
  const installed = Bun.file(launcher);
  if (existsSync(client) && installed.size === script.length && await installed.text() === script) return false;
  const manifestBytes = await blobs.get(portable.key, portable.hash);
  if (!manifestBytes) throw new Error(`Portable release manifest ${portable.key} is missing`);
  const file = portableManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes))).files.find(candidate => candidate.path === CLIENT);
  if (!file) return false;
  const bytes = await blobs.get(portableFileKey(portable.key, CLIENT), `sha256:${file.sha256}`);
  if (!bytes) throw new Error(`Portable file ${CLIENT} is missing`);
  await mkdir(dirname(client), { recursive: true });
  await writeFile(`${client}.${process.pid}.tmp`, bytes, { mode: 0o644 });
  await rename(`${client}.${process.pid}.tmp`, client);
  // A rename on the same filesystem replaces the command at once; a failure before it leaves the old one working.
  await writeFile(`${launcher}.${process.pid}.tmp`, script, { mode: 0o755 });
  await rename(`${launcher}.${process.pid}.tmp`, launcher);
  return true;
}
