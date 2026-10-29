/**
 * The inference Worker: sends model requests whose images are stored references. The workspace object serializes a
 * request with each image's reference in place of its data; this Worker streams it out with each reference replaced by
 * the image's base64, read through the caller's `readImage` as it goes, so neither side holds the images whole
 * (`expandedRequest`, `@gitspace/runtime-core/image-requests`). A Claude subscription request's billing attestation is
 * hashed over the expanded body with the WASM XXH64.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import xxhash, { type XXHashAPI } from 'xxhash-wasm';
import { expandedRequest, type ImageReader, type ImageRequest } from '@gitspace/runtime-core/image-requests';

/** The WASM XXH64, instantiated on first use: about 7.5 GB/s, where a BigInt version hashed 64 MB/s. */
let hasher: Promise<XXHashAPI> | undefined;

export class InferenceEntrypoint extends WorkerEntrypoint {
  async send(request: ImageRequest, readImage: ImageReader): Promise<Response> {
    try {
      const wasm = await (hasher ??= xxhash());
      const { length, body } = await expandedRequest(request, readImage, seed => wasm.create64(seed));
      const headers = new Headers(request.headers);
      headers.set('content-length', String(length));
      return await fetch(request.url, { method: request.method, headers, body: body.pipeThrough(new FixedLengthStream(length)), redirect: 'manual' });
    } catch (error) {
      // A refusal answers as the provider's own 400 would: the SDK reports a thrown error as a retried
      // "Connection error." and drops the reason.
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: error instanceof Error ? error.message : String(error) } }, { status: 400 });
    }
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler;
