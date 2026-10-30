import { CHANNEL_CATALOG, channelCatalogSchema, releasePinSchema, type ReleaseArtifact, type ReleaseSource, type StageReleaseInput } from '@gitspace/protocol/deployment';
import { loadPinnedDefaultRelease, type DefaultRelease, type DefaultReleaseReader } from '@gitspace/protocol/default-release';

/**
 * The channel: GitSpace's public bucket of published releases (`GITSPACE_CHANNEL_URL`), holding `catalog.json` and each
 * release under `defaults/releases/<commit>/`. A release record names a channel file by its channel key under this
 * prefix; the account answers every read of such a key (machines, the platform's `/deploy`, `/install`, the frontend)
 * from the channel, so a published release is used where it is, never copied.
 */
export const CHANNEL_PREFIX = 'channel/';

/** Published files never change: the edge keeps them a day. The catalog grows with each release, so it is kept briefly. */
const FILE_CACHE_SECONDS = 86_400;
const CATALOG_CACHE_SECONDS = 300;

/** One channel file, `GET` or `HEAD`, through the edge cache; null when the channel has no such file. */
export async function channelObject(env: Env, key: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response | null> {
  if (key.startsWith('/') || key.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`Channel key ${key} is invalid`);
  const response = await fetch(new URL(key, `${env.GITSPACE_CHANNEL_URL.replace(/\/+$/u, '')}/`), {
    method, signal: AbortSignal.timeout(60_000),
    cf: { cacheEverything: true, cacheTtl: key === CHANNEL_CATALOG ? CATALOG_CACHE_SECONDS : FILE_CACHE_SECONDS },
  });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The GitSpace channel answered HTTP ${response.status} for ${key}`); }
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

/** The release record of a published release: every file a channel key, the worker with the metadata it was built with. */
export function publishedStageInput(manifest: DefaultRelease, source: Extract<ReleaseSource, { kind: 'release' }>): StageReleaseInput {
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
      frontend: { key: `${CHANNEL_PREFIX}${prefix}frontend`, hash: `sha256:${source.pin.slice(41)}`, size: manifest.frontend.files.reduce((bytes, file) => bytes + file.size, 0) },
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

