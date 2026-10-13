import { createDecipheriv, createHash, type DecipherGCM } from 'node:crypto';
import { ARTIFACT_ENCRYPTION_VERSION, ARTIFACT_NONCE_BYTES, decryptArtifactBytes } from '@gitspace/protocol';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, chunkedCheckpointManifestSchema } from '@gitspace/protocol-workspace';

const ENCRYPTION_OVERHEAD = 29;

/** Artifacts use one flat content-addressed namespace, including encrypted parts. */
async function openSealedArtifact(env: Env, userId: string, hash: string): Promise<R2ObjectBody> {
  if (userId !== env.ACCOUNT_ID || !/^sha256:[a-f0-9]{64}$/u.test(hash)) throw new Error('Artifact object identity is invalid');
  const object = await env.DATA.get(`users/${userId}/accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${hash.slice(7)}`);
  if (!object) throw new Error('Artifact object is unavailable');
  return object;
}

async function readSealedBytes(object: R2ObjectBody, hash: string, maximum: number): Promise<Uint8Array> {
  if (object.size > maximum) { await object.body.cancel(); throw new Error('Artifact object exceeds byte limit'); }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== hash) throw new Error('Artifact object failed content verification');
  return bytes;
}

/**
 * Old single envelopes have one authentication tag, even above the chunk threshold.
 * Keep only the output plus bounded R2/decipher chunks, not a full ciphertext copy.
 * No plaintext escapes until both the content address and GCM tag are verified.
 */
async function readLargeLegacyArtifact(env: Env, object: R2ObjectBody, hash: string, key: Uint8Array, expectedSize?: number): Promise<Uint8Array> {
  const reader = object.body.getReader();
  try {
    if (key.byteLength !== 32) throw new RangeError('Artifact encryption key must be 32 bytes');
    const size = object.size - ENCRYPTION_OVERHEAD;
    if (size < 0 || (expectedSize !== undefined && size !== expectedSize)) throw new Error('Artifact size mismatch');
    // Workerd's incremental GCM implementation requires the tag before update().
    // Fetch only the suffix of this same object version, never another full copy.
    const suffix = await env.DATA.get(object.key, { range: { suffix: 16 }, onlyIf: { etagMatches: object.etag } });
    if (!suffix || !('body' in suffix)) throw new Error('Artifact object changed during read');
    const authTag = new Uint8Array(await suffix.arrayBuffer());
    if (authTag.byteLength !== 16) throw new Error('Artifact size mismatch');
    const header = new Uint8Array(1 + ARTIFACT_NONCE_BYTES);
    const tag = new Uint8Array(16);
    const digest = createHash('sha256');
    let decipher: DecipherGCM | undefined;
    let plaintext: Uint8Array | undefined;
    let offset = 0;
    let written = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      const end = offset + bytes.byteLength;
      if (end > object.size) throw new Error('Artifact size mismatch');
      digest.update(bytes);
      if (offset < header.byteLength) {
        header.set(bytes.subarray(0, Math.min(bytes.byteLength, header.byteLength - offset)), offset);
        if (end > 0 && header[0] !== ARTIFACT_ENCRYPTION_VERSION) throw new Error('Artifact object exceeds byte limit');
        if (end >= header.byteLength) {
          decipher = createDecipheriv('aes-256-gcm', key, header.subarray(1));
          decipher.setAuthTag(authTag);
          plaintext = new Uint8Array(size);
        }
      }
      const start = Math.max(offset, header.byteLength);
      const stop = Math.min(end, object.size - tag.byteLength);
      if (stop > start) {
        const part = decipher!.update(bytes.subarray(start - offset, stop - offset));
        plaintext!.set(part, written);
        written += part.byteLength;
      }
      const tagStart = Math.max(offset, object.size - tag.byteLength);
      if (end > tagStart) tag.set(bytes.subarray(tagStart - offset), tagStart - (object.size - tag.byteLength));
      offset = end;
    }
    if (offset !== object.size || !decipher || !plaintext) throw new Error('Artifact size mismatch');
    if (`sha256:${digest.digest('hex')}` !== hash) throw new Error('Artifact object failed content verification');
    if (!tag.every((byte, index) => byte === authTag[index])) throw new Error('Artifact object changed during read');
    const final = decipher.final();
    plaintext.set(final, written);
    if (written + final.byteLength !== size) throw new Error('Artifact size mismatch');
    return plaintext;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function readPart(env: Env, userId: string, hash: string, size: number, key: Uint8Array): Promise<Uint8Array> {
  const sealed = await readSealedBytes(await openSealedArtifact(env, userId, hash), hash, size + ENCRYPTION_OVERHEAD);
  if (sealed.byteLength !== size + ENCRYPTION_OVERHEAD) throw new Error('Artifact part size mismatch');
  const plaintext = await decryptArtifactBytes(sealed, key);
  if (plaintext.byteLength !== size) throw new Error('Artifact part size mismatch');
  return plaintext;
}

/** Authenticates one part at a time. Exhaust the iterable to verify the complete object. */
export async function readArtifactObject(env: Env, userId: string, hash: string, key: Uint8Array, expectedSize?: number): Promise<AsyncIterable<Uint8Array>> {
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) throw new Error('Artifact size is invalid');
  const maximum = expectedSize === undefined ? CHECKPOINT_CHUNK_BYTES + ENCRYPTION_OVERHEAD + 1
    : expectedSize <= CHECKPOINT_CHUNK_BYTES ? expectedSize + ENCRYPTION_OVERHEAD
    : Math.min(64 * 1024 * 1024, 128 + 128 * Math.ceil(expectedSize / CHECKPOINT_CHUNK_BYTES));
  const object = await openSealedArtifact(env, userId, hash);
  if (object.size > maximum) {
    const plaintext = await readLargeLegacyArtifact(env, object, hash, key, expectedSize);
    return (async function* () { yield plaintext; })();
  }
  const sealed = await readSealedBytes(object, hash, maximum);
  if (sealed[0] !== CHUNKED_CHECKPOINT_VERSION) {
    const plaintext = await decryptArtifactBytes(sealed, key);
    if (expectedSize !== undefined && plaintext.byteLength !== expectedSize) throw new Error('Artifact size mismatch');
    return (async function* () { yield plaintext; })();
  }
  const inventory = await decryptArtifactBytes(sealed.subarray(1), key);
  const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
  if (expectedSize !== undefined && manifest.size !== expectedSize) throw new Error('Artifact inventory size mismatch');
  return (async function* () {
    for (const part of manifest.chunks) yield await readPart(env, userId, part.hash, part.size, key);
  })();
}

/** Artifact manifests themselves are single encrypted metadata objects. */
export async function readArtifactManifestObject(env: Env, userId: string, hash: string, key: Uint8Array): Promise<Uint8Array> {
  return decryptArtifactBytes(await readSealedBytes(await openSealedArtifact(env, userId, hash), hash, 64 * 1024 * 1024), key);
}
