import { collectBytes, type GitLfsObject, type GitLfsStore } from '@gitspace/protocol-workspace';

export async function* lfsBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
    yield bytes.subarray(offset, offset + 1024 * 1024);
  }
}

export async function readLfs(store: GitLfsStore, object: GitLfsObject): Promise<Uint8Array | null> {
  const source = await store.get(object);
  return source ? collectBytes(source, object.size) : null;
}
