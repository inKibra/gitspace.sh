import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  EXECUTABLE_CHUNK_BYTES,
  executableArtifactManifestSchema,
  ompReleaseMetadataSchema,
  type ExecutableArtifactManifest,
  type OmpReleaseMetadata,
} from '@gitspace/protocol/deployment';

export { executableArtifactManifestSchema, type ExecutableArtifactManifest };

interface PackageManifest {
  dependencies?: Record<string, string>;
  gitspaceOmpPatches?: Record<string, string>;
}

export function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

/** Exact dependency and patch envelope compiled into an immutable OMP release. */
export async function readOmpReleaseMetadata(root: string): Promise<OmpReleaseMetadata> {
  const packageRoot = join(root, 'packages/account-omp');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;
  const packages = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {})
      .filter(([name]) => name.startsWith('@oh-my-pi/'))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const patches = await Promise.all(
    Object.values(manifest.gitspaceOmpPatches ?? {}).sort().map(async (path) => ({
      path: `packages/account-omp/${path}`,
      hash: sha256(new Uint8Array(await readFile(join(packageRoot, path)))),
    })),
  );
  return ompReleaseMetadataSchema.parse({
    upstreamVersion: packages['@oh-my-pi/pi-coding-agent'],
    bunVersion: Bun.version,
    packages,
    patches,
  });
}

/** Sidecar is outside the payload tree so its tree digest is not self-referential. */
export function executableManifestPath(path: string): string {
  return `${path}.manifest.json`;
}

export function executableArtifactCompatibility(): ExecutableArtifactManifest['compatibility'] {
  return executableArtifactManifestSchema.shape.compatibility.parse({
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    protocolVersion: 1,
  });
}

export function validateExecutableCompatibility(manifest: ExecutableArtifactManifest): void {
  const host = executableArtifactCompatibility();
  for (const field of ['platform', 'arch', 'bunVersion', 'protocolVersion'] as const) {
    if (manifest.compatibility[field] !== host[field]) {
      throw new Error(`Executable ${field} ${manifest.compatibility[field]} is incompatible with host ${host[field]}`);
    }
  }
}

/** Reject links and special files rather than hashing a different tree from the one Bun loads. */
async function executableFiles(root: string, directory = root): Promise<string[]> {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Executable artifact is not a directory: ${directory}`);
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await executableFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error(`Executable artifact contains a non-regular file: ${path}`);
  }
  return files;
}

/** Bounded-memory payload reader. Consumers must finish using each chunk before advancing the iterator. */
export async function* readExecutableFile(path: string): AsyncGenerator<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.allocUnsafe(Math.min(size, EXECUTABLE_CHUNK_BYTES));
    for (let offset = 0; offset < size || offset === 0; offset += buffer.byteLength) {
      const length = Math.min(buffer.byteLength, size - offset);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, offset + read);
        if (result.bytesRead === 0) throw new Error(`Executable file changed while reading: ${path}`);
        read += result.bytesRead;
      }
      yield buffer.subarray(0, length);
      if (size === 0) break;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, size);
    if (extra.bytesRead !== 0) throw new Error(`Executable file grew while reading: ${path}`);
  } finally {
    await handle.close();
  }
}

export async function createExecutableArtifactManifest(
  path: string,
  target: ExecutableArtifactManifest['target'],
  omp: OmpReleaseMetadata | null = null,
): Promise<{ manifest: ExecutableArtifactManifest; manifestHash: `sha256:${string}` }> {
  const files: ExecutableArtifactManifest['files'] = [];
  const tree = createHash('sha256');
  for (const name of await executableFiles(path)) {
    const filePath = join(path, name);
    const metadata = await lstat(filePath);
    const chunks: ExecutableArtifactManifest['files'][number]['chunks'] = [];
    const fileHash = createHash('sha256');
    let size = 0;
    tree.update(name.split('/').join(sep)).update('\0');
    for await (const content of readExecutableFile(filePath)) {
      const chunkHash = sha256(content);
      chunks.push({ key: `objects/sha256/${chunkHash.slice(7)}`, hash: chunkHash, size: content.byteLength });
      fileHash.update(content);
      tree.update(content);
      size += content.byteLength;
    }
    const mode = metadata.mode & 0o111 ? 0o755 : 0o644;
    files.push({ path: name, hash: `sha256:${fileHash.digest('hex')}`, size, mode, chunks });
    tree.update('\0');
  }
  const manifest = executableArtifactManifestSchema.parse({
    version: 1,
    target,
    entrypoint: `${target}.js`,
    compatibility: executableArtifactCompatibility(),
    treeHash: `sha256:${tree.digest('hex')}`,
    files,
    omp,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  await writeFile(executableManifestPath(path), bytes);
  return { manifest, manifestHash: sha256(bytes) };
}

export interface ExecutableArtifactExpectation {
  target: ExecutableArtifactManifest['target'];
  hash: string;
  /** Trusted release-record digest, retained in persisted selection across restarts. */
  manifestHash: string;
}

/** Authenticate the envelope before interpreting any of its file paths or compatibility claims. */
export function parseExecutableArtifactManifest(
  bytes: Uint8Array,
  expected: { target: ExecutableArtifactManifest['target']; manifestHash: string; size?: number },
): ExecutableArtifactManifest {
  if (sha256(bytes) !== expected.manifestHash) throw new Error('Executable manifest hash mismatch');
  if (expected.size !== undefined && bytes.byteLength !== expected.size) throw new Error('Executable manifest size mismatch');
  const manifest = executableArtifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (manifest.target !== expected.target) throw new Error(`Expected ${expected.target} executable, received ${manifest.target}`);
  validateExecutableCompatibility(manifest);
  return manifest;
}

/** No agent implementation imports: safe for builders, stable hosts, and machine followers. */
export async function validateExecutableArtifact(
  path: string,
  expected: ExecutableArtifactExpectation,
): Promise<ExecutableArtifactManifest> {
  const sidecar = executableManifestPath(path);
  if (!(await lstat(sidecar)).isFile()) throw new Error(`Executable manifest is not a regular file: ${sidecar}`);
  const manifest = parseExecutableArtifactManifest(await readFile(sidecar), expected);
  if (manifest.treeHash !== expected.hash) throw new Error('Executable manifest tree hash differs from selected generation');
  const files = await executableFiles(path);
  const inventory = new Map(manifest.files.map((file) => [file.path, file]));
  if (files.length !== inventory.size) throw new Error('Executable artifact file inventory mismatch');
  const tree = createHash('sha256');
  for (const name of files) {
    const file = inventory.get(name);
    if (!file) throw new Error(`Executable artifact contains unlisted file ${name}`);
    const filePath = join(path, name);
    const mode = (await lstat(filePath)).mode & 0o111 ? 0o755 : 0o644;
    if (mode !== file.mode) throw new Error(`Executable file mode mismatch: ${name}`);
    let index = 0;
    let size = 0;
    const fileHash = createHash('sha256');
    tree.update(name.split('/').join(sep)).update('\0');
    for await (const content of readExecutableFile(filePath)) {
      const chunk = file.chunks[index++];
      if (!chunk || content.byteLength !== chunk.size || sha256(content) !== chunk.hash) throw new Error(`Executable file integrity mismatch: ${name}`);
      fileHash.update(content);
      tree.update(content);
      size += content.byteLength;
    }
    if (index !== file.chunks.length || size !== file.size || `sha256:${fileHash.digest('hex')}` !== file.hash) throw new Error(`Executable file integrity mismatch: ${name}`);
    tree.update('\0');
  }
  if (`sha256:${tree.digest('hex')}` !== manifest.treeHash) throw new Error('Executable artifact tree hash mismatch');
  return manifest;
}
