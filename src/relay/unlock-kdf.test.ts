import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { deriveUnlockKey } from './unlock-kdf.js';

describe('unlock key derivation', () => {
  test('derives stable 32-byte key for identical input', () => {
    const sharedSecret = randomBytes(32);
    const salt = randomBytes(32);

    const first = deriveUnlockKey(sharedSecret, salt);
    const second = deriveUnlockKey(sharedSecret, salt);

    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
  });

  test('changes derived key when salt changes', () => {
    const sharedSecret = randomBytes(32);
    const first = deriveUnlockKey(sharedSecret, randomBytes(32));
    const second = deriveUnlockKey(sharedSecret, randomBytes(32));

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });
});
