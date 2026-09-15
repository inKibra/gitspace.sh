import type { ArtifactObjectStore } from '@gitspace/core';
import type { CheckpointBlobStore } from './portable-space-lifecycle.js';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** Stores already-encrypted artifact blobs and manifests through account-authenticated cloud data. */
export class CloudArtifactObjectStore implements ArtifactObjectStore {
  private readonly prefix: string;

  constructor(accountId: string, private readonly blobs: CheckpointBlobStore) {
    if (!accountId) throw new Error('Cloud artifact storage requires an account id');
    this.prefix = `accounts/${Buffer.from(accountId).toString('base64url')}/artifacts/sha256/`;
  }

  async put(hash: `sha256:${string}`, sealed: Uint8Array): Promise<void> {
    const key = this.key(hash);
    const actualHash = `sha256:${new Bun.CryptoHasher('sha256').update(sealed).digest('hex')}`;
    if (actualHash !== hash) throw new Error(`Artifact ${hash} failed content verification before upload`);
    const persistedHash = await this.blobs.put(key, sealed);
    if (persistedHash !== hash) throw new Error(`Artifact ${hash} upload returned a mismatched content hash`);
  }

  get(hash: `sha256:${string}`): Promise<Uint8Array | null> {
    return this.blobs.get(this.key(hash), hash);
  }

  private key(hash: `sha256:${string}`): string {
    if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid artifact hash ${hash}`);
    return `${this.prefix}${hash.slice('sha256:'.length)}`;
  }
}
