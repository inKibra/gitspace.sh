import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { nativeHostAbi, validateNativeAbi } from './executable-manifest.js';
import type { NativeAbi } from '@gitspace/protocol/deployment';
import type { PortableNatives } from '@gitspace/protocol/machine-release';
import { currentDistributionPlatform, versionAtLeast } from './distribution.js';
import { NATIVE_PINS } from './native-pins.js';
import {
  GIT_LFS_DECLARATION, GIT_LFS_PATH, gitLfsRuntimeSchema, machineNativeRuntimeSchema,
  nativeFileDigest, prepareGitLfs, prepareMachineNativeRuntime, readGitLfsRuntime,
  verifyNativeFile, type GitLfsRuntime, type MachineNativeRuntime,
  RIPGREP_DECLARATION, RIPGREP_PATH, ripgrepRuntimeSchema, prepareRipgrep, readRipgrepRuntime, type RipgrepRuntime,
} from './native-runtime.js';

async function command(argv: string[], cwd: string, environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...environment }, stdout: 'pipe', stderr: 'inherit' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`Native build command failed (${code}): ${argv.join(' ')}\n${stdout}`);
  return stdout.trim();
}

/** One platform's pinned natives (`NATIVE_PINS`, or a portable release's `natives`). */
export type PlatformNatives = PortableNatives['linux-x64'];
/** Where a host's pinned natives come from: their pins, and each pinned upstream archive's bytes (checked against the
 * pin here either way). A release build and a source run download them upstream; a machine assembling a generation
 * reads its account's mirror. */
export interface NativeSource { pins: PlatformNatives; archive(pin: { url: string; sha256: string; size: number }): Promise<Response> }
const upstreamNatives = (): NativeSource => ({ pins: NATIVE_PINS[currentDistributionPlatform()], archive: pin => fetch(pin.url) });

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
export async function pinnedGitLfs(source: NativeSource = upstreamNatives()): Promise<{ path: string; runtime: GitLfsRuntime }> {
  const pin = source.pins['git-lfs'];
  const asset = basename(pin.url);
  const upstream = gitLfsRuntimeSchema.shape.upstream.parse({ version: pin.version, url: pin.url, sha256: pin.sha256, size: pin.size });
  const cacheRoot = nativeCacheRoot();
  const cached = join(cacheRoot, `git-lfs-${pin.sha256}`);
  if (!(await Bun.file(join(cached, GIT_LFS_DECLARATION)).exists())) {
    await mkdir(cacheRoot, { recursive: true });
    const scratch = await mkdtemp(join(cacheRoot, '.git-lfs-'));
    try {
      const archive = join(scratch, asset);
      const response = await source.archive(upstream);
      // Not `response.body`: after touching it, Bun 1.4.0's Bun.write(path, response) spins without reading the socket.
      if (!response.ok) throw new Error(`Cannot fetch pinned Git LFS ${asset}: HTTP ${response.status}`);
      await Bun.write(archive, response);
      const archived = await nativeFileDigest(archive);
      if (archived.sha256 !== upstream.sha256 || archived.size !== upstream.size) throw new Error(`Official Git LFS release asset SHA256 mismatch: ${asset}`);
      // Only the host's own asset is unpacked: GNU tar detects gzip, and macOS bsdtar reads the Darwin zip assets.
      const member = pin.member;
      await command(['tar', '-xf', archive, '-C', scratch, member], scratch);
      const payload = join(scratch, 'payload');
      const binary = join(payload, GIT_LFS_PATH);
      await mkdir(dirname(binary), { recursive: true });
      await rename(join(scratch, member), binary);
      await chmod(binary, 0o755);
      await verifyNativeFile(binary, pin.executable);
      const runtime = gitLfsRuntimeSchema.parse({ version: 1, path: GIT_LFS_PATH, ...await nativeFileDigest(binary), upstream });
      await writeFile(join(payload, GIT_LFS_DECLARATION), JSON.stringify(runtime));
      await prepareGitLfs(payload);
      try { await rename(payload, cached); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const runtime = await readGitLfsRuntime(cached);
  if (!runtime || JSON.stringify(runtime.upstream) !== JSON.stringify(upstream) || runtime.sha256 !== pin.executable.sha256 || runtime.size !== pin.executable.size) throw new Error(`Git LFS cache provenance mismatch: ${cached}`);
  await prepareGitLfs(cached);
  return { path: join(cached, runtime.path), runtime };
}

/** Source runs and packaged generations use the same authenticated upstream binary. */
export async function pinnedRipgrep(source: NativeSource = upstreamNatives()): Promise<{ path: string; runtime: RipgrepRuntime }> {
  const pin = source.pins.rg;
  const asset = basename(pin.url);
  const upstream = ripgrepRuntimeSchema.shape.upstream.parse({ version: pin.version, url: pin.url, sha256: pin.sha256, size: pin.size });
  const cacheRoot = nativeCacheRoot();
  const cached = join(cacheRoot, `ripgrep-${pin.sha256}`);
  if (!(await Bun.file(join(cached, RIPGREP_DECLARATION)).exists())) {
    await mkdir(cacheRoot, { recursive: true });
    const scratch = await mkdtemp(join(cacheRoot, '.ripgrep-'));
    try {
      const archive = join(scratch, asset);
      const response = await source.archive(upstream);
      if (!response.ok) throw new Error(`Cannot fetch pinned ripgrep ${asset}: HTTP ${response.status}`);
      await Bun.write(archive, response);
      const archived = await nativeFileDigest(archive);
      if (archived.sha256 !== upstream.sha256 || archived.size !== upstream.size) throw new Error(`Official ripgrep release asset SHA256 mismatch: ${asset}`);
      const member = pin.member;
      await command(['tar', '-xf', archive, '-C', scratch, member], scratch);
      const payload = join(scratch, 'payload');
      const binary = join(payload, RIPGREP_PATH);
      await mkdir(dirname(binary), { recursive: true });
      await rename(join(scratch, member), binary);
      await chmod(binary, 0o755);
      await verifyNativeFile(binary, pin.executable);
      const runtime = ripgrepRuntimeSchema.parse({ version: 1, path: RIPGREP_PATH, ...await nativeFileDigest(binary), upstream });
      await writeFile(join(payload, RIPGREP_DECLARATION), JSON.stringify(runtime));
      await prepareRipgrep(payload);
      try { await rename(payload, cached); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const runtime = await readRipgrepRuntime(cached);
  if (!runtime || JSON.stringify(runtime.upstream) !== JSON.stringify(upstream) || runtime.sha256 !== pin.executable.sha256 || runtime.size !== pin.executable.size) throw new Error(`ripgrep cache provenance mismatch: ${cached}`);
  await prepareRipgrep(cached);
  return { path: join(cached, runtime.path), runtime };
}

/** Package the authenticated tools used by machine effects. `abi` is the generation's native ABI when the caller knows
 * it (a machine assembling its own); otherwise it is read from the packed files. */
export async function packageMachineNativeRuntime(output: string, source: NativeSource = upstreamNatives(), abi?: NativeAbi): Promise<MachineNativeRuntime> {
  // Every generation carries the same official Git LFS; the running machine puts its directory first on PATH.
  const gitLfs = await pinnedGitLfs(source);
  await mkdir(join(output, dirname(GIT_LFS_PATH)), { recursive: true });
  await cp(gitLfs.path, join(output, GIT_LFS_PATH));
  await verifyNativeFile(join(output, GIT_LFS_PATH), gitLfs.runtime);
  await writeFile(join(output, GIT_LFS_DECLARATION), JSON.stringify(gitLfs.runtime));
  const ripgrep = await pinnedRipgrep(source);
  await cp(ripgrep.path, join(output, RIPGREP_PATH));
  await verifyNativeFile(join(output, RIPGREP_PATH), ripgrep.runtime);
  await writeFile(join(output, RIPGREP_DECLARATION), JSON.stringify(ripgrep.runtime));
  const runtime = machineNativeRuntimeSchema.parse({ version: 2, bunVersion: Bun.version, abi: abi ?? await machineNativeAbi(output) });
  await writeFile(join(output, 'machine-native.json'), JSON.stringify(runtime));
  await prepareMachineNativeRuntime(output);
  return runtime;
}

