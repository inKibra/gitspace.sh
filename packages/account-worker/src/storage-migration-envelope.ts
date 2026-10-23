import { createDecipheriv, createHash } from 'node:crypto';
import type { DecipherGCM, Hash } from 'node:crypto';
import { streamBytes } from '@gitspace/protocol-workspace';
import { z } from 'zod';

/**
 * The retired artifact envelope, read only by the storage migration and deleted with it: `[1][12-byte nonce][AES-GCM
 * ciphertext + 16-byte tag]` under a key the machine also held, and its chunked form `[2][envelope of a JSON chunk
 * inventory]` whose 32 MiB plaintext chunks are envelopes of their own, named by the SHA-256 of their sealed bytes.
 */
export const LEGACY_SINGLE = 1;
export const LEGACY_CHUNKED = 2;
export const LEGACY_CHUNK_BYTES = 32 * 1024 * 1024;
export const LEGACY_OVERHEAD = 29;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The key does not authenticate the object: under GCM, it is not the key the object was sealed with. */
export class LegacyKeyMismatch extends Error {
  constructor() {
    super('The key does not open this object');
    this.name = 'LegacyKeyMismatch';
  }
}

export const legacyInventorySchema = z.object({
  version: z.literal(1),
  size: z.number().int().min(LEGACY_CHUNK_BYTES + 1),
  chunks: z.array(z.object({
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    size: z.number().int().positive().max(LEGACY_CHUNK_BYTES),
  }).strict()).min(2),
}).strict().superRefine((inventory, context) => {
  if (inventory.chunks.length !== Math.ceil(inventory.size / LEGACY_CHUNK_BYTES)
    || inventory.chunks.some((chunk, index) => chunk.size !== Math.min(LEGACY_CHUNK_BYTES, inventory.size - index * LEGACY_CHUNK_BYTES))) {
    context.addIssue({ code: 'custom', message: 'Chunk inventory does not cover its size with canonical boundaries' });
  }
});
export type LegacyInventory = z.infer<typeof legacyInventorySchema>;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The old flat, account-relative name of a drive object: one namespace for every scope, named by its sealed bytes. */
export function legacyDriveName(userId: string, hash: string): string {
  const account = btoa(String.fromCharCode(...new TextEncoder().encode(userId))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `accounts/${account}/artifacts/sha256/${hash.slice('sha256:'.length)}`;
}

/** The per-scope key the old format derived from the tenant's artifact key. */
export async function legacyScopeKey(artifactKey: Uint8Array, scope: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', Uint8Array.from(artifactKey), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('gitspace-artifacts-v1'), info: new TextEncoder().encode(scope),
  }, material, 256));
}

/** Authenticates and opens one single envelope. */
export async function openLegacyEnvelope(sealed: Uint8Array<ArrayBuffer>, key: Uint8Array): Promise<Uint8Array> {
  if (sealed.byteLength < LEGACY_OVERHEAD || sealed[0] !== LEGACY_SINGLE) throw new Error('Object is not a single legacy envelope');
  const cryptoKey = await crypto.subtle.importKey('raw', Uint8Array.from(key), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(1, 1 + NONCE_BYTES) }, cryptoKey, sealed.subarray(1 + NONCE_BYTES)));
  } catch {
    throw new LegacyKeyMismatch();
  }
}

/** Authenticates a chunked root and returns its chunk inventory. */
export async function openLegacyInventory(root: Uint8Array<ArrayBuffer>, key: Uint8Array): Promise<LegacyInventory> {
  if (root[0] !== LEGACY_CHUNKED) throw new Error('Object is not a chunked legacy root');
  const inventory = await openLegacyEnvelope(root.subarray(1), key);
  return legacyInventorySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
}

/**
 * Opens a single envelope too large to hold, streaming, and adds its sealed bytes to `sealedDigest`. Workerd's
 * incremental GCM needs the tag before `update()`, so it is read first from the same object version. Yielded bytes are
 * unauthenticated until the generator returns: the tag is checked last and a mismatch throws, so a consumer publishes
 * nothing before exhausting it.
 */
export async function* streamLegacyEnvelope(bucket: R2Bucket, key: string, etag: string, size: number, scopeKey: Uint8Array, sealedDigest?: Hash): AsyncGenerator<Uint8Array> {
  if (size < LEGACY_OVERHEAD) throw new Error('Object is not a single legacy envelope');
  const suffix = await bucket.get(key, { range: { suffix: TAG_BYTES }, onlyIf: { etagMatches: etag } });
  if (!suffix || !('body' in suffix)) throw new Error('Legacy object changed during read');
  const tag = new Uint8Array(await suffix.arrayBuffer());
  const object = await bucket.get(key, { onlyIf: { etagMatches: etag } });
  if (!object || !('body' in object)) throw new Error('Legacy object changed during read');
  const header = new Uint8Array(1 + NONCE_BYTES);
  let decipher: DecipherGCM | undefined;
  let offset = 0;
  for await (const bytes of streamBytes(object.body)) {
    const end = offset + bytes.byteLength;
    if (end > size) throw new Error('Legacy object size changed during read');
    sealedDigest?.update(bytes);
    if (offset < header.byteLength) {
      header.set(bytes.subarray(0, Math.min(bytes.byteLength, header.byteLength - offset)), offset);
      if (end >= header.byteLength) {
        if (header[0] !== LEGACY_SINGLE) throw new Error('Object is not a single legacy envelope');
        decipher = createDecipheriv('aes-256-gcm', scopeKey, header.subarray(1));
        decipher.setAuthTag(tag);
      }
    }
    const start = Math.max(offset, header.byteLength);
    const stop = Math.min(end, size - TAG_BYTES);
    if (decipher && stop > start) yield new Uint8Array(decipher.update(bytes.subarray(start - offset, stop - offset)));
    offset = end;
  }
  if (offset !== size || !decipher) throw new Error('Legacy object size changed during read');
  let final: Uint8Array;
  try {
    final = decipher.final();
  } catch {
    throw new LegacyKeyMismatch();
  }
  if (final.byteLength) yield new Uint8Array(final);
}
