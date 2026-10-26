/**
 * The extension's uploads to its account (docs/SIMPLIFICATION.md Batch 16 items 2 and 4): a download an agent tab
 * started, or a capture's files, sent over HTTPS in parts as the bytes arrive. Bytes never cross the relay connection.
 * Only the begin request (`POST /api/browser-relay/uploads`) is signed, with the extension's pairing key over its
 * method, path, the SHA-256 of its body, the time and a fresh nonce; the account checks it against the confirmed
 * pairing and answers with the upload's link, the whole authority for its parts, completion and abandonment. Share
 * requests (`share.ts`) are signed the same way under their own label.
 */

/** The request header carrying the pairing key's signature of an upload's begin request or a share request. */
export const SIGNATURE_HEADER = 'x-gitspace-browser-upload';
/** Where an upload begins: the one request signed with the pairing key. */
const BEGIN_PATH = '/api/browser-relay/uploads';
/** Every part but the last is exactly 32 MiB, the drive's multipart size (the account appends each as it comes); the
 * last is whatever remains. An upload idle for 45 minutes is forgotten, longer than a capture records. */
const PART_BYTES = 32 * 1024 * 1024;

/** What one upload stores: a download of a live script or step on the group, or one file of a capture. */
export type UploadTarget =
  | { kind: 'download'; groupId: string; attemptId: string; name: string; mediaType: string }
  | { kind: 'capture'; groupId: string; captureId: string; file: 'video.webm' | 'frames.bin' | 'frames.json' | 'thumbnail.jpg' | 'steps.json' | 'layout.jsonl'; mediaType: string };
/** Signs one request: the header value for `method` on `pathname` with a body of this SHA-256 (lowercase hex). An
 * upload signs only its begin request, `POST /api/browser-relay/uploads`. */
export type UploadSigner = (method: string, pathname: string, bodySha256: string) => Promise<string>;
/** The pairing a request is signed with. */
export type SigningIdentity = { privateKey: CryptoKey; pairingId: string; generation: number };
export type UploadResult = { path: string; size: number; mediaType: string };

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** The SHA-256 of a request body, as lowercase hex. */
export async function sha256Hex(body: Uint8Array<ArrayBuffer>): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', body)); }

/** The signature header for one request, made with the pairing key (in the service worker, which holds it): `label`
 * names what the request does, `upload` for an upload's begin, `share` for a share request and `comment` for one of
 * the in-page comment tool (`comments.ts`). */
export async function relaySignature(identity: SigningIdentity, label: 'upload' | 'share' | 'comment', method: string, pathname: string, bodySha256: string): Promise<string> {
  const issuedAt = Date.now();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const message = `gitspace-browser-relay-v2:${label}:${identity.pairingId}:${identity.generation}:${method}:${pathname}:${bodySha256}:${issuedAt}:${nonce}`;
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode(message)))));
  return btoa(JSON.stringify({ pairingId: identity.pairingId, generation: identity.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** The value of the account's `ok` reply; otherwise an error with the account's message after `refused`. */
export async function accountValue(response: Response, refused: string): Promise<unknown> {
  const reply: unknown = await response.json().catch(() => null);
  if (typeof reply === 'object' && reply !== null && 'status' in reply && reply.status === 'ok' && 'value' in reply) return reply.value;
  const message = typeof reply === 'object' && reply !== null && 'error' in reply && typeof reply.error === 'object' && reply.error !== null && 'message' in reply.error && typeof reply.error.message === 'string' ? reply.error.message : `HTTP ${response.status}`;
  throw new Error(`${refused}${message}`);
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
  private link: string | null = null;
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
      if (this.link === null) throw new Error('Nothing was recorded to upload');
      return this.send(`${this.link}/complete`, { method: 'POST', body: json({ parts: this.parts, size: this.size }), headers: { 'content-type': 'application/json' } });
    });
    if (typeof result !== 'object' || result === null || !('path' in result) || typeof result.path !== 'string' || !('size' in result) || typeof result.size !== 'number' || !('mediaType' in result) || typeof result.mediaType !== 'string') throw new Error('The account answered the upload with an unexpected reply');
    return { path: result.path, size: result.size, mediaType: result.mediaType };
  }

  /** Gives the upload up; the account drops what it received. */
  async abort(): Promise<void> {
    this.failure ??= new Error('Upload aborted');
    await this.requests;
    if (this.link !== null) await this.send(this.link, { method: 'DELETE' }).catch(() => {});
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
        this.link ??= await this.begin();
        await this.send(`${this.link}/parts/${index + 1}`, { method: 'PUT', body: part, headers: { 'content-type': 'application/octet-stream' } });
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

  /** Begins the upload with the signed request naming its target; the account answers with the upload's link. */
  private async begin(): Promise<string> {
    const body = json(this.target);
    const header = await this.sign('POST', BEGIN_PATH, await sha256Hex(body));
    const begun = await this.send(new URL(BEGIN_PATH, this.account).href, { method: 'POST', body, headers: { [SIGNATURE_HEADER]: header, 'content-type': 'application/json' } });
    if (typeof begun !== 'object' || begun === null || !('link' in begun) || typeof begun.link !== 'string') throw new Error('The account answered the upload with an unexpected reply');
    return begun.link;
  }

  /** One request to the account; resolves with the value of its `ok` reply. */
  private async send(url: string, init: { method: string; body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> }): Promise<unknown> {
    return accountValue(await fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }), 'The account refused the upload: ');
  }
}
