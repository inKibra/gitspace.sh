import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface OmpRuntimeRecipe {
  version: 1;
  upstreamVersion: string;
  bunVersion: string;
  platform: 'linux' | 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
  adapter: 'omp-adapter.js';
  packageHash: string;
  lockHash: string;
  patches: { path: string; hash: string }[];
}

interface PayloadFile { path: string; bytes: Buffer; mode: number; hash: string }
interface RecipePayload { recipe: OmpRuntimeRecipe; files: PayloadFile[]; dependencies: Record<string, string>; key: string }
const RECIPE_FILE = 'omp-runtime.json';
const CACHE_VERSION = 1;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid OMP ${label}`);
  return value as Record<string, unknown>;
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function safePath(path: unknown): path is string {
  return typeof path === 'string' && /^[A-Za-z0-9@%._+/-]+$/u.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseRecipe(value: unknown): OmpRuntimeRecipe {
  const recipe = record(value, 'runtime recipe');
  const fields = ['version', 'upstreamVersion', 'bunVersion', 'platform', 'arch', 'adapter', 'packageHash', 'lockHash', 'patches'];
  if (Object.keys(recipe).some((key) => !fields.includes(key)) || recipe.version !== 1
    || typeof recipe.upstreamVersion !== 'string' || !VERSION.test(recipe.upstreamVersion)
    || typeof recipe.bunVersion !== 'string' || !VERSION.test(recipe.bunVersion)
    || !['linux', 'darwin', 'win32'].includes(String(recipe.platform))
    || !['x64', 'arm64'].includes(String(recipe.arch)) || recipe.adapter !== 'omp-adapter.js'
    || typeof recipe.packageHash !== 'string' || !HASH.test(recipe.packageHash)
    || typeof recipe.lockHash !== 'string' || !HASH.test(recipe.lockHash) || !Array.isArray(recipe.patches)) {
    throw new Error('Invalid OMP runtime recipe');
  }
  if (recipe.platform !== process.platform || recipe.arch !== process.arch || recipe.bunVersion !== Bun.version) {
    throw new Error(`OMP runtime recipe is incompatible with ${process.platform}/${process.arch}/Bun ${Bun.version}`);
  }
  const paths = new Set<string>();
  for (const value of recipe.patches) {
    const patch = record(value, 'runtime patch');
    if (Object.keys(patch).some((key) => key !== 'path' && key !== 'hash')
      || !safePath(patch.path) || !patch.path.startsWith('patches/') || !patch.path.endsWith('.patch')
      || typeof patch.hash !== 'string' || !HASH.test(patch.hash) || paths.has(patch.path.toLowerCase())) {
      throw new Error('Invalid OMP runtime patch path or hash');
    }
    paths.add(patch.path.toLowerCase());
  }
  return recipe as unknown as OmpRuntimeRecipe;
}

function validatePackage(bytes: Buffer, recipe: OmpRuntimeRecipe): Record<string, string> {
  const manifest = record(JSON.parse(bytes.toString('utf8')), 'runtime package');
  if (manifest.type !== 'module' || ['scripts', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces', 'overrides', 'resolutions', 'trustedDependencies'].some((key) => key in manifest)) {
    throw new Error('OMP runtime package must contain only pinned production SDK dependencies');
  }
  if (manifest.packageManager !== undefined && manifest.packageManager !== `bun@${recipe.bunVersion}`) {
    throw new Error('OMP runtime package Bun version mismatch');
  }
  const dependencies = record(manifest.dependencies, 'runtime dependencies');
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^@oh-my-pi\/[a-z0-9-]+$/u.test(name) || version !== recipe.upstreamVersion) {
      throw new Error(`OMP runtime dependency version mismatch: ${name}`);
    }
  }
  for (const name of ['@oh-my-pi/pi-coding-agent', `@oh-my-pi/pi-natives-${recipe.platform}-${recipe.arch}`]) {
    if (dependencies[name] !== recipe.upstreamVersion) throw new Error(`OMP runtime requires exact dependency ${name}`);
  }
  const patches = record(manifest.patchedDependencies ?? {}, 'patched dependencies');
  const declaredPaths = new Set(recipe.patches.map((patch) => patch.path));
  for (const [name, path] of Object.entries(patches)) {
    const split = name.lastIndexOf('@');
    if (split <= 0 || dependencies[name.slice(0, split)] !== recipe.upstreamVersion
      || name.slice(split + 1) !== recipe.upstreamVersion || typeof path !== 'string' || !declaredPaths.delete(path)) {
      throw new Error(`OMP runtime patched dependency mismatch: ${name}`);
    }
  }
  if (declaredPaths.size) throw new Error('OMP runtime patch inventory mismatch');
  return dependencies as Record<string, string>;
}

/** Capture the small, authenticated input tree once; never install into its selection path. */
async function loadPayload(root: string, recipeBytes: Buffer): Promise<RecipePayload> {
  const recipe = parseRecipe(JSON.parse(recipeBytes.toString('utf8')));
  const expected = new Map<string, string | undefined>([
    [RECIPE_FILE, digest(recipeBytes)], ['omp.js', undefined], [recipe.adapter, undefined],
    ['package.json', recipe.packageHash], ['bun.lock', recipe.lockHash],
    ...recipe.patches.map((patch): [string, string] => [patch.path, patch.hash]),
  ]);
  const files: PayloadFile[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const local = relative(root, path).split(sep).join('/');
      const info = await lstat(path);
      if (info.isDirectory() && [...expected.keys()].some((key) => key.startsWith(`${local}/`))) {
        await visit(path);
      } else if (info.isFile() && expected.has(local)) {
        const bytes = await readFile(path);
        const hash = digest(bytes);
        if (expected.get(local) !== undefined && expected.get(local) !== hash) throw new Error(`OMP runtime input integrity mismatch: ${local}`);
        files.push({ path: local, bytes, mode: info.mode & 0o777, hash });
      } else {
        throw new Error(`Unexpected OMP runtime payload entry: ${local}`);
      }
    }
  }
  await visit(root);
  if (files.length !== expected.size) throw new Error('OMP runtime input inventory mismatch');
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const dependencies = validatePackage(files.find((file) => file.path === 'package.json')!.bytes, recipe);
  const key = digest(Buffer.from(JSON.stringify([CACHE_VERSION, files.map(({ path, hash, mode }) => [path, hash, mode])]))).slice(7);
  return { recipe, files, dependencies, key };
}

/** Hash installed bytes, not just a readiness marker. Links must survive rename and stay inside this install. */
async function installedTreeHash(root: string): Promise<string> {
  if (!(await lstat(root)).isDirectory()) throw new Error('OMP runtime install must be a regular directory');
  const physicalRoot = await realpath(root);
  const tree = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const local = relative(root, path).split(sep).join('/');
      const info = await lstat(path);
      if (info.isDirectory()) {
        tree.update(JSON.stringify([local, 'directory', info.mode & 0o777]));
        await visit(path);
      } else if (info.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        tree.update(JSON.stringify([local, 'file', info.mode & 0o777, hash.digest('hex')]));
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !within(root, resolve(dirname(path), target)) || !within(physicalRoot, await realpath(path))) {
          throw new Error(`OMP runtime install link escapes its generation: ${local}`);
        }
        tree.update(JSON.stringify([local, 'link', target]));
      } else {
        throw new Error(`OMP runtime install contains a non-regular entry: ${local}`);
      }
    }
  }
  await visit(root);
  return `sha256:${tree.digest('hex')}`;
}

async function validateInstalledInputs(root: string, payload: RecipePayload): Promise<void> {
  for (const file of payload.files) {
    const path = join(root, file.path);
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o777) !== file.mode || digest(await readFile(path)) !== file.hash) {
      throw new Error(`OMP installed runtime input integrity mismatch: ${file.path}`);
    }
  }
  for (const [name, version] of Object.entries(payload.dependencies)) {
    const path = join(root, 'node_modules', name, 'package.json');
    if (!(await lstat(path)).isFile()) throw new Error(`OMP installed dependency is not a regular file: ${name}`);
    const manifest = record(JSON.parse(await readFile(path, 'utf8')), 'installed package');
    if (manifest.name !== name || manifest.version !== version) throw new Error(`OMP installed dependency version mismatch: ${name}`);
  }
}

async function readyEntrypoint(directory: string, payload: RecipePayload): Promise<string | null> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('OMP runtime cache must be a regular directory');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  // An existing but incomplete/corrupt generation is an error, never an excuse to execute or overwrite it.
  const readyFile = join(directory, 'ready.json');
  if (!(await lstat(readyFile)).isFile()) throw new Error('OMP runtime cache readiness must be a regular file');
  const ready = record(JSON.parse(await readFile(readyFile, 'utf8')), 'runtime cache receipt');
  if (ready.version !== CACHE_VERSION || ready.key !== payload.key || typeof ready.treeHash !== 'string' || !HASH.test(ready.treeHash)) {
    throw new Error('OMP runtime cache receipt mismatch');
  }
  const install = join(directory, 'install');
  if (await installedTreeHash(install) !== ready.treeHash) throw new Error('OMP runtime cache integrity mismatch');
  await validateInstalledInputs(install, payload);
  return join(install, payload.recipe.adapter);
}

async function installPackages(directory: string): Promise<void> {
  // Copy-on-write clones on macOS, independent files elsewhere: Bun's Linux hardlinks would let a
  // changed derived runtime alter the shared package cache and other immutable generations.
  const child = Bun.spawn([
    process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts', '--omit=optional', '--linker=hoisted',
    `--backend=${process.platform === 'darwin' ? 'clonefile' : 'copyfile'}`,
  ], {
    cwd: directory, env: { ...process.env, BUN_BE_BUN: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`OMP runtime dependency install failed (${code}): ${`${stdout}\n${stderr}`.trim()}`);
}

/**
 * Prepare a derived SDK installation, retaining the authenticated recipe as the machine's selection.
 * Upstream feature/model cache paths and Bun's global download cache are deliberately left untouched.
 */
export async function prepareOmpRuntimeArtifact(artifactRoot: string, options: { cacheRoot?: string } = {}): Promise<string> {
  const source = resolve(artifactRoot);
  if (!(await lstat(source)).isDirectory()) throw new Error('OMP artifact must be a regular directory');
  const recipePath = join(source, RECIPE_FILE);
  try {
    if (!(await lstat(recipePath)).isFile()) throw new Error('OMP runtime recipe must be a regular file');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    // Existing authenticated complete artifacts remain valid rollback selections. Do not modify them.
    return join(source, 'omp.js');
  }
  const payload = await loadPayload(source, await readFile(recipePath));
  const cacheRoot = resolve(options.cacheRoot ?? process.env.GITSPACE_OMP_RUNTIME_CACHE ?? join(homedir(), '.cache', 'gitspace', 'omp-runtimes'));
  if (within(source, cacheRoot)) throw new Error('OMP runtime cache must be outside the authenticated artifact');
  const realSource = await realpath(source);
  // Resolve existing ancestors before mkdir: a cache-root symlink must not create directories in a selection.
  let ancestor = cacheRoot;
  for (;;) {
    try {
      if (within(realSource, resolve(await realpath(ancestor), relative(ancestor, cacheRoot)))) {
        throw new Error('OMP runtime cache must be outside the authenticated artifact');
      }
      break;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  if (within(realSource, await realpath(cacheRoot))) throw new Error('OMP runtime cache must be outside the authenticated artifact');
  const directory = join(cacheRoot, payload.key);
  const ready = await readyEntrypoint(directory, payload);
  if (ready) return ready;
  const staged = await mkdtemp(join(cacheRoot, `.${payload.key}.stage-`));
  try {
    const install = join(staged, 'install');
    await mkdir(install, { mode: 0o700 });
    for (const file of payload.files) {
      const path = join(install, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes, { flag: 'wx', mode: file.mode });
      await chmod(path, file.mode);
    }
    await installPackages(install);
    await validateInstalledInputs(install, payload);
    const treeHash = await installedTreeHash(install);
    await writeFile(join(staged, 'ready.json'), JSON.stringify({ version: CACHE_VERSION, key: payload.key, treeHash }), { flag: 'wx', mode: 0o600 });
    try { await rename(staged, directory); }
    catch (error) { if (!hasCode(error, 'EEXIST', 'ENOTEMPTY')) throw error; }
    // A competing publisher may have won. Authenticate that generation rather than trusting its marker.
    const entrypoint = await readyEntrypoint(directory, payload);
    if (!entrypoint) throw new Error('OMP runtime cache publication disappeared');
    return entrypoint;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
