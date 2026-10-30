import { describe, expect, test } from 'bun:test';
import { buildDefaultRelease, publishDefaultRelease, publishToChannel, rollbackDefaultRelease, type DefaultReleaseStorage } from '../src/default-release.js';
import { DEFAULT_ACCOUNT_POINTER, loadDefaultRelease, loadPinnedDefaultRelease } from '@gitspace/protocol/default-release';
import { channelCatalogSchema } from '@gitspace/protocol/deployment';
import { CHANNEL_CATALOG } from '@gitspace/protocol/release-channel';

const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const bytes = (value: string) => new TextEncoder().encode(value);
const workerModule = (commit: string) => `defaults/releases/${commit}/worker/worker.mjs`;
function storage() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let revision = 0;
  let failKey: string | null = null;
  const api: DefaultReleaseStorage = {
    async get(key) { return objects.get(key) ?? null; },
    async put(key, value, condition) {
      if (key === failKey) throw new Error('injected upload failure');
      const current = objects.get(key);
      if (condition === null ? current !== undefined : current?.etag !== condition) throw new Error('publication conflict');
      objects.set(key, { bytes: value, etag: String(++revision) });
    },
  };
  return { api, objects, fail(key: string) { failKey = key; } };
}
async function build(commit = sha, imageCommit = commit, embeddedCommit = commit) {
  return buildDefaultRelease(commit, {
    verifyCommit: async () => commit,
    worker: async () => ({ commit, version: commit, modules: [{ name: 'worker.mjs', type: 'esm', content: bytes(new Bun.Transpiler({ define: { GITSPACE_WORKER_SHA: JSON.stringify(embeddedCommit) } }).transformSync('const WORKER_VERSION = typeof GITSPACE_WORKER_SHA === "string" ? GITSPACE_WORKER_SHA : "channel"; export default { fetch() { return new Response(WORKER_VERSION); } };')) }], metadata: { mainModule: 'worker.mjs', compatibilityDate: '2026-01-01', compatibilityFlags: [], durableObjects: [], resources: [], migrations: [] } }),
    frontend: async () => ({ commit, files: [{ path: 'index.html', bytes: bytes(`ui:${commit}`), contentType: 'text/html' }] }),
    image: async () => ({ commit: imageCommit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}`, provenance: bytes(JSON.stringify({ commit: imageCommit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}` })) }),
  });
}

describe('coherent default account releases', () => {
  test('publishes immutable components before the single pointer; rollback restores the entire set', async () => {
    const f = storage();
    const first = await build();
    await publishDefaultRelease(first, f.api);
    expect((await loadDefaultRelease(f.api)).commit).toBe(sha);
    const second = await build(nextSha);
    await publishDefaultRelease(second, f.api);
    expect((await loadDefaultRelease(f.api)).commit).toBe(nextSha);
    await rollbackDefaultRelease(f.api);
    expect(await loadDefaultRelease(f.api)).toEqual(first.manifest);
    expect(f.objects.has(workerModule(sha))).toBe(true);
  });
  test('rejects cross-commit image provenance before writing anything', async () => {
    await expect(build(sha, nextSha)).rejects.toThrow('commit');
  });
  test('rejects a mismatched embedded Worker version before publication', async () => {
    const f = storage();
    await expect(build(sha, sha, nextSha).then(release => publishDefaultRelease(release, f.api))).rejects.toThrow('Worker');
    expect(f.objects.size).toBe(0);
  });
  test('failed partial publication leaves existing bootstrap consumers on the previous complete release', async () => {
    const f = storage();
    await publishDefaultRelease(await build(), f.api);
    const next = await build(nextSha);
    f.fail(next.manifest.frontend.files[0]!.key);
    await expect(publishDefaultRelease(next, f.api)).rejects.toThrow('injected');
    expect((await loadDefaultRelease(f.api)).commit).toBe(sha);
  });
  test('refuses corrupted local or immutable remote content and never activates it', async () => {
    const f = storage();
    const release = await build();
    release.objects.set(workerModule(sha), bytes('tampered'));
    await expect(publishDefaultRelease(release, f.api)).rejects.toThrow('integrity');
    expect(f.objects.has('defaults/account.json')).toBe(false);
    const valid = await build();
    f.objects.set(workerModule(sha), { bytes: bytes('collision'), etag: 'collision' });
    await expect(publishDefaultRelease(valid, f.api)).rejects.toThrow('integrity');
  });
  test('same release retries are idempotent and bootstrap rejects missing selected artifacts', async () => {
    const f = storage();
    const release = await build();
    await publishDefaultRelease(release, f.api);
    await publishDefaultRelease(release, f.api);
    f.objects.delete(`defaults/releases/${sha}/worker.manifest.json`);
    await expect(loadDefaultRelease(f.api)).rejects.toThrow('missing');
  });
  test('resolving the current default reads its manifests, not its frontend files', async () => {
    const f = storage();
    await publishDefaultRelease(await build(), f.api);
    const read: string[] = [];
    await loadDefaultRelease({ async get(key) { read.push(key); return f.api.get(key); } });
    expect(read).toContain(`defaults/releases/${sha}/worker.manifest.json`);
    expect(read.filter(key => key.includes('/frontend/'))).toEqual([]);
  });
  test('concurrent promotions cannot overwrite a pointer changed since publication began', async () => {
    const f = storage();
    await publishDefaultRelease(await build(), f.api);
    const next = await build(nextSha);
    let changed = false;
    const racing: DefaultReleaseStorage = {
      get: f.api.get,
      async put(key, value, condition) {
        if (!changed && key === 'defaults/account.json') {
          changed = true;
          const current = f.objects.get(key)!;
          f.objects.set(key, { ...current, etag: 'concurrent-writer' });
        }
        await f.api.put(key, value, condition);
      },
    };
    await expect(publishDefaultRelease(next, racing)).rejects.toThrow('publication conflict');
    expect((await loadDefaultRelease(f.api)).commit).toBe(sha);
  });
});

describe('the public channel', () => {
  const catalog = (objects: Map<string, { bytes: Uint8Array }>) => channelCatalogSchema.parse(JSON.parse(new TextDecoder().decode(objects.get(CHANNEL_CATALOG)?.bytes ?? bytes('{"schemaVersion":1,"releases":[]}'))));

  test('publishes each release as its source holds it, lists the newest first, and keeps a tag bound to the release it named', async () => {
    const source = storage();
    await publishDefaultRelease(await build(), source.api);
    await publishDefaultRelease(await build(nextSha), source.api);
    const channel = storage();
    const first = await publishToChannel(source.api, channel.api, sha, 'v1.0.0', '2026-10-01T00:00:00.000Z');
    const next = await publishToChannel(source.api, channel.api, nextSha, 'v1.1.0', '2026-10-02T00:00:00.000Z');
    expect(catalog(channel.objects).releases).toEqual([
      { tag: 'v1.1.0', commit: nextSha, pin: next, publishedAt: '2026-10-02T00:00:00.000Z' },
      { tag: 'v1.0.0', commit: sha, pin: first, publishedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    expect((await loadPinnedDefaultRelease(channel.api, first)).commit).toBe(sha);
    expect(channel.objects.get(workerModule(sha))?.bytes).toEqual(source.objects.get(workerModule(sha))?.bytes);
    // The channel lists releases; it has no default of its own.
    expect(channel.objects.has(DEFAULT_ACCOUNT_POINTER)).toBe(false);

    expect(await publishToChannel(source.api, channel.api, sha, 'v1.0.0', '2026-10-03T00:00:00.000Z')).toBe(first);
    await expect(publishToChannel(source.api, channel.api, nextSha, 'v1.0.0', '2026-10-03T00:00:00.000Z')).rejects.toThrow('already published');
    expect(catalog(channel.objects).releases.map(release => release.tag)).toEqual(['v1.1.0', 'v1.0.0']);
  });

  test('refuses a release whose source bytes changed, listing nothing', async () => {
    const source = storage();
    await publishDefaultRelease(await build(), source.api);
    source.objects.set(workerModule(sha), { bytes: bytes('tampered'), etag: 'tampered' });
    const channel = storage();
    await expect(publishToChannel(source.api, channel.api, sha, 'v1.0.0', '2026-10-01T00:00:00.000Z')).rejects.toThrow();
    expect(channel.objects.has(CHANNEL_CATALOG)).toBe(false);
    // Channel keys are immutable: bytes written there would block publishing the true release under them.
    expect(channel.objects.has(workerModule(sha))).toBe(false);
  });
});
