import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException, UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { buildInitialRuntime, workspaceSha } from './builders.js';
import { prepareOmpRuntimeArtifact } from '../../account-omp/src/runtime-recipe.js';
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
  const cacheRoot = join(scratch, 'probe-omp-cache');
  const entrypoint = await prepareOmpRuntimeArtifact(join(runtime, 'omp'), { cacheRoot });
  const rpc = new OmpRpcPeer<OmpChildApi, Record<string, never>>((message) => child.send(message), {});
  const child = Bun.spawn([join(runtime, 'bin/bun'), entrypoint], {
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

export async function buildDistribution(options: { release: string; output: string; platform?: string }): Promise<string> {
  requireBun();
  const platform = currentDistributionPlatform();
  if (options.platform && options.platform !== platform) {
    throw new Error(`Cannot build ${options.platform} on ${platform}: native SDK addons, walgit and Bun must match the native runner. Use macos-15 (darwin-arm64), macos-15-intel (darwin-x64), ubuntu-24.04 (linux-x64), or ubuntu-24.04-arm (linux-arm64).`);
  }
  if (platform.startsWith('linux-')) currentGlibcVersion();
  const release = distributionReleaseSchema.parse(options.release);
  const revision = await workspaceSha(ROOT);
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.distribution-build-'));
  try {
    const artifacts = join(staging, 'artifacts');
    const runtime = join(staging, 'runtime');
    await mkdir(artifacts);
    const client = join(artifacts, 'gitspace');
    const bun = await packageBun(platform, staging);
    await compileClient(platform, bun, client);
    const initial = await buildInitialRuntime(ROOT, runtime);
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
      ompRecipe: JSON.parse(await readFile(join(runtime, 'omp/omp-runtime.json'), 'utf8')) as unknown,
      native: JSON.parse(await readFile(join(runtime, 'machine/machine-native.json'), 'utf8')) as unknown,
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

export async function publishDistribution(directory: string, activate: boolean, options: {
  client?: S3Client;
  bucket?: string;
  signal?: AbortSignal;
} = {}): Promise<void> {
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
  const client = options.client ?? new S3Client({
    region: 'auto', forcePathStyle: true, maxAttempts: 1,
    endpoint: `https://${requiredEnvironment('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: requiredEnvironment('R2_ACCESS_KEY_ID'), secretAccessKey: requiredEnvironment('R2_SECRET_ACCESS_KEY') },
    // SHA-256 is checked locally and on readback; do not add optional streaming checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = options.bucket ?? process.env.R2_BUCKET ?? 'gitspace-data';
  const prefix = `distribution/v1/releases/${manifest.release}/${manifest.platform}/`;
  const signal = options.signal ?? AbortSignal.timeout(10 * 60_000);
  type Digest = { sha256: string; size: number };
  async function request<T>(
    operation: string, key: string, bytes: number | null,
    run: (deadline: AbortSignal) => Promise<T>, operationSignal = signal,
  ): Promise<T> {
    const started = performance.now();
    const deadline = AbortSignal.any([operationSignal, AbortSignal.timeout(60_000)]);
    const report = (outcome: string) => console.log(JSON.stringify({
      event: 'distribution_publish', platform: manifest.platform, operation, key, bytes,
      elapsedMs: Math.round(performance.now() - started), outcome,
    }));
    report('start');
    const heartbeat = setInterval(() => report('pending'), 10_000);
    try {
      const result = await run(deadline);
      report('success');
      return result;
    } catch (error) {
      report(deadline.aborted ? 'aborted' : 'failure');
      const metadata = error instanceof S3ServiceException ? error.$metadata : undefined;
      const detail = deadline.aborted ? 'deadline exceeded or cancelled'
        : error instanceof S3ServiceException ? `${error.name}; HTTP ${metadata?.httpStatusCode ?? 'unknown'}; request ${metadata?.requestId ?? 'unknown'}`
          : error instanceof Error ? `${error.name}: ${error.message}` : 'UnknownError';
      // Do not print signed requests, credentials, or unfiltered S3 error bodies.
      throw new Error(`Distribution ${operation} ${key}: ${detail}`);
    } finally {
      clearInterval(heartbeat);
    }
  }
  async function remoteDigest(Key: string, expectedSize: number): Promise<Digest | null> {
    return request('GetObject', Key, expectedSize, async (deadline) => {
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: deadline });
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
        throw error;
      }
      if (!response.Body) throw new Error('Distribution response has no body');
      const hash = createHash('sha256');
      let size = 0;
      // Aborting only the SDK command does not cover consuming its response body.
      await response.Body.transformToWebStream().pipeTo(new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.byteLength;
          if (size > expectedSize) throw new Error('Distribution response exceeds its declared size');
          hash.update(chunk);
        },
      }), { signal: deadline });
      return { sha256: hash.digest('hex'), size };
    });
  }
  function verify(key: string, actual: Digest, expected: Digest): void {
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`Distribution integrity mismatch for ${key}; release objects are immutable`);
    }
  }
  async function put(Key: string, body: Buffer | string | { path: string }, ContentType: string, bytes: number, immutable: boolean): Promise<void> {
    const partSize = 8 * 1024 * 1024;
    const condition = immutable ? { IfNoneMatch: '*' } : {};
    if (typeof body === 'string' || Buffer.isBuffer(body) || bytes <= partSize) {
      await request('PutObject', Key, bytes, async (deadline) => {
        const Body = typeof body === 'string' || Buffer.isBuffer(body) ? body : createReadStream(body.path, { signal: deadline });
        try {
          await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType, ContentLength: bytes, ...condition }), { abortSignal: deadline });
        } catch (error) {
          if (!(immutable && error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412)) throw error;
        } finally {
          if (Body instanceof Readable) Body.destroy();
        }
      });
      return;
    }
    const { UploadId } = await request('CreateMultipartUpload', Key, null, (deadline) =>
      client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }), { abortSignal: deadline }));
    if (!UploadId) throw new Error(`Distribution multipart upload for ${Key} returned no upload id`);
    const controller = new AbortController();
    const uploadSignal = AbortSignal.any([signal, controller.signal]);
    const parts: CompletedPart[] = [];
    const partCount = Math.ceil(bytes / partSize);
    let nextPart = 1;
    const workers = Array.from({ length: Math.min(4, partCount) }, async () => {
      while (nextPart <= partCount) {
        uploadSignal.throwIfAborted();
        const PartNumber = nextPart++;
        const start = (PartNumber - 1) * partSize;
        const end = Math.min(bytes, start + partSize) - 1;
        const { ETag } = await request(`UploadPart ${PartNumber}/${partCount}`, Key, end - start + 1, async (deadline) => {
          const Body = createReadStream(body.path, { start, end, signal: deadline });
          try {
            return await client.send(new UploadPartCommand({
              Bucket, Key, UploadId, PartNumber, Body, ContentLength: end - start + 1,
            }), { abortSignal: deadline });
          } finally {
            Body.destroy();
          }
        }, uploadSignal);
        if (!ETag) throw new Error(`Distribution multipart upload ${Key} part ${PartNumber} returned no ETag`);
        parts.push({ PartNumber, ETag });
      }
    });
    async function abortMultipart(): Promise<void> {
      // Cleanup needs its own budget even when the caller's deadline has expired.
      await request('AbortMultipartUpload', Key, null, async (deadline) => {
        try {
          await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }), { abortSignal: deadline });
        } catch (error) {
          if (!(error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) throw error;
        }
      }, AbortSignal.timeout(10_000));
    }
    let completed = false;
    try {
      await Promise.all(workers);
      parts.sort((left, right) => (left.PartNumber ?? 0) - (right.PartNumber ?? 0));
      completed = await request('CompleteMultipartUpload', Key, null, async (deadline) => {
        try {
          await client.send(new CompleteMultipartUploadCommand({
            Bucket, Key, UploadId, MultipartUpload: { Parts: parts }, ...condition,
          }), { abortSignal: deadline });
          return true;
        } catch (error) {
          if (immutable && error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) return false;
          throw error;
        }
      });
    } catch (error) {
      controller.abort();
      await Promise.allSettled(workers);
      try { await abortMultipart(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Distribution upload and multipart cleanup failed for ${Key}`);
      }
      throw error;
    }
    if (!completed) await abortMultipart();
  }
  try {
    const publishedKey = `${prefix}manifest.json`;
    const published = await remoteDigest(publishedKey, expectedManifest.size);
    if (published) verify(publishedKey, published, expectedManifest);
    for (const [name, expected, type] of [
      ['gitspace', manifest.client, 'application/octet-stream'],
      ['runtime.bin.gz', manifest.runtime, 'application/gzip'],
      ['provenance.json', manifest.provenance, 'application/json'],
    ] as const) {
      const path = join(directory, name);
      verify(path, await digest(path), expected);
      const key = `${prefix}${name}`;
      let remote = await remoteDigest(key, expected.size);
      if (!remote) {
        if (published) throw new Error(`Published distribution object ${key} is missing`);
        await put(key, { path }, type, expected.size, true);
        remote = await remoteDigest(key, expected.size);
      }
      if (!remote) throw new Error(`Distribution object ${key} is missing after upload`);
      verify(key, remote, expected);
    }
    if (!published) {
      await put(publishedKey, manifestBytes, 'application/json', expectedManifest.size, true);
      const committed = await remoteDigest(publishedKey, expectedManifest.size);
      if (!committed) throw new Error(`Distribution manifest ${publishedKey} is missing after upload`);
      verify(publishedKey, committed, expectedManifest);
    }
    if (activate) {
      // Immutable assets are verified before either platform channel can change.
      const channelText = JSON.stringify(channel);
      await put(`distribution/v1/stable/${manifest.platform}.json`, channelText, 'application/json', Buffer.byteLength(channelText), false);
      await put(`distribution/v1/stable/${manifest.platform}.txt`, expectedText, 'text/plain', Buffer.byteLength(expectedText), false);
    }
  } finally {
    if (!options.client) client.destroy();
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
  if (operation === 'client') {
    const output = option('--out');
    if (!output) throw new Error('Usage: bun packages/deployment/src/release.ts client --out <client-path>');
    await buildClient(resolve(output));
    console.log(resolve(output));
  } else if (operation === 'build') {
    const release = option('--release');
    const output = option('--out');
    if (!release || !output) throw new Error('Usage: bun packages/deployment/src/release.ts build --release <immutable-id> --out <new-platform-directory> [--platform <native-platform>]');
    console.log(await buildDistribution({ release, output, platform: option('--platform') }));
  } else if (operation === 'publish') {
    const directory = option('--from');
    if (!directory) throw new Error('Usage: bun packages/deployment/src/release.ts publish --from <platform-directory> [--activate]');
    await publishDistribution(resolve(directory), args.includes('--activate'));
    console.log(args.includes('--activate') ? 'Release published and platform channel activated.' : 'Immutable release published; channel unchanged. Repeat with --activate after acceptance.');
  } else {
    throw new Error('Expected client, build, or publish. Native runners: darwin-arm64 (macos-15), darwin-x64 (macos-15-intel), linux-x64 (ubuntu-24.04), linux-arm64 (ubuntu-24.04-arm).');
  }
}
