import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOmpBundle, hashArtifactPath, stripJsonComments, workerMetadataFromWrangler } from '../src/index.js';
import { executableManifestPath, validateExecutableArtifact } from '@gitspace/account-omp/manifest';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');

describe('worker release metadata', () => {
  it('derives the upload metadata from the real wrangler.jsonc', async () => {
    const metadata = await workerMetadataFromWrangler(repositoryRoot);
    expect(metadata.mainModule).toBe('worker.mjs');
    expect(metadata.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(metadata.compatibilityFlags).toContain('nodejs_compat');
    expect(metadata.durableObjects).toContainEqual({ name: 'RELAY', className: 'UserRelayDO' });
    expect(metadata.migrations).toContainEqual({ tag: 'v1', newSqliteClasses: ['UserRelayDO'] });
    // Every migration tag introduces classes that are bound; the platform replays them in order.
    const bound = new Set(metadata.durableObjects.map((binding) => binding.className));
    for (const migration of metadata.migrations) {
      for (const className of migration.newSqliteClasses) expect(bound.has(className)).toBe(true);
    }
  });

  it('builds a content-addressed hermetic OMP generation with its patch envelope', async () => {
    const output = await mkdtemp(join(tmpdir(), 'gitspace-omp-build-'));
    try {
      const built = await buildOmpBundle(repositoryRoot, output);
      expect(built.hash).toBe(await hashArtifactPath(output));
      const manifest = await validateExecutableArtifact(output, { target: 'omp', hash: built.hash, manifestHash: built.manifestHash });
      expect(manifest.files.some((file) => file.path.startsWith('drizzle/') || file.path === 'machine.js')).toBe(false);
      const probe = Bun.spawn([process.execPath, join(output, 'omp-worker.js'), '--version'], {
        cwd: output, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, NODE_PATH: '', PI_CODING_AGENT_DIR: join(output, 'agent') },
      });
      const diagnostic = `${await new Response(probe.stdout).text()}\n${await new Response(probe.stderr).text()}`;
      expect(await probe.exited).toBe(0);
      expect(diagnostic).toContain(built.metadata.upstreamVersion);
    } finally {
      await rm(output, { recursive: true, force: true });
      await rm(executableManifestPath(output), { force: true });
    }
  }, 120_000);

  it('strips comments outside string literals and trailing commas', () => {
    const source = `{
      // line comment
      "url": "http://x/y", /* block */ "flags": ["a", "b",],
      "note": "keeps // this and /* this */",
    }`;
    expect(JSON.parse(stripJsonComments(source))).toEqual({ url: 'http://x/y', flags: ['a', 'b'], note: 'keeps // this and /* this */' });
  });
});
