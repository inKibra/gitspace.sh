import type { ReleaseArtifact } from '@gitspace/protocol/deployment';
import { mirrorNatives, nativeMirrorKey, PORTABLE_MANIFEST_FILE, portableFileKey, portableManifestSchema, verifyPortableFiles, type NativeMirror } from '@gitspace/protocol/machine-release';

/** Upstream native files in the account's own storage at `users/<account>/natives/sha256/<sha256>`, where its machines
 * read them through the data endpoint. R2 checks each object against its pinned SHA-256 as it stores it. */
function accountNativeMirror(bucket: R2Bucket, userId: string): NativeMirror {
  const key = (sha256: string) => `users/${userId}/${nativeMirrorKey(sha256)}`;
  return {
    async has(sha256) {
      return await bucket.head(key(sha256)) !== null;
    },
    async put(native, body) {
      // R2 refuses bytes that miss the SHA-256, storing nothing; the download passes through without this Worker reading it.
      await bucket.put(key(native.sha256), body, { sha256: native.sha256, customMetadata: { sha256: `sha256:${native.sha256}` } });
    },
  };
}

/**
 * A launch's portable release, checked before it is staged: its manifest and every file the manifest names are in DATA
 * under the release as the building machine uploaded them (R2 checked each upload's SHA-256), and the account holds
 * every native the manifest names (`accountNativeMirror`), copying any it lacks from its upstream release.
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
  await mirrorNatives(manifest.natives, accountNativeMirror(env.DATA, userId), url => fetch(url, { signal: AbortSignal.timeout(5 * 60_000) }));
}
