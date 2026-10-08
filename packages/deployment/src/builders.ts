import { cp, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createExecutableArtifactManifest, executableManifestPath, type ExecutableArtifactManifest } from './executable-manifest.js';
import { workerReleaseMetadataSchema, type WorkerReleaseMetadata } from '@gitspace/protocol';
import { z } from 'zod';
import { hashArtifactPath } from './policies/shared.js';
import { packageMachineNativeRuntime } from './native-build.js';
import { encodeWorkerBundle, type WorkerModule } from '@gitspace/protocol/worker-bundle';

/**
 * Builders for the three account-owned GitSpace release targets. The
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
      name: 'static-worker-wasm',
      setup(build) {
        build.onResolve({ filter: /\.wasm$/u }, async args => {
          const source = resolve(dirname(args.importer), args.path);
          const content = new Uint8Array(await Bun.file(source).arrayBuffer());
          const name = basename(args.path);
          if (args.path !== name && args.path !== `./${name}`) throw new Error(`Worker WASM imports must use a sibling module name: ${args.path}`);
          const previous = modules.get(name);
          if (previous && !Buffer.from(previous.content).equals(content)) throw new Error(`Conflicting worker WASM module name: ${name}`);
          modules.set(name, { name, type: 'wasm', content });
          await Bun.write(join(outDir, name), content);
          return { path: `./${name}`, external: true };
        });
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Worker build failed');
  const entry = new Uint8Array(await Bun.file(join(outDir, 'worker.mjs')).arrayBuffer());
  const path = join(outDir, 'worker.bundle.json');
  await Bun.write(path, encodeWorkerBundle([{ name: 'worker.mjs', type: 'esm', content: entry }, ...[...modules.values()].sort((a, b) => a.name.localeCompare(b.name))]));
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

/** Independently complete machine generation, including authenticated migrations and native runtime. */
export async function buildMachineBundle(root: string, outDir: string): Promise<BuiltExecutableArtifact> {
  await prepareExecutableOutput(outDir);
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
  await cp(join(root, 'packages/core/drizzle'), join(outDir, 'drizzle'), { recursive: true });
  const native = await packageMachineNativeRuntime(root, outDir);
  const envelope = await createExecutableArtifactManifest(outDir, 'machine', native.abi);
  return { path: outDir, hash: envelope.manifest.treeHash, ...envelope };
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
