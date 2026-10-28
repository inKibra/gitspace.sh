import { createHash } from 'node:crypto';
import { GitLfsObjectSchema, projectStorageRoot, streamBytes, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';
import { tenantStore, type TenantStore } from './tenant-store.js';

/** The tenant object name of one LFS object: one object per oid, in its project's `lfs:<projectId>` scope. */
export function gitLfsObjectKey(projectId: string, oid: string): string {
  GitLfsObjectSchema.shape.oid.parse(oid);
  return `lfs/${projectStorageRoot(projectId)}/objects/${oid}`;
}

async function* verified(source: AsyncIterable<Uint8Array>, object: GitLfsObject): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of source) {
    size += bytes.byteLength;
    if (size > object.size) throw new Error('LFS object failed oid/size verification');
    hash.update(bytes);
    yield bytes;
  }
  if (size !== object.size || hash.digest('hex') !== object.oid) throw new Error('LFS object failed oid/size verification');
}

/** LFS payloads in the tenant store. The oid is the plaintext SHA-256 the store records, so an object is present only
 * when its recorded digest and size are the pointer's, and a read is verified against it before its last bytes. */
export class AccountGitLfsStore implements GitLfsStore {
  private readonly scope: string;
  constructor(
    private readonly store: TenantStore,
    private readonly projectId: string,
    private readonly pin: (object: GitLfsObject) => Promise<void>,
    private readonly release?: () => Promise<void>,
  ) {
    this.scope = `lfs:${projectId}`;
  }

  async has(object: GitLfsObject): Promise<boolean> {
    GitLfsObjectSchema.parse(object);
    const stored = await this.store.head(gitLfsObjectKey(this.projectId, object.oid), this.scope);
    return stored?.sha256 === `sha256:${object.oid}` && stored.size === object.size;
  }

  async releasePublication(): Promise<void> {
    if (!this.release) throw new Error('LFS publication release is not configured');
    await this.release();
  }

  async get(object: GitLfsObject): Promise<AsyncIterable<Uint8Array> | null> {
    GitLfsObjectSchema.parse(object);
    const stored = await this.store.get(gitLfsObjectKey(this.projectId, object.oid), this.scope);
    if (!stored) return null;
    if (stored.sha256 !== `sha256:${object.oid}` || stored.size !== object.size) {
      await stored.body.cancel();
      throw new Error('LFS object failed oid/size verification');
    }
    return streamBytes(stored.body);
  }

  async put(object: GitLfsObject, source: AsyncIterable<Uint8Array>): Promise<void> {
    GitLfsObjectSchema.parse(object);
    await this.pin(object);
    if (await this.has(object)) {
      for await (const _bytes of verified(source, object)) { /* Validate duplicate uploads too. */ }
      return;
    }
    // Concurrent publishers of one oid write identical bytes under one key; whichever completes last is kept.
    const writer = this.store.writer(gitLfsObjectKey(this.projectId, object.oid), this.scope, { sha256: `sha256:${object.oid}`, size: object.size });
    try {
      for await (const bytes of source) await writer.write(bytes);
    } catch (error) {
      await writer.abort();
      throw error;
    }
    await writer.close();
  }
}

export async function createAccountGitLfsStore(env: Env, userId: string, projectId: string, publicationId: string): Promise<AccountGitLfsStore> {
  if (userId !== env.ACCOUNT_ID) throw new Error('LFS account identity mismatch');
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.getProject();
  if (!project || project.id !== projectId || project.lifecycle === 'deleting') throw new Error('LFS project is unavailable');
  return new AccountGitLfsStore(
    tenantStore(env), projectId,
    // A stub per call: the store lives as long as a workspace runtime, and a stub that saw an error stays broken.
    object => env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`).lfsPin({ publicationId, objects: [object] }),
    () => env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`).lfsReleasePublication(publicationId),
  );
}
