import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { createExecutableArtifactManifest, executableManifestPath, type ExecutableArtifactManifest } from './executable-manifest.js';
import { WORKER_MANIFEST_FILE, resourceSourceSchema, workerReleaseMetadataSchema, type WorkerReleaseMetadata } from '@gitspace/protocol';
import { z } from 'zod';
import { hashArtifactPath } from './policies/shared.js';
import { packageMachineNativeRuntime } from './native-build.js';
import { nativeFileDigest } from './native-runtime.js';
import { BUN_VERSION, NATIVE_PINS } from './native-pins.js';
import { PORTABLE_MANIFEST_FILE, portableManifestSchema, type PortableFile } from '@gitspace/protocol/machine-release';
import { createWorkerManifest, type WorkerModule } from '@gitspace/protocol/worker-bundle';
import { writeBrowserRunner } from '@gitspace/browser-runner';
import { writeInferenceWorker } from '@gitspace/inference-worker';

/**
 * Builders for the three account-owned GitSpace release targets. The
 * self-develop sandbox and a "launch into" release use the same builders; only
 * the output directory and worker version stamp differ.
 */

export interface BuiltArtifact {
  /** Worker manifest (its modules beside it, by name), generation directory or frontend tree, plus its content-addressed hash. */
  path: string;
  hash: `sha256:${string}`;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * A checkout's release identity. `commit` is `git rev-parse HEAD`; `key` is that commit, or for a tree with
 * uncommitted changes `<commit>-dirty.<12 hex>` from sha256 over `git diff HEAD` plus every untracked (non-ignored)
 * file, so two launches of different uncommitted states never share a release key (release objects are immutable).
 * `uncommittedFiles` counts changed tracked paths and untracked source files.
 */
export async function workspaceRevision(root: string): Promise<{ key: string; commit: string; uncommittedFiles: number }> {
  const head = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const sha = (await new Response(head.stdout).text()).trim();
  if (await head.exited !== 0 || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error(`${root} is not a git checkout`);
  const diff = Bun.spawn(['git', 'diff', 'HEAD', '--no-color', '--no-ext-diff'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const changed = Bun.spawn(['git', 'diff', 'HEAD', '--name-only', '-z'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  // Untracked files only under the source roots: environment sandboxes live untracked in the checkout and would take a minute to walk.
  const untracked = Bun.spawn(['git', 'ls-files', '--others', '--exclude-standard', '-z', '--', 'packages', 'scripts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [changes, changedPaths, others] = await Promise.all([new Response(diff.stdout).arrayBuffer(), new Response(changed.stdout).text(), new Response(untracked.stdout).text()]);
  await Promise.all([diff.exited, changed.exited, untracked.exited]);
  // Vite drops `vite.config.ts.timestamp-*.mjs` beside the config while a build runs; a concurrent build must not change the fingerprint.
  const paths = others.split('\0').filter((path) => path.length > 0 && !/\.timestamp-[^/]*\.mjs$/u.test(path));
  const uncommittedFiles = changedPaths.split('\0').filter(path => path.length > 0).length + paths.length;
  if (changes.byteLength === 0 && paths.length === 0) return { key: sha, commit: sha, uncommittedFiles: 0 };
  const fingerprint = new Bun.CryptoHasher('sha256').update(new Uint8Array(changes));
  for (const path of paths) {
    // Nested checkouts and directory symlinks list as one entry; only regular files carry bytes worth fingerprinting.
    const entry = await lstat(join(root, path)).catch(() => null);
    if (!entry?.isFile()) continue;
    fingerprint.update(`\0${path}\0`).update(new Uint8Array(await Bun.file(join(root, path)).arrayBuffer()));
  }
  return { key: `${sha}-dirty.${fingerprint.digest('hex').slice(0, 12)}`, commit: sha, uncommittedFiles };
}

async function buildWorkerEntrypoint(entrypoint: string, sha: string, outDir: string): Promise<BuiltArtifact> {
  await mkdir(outDir, { recursive: true });
  const modules = new Map<string, WorkerModule>();
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    outdir: outDir,
    naming: 'worker.mjs',
    external: ['cloudflare:workers', 'node:*'],
    // CommonJS dependencies (memfs) call require('node:*'); workerd ESM has no global require and no import.meta.url,
    // so supply nodejs_compat's require anchored at the bundle root.
    banner: "import { createRequire as __gitspaceCreateRequire } from 'node:module';\nconst require = __gitspaceCreateRequire('/worker.mjs');",
    conditions: ['workerd'],
    define: { GITSPACE_WORKER_SHA: JSON.stringify(sha) },
    plugins: [{
      name: 'worker-runtime-modules',
      setup(build) {
        build.onResolve({ filter: new RegExp(`^(?:${builtinModules.filter(name => !name.startsWith('node:')).join('|')})$`, 'u') }, args => ({
          path: `node:${args.path}`, external: true,
        }));
        // Each imported .wasm file is uploaded as a precompiled module named by its file name. Bun keeps an external's
        // original specifier, so a package's .wasm is reached through a one-line module beside it that imports `./name`.
        build.onResolve({ filter: /\.wasm$/u }, async args => {
          if (!args.path.startsWith('.')) return { path: Bun.resolveSync(args.path, dirname(args.importer)), namespace: 'worker-wasm' };
          const source = resolve(dirname(args.importer), args.path);
          const content = new Uint8Array(await Bun.file(source).arrayBuffer());
          const name = basename(source);
          const previous = modules.get(name);
          if (previous && !Buffer.from(previous.content).equals(content)) throw new Error(`Conflicting worker WASM module name: ${name}`);
          modules.set(name, { name, type: 'wasm', content });
          await Bun.write(join(outDir, name), content);
          return { path: `./${name}`, external: true };
        });
        build.onLoad({ filter: /.*/u, namespace: 'worker-wasm' }, args => ({ contents: `export { default } from ${JSON.stringify(`./${basename(args.path)}`)};`, resolveDir: dirname(args.path), loader: 'js' }));
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Worker build failed');
  const entry: WorkerModule = { name: 'worker.mjs', type: 'esm', content: new Uint8Array(await Bun.file(join(outDir, 'worker.mjs')).arrayBuffer()) };
  // Each module stays its own file beside the manifest, so nothing downstream re-encodes or holds the release as one blob.
  const path = join(outDir, WORKER_MANIFEST_FILE);
  await Bun.write(path, JSON.stringify(createWorkerManifest(entry.name, [entry, ...[...modules.values()].sort((a, b) => a.name.localeCompare(b.name))])));
  return { path, hash: await hashArtifactPath(path) };
}
/** Account tenant Worker release stamped with its release sha (`GITSPACE_WORKER_SHA`, served at `/healthz`). */
export async function buildWorkerRelease(root: string, sha: string, outDir: string): Promise<BuiltArtifact> {
  // Generated for each build, never committed: the browser runner module the session object loads for scripts.
  await writeBrowserRunner(join(root, 'packages/account-worker/src/generated/browser-runner.js'));
  // The inference worker the workspace objects load for model requests (packages/inference-worker).
  await writeInferenceWorker(join(root, 'packages/account-worker/src/generated/inference-worker.js'));
  return buildWorkerEntrypoint(join(root, 'packages/account-worker/src/index.ts'), sha, outDir);
}

/** Stable operator control Worker used by the local self-development stack. */
export function buildControlWorkerBundle(root: string, sha: string, outDir: string): Promise<BuiltArtifact> {
  return buildWorkerEntrypoint(join(root, 'packages/operator-worker/src/index.ts'), sha, outDir);
}

export interface BuiltExecutableArtifact extends BuiltArtifact {
  manifest: ExecutableArtifactManifest;
  /** Digest of `<path>.manifest.json`, distinct from the payload tree hash. */
  manifestHash: `sha256:${string}`;
}

/** Reject accidental machine-side inference/runtime dependencies at the bundle boundary. */
function machinePackagingPlugin(): Bun.BunPlugin {
  return {
    name: 'gitspace-machine-packaging',
    setup(build) {
      build.onResolve({ filter: /^(?:@oh-my-pi\/|omp-legacy-pi-modules$)/u }, ({ path }) => {
        throw new Error(`Machine executable cannot include OMP runtime dependencies: ${path}`);
      });
    },
  };
}

async function prepareExecutableOutput(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length !== 0 || await Bun.file(executableManifestPath(outDir)).exists()) {
    throw new Error(`Executable output must be a new empty directory: ${outDir}`);
  }
}

/** The machine host, its workers and its updater: JavaScript that is the same on every platform. */
async function buildMachineJavaScript(root: string, outDir: string): Promise<void> {
  const entrypoints = [
    [join(root, 'packages/account-machine/src/runtime.ts'), 'machine'],
    [join(root, 'packages/account-machine/src/terminal-worker.ts'), 'machine-worker'],
    [join(root, 'packages/account-machine/src/host.ts'), 'host-runtime'],
    [join(root, 'packages/account-machine/src/machine-update.ts'), 'machine-update'],
    [join(root, 'packages/account-machine/src/machine-bootstrap.ts'), 'machine-bootstrap'],
  ] as const;
  for (const [entrypoint, name] of entrypoints) {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'bun',
      outdir: outDir,
      naming: { entry: `${name}.js`, asset: '[name]-[hash].[ext]' },
      plugins: [machinePackagingPlugin()],
      sourcemap: 'linked',
    });
    if (!result.success) throw new AggregateError(result.logs, 'Machine executable build failed');
  }
}

/** Independently complete machine generation, including authenticated migrations and native runtime. */
export async function buildMachineBundle(root: string, outDir: string): Promise<BuiltExecutableArtifact> {
  await prepareExecutableOutput(outDir);
  await buildMachineJavaScript(root, outDir);
  const native = await packageMachineNativeRuntime(root, outDir);
  const envelope = await createExecutableArtifactManifest(outDir, 'machine', native.abi);
  return { path: outDir, hash: envelope.manifest.treeHash, ...envelope };
}

async function portableInventory(root: string, directory = root): Promise<PortableFile[]> {
  const files: PortableFile[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await portableInventory(root, path));
    else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), ...await nativeFileDigest(path) });
    else throw new Error(`Portable release contains a link or special file: ${path}`);
  }
  return files;
}

/**
 * The portable machine release, the same for every platform: the machine and CLI JavaScript, and a manifest naming
 * them and each platform's pinned natives. Writes `<outDir>/portable.manifest.json` and the files it names under
 * `<outDir>/portable/`; returns the manifest.
 */
export async function buildPortableRelease(root: string, outDir: string): Promise<BuiltArtifact> {
  if (Bun.version !== BUN_VERSION) throw new Error(`The portable release runs on Bun ${BUN_VERSION} and must be built by it, not ${Bun.version}`);
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length !== 0) throw new Error(`Portable release output must be a new empty directory: ${outDir}`);
  const files = join(outDir, 'portable');
  await buildMachineJavaScript(root, join(files, 'machine'));
  const cli = await Bun.build({
    entrypoints: [join(root, 'packages/cli/src/index.ts')], target: 'bun', outdir: join(files, 'cli'),
    naming: { entry: 'gitspace.js', asset: '[name]-[hash].[ext]' }, minify: true,
  });
  if (!cli.success) throw new AggregateError(cli.logs, 'CLI build failed');
  const manifest = portableManifestSchema.parse({ schemaVersion: 1, bunVersion: BUN_VERSION, files: await portableInventory(files), natives: NATIVE_PINS });
  const path = join(outDir, PORTABLE_MANIFEST_FILE);
  await writeFile(path, JSON.stringify(manifest), { flag: 'wx' });
  return { path, hash: `sha256:${(await nativeFileDigest(path)).sha256}` };
}


/** Bootstrap a complete machine host with an embedded initial trust anchor. */
export async function buildInitialRuntime(root: string, outDir: string): Promise<{ machine: BuiltExecutableArtifact }> {
  const machine = await buildMachineBundle(root, join(outDir, 'machine'));
  for (const [source, name] of [['machine-bootstrap', 'host'], ['rpc-probe', 'rpc-probe']] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, `packages/account-machine/src/${source}.ts`)],
      target: 'bun', outdir: outDir, naming: `${name}.js`, sourcemap: 'linked',
      define: {
        'process.env.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH': JSON.stringify(machine.manifestHash),
      },
    });
    if (!result.success) throw new AggregateError(result.logs, 'Machine host build failed');
  }
  return { machine };
}

/** Vite build of the account-owned browser copied into `outDir`. */
export async function buildFrontendTree(root: string, outDir: string): Promise<BuiltArtifact> {
  const build = Bun.spawn(['bun', 'run', 'build'], {
    cwd: join(root, 'packages/account-web'),
    env: processEnvironment(),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (await build.exited !== 0) throw new Error('Account frontend build failed');
  await rm(outDir, { recursive: true, force: true });
  await cp(join(root, 'packages/account-web/dist'), outDir, { recursive: true });
  return { path: outDir, hash: await hashArtifactPath(outDir) };
}

/** Drops `//` and `/* *\/` comments outside string literals, then trailing commas, so wrangler's JSONC parses as JSON. */
export function stripJsonComments(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') end += 1;
        end += 1;
      }
      output += source.slice(index, end + 1);
      index = end + 1;
    } else if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      output += character;
      index += 1;
    }
  }
  return output.replace(/,(\s*[}\]])/gu, '$1');
}

const wranglerSchema = z.object({
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()).default([]),
  durable_objects: z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })).default([]) }).default({ bindings: [] }),
  migrations: z.array(z.object({ tag: z.string(), new_sqlite_classes: z.array(z.string()).default([]), deleted_classes: z.array(z.string()).default([]) })).default([]),
});

/** Provider upload requirements declared by the account application. */
export async function workerMetadataFromWrangler(root: string): Promise<WorkerReleaseMetadata> {
  const source = await readFile(join(root, 'packages/account-worker/wrangler.jsonc'), 'utf8');
  const config = wranglerSchema.parse(JSON.parse(stripJsonComments(source)));
  // A release names only sources this code binds; deployers skip ones they do not know, so a typo is caught here.
  const resources = z.array(z.object({ source: resourceSourceSchema }).passthrough()).parse(JSON.parse(await readFile(join(root, 'packages/account-worker/worker-bindings.json'), 'utf8')));
  return workerReleaseMetadataSchema.parse({
    mainModule: 'worker.mjs',
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    durableObjects: config.durable_objects.bindings.map((binding) => ({ name: binding.name, className: binding.class_name })),
    resources,
    migrations: config.migrations.map((migration) => ({ tag: migration.tag, newSqliteClasses: migration.new_sqlite_classes, deletedClasses: migration.deleted_classes })),
  });
}
