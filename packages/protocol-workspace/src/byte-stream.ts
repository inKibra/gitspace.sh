/** Read with backpressure, cancelling the source on failure, early return or abort. */
export async function* streamBytes(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Only for finite metadata, encrypted chunks, or bounded tool results—not LFS payloads. */
export async function collectBytes(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid byte limit');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    if (!chunk.byteLength) continue;
    if (chunk.byteLength > maxBytes - size) throw new Error('Byte stream exceeds size limit');
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
