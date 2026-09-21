import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitSpaceDatabase } from '@gitspace/core';
import { releaseRecordSchema, type ReleaseRecord, type StageReleaseInput } from '@gitspace/protocol';
import { DeploymentLauncher, releaseObjectKeys } from '../src/index.js';
import { executableArtifactManifestSchema, sha256 } from '@gitspace/account-omp/manifest';
import { buildWorkspaceTarget } from '../src/deployment-launcher.js';
import type { BuiltArtifact } from '@gitspace/deployment';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OMP release pipeline', () => {
  it('uses edited workspace build code and its transitive imports on each deployment build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-source-builder-'));
    roots.push(root);
    const source = join(root, 'packages/deployment/src');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'builders.ts'), `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { page } from './page.ts';
      export async function buildFrontendTree(_root, output) {
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'index.html'), page);
        return { path: output, hash: 'sha256:' + new Bun.CryptoHasher('sha256').update('index.html\\0').update(page).update('\\0').digest('hex') };
      }
    `);
    await writeFile(join(source, 'page.ts'), 'export const page = \"first source page\";');
    const first = await buildWorkspaceTarget<BuiltArtifact>(root, 'first', 'frontend', join(root, 'first'));
    expect(await readFile(join(first.path, 'index.html'), 'utf8')).toBe('first source page');
    await writeFile(join(source, 'page.ts'), 'export const page = \"edited source page\";');
    const next = await buildWorkspaceTarget<BuiltArtifact>(root, 'next', 'frontend', join(root, 'next'));
    expect(await readFile(join(next.path, 'index.html'), 'utf8')).toBe('edited source page');
    expect(next.hash).not.toBe(first.hash);
  });

  it('builds, uploads, stages, and launches the explicit OMP target', async () => {
    const repositoryRoot = join(import.meta.dir, '..', '..', '..');
    const buildRoot = mkdtempSync(join(tmpdir(), 'gitspace-omp-launch-'));
    roots.push(buildRoot);
    let staged: StageReleaseInput | null = null;
    const objects = new Map<string, Uint8Array>();
    const database = {
      getWorkspace: (id: string) => id === 'workspace-a' ? {
        id,
        name: 'omp-release',
        rootPath: repositoryRoot,
        projectId: 'project-a',
        placementState: 'open',
        holderId: 'machine-a',
      } : null,
    } as unknown as GitSpaceDatabase;
    const launcher = new DeploymentLauncher({
      database,
      machineId: 'machine-a',
      buildRoot,
      events: { append: () => undefined },
      blobs: {
        put: async (key, bytes) => {
          const copy = Uint8Array.from(bytes);
          objects.set(key, copy);
          return `sha256:${new Bun.CryptoHasher('sha256').update(copy).digest('hex')}`;
        },
      },
      authority: {
        stageRelease: async (input) => {
          staged = input;
          return releaseRecordSchema.parse({
            ...input,
            builtBy: 'machine-a',
            createdAt: new Date().toISOString(),
            status: { worker: 'skipped', frontend: 'skipped', machines: {}, omps: {} },
            error: null,
          });
        },
        launchRelease: async (sha, targets) => {
          expect(targets).toEqual(['omp']);
          if (!staged || staged.sha !== sha) throw new Error('Release was not staged before launch');
          const record = releaseRecordSchema.parse({
            ...staged,
            builtBy: 'machine-a',
            createdAt: new Date().toISOString(),
            status: { worker: 'skipped', frontend: 'skipped', machines: {}, omps: {} },
            error: null,
          }) as ReleaseRecord;
          return { record, desired: { worker: null, machine: null, omp: sha, frontend: null, updatedAt: new Date().toISOString() } };
        },
      },
    });

    const record = await launcher.launchAndWait({ workspaceId: 'workspace-a', targets: ['omp'] });
    const keys = releaseObjectKeys(record.sha);
    expect([record.artifacts.worker, record.artifacts.machine, record.artifacts.frontend]).toEqual([null, null, null]);
    const envelope = objects.get(record.artifacts.omp!.key)!;
    expect(sha256(envelope)).toBe(record.artifacts.omp!.hash);
    expect(envelope.byteLength).toBe(record.artifacts.omp!.size);
    const manifest = executableArtifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(envelope)));
    expect(manifest.files.some((file) => file.path.startsWith('drizzle/') || file.path === 'machine.js')).toBe(false);
    expect(manifest.files.some((file) => file.path.endsWith('.node') || file.path.split('/').includes('node_modules'))).toBe(false);
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'omp.js', 'omp-adapter.js', 'package.json', 'bun.lock', 'omp-runtime.json',
    ]));
    expect(manifest.files.reduce((bytes, file) => bytes + file.size, 0)).toBeLessThan(5 * 1024 * 1024);
    for (const file of manifest.files) {
      const bytes = new Uint8Array(file.size);
      let offset = 0;
      for (const chunk of file.chunks) {
        const content = objects.get(chunk.key)!;
        expect(sha256(content)).toBe(chunk.hash);
        bytes.set(content, offset);
        offset += chunk.size;
      }
      expect(sha256(bytes)).toBe(file.hash);
      expect(offset).toBe(file.size);
      if (file.path === 'omp-runtime.json') {
        const recipe = JSON.parse(new TextDecoder().decode(bytes));
        expect(recipe.packageHash).toBe(manifest.files.find((entry) => entry.path === 'package.json')!.hash);
        expect(recipe.lockHash).toBe(manifest.files.find((entry) => entry.path === 'bun.lock')!.hash);
        expect(recipe.upstreamVersion).toBe(record.omp!.upstreamVersion);
      }
    }
    expect(objects.has(keys.machine)).toBe(false);
  }, 120_000);
});
