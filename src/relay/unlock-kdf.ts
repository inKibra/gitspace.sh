import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const UNLOCK_KDF_INFO = new TextEncoder().encode('gitspace-unlock-v1');
const UNLOCK_KDF_KEY_LENGTH = 32;

export function deriveUnlockKey(sharedSecret: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, salt, UNLOCK_KDF_INFO, UNLOCK_KDF_KEY_LENGTH);
}
