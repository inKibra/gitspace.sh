/**
 * Encrypted frame encoding for E2E communication
 *
 * Frame format:
 * ┌────────────┬────────────┬──────────────────────────────────────────────┐
 * │  streamId  │   nonce    │   encrypted payload + authTag (16 bytes)     │
 * │  4 bytes   │  12 bytes  │              variable length                 │
 * └────────────┴────────────┴──────────────────────────────────────────────┘
 *
 * Stream IDs:
 * - 0: Master stream (full machine access)
 * - 1+: Session share streams (per-terminal access)
 */

import { NONCE_LENGTH, AUTH_TAG_LENGTH, encrypt, decrypt } from "./secretbox";

/** Stream ID for master access (full machine) */
export const MASTER_STREAM_ID = 0;

/** Length of stream ID field in bytes */
export const STREAM_ID_LENGTH = 4;

/** Minimum frame length (streamId + nonce + authTag, no payload) */
export const MIN_FRAME_LENGTH = STREAM_ID_LENGTH + NONCE_LENGTH + AUTH_TAG_LENGTH;

/**
 * Encrypted frame structure
 */
export interface EncryptedFrame {
  /** Stream ID (0 = master, 1+ = session shares) */
  streamId: number;
  /** Nonce used for encryption (12 bytes) */
  nonce: Buffer;
  /** Encrypted payload with auth tag appended */
  ciphertext: Buffer;
}

/**
 * Encode an encrypted frame to a buffer
 *
 * @param frame - The encrypted frame to encode
 * @returns Buffer ready to send over the wire
 */
export function encodeFrame(frame: EncryptedFrame): Buffer {
  const buf = Buffer.alloc(
    STREAM_ID_LENGTH + NONCE_LENGTH + frame.ciphertext.length
  );

  // Write stream ID (big-endian)
  buf.writeUInt32BE(frame.streamId, 0);

  // Copy nonce
  frame.nonce.copy(buf, STREAM_ID_LENGTH);

  // Copy ciphertext
  frame.ciphertext.copy(buf, STREAM_ID_LENGTH + NONCE_LENGTH);

  return buf;
}

/**
 * Decode an encrypted frame from a buffer
 *
 * @param data - Raw buffer from the wire
 * @returns Decoded frame, or null if too short
 */
export function decodeFrame(data: Buffer | Uint8Array): EncryptedFrame | null {
  if (data.length < MIN_FRAME_LENGTH) {
    return null;
  }

  const buf = Buffer.from(data);

  const streamId = buf.readUInt32BE(0);
  const nonce = buf.slice(STREAM_ID_LENGTH, STREAM_ID_LENGTH + NONCE_LENGTH);
  const ciphertext = buf.slice(STREAM_ID_LENGTH + NONCE_LENGTH);

  return { streamId, nonce, ciphertext };
}

/**
 * Peek at the stream ID without decoding the full frame
 *
 * Useful for routing frames to the right decryption key.
 *
 * @param data - Raw buffer from the wire
 * @returns Stream ID, or null if buffer too short
 */
export function peekStreamId(data: Buffer | Uint8Array): number | null {
  if (data.length < STREAM_ID_LENGTH) {
    return null;
  }

  return Buffer.from(data).readUInt32BE(0);
}

/**
 * Create an encrypted frame from plaintext data
 *
 * @param streamId - Stream ID (0 = master, 1+ = session)
 * @param data - Plaintext data to encrypt
 * @param key - Encryption key (from deriveKey)
 * @returns Encoded frame buffer ready to send
 */
export function createFrame(
  streamId: number,
  data: Uint8Array | Buffer,
  key: Uint8Array | Buffer
): Buffer {
  const encResult = encrypt(data, key);
  if (!encResult) {
    throw new Error('createFrame: invalid key length (expected 32 bytes)');
  }
  const { nonce, ciphertext } = encResult;

  return encodeFrame({
    streamId,
    nonce,
    ciphertext,
  });
}

/**
 * Decrypt a frame and return the plaintext
 *
 * @param frame - Encoded frame buffer from the wire
 * @param key - Decryption key (from deriveKey)
 * @returns Decrypted plaintext, or null if decryption failed
 */
export function openFrame(
  frame: Buffer | Uint8Array,
  key: Uint8Array | Buffer
): { streamId: number; data: Buffer } | null {
  const decoded = decodeFrame(frame);
  if (!decoded) {
    return null;
  }

  const data = decrypt(decoded.ciphertext, decoded.nonce, key);
  if (!data) {
    return null;
  }

  return { streamId: decoded.streamId, data };
}
