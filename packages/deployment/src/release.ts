import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { buildInitialRuntime, workspaceSha } from './builders.js';
import { prepareRuntimeLocks } from './runtime-packaging.js';
import { OMP_IPC_VERSION, OmpRpcPeer, type OmpChildApi } from '../../account-omp/src/ipc.js';
import {
  DISTRIBUTION_BUN_VERSION,
  currentDistributionPlatform,
  currentGlibcVersion,
  distributionChannelSchema,
  distributionManifestSchema,
  distributionReleaseSchema,
  versionAtLeast,
  type DistributionFile,
  type DistributionPlatform,
} from './distribution.js';

const ROOT = resolve(import.meta.dir, '../../..');
const WALGIT_REVISION = '6d8fa54ba0f83072a1a50317bb6c8c1afa5a3cd1';
const RUST_VERSION = '1.97.1';
const COMPILE_TARGETS: Record<DistributionPlatform, Bun.Build.CompileTarget> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64': 'bun-linux-x64-baseline',
};
// Official release asset digests: https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.0
const BUN_ASSETS: Record<DistributionPlatform, { name: string; sha256: string }> = {
  'darwin-arm64': { name: 'bun-darwin-aarch64', sha256: 'c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381' },
  'darwin-x64': { name: 'bun-darwin-x64-baseline', sha256: 'da9b9f1b4ba766c6f299711f38dfaa98623e1ed9c40896aa53db803c52ec1fa0' },
  'linux-arm64': { name: 'bun-linux-aarch64', sha256: '4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e' },
  'linux-x64': { name: 'bun-linux-x64-baseline', sha256: '184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f' },
};

async function packageBun(platform: DistributionPlatform, scratch: string): Promise<string> {
  if (!Bun.which('unzip')) throw new Error('Release builds require unzip to unpack the hash-pinned official Bun asset; consumers do not need unzip.');
  const asset = BUN_ASSETS[platform];
  const archive = join(scratch, 'bun.zip');
  const response = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${DISTRIBUTION_BUN_VERSION}/${asset.name}.zip`);
  if (!response.ok || !response.body) throw new Error(`Cannot fetch pinned Bun ${asset.name}: HTTP ${response.status}`);
  await pipeline(Readable.from(response.body), createWriteStream(archive, { flags: 'wx' }));
  if ((await digest(archive)).sha256 !== asset.sha256) throw new Error('Official Bun release asset SHA256 mismatch');
  const binary = join(scratch, 'bun');
  const unpack = Bun.spawn(['unzip', '-p', archive, `${asset.name}/bun`], { stdout: 'pipe', stderr: 'inherit' });
  await pipeline(Readable.from(unpack.stdout), createWriteStream(binary, { flags: 'wx', mode: 0o755 }));
  if (await unpack.exited !== 0) throw new Error('Cannot extract the verified Bun release asset');
  await chmod(binary, 0o755);
  if (await command([binary, '--version'], scratch) !== DISTRIBUTION_BUN_VERSION) throw new Error('Packaged Bun version does not match the release ABI pin');
  return binary;
}

async function compileClient(platform: DistributionPlatform, bun: string, output: string): Promise<void> {
  const build = await Bun.build({
    entrypoints: [join(ROOT, 'packages/cli/src/index.ts')], target: 'bun',
    compile: { target: COMPILE_TARGETS[platform], executablePath: bun, outfile: output }, minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, 'Standalone client build failed');
  await chmod(output, 0o755);
}

export async function buildClient(output: string): Promise<void> {
  requireBun();
  const platform = currentDistributionPlatform();
  if (platform.startsWith('linux-')) currentGlibcVersion();
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.client-build-'));
  try {
    const bun = await packageBun(platform, staging);
    const client = join(staging, 'gitspace');
    await compileClient(platform, bun, client);
    await rename(client, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function requireBun(): void {
  if (Bun.version !== DISTRIBUTION_BUN_VERSION) throw new Error(`Release builds require Bun ${DISTRIBUTION_BUN_VERSION}, found ${Bun.version}. Install the pinned Bun on the build runner; consumers do not install Bun.`);
}

async function command(argv: string[], cwd: string, environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...environment }, stdout: 'pipe', stderr: 'inherit' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`Release command failed (${code}): ${argv.join(' ')}\n${stdout}`);
  return stdout.trim();
}

async function digest(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) { hash.update(bytes); size += bytes.length; }
  return { sha256: hash.digest('hex'), size };
}

async function inventory(root: string, directory = root): Promise<DistributionFile[]> {
  const files: DistributionFile[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) {
      const mode = (await lstat(path)).mode & 0o111 ? 0o755 : 0o644;
      await chmod(path, mode);
      files.push({ path: relative(root, path).split(sep).join('/'), ...await digest(path), mode });
    } else throw new Error(`Release runtime contains a link or special file: ${path}`);
  }
  return files;
}

async function packageWalgit(scratch: string, destination: string): Promise<void> {
  for (const binary of ['git', 'cargo', 'protoc', 'cmake', 'clang', 'pkg-config']) {
    if (!Bun.which(binary)) throw new Error(`Native release build requires ${binary}. Install the C/C++ build tools, protobuf compiler/development headers, OpenSSL development headers, and rustup toolchain ${RUST_VERSION} on this runner.`);
  }
  const source = join(scratch, 'walgit');
  await mkdir(source);
  await command(['git', 'init', '.'], source);
  await command(['git', 'remote', 'add', 'origin', 'https://github.com/tobi/walgit.git'], source);
  await command(['git', 'fetch', '--depth', '1', 'origin', WALGIT_REVISION], source);
  await command(['git', 'checkout', '--detach', 'FETCH_HEAD'], source);
  if (await command(['git', 'rev-parse', 'HEAD'], source) !== WALGIT_REVISION) throw new Error('walgit source revision mismatch');
  await command([process.execPath, 'install', '--frozen-lockfile'], join(source, 'web'));
  await command([process.execPath, 'run', 'build'], join(source, 'web'));
  await command(['cargo', `+${RUST_VERSION}`, 'build', '--locked', '--release', '-p', 'walgit-cli'], source, {
    CARGO_INCREMENTAL: '0',
    CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${source}=/gitspace-build/walgit`,
  });
  await cp(join(source, 'target/release/walgit'), destination);
  await chmod(destination, 0o755);
  await command([destination, '--version'], scratch);
  if (process.platform === 'darwin') {
    const libraries = (await command(['otool', '-L', destination], scratch)).split('\n').slice(1).map((line) => line.trim().split(' ')[0]!);
    const external = libraries.filter((path) => path && !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'));
    if (external.length) throw new Error(`WalGit depends on unbundled macOS libraries: ${external.join(', ')}`);
  }
}

/** Read every shipped ELF's version requirements, rather than claiming the build host's libc is the ABI floor. */
async function minimumGlibc(root: string, files: DistributionFile[], client: string): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  currentGlibcVersion();
  if (!Bun.which('readelf')) throw new Error('Linux release builds require binutils (readelf and strip) to record native ABI requirements.');
  let minimum = '2.17';
  for (const path of [client, ...files.map((file) => join(root, file.path))]) {
    const handle = await open(path, 'r');
    const magic = Buffer.alloc(4);
    try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    const versions = await command(['readelf', '--version-info', path], ROOT);
    for (const match of versions.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/gu)) {
      if (versionAtLeast(match[1]!, minimum)) minimum = match[1]!;
    }
  }
  return minimum;
}

async function probeOmpRuntime(runtime: string, scratch: string): Promise<void> {
  const home = join(scratch, 'probe-home');
  await mkdir(home);
  const rpc = new OmpRpcPeer<OmpChildApi, Record<string, never>>((message) => child.send(message), {});
  const child = Bun.spawn([join(runtime, 'bin/bun'), join(runtime, 'omp/omp.js')], {
    cwd: runtime,
    env: { HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, PATH: `${join(runtime, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` },
    stdout: 'inherit', stderr: 'inherit',
    ipc: (message) => rpc.receive(message),
    onExit: (_child, code) => rpc.close(new Error(`Packaged OMP exited during health check (${code})`)),
  });
  try {
    const health = await rpc.call('health', [], AbortSignal.timeout(30_000));
    if (health.protocolVersion !== OMP_IPC_VERSION || health.bunVersion !== DISTRIBUTION_BUN_VERSION || health.platform !== process.platform || health.arch !== process.arch) {
      throw new Error('Packaged OMP runtime health does not match the native distribution');
    }
  } finally {
    rpc.close();
    child.kill();
    await child.exited;
  }
}

export async function buildDistribution(options: { release: string; output: string; runtimeLocks: string; platform?: string }): Promise<string> {
  requireBun();
  const platform = currentDistributionPlatform();
  if (options.platform && options.platform !== platform) {
    throw new Error(`Cannot build ${options.platform} on ${platform}: OMP, ONNX, sherpa, sharp, walgit and Bun must match the native runner. Use macos-15 (darwin-arm64), macos-15-intel (darwin-x64), ubuntu-24.04 (linux-x64), or ubuntu-24.04-arm (linux-arm64).`);
  }
  if (platform.startsWith('linux-')) currentGlibcVersion();
  const release = distributionReleaseSchema.parse(options.release);
  const revision = await workspaceSha(ROOT);
  const output = resolve(options.output);
  const locks = resolve(options.runtimeLocks);
  for (const name of ['memory', 'tts']) await readFile(join(locks, name, 'bun.lock'));
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.distribution-build-'));
  try {
    const artifacts = join(staging, 'artifacts');
    const runtime = join(staging, 'runtime');
    await mkdir(artifacts);
    const client = join(artifacts, 'gitspace');
    const bun = await packageBun(platform, staging);
    await compileClient(platform, bun, client);
    const initial = await buildInitialRuntime(ROOT, runtime, locks);
    await mkdir(join(runtime, 'bin'));
    // A genuine private Bun preserves process.execPath for machine/OMP/worker children; no global runtime or special execution environment is required.
    await cp(bun, join(runtime, 'bin/bun'));
    await chmod(join(runtime, 'bin/bun'), 0o755);
    await writeFile(join(runtime, 'bin/omp'), [
      '#!/bin/sh',
      'set -eu',
      'runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)',
      'exec "$runtime_dir/bin/bun" "$runtime_dir/omp-launcher.js" "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    await probeOmpRuntime(runtime, staging);
    await packageWalgit(staging, join(runtime, 'bin/walgit'));
    const files = await inventory(runtime);
    const glibc = await minimumGlibc(runtime, files, client);
    const payload = join(artifacts, 'runtime.bin.gz');
    async function* content() {
      for (const file of files) {
        for await (const bytes of createReadStream(join(runtime, file.path))) yield bytes;
      }
    }
    // gzip has no wall-clock timestamps; paths, owners, mtimes and temporary build directories are not archive metadata.
    await pipeline(Readable.from(content()), createGzip({ level: 9 }), createWriteStream(payload, { flags: 'wx', mode: 0o644 }));
    const provenance = {
      schemaVersion: 1, release, platform, sourceRevision: revision, bunVersion: Bun.version,
      bunAsset: BUN_ASSETS[platform],
      sourceLock: await digest(join(ROOT, 'bun.lock')),
      runtimeLocks: Object.fromEntries(await Promise.all(['memory', 'tts'].map(async (name) => [name, {
        package: JSON.parse(await readFile(join(locks, name, 'package.json'), 'utf8')) as unknown,
        lock: await readFile(join(locks, name, 'bun.lock'), 'utf8'),
      }]))),
      walgit: { repository: 'https://github.com/tobi/walgit.git', revision: WALGIT_REVISION, rustVersion: RUST_VERSION },
      machine: { treeHash: initial.machine.hash, manifestHash: initial.machine.manifestHash },
      omp: { treeHash: initial.omp.hash, manifestHash: initial.omp.manifestHash, metadata: initial.omp.metadata },
    };
    await writeFile(join(artifacts, 'provenance.json'), JSON.stringify(provenance));
    const manifest = distributionManifestSchema.parse({
      schemaVersion: 1, release, platform, bunVersion: Bun.version, minimumGlibc: glibc,
      client: await digest(client), runtime: { ...await digest(payload), files },
      provenance: await digest(join(artifacts, 'provenance.json')),
    });
    await writeFile(join(artifacts, 'manifest.json'), JSON.stringify(manifest));
    const channel = distributionChannelSchema.parse({ schemaVersion: 1, release, platform, manifest: await digest(join(artifacts, 'manifest.json')) });
    await writeFile(join(artifacts, 'channel.json'), JSON.stringify(channel));
    await writeFile(join(artifacts, 'channel.txt'), `gitspace-distribution-v1\n${release}\n${manifest.client.sha256}\n`);
    // Existing releases are immutable. All output becomes visible together only after the complete native build.
    if (await Bun.file(join(output, 'manifest.json')).exists()) throw new Error(`Release output already exists: ${output}. Use a new release/output, do not overwrite published artifacts.`);
    await rename(artifacts, output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to publish distribution objects to R2`);
  return value;
}

export async function publishDistribution(directory: string, activate: boolean): Promise<void> {
  const manifestPath = join(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = distributionManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const channel = distributionChannelSchema.parse(JSON.parse(await readFile(join(directory, 'channel.json'), 'utf8')));
  const expectedManifest = await digest(manifestPath);
  if (channel.release !== manifest.release || channel.platform !== manifest.platform || channel.manifest.sha256 !== expectedManifest.sha256 || channel.manifest.size !== expectedManifest.size) {
    throw new Error('Release channel does not authenticate its manifest');
  }
  const expectedText = `gitspace-distribution-v1\n${manifest.release}\n${manifest.client.sha256}\n`;
  if (await readFile(join(directory, 'channel.txt'), 'utf8') !== expectedText) throw new Error('Installer channel does not match the release');
  const bucket = new Bun.S3Client({
    bucket: process.env.R2_BUCKET ?? 'gitspace-data', region: 'auto',
    endpoint: `https://${requiredEnvironment('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    accessKeyId: requiredEnvironment('R2_ACCESS_KEY_ID'), secretAccessKey: requiredEnvironment('R2_SECRET_ACCESS_KEY'),
  });
  const prefix = `distribution/v1/releases/${manifest.release}/${manifest.platform}/`;
  const publishedManifest = bucket.file(`${prefix}manifest.json`);
  const published = await publishedManifest.exists();
  if (published && !Buffer.from(await publishedManifest.arrayBuffer()).equals(manifestBytes)) {
    throw new Error(`Published release ${manifest.release}/${manifest.platform} is immutable; choose a new release id`);
  }
  for (const [name, expected, type] of [
    ['gitspace', manifest.client, 'application/octet-stream'],
    ['runtime.bin.gz', manifest.runtime, 'application/gzip'],
    ['provenance.json', manifest.provenance, 'application/json'],
  ] as const) {
    const path = join(directory, name);
    const actual = await digest(path);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error(`Release artifact integrity check failed: ${name}`);
    if (!published) {
      // Bun's S3 client uses bounded multipart uploads for large runtime payloads.
      await bucket.file(`${prefix}${name}`).write(Bun.file(path), { type });
    }
  }
  if (!published) await publishedManifest.write(manifestBytes, { type: 'application/json' });
  if (activate) {
    // Immutable assets first. Each platform channel is switched only after its entire release is uploaded.
    await bucket.file(`distribution/v1/stable/${manifest.platform}.json`).write(JSON.stringify(channel), { type: 'application/json' });
    await bucket.file(`distribution/v1/stable/${manifest.platform}.txt`).write(expectedText, { type: 'text/plain' });
  }
}

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  if (operation === 'locks') {
    requireBun();
    const output = option('--out');
    if (!output) throw new Error('Usage: bun packages/deployment/src/release.ts locks --out <retained-lock-directory>');
    await prepareRuntimeLocks(ROOT, resolve(output));
    console.log(`Retain and distribute this exact runtime lock set to every native runner: ${resolve(output)}`);
  } else if (operation === 'client') {
    const output = option('--out');
    if (!output) throw new Error('Usage: bun packages/deployment/src/release.ts client --out <client-path>');
    await buildClient(resolve(output));
    console.log(resolve(output));
  } else if (operation === 'build') {
    const release = option('--release');
    const output = option('--out');
    const runtimeLocks = option('--runtime-locks');
    if (!release || !output || !runtimeLocks) throw new Error('Usage: bun packages/deployment/src/release.ts build --release <immutable-id> --runtime-locks <retained-lock-directory> --out <new-platform-directory> [--platform <native-platform>]');
    console.log(await buildDistribution({ release, output, runtimeLocks, platform: option('--platform') }));
  } else if (operation === 'publish') {
    const directory = option('--from');
    if (!directory) throw new Error('Usage: bun packages/deployment/src/release.ts publish --from <platform-directory> [--activate]');
    await publishDistribution(resolve(directory), args.includes('--activate'));
    console.log(args.includes('--activate') ? 'Release published and platform channel activated.' : 'Immutable release published; channel unchanged. Repeat with --activate after acceptance.');
  } else {
    throw new Error('Expected locks, client, build, or publish. Native runners: darwin-arm64 (macos-15), darwin-x64 (macos-15-intel), linux-x64 (ubuntu-24.04), linux-arm64 (ubuntu-24.04-arm).');
  }
}
