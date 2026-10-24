import { z } from 'zod';
import { createHash } from 'node:crypto';
import { DRIVE_FILE_MAX_BYTES, SHA256_STATE_PATTERN, Sha256State, TENANT_OBJECT_PART_BYTES, artifactObjectKey, driveUploadObjectKey } from '@gitspace/protocol';
import { collectBytes, streamBytes } from '@gitspace/protocol-workspace';
import type { TenantExpected, TenantObject, TenantRange, TenantStore } from './tenant-store.js';

/**
 * Drive file bytes: always one SSE-C tenant object, so `/files/` and every reader use R2's own range reads.
 * - A file whose SHA-256 is known before its bytes are stored (small writes; an Inspector upload, which the browser hashes
 *   first; a machine's `fromMachine`, which hashes the local file first) is named by it: `<scope>/sha256/<hex>`, one put
 *   or a multipart upload that records the digest.
 * - A file streamed before its digest is known (`WorkspaceDrive` streams; capture, download and extension uploads across
 *   requests) is one multipart object `<scope>/upload/<id>` of uniform `TENANT_OBJECT_PART_BYTES` parts, hashed as the
 *   parts pass (`Sha256State`, so the hash survives between requests). It records only its scope; its manifest entry
 *   names it (`object`) with the digest and size it is read against. A streamed file of one short part is known whole
 *   before it is stored, so it is named by its digest like any other.
 */

const sha256Schema = z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]);

/** A stored drive file as a manifest entry names it; `size` may be unknown for an earlier version pinned by digest. */
export interface DriveFileRef { blobHash: string; size?: number | undefined; object?: string | undefined }
/** A stored drive file: what a manifest entry records for it. */
export interface DriveFile { blobHash: `sha256:${string}`; size: number; object?: string }

/** A drive file being written across requests, as JSON its writer keeps between them; `append` returns the next one. */
export const DriveUploadSchema = z.object({
  /** The id of the object a file streamed before its digest is known is stored as. */
  id: z.string().uuid(),
  scopeId: z.string().regex(/^space:[A-Za-z0-9._-]{1,128}$/u),
  /** The digest and size the writer declared first: the file is named by them, and finishing refuses other bytes. */
  declared: z.object({ sha256: sha256Schema, size: z.number().int().positive().max(DRIVE_FILE_MAX_BYTES) }).nullable(),
  partBytes: z.number().int().positive().max(TENANT_OBJECT_PART_BYTES),
  /** The R2 multipart upload, from the first full part on. */
  multipart: z.string().min(1).nullable(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) })).max(10_000),
  /** The file was one short part, already stored whole under its digest. */
  whole: z.boolean(),
  size: z.number().int().nonnegative().max(DRIVE_FILE_MAX_BYTES),
  /** The running SHA-256 of the bytes so far, so finishing needs none of them again. */
  sha256: z.string().regex(SHA256_STATE_PATTERN),
});
export type DriveUpload = z.infer<typeof DriveUploadSchema>;

const limit = `Drive files are limited to ${DRIVE_FILE_MAX_BYTES / 1024 / 1024 / 1024} GiB`;

/** Drive files of one account in its tenant store; see the module comment for how each is stored. */
export class DriveFiles {
  constructor(private readonly store: TenantStore, private readonly accountId: string) {}

  /** The object a file is, and for a streamed one the digest and size its reads are checked against. */
  private located(scopeId: string, file: DriveFileRef): { name: string; expected?: TenantExpected } {
    if (!file.object) return { name: artifactObjectKey(this.accountId, scopeId, file.blobHash) };
    return { name: driveUploadObjectKey(this.accountId, scopeId, file.object), expected: { sha256: sha256Schema.parse(file.blobHash), ...(file.size === undefined ? {} : { size: file.size }) } };
  }

  /** The upload's object: named by the declared digest, or by the upload's id. */
  private uploadName(upload: DriveUpload): string {
    return upload.declared ? artifactObjectKey(this.accountId, upload.scopeId, upload.declared.sha256) : driveUploadObjectKey(this.accountId, upload.scopeId, upload.id);
  }

  /** The stored file's digest and size, or null when its object is missing. */
  async head(scopeId: string, file: DriveFileRef): Promise<{ sha256: `sha256:${string}`; size: number } | null> {
    const { name, expected } = this.located(scopeId, file);
    return this.store.head(name, scopeId, expected);
  }

  /** The file's bytes, or one range of them. A whole read fails before its last bytes unless they match the digest. */
  async get(scopeId: string, file: DriveFileRef, range?: TenantRange): Promise<TenantObject | null> {
    const { name, expected } = this.located(scopeId, file);
    return this.store.get(name, scopeId, { ...(range ? { range } : {}), ...(expected ? { expected } : {}) });
  }

  /** A whole file of at most `maxBytes`, verified before it is returned. */
  async bytes(scopeId: string, file: DriveFileRef, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
    const object = await this.get(scopeId, file);
    if (!object) return null;
    if (object.size > maxBytes) {
      await object.body.cancel();
      throw new Error(`Drive file exceeds ${maxBytes} bytes`);
    }
    return collectBytes(streamBytes(object.body), maxBytes);
  }

  /** Stores bytes held whole under their digest. */
  async put(scopeId: string, bytes: Uint8Array): Promise<DriveFile> {
    const stored = await this.store.put(artifactObjectKey(this.accountId, scopeId, `sha256:${createHash('sha256').update(bytes).digest('hex')}`), scopeId, bytes);
    if (!stored) throw new Error('Drive file was not stored');
    return { blobHash: stored.sha256, size: stored.size };
  }

  /** Copies a file into another scope under its digest, streaming it; R2 refuses bytes that miss the digest. */
  async copy(from: { scopeId: string; file: DriveFileRef }, toScopeId: string): Promise<DriveFile> {
    const source = await this.get(from.scopeId, from.file);
    if (source && from.file.size !== undefined && source.size !== from.file.size) {
      await source.body.cancel();
      throw new Error('Drive file differs from its recorded size');
    }
    if (!source) throw new Error('Drive file is unavailable');
    const stored = await this.store.put(artifactObjectKey(this.accountId, toScopeId, source.sha256), toScopeId, { stream: source.body, size: source.size, sha256: source.sha256 });
    if (!stored) throw new Error('Drive file was not stored');
    return { blobHash: stored.sha256, size: stored.size };
  }

  /** Stores a stream as it arrives, holding one part at a time: whole under its digest when it fits one part. */
  async write(scopeId: string, source: ReadableStream<Uint8Array>, partBytes = TENANT_OBJECT_PART_BYTES): Promise<DriveFile> {
    let upload = this.begin(scopeId, { partBytes });
    const buffer = new Uint8Array(partBytes);
    let used = 0;
    try {
      for await (const bytes of streamBytes(source)) {
        for (let offset = 0; offset < bytes.byteLength;) {
          // A full part is sent only once more bytes follow it: a stream of exactly one part is stored whole.
          if (used === partBytes) {
            upload = await this.append(upload, buffer);
            used = 0;
          }
          const count = Math.min(partBytes - used, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + count), used);
          used += count;
          offset += count;
        }
        if (upload.size + used > DRIVE_FILE_MAX_BYTES) throw new Error(limit);
      }
      if (upload.size === 0) return await this.put(scopeId, buffer.subarray(0, used));
      if (used) upload = await this.append(upload, buffer.subarray(0, used));
      return await this.finish(upload);
    } catch (error) {
      await this.discard(upload).catch(() => undefined);
      throw error;
    }
  }

  /** A new upload into the scope; nothing is stored until `append`. With `declared`, the file is named by that digest. */
  begin(scopeId: string, options: { declared?: { sha256: string; size: number }; partBytes?: number } = {}): DriveUpload {
    return DriveUploadSchema.parse({
      id: crypto.randomUUID(), scopeId, declared: options.declared ?? null, partBytes: options.partBytes ?? TENANT_OBJECT_PART_BYTES,
      multipart: null, parts: [], whole: false, size: 0, sha256: new Sha256State().save(),
    });
  }

  /** Stores the next bytes as parts and returns the upload after them. Every append but the last holds a multiple of
   * `partBytes`; a shorter one ends the upload. Appending the same bytes to the same upload again resends the same parts. */
  async append(upload: DriveUpload, bytes: Uint8Array): Promise<DriveUpload> {
    const current = DriveUploadSchema.parse(upload);
    if (!bytes.byteLength) return current;
    if (current.whole || current.size % current.partBytes) throw new Error('Only the last part of a drive upload may be shorter than its part size');
    const size = current.size + bytes.byteLength;
    if (size > (current.declared?.size ?? DRIVE_FILE_MAX_BYTES)) throw new Error(current.declared ? 'The upload exceeds its declared size' : limit);
    const sha256 = new Sha256State(current.sha256).update(bytes);
    if (current.size === 0 && bytes.byteLength < current.partBytes) {
      // The whole file in one short part: its digest is known before it is stored.
      if (current.declared && sha256.digest() !== current.declared.sha256) throw new Error('The uploaded bytes do not match their declared SHA-256');
      await this.put(current.scopeId, bytes);
      return { ...current, whole: true, size, sha256: sha256.save() };
    }
    const name = this.uploadName(current);
    const multipart = current.multipart ?? await this.store.createMultipart(name, current.scopeId, current.declared);
    const parts = [...current.parts];
    for (let offset = 0; offset < bytes.byteLength; offset += current.partBytes) {
      const { partNumber, etag } = await this.store.uploadPart(name, current.scopeId, multipart, (current.size + offset) / current.partBytes + 1, bytes.subarray(offset, offset + current.partBytes));
      parts.push({ partNumber, etag });
    }
    return { ...current, multipart, parts, size, sha256: sha256.save() };
  }

  /** Completes the upload as one object and returns the file a manifest entry names. Finishing the same upload again
   * returns the same file. */
  async finish(upload: DriveUpload): Promise<DriveFile> {
    const current = DriveUploadSchema.parse(upload);
    const sha256 = new Sha256State(current.sha256).digest();
    if (current.declared && (sha256 !== current.declared.sha256 || current.size !== current.declared.size)) {
      await this.discard(current).catch(() => undefined);
      throw new Error('The uploaded bytes do not match their declared SHA-256 and size');
    }
    if (current.whole) return { blobHash: sha256, size: current.size };
    if (!current.multipart) return this.put(current.scopeId, new Uint8Array());
    const name = this.uploadName(current);
    const expected = current.declared ? undefined : { sha256, size: current.size };
    try {
      await this.store.completeMultipart(name, current.scopeId, current.multipart, current.parts, expected);
    } catch (error) {
      // A retried finish: the first one completed the upload, and the object is there.
      if (!await this.store.head(name, current.scopeId, expected).catch(() => null)) throw error;
    }
    return { blobHash: sha256, size: current.size, ...(current.declared ? {} : { object: current.id }) };
  }

  /** Abandons an unfinished upload's parts; R2 also drops unfinished uploads after a week. */
  async discard(upload: DriveUpload): Promise<void> {
    if (upload.multipart) await this.store.abortMultipart(this.uploadName(upload), upload.scopeId, upload.multipart);
  }
}
