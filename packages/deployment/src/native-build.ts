import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { nativeHostAbi, validateNativeAbi } from '@gitspace/account-omp/manifest';
import type { NativeAbi } from '@gitspace/protocol/deployment';
import { hashArtifactPath } from './policies/shared.js';
import { versionAtLeast } from './distribution.js';
import {
  machineNativeDeclarationSchema, machineNativeRuntimeSchema, nativeFileDigest,
  prepareMachineNativeRuntime, readMachineNativeRuntime, verifyNativeFile, walgitProvenanceSchema,
  type MachineNativeRuntime,
} from './native-runtime.js';

// Newer upstream writers change the packfile format. This is a data-compatibility pin.
export const WALGIT_REVISION = '6465bf578d0bc9686019bc6d4537861ab162ee6a';
export const WALGIT_PATCH = 'patches/walgit/conditional-multipart.patch';
export const WALGIT_RUST_VERSION = '1.97.1';

async function command(argv: string[], cwd: string, environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...environment }, stdout: 'pipe', stderr: 'inherit' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`Native build command failed (${code}): ${argv.join(' ')}\n${stdout}`);
  return stdout.trim();
}

/** Linux records actual ELF requirements; Darwin conservatively requires the build host OS. */
export async function machineNativeAbi(root: string, selected?: NativeAbi): Promise<NativeAbi> {
  const abi = nativeHostAbi();
  if (selected) validateNativeAbi(selected);
  if (abi.platform !== 'linux') return abi;
  if (!Bun.which('readelf')) throw new Error('Native packaging requires binutils (readelf and strip)');
  abi.minimumVersion = selected?.minimumVersion ?? '2.17';
  const files = (await readdir(root)).filter((path) => path.endsWith('.node')).map((path) => join(root, path));
  if (await Bun.file(join(root, 'native/walgit')).exists()) files.push(join(root, 'native/walgit'));
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
    if (matches(runtime)) return { path: await prepareMachineNativeRuntime(generation), runtime };
  }
  const key = new Bun.CryptoHasher('sha256').update(JSON.stringify({ provenance, abi: nativeHostAbi() })).digest('hex');
  const cacheRoot = resolve(process.env.GITSPACE_NATIVE_CACHE ?? join(homedir(), '.cache/gitspace/native'));
  const cached = join(cacheRoot, key);
  if (await Bun.file(join(cached, 'machine-native.json')).exists()) {
    const runtime = await readMachineNativeRuntime(cached);
    if (!matches(runtime)) throw new Error(`Native cache provenance mismatch: ${cached}`);
    return { path: await prepareMachineNativeRuntime(cached), runtime };
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
    return { path: await prepareMachineNativeRuntime(cached), runtime: await readMachineNativeRuntime(cached) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
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
  const runtime = machineNativeRuntimeSchema.parse({ version: 1, bunVersion: Bun.version, abi: await machineNativeAbi(output, abi), walgit });
  await writeFile(join(output, 'machine-native.json'), JSON.stringify(runtime));
  // Environment paths belong to the destination image/host, not necessarily the build runner.
  if (walgit.source === 'release') await prepareMachineNativeRuntime(output);
  return runtime;
}

/** Direct source execution follows the same declaration; never relies on a bootstrap binary path. */
export async function sourceWalgit(root: string): Promise<string> {
  const declaration = machineNativeDeclarationSchema.parse(JSON.parse(await readFile(join(root, 'packages/account-machine/native.json'), 'utf8')));
  if (declaration.walgit.source === 'pinned-walgit') return (await pinnedWalgit(root)).path;
  const cacheRoot = resolve(process.env.GITSPACE_NATIVE_CACHE ?? join(homedir(), '.cache/gitspace/native'));
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(join(cacheRoot, '.source-'));
  try {
    await packageMachineNativeRuntime(root, staging);
    const path = await prepareMachineNativeRuntime(staging);
    if (declaration.walgit.source === 'environment') return path;
    const destination = join(cacheRoot, (await hashArtifactPath(staging)).slice(7));
    try { await rename(staging, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    return await prepareMachineNativeRuntime(destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
