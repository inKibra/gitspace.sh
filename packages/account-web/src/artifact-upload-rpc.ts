import { z } from 'zod';
import { DRIVE_UPLOAD_PATH } from '@gitspace/protocol/rpc-contract';
import { ClientHttpFailure, ClientNetworkFailure } from 'result-rpc';
import type { ArtifactUploadClient } from './inspector/artifact-upload.js';
import { createDeviceSignedFetch } from './device.js';
import { currentDevice, deviceRejected } from './device-session.js';
import { rpcClient } from './rpc-client.js';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);
const PartReplySchema = z.union([
  z.object({ status: z.literal('ok'), value: z.object({ received: z.number().int().nonnegative() }) }),
  z.object({ status: z.literal('error'), error: z.object({ message: z.string() }) }),
]);

/**
 * Upload calls into `spaceId`'s writable `uploads/` artifact folder at `expectedGeneration`: begin, commit and abort
 * over RPC; the parts as raw device-signed `PUT`s, which RPC would carry base64 in small chunks.
 * `generationOf` pins the committed artifact's scope generation on the returned reference.
 */
export function artifactUploadRpcClient(request: { spaceId: string; expectedGeneration: number }, generationOf: (artifact: { workspaceId: string | null }) => number, fetchPart: typeof globalThis.fetch = signedFetch): ArtifactUploadClient {
  return {
    begin: async (input) => {
      const result = await rpcClient.inspector.artifacts.uploadBegin({ ...request, ...input });
      if (result.status === 'error') throw result.error;
      return { uploadId: result.value.uploadId, url: result.value.url, partBytes: result.value.partBytes };
    },
    part: async ({ uploadId, partNumber, bytes }, signal) => {
      const query = new URLSearchParams({ spaceId: request.spaceId, expectedGeneration: String(request.expectedGeneration) });
      let response: Response;
      try {
        response = await fetchPart(`${DRIVE_UPLOAD_PATH}/${uploadId}/parts/${partNumber}?${query}`, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' }, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw ClientNetworkFailure({ retryable: true });
      }
      const reply = PartReplySchema.safeParse(await response.json().catch(() => null)).data;
      if (response.ok && reply?.status === 'ok') return reply.value;
      // A server or gateway failure leaves the upload where it was; a refusal is final.
      if (response.status >= 500) throw ClientHttpFailure({ status: response.status });
      throw new Error(reply?.status === 'error' ? reply.error.message : `The part was refused (${response.status})`);
    },
    commit: async (uploadId) => {
      const result = await rpcClient.inspector.artifacts.uploadCommit({ ...request, uploadId });
      if (result.status === 'error') throw result.error;
      const artifact = result.value;
      return { kind: 'artifact', url: artifact.url, hash: artifact.hash, label: artifact.path, mediaType: artifact.mediaType, generation: generationOf(artifact) };
    },
    abort: async (uploadId) => {
      const result = await rpcClient.inspector.artifacts.uploadAbort({ ...request, uploadId });
      if (result.status === 'error') throw result.error;
    },
  };
}
