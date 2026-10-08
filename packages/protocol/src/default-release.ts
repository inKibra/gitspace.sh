import { z } from 'zod';
import { workerReleaseMetadataSchema, executableArtifactManifestSchema, machineNativePlatformSchema, releaseArtifactSchema } from './deployment.js';
import { cloudImageReferenceSchema } from './cloud-image.js';

export const DEFAULT_ACCOUNT_POINTER = 'defaults/account.json';
export const defaultCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const defaultImageProvenanceSchema = z.object({ commit: defaultCommitSchema, image: cloudImageReferenceSchema }).passthrough();
const pathSchema = z.string().min(1).refine(value => !/[\\\x00-\x1f]/u.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Unsafe release path');
export const defaultObjectSchema = z.object({ key: pathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative() }).strict();
export const defaultNativeArtifactSchema = z.object({
  commit: defaultCommitSchema, platform: machineNativePlatformSchema,
  generation: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  artifact: defaultObjectSchema, chunks: z.array(defaultObjectSchema).min(1),
}).strict().superRefine((native, context) => {
  const prefix = /^distribution\/v1\/releases\/[A-Za-z0-9._-]+\/([^/]+)\/machine\//u.exec(native.artifact.key);
  if (!prefix || prefix[1] !== native.platform || !native.artifact.key.endsWith('/manifest.json')) context.addIssue({ code: 'custom', message: 'Native artifact platform namespace mismatch' });
  const root = native.artifact.key.slice(0, -'manifest.json'.length);
  for (const chunk of native.chunks) if (chunk.key !== `${root}objects/sha256/${chunk.sha256}`) context.addIssue({ code: 'custom', message: 'Native chunk namespace mismatch' });
});
export type DefaultNativeArtifact = z.infer<typeof defaultNativeArtifactSchema>;
export const defaultNativeProvenanceSchema = z.object({ sourceRevision: defaultCommitSchema, platform: machineNativePlatformSchema, machine: z.object({ treeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }) }).passthrough();
export const defaultMachineReleaseSchema = z.object({ sha: z.string().min(1), commit: defaultCommitSchema, platform: machineNativePlatformSchema, artifact: releaseArtifactSchema }).strict();
export const defaultReleaseSchema = z.object({
  schemaVersion: z.literal(1), commit: defaultCommitSchema,
  worker: z.object({ commit: defaultCommitSchema, version: defaultCommitSchema, bundle: defaultObjectSchema, metadata: workerReleaseMetadataSchema }).strict(),
  frontend: z.object({ commit: defaultCommitSchema, files: z.array(defaultObjectSchema.extend({ path: pathSchema, contentType: z.string().min(1) })).min(1) }).strict(),
  image: z.object({ commit: defaultCommitSchema, image: cloudImageReferenceSchema, provenance: defaultObjectSchema }).strict(),
  machines: z.array(defaultNativeArtifactSchema).default([]),
}).strict().superRefine((manifest, context) => {
  if ([manifest.worker.commit, manifest.worker.version, manifest.frontend.commit, manifest.image.commit].some(commit => commit !== manifest.commit)) context.addIssue({ code: 'custom', message: 'Default release part commit mismatch' });
  if (manifest.machines.some(machine => machine.commit !== manifest.commit) || new Set(manifest.machines.map(machine => machine.platform)).size !== manifest.machines.length) context.addIssue({ code: 'custom', message: 'Native default commit mismatch or duplicate platform' });
  const keys = new Set<string>();
  for (const object of [manifest.worker.bundle, ...manifest.frontend.files, manifest.image.provenance]) {
    if (!object.key.startsWith(`defaults/releases/${manifest.commit}/`) || keys.has(object.key)) context.addIssue({ code: 'custom', message: 'Default release object namespace mismatch or duplicate' });
    keys.add(object.key);
  }
  if (!manifest.frontend.files.some(file => file.path === 'index.html') || new Set(manifest.frontend.files.map(file => file.path)).size !== manifest.frontend.files.length) context.addIssue({ code: 'custom', message: 'Frontend requires a unique index.html inventory' });
});
export type DefaultRelease = z.infer<typeof defaultReleaseSchema>;
export type DefaultObject = z.infer<typeof defaultObjectSchema>;
export const defaultPointerSchema = z.object({ schemaVersion: z.literal(1), current: defaultObjectSchema, previous: defaultObjectSchema.nullable() }).strict();
export const defaultReleasePinSchema = z.string().regex(/^[a-f0-9]{40}:[a-f0-9]{64}$/u);
export function defaultReleasePin(reference: DefaultObject): string {
  const match = /^defaults\/releases\/([a-f0-9]{40})\/manifest.json$/u.exec(reference.key);
  if (!match) throw new Error('Default manifest namespace mismatch');
  return defaultReleasePinSchema.parse(`${match[1]}:${reference.sha256}`);
}
export type DefaultReleaseReader = { get(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> };
export async function verifyDefaultObject(reader: DefaultReleaseReader, object: DefaultObject): Promise<Uint8Array> {
  const result = await reader.get(object.key);
  if (!result) throw new Error(`Default release object missing: ${object.key}`);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(result.bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (result.bytes.byteLength !== object.size || digest !== object.sha256) throw new Error(`Default release integrity mismatch: ${object.key}`);
  return result.bytes;
}
export async function readDefaultManifest(reader: DefaultReleaseReader, reference: DefaultObject): Promise<DefaultRelease> {
  const manifest = defaultReleaseSchema.parse(JSON.parse(new TextDecoder().decode(await verifyDefaultObject(reader, reference))));
  if (reference.key !== `defaults/releases/${manifest.commit}/manifest.json`) throw new Error('Default manifest commit namespace mismatch');
  return manifest;
}

export async function verifyDefaultReleaseContents(reader: DefaultReleaseReader, manifest: DefaultRelease, nativeContent: 'all' | 'manifests' = 'all'): Promise<void> {
  for (const object of [manifest.worker.bundle, ...manifest.frontend.files]) await verifyDefaultObject(reader, object);
  const provenance = defaultImageProvenanceSchema.parse(JSON.parse(new TextDecoder().decode(await verifyDefaultObject(reader, manifest.image.provenance))));
  if (provenance.commit !== manifest.commit || provenance.image !== manifest.image.image) throw new Error('Default image provenance commit or image mismatch');
  for (const native of manifest.machines) {
    await verifyDefaultNativeArtifact(reader, native);
    if (nativeContent === 'all') for (const chunk of native.chunks) await verifyDefaultObject(reader, chunk);
  }
}

export async function verifyDefaultNativeArtifact(reader: DefaultReleaseReader, native: DefaultNativeArtifact): Promise<void> {
  const manifest = executableArtifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(await verifyDefaultObject(reader, native.artifact))));
  if (manifest.target !== 'machine' || `${manifest.compatibility.platform}-${manifest.compatibility.arch}` !== native.platform || !manifest.compatibility.nativeAbi || `${manifest.compatibility.nativeAbi.platform}-${manifest.compatibility.nativeAbi.arch}` !== native.platform || manifest.treeHash !== native.generation) throw new Error('Native executable platform or generation mismatch');
  const chunks = new Map(native.chunks.map(chunk => [chunk.sha256, chunk]));
  for (const file of manifest.files) for (const chunk of file.chunks) {
    const published = chunks.get(chunk.hash.slice(7));
    if (!published || published.size !== chunk.size) throw new Error('Native executable chunk inventory mismatch');
  }
}

export const defaultNativeSelectionSchema = z.object({ platform: machineNativePlatformSchema.optional(), generation: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional() }).strict();
type NativeSelection = z.infer<typeof defaultNativeSelectionSchema>;
export async function resolveDefaultRelease(reader: DefaultReleaseReader, pin?: string | null): Promise<{ release: DefaultRelease; pin: string }> {
  if (pin !== undefined && pin !== null) return { release: await loadPinnedDefaultRelease(reader, pin), pin };
  const pointer = await reader.get(DEFAULT_ACCOUNT_POINTER);
  if (!pointer) throw new Error('Default release pointer missing');
  const selected = defaultPointerSchema.parse(JSON.parse(new TextDecoder().decode(pointer.bytes)));
  const release = await readDefaultManifest(reader, selected.current);
  // Chunks are authenticated at publication and again on download.
  await verifyDefaultReleaseContents(reader, release, 'manifests');
  return { release, pin: defaultReleasePin(selected.current) };
}
export async function loadDefaultRelease(reader: DefaultReleaseReader): Promise<DefaultRelease> {
  return (await resolveDefaultRelease(reader)).release;
}
export async function loadPinnedDefaultRelease(reader: DefaultReleaseReader, pin: string): Promise<DefaultRelease> {
  defaultReleasePinSchema.parse(pin);
  const commit = pin.slice(0, 40);
  const key = `defaults/releases/${commit}/manifest.json`;
  const object = await reader.get(key);
  if (!object) throw new Error('Pinned default release missing');
  const reference = { key, sha256: pin.slice(41), size: object.bytes.byteLength };
  // Reuse the exact bytes read above while retaining the canonical hash verifier.
  return readDefaultManifest({ get: async requested => requested === key ? object : reader.get(requested) }, reference);
}
type NativeRelease = Pick<DefaultRelease, 'commit' | 'machines'>;
export async function defaultMachineRelease(reader: DefaultReleaseReader, release: NativeRelease, selection: NativeSelection) {
  let platform = selection.platform;
  if (!platform && selection.generation) {
    const index = await reader.get(`distribution/v1/generations/${selection.generation.slice(7)}.json`);
    if (index) {
      const native = defaultNativeArtifactSchema.parse(JSON.parse(new TextDecoder().decode(index.bytes)));
      if (native.generation !== selection.generation) throw new Error('Native generation index mismatch');
      await verifyDefaultNativeArtifact(reader, native);
      platform = native.platform;
    }
  }
  const native = release.machines.find(native => native.platform === platform);
  if (!native) throw new Error('No verified default machine for this native platform');
  if (native.commit !== release.commit) throw new Error('Default machine commit mismatch');
  await verifyDefaultNativeArtifact(reader, native);
  return defaultMachineReleaseSchema.parse({ sha: `${release.commit}-${native.platform}`, commit: release.commit, platform: native.platform, artifact: { key: native.artifact.key, hash: `sha256:${native.artifact.sha256}`, size: native.artifact.size } });
}
export async function defaultMachineObject(reader: DefaultReleaseReader, release: NativeRelease, key: string): Promise<Uint8Array> {
  for (const native of release.machines) {
    const object = native.artifact.key === key ? native.artifact : native.chunks.find(chunk => chunk.key === key || key === `objects/sha256/${chunk.sha256}`);
    if (object) { await verifyDefaultNativeArtifact(reader, native); return verifyDefaultObject(reader, object); }
  }
  throw new Error('Object is not part of the pinned default machine release');
}
