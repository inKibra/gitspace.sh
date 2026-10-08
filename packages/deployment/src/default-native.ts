import { createHash } from 'node:crypto';
import { executableArtifactManifestSchema, machineNativePlatformSchema } from '@gitspace/protocol/deployment';
import { defaultNativeArtifactSchema, type DefaultNativeArtifact } from '@gitspace/protocol/default-release';

/** The existing native distribution build owns these bytes; the default only selects them. */
export function createDefaultNativeArtifact(commit: string, release: string, platform: string, value: unknown): DefaultNativeArtifact {
  const manifest = executableArtifactManifestSchema.parse(value);
  machineNativePlatformSchema.parse(platform);
  if (`${manifest.compatibility.platform}-${manifest.compatibility.arch}` !== platform || !manifest.compatibility.nativeAbi || `${manifest.compatibility.nativeAbi.platform}-${manifest.compatibility.nativeAbi.arch}` !== platform) throw new Error('Native manifest platform mismatch');
  const prefix = `distribution/v1/releases/${release}/${platform}/machine/`;
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const chunks = new Map<string, DefaultNativeArtifact['chunks'][number]>();
  for (const file of manifest.files) for (const chunk of file.chunks) chunks.set(chunk.key, { key: prefix + chunk.key, sha256: chunk.hash.slice(7), size: chunk.size });
  return defaultNativeArtifactSchema.parse({ commit, platform, generation: manifest.treeHash,
    artifact: { key: `${prefix}manifest.json`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength }, chunks: [...chunks.values()] });
}
