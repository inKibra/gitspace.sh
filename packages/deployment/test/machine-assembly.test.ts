import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_UPSTREAMS, type PortableManifest } from '@gitspace/protocol/machine-release';
import { assembleMachineGeneration } from '../src/machine-assembly.js';
import { currentDistributionPlatform } from '../src/distribution.js';
import { validateExecutableArtifact } from '../src/executable-manifest.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A portable release as a launch builds it: ESM bundles marked `// @bun` with linked maps, and this platform's
 * natives as upstream `.tar.gz` archives holding a tool that answers its version. */
async function release() {
  const root = await mkdtemp(join(tmpdir(), 'machine-assembly-'));
  roots.push(root);
  process.env.GITSPACE_NATIVE_CACHE = join(root, 'cache');
  const files = new Map<string, Uint8Array>();
  const bundle = (body: string) => new TextEncoder().encode(`// @bun\n${body}\n//# sourceMappingURL=${'x'}.map\n`);
  files.set('machine/machine.js', bundle(`const here = import.meta.main ? 'main' : 'imported';\nconsole.log(JSON.stringify({ here, require: typeof import.meta.require }));`));
  files.set('machine/machine-worker.js', bundle(`console.log('worker');`));
  for (const name of ['machine.js', 'machine-worker.js']) files.set(`machine/${name}.map`, new TextEncoder().encode(JSON.stringify({ version: 3, sources: [`../src/${name.replace('.js', '.ts')}`], sourcesContent: ['source'], names: [], mappings: 'AAAA' })));
  files.set('machine/host-runtime.js', new TextEncoder().encode('export {};\n'));
  files.set('cli/gitspace.js', new TextEncoder().encode('console.log("cli");\n'));
  const archives = new Map<string, Uint8Array>();
  const native = async (name: 'rg' | 'git-lfs', version: string, answer: string) => {
    const scratch = join(root, `archive-${name}`);
    await mkdir(join(scratch, 'tool'), { recursive: true });
    const script = new TextEncoder().encode(`#!/bin/sh\necho "${answer}"\n`);
    await writeFile(join(scratch, 'tool', name), script);
    await chmod(join(scratch, 'tool', name), 0o755);
    await Bun.$`tar -czf ${join(scratch, 'asset.tar.gz')} -C ${scratch} tool/${name}`.quiet();
    const asset = new Uint8Array(await readFile(join(scratch, 'asset.tar.gz')));
    archives.set(digest(asset), asset);
    return { version, url: `${NATIVE_UPSTREAMS[name]}v${version}/${name}.tar.gz`, sha256: digest(asset), size: asset.byteLength, member: `tool/${name}`, executable: { sha256: digest(script), size: script.byteLength }, abi: { os: 'linux' as const, glibc: null } };
  };
  const pins = { bun: { version: Bun.version, url: `${NATIVE_UPSTREAMS.bun}v/bun.zip`, sha256: 'a'.repeat(64), size: 1, member: 'bun', executable: { sha256: 'b'.repeat(64), size: 1 }, abi: { os: 'linux' as const, glibc: '2.17' } }, rg: await native('rg', '14.1.1', 'ripgrep 14.1.1'), 'git-lfs': await native('git-lfs', '3.8.0', 'git-lfs/3.8.0 (test)') };
  const manifest: PortableManifest = {
    schemaVersion: 1, bunVersion: Bun.version,
    files: [...files].map(([path, bytes]) => ({ path, sha256: digest(bytes), size: bytes.byteLength })),
    natives: { 'darwin-arm64': pins, 'darwin-x64': pins, 'linux-arm64': pins, 'linux-x64': pins, [currentDistributionPlatform()]: pins },
  };
  return { root, manifest, file: async (file: { path: string }) => files.get(file.path)!, archive: async (pin: { sha256: string }) => new Response(archives.get(pin.sha256)!.slice()) };
}

it('builds this machine\'s generation from a portable release: compiled bundles, its pinned tools, and a manifest that validates', async () => {
  if (process.platform !== 'linux') return;
  const { root, manifest, file, archive } = await release();
  const output = join(root, 'generation');
  await mkdir(output);
  const built = await assembleMachineGeneration({ manifest, file, archive, output });
  const names = built.manifest.files.map(entry => entry.path).sort();
  expect(names).toEqual(['host-runtime.js', 'machine-native.json', 'machine-worker.js', 'machine-worker.js.jsc', 'machine-worker.js.map', 'machine.js', 'machine.js.jsc', 'machine.js.map', 'native/bin/git-lfs', 'native/bin/rg', 'native/git-lfs.json', 'native/ripgrep.json'].sort());
  expect(await validateExecutableArtifact(output, { target: 'machine', hash: built.manifest.treeHash, manifestHash: built.manifestHash })).toEqual(built.manifest);
  // The compiled machine process runs as the entrypoint, its `require` the CommonJS one.
  expect((await Bun.$`${process.execPath} ${join(output, 'machine.js')}`.text()).trim()).toBe(JSON.stringify({ here: 'main', require: 'function' }));
  expect(JSON.parse(await readFile(join(output, 'machine-native.json'), 'utf8'))).toMatchObject({ bunVersion: Bun.version, abi: { platform: 'linux', minimumVersion: '2.17' } });
});

it('refuses a release for another Bun, and a native whose archive is not the pinned one', async () => {
  const { root, manifest, file, archive } = await release();
  await mkdir(join(root, 'other-bun'));
  await expect(assembleMachineGeneration({ manifest: { ...manifest, bunVersion: '0.0.1' }, file, archive, output: join(root, 'other-bun') })).rejects.toThrow(`This release runs on Bun 0.0.1; this machine runs Bun ${Bun.version}`);
  await mkdir(join(root, 'tampered'));
  await expect(assembleMachineGeneration({ manifest, file, archive: async () => new Response(Uint8Array.of(1, 2, 3)), output: join(root, 'tampered') })).rejects.toThrow('SHA256 mismatch');
});
