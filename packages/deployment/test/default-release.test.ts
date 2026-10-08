import { describe, expect, test } from 'bun:test';
import { buildDefaultRelease, publishDefaultRelease, rollbackDefaultRelease, type DefaultReleaseStorage } from '../src/default-release.js';
import { loadDefaultRelease } from '@gitspace/protocol/default-release';

const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const bytes = (value: string) => new TextEncoder().encode(value);
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
async function build(commit = sha, imageCommit = commit) {
  return buildDefaultRelease(commit, {
    verifyCommit: async () => commit,
    worker: async () => ({ commit, version: commit, bytes: bytes(`worker:${commit}`), metadata: { mainModule: 'worker.mjs', compatibilityDate: '2026-01-01', compatibilityFlags: [], durableObjects: [], resources: [], migrations: [] } }),
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
    expect(f.objects.has(first.manifest.worker.bundle.key)).toBe(true);
  });
  test('rejects cross-commit image provenance before writing anything', async () => {
    await expect(build(sha, nextSha)).rejects.toThrow('commit');
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
    release.objects.set(release.manifest.worker.bundle.key, bytes('tampered'));
    await expect(publishDefaultRelease(release, f.api)).rejects.toThrow('integrity');
    expect(f.objects.has('defaults/account.json')).toBe(false);
    const valid = await build();
    f.objects.set(valid.manifest.worker.bundle.key, { bytes: bytes('collision'), etag: 'collision' });
    await expect(publishDefaultRelease(valid, f.api)).rejects.toThrow('integrity');
  });
  test('same release retries are idempotent and bootstrap rejects missing selected artifacts', async () => {
    const f = storage();
    const release = await build();
    await publishDefaultRelease(release, f.api);
    await publishDefaultRelease(release, f.api);
    f.objects.delete(release.manifest.worker.bundle.key);
    await expect(loadDefaultRelease(f.api)).rejects.toThrow('missing');
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
