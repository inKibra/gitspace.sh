import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceTarget } from '../src/deployment-launcher.js';
import type { BuiltArtifact } from '@gitspace/deployment';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace release pipeline', () => {
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

  it('rejects a retired OMP target before running workspace build code', async () => {
    await expect(buildWorkspaceTarget<BuiltArtifact>('/unavailable-source', 'legacy', 'omp' as never, '/unavailable-output')).rejects.toThrow();
  });
});
