import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { buildInitialRuntime } from '../../deployment/src/builders.js';

interface RuntimeFile {
  path: string;
  size: number;
}

/** Move every payload file exactly once into bounded image layers, retaining its path and mode. */
export async function partitionRuntime(root: string, output: string, slots: number, targetBytes = 128 * 1024 * 1024) {
  if (!Number.isInteger(slots) || slots < 1 || !Number.isSafeInteger(targetBytes) || targetBytes < 1) {
    throw new Error('Runtime layer count and target bytes must be positive integers');
  }
  const files: RuntimeFile[] = [];
  const directories: string[] = [];
  async function inventory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(relative(root, path));
        await inventory(path);
      } else if (entry.isFile()) {
        files.push({ path: relative(root, path), size: (await stat(path)).size });
      } else {
        throw new Error(`Runtime image contains a non-regular entry: ${path}`);
      }
    }
  }
  await inventory(root);
  files.sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
  const bins = Array.from({ length: slots }, () => ({ bytes: 0, files: [] as RuntimeFile[] }));
  for (const file of files) {
    // Large native files remain whole in their own layer; no reconstruction layer duplicates their bytes.
    const bin = file.size > targetBytes
      ? bins.find((candidate) => candidate.files.length === 0)
      : bins.find((candidate) => candidate.bytes + file.size <= targetBytes);
    if (!bin) throw new Error(`Complete runtime requires more than ${slots} image layers`);
    bin.files.push(file);
    bin.bytes += file.size;
  }
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error(`Runtime layer output must be empty: ${output}`);
  const layers: Array<{ layer: string; bytes: number; files: number }> = [];
  for (const [index, bin] of bins.entries()) {
    const layer = String(index).padStart(2, '0');
    const destination = join(output, layer);
    await mkdir(destination, { recursive: true });
    if (index === 0) {
      for (const directory of directories) await mkdir(join(destination, directory), { recursive: true });
    }
    for (const file of bin.files) {
      const path = join(destination, file.path);
      await mkdir(dirname(path), { recursive: true });
      await rename(join(root, file.path), path);
    }
    layers.push({ layer, bytes: bin.bytes, files: bin.files.length });
  }
  await rm(root, { recursive: true });
  return layers;
}

if (import.meta.main) {
  const slots = Number(process.env.GITSPACE_RUNTIME_LAYER_COUNT);
  if (!Number.isInteger(slots) || slots < 1) throw new Error('GITSPACE_RUNTIME_LAYER_COUNT is required');
  await buildInitialRuntime(process.cwd(), '/out');
  console.log(JSON.stringify({ runtimeLayers: await partitionRuntime('/out', '/runtime-layers', slots) }));
}
