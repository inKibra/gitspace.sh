import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, chunkedCheckpointManifestSchema, collectBytes } from '@gitspace/protocol-workspace';
import { decryptArtifactBytes, encryptArtifactBytes } from '@gitspace/protocol';

export interface CheckpointBlobStore {
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
  get(key: string, expectedHash?: string, maxBytes?: number): Promise<Uint8Array | null>;
}


export class FileCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return hashBytes(bytes);
  }

  async get(key: string, expectedHash?: string, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    try {
      const file = await open(this.path(key), 'r');
      let bytes: Uint8Array;
      try {
        if ((await file.stat()).size > maxBytes) throw new Error('Checkpoint ciphertext exceeds byte limit');
        bytes = await collectBytes(file.createReadStream({ autoClose: false }), maxBytes);
      } finally { await file.close(); }
      if (expectedHash && hashBytes(bytes) !== expectedHash) throw new Error(`Checkpoint object ${key} failed integrity verification`);
      return bytes;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private path(key: string): string {
    const root = resolve(this.root);
    const path = resolve(root, key);
    const local = relative(root, path);
    if (local === '' || local === '..' || local.startsWith(`..${sep}`)) throw new Error(`Invalid checkpoint object key ${key}`);
    return path;
  }
}

export class EncryptedCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly inner: CheckpointBlobStore, private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new RangeError('Checkpoint encryption key must be 32 bytes');
  }

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    return this.putStream(key, (async function* () { yield bytes; })(), bytes.byteLength);
  }

  async putStream(key: string, source: AsyncIterable<Uint8Array>, size: number): Promise<`sha256:${string}`> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Checkpoint source size is invalid');
    if (128 + 128 * Math.ceil(size / CHECKPOINT_CHUNK_BYTES) > 64 * 1024 * 1024 - 30) throw new Error('Checkpoint inventory exceeds byte limit');
    const chunks: Array<{ hash: `sha256:${string}`; size: number }> = [];
    let buffer = new Uint8Array(Math.min(size, CHECKPOINT_CHUNK_BYTES));
    let filled = 0;
    let total = 0;
    for await (const input of source) {
      total += input.byteLength;
      if (total > size) throw new Error('Checkpoint source exceeds expected size');
      let offset = 0;
      while (offset < input.byteLength) {
        const count = Math.min(buffer.byteLength - filled, input.byteLength - offset);
        buffer.set(input.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === buffer.byteLength && size > CHECKPOINT_CHUNK_BYTES) {
          const sealed = await encryptArtifactBytes(buffer, this.key);
          const hash = hashBytes(sealed);
          if (await this.inner.put(`${key}.chunks/${hash.slice(7)}`, sealed) !== hash) throw new Error(`Checkpoint chunk for ${key} failed upload integrity verification`);
          chunks.push({ hash, size: filled });
          buffer = new Uint8Array(Math.max(0, Math.min(size - chunks.length * CHECKPOINT_CHUNK_BYTES, CHECKPOINT_CHUNK_BYTES)));
          filled = 0;
        }
      }
    }
    if (total !== size) throw new Error('Checkpoint source has an unexpected size');
    // Exhaustion also completes the caller's incremental plaintext integrity check.
    if (size <= CHECKPOINT_CHUNK_BYTES) return this.inner.put(key, await encryptArtifactBytes(buffer, this.key));
    const inventory = new TextEncoder().encode(JSON.stringify({ version: 1, size, chunks }));
    const sealed = await encryptArtifactBytes(inventory, this.key);
    const envelope = new Uint8Array(1 + sealed.byteLength);
    envelope[0] = CHUNKED_CHECKPOINT_VERSION;
    envelope.set(sealed, 1);
    return this.inner.put(key, envelope);
  }

  async get(key: string, expectedHash?: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array | null> {
    const source = await this.getStream(key, expectedHash);
    return source === null ? null : collectBytes(source, maxBytes);
  }

  async getStream(key: string, expectedHash?: string, expectedSize?: number): Promise<AsyncIterable<Uint8Array> | null> {
    const manifestLimit = expectedSize === undefined ? 64 * 1024 * 1024 : Math.min(64 * 1024 * 1024, 128 + 128 * Math.ceil(expectedSize / CHECKPOINT_CHUNK_BYTES));
    const limit = expectedSize === undefined ? manifestLimit : expectedSize <= CHECKPOINT_CHUNK_BYTES ? expectedSize + 29 : manifestLimit;
    const sealed = await this.inner.get(key, expectedHash, limit);
    if (!sealed) return null;
    if (sealed.byteLength > limit) throw new Error('Checkpoint ciphertext exceeds byte limit');
    const inner = this.inner;
    const encryptionKey = this.key;
    return (async function* () {
      if (sealed[0] !== CHUNKED_CHECKPOINT_VERSION) {
        const bytes = await decryptArtifactBytes(sealed, encryptionKey);
        if (expectedSize !== undefined && bytes.byteLength !== expectedSize) throw new Error('LFS inventory size does not match object');
        yield bytes;
        return;
      }
      const inventory = await decryptArtifactBytes(sealed.subarray(1), encryptionKey);
      const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
      if (expectedSize !== undefined && manifest.size !== expectedSize) throw new Error('LFS inventory size does not match object');
      for (const chunk of manifest.chunks) {
        const chunkKey = `${key}.chunks/${chunk.hash.slice(7)}`;
        const stored = await inner.get(chunkKey, chunk.hash, chunk.size + 29);
        if (!stored) throw new Error(`Checkpoint chunk ${chunkKey} is missing`);
        if (stored.byteLength !== chunk.size + 29 || hashBytes(stored) !== chunk.hash) throw new Error(`Checkpoint chunk ${chunkKey} failed integrity verification`);
        const plaintext = await decryptArtifactBytes(stored, encryptionKey);
        if (plaintext.byteLength !== chunk.size) throw new Error(`Checkpoint chunk ${chunkKey} has an unexpected size`);
        yield plaintext;
      }
    })();
  }
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}
