/**
 * UTF-8 Boundary Handling Utilities
 *
 * Provides functions for handling UTF-8 encoded data streams,
 * particularly for finding safe split points in byte buffers
 * to avoid breaking multi-byte character sequences.
 */

/**
 * Find the boundary where complete UTF-8 sequences end.
 * Returns the number of bytes that form complete UTF-8 sequences.
 * Any bytes after this boundary are incomplete and should be buffered.
 *
 * This function is useful when streaming UTF-8 data in chunks,
 * where a multi-byte character might be split across chunk boundaries.
 *
 * @param buf - The byte buffer to analyze (Buffer or Uint8Array)
 * @returns The byte offset where complete UTF-8 sequences end
 *
 * @example
 * ```ts
 * const chunk = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xc3]); // "Hello" + incomplete é
 * const boundary = findUtf8Boundary(chunk); // Returns 5
 * const complete = chunk.slice(0, boundary); // "Hello"
 * const incomplete = chunk.slice(boundary); // [0xc3] - buffer for next chunk
 * ```
 */
export function findUtf8Boundary(buf: Uint8Array | Buffer): number {
  if (buf.length === 0) return 0;

  // UTF-8 encoding:
  // - 1 byte:  0xxxxxxx (0x00-0x7F) - always complete
  // - 2 bytes: 110xxxxx 10xxxxxx (starts with 0xC0-0xDF)
  // - 3 bytes: 1110xxxx 10xxxxxx 10xxxxxx (starts with 0xE0-0xEF)
  // - 4 bytes: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx (starts with 0xF0-0xF7)
  // Continuation bytes: 10xxxxxx (0x80-0xBF)

  // Start from the last byte and work backwards (up to 3 bytes back)
  for (let i = 0; i < Math.min(4, buf.length); i++) {
    const pos = buf.length - 1 - i;
    const byte = buf[pos];

    // Skip continuation bytes (10xxxxxx) - keep looking for the leading byte
    if ((byte & 0xc0) === 0x80) {
      continue;
    }

    // Found a leading byte at pos - check if sequence is complete
    let expectedLen: number;
    if ((byte & 0x80) === 0x00) {
      // ASCII (0xxxxxxx) - 1 byte
      expectedLen = 1;
    } else if ((byte & 0xe0) === 0xc0) {
      // 2-byte sequence (110xxxxx)
      expectedLen = 2;
    } else if ((byte & 0xf0) === 0xe0) {
      // 3-byte sequence (1110xxxx)
      expectedLen = 3;
    } else if ((byte & 0xf8) === 0xf0) {
      // 4-byte sequence (11110xxx)
      expectedLen = 4;
    } else {
      // Invalid leading byte - treat buffer as complete
      return buf.length;
    }

    const actualLen = buf.length - pos;
    if (actualLen >= expectedLen) {
      // Sequence is complete
      return buf.length;
    } else {
      // Incomplete sequence - boundary is at this position
      return pos;
    }
  }

  // Only found continuation bytes (malformed UTF-8) - buffer conservatively
  return Math.max(0, buf.length - 3);
}
