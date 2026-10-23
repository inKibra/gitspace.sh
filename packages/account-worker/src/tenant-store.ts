import { createHash, type Hash } from 'node:crypto';
import { TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { collectBytes, streamBytes } from '@gitspace/protocol-workspace';

/**
 * The only code that touches DATA for tenant objects. Every object lives at `sse/users/<account>/<name>`, encrypted at
 * rest by R2 (SSE-C) with its scope's key from the credential vault, and records its scope and plaintext SHA-256 and size
 * at creation. A full read verifies both before releasing its last bytes; a range read trusts R2.
 */

export type Sha256 = `sha256:${string}`;
export const TENANT_OBJECT_PREFIX = 'sse/';
const R2_PART_LIMIT = 10_000;

export interface TenantObjectMetadata { scope: string; sha256: Sha256; size: number }
export type TenantBody = Uint8Array | { stream: ReadableStream<Uint8Array>; size: number; sha256: Sha256 };
export interface TenantRange { offset: number; length: number }
export interface TenantObject extends TenantObjectMetadata { body: ReadableStream<Uint8Array>; range: TenantRange | null }
export interface TenantObjectWriter { write(bytes: Uint8Array): Promise<void>; close(): Promise<TenantObjectMetadata>; abort(): Promise<void> }
export interface TenantListing { objects: Array<{ name: string; size: number; uploaded: Date }>; cursor: string | null }

/** Stored bytes that do not match the scope, digest or size their object records. */
export class TenantObjectIntegrityError extends Error {}

/** Which scope's key a name's object is encrypted under; null for names outside the tenant namespaces. */
export type TenantNamespace =
  | { kind: 'lfs'; scope: string; projectId: string; oid: string }
  | { kind: 'drive'; scope: string; workspaceId: string }
  | { kind: 'space'; scope: string; projectId: string; spaceId: string };

const storageId = '[A-Za-z0-9._-]{1,128}';
const lfsName = new RegExp(`^lfs/projects/(${storageId})/objects/([a-f0-9]{64})$`, 'u');
const driveName = new RegExp(`^accounts/[A-Za-z0-9_-]+/artifacts/space:(${storageId})/sha256/[a-f0-9]{64}$`, 'u');
const spaceName = new RegExp(`^projects/(${storageId})/spaces/(${storageId})/.+$`, 'u');

export function tenantNamespace(name: string): TenantNamespace | null {
  if (name.length > 1_024 || name.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const lfs = lfsName.exec(name);
  if (lfs) return { kind: 'lfs', scope: `lfs:${lfs[1]}`, projectId: lfs[1]!, oid: lfs[2]! };
  const drive = driveName.exec(name);
  if (drive) return { kind: 'drive', scope: `space:${drive[1]}`, workspaceId: drive[1]! };
  const space = spaceName.exec(name);
  if (space) return { kind: 'space', scope: `space:${space[2]}`, projectId: space[1]!, spaceId: space[2]! };
  return null;
}

export function tenantObjectKey(userId: string, name: string): string {
  if (!name || name.startsWith('/') || name.split('/').some(part => part === '..')) throw new Error('Tenant object name is invalid');
  return `${TENANT_OBJECT_PREFIX}users/${userId}/${name}`;
}

function declaredMetadata(scope: string, declared: { sha256: Sha256; size: number }): Record<string, string> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(declared.sha256) || !Number.isSafeInteger(declared.size) || declared.size < 0) throw new Error('Tenant object digest or size is invalid');
  return { scope, sha256: declared.sha256, size: String(declared.size) };
}

function storedMetadata(object: R2Object, scope: string): TenantObjectMetadata {
  const { scope: stored, sha256, size } = object.customMetadata ?? {};
  if (stored !== scope) throw new TenantObjectIntegrityError('Tenant object belongs to another scope');
  if (!sha256 || !/^sha256:[a-f0-9]{64}$/u.test(sha256) || !size || !/^(0|[1-9][0-9]{0,15})$/u.test(size)) throw new TenantObjectIntegrityError('Tenant object metadata is malformed');
  if (object.size !== Number(size)) throw new TenantObjectIntegrityError('Tenant object size differs from its recorded size');
  return { scope, sha256: `sha256:${sha256.slice(7)}`, size: Number(size) };
}

/** Passes bytes through while hashing them, holding back the newest chunk until the next arrives: the last bytes are
 * released only after the whole stream matched `expected`, so a consumer never completes a mismatched read. */
function verifying(expected: { sha256: Sha256; size: number }): TransformStream<Uint8Array, Uint8Array> {
  const hash: Hash = createHash('sha256');
  let size = 0;
  let pending: Uint8Array | null = null;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > expected.size) throw new TenantObjectIntegrityError('Tenant object exceeds its recorded size');
      hash.update(chunk);
      if (pending) controller.enqueue(pending);
      pending = chunk;
    },
    flush(controller) {
      if (size !== expected.size || `sha256:${hash.digest('hex')}` !== expected.sha256) throw new TenantObjectIntegrityError('Tenant object failed sha256/size verification');
      if (pending) controller.enqueue(pending);
    },
  });
}

/** Sends `stream` to R2 as a body of exactly `size` bytes. When the source fails (a digest or size mismatch included),
 * that failure is the one reported, not the aborted R2 request it caused. */
async function sendSized<T>(stream: ReadableStream<Uint8Array>, size: number, send: (body: ReadableStream<Uint8Array>) => Promise<T>): Promise<T> {
  const fixed = new FixedLengthStream(size);
  const [sent, piped] = await Promise.allSettled([send(fixed.readable), stream.pipeTo(fixed.writable)]);
  if (piped.status === 'rejected' && (piped.reason instanceof TenantObjectIntegrityError || sent.status === 'fulfilled')) throw piped.reason;
  if (sent.status === 'rejected') throw sent.reason;
  return sent.value;
}

export class TenantStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly userId: string,
    private readonly scopeKey: (scope: string) => Promise<Uint8Array>,
  ) {}

  private key(name: string): string { return tenantObjectKey(this.userId, name); }

  private async ssecKey(scope: string): Promise<ArrayBuffer> {
    const key = await this.scopeKey(scope);
    if (key.byteLength !== 32) throw new Error('Storage scope key must be 32 bytes');
    return key.slice().buffer;
  }

  /** Stream bodies are one R2 put (up to R2's single-object limit); R2 refuses bytes that miss the declared digest.
   * With `onlyIfAbsent`, an existing object is kept and null returned. */
  async put(name: string, scope: string, body: TenantBody, options: { onlyIfAbsent?: boolean } = {}): Promise<TenantObjectMetadata | null> {
    if (body instanceof Uint8Array) {
      return this.store(name, scope, body, { sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`, size: body.byteLength }, options);
    }
    return this.store(name, scope, body.stream, body, options);
  }

  private async store(name: string, scope: string, value: Uint8Array | ReadableStream<Uint8Array>, declared: { sha256: Sha256; size: number }, options: { onlyIfAbsent?: boolean }): Promise<TenantObjectMetadata | null> {
    // R2 applies no SSE-C to an empty body (and then refuses reads that name a key), so an empty object has none.
    const putOptions: R2PutOptions = {
      ...(declared.size === 0 ? {} : { ssecKey: await this.ssecKey(scope) }), customMetadata: declaredMetadata(scope, declared), sha256: declared.sha256.slice(7),
      ...(options.onlyIfAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
    };
    const stored = value instanceof Uint8Array
      ? await this.bucket.put(this.key(name), value, putOptions)
      : await sendSized(value, declared.size, body => this.bucket.put(this.key(name), body, putOptions));
    return stored ? { scope, sha256: declared.sha256, size: declared.size } : null;
  }

  async get(name: string, scope: string, options: { range?: TenantRange } = {}): Promise<TenantObject | null> {
    const range = options.range;
    if (range && (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 1)) throw new Error('Tenant object range is invalid');
    const object = await this.bucket.get(this.key(name), { ssecKey: await this.ssecKey(scope), ...(range ? { range } : {}) })
      .catch(async (error: unknown) => {
        // An empty object carries no key (see `store`); R2 answers a keyed read of it with 10034. Read it plainly, and
        // only an object that really is empty is accepted.
        if (!String(error).includes('(10034)')) throw error;
        const plain = await this.bucket.get(this.key(name));
        if (plain && plain.size !== 0) { await plain.body.cancel(); throw error; }
        return plain;
      });
    if (!object) return null;
    let metadata: TenantObjectMetadata;
    try { metadata = storedMetadata(object, scope); }
    catch (error) { await object.body.cancel(); throw error; }
    if (range) return { ...metadata, body: object.body, range };
    return { ...metadata, body: object.body.pipeThrough(verifying(metadata)), range: null };
  }

  /** A whole object of at most `maxBytes`, verified before it is returned. */
  async bytes(name: string, scope: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
    const object = await this.get(name, scope);
    if (!object) return null;
    if (object.size > maxBytes) {
      await object.body.cancel();
      throw new Error(`Tenant object exceeds ${maxBytes} bytes`);
    }
    return collectBytes(streamBytes(object.body), maxBytes);
  }

  async head(name: string, scope: string): Promise<TenantObjectMetadata | null> {
    const object = await this.bucket.head(this.key(name));
    return object ? storedMetadata(object, scope) : null;
  }

  async delete(names: readonly string[]): Promise<void> {
    const keys = names.map(name => this.key(name));
    for (let offset = 0; offset < keys.length; offset += 1000) await this.bucket.delete(keys.slice(offset, offset + 1000));
  }

  async list(namePrefix: string, cursor?: string): Promise<TenantListing> {
    const prefix = this.key(namePrefix);
    const root = this.key('x').slice(0, -1);
    const page = await this.bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    return {
      objects: page.objects.map(object => ({ name: object.key.slice(root.length), size: object.size, uploaded: object.uploaded })),
      cursor: page.truncated ? page.cursor : null,
    };
  }

  /** Streams an object whose digest and size are known up front: one put when it fits a part, otherwise uniform
   * `TENANT_OBJECT_PART_BYTES` parts. `close` completes only when the written bytes match `declared`; any failure aborts. */
  writer(name: string, scope: string, declared: { sha256: Sha256; size: number }): TenantObjectWriter {
    declaredMetadata(scope, declared);
    const hash = createHash('sha256');
    const buffer = new Uint8Array(Math.min(declared.size, TENANT_OBJECT_PART_BYTES));
    let used = 0;
    let written = 0;
    let upload: { id: string; parts: R2UploadedPart[] } | null = null;
    let finished = false;
    const abort = async () => {
      finished = true;
      if (upload) await this.abortMultipart(name, scope, upload.id);
      upload = null;
    };
    const failed = async (error: unknown): Promise<never> => {
      await abort().catch(() => undefined);
      throw error;
    };
    const flushPart = async () => {
      upload ??= { id: await this.createMultipart(name, scope, declared), parts: [] };
      upload.parts.push(await this.uploadPart(name, scope, upload.id, upload.parts.length + 1, buffer.subarray(0, used)));
      used = 0;
    };
    return {
      write: async (bytes) => {
        if (finished) throw new Error('Tenant object writer is closed');
        try {
          written += bytes.byteLength;
          if (written > declared.size) throw new TenantObjectIntegrityError('Tenant object exceeds its declared size');
          hash.update(bytes);
          for (let offset = 0; offset < bytes.byteLength;) {
            if (used === buffer.byteLength) await flushPart();
            const count = Math.min(buffer.byteLength - used, bytes.byteLength - offset);
            buffer.set(bytes.subarray(offset, offset + count), used);
            used += count;
            offset += count;
          }
        } catch (error) { return failed(error); }
      },
      close: async () => {
        if (finished) throw new Error('Tenant object writer is closed');
        try {
          if (written !== declared.size || `sha256:${hash.digest('hex')}` !== declared.sha256) throw new TenantObjectIntegrityError('Tenant object failed sha256/size verification');
          finished = true;
          if (!upload) {
            await this.store(name, scope, buffer.subarray(0, used), declared, {});
            return { scope, sha256: declared.sha256, size: declared.size };
          }
          if (used) await flushPart();
          return await this.completeMultipart(name, scope, upload.id, upload.parts);
        } catch (error) { return failed(error); }
      },
      abort,
    };
  }

  /** Multipart objects record the digest and size declared here; complete checks the size and full reads the digest. */
  async createMultipart(name: string, scope: string, declared: { sha256: Sha256; size: number }): Promise<string> {
    const customMetadata = declaredMetadata(scope, declared);
    return (await this.bucket.createMultipartUpload(this.key(name), { customMetadata, ssecKey: await this.ssecKey(scope) })).uploadId;
  }

  /** A streamed part is checked against its digest and size as it passes; a mismatch fails the part before its last bytes. */
  async uploadPart(name: string, scope: string, uploadId: string, partNumber: number, part: Uint8Array | { stream: ReadableStream<Uint8Array>; size: number; sha256: Sha256 }): Promise<R2UploadedPart> {
    const size = part instanceof Uint8Array ? part.byteLength : part.size;
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > R2_PART_LIMIT) throw new Error('Tenant object part number is invalid');
    if (!Number.isSafeInteger(size) || size < 1 || size > TENANT_OBJECT_PART_BYTES) throw new Error('Tenant object part size is invalid');
    const upload = this.bucket.resumeMultipartUpload(this.key(name), uploadId);
    const ssecKey = await this.ssecKey(scope);
    if (part instanceof Uint8Array) return upload.uploadPart(partNumber, part, { ssecKey });
    declaredMetadata(scope, part);
    return sendSized(part.stream.pipeThrough(verifying(part)), size, body => upload.uploadPart(partNumber, body, { ssecKey }));
  }

  /** A completed object whose parts do not add up to its declared size is deleted rather than left readable. */
  async completeMultipart(name: string, scope: string, uploadId: string, parts: R2UploadedPart[]): Promise<TenantObjectMetadata> {
    const completed = await this.bucket.resumeMultipartUpload(this.key(name), uploadId).complete(parts);
    try {
      return storedMetadata(completed, scope);
    } catch (error) {
      await this.bucket.delete(this.key(name));
      throw error;
    }
  }

  async abortMultipart(name: string, scope: string, uploadId: string): Promise<void> {
    await this.bucket.resumeMultipartUpload(this.key(name), uploadId).abort();
  }
}

/** Scope keys this isolate has read, one vault call per scope. */
const scopeKeys = new Map<string, Promise<Uint8Array>>();

export function tenantStore(env: Env): TenantStore {
  return new TenantStore(env.DATA, env.ACCOUNT_ID, scope => {
    const cacheKey = `${env.ACCOUNT_ID}\n${scope}`;
    let key = scopeKeys.get(cacheKey);
    if (!key) {
      key = (async () => new Uint8Array(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).scopeKey(scope)))();
      scopeKeys.set(cacheKey, key);
      key.catch(() => scopeKeys.delete(cacheKey));
    }
    return key;
  });
}

export async function forgetTenantScope(env: Env, scope: string): Promise<void> {
  scopeKeys.delete(`${env.ACCOUNT_ID}\n${scope}`);
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).forgetScope(scope);
}
