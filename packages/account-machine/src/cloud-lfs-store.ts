import { createSignedControlRequest, sendSigned } from '@gitspace/protocol';
import { collectBytes, streamBytes, GitLfsObjectSchema, GitLfsProtectionSchema, projectStorageRoot, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';
import { verifiedBytes, type StreamingBlobStore } from './checkpoint-blobs.js';
import { cloudControlOptions, type SignedCloudRequestOptions } from './cloud-space-authority.js';
import { z } from 'zod';

export type CloudGitLfsStoreOptions = {
  projectId: string;
  blobs: StreamingBlobStore;
  controlOptions: SignedCloudRequestOptions;
};
/** Restores read verified objects; they hold no publication and so can neither pin nor upload. */
export type CloudGitLfsReader = Pick<GitLfsStore, 'has' | 'get'> & {
};
/** Every pin and upload belongs to the publication identity fixed at construction until it is released. */
export type CloudGitLfsPublisher = CloudGitLfsReader & Required<GitLfsStore> & { releasePublication(): Promise<void> };

function cloudGitLfs(options: CloudGitLfsStoreOptions) {
  const root = `lfs/${projectStorageRoot(options.projectId)}/objects`;
  const objectKey = (object: GitLfsObject) => `${root}/${GitLfsObjectSchema.parse(object).oid}`;
  const controlOptions = cloudControlOptions(options.controlOptions);
  const control = async <S extends z.ZodType>(operation: Extract<Parameters<typeof createSignedControlRequest>[0]['operation'], `lfs.${string}`>, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> => {
    const response = await sendSigned(controlOptions.clock, (timestamp) => {
      const request = createSignedControlRequest({ ...controlOptions, operation, payload: { projectId: options.projectId, ...payload }, timestamp });
      return (controlOptions.fetcher ?? fetch)(new URL('/v1/control', controlOptions.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`LFS publication ${operation} failed with ${response.status}`);
    }
    const bytes = response.body ? await collectBytes(streamBytes(response.body), 64 * 1024 * 1024) : new Uint8Array();
    const envelope = z.object({ status: z.literal('ok'), value: z.unknown() }).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return schema.parse(envelope.value);
  };
  // The oid is the plaintext SHA-256: the store's read verification is the LFS oid/size check.
  const get = async (object: GitLfsObject) => options.blobs.getStream(objectKey(object), { hash: `sha256:${object.oid}`, size: object.size });
  const has = async (object: GitLfsObject) => {
    const source = await get(object);
    if (source === null) return false;
    for await (const _chunk of source) { /* Exhaustion verifies the complete object. */ }
    return true;
  };
  const reader: CloudGitLfsReader = {
    get,
    has,
  };
  return { reader, control, objectKey };
}

export function createCloudGitLfsStore(options: CloudGitLfsStoreOptions): CloudGitLfsReader {
  return cloudGitLfs(options).reader;
}

export function createCloudGitLfsPublisher(options: CloudGitLfsStoreOptions & { publicationId: string }): CloudGitLfsPublisher {
  const { reader, control, objectKey } = cloudGitLfs(options);
  const { publicationId } = options;
  const pinned = new Set<string>();
  const pin = async (object: GitLfsObject) => {
    GitLfsObjectSchema.parse(object);
    if (pinned.has(object.oid)) return;
    await control('lfs.pin', { publicationId, objects: [object] }, GitLfsProtectionSchema);
    pinned.add(object.oid);
  };
  return {
    ...reader,
    async protect(objects) {
      const requested = GitLfsObjectSchema.array().parse(objects);
      const result = await control('lfs.pin', { publicationId, objects: requested }, GitLfsProtectionSchema);
      const sizes = new Map(requested.map(object => [object.oid, object.size]));
      if (result.objects.some(object => sizes.get(object.oid) !== object.size)) throw new Error('LFS protection returned an unrequested object');
      for (const object of requested) pinned.add(object.oid);
      return result.objects;
    },
    async has(object) { await pin(object); return reader.has(object); },
    async put(object, source) {
      await pin(object);
      const expected = { hash: `sha256:${object.oid}`, size: object.size };
      const label = `LFS object ${object.oid}`;
      if (await reader.has(object)) {
        for await (const _chunk of verifiedBytes(source, expected, label)) { /* Verify even a deduplicated source. */ }
        return;
      }
      let sourceVerified = false;
      const verified = (async function* () {
        yield* verifiedBytes(source, expected, label);
        sourceVerified = true;
      })();
      try { await options.blobs.putStream(objectKey(object), verified, expected); }
      catch (error) {
        // A concurrent publication of the same oid stores the same bytes; only a fully verified upload may accept it.
        if (!sourceVerified || !await reader.has(object)) throw error;
      }
    },
    async releasePublication() {
      await control('lfs.release', { publicationId }, z.null());
      pinned.clear();
    },
  };
}
