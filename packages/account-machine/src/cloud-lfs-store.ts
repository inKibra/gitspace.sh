import { createSignedControlRequest, deriveArtifactScopeKey } from '@gitspace/protocol';
import { collectBytes, streamBytes, GitLfsObjectSchema, GitLfsOriginConfirmationSchema, GitLfsProtectionSchema, GitLfsSnapshotSchema, projectStorageRoot, type GitLfsObject, type GitLfsOriginConfirmation, type GitLfsSnapshot, type GitLfsStore } from '@gitspace/protocol-workspace';
import { EncryptedCheckpointBlobStore, type CheckpointBlobStore } from './portable-space-lifecycle.js';
import { z } from 'zod';

export type CloudGitLfsStoreOptions = {
  projectId: string;
  blobs: CheckpointBlobStore;
  encryptionKey: Uint8Array;
  publicationId?: string;
  controlOptions: { baseUrl: string; userId: string; machineId: string; signingPrivateKey: Uint8Array; fetcher?: typeof fetch };
};

export async function createCloudGitLfsStore(options: CloudGitLfsStoreOptions): Promise<GitLfsStore & {
  releasePublication(): Promise<void>;
  confirmOrigin(confirmation: GitLfsOriginConfirmation): Promise<void>;
  resolveSources(objects: GitLfsSnapshot['objects']): Promise<GitLfsSnapshot['objects']>;
}> {
  const root = `lfs/${projectStorageRoot(options.projectId)}/objects`;
  const encrypted = new EncryptedCheckpointBlobStore(options.blobs, await deriveArtifactScopeKey(options.encryptionKey, `lfs:${options.projectId}`));
  const pinned = new Set<string>();
  const objectKey = (object: GitLfsObject) => `${root}/${GitLfsObjectSchema.parse(object).oid}`;
  const control = async <S extends z.ZodType>(operation: Extract<Parameters<typeof createSignedControlRequest>[0]['operation'], `lfs.${string}`>, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> => {
    const request = createSignedControlRequest({ ...options.controlOptions, operation, payload: { projectId: options.projectId, ...payload } });
    const response = await (options.controlOptions.fetcher ?? fetch)(new URL('/v1/control', options.controlOptions.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`LFS publication ${operation} failed with ${response.status}`);
    }
    const bytes = response.body ? await collectBytes(streamBytes(response.body), 64 * 1024 * 1024) : new Uint8Array();
    const envelope = z.object({ status: z.literal('ok'), value: z.unknown() }).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return schema.parse(envelope.value);
  };
  const pin = async (object: GitLfsObject) => {
    GitLfsObjectSchema.parse(object);
    if (!options.publicationId || pinned.has(object.oid)) return;
    await control('lfs.pin', { publicationId: options.publicationId, objects: [object] }, GitLfsProtectionSchema);
    pinned.add(object.oid);
  };
  const verify = async function* (object: GitLfsObject, source: AsyncIterable<Uint8Array>) {
    const hash = new Bun.CryptoHasher('sha256');
    let size = 0;
    for await (const bytes of source) {
      size += bytes.byteLength;
      if (size > object.size) throw new Error('LFS object failed oid/size verification');
      hash.update(bytes);
      yield bytes;
    }
    if (size !== object.size || hash.digest('hex') !== object.oid) throw new Error('LFS object failed oid/size verification');
  };
  const get = async (object: GitLfsObject) => {
    GitLfsObjectSchema.parse(object);
    const source = await encrypted.getStream(objectKey(object), undefined, object.size);
    return source === null ? null : verify(object, source);
  };
  const has = async (object: GitLfsObject) => {
    const source = await get(object);
    if (source === null) return false;
    for await (const _chunk of source) { /* Exhaustion verifies the complete object. */ }
    return true;
  };
  return {
    get,
    async protect(objects) {
      if (!options.publicationId) throw new Error('LFS protection requires a durable publication identity');
      const requested = GitLfsObjectSchema.array().parse(objects);
      const result = await control('lfs.pin', { publicationId: options.publicationId, objects: requested }, GitLfsProtectionSchema);
      const sizes = new Map(requested.map(object => [object.oid, object.size]));
      if (result.objects.some(object => sizes.get(object.oid) !== object.size)) throw new Error('LFS protection returned an unrequested object');
      for (const object of requested) pinned.add(object.oid);
      return result.objects;
    },
    async has(object) { await pin(object); return has(object); },
    async put(object, source) {
      GitLfsObjectSchema.parse(object);
      if (!options.publicationId) throw new Error('LFS upload requires a durable publication identity');
      await pin(object);
      if (await has(object)) {
        for await (const _chunk of verify(object, source)) { /* Verify even a deduplicated source. */ }
        return;
      }
      let sourceVerified = false;
      const verified = (async function* () {
        yield* verify(object, source);
        sourceVerified = true;
      })();
      try { await encrypted.putStream(objectKey(object), verified, object.size); }
      catch (error) {
        // Only a fully verified upload may accept independently encrypted winning bytes.
        if (!sourceVerified || !await has(object)) throw error;
      }
    },
    async releasePublication() {
      if (options.publicationId) await control('lfs.release', { publicationId: options.publicationId }, z.null());
      pinned.clear();
    },
    async confirmOrigin(confirmation) {
      await control('lfs.originConfirmed', GitLfsOriginConfirmationSchema.parse(confirmation), z.null());
    },
    async resolveSources(objects) {
      const requested = GitLfsSnapshotSchema.shape.objects.parse(objects);
      const resolved = await control('lfs.sources', { objects: requested }, GitLfsSnapshotSchema.shape.objects);
      if (resolved.length !== requested.length || resolved.some((object, index) => object.oid !== requested[index]?.oid || object.size !== requested[index]?.size)) throw new Error('LFS source resolution changed the requested inventory');
      return resolved;
    },
  };
}
