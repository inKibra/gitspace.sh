import { DEFAULT_ACCOUNT_POINTER } from '@gitspace/protocol/default-release';

export async function publishDefaultFixture(bucket: R2Bucket) {
  const commit = 'd'.repeat(40);
  async function object(key: string, text: string) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    await bucket.put(key, bytes);
    return { key, size: bytes.byteLength, sha256 };
  }
  const root = `defaults/releases/${commit}/`;
  const nativeRoot = 'distribution/v1/releases/fixture/linux-x64/machine/';
  const source = await object(`${nativeRoot}source`, 'machine source');
  const chunk = await object(`${nativeRoot}objects/sha256/${source.sha256}`, 'machine source');
  const generation = `sha256:${source.sha256}`;
  const artifact = await object(`${nativeRoot}manifest.json`, JSON.stringify({
    version: 1, target: 'machine', inferenceVersion: 1, entrypoint: 'machine.js',
    compatibility: { platform: 'linux', arch: 'x64', bunVersion: '1.4.0', protocolVersion: 1, nativeAbi: { platform: 'linux', arch: 'x64', minimumVersion: '2.35' } },
    treeHash: generation, files: [{ path: 'machine.js', hash: generation, size: chunk.size, mode: 420, chunks: [{ key: `objects/sha256/${chunk.sha256}`, hash: generation, size: chunk.size }] }], omp: null,
  }));
  const image = `registry.example/tenant/default@sha256:${'d'.repeat(64)}`;
  const bundle = await object(`${root}worker.json`, '{}');
  const frontend = await object(`${root}frontend/index.html`, '<html>original</html>');
  const provenance = await object(`${root}image-provenance.json`, JSON.stringify({ commit, image }));
  const release = { schemaVersion: 1, commit,
    worker: { commit, version: commit, bundle, metadata: { mainModule: 'worker.mjs', compatibilityDate: '2026-08-27', compatibilityFlags: [], durableObjects: [], resources: [], migrations: [] } },
    frontend: { commit, files: [{ ...frontend, path: 'index.html', contentType: 'text/html' }] },
    image: { commit, image, provenance }, machines: [{ commit, platform: 'linux-x64', generation, artifact, chunks: [chunk] }],
  };
  const reference = await object(`${root}manifest.json`, JSON.stringify(release));
  await bucket.put(DEFAULT_ACCOUNT_POINTER, JSON.stringify({ schemaVersion: 1, current: reference, previous: null }));
  return { commit, pin: `${commit}:${reference.sha256}`, image, release, object, generation };
}
