import { channelCatalogSchema, releasePinSchema, type ReleaseArtifact, type ReleaseSource, type StageReleaseInput } from '@gitspace/protocol/deployment';
import { loadPinnedDefaultRelease, type DefaultRelease, type DefaultReleaseReader } from '@gitspace/protocol/default-release';
import { CHANNEL_CATALOG } from '@gitspace/protocol/release-channel';

/**
 * The channel: GitSpace's published releases, `catalog.json` and each release under `defaults/releases/<commit>/`,
 * read through the read-only release channel Worker this account binds (`RELEASE_CHANNEL`, resource source
 * `release-channel`). A release record names a channel file by its channel key under this prefix; the account answers
 * every read of such a key (machines, the platform's `/deploy`, `/install`, the frontend) from the channel, so a
 * published release is used where it is, never copied.
 */
export const CHANNEL_PREFIX = 'channel/';

/** One channel file, `GET` or `HEAD`; null when the channel has no such file. */
export async function channelObject(env: Env, key: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response | null> {
  if (key.startsWith('/') || key.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`Channel key ${key} is invalid`);
  const response = await env.RELEASE_CHANNEL.fetch(new Request(new URL(key, 'https://release-channel.internal/'), { method, signal: AbortSignal.timeout(60_000) }));
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The GitSpace release channel answered HTTP ${response.status} for ${key}`); }
  return response;
}

function channelReader(env: Env): DefaultReleaseReader {
  return {
    async get(key) {
      const response = await channelObject(env, key);
      return response ? { bytes: await response.bytes(), etag: response.headers.get('etag') ?? '' } : null;
    },
  };
}

/** A published release, its manifest checked against the pin: by its tag in the catalog, or by its pin (the catalog
 * then names its tag, when it lists it). */
export async function publishedRelease(env: Env, reference: { tag: string } | { pin: string }): Promise<{ manifest: DefaultRelease; source: Extract<ReleaseSource, { kind: 'release' }> }> {
  const catalogResponse = await channelObject(env, CHANNEL_CATALOG);
  const catalog = catalogResponse ? channelCatalogSchema.parse(await catalogResponse.json()) : null;
  let pin: string;
  let tag: string | null;
  if ('tag' in reference) {
    const listed = catalog?.releases.find(release => release.tag === reference.tag);
    if (!listed) throw new Error(`The GitSpace channel has no release ${reference.tag}`);
    ({ pin, tag } = listed);
  } else {
    pin = releasePinSchema.parse(reference.pin);
    tag = catalog?.releases.find(release => release.pin === pin)?.tag ?? null;
  }
  return { manifest: await loadPinnedDefaultRelease(channelReader(env), pin), source: { kind: 'release', tag, pin } };
}

/**
 * The hash a machine computes over the frontend tree it writes from a release (`hashArtifactPath`): for each file, its
 * path in the tree, a NUL, its bytes and a NUL, every directory's entries in `localeCompare` order of their names. A
 * published release names no such hash, so its record's frontend artifact carries this one; the pin's hash there made
 * every machine refuse the tree it wrote (2026-11-26).
 */
export async function publishedFrontendTreeHash(env: Env, files: DefaultRelease['frontend']['files']): Promise<`sha256:${string}`> {
  const ordered = [...files].sort((left, right) => {
    const a = left.path.split('/');
    const b = right.path.split('/');
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return a[index]!.localeCompare(b[index]!);
    }
    return a.length - b.length;
  });
  const contents: Uint8Array[] = [];
  for (let start = 0; start < ordered.length; start += 8) {
    contents.push(...await Promise.all(ordered.slice(start, start + 8).map(async (file) => {
      const response = await channelObject(env, file.key);
      if (!response) throw new Error(`The GitSpace channel has no frontend file ${file.key}`);
      return response.bytes();
    })));
  }
  const encoder = new TextEncoder();
  const parts = ordered.flatMap((file, index) => [encoder.encode(file.path), new Uint8Array([0]), contents[index]!, new Uint8Array([0])]);
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The release record of a published release: every file a channel key, the worker with the metadata it was built with,
 * the frontend under the tree hash a machine computes (`publishedFrontendTreeHash`). */
export function publishedStageInput(manifest: DefaultRelease, source: Extract<ReleaseSource, { kind: 'release' }>, frontendTree: `sha256:${string}`): StageReleaseInput {
  if (!('manifest' in manifest.worker)) throw new Error(`Published release ${manifest.commit} predates module releases; publish it again`);
  if (!manifest.portable) throw new Error(`Published release ${manifest.commit} has no portable machine release`);
  const prefix = `defaults/releases/${manifest.commit}/`;
  const artifact = (object: { key: string; sha256: string; size: number }): ReleaseArtifact => ({ key: `${CHANNEL_PREFIX}${object.key}`, hash: `sha256:${object.sha256}`, size: object.size });
  return {
    sha: manifest.commit,
    label: source.tag ?? `published ${manifest.commit.slice(0, 12)}`,
    source,
    inferenceVersion: manifest.inferenceVersion,
    worker: manifest.worker.metadata,
    artifacts: {
      worker: artifact(manifest.worker.manifest),
      machine: null,
      // The frontend tree is served by path under its prefix; the pin's manifest lists and pins each file.
      frontend: { key: `${CHANNEL_PREFIX}${prefix}frontend`, hash: frontendTree, size: manifest.frontend.files.reduce((bytes, file) => bytes + file.size, 0) },
      portable: artifact(manifest.portable),
    },
  };
}

/** A release file: a published release's from the channel, any other from account storage. `size` is null when the
 * channel's answer does not state it. */
export async function releaseFile(env: Env, userId: string, key: string, method: 'GET' | 'HEAD'): Promise<{ body: ReadableStream<Uint8Array> | null; size: number | null; etag: string } | null> {
  if (key.startsWith(CHANNEL_PREFIX)) {
    const response = await channelObject(env, key.slice(CHANNEL_PREFIX.length), method);
    if (!response) return null;
    const length = response.headers.get('content-length');
    return { body: method === 'HEAD' ? null : response.body, size: length === null ? null : Number(length), etag: response.headers.get('etag') ?? '' };
  }
  const stored = `users/${userId}/${key}`;
  const object = method === 'HEAD' ? await env.DATA.head(stored) : await env.DATA.get(stored);
  if (!object) return null;
  return { body: 'body' in object && object.body instanceof ReadableStream ? object.body : null, size: object.size, etag: object.httpEtag };
}

