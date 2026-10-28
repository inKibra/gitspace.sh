import { createHash } from 'node:crypto';
import { DEFAULT_ACCOUNT_POINTER, defaultCommitSchema, defaultPointerSchema, defaultReleaseSchema, defaultImageProvenanceSchema, readDefaultManifest, verifyDefaultObject, verifyDefaultPortable, verifyDefaultReleaseContents, verifyDefaultWorker, type DefaultRelease, type DefaultReleaseReader, type DefaultObject } from '@gitspace/protocol/default-release';
import { WORKER_MANIFEST_FILE, workerModuleKey, type WorkerReleaseMetadata } from '@gitspace/protocol/deployment';
import { PORTABLE_MANIFEST_FILE, portableFileKey } from '@gitspace/protocol/machine-release';
import { createWorkerManifest, type WorkerModule } from '@gitspace/protocol/worker-bundle';

export type DefaultReleaseStorage = DefaultReleaseReader & { put(key: string, bytes: Uint8Array, expectedEtag: string | null): Promise<void> };
export type DefaultReleaseBuild = { manifest: DefaultRelease; objects: Map<string, Uint8Array> };
export type DefaultReleaseBuilders = {
  verifyCommit(): Promise<string>;
  worker(): Promise<{ commit: string; version: string; modules: WorkerModule[]; metadata: WorkerReleaseMetadata }>;
  frontend(): Promise<{ commit: string; files: { path: string; bytes: Uint8Array; contentType: string }[] }>;
  image(): Promise<{ commit: string; image: string; provenance: Uint8Array }>;
  machines?(): Promise<DefaultRelease['machines']>;
  /** The portable machine release: its manifest and the files it names, by path. */
  portable?(): Promise<{ manifest: Uint8Array; files: { path: string; bytes: Uint8Array }[] }>;
};
export function defaultObject(key: string, bytes: Uint8Array): DefaultObject {
  return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function buildDefaultRelease(commit: string, builders: DefaultReleaseBuilders): Promise<DefaultReleaseBuild> {
  defaultCommitSchema.parse(commit);
  if (await builders.verifyCommit() !== commit) throw new Error('Build checkout commit mismatch or dirty tree');
  const worker = await builders.worker();
  const workerManifest = new TextEncoder().encode(JSON.stringify(createWorkerManifest(worker.metadata.mainModule, worker.modules)));
  const main = worker.modules.find(module => module.name === worker.metadata.mainModule);
  if (!main) throw new Error('Worker release has no declared main module');
  // Bun's non-minified Worker build folds GITSPACE_WORKER_SHA into these
  // declarations, including renamed copies from other bundled modules.
  const source = new TextDecoder('utf-8', { fatal: true }).decode(main.content);
  const versions = [...source.matchAll(/^(?:var|const|let) WORKER_VERSION(?:\d+)? = ([^\n]+);$/gmu)];
  if (versions.length === 0 || versions.some(match => match[1] !== JSON.stringify(commit))) throw new Error('Worker embedded version commit mismatch');
  const frontend = await builders.frontend();
  const image = await builders.image();
  const machines = builders.machines ? await builders.machines() : [];
  const portable = builders.portable ? await builders.portable() : null;
  if (await builders.verifyCommit() !== commit) throw new Error('Build checkout commit changed during build');
  const prefix = `defaults/releases/${commit}/`;
  const objects = new Map<string, Uint8Array>();
  const workerManifestKey = `${prefix}${WORKER_MANIFEST_FILE}`;
  for (const module of worker.modules) objects.set(workerModuleKey(workerManifestKey, module.name), module.content);
  objects.set(workerManifestKey, workerManifest);
  objects.set(`${prefix}image-provenance.json`, image.provenance);
  const portableKey = `${prefix}${PORTABLE_MANIFEST_FILE}`;
  if (portable) {
    for (const file of portable.files) objects.set(portableFileKey(portableKey, file.path), file.bytes);
    objects.set(portableKey, portable.manifest);
  }
  const manifest = defaultReleaseSchema.parse({
    schemaVersion: 1, commit, inferenceVersion: 1, machines,
    ...(portable ? { portable: defaultObject(portableKey, portable.manifest) } : {}),
    worker: { commit: worker.commit, version: worker.version, manifest: defaultObject(workerManifestKey, workerManifest), metadata: worker.metadata },
    frontend: { commit: frontend.commit, files: frontend.files.map(file => {
      const key = `${prefix}frontend/${file.path}`;
      objects.set(key, file.bytes);
      return { ...defaultObject(key, file.bytes), path: file.path, contentType: file.contentType };
    }) },
    image: { commit: image.commit, image: image.image, provenance: defaultObject(`${prefix}image-provenance.json`, image.provenance) },
  });
  const provenance = defaultImageProvenanceSchema.parse(JSON.parse(new TextDecoder().decode(image.provenance)));
  if (provenance.commit !== commit || provenance.image !== image.image) throw new Error('Image provenance commit or image mismatch');
  objects.set(`${prefix}manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
  return { manifest, objects };
}
async function verifyRelease(reader: DefaultReleaseReader, reference: DefaultObject): Promise<DefaultRelease> {
  const manifest = await readDefaultManifest(reader, reference);
  await verifyDefaultReleaseContents(reader, manifest);
  return manifest;
}
export async function publishDefaultRelease(build: DefaultReleaseBuild, storage: DefaultReleaseStorage): Promise<void> {
  const manifest = defaultReleaseSchema.parse(build.manifest);
  const manifestKey = `defaults/releases/${manifest.commit}/manifest.json`;
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const reference = defaultObject(manifestKey, manifestBytes);
  const local: DefaultReleaseReader = { async get(key) { const bytes = build.objects.get(key); return bytes ? { bytes, etag: '' } : key.startsWith('distribution/v1/') ? storage.get(key) : null; } };
  await verifyRelease(local, reference);
  const before = await storage.get(DEFAULT_ACCOUNT_POINTER);
  const pointer = before ? defaultPointerSchema.parse(JSON.parse(new TextDecoder().decode(before.bytes))) : null;
  if (pointer) await verifyRelease(storage, pointer.current);
  const portableObjects = manifest.portable ? await verifyDefaultPortable(local, manifest.portable, 'manifests') : [];
  for (const object of [...await verifyDefaultWorker(local, manifest.worker, 'manifests'), ...manifest.frontend.files, manifest.image.provenance, ...portableObjects, reference]) {
    const bytes = await verifyDefaultObject(local, object);
    if (!await storage.get(object.key)) {
      try { await storage.put(object.key, bytes, null); }
      catch (error) { if (!await storage.get(object.key)) throw error; }
    }
    await verifyDefaultObject(storage, object);
  }
  if (pointer?.current.sha256 === reference.sha256 && pointer.current.key === reference.key) return;
  await storage.put(DEFAULT_ACCOUNT_POINTER, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, current: reference, previous: pointer?.current ?? null })), before?.etag ?? null);
}
export async function rollbackDefaultRelease(storage: DefaultReleaseStorage): Promise<void> {
  const before = await storage.get(DEFAULT_ACCOUNT_POINTER);
  if (!before) throw new Error('Default release pointer missing');
  const pointer = defaultPointerSchema.parse(JSON.parse(new TextDecoder().decode(before.bytes)));
  if (!pointer.previous) throw new Error('No previous complete default release');
  await verifyRelease(storage, pointer.previous);
  await storage.put(DEFAULT_ACCOUNT_POINTER, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, current: pointer.previous, previous: pointer.current })), before.etag);
}
