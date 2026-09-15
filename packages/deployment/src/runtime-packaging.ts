import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readOmpReleaseMetadata, sha256 } from '@gitspace/account-omp/manifest';
import type { OmpReleaseMetadata } from '@gitspace/protocol';

export async function installedPackageRoot(name: string, from: string): Promise<string> {
  // Inspect the actual installed graph, not Bun's module cache or its built-in native-addon shims.
  // A release build can follow a dependency/patch install performed after this builder process started.
  let directory = await realpath(from);
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    const manifest = await lstat(join(candidate, 'package.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifest?.isFile()) return realpath(candidate);
    const parent = dirname(directory);
    if (parent === directory) throw Object.assign(new Error(`Cannot locate installed package ${name} from ${from}`), { code: 'MODULE_NOT_FOUND' });
    directory = parent;
  }
}

function pinnedVersion(value: string | undefined, label: string): string {
  if (!value || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(value)) throw new Error(`${label} has no exact upstream executable dependency version: ${value}`);
  return value;
}

interface LockedPackageMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
}

type LockedPackage = [string, string, LockedPackageMetadata, string];
interface BunLock {
  lockfileVersion: number;
  configVersion: number;
  workspaces: Record<string, { name: string; dependencies: Record<string, string> }>;
  patchedDependencies?: Record<string, string>;
  packages: Record<string, LockedPackage>;
}

/** Keep the source lock's exact dependency placements, including nested versions and optional metadata. */
function recipeLockedPackages(source: BunLock, dependencies: Record<string, string>): Record<string, LockedPackage> {
  const packages: Record<string, LockedPackage> = {};
  const visit = (name: string, from: string, optional = false): void => {
    let parent = from;
    let key: string;
    for (;;) {
      key = parent ? `${parent}/${name}` : name;
      if (source.packages[key]) break;
      if (!parent) {
        if (optional) return;
        throw new Error(`Source bun.lock is missing OMP dependency ${name} from ${from || 'root'}`);
      }
      parent = parent.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/u, '');
    }
    if (packages[key]) return;
    const entry = source.packages[key]!;
    if (entry.length !== 4 || !/^sha(?:256|512)-/u.test(entry[3])) {
      throw new Error(`OMP dependency ${key} must have a registry integrity in source bun.lock`);
    }
    packages[key] = entry;
    for (const dependency of Object.keys(entry[2].dependencies ?? {})) visit(dependency, key);
    for (const dependency of Object.keys(entry[2].optionalDependencies ?? {})) visit(dependency, key);
    for (const dependency of Object.keys(entry[2].peerDependencies ?? {})) {
      visit(dependency, key, entry[2].optionalPeers?.includes(dependency) ?? false);
    }
  };
  for (const [name, version] of Object.entries(dependencies)) {
    if (source.packages[name]?.[0] !== `${name}@${version}`) {
      throw new Error(`Source bun.lock does not pin ${name}@${version}`);
    }
    visit(name, '');
  }
  return Object.fromEntries(Object.entries(packages).sort(([left], [right]) => left.localeCompare(right)));
}

/** Publish dependency inputs only. The authenticated recipe is installed into a derived runtime cache on its host. */
export async function packageOmpRuntimeRecipe(root: string, outDir: string): Promise<OmpReleaseMetadata> {
  const packageRoot = join(root, 'packages/account-omp');
  const metadata = await readOmpReleaseMetadata(root);
  const source = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    gitspaceOmpPatches?: Record<string, string>;
  };
  for (const [name, version] of Object.entries(metadata.packages)) pinnedVersion(version, name);
  if (!['linux', 'darwin', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Unsupported OMP runtime platform: ${process.platform}-${process.arch}`);
  }
  // Optional dependencies are omitted from the base install. Core native functionality is not optional for GitSpace.
  const nativePackage = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
  const dependencies = {
    ...metadata.packages,
    [nativePackage]: pinnedVersion(metadata.packages['@oh-my-pi/pi-natives'], '@oh-my-pi/pi-natives'),
  };
  const patchedDependencies: Record<string, string> = {};
  const patches: Array<{ path: string; hash: `sha256:${string}` }> = [];
  // A sibling of outDir could inherit the checkout's workspace. A fresh OS temp directory cannot.
  const scratch = await mkdtemp(join(tmpdir(), 'gitspace-omp-recipe-'));
  try {
    for (const [specifier, path] of Object.entries(source.gitspaceOmpPatches ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const separator = specifier.lastIndexOf('@');
      const name = specifier.slice(0, separator);
      const version = specifier.slice(separator + 1);
      if (!metadata.packages[name] || metadata.packages[name] !== version) {
        throw new Error(`OMP patch ${specifier} does not match an exact SDK dependency`);
      }
      if (!path.startsWith('patches/') || /[\\:\0]/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`OMP patch must be a relative path inside patches/: ${path}`);
      }
      const bytes = await readFile(join(packageRoot, path));
      const hash = sha256(bytes);
      if (!metadata.patches.some((patch) => patch.path === `packages/account-omp/${path}` && patch.hash === hash)) {
        throw new Error(`OMP patch changed while preparing the release: ${path}`);
      }
      await mkdir(dirname(join(scratch, path)), { recursive: true });
      await writeFile(join(scratch, path), bytes, { flag: 'wx' });
      patchedDependencies[specifier] = path;
      patches.push({ path, hash });
    }
    if (patches.length !== metadata.patches.length) throw new Error('OMP patch map changed while preparing the release');
    const packageBytes = Buffer.from(`${JSON.stringify({
      name: 'gitspace-omp-runtime',
      private: true,
      type: 'module',
      dependencies,
      patchedDependencies,
    }, null, 2)}\n`);
    await writeFile(join(scratch, 'package.json'), packageBytes, { flag: 'wx' });
    const sourceLock = Bun.JSONC.parse(await readFile(join(root, 'bun.lock'), 'utf8')) as BunLock;
    if (sourceLock.lockfileVersion !== 1 || !sourceLock.packages) throw new Error('Unsupported source bun.lock format');
    const lockedPackages = recipeLockedPackages(sourceLock, dependencies);
    const recipeLock: BunLock = {
      lockfileVersion: sourceLock.lockfileVersion,
      configVersion: sourceLock.configVersion,
      workspaces: { '': { name: 'gitspace-omp-runtime', dependencies } },
      patchedDependencies,
      packages: lockedPackages,
    };
    await writeFile(join(scratch, 'bun.lock'), `${JSON.stringify(recipeLock, null, 2)}\n`, { flag: 'wx' });
    // Normalize only the projected source lock. A newer registry resolution is a build error, not a silent release change.
    const install = Bun.spawn([
      process.execPath, 'install', '--lockfile-only', '--ignore-scripts', '--save-text-lockfile', '--omit=optional', '--linker=hoisted',
    ], {
      cwd: scratch, env: { ...process.env, BUN_BE_BUN: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
    if (code !== 0) throw new Error(`Cannot resolve OMP runtime recipe lock: ${stdout}\n${stderr}`);
    const lockBytes = await readFile(join(scratch, 'bun.lock'));
    const resolvedLock = Bun.JSONC.parse(lockBytes.toString('utf8')) as BunLock;
    const provenance = (entry: LockedPackage): string => JSON.stringify([entry[0], entry[1], entry[3]]);
    const lockedInputs = new Set(Object.values(lockedPackages).map(provenance));
    if (Object.keys(resolvedLock.workspaces).length !== 1 || !resolvedLock.workspaces['']) {
      throw new Error('OMP runtime recipe lock inherited unrelated workspaces');
    }
    for (const entry of Object.values(resolvedLock.packages)) {
      if (!lockedInputs.has(provenance(entry))) {
        throw new Error(`OMP runtime recipe resolved ${entry[0]} outside source bun.lock; update the source dependency lock first`);
      }
    }
    for (const path of ['package.json', 'bun.lock', ...patches.map((patch) => patch.path)]) {
      await mkdir(dirname(join(outDir, path)), { recursive: true });
      await cp(join(scratch, path), join(outDir, path));
    }
    await writeFile(join(outDir, 'omp-runtime.json'), `${JSON.stringify({
      version: 1,
      upstreamVersion: metadata.upstreamVersion,
      bunVersion: metadata.bunVersion,
      platform: process.platform,
      arch: process.arch,
      adapter: 'omp-adapter.js',
      packageHash: sha256(packageBytes),
      lockHash: sha256(lockBytes),
      patches: patches.sort((left, right) => left.path.localeCompare(right.path)),
    }, null, 2)}\n`, { flag: 'wx' });
    return metadata;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
