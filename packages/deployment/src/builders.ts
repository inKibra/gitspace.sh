import { cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { workerReleaseMetadataSchema, type WorkerReleaseMetadata } from '@gitspace/protocol';
import { z } from 'zod';
import { hashArtifactPath } from './policies/shared.js';

/**
 * Builders for the three GitSpace bundles. The self-develop sandbox and a
 * "launch into" release build the same way; only the output directory and the
 * worker version stamp differ.
 */

export interface BuiltArtifact {
  /** The bundle file for the worker; the directory holding `machine.js` + `drizzle/` or the frontend tree otherwise. */
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

/** Tenant worker bundle stamped with its release sha (`GITSPACE_WORKER_SHA`, served at `/healthz`). */
export async function buildWorkerBundle(root: string, sha: string, outDir: string): Promise<BuiltArtifact> {
  await mkdir(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, 'packages/auth-worker/src/index.ts')],
    target: 'browser',
    outdir: outDir,
    naming: 'worker.mjs',
    external: ['cloudflare:workers'],
    define: { GITSPACE_WORKER_SHA: JSON.stringify(sha) },
  });
  if (!result.success) throw new AggregateError(result.logs, 'Control Worker build failed');
  const path = join(outDir, 'worker.mjs');
  return { path, hash: await hashArtifactPath(path) };
}

/** Machine daemon bundle plus the drizzle migrations it runs at start; `outDir` becomes the generation artifact. */
export async function buildMachineBundle(root: string, outDir: string): Promise<BuiltArtifact> {
  await mkdir(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, 'packages/machine/src/runtime.ts')],
    target: 'bun',
    outdir: outDir,
    naming: 'machine.js',
    external: ['@oh-my-pi/*', '@noble/*'],
    sourcemap: 'linked',
  });
  if (!result.success) throw new AggregateError(result.logs, 'Machine build failed');
  await cp(join(root, 'packages/core/drizzle'), join(outDir, 'drizzle'), { recursive: true });
  return { path: outDir, hash: await hashArtifactPath(outDir) };
}

/** Vite build of `packages/web` copied into `outDir`. */
export async function buildFrontendTree(root: string, outDir: string): Promise<BuiltArtifact> {
  const build = Bun.spawn(['bun', 'run', 'build'], {
    cwd: join(root, 'packages/web'),
    env: processEnvironment(),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (await build.exited !== 0) throw new Error('Frontend build failed');
  await rm(outDir, { recursive: true, force: true });
  await cp(join(root, 'packages/web/dist'), outDir, { recursive: true });
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

/** Upload metadata for the tenant worker, read from the workspace's `packages/auth-worker/wrangler.jsonc`. */
export async function workerMetadataFromWrangler(root: string): Promise<WorkerReleaseMetadata> {
  const source = await readFile(join(root, 'packages/auth-worker/wrangler.jsonc'), 'utf8');
  const config = wranglerSchema.parse(JSON.parse(stripJsonComments(source)));
  return workerReleaseMetadataSchema.parse({
    mainModule: 'worker.mjs',
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    durableObjects: config.durable_objects.bindings.map((binding) => ({ name: binding.name, className: binding.class_name })),
    migrations: config.migrations.map((migration) => ({ tag: migration.tag, newSqliteClasses: migration.new_sqlite_classes })),
  });
}
