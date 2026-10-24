import { createHash } from 'node:crypto';

/** `length` bytes of an endless test file from offset `start`: each 4-byte word holds its own offset, so bytes read at a
 * wrong offset never match, and a large file is generated piece by piece instead of held whole. */
export function pattern(start: number, length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const position = start + index;
    bytes[index] = ((position - position % 4) >>> (8 * (3 - position % 4))) & 0xff;
  }
  return bytes;
}

/** The `sha256:` digest of a body, read without holding it. */
export async function streamedSha256(body: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  const reader = body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) hash.update(read.value);
  return `sha256:${hash.digest('hex')}`;
}
