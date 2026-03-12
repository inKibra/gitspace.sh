import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { generateMnemonic } from '../../lib/tmux-lite/crypto/user-identity.js';
import {
  decryptMnemonicEnvelope,
  encryptMnemonicEnvelope,
} from '../identity-backup.js';

const LEGACY_PBKDF2_ITERATIONS = 100_000;

function encodeBase64(input: Uint8Array): string {
  return Buffer.from(input).toString('base64');
}

async function encryptLegacyEnvelope(mnemonic: string, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, LEGACY_PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(mnemonic, 'utf-8')), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1 as const,
    algorithm: 'PBKDF2-AES-GCM' as const,
    iterations: LEGACY_PBKDF2_ITERATIONS,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(Buffer.concat([ciphertext, authTag])),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('identity-backup crypto', () => {
  test('encrypt/decrypt roundtrip works', async () => {
    const mnemonic = generateMnemonic();
    const envelope = await encryptMnemonicEnvelope(mnemonic, 'backup-pass-1');
    const decrypted = await decryptMnemonicEnvelope(envelope, 'backup-pass-1');
    expect(decrypted).toBe(mnemonic);
  });

  test('decrypt fails with wrong password', async () => {
    const mnemonic = generateMnemonic();
    const envelope = await encryptMnemonicEnvelope(mnemonic, 'backup-pass-1');
    await expect(decryptMnemonicEnvelope(envelope, 'wrong-pass')).rejects.toThrow('Invalid backup password');
  });

  test('decrypt accepts legacy PBKDF2 iteration counts above the floor', async () => {
    const mnemonic = generateMnemonic();
    const envelope = await encryptLegacyEnvelope(mnemonic, 'backup-pass-1');

    await expect(decryptMnemonicEnvelope(envelope, 'backup-pass-1')).resolves.toBe(mnemonic);
  });

  test('decrypt fails when ciphertext is corrupted', async () => {
    const mnemonic = generateMnemonic();
    const envelope = await encryptMnemonicEnvelope(mnemonic, 'backup-pass-1');
    const tampered = {
      ...envelope,
      ciphertext: envelope.ciphertext.slice(0, -4) + 'AAAA',
    };
    await expect(decryptMnemonicEnvelope(tampered, 'backup-pass-1')).rejects.toThrow();
  });

  test('decrypt rejects weakened PBKDF2 iteration counts', async () => {
    const mnemonic = generateMnemonic();
    const envelope = await encryptMnemonicEnvelope(mnemonic, 'backup-pass-1');
    const weakened = {
      ...envelope,
      iterations: 1,
    };

    await expect(decryptMnemonicEnvelope(weakened, 'backup-pass-1')).rejects.toThrow(/unsupported key derivation parameters/i);
  });

  test('decrypt rejects excessive PBKDF2 iteration counts', async () => {
    const mnemonic = generateMnemonic();
    const envelope = await encryptMnemonicEnvelope(mnemonic, 'backup-pass-1');
    const excessive = {
      ...envelope,
      iterations: 5_000_000,
    };

    await expect(decryptMnemonicEnvelope(excessive, 'backup-pass-1')).rejects.toThrow(/unsupported key derivation parameters/i);
  });
});
