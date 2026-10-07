import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';

const pending = new Map<string, Promise<string>>();
async function git(root: string, args: string[]): Promise<Buffer> {
  const result = Promise.withResolvers<Buffer>();
  execFile('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }, (error, stdout, stderr) => {
    if (error) result.reject(new Error(`Canonical search Git read failed: ${stderr.toString() || error.message}`));
    else result.resolve(stdout);
  });
  return result.promise;
}

/** Raw Git bytes, never checkout filters or hydrated LFS. Keep only the last canonical search tree per checkout. */
export async function materializeSearchSnapshot(root: string, checkpoint: RuntimeGitCheckpoint): Promise<string> {
  const canonical = await realpath(root);
  const key = createHash('sha256').update(canonical).digest('hex');
  const cache = join(tmpdir(), 'gitspace-search-snapshots', key);
  const prior = pending.get(cache) ?? Promise.resolve('');
  const operation = prior.catch(() => '').then(async () => {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    for (const name of await readdir(cache)) if (name.startsWith('pending-')) await rm(join(cache, name), { recursive: true, force: true });
    const tree = join(cache, 'current');
    const marker = join(cache, 'commit');
    const commit = await readFile(marker, 'utf8').catch(() => null);
    if (commit === checkpoint.worktreeCommit) return tree;
    const actualTree = new TextDecoder().decode(await git(canonical, ['rev-parse', `${checkpoint.worktreeCommit}^{tree}`])).trim();
    if (actualTree !== checkpoint.worktreeTree) throw new Error('Canonical search commit/tree mismatch');
    const entries = new TextDecoder().decode(await git(canonical, ['ls-tree', '-rz', '--full-tree', checkpoint.worktreeCommit])).split('\0').filter(Boolean);
    const scratch = await mkdtemp(join(cache, 'pending-'));
    try {
      for (const entry of entries) {
        const separator = entry.indexOf('\t');
        const header = entry.slice(0, separator).split(' ');
        const path = entry.slice(separator + 1);
        if (header[1] !== 'blob' || (header[0] !== '100644' && header[0] !== '100755')) continue;
        if (separator < 0 || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '.git') || !header[2]) throw new Error('Invalid canonical search Git tree entry');
        const target = join(scratch, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, await git(canonical, ['cat-file', 'blob', header[2]]), { mode: 0o400 });
      }
      // The executor checkout queue excludes concurrent grep readers while switching snapshots.
      await rm(marker, { force: true });
      await rm(tree, { recursive: true, force: true });
      await rename(scratch, tree);
      await writeFile(marker, checkpoint.worktreeCommit, { mode: 0o600 });
      return tree;
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  pending.set(cache, operation);
  try { return await operation; }
  finally { if (pending.get(cache) === operation) pending.delete(cache); }
}
