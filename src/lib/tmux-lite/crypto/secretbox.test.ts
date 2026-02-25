import { describe, expect, test } from "bun:test";
import {
  encrypt,
  decrypt,
  seal,
  open,
  generateNonce,
  NONCE_LENGTH,
  AUTH_TAG_LENGTH,
} from "./secretbox";
import { randomBytes } from "node:crypto";

// Generate a valid 256-bit key for testing
const testKey = randomBytes(32);

describe("generateNonce", () => {
  test("generates nonce of correct length", () => {
    const nonce = generateNonce();
    expect(nonce).toBeInstanceOf(Buffer);
    expect(nonce.length).toBe(NONCE_LENGTH);
  });

  test("generates unique nonces", () => {
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();
    expect(nonce1.equals(nonce2)).toBe(false);
  });
});

describe("encrypt/decrypt", () => {
  test("encrypts and decrypts data", () => {
    const plaintext = Buffer.from("Hello, World!");
    const result = encrypt(plaintext, testKey);
    expect(result).not.toBeNull();
    const { nonce, ciphertext } = result!;

    expect(nonce.length).toBe(NONCE_LENGTH);
    expect(ciphertext.length).toBe(plaintext.length + AUTH_TAG_LENGTH);

    const decrypted = decrypt(ciphertext, nonce, testKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.equals(plaintext)).toBe(true);
  });

  test("encrypts empty data", () => {
    const plaintext = Buffer.from("");
    const result = encrypt(plaintext, testKey);
    expect(result).not.toBeNull();
    const { nonce, ciphertext } = result!;

    expect(ciphertext.length).toBe(AUTH_TAG_LENGTH);

    const decrypted = decrypt(ciphertext, nonce, testKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.length).toBe(0);
  });

  test("encrypts large data", () => {
    const plaintext = randomBytes(1024 * 1024); // 1MB
    const result = encrypt(plaintext, testKey);
    expect(result).not.toBeNull();
    const { nonce, ciphertext } = result!;

    const decrypted = decrypt(ciphertext, nonce, testKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.equals(plaintext)).toBe(true);
  });

  test("same plaintext produces different ciphertext (random nonce)", () => {
    const plaintext = Buffer.from("Hello, World!");
    const result1 = encrypt(plaintext, testKey);
    const result2 = encrypt(plaintext, testKey);
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();

    expect(result1!.nonce.equals(result2!.nonce)).toBe(false);
    expect(result1!.ciphertext.equals(result2!.ciphertext)).toBe(false);
  });

  test("returns null for wrong key length", () => {
    const plaintext = Buffer.from("Hello, World!");
    expect(encrypt(plaintext, randomBytes(16))).toBeNull();
    expect(encrypt(plaintext, randomBytes(31))).toBeNull();
    expect(encrypt(plaintext, randomBytes(0))).toBeNull();
  });

  test("decryption fails with wrong key", () => {
    const plaintext = Buffer.from("Hello, World!");
    const { nonce, ciphertext } = encrypt(plaintext, testKey)!;

    const wrongKey = randomBytes(32);
    const decrypted = decrypt(ciphertext, nonce, wrongKey);
    expect(decrypted).toBeNull();
  });

  test("decryption fails with wrong nonce", () => {
    const plaintext = Buffer.from("Hello, World!");
    const { ciphertext } = encrypt(plaintext, testKey)!;

    const wrongNonce = generateNonce();
    const decrypted = decrypt(ciphertext, wrongNonce, testKey);
    expect(decrypted).toBeNull();
  });

  test("decryption fails with tampered ciphertext", () => {
    const plaintext = Buffer.from("Hello, World!");
    const { nonce, ciphertext } = encrypt(plaintext, testKey)!;

    // Tamper with the ciphertext
    ciphertext[0] ^= 0xff;
    const decrypted = decrypt(ciphertext, nonce, testKey);
    expect(decrypted).toBeNull();
  });

  test("decryption fails with tampered auth tag", () => {
    const plaintext = Buffer.from("Hello, World!");
    const { nonce, ciphertext } = encrypt(plaintext, testKey)!;

    // Tamper with the auth tag (last 16 bytes)
    ciphertext[ciphertext.length - 1] ^= 0xff;
    const decrypted = decrypt(ciphertext, nonce, testKey);
    expect(decrypted).toBeNull();
  });

  test("accepts Uint8Array inputs", () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const key = new Uint8Array(testKey);
    const { nonce, ciphertext } = encrypt(plaintext, key)!;

    const decrypted = decrypt(ciphertext, nonce, key);
    expect(decrypted).not.toBeNull();
    expect(Buffer.from(decrypted!).equals(Buffer.from(plaintext))).toBe(true);
  });
});

describe("seal/open", () => {
  test("seals and opens data", () => {
    const plaintext = Buffer.from("Hello, World!");
    const sealed = seal(plaintext, testKey);

    expect(sealed.length).toBe(NONCE_LENGTH + plaintext.length + AUTH_TAG_LENGTH);

    const opened = open(sealed, testKey);
    expect(opened).not.toBeNull();
    expect(opened!.equals(plaintext)).toBe(true);
  });

  test("sealed format is nonce || ciphertext || authTag", () => {
    const plaintext = Buffer.from("Hello, World!");
    const sealed = seal(plaintext, testKey);

    // Extract nonce and use decrypt to verify format
    const nonce = sealed.slice(0, NONCE_LENGTH);
    const ciphertext = sealed.slice(NONCE_LENGTH);

    const decrypted = decrypt(ciphertext, nonce, testKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.equals(plaintext)).toBe(true);
  });

  test("open fails with wrong key", () => {
    const plaintext = Buffer.from("Hello, World!");
    const sealed = seal(plaintext, testKey);

    const wrongKey = randomBytes(32);
    const opened = open(sealed, wrongKey);
    expect(opened).toBeNull();
  });

  test("open fails with too short input", () => {
    const tooShort = Buffer.alloc(NONCE_LENGTH + AUTH_TAG_LENGTH - 1);
    const opened = open(tooShort, testKey);
    expect(opened).toBeNull();
  });

  test("open fails with tampered data", () => {
    const plaintext = Buffer.from("Hello, World!");
    const sealed = seal(plaintext, testKey);

    sealed[NONCE_LENGTH + 5] ^= 0xff; // Tamper with ciphertext
    const opened = open(sealed, testKey);
    expect(opened).toBeNull();
  });
});
