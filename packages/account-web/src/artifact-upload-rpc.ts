import type { ArtifactUploadClient } from './inspector/artifact-upload.js';
import { rpcClient } from './rpc-client.js';

/**
 * Upload calls into `spaceId`'s writable `uploads/` artifact folder at `expectedGeneration`.
 * `generationOf` pins the committed artifact's scope generation on the returned reference.
 */
export function artifactUploadRpcClient(request: { spaceId: string; expectedGeneration: number }, generationOf: (artifact: { workspaceId: string | null }) => number): ArtifactUploadClient {
  return {
    begin: async (input) => {
      const result = await rpcClient.inspector.artifacts.uploadBegin({ ...request, ...input });
      if (result.status === 'error') throw result.error;
      return result.value;
    },
    chunk: async (input, signal) => {
      const result = await rpcClient.inspector.artifacts.uploadChunk({ ...request, ...input }, { signal });
      if (result.status === 'error') throw result.error;
      return result.value;
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
