import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildDefaultRelease } from '../src/default-release.js';
import { encodeWorkerBundle } from '@gitspace/protocol/worker-bundle';
import { runDefaultRelease } from '../src/default-release-cli.js';

const commit = 'b'.repeat(40);
const encode = (value: string) => new TextEncoder().encode(value);

test('rejects self-consistent foreign saved-directory publication before opening storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'default-cli-'));
  try {
    const release = await buildDefaultRelease(commit, {
      verifyCommit: async () => commit,
      worker: async () => ({ commit, version: commit, bytes: encodeWorkerBundle([{ name: 'worker.mjs', type: 'esm', content: encode(new Bun.Transpiler({ define: { GITSPACE_WORKER_SHA: JSON.stringify(commit) } }).transformSync('const WORKER_VERSION = typeof GITSPACE_WORKER_SHA === "string" ? GITSPACE_WORKER_SHA : "channel"; export default { fetch() { return new Response(WORKER_VERSION); } };')) }]), metadata: { mainModule: 'worker.mjs', compatibilityDate: '2026-01-01', compatibilityFlags: [], durableObjects: [], resources: [], migrations: [] } }),
      frontend: async () => ({ commit, files: [{ path: 'index.html', bytes: encode('foreign'), contentType: 'text/html' }] }),
      image: async () => ({ commit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}`, provenance: encode(JSON.stringify({ commit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}` })) }),
    });
    for (const [key, bytes] of release.objects) {
      const path = join(directory, key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
    }
    const preload = join(directory, 'deny-storage.ts');
    await Bun.write(preload, `import { mock } from 'bun:test'; mock.module(${JSON.stringify(resolve(import.meta.dir, '../src/release.ts'))}, () => ({ releaseStorageClient() { throw new Error('STORAGE_ADAPTER_OPENED'); } }));`);
    const child = Bun.spawn([process.execPath, '--preload', preload, resolve(import.meta.dir, '../src/default-release-cli.ts'), 'publish', '--from', directory, '--commit', commit, '--bucket', 'never-contact'], { env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(stderr).not.toContain('STORAGE_ADAPTER_OPENED');
    expect(stderr).toContain('build --publish');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects --from with build rather than silently ignoring saved input', async () => {
  await expect(runDefaultRelease(['build', '--from', '/unused-saved-directory'])).rejects.toThrow('--from');
});
