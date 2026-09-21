import { cp, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface BootstrapMigrationInput {
  bundleRoot: string;
  environmentRoot: string;
  candidatePath: string;
  initialMachineManifestHash: string;
  initialOmpManifestHash: string;
}
interface BootstrapMigration {
  version: 1;
  phase: 'prepared' | 'committed' | 'rolled-back';
  target: string;
  original: string;
  candidatePath: string;
  replacement: string;
  mode: number;
  runtime: string;
}
async function optionalRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.next-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function linkImmutableTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: (await lstat(source)).mode & 0o777 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await linkImmutableTree(from, to);
    } else if (entry.isFile()) {
      try {
        await link(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await cp(from, to, { preserveTimestamps: true });
      }
    } else if (entry.isSymbolicLink()) {
      await cp(from, to, { verbatimSymlinks: true });
    } else {
      throw new Error('Initial runtime contains a special file');
    }
  }
}

/** Preflight the one-time transition without modifying an authenticated distribution tree.
 * The private intent survives updater interruption; commit and rollback are idempotent.
 */
export async function prepareBootstrapMigration(
  input: BootstrapMigrationInput,
): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }> {
  const root = resolve(input.environmentRoot);
  const bundle = resolve(input.bundleRoot);
  const intentPath = join(root, 'bootstrap-migration.json');
  const previous = await optionalRead(intentPath);
  let intent: BootstrapMigration | null = previous ? (JSON.parse(previous) as BootstrapMigration) : null;
  if (intent && (intent.version !== 1 || !['prepared', 'committed', 'rolled-back'].includes(intent.phase))) {
    throw new Error('Unsupported bootstrap migration intent');
  }
  // A prior release's completed migration is stable across subsequent machine releases.
  if (intent?.phase === 'committed' && intent.candidatePath !== input.candidatePath)
    return { async commit() {}, async rollback() {} };
  if (!intent || intent.phase === 'rolled-back') {
    for (const hash of [input.initialMachineManifestHash, input.initialOmpManifestHash]) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(hash))
        throw new Error('Bootstrap migration requires authenticated initial manifest anchors');
    }
    const distribution = await optionalRead(join(bundle, 'distribution-manifest.json'));
    const selectionPath = join(dirname(root), 'runtime-selection.json');
    const nativeSelection = await optionalRead(selectionPath);
    if (nativeSelection !== null) {
      const selected = JSON.parse(nativeSelection) as { path?: string };
      if (!selected.path || resolve(selected.path) !== bundle)
        throw new Error('Native runtime selection changed before bootstrap migration');
    } else if (distribution !== null) {
      throw new Error('Immutable distribution has no native runtime selection to migrate');
    }
    const runtime = join(root, 'bootstrap-runtimes', crypto.randomUUID());
    const staging = `${runtime}.staging`;
    await mkdir(dirname(runtime), { recursive: true, mode: 0o700 });
    try {
      // Native installs retain their private Bun and independently selected OMP recipe.
      // Provider bootstubs have no native runtime selection and need only the stable loader.
      if (nativeSelection !== null) {
        await linkImmutableTree(bundle, staging);
        // This is a derived bootstrap, never an immutable public channel installation.
        await rm(join(staging, 'distribution-manifest.json'), { force: true });
      } else {
        await mkdir(staging, { mode: 0o700 });
      }
      // Unlink replacement files first: all other immutable payloads share their original inodes.
      await rm(join(staging, 'machine-bootstrap.js'), { force: true });
      await cp(join(input.candidatePath, 'machine-bootstrap.js'), join(staging, 'machine-bootstrap.js'));
      const bootstrap = [
        `process.env.GITSPACE_BUNDLE_ROOT = ${JSON.stringify(bundle)};`,
        `process.env.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH = ${JSON.stringify(input.initialMachineManifestHash)};`,
        `process.env.GITSPACE_INITIAL_OMP_MANIFEST_HASH = ${JSON.stringify(input.initialOmpManifestHash)};`,
        `const { startMachineHost } = await import(${JSON.stringify(pathToFileURL(join(runtime, 'machine-bootstrap.js')).href)});`,
        'await startMachineHost();',
        '',
      ].join('\n');
      let target: string;
      let original: string;
      let replacement: string;
      let mode: number;
      if (nativeSelection !== null) {
        target = selectionPath;
        original = nativeSelection;
        replacement = JSON.stringify({ path: runtime });
        mode = 0o600;
        await rm(join(staging, 'host.js'), { force: true });
        await writeFile(join(staging, 'host.js'), bootstrap, { mode: 0o644 });
      } else {
        target = join(bundle, 'host.js');
        const entry = await lstat(target);
        if (!entry.isFile()) throw new Error('Provider bootstrap must be a regular file');
        original = await readFile(target, 'utf8');
        replacement = bootstrap;
        mode = entry.mode & 0o777;
      }
      // Prove the target directory permits atomic replacement before retiring a host.
      const probe = `${target}.preflight-${crypto.randomUUID()}`;
      try {
        await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      } finally {
        await rm(probe, { force: true });
      }
      await rename(staging, runtime);
      intent = {
        version: 1,
        phase: 'prepared',
        target,
        original,
        replacement,
        mode,
        runtime,
        candidatePath: input.candidatePath,
      };
      await atomicWrite(intentPath, JSON.stringify(intent), 0o600);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const migration = intent;
  const replace = async (expected: string, next: string, phase: BootstrapMigration['phase']): Promise<void> => {
    const current = await readFile(migration.target, 'utf8');
    if (current !== expected && current !== next)
      throw new Error('Bootstrap target changed outside the machine update');
    if (current !== next) await atomicWrite(migration.target, next, migration.mode);
    migration.phase = phase;
    await atomicWrite(intentPath, JSON.stringify(migration), 0o600);
  };
  return {
    commit: () => replace(migration.original, migration.replacement, 'committed'),
    rollback: () => replace(migration.replacement, migration.original, 'rolled-back'),
  };
}
