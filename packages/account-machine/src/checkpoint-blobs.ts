export type BlobHash = `sha256:${string}`;

/** The attached workspace a drive object request is made for; the account authorizes its drive scopes from it. */
export interface DataWorkspace { projectId: string; workspaceId: string }

/**
 * Plaintext tenant objects in account storage, named by their storage keys. The account encrypts them at rest under
 * the scope it derives from the key; every stored object records its plaintext SHA-256 and size, and every read is
 * verified against them. Drive objects also name the workspace whose attachment authorizes them.
 */
export interface CheckpointBlobStore {
  /** Stores the bytes unless the key already holds them; returns their SHA-256. */
  put(key: string, bytes: Uint8Array, workspace?: DataWorkspace): Promise<BlobHash>;
  /** The complete object, verified against its recorded hash and size and, when given, the expected hash. */
  get(key: string, expectedHash?: string, maxBytes?: number, workspace?: DataWorkspace): Promise<Uint8Array | null>;
}

/** Objects too large to hold whole: uploads above one request travel in uniform parts. */
export interface StreamingBlobStore extends CheckpointBlobStore {
  /** Uploads exactly `size` bytes with SHA-256 `hash` from the source; returns the hash. */
  putStream(key: string, source: AsyncIterable<Uint8Array>, expected: { size: number; hash: string }): Promise<BlobHash>;
  /** The object's bytes; the last pull fails unless they match the recorded and the expected hash and size. */
  getStream(key: string, expected: { hash: string; size: number }): Promise<AsyncIterable<Uint8Array> | null>;
}

export function hashBytes(bytes: Uint8Array): BlobHash {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

/**
 * Passes a source through while counting and hashing it; the last pull fails unless the source had exactly the
 * expected size and hash. Bytes released before that are unverified, so consumers commit only after exhaustion.
 */
export async function* verifiedBytes(source: AsyncIterable<Uint8Array>, expected: { hash: string; size: number }, label: string): AsyncGenerator<Uint8Array> {
  const hasher = new Bun.CryptoHasher('sha256');
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > expected.size) throw new Error(`${label} exceeds its recorded size`);
    hasher.update(chunk);
    yield chunk;
  }
  if (size !== expected.size || `sha256:${hasher.digest('hex')}` !== expected.hash) throw new Error(`${label} failed integrity verification`);
}
