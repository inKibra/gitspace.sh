import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildOmpBundle, hashArtifactPath, stripJsonComments, workerMetadataFromWrangler } from '../src/index.js';
import { sha256, validateExecutableArtifact } from '@gitspace/account-omp/manifest';
import { prepareOmpRuntimeArtifact, type OmpRuntimeRecipe } from '../../account-omp/src/runtime-recipe.js';
import { packageOmpRuntimeRecipe } from '../src/runtime-packaging.js';
import { z } from 'zod';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const lockSchema = z.object({
  workspaces: z.record(z.string(), z.object({ dependencies: z.record(z.string(), z.string()).optional() })),
  patchedDependencies: z.record(z.string(), z.string()).optional(),
  packages: z.record(z.string(), z.tuple([z.string()]).rest(z.unknown())),
});

describe('worker release metadata', () => {
  it('declares SQL storage for every durable class in the app release', async () => {
    const metadata = await workerMetadataFromWrangler(repositoryRoot);
    const bound = new Set(metadata.durableObjects.map((binding) => binding.className));
    const introduced = new Set(metadata.migrations.flatMap((migration) => migration.newSqliteClasses));
    expect(introduced).toEqual(bound);
  });

  it('builds a tiny authenticated recipe with source-locked dependencies and executable SDK patches', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'gitspace-omp-build-'));
    const output = join(sandbox, 'recipe');
    try {
      const built = await buildOmpBundle(repositoryRoot, output);
      expect(built.hash).toBe(await hashArtifactPath(output));
      const manifest = await validateExecutableArtifact(output, { target: 'omp', hash: built.hash, manifestHash: built.manifestHash });
      const recipe = JSON.parse(await readFile(join(output, 'omp-runtime.json'), 'utf8')) as OmpRuntimeRecipe;
      const packageBytes = await readFile(join(output, 'package.json'));
      const lockBytes = await readFile(join(output, 'bun.lock'));
      const runtimePackage = JSON.parse(packageBytes.toString('utf8'));
      const sourcePackage = JSON.parse(await readFile(join(repositoryRoot, 'packages/account-omp/package.json'), 'utf8'));
      expect(manifest.files.map((file) => file.path).sort()).toEqual([
        'omp.js', 'omp-adapter.js', 'package.json', 'bun.lock', 'omp-runtime.json',
        ...Object.values(sourcePackage.gitspaceOmpPatches),
      ].sort());
      expect(manifest.files.reduce((bytes, file) => bytes + file.size, 0)).toBeLessThan(5 * 1024 * 1024);
      expect(recipe.packageHash).toBe(sha256(packageBytes));
      expect(recipe.lockHash).toBe(sha256(lockBytes));
      expect(runtimePackage.dependencies).toEqual({
        ...built.metadata.packages,
        [`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`]: built.metadata.packages['@oh-my-pi/pi-natives'],
      });
      expect(runtimePackage.patchedDependencies).toEqual(sourcePackage.gitspaceOmpPatches);
      for (const patch of recipe.patches) {
        const bytes = await readFile(join(output, patch.path));
        expect(sha256(bytes)).toBe(patch.hash);
        expect(built.metadata.patches).toContainEqual({ path: `packages/account-omp/${patch.path}`, hash: patch.hash });
      }
      const lock = lockSchema.parse(Bun.JSONC.parse(lockBytes.toString('utf8')));
      const sourceLock = lockSchema.parse(Bun.JSONC.parse(await readFile(join(repositoryRoot, 'bun.lock'), 'utf8')));
      expect(Object.keys(lock.workspaces)).toEqual(['']);
      expect(lock.workspaces['']!.dependencies).toEqual(runtimePackage.dependencies);
      expect(lock.patchedDependencies).toEqual(runtimePackage.patchedDependencies);
      const sourceResolutions = new Set(Object.values(sourceLock.packages).map((entry) => JSON.stringify([entry[0], entry[1], entry[3]])));
      for (const entry of Object.values(lock.packages)) {
        expect(sourceResolutions.has(JSON.stringify([entry[0], entry[1], entry[3]]))).toBe(true);
        expect(entry[0]).not.toContain('@workspace:');
      }
      const repeat = join(sandbox, 'repeat');
      await packageOmpRuntimeRecipe(repositoryRoot, repeat);
      expect(sha256(await readFile(join(repeat, 'bun.lock')))).toBe(recipe.lockHash);

      const entrypoint = await prepareOmpRuntimeArtifact(output, { cacheRoot: join(sandbox, 'cache') });
      const runtimeRoot = dirname(entrypoint);
      const extension = join(sandbox, 'extension.ts');
      await writeFile(extension, "export { Agent as default } from '@mariozechner/pi-agent-core';\n");
      const probe = Bun.spawn([process.execPath, '--eval', `
        import { Agent } from '@oh-my-pi/pi-agent-core';
        import { loadLegacyPiModule } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat';
        const entry = Bun.resolveSync('@oh-my-pi/pi-coding-agent', process.cwd());
        const legacy = await loadLegacyPiModule(${JSON.stringify(extension)});
        const agent = new legacy.default();
        const message = { role: 'user', content: [{ type: 'text', text: 'retained follow-up' }], timestamp: 0 };
        agent.followUp(message);
        console.log(JSON.stringify({
          sourceSdk: entry.replaceAll('\\\\', '/').endsWith('/src/index.ts'),
          sharedAgent: legacy.default === Agent,
          removed: agent.removeFollowUp(0)?.content,
          remaining: agent.removeFollowUp(0) ?? null,
        }));
      `], {
        cwd: runtimeRoot, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, BUN_BE_BUN: '1', NODE_PATH: '', PI_CODING_AGENT_DIR: join(sandbox, 'agent') },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
      if (code !== 0) throw new Error(`Installed OMP SDK probe exited ${code}: ${stderr}`);
      expect(JSON.parse(stdout)).toEqual({
        sourceSdk: true,
        sharedAgent: true,
        removed: [{ type: 'text', text: 'retained follow-up' }],
        remaining: null,
      });
      // Preparing and running the SDK must not turn the selected authenticated payload into an installation directory.
      expect(await hashArtifactPath(output)).toBe(built.hash);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 240_000);

  it('strips comments outside string literals and trailing commas', () => {
    const source = `{
      // line comment
      "url": "http://x/y", /* block */ "flags": ["a", "b",],
      "note": "keeps // this and /* this */",
    }`;
    expect(JSON.parse(stripJsonComments(source))).toEqual({ url: 'http://x/y', flags: ['a', 'b'], note: 'keeps // this and /* this */' });
  });
});
