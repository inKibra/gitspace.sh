import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBootstrapMigration } from '../src/machine-bootstrap-migration.js';
import { hashArtifactPath } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-bootstrap-migration-'));
  roots.push(root);
  const bundleRoot = join(root, 'runtime', 'published');
  const environmentRoot = join(root, 'machine');
  const candidatePath = join(root, 'candidate');
  await Promise.all([mkdir(bundleRoot, { recursive: true }), mkdir(environmentRoot), mkdir(candidatePath)]);
  await writeFile(join(bundleRoot, 'distribution-manifest.json'), '{}');
  await writeFile(join(bundleRoot, 'host.js'), 'throw new Error("original bootstrap");');
  await writeFile(join(bundleRoot, 'retained-asset'), 'private-runtime');
  await writeFile(join(candidatePath, 'machine-bootstrap.js'), 'export async function startMachineHost() {}');
  await writeFile(join(root, 'runtime-selection.json'), JSON.stringify({ path: bundleRoot }));
  return {
    root,
    bundleRoot,
    environmentRoot,
    candidatePath,
    initialMachineManifestHash: `sha256:${'1'.repeat(64)}`,
    initialOmpManifestHash: `sha256:${'2'.repeat(64)}`,
  };
}

it('leaves the authenticated installation unchanged across bootstrap commit and rollback', async () => {
  const input = await fixture();
  const originalHash = await hashArtifactPath(input.bundleRoot);
  const selection = join(input.root, 'runtime-selection.json');
  const originalSelection = await readFile(selection, 'utf8');
  const migration = await prepareBootstrapMigration(input);
  expect(await readFile(selection, 'utf8')).toBe(originalSelection);
  await migration.commit();
  const updated = JSON.parse(await readFile(selection, 'utf8')) as { path: string };
  expect(updated.path).not.toBe(input.bundleRoot);
  expect(await readFile(join(updated.path, 'retained-asset'), 'utf8')).toBe('private-runtime');
  expect(await hashArtifactPath(input.bundleRoot)).toBe(originalHash);
  // A newly started updater can finish or reverse the durable migration intent.
  const restarted = await prepareBootstrapMigration(input);
  await restarted.commit();
  expect(JSON.parse(await readFile(selection, 'utf8')).path).toBe(updated.path);
  await restarted.rollback();
  expect(await readFile(selection, 'utf8')).toBe(originalSelection);
  expect(await hashArtifactPath(input.bundleRoot)).toBe(originalHash);
});

it('does not overwrite a different installation selected during migration', async () => {
  const input = await fixture();
  const migration = await prepareBootstrapMigration(input);
  const selection = join(input.root, 'runtime-selection.json');
  const changed = JSON.stringify({ path: join(input.root, 'other-installation') });
  await writeFile(selection, changed);
  await expect(migration.commit()).rejects.toThrow('changed outside');
  expect(await readFile(selection, 'utf8')).toBe(changed);
});
