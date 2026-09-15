import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutableArtifactManifest, executableManifestPath, sha256, validateExecutableArtifact } from '../src/manifest.js';


const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function generation() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-envelope-'));
  roots.push(root);
  const path = join(root, 'machine');
  await mkdir(join(path, 'drizzle'), { recursive: true });
  await writeFile(join(path, 'machine.js'), 'console.log("machine")');
  await writeFile(join(path, 'drizzle/0000.sql'), 'CREATE TABLE t(id TEXT);');
  const built = await createExecutableArtifactManifest(path, 'machine');
  const expected = { target: 'machine' as const, hash: built.manifest.treeHash, manifestHash: built.manifestHash };
  return { path, expected, manifest: built.manifest };
}

describe('OMP release manifest', () => {

  it('binds migrations and aggregate tree hash to the trusted envelope digest', async () => {
    const { path, expected } = await generation();
    await validateExecutableArtifact(path, expected);
    await writeFile(join(path, 'drizzle/0000.sql'), 'DROP TABLE t;');
    await expect(validateExecutableArtifact(path, expected)).rejects.toThrow('integrity mismatch');
  });

  it('rejects a self-selected replacement manifest even if its inventory matches disk', async () => {
    const { path, expected } = await generation();
    await writeFile(join(path, 'machine.js'), 'console.log("attacker")');
    const replacement = await createExecutableArtifactManifest(path, 'machine');
    await expect(validateExecutableArtifact(path, { ...expected, hash: replacement.manifest.treeHash })).rejects.toThrow('manifest hash mismatch');
  });

  it('rejects unlisted files and symbolic links in a selected generation', async () => {
    const { path, expected } = await generation();
    await writeFile(join(path, 'extra.js'), 'console.log("unlisted")');
    await expect(validateExecutableArtifact(path, expected)).rejects.toThrow('inventory mismatch');
    await rm(join(path, 'extra.js'));
    await rm(join(path, 'machine.js'));
    await symlink(join(path, 'drizzle/0000.sql'), join(path, 'machine.js'));
    await expect(validateExecutableArtifact(path, expected)).rejects.toThrow('non-regular file');
  });

  it.skipIf(process.platform === 'win32')('authenticates executable permissions for packaged helper commands', async () => {
    const { path, expected } = await generation();
    await chmod(join(path, 'machine.js'), 0o755);
    await expect(validateExecutableArtifact(path, expected)).rejects.toThrow('mode mismatch');
  });

  it('rejects authenticated path traversal before opening payload files', async () => {
    const { path, expected, manifest } = await generation();
    manifest.files[0]!.path = '../escape';
    await writeFile(executableManifestPath(path), JSON.stringify(manifest));
    const bytes = await readFile(executableManifestPath(path));
    await expect(validateExecutableArtifact(path, { ...expected, manifestHash: sha256(bytes) })).rejects.toThrow('relative POSIX paths');
  });
});
