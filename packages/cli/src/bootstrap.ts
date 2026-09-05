import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import {
  currentDistributionPlatform,
  currentGlibcVersion,
  distributionBaseUrl,
  distributionChannelSchema,
  distributionManifestSchema,
  versionAtLeast,
  type DistributionFile,
  type DistributionManifest,
} from '@gitspace/deployment/distribution';

async function download(url: URL): Promise<Response> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Cannot download GitSpace release ${url}: HTTP ${response.status}. If this platform has not been published, use GitSpace in the browser without pairing this machine.`);
  }
  return response;
}

async function metadata(url: URL, maximum: number, expected?: { size: number; sha256: string }): Promise<Uint8Array> {
  const response = await download(url);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error(`GitSpace release metadata exceeds ${maximum} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (expected && (size !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)) {
    throw new Error(`GitSpace release metadata integrity check failed: ${url}`);
  }
  return bytes;
}

async function downloadPayload(url: URL, path: string, expected: { size: number; sha256: string }): Promise<void> {
  const response = await download(url);
  const reader = response.body!.getReader();
  const handle = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expected.size) throw new Error('GitSpace runtime download exceeds its published size');
      hash.update(value);
      await handle.writeFile(value);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('GitSpace runtime download integrity check failed');
    await handle.sync();
  } finally {
    await handle.close();
    await reader.cancel();
    reader.releaseLock();
  }
}

/** The authenticated inventory supplies paths and lengths. The payload cannot create links, special files, or traverse directories. */
async function unpack(payload: string, root: string, files: DistributionFile[]): Promise<void> {
  const source = createReadStream(payload);
  const decompressed = source.pipe(createGunzip());
  source.on('error', (error) => decompressed.destroy(error));
  const chunks = decompressed[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array();
  let offset = 0;
  try {
    for (const file of files) {
      const destination = join(root, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      let remaining = file.size;
      try {
        while (remaining > 0) {
          if (offset === chunk.byteLength) {
            const next = await chunks.next();
            if (next.done) throw new Error(`Truncated GitSpace runtime file: ${file.path}`);
            chunk = next.value as Uint8Array;
            offset = 0;
          }
          const length = Math.min(remaining, chunk.byteLength - offset);
          const bytes = chunk.subarray(offset, offset + length);
          hash.update(bytes);
          await handle.writeFile(bytes);
          offset += length;
          remaining -= length;
        }
        if (hash.digest('hex') !== file.sha256) throw new Error(`GitSpace runtime file integrity check failed: ${file.path}`);
        await handle.chmod(file.mode);
      } finally {
        await handle.close();
      }
    }
    if (offset !== chunk.byteLength || !(await chunks.next()).done) throw new Error('GitSpace runtime contains unlisted payload bytes');
  } finally {
    decompressed.destroy();
    source.destroy();
  }
}

async function verifyInstalled(root: string, manifest: DistributionManifest): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new Error('Installed runtime is not a regular directory');
  const inventory = new Map(manifest.runtime.files.map((file) => [file.path, file]));
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path, `${name}/`); continue; }
      if (!entry.isFile()) throw new Error(`Installed runtime contains a link or special file: ${name}`);
      if (name === 'distribution-manifest.json') continue;
      const expected = inventory.get(name);
      if (!expected) throw new Error(`Installed runtime contains an unlisted file: ${name}`);
      const stat = await lstat(path);
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      if (stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode || hash.digest('hex') !== expected.sha256) {
        throw new Error(`Installed runtime failed integrity verification: ${name}. Remove this runtime directory and pair again.`);
      }
      inventory.delete(name);
    }
  }
  await visit(root);
  if (inventory.size !== 0) throw new Error(`Installed runtime is missing ${inventory.keys().next().value}`);
}

/** Install only published bootstrap code. Account-selected machine/OMP releases remain the host's responsibility. */
export async function installRuntime(configRoot: string, apiUrl: string): Promise<string> {
  const platform = currentDistributionPlatform();
  const glibc = platform.startsWith('linux-') ? currentGlibcVersion() : null;
  const base = distributionBaseUrl(apiUrl);
  const channel = distributionChannelSchema.parse(JSON.parse(new TextDecoder().decode(await metadata(new URL(`stable/${platform}.json`, base), 64 * 1024))));
  if (channel.platform !== platform) throw new Error('GitSpace release channel returned the wrong platform');
  const release = new URL(`releases/${channel.release}/${platform}/`, base);
  const manifestBytes = await metadata(new URL('manifest.json', release), channel.manifest.size, channel.manifest);
  const manifest = distributionManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (manifest.platform !== platform || manifest.release !== channel.release) throw new Error('GitSpace release manifest does not match its channel');
  if (glibc && manifest.minimumGlibc && !versionAtLeast(glibc, manifest.minimumGlibc)) {
    throw new Error(`This GitSpace runtime requires glibc ${manifest.minimumGlibc} or newer; this machine has ${glibc}. Upgrade the Linux distribution or use GitSpace in the browser without pairing.`);
  }
  const runtimeDirectory = join(configRoot, 'runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const destination = join(runtimeDirectory, channel.manifest.sha256);
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    await verifyInstalled(destination, manifest);
  } else {
    const staging = await mkdtemp(join(runtimeDirectory, '.install-'));
    try {
      const payload = join(staging, 'runtime.bin.gz');
      const tree = join(staging, 'tree');
      await mkdir(tree, { mode: 0o700 });
      await downloadPayload(new URL('runtime.bin.gz', release), payload, manifest.runtime);
      await unpack(payload, tree, manifest.runtime.files);
      await writeFile(join(tree, 'distribution-manifest.json'), manifestBytes, { mode: 0o644 });
      try {
        await rename(tree, destination);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await verifyInstalled(destination, manifest);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const selection = join(configRoot, 'runtime-selection.json');
  const temporary = `${selection}.next-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify({ path: destination }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, selection);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}
