const RPC_RECORD_VERSION = 1;
const RPC_NONCE_BYTES = 12;
const RPC_FRAME_HEADER_BYTES = 4;
const MAX_RPC_RECORD_BYTES = 2 * 1024 * 1024;
export const ENCRYPTED_RPC_CONTENT_TYPE = 'application/vnd.gitspace.rpc-encrypted; v=1';
export const RPC_SESSION_HEADER = 'x-gitspace-rpc-session';
export const RPC_REQUEST_HEADER = 'x-gitspace-rpc-request';

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

function aad(sessionId: string, requestId: string, direction: 'request' | 'response', sequence: number): Uint8Array {
  return new TextEncoder().encode(`${sessionId}\n${requestId}\n${direction}\n${sequence}`);
}

export async function encryptRpcRecord(input: {
  plaintext: Uint8Array;
  key: Uint8Array;
  sessionId: string;
  requestId: string;
  direction: 'request' | 'response';
  sequence: number;
  nonce?: Uint8Array;
}): Promise<Uint8Array> {
  if (input.key.byteLength !== 32) throw new RangeError('RPC encryption key must be 32 bytes');
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(RPC_NONCE_BYTES));
  if (nonce.byteLength !== RPC_NONCE_BYTES) throw new RangeError(`RPC nonce must be ${RPC_NONCE_BYTES} bytes`);
  const key = await crypto.subtle.importKey('raw', ownedBuffer(input.key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(nonce),
    additionalData: ownedBuffer(aad(input.sessionId, input.requestId, input.direction, input.sequence)),
  }, key, ownedBuffer(input.plaintext));
  const sealed = new Uint8Array(1 + nonce.byteLength + ciphertext.byteLength);
  sealed[0] = RPC_RECORD_VERSION;
  sealed.set(nonce, 1);
  sealed.set(new Uint8Array(ciphertext), 1 + nonce.byteLength);
  return sealed;
}

export async function decryptRpcRecord(input: {
  sealed: Uint8Array;
  key: Uint8Array;
  sessionId: string;
  requestId: string;
  direction: 'request' | 'response';
  sequence: number;
}): Promise<Uint8Array> {
  if (input.key.byteLength !== 32) throw new RangeError('RPC encryption key must be 32 bytes');
  if (input.sealed.byteLength <= 1 + RPC_NONCE_BYTES || input.sealed[0] !== RPC_RECORD_VERSION) {
    throw new Error('Unsupported or malformed encrypted RPC record');
  }
  const nonce = input.sealed.subarray(1, 1 + RPC_NONCE_BYTES);
  const ciphertext = input.sealed.subarray(1 + RPC_NONCE_BYTES);
  const key = await crypto.subtle.importKey('raw', ownedBuffer(input.key), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(nonce),
    additionalData: ownedBuffer(aad(input.sessionId, input.requestId, input.direction, input.sequence)),
  }, key, ownedBuffer(ciphertext));
  return new Uint8Array(plaintext);
}

export function frameRpcRecord(record: Uint8Array): Uint8Array {
  if (record.byteLength === 0 || record.byteLength > MAX_RPC_RECORD_BYTES) throw new RangeError('Encrypted RPC record exceeds frame limit');
  const framed = new Uint8Array(RPC_FRAME_HEADER_BYTES + record.byteLength);
  new DataView(framed.buffer).setUint32(0, record.byteLength, false);
  framed.set(record, RPC_FRAME_HEADER_BYTES);
  return framed;
}

export async function* parseRpcRecordFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk.done) {
        const merged = new Uint8Array(pending.byteLength + chunk.value.byteLength);
        merged.set(pending);
        merged.set(chunk.value, pending.byteLength);
        pending = merged;
      }
      while (pending.byteLength >= RPC_FRAME_HEADER_BYTES) {
        const size = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(0, false);
        if (size === 0 || size > MAX_RPC_RECORD_BYTES) throw new Error('Encrypted RPC frame length is invalid');
        if (pending.byteLength < RPC_FRAME_HEADER_BYTES + size) break;
        yield pending.slice(RPC_FRAME_HEADER_BYTES, RPC_FRAME_HEADER_BYTES + size);
        pending = pending.slice(RPC_FRAME_HEADER_BYTES + size);
      }
      if (chunk.done) {
        if (pending.byteLength !== 0) throw new Error('Encrypted RPC response ended with a partial frame');
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function encodeRequestPayload(contentType: string, body: Uint8Array): Uint8Array {
  const contentTypeBytes = new TextEncoder().encode(contentType);
  if (contentTypeBytes.byteLength > 65_535) throw new RangeError('RPC content type is too long');
  const payload = new Uint8Array(2 + contentTypeBytes.byteLength + body.byteLength);
  new DataView(payload.buffer).setUint16(0, contentTypeBytes.byteLength, false);
  payload.set(contentTypeBytes, 2);
  payload.set(body, 2 + contentTypeBytes.byteLength);
  return payload;
}

export function decodeRequestPayload(payload: Uint8Array): { contentType: string; body: Uint8Array } {
  if (payload.byteLength < 2) throw new Error('Encrypted RPC request payload is malformed');
  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, false);
  if (payload.byteLength < 2 + length) throw new Error('Encrypted RPC request content type is truncated');
  return {
    contentType: new TextDecoder().decode(payload.subarray(2, 2 + length)),
    body: payload.slice(2 + length),
  };
}

interface ResponseMetadata {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

export function encodeResponseMetadata(response: Response): Uint8Array {
  const metadata: ResponseMetadata = {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
  };
  return new TextEncoder().encode(JSON.stringify(metadata));
}

export function decodeResponseMetadata(bytes: Uint8Array): ResponseMetadata {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ResponseMetadata>;
  if (typeof parsed.status !== 'number' || !Number.isInteger(parsed.status) || typeof parsed.statusText !== 'string' || !Array.isArray(parsed.headers)) {
    throw new Error('Encrypted RPC response metadata is malformed');
  }
  const headers = parsed.headers.filter((entry): entry is [string, string] => (
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'
  ));
  if (headers.length !== parsed.headers.length) throw new Error('Encrypted RPC response headers are malformed');
  return { status: parsed.status, statusText: parsed.statusText, headers };
}

export function createEncryptedRpcFetch(options: {
  key: Uint8Array;
  sessionId: string;
  fetch?: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const encryptedFetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const original = new Request(input, init);
    const requestId = crypto.randomUUID();
    const body = new Uint8Array(await original.arrayBuffer());
    const payload = encodeRequestPayload(original.headers.get('content-type') ?? '', body);
    const sealed = await encryptRpcRecord({
      plaintext: payload,
      key: options.key,
      sessionId: options.sessionId,
      requestId,
      direction: 'request',
      sequence: 0,
    });
    const headers = new Headers(original.headers);
    headers.set('content-type', ENCRYPTED_RPC_CONTENT_TYPE);
    headers.set(RPC_SESSION_HEADER, options.sessionId);
    headers.set(RPC_REQUEST_HEADER, requestId);
    headers.delete('content-length');
    const outer = await baseFetch(new Request(original.url, {
      method: original.method,
      headers,
      body: ownedBuffer(sealed),
      signal: original.signal,
      credentials: original.credentials,
      cache: original.cache,
      redirect: original.redirect,
    }));
    if (!outer.ok || outer.headers.get('content-type') !== ENCRYPTED_RPC_CONTENT_TYPE || !outer.body) {
      throw new Error(`Encrypted RPC transport failed with ${outer.status}`);
    }
    const frames = parseRpcRecordFrames(outer.body);
    const iterator = frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('Encrypted RPC response omitted metadata');
    const metadata = decodeResponseMetadata(await decryptRpcRecord({
      sealed: first.value,
      key: options.key,
      sessionId: options.sessionId,
      requestId,
      direction: 'response',
      sequence: 0,
    }));
    let sequence = 1;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        try {
          controller.enqueue(await decryptRpcRecord({
            sealed: next.value,
            key: options.key,
            sessionId: options.sessionId,
            requestId,
            direction: 'response',
            sequence,
          }));
          sequence += 1;
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
    return new Response(stream, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: metadata.headers,
    });
  };
  return encryptedFetch as typeof globalThis.fetch;
}

export const encodeRpcRequestPayload = encodeRequestPayload;
