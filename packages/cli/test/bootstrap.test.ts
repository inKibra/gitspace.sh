import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatInstallMetadata } from '@gitspace/protocol/install-script';
import { NATIVE_UPSTREAMS, nativeMirrorKey, PORTABLE_ENTRYPOINTS, portableFileKey } from '@gitspace/protocol/machine-release';
import { installRuntime } from '../src/bootstrap.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();

/** An account holding one release: its portable files (the real machine bootstrap, stand-ins for the rest) and this
 * platform's tools as pinned upstream archives, served the way the account serves them. */
async function account(root: string) {
  const objects = new Map<string, Uint8Array>();
  const release = 'release-a';
  const key = `releases/${release}/portable.manifest.json`;
  const bootstrap = await Bun.build({ entrypoints: [join(import.meta.dir, '../../account-machine/src/machine-bootstrap.ts')], target: 'bun' });
  if (!bootstrap.success) throw new AggregateError(bootstrap.logs, 'bootstrap build failed');
  const files: Record<string, Uint8Array> = {
    'machine/machine-bootstrap.js': new Uint8Array(await bootstrap.outputs[0]!.arrayBuffer()),
    'machine/host-runtime.js': encoder.encode(`console.log('host runtime of', JSON.parse(process.env.GITSPACE_HOST_SELECTION).path);\n`),
    'machine/machine.js': encoder.encode('// @bun\nconsole.log("machine");\n'),
    'machine/machine-worker.js': encoder.encode('// @bun\nconsole.log("worker");\n'),
    'machine/machine.js.map': encoder.encode(JSON.stringify({ version: 3, sources: ['runtime.ts'], names: [], mappings: 'AAAA' })),
    'machine/machine-worker.js.map': encoder.encode(JSON.stringify({ version: 3, sources: ['terminal-worker.ts'], names: [], mappings: 'AAAA' })),
  };
  for (const path of PORTABLE_ENTRYPOINTS) files[path] ??= encoder.encode('export {};\n');
  for (const [path, bytes] of Object.entries(files)) objects.set(portableFileKey(key, path), bytes);
  const tool = async (name: 'rg' | 'git-lfs', version: string, answer: string) => {
    const scratch = join(root, `archive-${name}`);
    await mkdir(join(scratch, 'tool'), { recursive: true });
    const script = encoder.encode(`#!/bin/sh\necho "${answer}"\n`);
    await writeFile(join(scratch, 'tool', name), script, { mode: 0o755 });
    await Bun.$`tar -czf ${join(scratch, 'asset.tar.gz')} -C ${scratch} tool/${name}`.quiet();
    const asset = new Uint8Array(await readFile(join(scratch, 'asset.tar.gz')));
    objects.set(nativeMirrorKey(sha256(asset)), asset);
    return { version, url: `${NATIVE_UPSTREAMS[name]}v${version}/${name}.tar.gz`, sha256: sha256(asset), size: asset.byteLength, member: `tool/${name}`, executable: { sha256: sha256(script), size: script.byteLength }, abi: { os: 'linux' as const, glibc: null } };
  };
  const linux = { bun: { version: Bun.version, url: `${NATIVE_UPSTREAMS.bun}v/bun.zip`, sha256: 'a'.repeat(64), size: 1, member: 'bun/bun', executable: { sha256: 'b'.repeat(64), size: 1 }, abi: { os: 'linux' as const, glibc: '2.17' } }, rg: await tool('rg', '14.1.1', 'ripgrep 14.1.1'), 'git-lfs': await tool('git-lfs', '3.8.0', 'git-lfs/3.8.0 (test)') };
  const darwin = Object.fromEntries(Object.entries(linux).map(([name, pin]) => [name, { ...pin, abi: { os: 'darwin' as const, macos: '13.0' } }]));
  const manifest = encoder.encode(JSON.stringify({
    schemaVersion: 1, bunVersion: Bun.version, natives: { 'darwin-arm64': darwin, 'darwin-x64': darwin, 'linux-arm64': linux, 'linux-x64': linux },
    files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.byteLength })),
  }));
  objects.set(key, manifest);
  const metadata = formatInstallMetadata({ release, portableSha256: sha256(manifest), bun: { sha256: 'a'.repeat(64), size: 1, executableSha256: 'b'.repeat(64), executableSize: 1, member: 'bun/bun' }, cli: { sha256: 'c'.repeat(64), size: 1 } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname.startsWith('/distribution/v1/install/') ? new Response(metadata) : new Response('Not found', { status: 404 }) });
  cleanup.push(async () => { server.stop(true); });
  const read: string[] = [];
  // The signed data endpoint: every read checked against the hash it names.
  const blobs = { get: async (name: string, expectedHash?: string) => {
    read.push(name);
    const bytes = objects.get(name) ?? null;
    if (bytes && expectedHash && expectedHash !== `sha256:${sha256(bytes)}`) throw new Error(`integrity ${name}`);
    return bytes;
  } };
  return { accountUrl: `http://127.0.0.1:${server.port}`, blobs, objects, read, release };
}

it('builds the machine runtime from the account\'s release, whose host.js starts that generation trusting it', async () => {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'gitspace-cli-bootstrap-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  process.env.GITSPACE_NATIVE_CACHE = join(root, 'native-cache');
  const source = await account(root);
  const runtime = await installRuntime(join(root, 'config'), source);
  expect(JSON.parse(await readFile(join(root, 'config', 'runtime-selection.json'), 'utf8'))).toEqual({ path: runtime });
  expect(existsSync(join(runtime, 'bin', 'bun'))).toBe(true);
  expect(existsSync(join(runtime, 'machine', 'machine.js.jsc'))).toBe(true);
  expect(source.read.every(name => name.startsWith(`releases/${source.release}/`) || name.startsWith('natives/sha256/'))).toBe(true);
  // The host entry validates the generation against the anchor it was written with, then runs its host runtime.
  const host = Bun.spawnSync([join(runtime, 'bin', 'bun'), join(runtime, 'host.js')], { env: { ...process.env, GITSPACE_ENVIRONMENT_ROOT: join(root, 'environment') }, stdout: 'pipe', stderr: 'pipe' });
  expect(host.stderr.toString()).toBe('');
  expect(host.stdout.toString().trim()).toBe(`host runtime of ${join(runtime, 'machine')}`);
  // A changed generation is not the one the anchor names: the host refuses it.
  await writeFile(join(runtime, 'machine', 'host-runtime.js'), 'console.log("tampered");\n');
  const refused = Bun.spawnSync([join(runtime, 'bin', 'bun'), join(runtime, 'host.js')], { env: { ...process.env, GITSPACE_ENVIRONMENT_ROOT: join(root, 'environment-2') }, stdout: 'pipe', stderr: 'pipe' });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stdout.toString()).not.toContain('tampered');
});

it('refuses a release manifest that is not the one the account named', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-cli-bootstrap-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = await account(root);
  source.objects.set(`releases/${source.release}/portable.manifest.json`, encoder.encode('{}'));
  await expect(installRuntime(join(root, 'config'), source)).rejects.toThrow('integrity');
  expect(existsSync(join(root, 'config', 'runtime-selection.json'))).toBe(false);
});
