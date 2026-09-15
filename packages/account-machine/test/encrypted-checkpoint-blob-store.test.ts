import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHECKPOINT_CHUNK_BYTES,
  CHUNKED_CHECKPOINT_VERSION,
  spaceOmpCheckpointKey,
} from '@gitspace/protocol-workspace';
import { decryptArtifactBytes, encryptArtifactBytes } from '@gitspace/protocol';
import { EncryptedCheckpointBlobStore, FileCheckpointBlobStore } from '../src/index.js';

const roots: string[] = [];
const encryptionKey = new Uint8Array(32).fill(23);
const checkpointKey = spaceOmpCheckpointKey('project-a', 'space-a', 1);
const absentHash = `sha256:${'a'.repeat(64)}`;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class ObservedFileCheckpointBlobStore extends FileCheckpointBlobStore {
  readonly reads: string[] = [];

  override get(key: string, expectedHash?: string): Promise<Uint8Array | null> {
    this.reads.push(key);
    return super.get(key, expectedHash);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-encrypted-checkpoint-'));
  roots.push(root);
  const inner = new ObservedFileCheckpointBlobStore(root);
  return { inner, store: new EncryptedCheckpointBlobStore(inner, encryptionKey) };
}

async function sealedManifest(manifest: unknown): Promise<Uint8Array> {
  const sealed = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify(manifest)), encryptionKey);
  const bytes = new Uint8Array(1 + sealed.byteLength);
  bytes[0] = CHUNKED_CHECKPOINT_VERSION;
  bytes.set(sealed, 1);
  return bytes;
}

const canonicalManifest = {
  version: 1,
  size: CHECKPOINT_CHUNK_BYTES + 1,
  chunks: [
    { hash: absentHash, size: CHECKPOINT_CHUNK_BYTES },
    { hash: absentHash, size: 1 },
  ],
};

describe('EncryptedCheckpointBlobStore', () => {
  it.each([
    { label: 'empty', plaintext: new Uint8Array() },
    { label: 'small', plaintext: new TextEncoder().encode('persisted complete OMP checkpoint\n') },
  ])('reads persisted v1 $label checkpoints without rewriting them', async ({ plaintext }) => {
    const { inner, store } = fixture();
    const legacy = await encryptArtifactBytes(plaintext, encryptionKey, new Uint8Array(12).fill(3));
    expect(legacy[0]).toBe(1);
    const legacyHash = await inner.put(checkpointKey, legacy);

    expect(await store.get(checkpointKey, legacyHash)).toEqual(plaintext);
    expect(await inner.get(checkpointKey, legacyHash)).toEqual(legacy);
  });

  it('keeps an exactly 32 MiB checkpoint readable by the existing v1 artifact decoder', async () => {
    const { inner, store } = fixture();
    const plaintext = new Uint8Array(CHECKPOINT_CHUNK_BYTES).fill(29);
    plaintext[plaintext.byteLength - 1] = 31;
    const expectedHash = new Bun.CryptoHasher('sha256').update(plaintext).digest('hex');

    const hash = await store.put(checkpointKey, plaintext);
    const persisted = await inner.get(checkpointKey, hash);
    expect(persisted).not.toBeNull();
    const restored = await decryptArtifactBytes(persisted!, encryptionKey);

    expect(restored.byteLength).toBe(plaintext.byteLength);
    expect(new Bun.CryptoHasher('sha256').update(restored).digest('hex')).toBe(expectedHash);
  }, 60_000);

  it.each([
    {
      label: 'a chunk key outside the checkpoint revision',
      manifest: { ...canonicalManifest, chunks: [{ ...canonicalManifest.chunks[0], key: 'projects/other/secret.enc' }, canonicalManifest.chunks[1]] },
    },
    {
      label: 'path traversal in a chunk digest',
      manifest: { ...canonicalManifest, chunks: [{ hash: 'sha256:../../outside', size: CHECKPOINT_CHUNK_BYTES }, canonicalManifest.chunks[1]] },
    },
    {
      label: 'noncanonical chunk boundaries',
      manifest: { ...canonicalManifest, chunks: [{ hash: absentHash, size: CHECKPOINT_CHUNK_BYTES - 1 }, { hash: absentHash, size: 2 }] },
    },
  ])('rejects an authenticated manifest containing $label before fetching chunk objects', async ({ manifest }) => {
    const { inner, store } = fixture();
    const rootHash = await inner.put(checkpointKey, await sealedManifest(manifest));

    await expect(store.get(checkpointKey, rootHash)).rejects.toThrow();

    // Malformed inventories must not cause storage reads under attacker-supplied references.
    expect(inner.reads).toEqual([checkpointKey]);
  });

  it('rejects a replaced root even when its manifest authenticates with the same encryption key', async () => {
    const { inner, store } = fixture();
    const originalHash = await inner.put(checkpointKey, await sealedManifest(canonicalManifest));
    const replacement = {
      ...canonicalManifest,
      size: CHECKPOINT_CHUNK_BYTES + 2,
      chunks: [canonicalManifest.chunks[0], { hash: absentHash, size: 2 }],
    };
    await inner.put(checkpointKey, await sealedManifest(replacement));

    await expect(store.get(checkpointKey, originalHash)).rejects.toThrow();
    expect(inner.reads).toEqual([checkpointKey]);
  });

  it('rejects an authenticated chunk whose plaintext size disagrees with the inventory', async () => {
    const { inner, store } = fixture();
    const shortChunk = await encryptArtifactBytes(new Uint8Array([37]), encryptionKey);
    const chunkHash = `sha256:${new Bun.CryptoHasher('sha256').update(shortChunk).digest('hex')}`;
    const chunkKey = `${checkpointKey}.chunks/${chunkHash.slice(7)}`;
    await inner.put(chunkKey, shortChunk);
    const manifest = {
      ...canonicalManifest,
      chunks: [{ hash: chunkHash, size: CHECKPOINT_CHUNK_BYTES }, canonicalManifest.chunks[1]],
    };
    const rootHash = await inner.put(checkpointKey, await sealedManifest(manifest));

    await expect(store.get(checkpointKey, rootHash)).rejects.toThrow();
    expect(inner.reads).toEqual([checkpointKey, chunkKey]);
  });

  it('rejects a chunked envelope used as a chunk without recursively traversing its inventory', async () => {
    const { inner, store } = fixture();
    const nestedRoot = await sealedManifest(canonicalManifest);
    const chunkHash = `sha256:${new Bun.CryptoHasher('sha256').update(nestedRoot).digest('hex')}`;
    const chunkKey = `${checkpointKey}.chunks/${chunkHash.slice(7)}`;
    await inner.put(chunkKey, nestedRoot);
    const manifest = {
      ...canonicalManifest,
      chunks: [{ hash: chunkHash, size: CHECKPOINT_CHUNK_BYTES }, canonicalManifest.chunks[1]],
    };
    const rootHash = await inner.put(checkpointKey, await sealedManifest(manifest));

    await expect(store.get(checkpointKey, rootHash)).rejects.toThrow();
    expect(inner.reads).toEqual([checkpointKey, chunkKey]);
  });
});
