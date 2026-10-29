/**
 * Images in conversation history are references to stored bytes, not the bytes:
 * `gs-image:v1:<workspace>:<size>:<width>x<height>:<sha256>` in an image block's `data`. A model request carrying references is serialized as usual and sent through the inference
 * Worker, which writes each image's base64 in place of its reference as it streams the request out, so the workspace
 * object never holds the images. This module is shared by both sides and has no dependencies.
 */

const REFERENCE = /^gs-image:v1:([A-Za-z0-9._-]{1,128}):(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,5})x(0|[1-9][0-9]{0,5}):([a-f0-9]{64})$/u;
/** A reference where a serialized request carries image data: a whole JSON string value (Anthropic, Google), or the
 * end of a JSON string after `;base64,` (a data URL: OpenAI). Text that merely mentions a reference is neither. */
const IN_REQUEST = /(?<="|;base64,)gs-image:v1:[A-Za-z0-9._-]{1,128}:(?:0|[1-9][0-9]{0,11}):(?:0|[1-9][0-9]{0,5})x(?:0|[1-9][0-9]{0,5}):[a-f0-9]{64}(?=")/gu;

/** `width` and `height` are the image's as its header declared them when it was stored, 0 when it declared none: every
 * request checks them against its model's limits, as it checks an inline image's header. */
export interface ImageReference { workspaceId: string; size: number; width: number; height: number; sha256: string }
/** One reference in a serialized request: where it is (UTF-16 offsets) and the stored image's size in bytes. */
export interface RequestImage { reference: string; start: number; end: number; size: number }

export function imageReference(image: ImageReference): string {
  return `gs-image:v1:${image.workspaceId}:${image.size}:${image.width}x${image.height}:${image.sha256}`;
}

export function parseImageReference(data: string): ImageReference | null {
  const match = REFERENCE.exec(data);
  return match ? { workspaceId: match[1]!, size: Number(match[2]), width: Number(match[3]), height: Number(match[4]), sha256: match[5]! } : null;
}

/** Base64 characters (and UTF-8 bytes) of `size` bytes. */
export function base64Length(size: number): number {
  return Math.ceil(size / 3) * 4;
}

/** The base64 bytes an image block's data stands for: its own length, or for a reference the stored image's. */
export function imageDataBytes(data: string): number {
  const reference = parseImageReference(data);
  return reference ? base64Length(reference.size) : data.length;
}

export function requestImages(payload: string): RequestImage[] {
  return [...payload.matchAll(IN_REQUEST)].map(match => ({
    reference: match[0], start: match.index, end: match.index + match[0].length, size: parseImageReference(match[0])!.size,
  }));
}

/** UTF-16 code units encoded at a time: at most three UTF-8 bytes each. */
export const ENCODE_UNITS = 0x4000;
const encoder = new TextEncoder();

/** UTF-8 bytes of `text[start, end)`, counted a chunk at a time; no copy of the whole is made. */
function utf8Length(text: string, start: number, end: number, scratch: Uint8Array): number {
  let length = 0;
  for (const range of textRanges(text, start, end, -1)) length += encoder.encodeInto(text.slice(range.start, range.end), scratch).written;
  return length;
}

/** The ranges of `text[from, to)` encoded one at a time: at most ENCODE_UNITS, never splitting a surrogate pair, and
 * one starting at `split` when it falls inside. */
function* textRanges(text: string, from: number, to: number, split: number): Generator<{ start: number; end: number }> {
  for (let start = from; start < to;) {
    const stop = start < split && split < to ? split : to;
    let end = Math.min(start + ENCODE_UNITS, stop);
    if (end < stop && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
    yield { start, end };
    start = end;
  }
}

/** Bytes of the request once every reference is replaced by its image's base64. */
export function expandedLength(payload: string, images: readonly RequestImage[]): number {
  const scratch = new Uint8Array(ENCODE_UNITS * 3);
  let length = 0, cursor = 0;
  for (const image of images) { length += utf8Length(payload, cursor, image.start, scratch) + base64Length(image.size); cursor = image.end; }
  return length + utf8Length(payload, cursor, payload.length, scratch);
}

/** Opens the stored bytes of one referenced image. */
export type ImageReader = (reference: string) => Promise<ReadableStream<Uint8Array>>;

/** Raw image bytes base64-encoded at a time; a multiple of 3 so no padding appears mid-image. */
const IMAGE_CHUNK = 48 * 1024;
const ALPHABET = encoder.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const PAD = 61;

/** Base64 of `bytes` as ASCII bytes, written into `out` (sized for it). */
function base64Into(bytes: Uint8Array, out: Uint8Array): Uint8Array {
  let o = 0, i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = ALPHABET[n >>> 18]!; out[o++] = ALPHABET[(n >>> 12) & 63]!; out[o++] = ALPHABET[(n >>> 6) & 63]!; out[o++] = ALPHABET[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out[o++] = ALPHABET[n >>> 18]!; out[o++] = ALPHABET[(n >>> 12) & 63]!;
    out[o++] = i + 1 < bytes.length ? ALPHABET[(n >>> 6) & 63]! : PAD; out[o++] = PAD;
  }
  return out.subarray(0, o);
}

/** One image's base64, chunk by chunk, checked against the size its reference states. */
async function* imageBase64(stream: ReadableStream<Uint8Array>, image: RequestImage, reuse: Uint8Array | null): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let carry = new Uint8Array(0);
  let consumed = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      let bytes = carry;
      if (!done) { bytes = new Uint8Array(carry.length + value.length); bytes.set(carry); bytes.set(value, carry.length); }
      const whole = done ? bytes.length : bytes.length - (bytes.length % 3);
      for (let offset = 0; offset < whole; offset += IMAGE_CHUNK) {
        const raw = bytes.subarray(offset, Math.min(whole, offset + IMAGE_CHUNK));
        consumed += raw.length;
        if (consumed > image.size) throw new Error(`Image ${image.reference} is larger than its reference states`);
        yield base64Into(raw, reuse ?? new Uint8Array(base64Length(raw.length)));
      }
      if (done) { finished = true; break; }
      carry = bytes.slice(whole);
    }
  } finally {
    // A request abandoned mid-image (an error, a cancelled send) stops reading the stored object.
    if (!finished) reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (consumed !== image.size) throw new Error(`Image ${image.reference} is smaller than its reference states`);
}

/** A chunk of the expanded request; `at` is the payload offset a text chunk starts at, -1 for image bytes. */
export interface RequestChunk { bytes: Uint8Array; at: number }

/**
 * The expanded request, chunk by chunk: payload text, with one chunk starting at `split` when it is a text offset, and
 * each reference replaced by its image's base64. With `reuse`, chunks share buffers and must be consumed before the
 * next is taken (a hash); without, each chunk is its own (a body). The next image is opened while one is encoded.
 */
export async function* expandedChunks(payload: string, images: readonly RequestImage[], read: ImageReader, options: { split?: number; reuse?: boolean } = {}): AsyncGenerator<RequestChunk> {
  const split = options.split ?? -1;
  const text = new Uint8Array(ENCODE_UNITS * 3);
  const encoded = options.reuse ? new Uint8Array(base64Length(IMAGE_CHUNK)) : null;
  let next: Promise<ReadableStream<Uint8Array>> | undefined = images[0] ? read(images[0].reference) : undefined;
  let cursor = 0;
  try {
    for (const [index, image] of images.entries()) {
      for (const range of textRanges(payload, cursor, image.start, split)) {
        const { written } = encoder.encodeInto(payload.slice(range.start, range.end), text);
        yield { bytes: options.reuse ? text.subarray(0, written) : text.slice(0, written), at: range.start };
      }
      const stream = await next!;
      const following = images[index + 1];
      next = following ? read(following.reference) : undefined;
      // A failed read of the next image is reported when it is reached, not while this one streams.
      next?.catch(() => undefined);
      for await (const bytes of imageBase64(stream, image, encoded)) yield { bytes, at: -1 };
      cursor = image.end;
    }
    for (const range of textRanges(payload, cursor, payload.length, split)) {
      const { written } = encoder.encodeInto(payload.slice(range.start, range.end), text);
      yield { bytes: options.reuse ? text.subarray(0, written) : text.slice(0, written), at: range.start };
    }
  } finally {
    void next?.then(stream => stream.cancel(), () => undefined);
  }
}

/** Claude Code's billing attestation: XXH64 (this seed) of the whole UTF-8 body with the placeholder in place, its
 * low 20 bits as five hex digits written over the placeholder in the billing system block. */
export const CCH_PLACEHOLDER = 'cch=00000';
export const CCH_SEED = 0x4d659218e32a3268n;
export const BILLING_BLOCK = '"system":[{"type":"text","text":"x-anthropic-billing-header:';

/** The payload offset of the attestation digits in the billing block; message text serializes first and may contain
 * the same placeholder. Null when the payload has no billing block. */
export function attestationOffset(payload: string): number | null {
  const block = payload.indexOf(BILLING_BLOCK);
  if (block === -1) return null;
  const at = payload.indexOf(CCH_PLACEHOLDER, block);
  return at === -1 ? null : at + 'cch='.length;
}

/** A serialized model request carrying image references, as the inference Worker takes it: `headers` are complete but
 * for Content-Length, which the Worker sets; `attest` asks for Claude Code's billing attestation over the expanded body.
 * The Worker finds the references in `payload` itself. */
export interface ImageRequest { url: string; method: string; headers: Array<[string, string]>; payload: string; attest: boolean }
/** Sends an image request; the workspace object supplies the stored bytes as the Worker reads them. */
export type ImageRequestTransport = (request: ImageRequest) => Promise<Response>;

/** XXH64 over bytes fed in pieces: the Worker's WASM one, or any with the same results. */
export interface StreamingHash { update(bytes: Uint8Array): unknown; digest(): bigint }

/**
 * The body an image request goes out with, at its known length: each reference replaced by its image's base64, read
 * as the body streams. With `attest`, pass 1 produces the expanded body and hashes it, keeping nothing, and the body
 * (pass 2, produced again) carries the attestation over its placeholder. Pass 1's failures (an image missing or not
 * the size its reference states) reject here; pass 2's error the body.
 */
export async function expandedRequest(request: ImageRequest, read: ImageReader, hash: (seed: bigint) => StreamingHash): Promise<{ length: number; body: ReadableStream<Uint8Array> }> {
  const images = requestImages(request.payload);
  const digits = request.attest ? attestationOffset(request.payload) : null;
  if (request.attest && digits === null) throw new Error('Claude subscription request has no attestation placeholder; not sent as a third-party request');
  let cch: Uint8Array | null = null;
  if (digits !== null) {
    const hashed = hash(CCH_SEED);
    for await (const chunk of expandedChunks(request.payload, images, read, { split: digits, reuse: true })) hashed.update(chunk.bytes);
    cch = encoder.encode((hashed.digest() & 0xfffffn).toString(16).padStart(5, '0'));
  }
  const chunks = expandedChunks(request.payload, images, read, digits === null ? {} : { split: digits });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) return controller.close();
      if (cch && next.value.at === digits) next.value.bytes.set(cch);
      controller.enqueue(next.value.bytes);
    },
    async cancel() { await chunks.return(undefined); },
  });
  return { length: expandedLength(request.payload, images), body };
}
