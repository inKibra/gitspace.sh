/**
 * Browser-compatible encrypted frame encoding for E2E communication
 *
 * Uses AES-256-GCM via Web Crypto API
 *
 * Frame format:
 * ┌────────────┬────────────┬──────────────────────────────────────────────┐
 * │  streamId  │   nonce    │   encrypted payload + authTag (16 bytes)     │
 * │  4 bytes   │  12 bytes  │              variable length                 │
 * └────────────┴────────────┴──────────────────────────────────────────────┘
 */

/** Nonce/IV length in bytes (96-bit for AES-GCM) */
export const NONCE_LENGTH = 12;

/** Auth tag length in bytes */
export const AUTH_TAG_LENGTH = 16;

/** Stream ID for master access */
export const MASTER_STREAM_ID = 0;

/** Length of stream ID field */
export const STREAM_ID_LENGTH = 4;

/** Minimum frame length */
export const MIN_FRAME_LENGTH = STREAM_ID_LENGTH + NONCE_LENGTH + AUTH_TAG_LENGTH;

/**
 * Encrypted frame structure
 */
export interface EncryptedFrame {
  streamId: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Convert Uint8Array to ArrayBuffer
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/**
 * Import a key for AES-GCM
 */
async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Generate a random nonce
 */
function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Encrypt data using AES-256-GCM
 */
export async function encrypt(
  data: Uint8Array,
  key: Uint8Array
): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const nonce = generateNonce();
  const cryptoKey = await importKey(key);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: AUTH_TAG_LENGTH * 8 },
    cryptoKey,
    toArrayBuffer(data)
  );

  return { nonce, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Decrypt data using AES-256-GCM
 */
export async function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array | null> {
  try {
    const cryptoKey = await importKey(key);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: AUTH_TAG_LENGTH * 8 },
      cryptoKey,
      toArrayBuffer(ciphertext)
    );

    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

/**
 * Encode an encrypted frame to a buffer
 */
export function encodeFrame(frame: EncryptedFrame): Uint8Array {
  const buf = new Uint8Array(
    STREAM_ID_LENGTH + NONCE_LENGTH + frame.ciphertext.length
  );

  // Write stream ID (big-endian)
  const view = new DataView(buf.buffer);
  view.setUint32(0, frame.streamId, false);

  // Copy nonce
  buf.set(frame.nonce, STREAM_ID_LENGTH);

  // Copy ciphertext
  buf.set(frame.ciphertext, STREAM_ID_LENGTH + NONCE_LENGTH);

  return buf;
}

/**
 * Decode an encrypted frame from a buffer
 */
export function decodeFrame(data: Uint8Array): EncryptedFrame | null {
  if (data.length < MIN_FRAME_LENGTH) {
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const streamId = view.getUint32(0, false);
  const nonce = data.slice(STREAM_ID_LENGTH, STREAM_ID_LENGTH + NONCE_LENGTH);
  const ciphertext = data.slice(STREAM_ID_LENGTH + NONCE_LENGTH);

  return { streamId, nonce, ciphertext };
}

/**
 * Create an encrypted frame from plaintext data
 */
export async function createFrame(
  streamId: number,
  data: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  const { nonce, ciphertext } = await encrypt(data, key);

  return encodeFrame({
    streamId,
    nonce,
    ciphertext,
  });
}

/**
 * Decrypt a frame and return the plaintext
 */
export async function openFrame(
  frame: Uint8Array,
  key: Uint8Array
): Promise<{ streamId: number; data: Uint8Array } | null> {
  const decoded = decodeFrame(frame);
  if (!decoded) {
    return null;
  }

  const data = await decrypt(decoded.ciphertext, decoded.nonce, key);
  if (!data) {
    return null;
  }

  return { streamId: decoded.streamId, data };
}

/**
 * Encrypt data and return a single buffer with nonce prepended
 */
export async function seal(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const { nonce, ciphertext } = await encrypt(data, key);
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

/**
 * Decrypt data from a sealed buffer
 */
export async function open(sealed: Uint8Array, key: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
    return null;
  }

  const nonce = sealed.slice(0, NONCE_LENGTH);
  const ciphertext = sealed.slice(NONCE_LENGTH);

  return decrypt(ciphertext, nonce, key);
}
