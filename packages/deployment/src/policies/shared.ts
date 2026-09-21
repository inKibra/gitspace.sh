import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import type { DeploymentArtifact, EntrypointId } from '../contracts.js';
import { ReplacementActionError, type ReplacementPhase } from '../engine.js';

async function sortedFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await sortedFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function hashArtifactPath(path: string): Promise<`sha256:${string}`> {
  const metadata = await stat(path);
  const hash = createHash('sha256');
  if (metadata.isDirectory()) {
    for (const file of await sortedFiles(path)) {
      hash.update(relative(path, file));
      hash.update('\0');
      hash.update(await readFile(file));
      hash.update('\0');
    }
  } else {
    hash.update(await readFile(path));
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function verifyArtifact(
  artifact: DeploymentArtifact,
  phase: ReplacementPhase,
): Promise<ResultType<void, ReplacementActionError>> {
  try {
    const actual = await hashArtifactPath(artifact.path);
    return actual === artifact.hash
      ? Result.ok(undefined)
      : Result.err(new ReplacementActionError({
          entrypoint: artifact.entrypoint,
          phase,
          message: `Artifact hash mismatch: expected ${artifact.hash}, received ${actual}`,
        }));
  } catch (error) {
    return Result.err(new ReplacementActionError({
      entrypoint: artifact.entrypoint,
      phase,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function copyArtifact(source: string, destination: string): Promise<void> {
  const metadata = await stat(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: metadata.isDirectory(), force: false, errorOnExist: true });
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${crypto.randomUUID()}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export function actionFailure(
  entrypoint: EntrypointId,
  phase: ReplacementPhase,
  error: unknown,
): ResultType<void, ReplacementActionError> {
  return Result.err(new ReplacementActionError({
    entrypoint,
    phase,
    message: error instanceof Error ? error.message : String(error),
  }));
}
