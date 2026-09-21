import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOmpRuntimeArtifact, type OmpRuntimeRecipe } from '../src/runtime-recipe.js';

const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function command(args: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

/** Real frozen Bun installs from tiny local tarballs: no SDK/native/model downloads and no installer mocks. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-omp-recipe-'));
  roots.push(root);
  const native = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
  const version = '0.0.0-recipe-test';
  const packages = ['@oh-my-pi/pi-coding-agent', native, 'recipe-optional-heavy'];
  const manifests = new Map<string, Record<string, unknown>>();
  const tarballs = new Map<string, Blob>();
  for (const name of packages) {
    const manifest = {
      name, version, type: 'module', main: 'index.js',
      ...(name === '@oh-my-pi/pi-coding-agent' ? { bin: { 'recipe-agent': 'index.js' }, optionalDependencies: { 'recipe-optional-heavy': version } } : {}),
    };
    manifests.set(name, manifest);
    tarballs.set(name, await new Bun.Archive({
      'package/package.json': JSON.stringify(manifest),
      'package/index.js': 'export default "base";\n',
    }, { compress: 'gzip' }).blob());
  }
  const downloads: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.slice(1).replace(/\.tgz$/u, ''));
      const tarball = tarballs.get(name);
      if (!tarball) return new Response('Unknown fixture package', { status: 404 });
      if (url.pathname.endsWith('.tgz')) {
        downloads.push(name);
        return new Response(tarball);
      }
      const integrity = `sha512-${createHash('sha512').update(Buffer.from(await tarball.arrayBuffer())).digest('base64')}`;
      return Response.json({ name, 'dist-tags': { latest: version }, versions: {
        [version]: { ...manifests.get(name), dist: { tarball: `${url.origin}/${encodeURIComponent(name)}.tgz`, integrity } },
      } });
    },
  });
  servers.push(server);
  const cacheRoot = join(root, 'runtimes');
  const bunCache = join(root, 'bun-cache');
  const registry = server.url.href;
  const env = { ...process.env, BUN_INSTALL_CACHE_DIR: bunCache, BUN_CONFIG_DEFAULT_REGISTRY: registry, npm_config_registry: registry };
  const runner = join(root, 'prepare.ts');
  await writeFile(runner, `
import { prepareOmpRuntimeArtifact } from ${JSON.stringify(fileURLToPath(new URL('../src/runtime-recipe.ts', import.meta.url)))};
const entrypoint = await prepareOmpRuntimeArtifact(process.argv[2], { cacheRoot: process.argv[3] });
const runtime = await import(entrypoint);
console.log(JSON.stringify({ entrypoint, value: runtime.default }));
`);
  async function generation(name: string, patched = false) {
    const artifact = join(root, name);
    await mkdir(artifact);
    const patchPath = 'patches/sdk.patch';
    if (patched) {
      await mkdir(join(artifact, 'patches'));
      await writeFile(join(artifact, patchPath), 'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-export default "base";\n+export default "patched";\n');
    }
    await writeFile(join(artifact, 'package.json'), JSON.stringify({
      name: 'gitspace-runtime-fixture', private: true, type: 'module',
      dependencies: { '@oh-my-pi/pi-coding-agent': version, [native]: version },
      patchedDependencies: patched ? { [`@oh-my-pi/pi-coding-agent@${version}`]: patchPath } : {},
    }));
    const locked = await command(['install', '--lockfile-only', '--ignore-scripts', '--registry', registry, '--cache-dir', bunCache], artifact, env);
    if (locked.code !== 0) throw new Error(`Fixture lock generation failed: ${locked.stdout}\n${locked.stderr}`);
    await rm(join(artifact, 'node_modules'), { recursive: true, force: true });
    await writeFile(join(artifact, 'omp.js'), 'throw new Error("fixture should execute the prepared adapter");\n');
    await writeFile(join(artifact, 'omp-adapter.js'), 'import value from "@oh-my-pi/pi-coding-agent"; export default value;\n');
    const hash = async (path: string) => `sha256:${createHash('sha256').update(await readFile(join(artifact, path))).digest('hex')}`;
    const recipe: OmpRuntimeRecipe = {
      version: 1, upstreamVersion: version, bunVersion: Bun.version,
      platform: process.platform as OmpRuntimeRecipe['platform'], arch: process.arch as OmpRuntimeRecipe['arch'],
      adapter: 'omp-adapter.js', packageHash: await hash('package.json'), lockHash: await hash('bun.lock'),
      patches: patched ? [{ path: patchPath, hash: await hash(patchPath) }] : [],
    };
    await writeFile(join(artifact, 'omp-runtime.json'), JSON.stringify(recipe));
    return { artifact, recipe };
  }
  async function prepare(artifact: string, runtimeCache = cacheRoot) {
    const result = await command([runner, artifact, runtimeCache], root, env);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as { entrypoint: string; value: string };
  }
  return { root, cacheRoot, bunCache, downloads, server, generation, prepare };
}

describe('OMP runtime recipes', () => {
  it('assembles once, omits optional downloads, and reuses the ready adapter without a registry or Bun cache', async () => {
    const f = await fixture();
    const { artifact } = await f.generation('base');
    const before = await readdir(artifact);
    const cold = await f.prepare(artifact);
    expect(cold.value).toBe('base');
    expect(f.downloads).not.toContain('recipe-optional-heavy');
    expect(await readdir(artifact)).toEqual(before);
    await f.server.stop(true);
    await rm(f.bunCache, { recursive: true, force: true });
    expect(await f.prepare(artifact)).toEqual(cold);
  }, 30_000);

  it('accepts installed bin links through a parent alias but rejects links outside the generation', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    await symlink(f.root, alias);
    const { artifact } = await f.generation('base');
    const cacheRoot = join(alias, 'runtimes');
    const cold = await f.prepare(artifact, cacheRoot);
    expect(cold.value).toBe('base');
    expect(await f.prepare(artifact, cacheRoot)).toEqual(cold);
    const bin = join(dirname(cold.entrypoint), 'node_modules/.bin/recipe-agent');
    const outside = join(f.root, 'outside.js');
    await writeFile(outside, 'export default "outside";\n');
    await rm(bin);
    await symlink(relative(dirname(bin), outside), bin);
    await expect(f.prepare(artifact, cacheRoot)).rejects.toThrow('link escapes its generation');
    await rm(bin);
    await symlink('../@oh-my-pi/pi-coding-agent/index.js', bin);
    const installedModule = join(dirname(cold.entrypoint), 'node_modules/@oh-my-pi/pi-coding-agent/index.js');
    await rm(installedModule);
    await symlink(outside, installedModule);
    await expect(f.prepare(artifact, cacheRoot)).rejects.toThrow('link escapes its generation');
  }, 30_000);

  it('isolates patched candidates and preserves a ready generation when new input verification fails', async () => {
    const f = await fixture();
    const base = await f.generation('base');
    const previous = await f.prepare(base.artifact);
    const patched = await f.generation('patched', true);
    const candidate = await f.prepare(patched.artifact);
    expect(candidate.value).toBe('patched');
    expect(candidate.entrypoint).not.toBe(previous.entrypoint);
    await writeFile(join(patched.artifact, 'patches/sdk.patch'), 'corrupt patch');
    await expect(f.prepare(patched.artifact)).rejects.toThrow('input integrity mismatch');
    const failed = join(f.root, 'failed-install');
    await cp(base.artifact, failed, { recursive: true });
    const brokenLock = 'not a Bun lockfile';
    await writeFile(join(failed, 'bun.lock'), brokenLock);
    await writeFile(join(failed, 'omp-runtime.json'), JSON.stringify({
      ...base.recipe, lockHash: `sha256:${createHash('sha256').update(brokenLock).digest('hex')}`,
    }));
    await expect(f.prepare(failed)).rejects.toThrow('dependency install failed');
    expect(await f.prepare(base.artifact)).toEqual(previous);
  }, 30_000);

  it('publishes concurrent cold contenders atomically and rejects later installed-byte corruption', async () => {
    const f = await fixture();
    const { artifact } = await f.generation('base');
    const [left, right] = await Promise.all([f.prepare(artifact), f.prepare(artifact)]);
    expect(left).toEqual(right);
    expect(await readdir(f.cacheRoot)).toEqual([dirname(dirname(left.entrypoint)).split(/[\\/]/u).at(-1)!]);
    const receipt = join(dirname(dirname(left.entrypoint)), 'ready.json');
    const receiptBytes = await readFile(receipt);
    await rm(receipt);
    await expect(f.prepare(artifact)).rejects.toThrow('ready.json');
    await writeFile(receipt, receiptBytes);
    await writeFile(join(dirname(left.entrypoint), 'node_modules/@oh-my-pi/pi-coding-agent/index.js'), 'export default "corrupt";\n');
    await expect(f.prepare(artifact)).rejects.toThrow('cache integrity mismatch');
  }, 30_000);

  it('rejects incompatible recipes and escaping patch/cache paths before touching the selected artifact', async () => {
    const f = await fixture();
    const { artifact, recipe } = await f.generation('base');
    const recipePath = join(artifact, 'omp-runtime.json');
    await writeFile(recipePath, JSON.stringify({ ...recipe, bunVersion: '0.0.0' }));
    await expect(prepareOmpRuntimeArtifact(artifact, { cacheRoot: f.cacheRoot })).rejects.toThrow('incompatible');
    await writeFile(recipePath, JSON.stringify({ ...recipe, upstreamVersion: '0.0.1' }));
    await expect(prepareOmpRuntimeArtifact(artifact, { cacheRoot: f.cacheRoot })).rejects.toThrow('dependency version mismatch');
    await writeFile(recipePath, JSON.stringify({ ...recipe, patches: [{ path: 'patches/../../escape.patch', hash: recipe.packageHash }] }));
    await expect(prepareOmpRuntimeArtifact(artifact, { cacheRoot: f.cacheRoot })).rejects.toThrow('patch path');
    await writeFile(recipePath, JSON.stringify(recipe));
    await expect(prepareOmpRuntimeArtifact(artifact, { cacheRoot: join(artifact, 'cache') })).rejects.toThrow('outside the authenticated artifact');
    expect(await readdir(artifact)).not.toContain('cache');
  }, 30_000);

  it.skipIf(process.platform === 'win32')('rejects symbolic-link inputs and cache roots pointing back into a selected artifact', async () => {
    const f = await fixture();
    const { artifact } = await f.generation('base');
    const outside = join(f.root, 'adapter.js');
    await cp(join(artifact, 'omp-adapter.js'), outside);
    await rm(join(artifact, 'omp-adapter.js'));
    await symlink(outside, join(artifact, 'omp-adapter.js'));
    await expect(prepareOmpRuntimeArtifact(artifact, { cacheRoot: f.cacheRoot })).rejects.toThrow('Unexpected OMP runtime payload');
    await rm(join(artifact, 'omp-adapter.js'));
    await cp(outside, join(artifact, 'omp-adapter.js'));
    await symlink(artifact, join(f.root, 'artifact-link'));
    await expect(prepareOmpRuntimeArtifact(artifact, { cacheRoot: join(f.root, 'artifact-link/cache') })).rejects.toThrow('outside the authenticated artifact');
    expect(await readdir(artifact)).not.toContain('cache');
  }, 30_000);

  it('keeps authenticated legacy artifacts read-only without creating a derived cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitspace-omp-legacy-'));
    roots.push(root);
    const artifact = join(root, 'legacy');
    await mkdir(artifact);
    await writeFile(join(artifact, 'omp.js'), 'legacy runtime');
    expect(await prepareOmpRuntimeArtifact(artifact, { cacheRoot: join(root, 'cache') })).toBe(join(artifact, 'omp.js'));
    expect(await readdir(root)).toEqual(['legacy']);
  });
});
