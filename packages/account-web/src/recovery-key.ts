import { deviceProtocolBase64 } from '@gitspace/protocol/device-grant';
import { ed25519 } from '@noble/curves/ed25519.js';
import { DeviceEnrollmentError } from './device.js';

/**
 * The account root key a `gsr_…` recovery key encodes, its public key (base64) and the account id derived from it.
 * Callers zero `privateKey` as soon as they have signed with it.
 */
export async function parseRecoveryKey(input: string): Promise<{ privateKey: Uint8Array; publicKey: string; userId: string }> {
  const key = input.trim();
  if (!/^gsr_[A-Za-z0-9_-]{43}$/u.test(key)) throw new DeviceEnrollmentError('INVALID_RECOVERY', 'Enter the complete recovery key beginning with gsr_.');
  const privateKey = deviceProtocolBase64.decode(`${key.slice(4).replaceAll('-', '+').replaceAll('_', '/')}=`);
  if (`gsr_${deviceProtocolBase64.encode(privateKey).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}` !== key) {
    privateKey.fill(0);
    throw new DeviceEnrollmentError('INVALID_RECOVERY', 'The recovery key is invalid.');
  }
  const publicBytes = ed25519.getPublicKey(privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(publicBytes)));
  return { privateKey, publicKey: deviceProtocolBase64.encode(publicBytes), userId: `u-${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}` };
}
