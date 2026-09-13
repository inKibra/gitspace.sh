import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExecutableArtifactManifest, executableManifestPath, type ExecutableArtifactManifest } from '@gitspace/account-omp/manifest';
import { workerReleaseMetadataSchema, type OmpReleaseMetadata, type WorkerReleaseMetadata } from '@gitspace/protocol';
import { z } from 'zod';
import { hashArtifactPath } from './policies/shared.js';
import { installedPackageRoot, packageOmpRuntimeRecipe } from './runtime-packaging.js';

/**
 * Builders for the four account-owned GitSpace release targets. The
 * self-develop sandbox and a "launch into" release use the same builders; only
 * the output directory and worker version stamp differ.
 */

export interface BuiltArtifact {
  /** Bundle file or generation directory, plus its content-addressed hash. */
  path: string;
  hash: `sha256:${string}`;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * `git rev-parse HEAD`; a tree with uncommitted changes gets
 * `-dirty.<12 hex>` from sha256 over `git diff HEAD` plus every untracked
 * (non-ignored) file, so two launches of different uncommitted states never
 * share a release key (release objects are immutable).
 */
export async function workspaceSha(root: string): Promise<string> {
  const head = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const sha = (await new Response(head.stdout).text()).trim();
  if (await head.exited !== 0 || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error(`${root} is not a git checkout`);
  const diff = Bun.spawn(['git', 'diff', 'HEAD', '--no-color', '--no-ext-diff'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  // Untracked files only under the source roots: environment sandboxes live untracked in the checkout and would take a minute to walk.
  const untracked = Bun.spawn(['git', 'ls-files', '--others', '--exclude-standard', '-z', '--', 'packages', 'scripts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [changes, others] = await Promise.all([new Response(diff.stdout).arrayBuffer(), new Response(untracked.stdout).text()]);
  await Promise.all([diff.exited, untracked.exited]);
  // Vite drops `vite.config.ts.timestamp-*.mjs` beside the config while a build runs; a concurrent build must not change the fingerprint.
  const paths = others.split('\0').filter((path) => path.length > 0 && !/\.timestamp-[^/]*\.mjs$/u.test(path));
  if (changes.byteLength === 0 && paths.length === 0) return sha;
  const fingerprint = new Bun.CryptoHasher('sha256').update(new Uint8Array(changes));
  for (const path of paths) {
    // Nested checkouts and directory symlinks list as one entry; only regular files carry bytes worth fingerprinting.
    const entry = await lstat(join(root, path)).catch(() => null);
    if (!entry?.isFile()) continue;
    fingerprint.update(`\0${path}\0`).update(new Uint8Array(await Bun.file(join(root, path)).arrayBuffer()));
  }
  return `${sha}-dirty.${fingerprint.digest('hex').slice(0, 12)}`;
}

async function buildWorkerEntrypoint(entrypoint: string, sha: string, outDir: string): Promise<BuiltArtifact> {
  await mkdir(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    outdir: outDir,
    naming: 'worker.mjs',
    external: ['cloudflare:workers'],
    conditions: ['workerd'],
    define: { GITSPACE_WORKER_SHA: JSON.stringify(sha) },
  });
  if (!result.success) throw new AggregateError(result.logs, 'Worker build failed');
  const path = join(outDir, 'worker.mjs');
  return { path, hash: await hashArtifactPath(path) };
}
/** Account tenant Worker bundle stamped with its release sha (`GITSPACE_WORKER_SHA`, served at `/healthz`). */
export function buildWorkerBundle(root: string, sha: string, outDir: string): Promise<BuiltArtifact> {
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

/** Machine-only native/terminal packaging. OMP uses installed upstream SDK sources without loader overrides. */
function machinePackagingPlugin(): Bun.BunPlugin {
  return {
    name: 'gitspace-machine-packaging',
    setup(build) {
        build.onResolve({ filter: /^omp-legacy-pi-modules$/u }, () => {
          throw new Error('Machine executable cannot include OMP extension execution');
        });
        build.onLoad({ filter: /[/\\]pi-coding-agent[/\\]src[/\\](?:sdk\.ts|session[/\\]agent-session\.ts)$/u }, ({ path }) => {
          throw new Error(`Machine executable cannot include OMP agent execution: ${path}`);
        });
      build.onLoad({ filter: /[/\\]pi-natives[/\\]native[/\\]loader-state\.js$/u }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const original = 'const ctx = initLoaderContext();';
        if (!source.includes(original)) throw new Error('Unsupported pi-natives loader contract');
        return {
          loader: 'js',
          contents: source.replace('cleanupStaleNativeVersions({ nativesDir: ctx.nativesDir, currentVersion: ctx.packageVersion });', '').replace(original, `const ctx = initLoaderContext({ nativeDir: import.meta.dir, leafPackageDir: null, isCompiledBinary: false });
  ctx.candidates = ctx.addonFilenames.map(filename => path.join(import.meta.dir, filename));
  ctx.isWorkspaceLoad = false;
  ctx.stageFromNodeModules = false;`),
        };
      });
      build.onLoad({ filter: /[/\\]pi-utils[/\\]src[/\\]worker-host\.ts$/u }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const original = 'stripWindowsExtendedLengthPathPrefix(Bun.main)';
        const initial = 'let workerHostMain: string | null = null;';
        if (!source.includes(original) || !source.includes(initial)) throw new Error('Unsupported OMP worker-host contract');
        const workerPath = "stripWindowsExtendedLengthPathPrefix(gitspaceFileURLToPath(new URL('./machine-worker.js', import.meta.url)))";
        return {
          loader: 'ts',
          contents: `import { fileURLToPath as gitspaceFileURLToPath } from 'node:url';\n${source.replace(original, workerPath).replace(initial, `let workerHostMain: string | null = ${workerPath};`)}`,
        };
      });
    },
  };
}

async function copyNativeRuntime(root: string, outDir: string): Promise<void> {
  const packageRoot = await installedPackageRoot('@oh-my-pi/pi-natives', root);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string; optionalDependencies: Record<string, string>;
  };
  const tag = `${process.platform}-${process.arch}`;
  const name = `@oh-my-pi/pi-natives-${tag}`;
  const leafRoot = await installedPackageRoot(name, packageRoot);
  const leaf = JSON.parse(await readFile(join(leafRoot, 'package.json'), 'utf8')) as {
    version: string; os: string[]; cpu: string[];
  };
  if (leaf.version !== manifest.version || manifest.optionalDependencies[name] !== leaf.version
    || !leaf.os.includes(process.platform) || !leaf.cpu.includes(process.arch)) {
    throw new Error(`Installed native addon ${name} is incompatible with pi-natives ${manifest.version}`);
  }
  // Baseline is required on x64; include AVX2 when upstream ships a second variant.
  const installed = await readdir(leafRoot);
  const filenames = process.arch === 'x64'
    ? [`pi_natives.${tag}-baseline.node`]
    : [`pi_natives.${tag}.node`];
  if (process.arch === 'x64' && installed.includes(`pi_natives.${tag}-modern.node`)) filenames.push(`pi_natives.${tag}-modern.node`);
  for (const filename of filenames) {
    if (!installed.includes(filename) || !(await lstat(join(leafRoot, filename))).isFile()) {
      throw new Error(`Installed native addon ${name} is missing ${filename}`);
    }
    await cp(join(leafRoot, filename), join(outDir, filename));
    if (process.platform === 'linux') {
      // Published Linux addons contain debug sections larger than a Worker request body.
      // Strip only the staged copy; the N-API code/symbols and installed package stay unchanged.
      const strip = Bun.spawn(['strip', '--strip-debug', join(outDir, filename)], { stdout: 'ignore', stderr: 'pipe' });
      const error = await new Response(strip.stderr).text();
      if (await strip.exited !== 0) throw new Error(`Cannot strip staged native addon ${filename}: ${error}`);
    }
  }
}

async function prepareExecutableOutput(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length !== 0 || await Bun.file(executableManifestPath(outDir)).exists()) {
    throw new Error(`Executable output must be a new empty directory: ${outDir}`);
  }
}

/** Independently complete machine generation, including authenticated migrations and native runtime. */
export async function buildMachineBundle(root: string, outDir: string): Promise<BuiltExecutableArtifact> {
  await prepareExecutableOutput(outDir);
  const entrypoints = [
    [join(root, 'packages/account-machine/src/runtime.ts'), 'machine'],
    [join(root, 'packages/account-machine/src/terminal-worker.ts'), 'machine-worker'],
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
  const nativeOwner = await installedPackageRoot('@oh-my-pi/pi-coding-agent', join(root, 'packages/account-machine'));
  await copyNativeRuntime(nativeOwner, outDir);
  await cp(join(root, 'packages/core/drizzle'), join(outDir, 'drizzle'), { recursive: true });
  const envelope = await createExecutableArtifactManifest(outDir, 'machine');
  return { path: outDir, hash: envelope.manifest.treeHash, ...envelope };
}


export interface BuiltOmpArtifact extends BuiltExecutableArtifact {
  metadata: OmpReleaseMetadata;
}

/** Authenticate a small GitSpace adapter and exact upstream dependency recipe, not an eagerly bundled SDK graph. */
export async function buildOmpBundle(root: string, outDir: string): Promise<BuiltOmpArtifact> {
  await prepareExecutableOutput(outDir);
  const metadata = await packageOmpRuntimeRecipe(root, outDir);
  for (const [source, name] of [['runtime', 'omp-adapter'], ['recipe-bootstrap', 'omp']] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, `packages/account-omp/src/${source}.ts`)],
      target: 'bun',
      outdir: outDir,
      naming: `${name}.js`,
      // SDK modules must execute from their complete patched npm sources, including workers, assets and lazy installers.
      external: ['@oh-my-pi/*'],
    });
    if (!result.success) throw new AggregateError(result.logs, `OMP ${name} build failed`);
  }
  const envelope = await createExecutableArtifactManifest(outDir, 'omp', metadata);
  return { path: outDir, hash: envelope.manifest.treeHash, ...envelope, metadata };
}

/** Bootstrap a host with independently versioned machine and OMP payloads and an embedded initial trust anchor. */
export async function buildInitialRuntime(root: string, outDir: string): Promise<{ machine: BuiltExecutableArtifact; omp: BuiltOmpArtifact }> {
  const machine = await buildMachineBundle(root, join(outDir, 'machine'));
  const omp = await buildOmpBundle(root, join(outDir, 'omp'));
  for (const [source, name] of [['host', 'host-runtime'], ['rpc-probe', 'rpc-probe']] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, `packages/account-machine/src/${source}.ts`)],
      target: 'bun', outdir: outDir, naming: `${name}.js`, sourcemap: 'linked',
    });
    if (!result.success) throw new AggregateError(result.logs, 'Machine host build failed');
  }
  const launcher = await Bun.build({
    entrypoints: [join(root, 'packages/deployment/src/omp-launcher.ts')],
    target: 'bun', outdir: outDir, naming: 'omp-launcher.js',
    define: { 'process.env.GITSPACE_INITIAL_OMP_MANIFEST_HASH': JSON.stringify(omp.manifestHash) },
  });
  if (!launcher.success) throw new AggregateError(launcher.logs, 'Selected OMP command launcher build failed');
  await writeFile(join(outDir, 'host.js'), [
    "import { fileURLToPath } from 'node:url';",
    "process.env.GITSPACE_OMP_RUNTIME_PATH = fileURLToPath(new URL('./omp/omp.js', import.meta.url));",
    `process.env.GITSPACE_OMP_MANIFEST_HASH = ${JSON.stringify(omp.manifestHash)};`,
    "// The initial trust environment must be set before the host module evaluates.",
    "await import('./host-runtime.js');",
    '',
  ].join('\n'));
  return { machine, omp };
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
  migrations: z.array(z.object({ tag: z.string(), new_sqlite_classes: z.array(z.string()).default([]) })).default([]),
});

/** Provider upload requirements declared by the account application. */
export async function workerMetadataFromWrangler(root: string): Promise<WorkerReleaseMetadata> {
  const source = await readFile(join(root, 'packages/account-worker/wrangler.jsonc'), 'utf8');
  const config = wranglerSchema.parse(JSON.parse(stripJsonComments(source)));
  const resources: unknown = JSON.parse(await readFile(join(root, 'packages/account-worker/worker-bindings.json'), 'utf8'));
  return workerReleaseMetadataSchema.parse({
    mainModule: 'worker.mjs',
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    durableObjects: config.durable_objects.bindings.map((binding) => ({ name: binding.name, className: binding.class_name })),
    resources,
    migrations: config.migrations.map((migration) => ({ tag: migration.tag, newSqliteClasses: migration.new_sqlite_classes })),
  });
}
