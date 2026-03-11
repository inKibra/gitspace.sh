import { describe, expect, test } from 'bun:test';
import { generateMnemonic } from '../../lib/tmux-lite/crypto/user-identity.js';
import {
  decryptMnemonicEnvelope,
  encryptMnemonicEnvelope,
} from '../identity-backup.js';

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
