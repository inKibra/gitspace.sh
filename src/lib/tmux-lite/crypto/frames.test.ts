import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  decodeFrame,
  peekStreamId,
  createFrame,
  openFrame,
  MASTER_STREAM_ID,
  STREAM_ID_LENGTH,
  MIN_FRAME_LENGTH,
  type EncryptedFrame,
} from "./frames";
import { NONCE_LENGTH, AUTH_TAG_LENGTH, generateNonce } from "./secretbox";
import { randomBytes } from "node:crypto";

const testKey = randomBytes(32);

describe("constants", () => {
  test("MASTER_STREAM_ID is 0", () => {
    expect(MASTER_STREAM_ID).toBe(0);
  });

  test("STREAM_ID_LENGTH is 4", () => {
    expect(STREAM_ID_LENGTH).toBe(4);
  });

  test("MIN_FRAME_LENGTH is correct", () => {
    expect(MIN_FRAME_LENGTH).toBe(STREAM_ID_LENGTH + NONCE_LENGTH + AUTH_TAG_LENGTH);
  });
});

describe("encodeFrame/decodeFrame", () => {
  test("encodes and decodes frame", () => {
    const frame: EncryptedFrame = {
      streamId: 42,
      nonce: generateNonce(),
      ciphertext: Buffer.from("encrypted-data-here"),
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.streamId).toBe(42);
    expect(decoded!.nonce.equals(frame.nonce)).toBe(true);
    expect(decoded!.ciphertext.equals(frame.ciphertext)).toBe(true);
  });

  test("encodes streamId as big-endian uint32", () => {
    const frame: EncryptedFrame = {
      streamId: 0x12345678,
      nonce: generateNonce(),
      ciphertext: randomBytes(32),
    };

    const encoded = encodeFrame(frame);

    expect(encoded[0]).toBe(0x12);
    expect(encoded[1]).toBe(0x34);
    expect(encoded[2]).toBe(0x56);
    expect(encoded[3]).toBe(0x78);
  });

  test("encodes master stream (0)", () => {
    const frame: EncryptedFrame = {
      streamId: MASTER_STREAM_ID,
      nonce: generateNonce(),
      ciphertext: randomBytes(32), // Must be >= AUTH_TAG_LENGTH
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded!.streamId).toBe(MASTER_STREAM_ID);
  });

  test("encodes large streamId", () => {
    const frame: EncryptedFrame = {
      streamId: 0xffffffff,
      nonce: generateNonce(),
      ciphertext: randomBytes(32), // Must be >= AUTH_TAG_LENGTH
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded!.streamId).toBe(0xffffffff);
  });

  test("decodeFrame returns null for too-short buffer", () => {
    const tooShort = Buffer.alloc(MIN_FRAME_LENGTH - 1);
    const decoded = decodeFrame(tooShort);
    expect(decoded).toBeNull();
  });

  test("decodeFrame accepts Uint8Array", () => {
    const frame: EncryptedFrame = {
      streamId: 1,
      nonce: generateNonce(),
      ciphertext: randomBytes(32), // Must be >= AUTH_TAG_LENGTH
    };

    const encoded = new Uint8Array(encodeFrame(frame));
    const decoded = decodeFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.streamId).toBe(1);
  });

  test("handles empty ciphertext", () => {
    const frame: EncryptedFrame = {
      streamId: 1,
      nonce: generateNonce(),
      ciphertext: Buffer.alloc(AUTH_TAG_LENGTH), // Just auth tag, no payload
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.ciphertext.length).toBe(AUTH_TAG_LENGTH);
  });
});

describe("peekStreamId", () => {
  test("extracts streamId without full decode", () => {
    const frame: EncryptedFrame = {
      streamId: 123,
      nonce: generateNonce(),
      ciphertext: randomBytes(32),
    };

    const encoded = encodeFrame(frame);
    const streamId = peekStreamId(encoded);

    expect(streamId).toBe(123);
  });

  test("returns null for too-short buffer", () => {
    const tooShort = Buffer.alloc(STREAM_ID_LENGTH - 1);
    const streamId = peekStreamId(tooShort);
    expect(streamId).toBeNull();
  });

  test("works with exactly STREAM_ID_LENGTH bytes", () => {
    const buf = Buffer.alloc(STREAM_ID_LENGTH);
    buf.writeUInt32BE(999, 0);

    const streamId = peekStreamId(buf);
    expect(streamId).toBe(999);
  });

  test("accepts Uint8Array", () => {
    const frame: EncryptedFrame = {
      streamId: 456,
      nonce: generateNonce(),
      ciphertext: randomBytes(32),
    };

    const encoded = new Uint8Array(encodeFrame(frame));
    const streamId = peekStreamId(encoded);

    expect(streamId).toBe(456);
  });
});

describe("createFrame/openFrame", () => {
  test("creates and opens frame", () => {
    const plaintext = Buffer.from("Hello, World!");
    const frame = createFrame(MASTER_STREAM_ID, plaintext, testKey);

    const result = openFrame(frame, testKey);

    expect(result).not.toBeNull();
    expect(result!.streamId).toBe(MASTER_STREAM_ID);
    expect(result!.data.equals(plaintext)).toBe(true);
  });

  test("creates frame with custom streamId", () => {
    const plaintext = Buffer.from("Session data");
    const streamId = 42;
    const frame = createFrame(streamId, plaintext, testKey);

    const result = openFrame(frame, testKey);

    expect(result).not.toBeNull();
    expect(result!.streamId).toBe(streamId);
    expect(result!.data.equals(plaintext)).toBe(true);
  });

  test("openFrame fails with wrong key", () => {
    const plaintext = Buffer.from("Secret message");
    const frame = createFrame(MASTER_STREAM_ID, plaintext, testKey);

    const wrongKey = randomBytes(32);
    const result = openFrame(frame, wrongKey);

    expect(result).toBeNull();
  });

  test("openFrame fails with tampered frame", () => {
    const plaintext = Buffer.from("Secret message");
    const frame = createFrame(MASTER_STREAM_ID, plaintext, testKey);

    // Tamper with encrypted data
    frame[STREAM_ID_LENGTH + NONCE_LENGTH + 5] ^= 0xff;
    const result = openFrame(frame, testKey);

    expect(result).toBeNull();
  });

  test("openFrame returns null for too-short frame", () => {
    const tooShort = Buffer.alloc(MIN_FRAME_LENGTH - 1);
    const result = openFrame(tooShort, testKey);
    expect(result).toBeNull();
  });

  test("handles empty plaintext", () => {
    const plaintext = Buffer.from("");
    const frame = createFrame(MASTER_STREAM_ID, plaintext, testKey);

    const result = openFrame(frame, testKey);

    expect(result).not.toBeNull();
    expect(result!.data.length).toBe(0);
  });

  test("handles large plaintext", () => {
    const plaintext = randomBytes(64 * 1024); // 64KB
    const frame = createFrame(MASTER_STREAM_ID, plaintext, testKey);

    const result = openFrame(frame, testKey);

    expect(result).not.toBeNull();
    expect(result!.data.equals(plaintext)).toBe(true);
  });

  test("accepts Uint8Array inputs", () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const key = new Uint8Array(testKey);
    const frame = createFrame(1, plaintext, key);

    const result = openFrame(frame, key);

    expect(result).not.toBeNull();
    expect(Buffer.from(result!.data).equals(Buffer.from(plaintext))).toBe(true);
  });

  test("streamId can be peeked before decryption", () => {
    const plaintext = Buffer.from("Secret");
    const streamId = 789;
    const frame = createFrame(streamId, plaintext, testKey);

    // Can peek without decrypting
    const peeked = peekStreamId(frame);
    expect(peeked).toBe(streamId);

    // Can still decrypt after peeking
    const result = openFrame(frame, testKey);
    expect(result).not.toBeNull();
  });
});
