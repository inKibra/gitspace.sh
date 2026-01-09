import { describe, expect, test } from "bun:test";
import {
  generateSalt,
  deriveKey,
  SALT_LENGTH,
  KEY_LENGTH,
} from "./keys";

describe("generateSalt", () => {
  test("generates salt of correct length", () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Buffer);
    expect(salt.length).toBe(SALT_LENGTH);
  });

  test("generates unique salts", () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    expect(salt1.equals(salt2)).toBe(false);
  });
});

describe("deriveKey", () => {
  test("derives key of correct length", async () => {
    const salt = generateSalt();
    const key = await deriveKey("test-secret", salt);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(KEY_LENGTH);
  });

  test("same secret + salt produces same key", async () => {
    const salt = generateSalt();
    const key1 = await deriveKey("test-secret", salt);
    const key2 = await deriveKey("test-secret", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  test("different secrets produce different keys", async () => {
    const salt = generateSalt();
    const key1 = await deriveKey("secret-1", salt);
    const key2 = await deriveKey("secret-2", salt);
    expect(key1.equals(key2)).toBe(false);
  });

  test("different salts produce different keys", async () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const key1 = await deriveKey("test-secret", salt1);
    const key2 = await deriveKey("test-secret", salt2);
    expect(key1.equals(key2)).toBe(false);
  });

  test("accepts Uint8Array salt", async () => {
    const salt = new Uint8Array(generateSalt());
    const key = await deriveKey("test-secret", salt);
    expect(key.length).toBe(KEY_LENGTH);
  });
});
