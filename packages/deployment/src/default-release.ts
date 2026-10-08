import { createHash } from 'node:crypto';
import { DEFAULT_ACCOUNT_POINTER, defaultCommitSchema, defaultPointerSchema, defaultReleaseSchema, defaultImageProvenanceSchema, readDefaultManifest, verifyDefaultObject, verifyDefaultReleaseContents, type DefaultRelease, type DefaultReleaseReader, type DefaultObject } from '@gitspace/protocol/default-release';
import type { WorkerReleaseMetadata } from '@gitspace/protocol/deployment';

export type DefaultReleaseStorage = DefaultReleaseReader & { put(key: string, bytes: Uint8Array, expectedEtag: string | null): Promise<void> };
export type DefaultReleaseBuild = { manifest: DefaultRelease; objects: Map<string, Uint8Array> };
export type DefaultReleaseBuilders = {
  verifyCommit(): Promise<string>;
  worker(): Promise<{ commit: string; version: string; bytes: Uint8Array; metadata: WorkerReleaseMetadata }>;
  frontend(): Promise<{ commit: string; files: { path: string; bytes: Uint8Array; contentType: string }[] }>;
  image(): Promise<{ commit: string; image: string; provenance: Uint8Array }>;
  machines?(): Promise<DefaultRelease['machines']>;
};
export function defaultObject(key: string, bytes: Uint8Array): DefaultObject {
  return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function buildDefaultRelease(commit: string, builders: DefaultReleaseBuilders): Promise<DefaultReleaseBuild> {
  defaultCommitSchema.parse(commit);
  if (await builders.verifyCommit() !== commit) throw new Error('Build checkout commit mismatch or dirty tree');
  const worker = await builders.worker();
  const frontend = await builders.frontend();
  const image = await builders.image();
  const machines = builders.machines ? await builders.machines() : [];
  if (await builders.verifyCommit() !== commit) throw new Error('Build checkout commit changed during build');
  const prefix = `defaults/releases/${commit}/`;
  const objects = new Map<string, Uint8Array>();
  objects.set(`${prefix}worker.bundle.json`, worker.bytes);
  objects.set(`${prefix}image-provenance.json`, image.provenance);
  const manifest = defaultReleaseSchema.parse({
    schemaVersion: 1, commit, machines,
    worker: { commit: worker.commit, version: worker.version, bundle: defaultObject(`${prefix}worker.bundle.json`, worker.bytes), metadata: worker.metadata },
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
  for (const object of [manifest.worker.bundle, ...manifest.frontend.files, manifest.image.provenance, reference]) {
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
