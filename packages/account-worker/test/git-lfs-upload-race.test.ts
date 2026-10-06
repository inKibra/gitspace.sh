import { lfsBytes, readLfs } from './git-lfs-fixture.js';
import { createHash } from 'node:crypto';
import { env } from 'cloudflare:test';
import { decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes } from '@gitspace/protocol';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, chunkedCheckpointManifestSchema, GitLfsObjectSchema, type GitLfsObject } from '@gitspace/protocol-workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountGitLfsStore, gitLfsObjectKey } from '../src/git-lfs-store.js';

type UploadFixture = {
  key: Uint8Array;
  bytes: Uint8Array;
  object: GitLfsObject;
  path: string;
  store: AccountGitLfsStore;
};

async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fixture(): Promise<UploadFixture> {
  const projectId = crypto.randomUUID();
  const key = await deriveArtifactScopeKey(new Uint8Array(32).fill(19), `lfs:${projectId}`);
  const bytes = new Uint8Array(CHECKPOINT_CHUNK_BYTES + 17).fill(83);
  const object = GitLfsObjectSchema.parse({ oid: await sha256(bytes), size: bytes.length });
  const path = `users/${env.ACCOUNT_ID}/${gitLfsObjectKey(projectId, object.oid)}`;
  const store = new AccountGitLfsStore(env.DATA, env.ACCOUNT_ID, projectId, key, async () => {});
  return { key, bytes, object, path, store };
}

async function chunkKeys(path: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix: `${path}.chunks/`, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

async function assertPublished(f: UploadFixture) {
  const stored = await env.DATA.get(f.path);
  if (!stored) throw new Error('Missing published manifest');
  const envelope = new Uint8Array(await stored.arrayBuffer());
  expect(envelope[0]).toBe(CHUNKED_CHECKPOINT_VERSION);
  const inventory = await decryptArtifactBytes(envelope.subarray(1), f.key);
  const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder().decode(inventory)));
  expect(await chunkKeys(f.path)).toEqual(manifest.chunks.map(chunk => `${f.path}.chunks/${chunk.hash.slice(7)}`).sort());
  const actual = await readLfs(f.store, f.object);
  if (!actual) throw new Error('Missing plaintext');
  expect(actual.byteLength).toBe(f.bytes.byteLength);
  expect(await sha256(actual)).toBe(f.object.oid);
}

afterEach(() => vi.restoreAllMocks());

describe('encrypted LFS publication cleanup', () => {
  it('streams canonical plaintext chunks and checks the full identity at completion', async () => {
    const f = await fixture();
    await f.store.put(f.object, lfsBytes(f.bytes));
    const source = await f.store.get(f.object);
    if (!source) throw new Error('Missing object');
    let offset = 0;
    const sizes: number[] = [];
    const hash = createHash('sha256');
    for await (const bytes of source) {
      hash.update(bytes);
      offset += bytes.byteLength;
      sizes.push(bytes.byteLength);
    }
    expect(sizes).toEqual([CHECKPOINT_CHUNK_BYTES, 17]);
    expect(offset).toBe(f.object.size);
    expect(hash.digest('hex')).toBe(f.object.oid);
    const wrongIdentity = GitLfsObjectSchema.parse({ ...f.object, oid: '0'.repeat(64) });
    const wrongPath = f.path.slice(0, -64) + wrongIdentity.oid;
    const manifest = await env.DATA.get(f.path);
    if (!manifest) throw new Error('Missing manifest');
    await env.DATA.put(wrongPath, manifest.body);
    for (const key of await chunkKeys(f.path)) {
      const chunk = await env.DATA.get(key);
      if (!chunk) throw new Error('Missing chunk');
      await env.DATA.put(key.replace(f.path, wrongPath), chunk.body);
    }
    await expect(f.store.has(wrongIdentity)).rejects.toThrow('oid/size');
  });

  it('cancels oversized R2 envelopes without pulling their body', async () => {
    const f = await fixture();
    await env.DATA.put(f.path, 'placeholder');
    const stored = await env.DATA.get(f.path);
    if (!stored) throw new Error('Missing fixture');
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(385));
      controller.close();
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.spyOn(env.DATA, 'get').mockResolvedValueOnce(new Proxy(stored, {
      get(target, property, receiver) {
        if (property === 'body') return body;
        if (property === 'size') return CHECKPOINT_CHUNK_BYTES + 30;
        return Reflect.get(target, property, receiver);
      },
    }));
    await expect(f.store.get(f.object)).rejects.toThrow('byte limit');
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an R2 body that exceeds its declared size while streaming', async () => {
    const f = await fixture();
    await env.DATA.put(f.path, 'placeholder');
    const stored = await env.DATA.get(f.path);
    if (!stored) throw new Error('Missing fixture');
    const cancel = vi.fn();
    let remaining = 1000;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(385));
      if (--remaining === 0) controller.close();
    });
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.spyOn(env.DATA, 'get').mockResolvedValueOnce(new Proxy(stored, {
      get(target, property, receiver) {
        if (property === 'body') return body;
        return Reflect.get(target, property, receiver);
      },
    }));
    await expect(f.store.get(f.object)).rejects.toThrow('byte limit');
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects forged inventory size before requesting chunks', async () => {
    const f = await fixture();
    const sealed = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify({
      version: 1, size: CHECKPOINT_CHUNK_BYTES + 18,
      chunks: [{ hash: `sha256:${'1'.repeat(64)}`, size: CHECKPOINT_CHUNK_BYTES }, { hash: `sha256:${'2'.repeat(64)}`, size: 18 }],
    })), f.key);
    const envelope = new Uint8Array(sealed.byteLength + 1);
    envelope[0] = CHUNKED_CHECKPOINT_VERSION;
    envelope.set(sealed, 1);
    await env.DATA.put(f.path, envelope);
    const get = vi.spyOn(env.DATA, 'get');
    await expect(f.store.get(f.object)).rejects.toThrow('inventory size');
    expect(get.mock.calls.map(call => call[0])).toEqual([f.path]);
  });

  it('removes uploaded chunks when the source ends with a mismatched digest', async () => {
    const f = await fixture();
    async function* corrupt() {
      yield f.bytes.subarray(0, CHECKPOINT_CHUNK_BYTES);
      expect(await chunkKeys(f.path)).toHaveLength(1);
      yield new Uint8Array(17);
    }
    await expect(f.store.put(f.object, corrupt())).rejects.toThrow('oid/size');
    expect(await env.DATA.head(f.path)).toBeNull();
    expect(await chunkKeys(f.path)).toEqual([]);
  });

  it('removes only the losing attempt chunks after both random uploads reach manifest CAS', async () => {
    const f = await fixture();
    const put = env.DATA.put.bind(env.DATA);
    const gate = Promise.withResolvers<void>();
    let manifests = 0;
    let uploadedBeforeCas: string[] = [];
    const outcomes: boolean[] = [];
    vi.spyOn(env.DATA, 'put').mockImplementation(async (path, value, options) => {
      if (path !== f.path) return put(path, value, options);
      if (++manifests === 2) {
        uploadedBeforeCas = await chunkKeys(f.path);
        gate.resolve();
      }
      await gate.promise;
      const result = await put(path, value, options);
      outcomes.push(result !== null);
      return result;
    });
    // Unrelated scopes and a third in-flight attempt must never be prefix-cleaned.
    const otherScope = `users/other/${gitLfsObjectKey('other-project', f.object.oid)}.chunks/sentinel`;
    const otherAttempt = `${f.path}.chunks/in-flight-sentinel`;
    await put(otherScope, 'other scope');
    await put(otherAttempt, 'other attempt');
    await Promise.all([f.store.put(f.object, lfsBytes(f.bytes)), f.store.put(f.object, lfsBytes(f.bytes))]);
    expect(uploadedBeforeCas.filter(key => key !== otherAttempt)).toHaveLength(4);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await (await env.DATA.get(otherScope))?.text()).toBe('other scope');
    expect(await (await env.DATA.get(otherAttempt))?.text()).toBe('other attempt');
    await env.DATA.delete(otherAttempt);
    await assertPublished(f);
  });

  it('cleans this attempt after a chunk write persists but loses its response', async () => {
    const f = await fixture();
    const put = env.DATA.put.bind(env.DATA);
    let chunks = 0;
    vi.spyOn(env.DATA, 'put').mockImplementation(async (path, value, options) => {
      const result = await put(path, value, options);
      if (path.startsWith(`${f.path}.chunks/`) && ++chunks === 2) throw new Error('chunk response lost');
      return result;
    });
    await expect(f.store.put(f.object, lfsBytes(f.bytes))).rejects.toThrow('chunk response lost');
    expect(await env.DATA.head(f.path)).toBeNull();
    expect(await chunkKeys(f.path)).toEqual([]);
  });

  it('keeps chunks when a failed manifest request has no known outcome', async () => {
    const f = await fixture();
    const put = env.DATA.put.bind(env.DATA);
    vi.spyOn(env.DATA, 'put').mockImplementation(async (path, value, options) => {
      if (path === f.path) throw new Error('manifest request interrupted');
      return put(path, value, options);
    });
    await expect(f.store.put(f.object, lfsBytes(f.bytes))).rejects.toThrow('manifest request interrupted');
    expect(await env.DATA.head(f.path)).toBeNull();
    // The request may still commit remotely; only fenced collection may reclaim these.
    expect(await chunkKeys(f.path)).toHaveLength(2);
  });

  it('preserves winning chunks when a committed manifest loses its response', async () => {
    const f = await fixture();
    const put = env.DATA.put.bind(env.DATA);
    vi.spyOn(env.DATA, 'put').mockImplementation(async (path, value, options) => {
      const result = await put(path, value, options);
      if (path === f.path) throw new Error('manifest response lost');
      return result;
    });
    await expect(f.store.put(f.object, lfsBytes(f.bytes))).rejects.toThrow('manifest response lost');
    await assertPublished(f);
  });

  it('protects referenced chunks even if a conditional result reports no publication', async () => {
    const f = await fixture();
    const put = env.DATA.put.bind(env.DATA);
    vi.spyOn(env.DATA, 'put').mockImplementation(async (path, value, options) => {
      const result = await put(path, value, options);
      return path === f.path ? put(path, value, options) : result;
    });
    await f.store.put(f.object, lfsBytes(f.bytes));
    await assertPublished(f);
  });
});
