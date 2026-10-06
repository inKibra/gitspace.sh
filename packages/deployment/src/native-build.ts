import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nativeHostAbi, validateNativeAbi } from './executable-manifest.js';
import type { NativeAbi } from '@gitspace/protocol/deployment';
import { currentDistributionPlatform, versionAtLeast, type DistributionPlatform } from './distribution.js';
import {
  GIT_LFS_DECLARATION, GIT_LFS_PATH, gitLfsRuntimeSchema, machineNativeRuntimeSchema,
  nativeFileDigest, prepareGitLfs, prepareMachineNativeRuntime, readGitLfsRuntime,
  verifyNativeFile, type GitLfsRuntime, type MachineNativeRuntime,
  RIPGREP_DECLARATION, RIPGREP_PATH, ripgrepRuntimeSchema, prepareRipgrep, readRipgrepRuntime, type RipgrepRuntime,
} from './native-runtime.js';

export const GIT_LFS_VERSION = '3.8.0';
// Official release assets; digests match the core-team-signed sha256sums.asc of https://github.com/git-lfs/git-lfs/releases/tag/v3.8.0
const GIT_LFS_ASSETS: Record<DistributionPlatform, { name: string; sha256: string; size: number }> = {
  'darwin-arm64': { name: 'git-lfs-darwin-arm64-v3.8.0.zip', sha256: 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8', size: 5_550_634 },
  'darwin-x64': { name: 'git-lfs-darwin-amd64-v3.8.0.zip', sha256: 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53', size: 6_198_060 },
  'linux-arm64': { name: 'git-lfs-linux-arm64-v3.8.0.tar.gz', sha256: 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2', size: 5_341_074 },
  'linux-x64': { name: 'git-lfs-linux-amd64-v3.8.0.tar.gz', sha256: 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d', size: 5_909_255 },
};

export const RIPGREP_VERSION = '14.1.1';
// Official release archives verified against their adjacent .sha256 assets:
// https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1
// Linux x64 is upstream's static musl executable; it adds no glibc requirement.
const RIPGREP_ASSETS: Record<DistributionPlatform, { name: string; sha256: string; size: number }> = {
  'darwin-arm64': { name: 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz', sha256: '24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be', size: 1_787_248 },
  'darwin-x64': { name: 'ripgrep-14.1.1-x86_64-apple-darwin.tar.gz', sha256: 'fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3', size: 2_082_672 },
  'linux-arm64': { name: 'ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz', sha256: 'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f', size: 2_047_405 },
  'linux-x64': { name: 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz', sha256: '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e', size: 2_566_310 },
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
  for (const path of [GIT_LFS_PATH, RIPGREP_PATH]) {
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

/** Source runs and packaged generations use the same authenticated upstream binary. */
export async function pinnedRipgrep(): Promise<{ path: string; runtime: RipgrepRuntime }> {
  const asset = RIPGREP_ASSETS[currentDistributionPlatform()];
  const upstream = ripgrepRuntimeSchema.shape.upstream.parse({
    version: RIPGREP_VERSION, url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset.name}`,
    sha256: asset.sha256, size: asset.size,
  });
  const cacheRoot = nativeCacheRoot();
  const cached = join(cacheRoot, `ripgrep-${asset.sha256}`);
  if (!(await Bun.file(join(cached, RIPGREP_DECLARATION)).exists())) {
    await mkdir(cacheRoot, { recursive: true });
    const scratch = await mkdtemp(join(cacheRoot, '.ripgrep-'));
    try {
      const archive = join(scratch, asset.name);
      const response = await fetch(upstream.url);
      if (!response.ok) throw new Error(`Cannot fetch pinned ripgrep ${asset.name}: HTTP ${response.status}`);
      await Bun.write(archive, response);
      const archived = await nativeFileDigest(archive);
      if (archived.sha256 !== upstream.sha256 || archived.size !== upstream.size) throw new Error(`Official ripgrep release asset SHA256 mismatch: ${asset.name}`);
      const member = `${asset.name.slice(0, -'.tar.gz'.length)}/rg`;
      await command(['tar', '-xf', archive, '-C', scratch, member], scratch);
      const payload = join(scratch, 'payload');
      const binary = join(payload, RIPGREP_PATH);
      await mkdir(dirname(binary), { recursive: true });
      await rename(join(scratch, member), binary);
      await chmod(binary, 0o755);
      const runtime = ripgrepRuntimeSchema.parse({ version: 1, path: RIPGREP_PATH, ...await nativeFileDigest(binary), upstream });
      await writeFile(join(payload, RIPGREP_DECLARATION), JSON.stringify(runtime));
      await prepareRipgrep(payload);
      try { await rename(payload, cached); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const runtime = await readRipgrepRuntime(cached);
  if (!runtime || JSON.stringify(runtime.upstream) !== JSON.stringify(upstream)) throw new Error(`ripgrep cache provenance mismatch: ${cached}`);
  await prepareRipgrep(cached);
  return { path: join(cached, runtime.path), runtime };
}

/** Package the authenticated tools used by machine effects. */
export async function packageMachineNativeRuntime(_root: string, output: string): Promise<MachineNativeRuntime> {
  // Every generation carries the same official Git LFS; the running machine puts its directory first on PATH.
  const gitLfs = await pinnedGitLfs();
  await mkdir(join(output, dirname(GIT_LFS_PATH)), { recursive: true });
  await cp(gitLfs.path, join(output, GIT_LFS_PATH));
  await verifyNativeFile(join(output, GIT_LFS_PATH), gitLfs.runtime);
  await writeFile(join(output, GIT_LFS_DECLARATION), JSON.stringify(gitLfs.runtime));
  const ripgrep = await pinnedRipgrep();
  await cp(ripgrep.path, join(output, RIPGREP_PATH));
  await verifyNativeFile(join(output, RIPGREP_PATH), ripgrep.runtime);
  await writeFile(join(output, RIPGREP_DECLARATION), JSON.stringify(ripgrep.runtime));
  const runtime = machineNativeRuntimeSchema.parse({ version: 2, bunVersion: Bun.version, abi: await machineNativeAbi(output) });
  await writeFile(join(output, 'machine-native.json'), JSON.stringify(runtime));
  await prepareMachineNativeRuntime(output);
  return runtime;
}

