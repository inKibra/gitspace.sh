/**
 * R2 as SSE-C behaves in production; Miniflare's R2 binding drops `ssecKey`. An object written with a key reads, ranges
 * and takes parts only with that same key, as R2 refuses any other. As in production (probed 2026-10-23), an empty body
 * is stored without encryption whatever key the put names, and R2 answers a read naming a key with error 10034, as it
 * answers a read naming none of an encrypted object.
 */
export function ssecBucket(bucket: R2Bucket): R2Bucket {
  const keys = new Map<string, string>();
  const fingerprint = (key: ArrayBuffer | string | undefined): string => key === undefined ? 'none' : typeof key === 'string' ? key : Buffer.from(key).toString('hex');
  const opened = (name: string, key: ArrayBuffer | string | undefined): void => {
    const stored = keys.get(name);
    if (stored !== undefined && stored !== fingerprint(key)) throw new Error('SSE-C key does not match the object');
  };
  return {
    head: (key: string) => bucket.head(key),
    async get(key: string, options?: R2GetOptions) {
      const stored = keys.get(key);
      if (stored === 'empty' && options?.ssecKey !== undefined) throw new Error('get: The encryption parameters are not applicable to this object. (10034)');
      if (stored !== undefined && stored !== 'empty' && stored !== 'none' && options?.ssecKey === undefined) throw new Error('get: The object was stored using a form of Server Side Encryption. The correct parameters must be provided to retrieve the object. (10034)');
      if (stored !== 'empty') opened(key, options?.ssecKey);
      return bucket.get(key, options);
    },
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions) {
      const stored = await bucket.put(key, value, options);
      if (stored) keys.set(key, stored.size === 0 ? 'empty' : fingerprint(options?.ssecKey));
      return stored;
    },
    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      const upload = await bucket.createMultipartUpload(key, options);
      keys.set(key, fingerprint(options?.ssecKey));
      return upload;
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return {
        key: upload.key,
        uploadId: upload.uploadId,
        async uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, options?: R2UploadPartOptions) {
          opened(key, options?.ssecKey);
          return upload.uploadPart(partNumber, value, options);
        },
        abort: () => upload.abort(),
        complete: (parts: R2UploadedPart[]) => upload.complete(parts),
      };
    },
    delete: (names: string | string[]) => bucket.delete(names),
    list: (options?: R2ListOptions) => bucket.list(options),
  };
}
