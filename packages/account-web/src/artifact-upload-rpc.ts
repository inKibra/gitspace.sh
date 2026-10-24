import { z } from 'zod';
import { ClientHttpFailure, ClientNetworkFailure } from 'result-rpc';
import type { ArtifactUploadClient } from './inspector/artifact-upload.js';
import { rpcClient } from './rpc-client.js';

const PartSchema = z.object({ received: z.number().int().nonnegative() });
const ArtifactSchema = z.object({ url: z.string(), path: z.string(), hash: z.string(), mediaType: z.string().nullable(), workspaceId: z.string().nullable() });
const ErrorReplySchema = z.object({ status: z.literal('error'), error: z.object({ message: z.string() }) });

/** Sends one request through an upload link. A lost connection or a server/gateway failure leaves the upload where it
 * was (retryable); a refusal is final. */
async function linkRequest<T>(send: typeof globalThis.fetch, url: string, init: RequestInit, value: z.ZodType<T>, refusal: string): Promise<T> {
  let response: Response;
  try {
    response = await send(url, { ...init, credentials: 'omit' });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw ClientNetworkFailure({ retryable: true });
  }
  const reply = z.union([z.object({ status: z.literal('ok'), value }), ErrorReplySchema]).safeParse(await response.json().catch(() => null)).data;
  if (response.ok && reply?.status === 'ok') return reply.value;
  if (response.status >= 500) throw ClientHttpFailure({ status: response.status });
  throw new Error(reply?.status === 'error' ? reply.error.message : `${refusal} (${response.status})`);
}

/**
 * Upload calls into `spaceId`'s writable `uploads/` artifact folder at `expectedGeneration`: begin over RPC, which
 * answers with the upload's link; the raw parts, commit and abort go through that link, which is their whole authority.
 * `generationOf` pins the committed artifact's scope generation on the returned reference.
 */
export function artifactUploadRpcClient(request: { spaceId: string; expectedGeneration: number }, generationOf: (artifact: { workspaceId: string | null }) => number, send: typeof globalThis.fetch = globalThis.fetch): ArtifactUploadClient {
  return {
    begin: async (input) => {
      const result = await rpcClient.inspector.artifacts.uploadBegin({ ...request, ...input });
      if (result.status === 'error') throw result.error;
      return { link: result.value.link, url: result.value.url, partBytes: result.value.partBytes };
    },
    part: ({ link, partNumber, bytes }, signal) =>
      linkRequest(send, `${link}/parts/${partNumber}`, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' }, signal }, PartSchema, 'The part was refused'),
    commit: async (link) => {
      const artifact = await linkRequest(send, `${link}/complete`, { method: 'POST' }, ArtifactSchema, 'The upload was refused');
      return { kind: 'artifact', url: artifact.url, hash: artifact.hash, label: artifact.path, mediaType: artifact.mediaType, generation: generationOf(artifact) };
    },
    abort: async (link) => {
      await linkRequest(send, link, { method: 'DELETE' }, z.unknown(), 'The abort was refused');
    },
  };
}
