import { credentialProtocolBase64, decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes } from '@gitspace/protocol';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, chunkedCheckpointManifestSchema, GitLfsObjectSchema, projectStorageRoot, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';

export function gitLfsObjectKey(projectId: string, oid: string): string {
  GitLfsObjectSchema.shape.oid.parse(oid);
  return `lfs/${projectStorageRoot(projectId)}/objects/${oid}`;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verify(object: GitLfsObject, bytes: Uint8Array): Promise<void> {
  GitLfsObjectSchema.parse(object);
  if (bytes.byteLength !== object.size || await digest(bytes) !== object.oid) throw new Error('LFS object failed oid/size verification');
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

  async has(object: GitLfsObject): Promise<boolean> { return await this.get(object) !== null; }

  async releasePublication(): Promise<void> {
    if (!this.release) throw new Error('LFS publication release is not configured');
    await this.release();
  }

  async get(object: GitLfsObject): Promise<Uint8Array | null> {
    GitLfsObjectSchema.parse(object);
    const path = this.path(object);
    const bytes = await readEncryptedCheckpoint(this.bucket, path, this.key, undefined, object.size);
    if (!bytes) return null;
    await verify(object, bytes);
    return bytes;
  }

  async put(object: GitLfsObject, bytes: Uint8Array): Promise<void> {
    await verify(object, bytes);
    await this.pin(object);
    if (await this.has(object)) return;
    const path = this.path(object);
    const uploadedChunkKeys: string[] = [];
    let publication: 'not-attempted' | 'unknown' | 'lost' | 'won' = 'not-attempted';
    try {
      let envelope: Uint8Array;
      if (bytes.byteLength <= CHECKPOINT_CHUNK_BYTES) envelope = await encryptArtifactBytes(bytes, this.key);
      else {
        const chunks: Array<{ hash: `sha256:${string}`; size: number }> = [];
        for (let offset = 0; offset < bytes.byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
          const plaintext = bytes.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES);
          const ciphertext = await encryptArtifactBytes(plaintext, this.key);
          const hash = `sha256:${await digest(ciphertext)}` as const;
          const chunkKey = `${path}.chunks/${hash.slice(7)}`;
          // Include writes whose response is lost after the chunk has persisted.
          uploadedChunkKeys.push(chunkKey);
          await this.bucket.put(chunkKey, ciphertext, { customMetadata: { sha256: hash } });
          chunks.push({ hash, size: plaintext.byteLength });
        }
        const sealed = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify({ version: 1, size: bytes.byteLength, chunks })), this.key);
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
      const envelope = new Uint8Array(await stored.arrayBuffer());
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

export async function readEncryptedCheckpoint(bucket: R2Bucket, path: string, key: Uint8Array, expectedHash?: string, expectedSize?: number): Promise<Uint8Array | null> {
  const stored = await bucket.get(path);
  if (!stored) return null;
  const sealed = new Uint8Array(await stored.arrayBuffer());
  if (expectedHash && `sha256:${await digest(sealed)}` !== expectedHash) throw new Error('Checkpoint failed ciphertext integrity verification');
  if (sealed[0] !== CHUNKED_CHECKPOINT_VERSION) return decryptArtifactBytes(sealed, key);
  const inventory = await decryptArtifactBytes(sealed.subarray(1), key);
  const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
  if (expectedSize !== undefined && manifest.size !== expectedSize) throw new Error('LFS inventory size does not match object');
  const bytes = new Uint8Array(manifest.size);
  let offset = 0;
  for (const chunk of manifest.chunks) {
    const storedChunk = await bucket.get(`${path}.chunks/${chunk.hash.slice(7)}`);
    if (!storedChunk) throw new Error('Checkpoint chunk is missing');
    const ciphertext = new Uint8Array(await storedChunk.arrayBuffer());
    if (`sha256:${await digest(ciphertext)}` !== chunk.hash) throw new Error('Checkpoint chunk failed integrity verification');
    const plaintext = await decryptArtifactBytes(ciphertext, key);
    if (plaintext.byteLength !== chunk.size) throw new Error('Checkpoint chunk size does not match inventory');
    bytes.set(plaintext, offset);
    offset += plaintext.byteLength;
  }
  return bytes;
}
