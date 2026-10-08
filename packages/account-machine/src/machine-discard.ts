import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MachineDiscardRequired, type MachineDiscardConfirmation, type MachineDiscardScope } from '@gitspace/protocol/machine-discard';

/** The capability is process-local, one-use, and bound to the exact stopped work inventory. */
export class MachineDiscardGate {
  private issued: { digest: string; confirmation: MachineDiscardConfirmation } | null = null;
  constructor(private readonly machineId: string) {}
  require(action: 'sleep' | 'destroy', digest: string, workspaces: MachineDiscardScope[]): MachineDiscardRequired;
  require(action: 'sleep' | 'destroy', digest: string, workspaces: MachineDiscardScope[], confirmation: MachineDiscardConfirmation): null;
  require(action: 'sleep' | 'destroy', digest: string, workspaces: MachineDiscardScope[], confirmation?: MachineDiscardConfirmation): MachineDiscardRequired | null {
    const scope = JSON.stringify({ digest, workspaces });
    if (confirmation) {
      const issued = this.issued;
      if (!issued || issued.digest !== scope || confirmation.machineId !== this.machineId || confirmation.action !== action
        || issued.confirmation.action !== action || confirmation.token !== issued.confirmation.token) {
        throw new Error('Discard confirmation is stale or does not match this machine, operation and local work. Review the current loss scope again.');
      }
      this.issued = null;
      return null;
    }
    if (!this.issued || this.issued.digest !== scope || this.issued.confirmation.action !== action) {
      this.issued = { digest: scope, confirmation: { machineId: this.machineId, action, token: crypto.randomUUID() } };
    }
    return new MachineDiscardRequired({ message: 'This machine retains unpublished local work. Saving failed; review the loss scope before explicitly discarding it.', confirmation: this.issued.confirmation, workspaces });
  }
}

/** Includes ignored files, symlink targets, index and local refs; never edits a checkout. */
export async function localWorkDigest(paths: readonly string[], authority: unknown): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(authority));
  const visited = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    const stat = await lstat(path);
    hash.update(JSON.stringify([path, stat.mode]));
    if (stat.isSymbolicLink()) { hash.update(await readlink(path)); return; }
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        // A concurrent Git writer invalidates the capture rather than granting
        // permission from a mixed index/ref snapshot.
        if (name.endsWith('.lock') && path.includes('/.git')) throw new Error(`Git is changing ${path}`);
        await visit(join(path, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Cannot safely fingerprint local special file ${path}`);
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  };
  for (const path of [...paths].sort()) {
    await visit(path);
    const git = Bun.spawn(['git', 'rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
    const [out, error, exitCode] = await Promise.all([new Response(git.stdout).text(), new Response(git.stderr).text(), git.exited]);
    if (exitCode !== 0) throw new Error(`Cannot fingerprint Git metadata: ${error}`);
    for (const directory of out.trim().split('\n')) await visit(directory);
  }
  return hash.digest('hex');
}
