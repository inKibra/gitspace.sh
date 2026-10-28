import type { ReleaseArtifact } from '@gitspace/protocol/deployment';
import { PORTABLE_MANIFEST_FILE, portableFileKey, portableManifestSchema, verifyPortableFiles } from '@gitspace/protocol/machine-release';
import { tenantPlatformJson } from './tenant-platform.js';

/**
 * A launch's portable release, checked before it is staged: its manifest and every file the manifest names are in DATA
 * under the release as the building machine uploaded them (R2 checked each upload's SHA-256), and the platform holds
 * every native the manifest names in its mirror, copying any it lacks.
 */
export async function admitPortableRelease(env: Env, userId: string, sha: string, artifact: ReleaseArtifact): Promise<void> {
  if (artifact.key !== `releases/${sha}/${PORTABLE_MANIFEST_FILE}`) throw new Error(`Portable release manifest ${artifact.key} is not part of release ${sha}`);
  const object = await env.DATA.get(`users/${userId}/${artifact.key}`);
  if (!object) throw new Error(`Portable release manifest ${artifact.key} is missing`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== artifact.size || `sha256:${digest}` !== artifact.hash) throw new Error(`Portable release manifest ${artifact.key} does not match its digest`);
  const manifest = portableManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  await verifyPortableFiles(manifest, async path => {
    const stored = await env.DATA.head(`users/${userId}/${portableFileKey(artifact.key, path)}`);
    const recorded = stored?.customMetadata?.sha256;
    return stored && recorded?.startsWith('sha256:') ? { sha256: recorded.slice('sha256:'.length), size: stored.size } : null;
  });
  await tenantPlatformJson<unknown>(env, '/machine-release/natives', { method: 'POST', body: JSON.stringify({ natives: manifest.natives }) });
}
