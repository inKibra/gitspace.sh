import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { nativeHostAbi, validateNativeAbi } from '@gitspace/account-omp/manifest';
import type { NativeAbi } from '@gitspace/protocol/deployment';
import { hashArtifactPath } from './policies/shared.js';
import { currentDistributionPlatform, versionAtLeast, type DistributionPlatform } from './distribution.js';
import {
  GIT_LFS_DECLARATION, GIT_LFS_PATH, gitLfsRuntimeSchema, machineNativeDeclarationSchema, machineNativeRuntimeSchema,
  nativeFileDigest, prepareGitLfs, prepareMachineNativeRuntime, readGitLfsRuntime, readMachineNativeRuntime,
  verifyNativeFile, walgitProvenanceSchema, type GitLfsRuntime, type MachineNativeRuntime,
} from './native-runtime.js';

// Newer upstream writers change the packfile format. This is a data-compatibility pin.
export const WALGIT_REVISION = '6465bf578d0bc9686019bc6d4537861ab162ee6a';
export const WALGIT_PATCH = 'patches/walgit/conditional-multipart.patch';
export const WALGIT_RUST_VERSION = '1.97.1';
export const GIT_LFS_VERSION = '3.8.0';
// Official release assets; digests match the core-team-signed sha256sums.asc of https://github.com/git-lfs/git-lfs/releases/tag/v3.8.0
const GIT_LFS_ASSETS: Record<DistributionPlatform, { name: string; sha256: string; size: number }> = {
  'darwin-arm64': { name: 'git-lfs-darwin-arm64-v3.8.0.zip', sha256: 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8', size: 5_550_634 },
  'darwin-x64': { name: 'git-lfs-darwin-amd64-v3.8.0.zip', sha256: 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53', size: 6_198_060 },
  'linux-arm64': { name: 'git-lfs-linux-arm64-v3.8.0.tar.gz', sha256: 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2', size: 5_341_074 },
  'linux-x64': { name: 'git-lfs-linux-amd64-v3.8.0.tar.gz', sha256: 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d', size: 5_909_255 },
};

async function command(argv: string[], cwd: string, environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...environment }, stdout: 'pipe', stderr: 'inherit' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`Native build command failed (${code}): ${argv.join(' ')}\n${stdout}`);
  return stdout.trim();
}

function nativeCacheRoot(): string {
  return resolve(process.env.GITSPACE_NATIVE_CACHE ?? join(homedir(), '.cache/gitspace/native'));
}

/** Linux records actual ELF requirements; Darwin conservatively requires the build host OS. */
export async function machineNativeAbi(root: string, selected?: NativeAbi): Promise<NativeAbi> {
  const abi = nativeHostAbi();
  if (selected) validateNativeAbi(selected);
  if (abi.platform !== 'linux') return abi;
  if (!Bun.which('readelf')) throw new Error('Native packaging requires binutils (readelf and strip)');
  abi.minimumVersion = selected?.minimumVersion ?? '2.17';
  const files = (await readdir(root)).filter((path) => path.endsWith('.node')).map((path) => join(root, path));
  for (const path of ['native/walgit', GIT_LFS_PATH]) {
    if (await Bun.file(join(root, path)).exists()) files.push(join(root, path));
  }
  for (const file of files) {
    const versions = await command(['readelf', '--version-info', file], root);
    for (const match of versions.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/gu)) {
      if (versionAtLeast(match[1]!, abi.minimumVersion)) abi.minimumVersion = match[1]!;
    }
  }
  validateNativeAbi(abi);
  return abi;
}

async function pinnedWalgit(root: string): Promise<{ path: string; runtime: MachineNativeRuntime }> {
  // Snapshot before hashing/building: a concurrent source edit cannot change provenance halfway through.
  const patchBytes = await readFile(join(root, WALGIT_PATCH));
  const patch = { path: WALGIT_PATCH, sha256: new Bun.CryptoHasher('sha256').update(patchBytes).digest('hex'), size: patchBytes.byteLength };
  const provenance = walgitProvenanceSchema.parse({ repository: 'https://github.com/tobi/walgit.git', revision: WALGIT_REVISION, rustVersion: WALGIT_RUST_VERSION, bunVersion: Bun.version, build: 'static-openssl-v1', patch });
  const matches = (runtime: MachineNativeRuntime): boolean => runtime.walgit.source === 'release'
    && JSON.stringify(runtime.walgit.provenance) === JSON.stringify(provenance);
  // An ordinary source deployment on a linked machine can reuse its authenticated exact pin,
  // without a compiler, external registry, or bootstrap-global binary. Different declarations never reuse it.
  const generation = process.env.GITSPACE_MACHINE_RUNTIME_PATH;
  const generationHash = process.env.GITSPACE_GENERATION_HASH;
  if (generation && generationHash) {
    if (await hashArtifactPath(generation) !== generationHash) throw new Error('Selected machine generation integrity mismatch during native reuse');
    const runtime = await readMachineNativeRuntime(generation);
    if (matches(runtime)) return { path: (await prepareMachineNativeRuntime(generation)).walgit, runtime };
  }
  const key = new Bun.CryptoHasher('sha256').update(JSON.stringify({ provenance, abi: nativeHostAbi() })).digest('hex');
  const cacheRoot = nativeCacheRoot();
  const cached = join(cacheRoot, key);
  if (await Bun.file(join(cached, 'machine-native.json')).exists()) {
    const runtime = await readMachineNativeRuntime(cached);
    if (!matches(runtime)) throw new Error(`Native cache provenance mismatch: ${cached}`);
    return { path: (await prepareMachineNativeRuntime(cached)).walgit, runtime };
  }
  for (const binary of ['git', 'cargo', 'protoc', 'cmake', 'clang', 'pkg-config']) {
    if (!Bun.which(binary)) throw new Error(`Building declared WalGit requires ${binary}. Install C/C++ tools, protobuf compiler/development headers, OpenSSL development headers, binutils and rustup toolchain ${WALGIT_RUST_VERSION}; or declare a verified release payload/environment binary in packages/account-machine/native.json.`);
  }
  await mkdir(cacheRoot, { recursive: true });
  const scratch = await mkdtemp(join(cacheRoot, '.build-'));
  const payload = join(scratch, 'payload');
  const source = join(scratch, 'source');
  try {
    await mkdir(source);
    await mkdir(join(payload, 'native'), { recursive: true });
    await command(['git', 'init', '.'], source);
    await command(['git', 'remote', 'add', 'origin', provenance.repository], source);
    await command(['git', 'fetch', '--depth', '1', 'origin', WALGIT_REVISION], source);
    await command(['git', 'checkout', '--detach', 'FETCH_HEAD'], source);
    if (await command(['git', 'rev-parse', 'HEAD'], source) !== WALGIT_REVISION) throw new Error('WalGit source revision mismatch');
    const snapshot = join(scratch, 'conditional-multipart.patch');
    await writeFile(snapshot, patchBytes);
    await command(['git', 'apply', '--', snapshot], source);
    await command([process.execPath, 'install', '--frozen-lockfile'], join(source, 'web'));
    await command([process.execPath, 'run', 'build'], join(source, 'web'));
    await command(['cargo', `+${WALGIT_RUST_VERSION}`, 'build', '--locked', '--release', '-p', 'walgit-cli'], source, {
      CARGO_INCREMENTAL: '0',
      CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${source}=/gitspace-build/walgit`,
      OPENSSL_STATIC: '1',
    });
    const binary = join(payload, 'native/walgit');
    await cp(join(source, 'target/release/walgit'), binary);
    await chmod(binary, 0o755);
    if (process.platform === 'linux') await command(['strip', '--strip-debug', binary], source);
    if (process.platform === 'darwin') {
      const libraries = (await command(['otool', '-L', binary], source)).split('\n').slice(1).map((line) => line.trim().split(' ')[0]!);
      const external = libraries.filter((path) => path && !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'));
      if (external.length) throw new Error(`WalGit depends on unbundled macOS libraries: ${external.join(', ')}`);
    }
    await mkdir(join(payload, 'native/patches'), { recursive: true });
    await writeFile(join(payload, 'native/patches/conditional-multipart.patch'), patchBytes);
    const runtime = machineNativeRuntimeSchema.parse({
      version: 1, bunVersion: Bun.version, abi: await machineNativeAbi(payload),
      walgit: { source: 'release', path: 'native/walgit', ...await nativeFileDigest(binary), provenance },
    });
    await writeFile(join(payload, 'machine-native.json'), JSON.stringify(runtime));
    await prepareMachineNativeRuntime(payload);
    try { await rename(payload, cached); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const concurrent = await readMachineNativeRuntime(cached);
      if (!matches(concurrent)) throw new Error('Concurrent native cache provenance mismatch');
    }
    return { path: (await prepareMachineNativeRuntime(cached)).walgit, runtime: await readMachineNativeRuntime(cached) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Official Git LFS for this host, unpacked only from the hash-pinned upstream archive and cached by its digest. */
export async function pinnedGitLfs(): Promise<{ path: string; runtime: GitLfsRuntime }> {
  const asset = GIT_LFS_ASSETS[currentDistributionPlatform()];
  const upstream = gitLfsRuntimeSchema.shape.upstream.parse({
    version: GIT_LFS_VERSION, url: `https://github.com/git-lfs/git-lfs/releases/download/v${GIT_LFS_VERSION}/${asset.name}`,
    sha256: asset.sha256, size: asset.size,
  });
  const cacheRoot = nativeCacheRoot();
  const cached = join(cacheRoot, `git-lfs-${asset.sha256}`);
  if (!(await Bun.file(join(cached, GIT_LFS_DECLARATION)).exists())) {
    await mkdir(cacheRoot, { recursive: true });
    const scratch = await mkdtemp(join(cacheRoot, '.git-lfs-'));
    try {
      const archive = join(scratch, asset.name);
      const response = await fetch(upstream.url);
      // Not `response.body`: after touching it, Bun 1.4.0's Bun.write(path, response) spins without reading the socket.
      if (!response.ok) throw new Error(`Cannot fetch pinned Git LFS ${asset.name}: HTTP ${response.status}`);
      await Bun.write(archive, response);
      const archived = await nativeFileDigest(archive);
      if (archived.sha256 !== upstream.sha256 || archived.size !== upstream.size) throw new Error(`Official Git LFS release asset SHA256 mismatch: ${asset.name}`);
      // Only the host's own asset is unpacked: GNU tar detects gzip, and macOS bsdtar reads the Darwin zip assets.
      const member = `git-lfs-${GIT_LFS_VERSION}/git-lfs`;
      await command(['tar', '-xf', archive, '-C', scratch, member], scratch);
      const payload = join(scratch, 'payload');
      const binary = join(payload, GIT_LFS_PATH);
      await mkdir(dirname(binary), { recursive: true });
      await rename(join(scratch, member), binary);
      await chmod(binary, 0o755);
      const runtime = gitLfsRuntimeSchema.parse({ version: 1, path: GIT_LFS_PATH, ...await nativeFileDigest(binary), upstream });
      await writeFile(join(payload, GIT_LFS_DECLARATION), JSON.stringify(runtime));
      await prepareGitLfs(payload);
      try { await rename(payload, cached); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const runtime = await readGitLfsRuntime(cached);
  if (!runtime || JSON.stringify(runtime.upstream) !== JSON.stringify(upstream)) throw new Error(`Git LFS cache provenance mismatch: ${cached}`);
  await prepareGitLfs(cached);
  return { path: join(cached, runtime.path), runtime };
}

/** Resolve the tenant's source declaration into the existing complete-tree artifact. */
export async function packageMachineNativeRuntime(root: string, output: string): Promise<MachineNativeRuntime> {
  const declaration = machineNativeDeclarationSchema.parse(JSON.parse(await readFile(join(root, 'packages/account-machine/native.json'), 'utf8')));
  const selected = declaration.walgit;
  let walgit: MachineNativeRuntime['walgit'];
  let abi: NativeAbi | undefined;
  if (selected.source === 'environment') {
    abi = selected.abi;
    walgit = { source: 'environment', path: selected.path, sha256: selected.sha256, size: selected.size };
  } else {
    const destination = join(output, 'native/walgit');
    await mkdir(dirname(destination), { recursive: true });
    if (selected.source === 'pinned-walgit') {
      const built = await pinnedWalgit(root);
      if (built.runtime.walgit.source !== 'release') throw new Error('Pinned build did not produce a release payload');
      await cp(built.path, destination);
      await verifyNativeFile(destination, built.runtime.walgit);
      walgit = built.runtime.walgit;
      abi = built.runtime.abi;
      await mkdir(join(output, 'native/patches'), { recursive: true });
      await cp(join(dirname(built.path), 'patches/conditional-multipart.patch'), join(output, 'native/patches/conditional-multipart.patch'));
    } else {
      abi = selected.artifact.abi;
      validateNativeAbi(abi);
      const { location } = selected.artifact;
      if (location.startsWith('https://')) {
        const response = await fetch(location, { redirect: 'error' });
        if (!response.ok || !response.body) throw new Error(`Native payload download failed: ${response.status}`);
        await Bun.write(destination, response);
      } else {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(location)) throw new Error('Native artifact locations must be HTTPS URLs or local files');
        const source = isAbsolute(location) ? location : resolve(root, location);
        if (!(await lstat(source)).isFile()) throw new Error(`Native payload must be a regular file: ${source}`);
        await cp(source, destination, { dereference: false });
      }
      if (!(await lstat(destination)).isFile()) throw new Error(`Native payload must be a regular file: ${destination}`);
      await chmod(destination, 0o755);
      await verifyNativeFile(destination, selected.artifact);
      walgit = { source: 'release', path: 'native/walgit', sha256: selected.artifact.sha256, size: selected.artifact.size, provenance: null };
    }
  }
  // Every generation carries the same official Git LFS; the running machine puts its directory first on PATH.
  const gitLfs = await pinnedGitLfs();
  await mkdir(join(output, dirname(GIT_LFS_PATH)), { recursive: true });
  await cp(gitLfs.path, join(output, GIT_LFS_PATH));
  await verifyNativeFile(join(output, GIT_LFS_PATH), gitLfs.runtime);
  await writeFile(join(output, GIT_LFS_DECLARATION), JSON.stringify(gitLfs.runtime));
  const runtime = machineNativeRuntimeSchema.parse({ version: 1, bunVersion: Bun.version, abi: await machineNativeAbi(output, abi), walgit });
  await writeFile(join(output, 'machine-native.json'), JSON.stringify(runtime));
  // Environment paths belong to the destination image/host, not necessarily the build runner.
  if (walgit.source === 'release') await prepareMachineNativeRuntime(output);
  else await prepareGitLfs(output);
  return runtime;
}

/** Direct source execution follows the same declaration; never relies on a bootstrap binary path. */
export async function sourceWalgit(root: string): Promise<string> {
  const declaration = machineNativeDeclarationSchema.parse(JSON.parse(await readFile(join(root, 'packages/account-machine/native.json'), 'utf8')));
  if (declaration.walgit.source === 'pinned-walgit') return (await pinnedWalgit(root)).path;
  const cacheRoot = nativeCacheRoot();
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(join(cacheRoot, '.source-'));
  try {
    await packageMachineNativeRuntime(root, staging);
    const { walgit: path } = await prepareMachineNativeRuntime(staging);
    if (declaration.walgit.source === 'environment') return path;
    const destination = join(cacheRoot, (await hashArtifactPath(staging)).slice(7));
    try { await rename(staging, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    return (await prepareMachineNativeRuntime(destination)).walgit;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
