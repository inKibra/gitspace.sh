import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { credentialProtocolBase64, TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { collectBytes, streamBytes } from '@gitspace/protocol-workspace';
import { describe, expect, it } from 'vitest';
import { TenantObjectIntegrityError, TenantStore, tenantObjectKey, type Sha256 } from '../src/tenant-store.js';
import { tenantRootPrivateKey } from './setup.js';
import { ssecBucket } from './tenant-store-fixture.js';

function sha256(bytes: Uint8Array): Sha256 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fixture() {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const bucket = ssecBucket(env.DATA);
  const store = new TenantStore(bucket, env.ACCOUNT_ID, async scope => new Uint8Array(await vault.scopeKey(scope)));
  return { vault, bucket, store };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<{ bytes: number; error: unknown }> {
  let bytes = 0;
  try {
    for await (const chunk of streamBytes(body)) bytes += chunk.byteLength;
    return { bytes, error: null };
  } catch (error) {
    return { bytes, error };
  }
}

describe('tenant store', () => {
  it('creates each scope key once, keeps it only wrapped under the vault, and forgets it', async () => {
    const { vault } = await fixture();
    const first = new Uint8Array(await vault.scopeKey('space:a'));
    expect(first.byteLength).toBe(32);
    expect(new Uint8Array(await vault.scopeKey('space:a'))).toEqual(first);
    expect(new Uint8Array(await vault.scopeKey('space:b'))).not.toEqual(first);
    const rows = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec<{ scope: string; wrapped: ArrayBuffer; root_version: number }>('SELECT scope, wrapped, root_version FROM scope_keys ORDER BY scope').toArray());
    expect(rows.map(row => [row.scope, row.root_version])).toEqual([['space:a', 1], ['space:b', 1]]);
    const wrapped = Buffer.from(rows[0]!.wrapped);
    expect(wrapped.byteLength).toBe(12 + 32 + 16);
    expect(wrapped.indexOf(Buffer.from(first))).toBe(-1);
    await vault.forgetScope('space:a');
    expect(new Uint8Array(await vault.scopeKey('space:a'))).not.toEqual(first);
  });

  it('stores plaintext with its scope, digest and size, reads it back verified, and serves ranges', async () => {
    const { store } = await fixture();
    const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => index % 253);
    expect(await store.put('projects/p/spaces/s/state.bin', 'space:s', bytes)).toEqual({ scope: 'space:s', sha256: sha256(bytes), size: bytes.byteLength });
    const raw = await env.DATA.head(tenantObjectKey(env.ACCOUNT_ID, 'projects/p/spaces/s/state.bin'));
    expect(raw?.customMetadata).toEqual({ scope: 'space:s', sha256: sha256(bytes), size: String(bytes.byteLength) });
    expect(await env.DATA.head(`users/${env.ACCOUNT_ID}/projects/p/spaces/s/state.bin`)).toBeNull();
    expect(await store.bytes('projects/p/spaces/s/state.bin', 'space:s', bytes.byteLength)).toEqual(bytes);
    const range = await store.get('projects/p/spaces/s/state.bin', 'space:s', { range: { offset: 1_000, length: 77 } });
    expect(range).toMatchObject({ size: bytes.byteLength, range: { offset: 1_000, length: 77 } });
    expect(await collectBytes(streamBytes(range!.body), 77)).toEqual(bytes.subarray(1_000, 1_077));
    await expect(store.head('projects/p/spaces/s/state.bin', 'space:other')).rejects.toThrow(TenantObjectIntegrityError);
  });

  it('reads back an empty file, which R2 stores without encryption', async () => {
    const { store } = await fixture();
    const empty = new Uint8Array(0);
    expect(await store.put('projects/p/spaces/s/empty.txt', 'space:s', empty)).toEqual({ scope: 'space:s', sha256: sha256(empty), size: 0 });
    expect(await store.bytes('projects/p/spaces/s/empty.txt', 'space:s', 10)).toEqual(empty);
  });

  it('reads an object only with the key of the scope it was written in', async () => {
    const { store, bucket } = await fixture();
    await store.put('projects/p/spaces/s/state.bin', 'space:s', new TextEncoder().encode('scoped'));
    const otherKey = new TenantStore(bucket, env.ACCOUNT_ID, async () => crypto.getRandomValues(new Uint8Array(32)));
    await expect(otherKey.get('projects/p/spaces/s/state.bin', 'space:s')).rejects.toThrow('SSE-C');
    await expect(otherKey.get('projects/p/spaces/s/state.bin', 'space:s', { range: { offset: 0, length: 1 } })).rejects.toThrow('SSE-C');
  });

  it('refuses a tampered body on a full read before releasing its last bytes', async () => {
    const { store } = await fixture();
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 249);
    const recorded = await store.put('projects/p/spaces/s/state.bin', 'space:s', bytes);
    const key = tenantObjectKey(env.ACCOUNT_ID, 'projects/p/spaces/s/state.bin');
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.byteLength - 1] ^= 1;
    // The body changes behind metadata that still names the original digest and size.
    await env.DATA.put(key, tampered, { customMetadata: { scope: 'space:s', sha256: recorded!.sha256, size: String(bytes.byteLength) } });
    await expect(store.bytes('projects/p/spaces/s/state.bin', 'space:s', bytes.byteLength)).rejects.toThrow(TenantObjectIntegrityError);
    const read = await readAll((await store.get('projects/p/spaces/s/state.bin', 'space:s'))!.body);
    expect(read.error).toBeInstanceOf(TenantObjectIntegrityError);
    expect(read.bytes).toBeLessThan(bytes.byteLength);
    // A body of another length is refused before any byte is read.
    await env.DATA.put(key, bytes.subarray(1), { customMetadata: { scope: 'space:s', sha256: recorded!.sha256, size: String(bytes.byteLength) } });
    await expect(store.head('projects/p/spaces/s/state.bin', 'space:s')).rejects.toThrow(TenantObjectIntegrityError);
  });

  it('writes a large object as uniform parts and completes it only when it matches its declared digest', async () => {
    const { store } = await fixture();
    const bytes = Uint8Array.from({ length: TENANT_OBJECT_PART_BYTES + 3 * 1024 * 1024 + 5 }, (_, index) => (index * 31) % 251);
    const write = async (name: string, declared: { sha256: Sha256; size: number }) => {
      const writer = store.writer(name, 'lfs:p', declared);
      for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) await writer.write(bytes.subarray(offset, offset + 1024 * 1024));
      return writer.close();
    };
    expect(await write('lfs/projects/p/objects/large', { sha256: sha256(bytes), size: bytes.byteLength })).toEqual({ scope: 'lfs:p', sha256: sha256(bytes), size: bytes.byteLength });
    const stored = await store.get('lfs/projects/p/objects/large', 'lfs:p');
    expect(stored?.size).toBe(bytes.byteLength);
    const hash = createHash('sha256');
    for await (const chunk of streamBytes(stored!.body)) hash.update(chunk);
    expect(`sha256:${hash.digest('hex')}`).toBe(sha256(bytes));
    await expect(write('lfs/projects/p/objects/mismatch', { sha256: sha256(bytes.subarray(1)), size: bytes.byteLength })).rejects.toThrow(TenantObjectIntegrityError);
    expect(await store.head('lfs/projects/p/objects/mismatch', 'lfs:p')).toBeNull();
  }, 60_000);
});
