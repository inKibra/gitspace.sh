import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitSpaceDatabase } from '@gitspace/core';
import { releaseRecordSchema, type ReleaseRecord, type StageReleaseInput } from '@gitspace/protocol';
import { DeploymentLauncher, releaseObjectKeys } from '../src/index.js';
import { executableArtifactManifestSchema, sha256 } from '@gitspace/account-omp/manifest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OMP release pipeline', () => {
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
    expect(manifest.files.some((file) => file.path.endsWith('.node'))).toBe(true);
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
    }
    expect(objects.has(keys.machine)).toBe(false);
  }, 120_000);
});
