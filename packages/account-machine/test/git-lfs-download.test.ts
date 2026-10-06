import { afterEach, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { hydrateGitLfs } from '../src/git-lfs.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const payload = new TextEncoder().encode('bounded LFS payload');
const object = GitLfsObjectSchema.parse({ oid: createHash('sha256').update(payload).digest('hex'), size: payload.byteLength });
function fixture(body: ReadableStream<Uint8Array>) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-lfs-download-')); roots.push(root);
  for (const args of [['init', '-b', 'main'], ['config', 'lfs.url', 'https://origin.invalid/lfs?token=machine-secret'], ['config', 'http.https://origin.invalid/.extraHeader', 'Authorization: Bearer machine-secret']]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: root });
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  const path = join(root, '.git/lfs/objects', object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
  const mock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(init?.redirect).toBe('error');
    if (String(input).includes('/objects/batch')) {
      expect(new URL(String(input)).search).toBe('?token=machine-secret');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer machine-secret');
      return Response.json({ objects: [{ ...object, actions: { download: { href: 'https://cdn.invalid/payload', header: { 'x-download-token': 'action-only' } } } }] });
    }
    expect(String(input)).toBe('https://cdn.invalid/payload');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new Headers(init?.headers).get('x-download-token')).toBe('action-only');
    return new Response(body, { headers: { 'content-length': String(object.size) } });
  }, { preconnect: fetch.preconnect }));
  return {
    path,
    restore: () => hydrateGitLfs(root, [], { objects: [{ ...object, source: 'origin', location: { origin: 'https://origin.invalid/repo.git', endpoint: 'https://origin.invalid/lfs' } }], heldBack: [] }),
    reset: () => mock.mockRestore(),
    empty: () => { expect(existsSync(path)).toBe(false); expect(existsSync(dirname(path)) ? readdirSync(dirname(path)) : []).toEqual([]); },
  };
}

it('stops an oversized origin body on the first excess chunk despite a valid Content-Length', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls <= 10_000) controller.enqueue(new Uint8Array(4));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const f = fixture(body);
  try {
    await expect(f.restore()).rejects.toThrow('hydration failed');
    expect(pulls).toBe(Math.floor(object.size / 4) + 1);
    expect(cancelled).toBe(true);
    f.empty();
  } finally { f.reset(); }
});

it('rejects a short body and removes its partial cache file', async () => {
  const f = fixture(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, payload.length - 1)); controller.close(); } }));
  try { await expect(f.restore()).rejects.toThrow('hydration failed'); f.empty(); }
  finally { f.reset(); }
});

it('rejects a complete wrong digest and removes its temporary file', async () => {
  const f = fixture(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(object.size)); controller.close(); } }));
  try { await expect(f.restore()).rejects.toThrow('hydration failed'); f.empty(); }
  finally { f.reset(); }
});

it('removes the partial cache file when the source fails after a chunk', async () => {
  let pulls = 0;
  const f = fixture(new ReadableStream<Uint8Array>({ pull(controller) { if (++pulls === 1) controller.enqueue(payload.subarray(0, 3)); else controller.error(new Error('connection lost')); } }, { highWaterMark: 0 }));
  try { await expect(f.restore()).rejects.toThrow('hydration failed'); f.empty(); }
  finally { f.reset(); }
});

it('cancels a stalled body on abort and removes the in-progress temporary file', async () => {
  const abort = new AbortController();
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
  const stalled = Promise.withResolvers<void>();
  let pulls = 0, cancelled = false;
  const f = fixture(new ReadableStream<Uint8Array>({
    pull(controller) { if (++pulls === 1) controller.enqueue(payload.subarray(0, 3)); else { stalled.resolve(); return new Promise<void>(() => {}); } },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const restoring = f.restore().then(() => null, (error: unknown) => error);
  try {
    await stalled.promise;
    expect(existsSync(f.path)).toBe(false);
    expect(existsSync(dirname(f.path)) && readdirSync(dirname(f.path)).some(name => name.startsWith(`${object.oid}.tmp-`))).toBe(true);
    abort.abort(new Error('cancel download'));
    expect(await restoring).toBeInstanceOf(Error);
    expect(cancelled).toBe(true);
    f.empty();
  } finally { abort.abort(); await restoring; timeout.mockRestore(); f.reset(); }
});

it('publishes only the complete verified object with an atomic cache rename', async () => {
  const stalled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let pulls = 0;
  const f = fixture(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (++pulls === 1) controller.enqueue(payload.subarray(0, 3));
      else { stalled.resolve(); await release.promise; controller.enqueue(payload.subarray(3)); controller.close(); }
    },
  }, { highWaterMark: 0 }));
  let restoring: Promise<void> | undefined;
  try {
    restoring = f.restore();
    await stalled.promise;
    expect(existsSync(f.path)).toBe(false);
    expect(existsSync(dirname(f.path)) && readdirSync(dirname(f.path)).some(name => name.startsWith(`${object.oid}.tmp-`))).toBe(true);
    release.resolve();
    await restoring;
    expect(readFileSync(f.path)).toEqual(Buffer.from(payload));
    expect(readdirSync(dirname(f.path))).toEqual([object.oid]);
  } finally { release.resolve(); await restoring; f.reset(); }
});
