/**
 * The inference worker: loaded per workspace by the tenant's Worker Loader (`inference:<workspace>:<release>`), so a
 * request's body and images live in its isolate, never the workspace object's (`docs/INFERENCE-WORKER-DESIGN.md`).
 * `run(attempt)` builds and sends one request with pi-ai and streams pi's events back as newline-delimited JSON;
 * cancelling the stream aborts the request. Images arrive as references: each provider serializes them in place, and
 * the outgoing body streams with each reference replaced by the image, read through `env.READER` (the workspace's own
 * images only). A Claude subscription request's billing attestation is hashed over the expanded body (WASM XXH64).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import xxhash, { type XXHashAPI } from 'xxhash-wasm';
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
import { attemptEventStream, claudeCode, createAttemptRunner, expandedRequest, requestImages, restoreStandIns, type AttemptRunner, type ClaudeCodeTransport, type ImageReader, type ImageRequestTransport, type InferenceAttempt } from '@gitspace/runtime-core/inference';
import { parseImageReference } from '@gitspace/protocol-runtime/image-reference';

export interface InferenceWorkerEnv {
  /** The workspace's image reader: serves only the references of the workspace it was made for. */
  READER: { read: ImageReader };
}

setBedrockProviderModule(bedrockProviderModule);
const upstream = globalThis.fetch.bind(globalThis);
/** The WASM XXH64, instantiated on first use: about 7.5 GB/s, where a BigInt version hashed 64 MB/s. Module state holds
 * finished values only: a promise made by one request never settles in another once its request ends, so a request
 * stopped while one was pending broke every later request this isolate served. */
let hasher: XXHashAPI | undefined;
let runner: AttemptRunner | undefined;
let standInFetch: ClaudeCodeTransport | undefined;

/** Images this isolate already read, by reference (a reference names its bytes' hash and size), least recently used
 * first. One loaded worker serves one workspace, so a retried attempt and the next turn send the same images again. */
const images = new Map<string, Uint8Array<ArrayBuffer>>();
const IMAGE_CACHE_BYTES = 24 * 1024 * 1024;
let imageBytes = 0;
/** Waits before each further try of an image read: R2 answers a transient internal error (10001), or the connection
 * drops, and a whole model request failed on one such read. */
const READ_RETRY_MS = [250, 1_000];

/** The reader and the size checks refuse with a message starting "Image ": the same refusal on every try. */
function refusal(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Image ');
}

function cachedImages(env: InferenceWorkerEnv): ImageReader {
  return async reference => {
    let bytes = images.get(reference);
    // A hit is taken out and put back last, so the least recently sent image goes first.
    if (bytes) { images.delete(reference); imageBytes -= bytes.byteLength; }
    for (let attempt = 0; !bytes; attempt++) {
      try {
        bytes = new Uint8Array(await new Response(await env.READER.read(reference)).arrayBuffer());
      } catch (error) {
        const wait = READ_RETRY_MS[attempt];
        if (wait === undefined || refusal(error)) throw error;
        const waited = Promise.withResolvers<void>();
        setTimeout(waited.resolve, wait);
        await waited.promise;
      }
    }
    // Only bytes of the size the reference names are kept; any other read fails the size check when it is sent.
    // Two reads of one image at once (stand-in and direct paths) keep one copy.
    if (!images.has(reference) && bytes.byteLength === parseImageReference(reference)?.size && bytes.byteLength <= IMAGE_CACHE_BYTES) {
      images.set(reference, bytes);
      imageBytes += bytes.byteLength;
      for (const [oldest, kept] of images) {
        if (imageBytes <= IMAGE_CACHE_BYTES) break;
        images.delete(oldest);
        imageBytes -= kept.byteLength;
      }
    }
    return new Blob([bytes]).stream();
  };
}

function transport(env: InferenceWorkerEnv): ImageRequestTransport {
  const read = cachedImages(env);
  return async request => {
    try {
      const wasm = hasher ??= await xxhash();
      const { length, body } = await expandedRequest(request, read, seed => wasm.create64(seed));
      const headers = new Headers(request.headers);
      headers.set('content-length', String(length));
      return await upstream(request.url, { method: request.method, headers, body: body.pipeThrough(new FixedLengthStream(length)), redirect: 'manual' });
    } catch (error) {
      // Answered as the provider's own error would be: the SDK reports a thrown error as a retried "Connection error."
      // and drops the reason. A refusal is the provider's 400; a storage or network failure (R2's "get: … (10001)",
      // "Network connection lost.") is a 503 the request is retried after.
      const message = error instanceof Error ? error.message : String(error);
      return refusal(error)
        ? Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status: 400 })
        : Response.json({ type: 'error', error: { type: 'api_error', message } }, { status: 503 });
    }
  };
}

/**
 * Bedrock's and Google's providers send through their SDKs, which call the global `fetch` with their own bodies: one
 * carrying references, or Bedrock's stand-ins (see `restoreStandIns`) turned back into references, goes out through
 * the image transport like any other provider's request.
 */
function interceptStandIns(env: InferenceWorkerEnv): void {
  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request && init === undefined && input.method === 'POST' ? await input.clone().text() : null;
    const restored = body === null ? null : restoreStandIns(body);
    if (restored === null || (restored === body && requestImages(restored).length === 0)) return upstream(input, init);
    const request = input instanceof Request ? input : new Request(input, init);
    const headers = new Headers(init?.headers ?? request.headers);
    headers.delete('content-length');
    // No Claude identity applies to these requests; the transport only writes their images in.
    const shaped = standInFetch ??= await claudeCode({ profileId: 'sdk', sessionId: crypto.randomUUID() }, transport(env));
    return shaped.fetch(request.url, { method: request.method, headers, body: restored, ...(init?.signal ? { signal: init.signal } : {}) });
  };
}

export class Inference extends WorkerEntrypoint<InferenceWorkerEnv> {
  run(attempt: InferenceAttempt): ReadableStream<Uint8Array> {
    if (!runner) {
      // One loaded worker serves one workspace, so its reader is the same for every attempt.
      interceptStandIns(this.env);
      runner = createAttemptRunner({ imageTransport: transport(this.env) });
    }
    const run = runner;
    return attemptEventStream(signal => run(attempt, signal));
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler;
