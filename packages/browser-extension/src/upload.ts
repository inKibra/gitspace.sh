/**
 * The extension's uploads to its account (docs/SIMPLIFICATION.md Batch 16 items 2 and 4): a download an agent tab
 * started, or a capture's files, sent over HTTPS to `/api/browser-relay/uploads` in parts as the bytes arrive. Bytes
 * never cross the relay connection. Each request is signed with the extension's pairing key over its method, path,
 * the SHA-256 of its body, the time and a fresh nonce; the account checks it against the confirmed pairing.
 */

/** The request header carrying the signature. */
export const UPLOAD_HEADER = 'x-gitspace-browser-upload';
/** Every part but the last is exactly 32 MiB, the drive's multipart size (the account appends each as it comes); the
 * last is whatever remains. An upload idle for 45 minutes is forgotten, longer than a capture records. */
const PART_BYTES = 32 * 1024 * 1024;

/** What one upload stores: a download of a live script or step on the group, or one file of a capture. */
export type UploadTarget =
  | { kind: 'download'; groupId: string; attemptId: string; name: string; mediaType: string }
  | { kind: 'capture'; groupId: string; captureId: string; file: 'video.webm' | 'frames.bin' | 'frames.json' | 'thumbnail.jpg'; mediaType: string };
/** Signs one request: the header value for `method` on `pathname` with a body of this SHA-256 (lowercase hex). */
export type UploadSigner = (method: string, pathname: string, bodySha256: string) => Promise<string>;
/** The pairing an upload is signed with. */
export type UploadIdentity = { privateKey: CryptoKey; pairingId: string; generation: number };
export type UploadResult = { path: string; size: number; mediaType: string };

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The signature header for one request, made with the pairing key (in the service worker, which holds it). */
export async function uploadSignature(identity: UploadIdentity, method: string, pathname: string, bodySha256: string): Promise<string> {
  const issuedAt = Date.now();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const message = `gitspace-browser-relay-v2:upload:${identity.pairingId}:${identity.generation}:${method}:${pathname}:${bodySha256}:${issuedAt}:${nonce}`;
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode(message)))));
  return btoa(JSON.stringify({ pairingId: identity.pairingId, generation: identity.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * One file uploaded in parts: `write` as bytes arrive, then `complete` (or `abort`). The upload begins with its first
 * part, so nothing is sent for a file that never gets bytes; requests go one at a time, in order.
 */
export class Upload {
  private readonly buffered: Uint8Array<ArrayBuffer>[] = [];
  private bufferedBytes = 0;
  private size = 0;
  private parts = 0;
  private uploadId: string | null = null;
  private requests: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  constructor(private readonly account: string, private readonly sign: UploadSigner, private readonly target: UploadTarget) {}

  /** Bytes in order; each full part goes out as it fills, and this resolves once it was sent. Rejects once the
   * upload failed. */
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!bytes.byteLength) return Promise.resolve();
    this.buffered.push(bytes);
    this.bufferedBytes += bytes.byteLength;
    this.size += bytes.byteLength;
    return this.bufferedBytes >= PART_BYTES ? this.flush(false) : Promise.resolve();
  }

  /** Sends what waits and completes the file: its drive path, size and media type. */
  async complete(): Promise<UploadResult> {
    await this.flush(true);
    const result = await this.enqueue(async () => {
      if (this.uploadId === null) throw new Error('Nothing was recorded to upload');
      return this.request('POST', `/api/browser-relay/uploads/${this.uploadId}/complete`, json({ parts: this.parts, size: this.size }));
    });
    if (typeof result !== 'object' || result === null || !('path' in result) || typeof result.path !== 'string' || !('size' in result) || typeof result.size !== 'number' || !('mediaType' in result) || typeof result.mediaType !== 'string') throw new Error('The account answered the upload with an unexpected reply');
    return { path: result.path, size: result.size, mediaType: result.mediaType };
  }

  /** Gives the upload up; the account drops what it received. */
  async abort(): Promise<void> {
    this.failure ??= new Error('Upload aborted');
    await this.requests;
    if (this.uploadId !== null) await this.request('DELETE', `/api/browser-relay/uploads/${this.uploadId}`, new Uint8Array(0)).catch(() => {});
  }

  /** Sends each full part waiting, and with `all` the rest as the last; resolves once they were sent. */
  private async flush(all: boolean): Promise<void> {
    while (this.bufferedBytes >= PART_BYTES || (all && this.bufferedBytes)) {
      const part = new Uint8Array(Math.min(this.bufferedBytes, PART_BYTES));
      let filled = 0;
      while (filled < part.byteLength) {
        const head = this.buffered[0];
        if (!head) break;
        const take = Math.min(head.byteLength, part.byteLength - filled);
        part.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.byteLength) this.buffered.shift(); else this.buffered[0] = head.subarray(take);
      }
      this.bufferedBytes -= part.byteLength;
      const index = this.parts++;
      void this.enqueue(async () => {
        if (this.uploadId === null) {
          const begun = await this.request('POST', '/api/browser-relay/uploads', json(this.target));
          if (typeof begun !== 'object' || begun === null || !('uploadId' in begun) || typeof begun.uploadId !== 'string') throw new Error('The account answered the upload with an unexpected reply');
          this.uploadId = begun.uploadId;
        }
        await this.request('PUT', `/api/browser-relay/uploads/${this.uploadId}/parts/${index}`, part);
      }).catch(() => {});
    }
    await this.requests;
    if (this.failure) throw this.failure;
  }

  /** Runs `operation` after every request before it, unless one of them failed. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const step = this.requests.then(() => { if (this.failure) throw this.failure; return operation(); });
    this.requests = step.then(() => {}, (error: unknown) => { this.failure ??= error instanceof Error ? error : new Error(String(error)); });
    return step;
  }

  private async request(method: string, pathname: string, body: Uint8Array<ArrayBuffer>): Promise<unknown> {
    const header = await this.sign(method, pathname, hex(await crypto.subtle.digest('SHA-256', body)));
    const response = await fetch(new URL(pathname, this.account), {
      method, credentials: 'omit', cache: 'no-store',
      headers: { [UPLOAD_HEADER]: header, ...(body.byteLength ? { 'content-type': method === 'PUT' ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body.byteLength ? { body } : {}),
    });
    const reply: unknown = await response.json().catch(() => null);
    if (typeof reply === 'object' && reply !== null && 'status' in reply && reply.status === 'ok' && 'value' in reply) return reply.value;
    const message = typeof reply === 'object' && reply !== null && 'error' in reply && typeof reply.error === 'object' && reply.error !== null && 'message' in reply.error && typeof reply.error.message === 'string' ? reply.error.message : `HTTP ${response.status}`;
    throw new Error(`The account refused the upload: ${message}`);
  }
}
