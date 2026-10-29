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

export interface InferenceWorkerEnv {
  /** The workspace's image reader: serves only the references of the workspace it was made for. */
  READER: { read: ImageReader };
}

setBedrockProviderModule(bedrockProviderModule);
const upstream = globalThis.fetch.bind(globalThis);
/** The WASM XXH64, instantiated on first use: about 7.5 GB/s, where a BigInt version hashed 64 MB/s. */
let hasher: Promise<XXHashAPI> | undefined;
let runner: AttemptRunner | undefined;
let standInFetch: Promise<ClaudeCodeTransport> | undefined;

function transport(env: InferenceWorkerEnv): ImageRequestTransport {
  return async request => {
    try {
      const wasm = await (hasher ??= xxhash());
      const { length, body } = await expandedRequest(request, reference => env.READER.read(reference), seed => wasm.create64(seed));
      const headers = new Headers(request.headers);
      headers.set('content-length', String(length));
      return await upstream(request.url, { method: request.method, headers, body: body.pipeThrough(new FixedLengthStream(length)), redirect: 'manual' });
    } catch (error) {
      // A refusal answers as the provider's own 400 would: the SDK reports a thrown error as a retried
      // "Connection error." and drops the reason.
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: error instanceof Error ? error.message : String(error) } }, { status: 400 });
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
    const shaped = await (standInFetch ??= claudeCode({ profileId: 'sdk', sessionId: crypto.randomUUID() }, transport(env)));
    return shaped.fetch(request.url, { method: request.method, headers, body: restored, ...(init?.signal ? { signal: init.signal } : {}) });
  };
}

export class Inference extends WorkerEntrypoint<InferenceWorkerEnv> {
  run(attempt: InferenceAttempt): ReadableStream<Uint8Array> {
    if (!runner) {
      // One loaded worker serves one workspace, so its reader is the same for every attempt.
      interceptStandIns(this.env);
      runner = createAttemptRunner({ images: { transport: transport(this.env), read: reference => this.env.READER.read(reference) } });
    }
    const run = runner;
    return attemptEventStream(signal => run(attempt, signal));
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler;
