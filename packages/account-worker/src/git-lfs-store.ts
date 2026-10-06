import { createHash } from 'node:crypto';
import { credentialProtocolBase64, decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes } from '@gitspace/protocol';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, collectBytes, streamBytes, chunkedCheckpointManifestSchema, GitLfsObjectSchema, projectStorageRoot, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';

export function gitLfsObjectKey(projectId: string, oid: string): string {
  GitLfsObjectSchema.shape.oid.parse(oid);
  return `lfs/${projectStorageRoot(projectId)}/objects/${oid}`;
}

const ENCRYPTION_OVERHEAD = 29;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024 - ENCRYPTION_OVERHEAD - 1;
const MAX_PORTABLE_BYTES = 64 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function* verified(source: AsyncIterable<Uint8Array>, object: GitLfsObject): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of source) {
    size += bytes.byteLength;
    if (size > object.size) throw new Error('LFS object failed oid/size verification');
    hash.update(bytes);
    yield bytes;
  }
  if (size !== object.size || hash.digest('hex') !== object.oid) throw new Error('LFS object failed oid/size verification');
}

async function readEnvelope(stored: R2ObjectBody, expectedSize?: number): Promise<Uint8Array> {
  const maximum = expectedSize === undefined ? MAX_PORTABLE_BYTES
    : expectedSize <= CHECKPOINT_CHUNK_BYTES ? expectedSize + ENCRYPTION_OVERHEAD
    : Math.min(MAX_PORTABLE_BYTES, 128 + 128 * Math.ceil(expectedSize / CHECKPOINT_CHUNK_BYTES));
  if (stored.size > maximum) {
    await stored.body.cancel();
    throw new Error('Checkpoint envelope exceeds byte limit');
  }
  async function* bounded() {
    let limit = maximum;
    let size = 0;
    for await (const bytes of streamBytes(stored.body)) {
      if (!bytes.byteLength) continue;
      if (!size && bytes[0] === CHUNKED_CHECKPOINT_VERSION) limit = Math.min(maximum, MAX_INVENTORY_BYTES + ENCRYPTION_OVERHEAD + 1);
      size += bytes.byteLength;
      if (stored.size > limit || size > limit) throw new Error('Checkpoint envelope exceeds byte limit');
      yield bytes;
    }
  }
  return collectBytes(bounded(), maximum);
}

export class AccountGitLfsStore implements GitLfsStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly userId: string,
    private readonly projectId: string,
    private readonly key: Uint8Array,
    private readonly pin: (object: GitLfsObject) => Promise<void>,
    private readonly release?: () => Promise<void>,
  ) {}

  private path(object: GitLfsObject): string { return `users/${this.userId}/${gitLfsObjectKey(this.projectId, object.oid)}`; }

  async has(object: GitLfsObject): Promise<boolean> {
    const source = await this.get(object);
    if (!source) return false;
    for await (const _bytes of source) { /* Exhaust to verify integrity. */ }
    return true;
  }

  async releasePublication(): Promise<void> {
    if (!this.release) throw new Error('LFS publication release is not configured');
    await this.release();
  }

  async get(object: GitLfsObject): Promise<AsyncIterable<Uint8Array> | null> {
    GitLfsObjectSchema.parse(object);
    const source = await streamEncryptedCheckpoint(this.bucket, this.path(object), this.key, undefined, object.size);
    return source ? verified(source, object) : null;
  }

  async put(object: GitLfsObject, source: AsyncIterable<Uint8Array>): Promise<void> {
    GitLfsObjectSchema.parse(object);
    await this.pin(object);
    if (await this.has(object)) {
      for await (const _bytes of verified(source, object)) { /* Validate duplicate uploads too. */ }
      return;
    }
    const path = this.path(object);
    const uploadedChunkKeys: string[] = [];
    let publication: 'not-attempted' | 'unknown' | 'lost' | 'won' = 'not-attempted';
    try {
      const chunks: Array<{ hash: `sha256:${string}`; size: number }> = [];
      const chunked = object.size > CHECKPOINT_CHUNK_BYTES;
      if (Math.ceil(object.size / CHECKPOINT_CHUNK_BYTES) * 128 + 128 > MAX_INVENTORY_BYTES) throw new Error('LFS inventory exceeds byte limit');
      const buffer = new Uint8Array(Math.min(object.size, CHECKPOINT_CHUNK_BYTES));
      let used = 0;
      const uploadChunk = async (plaintext: Uint8Array) => {
        const ciphertext = await encryptArtifactBytes(plaintext, this.key);
        const hash = `sha256:${digest(ciphertext)}` as const;
        const chunkKey = `${path}.chunks/${hash.slice(7)}`;
        uploadedChunkKeys.push(chunkKey);
        await this.bucket.put(chunkKey, ciphertext, { customMetadata: { sha256: hash } });
        chunks.push({ hash, size: plaintext.byteLength });
      };
      for await (const bytes of verified(source, object)) {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = Math.min(buffer.byteLength - used, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + count), used);
          used += count;
          offset += count;
          if (chunked && used === buffer.byteLength) {
            await uploadChunk(buffer);
            used = 0;
          }
        }
      }
      let envelope: Uint8Array;
      if (!chunked) envelope = await encryptArtifactBytes(buffer, this.key);
      else {
        if (used) await uploadChunk(buffer.subarray(0, used));
        const inventory = new TextEncoder().encode(JSON.stringify({ version: 1, size: object.size, chunks }));
        if (inventory.byteLength > MAX_INVENTORY_BYTES) throw new Error('LFS inventory exceeds byte limit');
        const sealed = await encryptArtifactBytes(inventory, this.key);
        envelope = new Uint8Array(1 + sealed.byteLength);
        envelope[0] = CHUNKED_CHECKPOINT_VERSION;
        envelope.set(sealed, 1);
      }
      const hash = `sha256:${await digest(envelope)}`;
      publication = 'unknown';
      const stored = await this.bucket.put(path, envelope, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: hash } });
      publication = stored === null ? 'lost' : 'won';
      // A concurrent publisher may have won with independently encrypted bytes.
      if (!await this.has(object)) throw new Error('LFS object publication did not persist');
    } finally {
      if (publication !== 'won' && uploadedChunkKeys.length) {
        await this.removeUnpublishedChunks(path, uploadedChunkKeys, publication === 'unknown');
      }
    }
  }

  private async removeUnpublishedChunks(path: string, uploadedChunkKeys: readonly string[], uncertainPublication: boolean): Promise<void> {
    const stored = await this.bucket.get(path);
    // A rejected request may still complete remotely. Absence is not proof that
    // its manifest cannot appear later; retain chunks until fenced collection.
    if (!stored && uncertainPublication) return;
    const referenced = new Set<string>();
    if (stored) {
      const envelope = await readEnvelope(stored);
      if (envelope[0] === CHUNKED_CHECKPOINT_VERSION) {
        const inventory = await decryptArtifactBytes(envelope.subarray(1), this.key);
        const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
        for (const chunk of manifest.chunks) referenced.add(`${path}.chunks/${chunk.hash.slice(7)}`);
      } else {
        // Authenticate the existing envelope before treating it as unchunked.
        await decryptArtifactBytes(envelope, this.key);
      }
    }
    // Never list/delete a prefix: another attempt may still be uploading.
    const unused = uploadedChunkKeys.filter(key => !referenced.has(key));
    for (let offset = 0; offset < unused.length; offset += 1000) {
      await this.bucket.delete(unused.slice(offset, offset + 1000));
    }
  }
}

export async function createAccountGitLfsStore(env: Env, userId: string, projectId: string, publicationId: string): Promise<AccountGitLfsStore> {
  if (userId !== env.ACCOUNT_ID) throw new Error('LFS account identity mismatch');
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.getProject();
  if (!project || project.id !== projectId || project.lifecycle === 'deleting') throw new Error('LFS project is unavailable');
  const accountKey = credentialProtocolBase64.decode(await env.CREDENTIALS.getByName(userId).artifactKey(userId));
  const key = await deriveArtifactScopeKey(accountKey, `lfs:${projectId}`);
  return new AccountGitLfsStore(
    env.DATA, userId, projectId, key,
    object => authority.lfsPin({ publicationId, objects: [object] }),
    () => authority.lfsReleasePublication(publicationId),
  );
}

/** Called only while project authority excludes new pins, after durable references reach zero. */
export async function deleteGitLfsObject(bucket: R2Bucket, userId: string, projectId: string, object: GitLfsObject): Promise<void> {
  const path = `users/${userId}/${gitLfsObjectKey(projectId, object.oid)}`;
  await bucket.delete(path);
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${path}.chunks/`, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) await bucket.delete(page.objects.map(item => item.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function streamEncryptedCheckpoint(bucket: R2Bucket, path: string, key: Uint8Array, expectedHash?: string, expectedSize?: number): Promise<AsyncIterable<Uint8Array> | null> {
  const stored = await bucket.get(path);
  if (!stored) return null;
  const sealed = await readEnvelope(stored, expectedSize);
  if (expectedHash && `sha256:${digest(sealed)}` !== expectedHash) throw new Error('Checkpoint failed ciphertext integrity verification');
  if (sealed[0] !== CHUNKED_CHECKPOINT_VERSION) {
    const plaintext = await decryptArtifactBytes(sealed, key);
    if (expectedSize !== undefined && plaintext.byteLength !== expectedSize) throw new Error('LFS object failed oid/size verification');
    return (async function* () { yield plaintext; })();
  }
  const inventory = await decryptArtifactBytes(sealed.subarray(1), key);
  const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
  if (expectedSize !== undefined && manifest.size !== expectedSize) throw new Error('LFS inventory size does not match object');
  if (expectedSize === undefined && manifest.size > MAX_PORTABLE_BYTES) throw new Error('Checkpoint exceeds byte limit');
  return (async function* () {
    for (const chunk of manifest.chunks) {
      const storedChunk = await bucket.get(`${path}.chunks/${chunk.hash.slice(7)}`);
      if (!storedChunk) throw new Error('Checkpoint chunk is missing');
      const limit = chunk.size + ENCRYPTION_OVERHEAD;
      if (storedChunk.size > limit) {
        await storedChunk.body.cancel();
        throw new Error('Checkpoint chunk exceeds byte limit');
      }
      const ciphertext = await collectBytes(streamBytes(storedChunk.body), limit);
      if (`sha256:${digest(ciphertext)}` !== chunk.hash) throw new Error('Checkpoint chunk failed integrity verification');
      const plaintext = await decryptArtifactBytes(ciphertext, key);
      if (plaintext.byteLength !== chunk.size) throw new Error('Checkpoint chunk size does not match inventory');
      yield plaintext;
    }
  })();
}

/** Bounded byte wrapper for portable metadata consumers; LFS uses the streaming path. */
export async function readEncryptedCheckpoint(bucket: R2Bucket, path: string, key: Uint8Array, expectedHash?: string, expectedSize?: number): Promise<Uint8Array | null> {
  if (expectedSize !== undefined && expectedSize > MAX_PORTABLE_BYTES) throw new Error('Checkpoint exceeds byte limit');
  const source = await streamEncryptedCheckpoint(bucket, path, key, expectedHash, expectedSize);
  return source ? collectBytes(source, expectedSize ?? MAX_PORTABLE_BYTES) : null;
}
