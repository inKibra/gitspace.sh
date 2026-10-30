import type { DefaultReleaseReader } from '@gitspace/protocol/default-release';

export function defaultReleaseReader(bucket: R2Bucket): DefaultReleaseReader {
  return { async get(key) { const object = await bucket.get(key); return object ? { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag } : null; } };
}
