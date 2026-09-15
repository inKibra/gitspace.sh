import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executableManifestPath, parseExecutableArtifactManifest, validateExecutableArtifact } from '@gitspace/account-omp/manifest';
import { prepareOmpRuntimeArtifact } from '../../account-omp/src/runtime-recipe.js';
import { ompGenerationSelectionSchema, type OmpGenerationSelection } from '../../account-machine/src/omp-runtime.js';

/** Browser-relay and other OMP commands use the same authenticated account selection as agent children. */
async function selectedOmp(): Promise<OmpGenerationSelection> {
  const environmentRoot = process.env.GITSPACE_ENVIRONMENT_ROOT;
  if (environmentRoot) {
    try {
      return ompGenerationSelectionSchema.parse(JSON.parse(await readFile(join(environmentRoot, 'omp-selection.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const path = join(import.meta.dir, 'omp');
  // Replaced by the builder, not supplied by the consumer's environment.
  const manifestHash = process.env.GITSPACE_INITIAL_OMP_MANIFEST_HASH;
  if (!manifestHash) throw new Error('Packaged OMP command launcher has no initial trust anchor');
  const manifest = parseExecutableArtifactManifest(await readFile(executableManifestPath(path)), { target: 'omp', manifestHash });
  return { path, hash: manifest.treeHash, manifestHash, sha: null };
}

const selection = await selectedOmp();
await validateExecutableArtifact(selection.path, { target: 'omp', hash: selection.hash, manifestHash: selection.manifestHash });
const prepared = await prepareOmpRuntimeArtifact(selection.path);
const entrypoint = prepared === join(selection.path, 'omp.js')
  ? join(selection.path, 'omp-worker.js')
  : join(dirname(Bun.resolveSync('@oh-my-pi/pi-coding-agent', dirname(prepared))), 'cli.ts');
const child = Bun.spawn([process.execPath, entrypoint, ...process.argv.slice(2)], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env,
});
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.exitCode = await child.exited;
