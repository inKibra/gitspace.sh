/**
 * Device certificate creation and verification
 *
 * A device certificate proves that a machine's identity keypair was endorsed
 * by a user's root identity. The user root key signs the machine's public keys,
 * creating a verifiable chain of trust:
 *
 *   User Root (Ed25519) → signs → Device Certificate → contains → Machine Public Keys
 *
 * This allows third parties (relays, other clients) to verify that a machine
 * belongs to a specific user without the user being present.
 *
 * @module device-cert
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import type { DeviceCertificate, UserRootIdentity } from '../../../types/identity.js';
import { deriveIdentityId } from './identity.js';

// ============================================================================
// Constants
// ============================================================================

/** Domain separator for device certificate signatures */
const CERT_DOMAIN = new TextEncoder().encode('gitspace-device-cert-v1');
/** Default certificate lifetime (90 days) */
const DEVICE_CERT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ============================================================================
// Certificate Creation
// ============================================================================

/**
 * Create a device certificate
 *
 * Signs the machine's public keys with the user's root Ed25519 key.
 * The signature covers:
 * domain || deviceSigningPubKey || deviceKexPubKey || issuedAt || expiresAt
 *
 * @param userRoot - User's root identity (must have signing secret key)
 * @param deviceSigningPublicKey - Machine's Ed25519 public key (32 bytes)
 * @param deviceKeyExchangePublicKey - Machine's X25519 public key (32 bytes)
 * @returns Signed device certificate
 */
export function createDeviceCertificate(
  userRoot: UserRootIdentity,
  deviceSigningPublicKey: Uint8Array,
  deviceKeyExchangePublicKey: Uint8Array,
  options: {
    expiresAt?: number;
    label?: string;
  } = {},
): DeviceCertificate {
  if (deviceSigningPublicKey.length !== 32) {
    throw new Error(`Invalid device signing public key length: ${deviceSigningPublicKey.length}, expected 32`);
  }
  if (deviceKeyExchangePublicKey.length !== 32) {
    throw new Error(`Invalid device key exchange public key length: ${deviceKeyExchangePublicKey.length}, expected 32`);
  }

  const issuedAt = Date.now();
  const expiresAt = options.expiresAt ?? issuedAt + DEVICE_CERT_TTL_MS;
  if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('Invalid certificate expiry timestamp');
  }

  const payload = buildCertPayload(
    deviceSigningPublicKey,
    deviceKeyExchangePublicKey,
    issuedAt,
    expiresAt,
  );

  // Sign with user root Ed25519 key (extract 32-byte private key from 64-byte secret key)
  const privateKey = userRoot.signing.secretKey.slice(0, 32);
  const signature = ed25519.sign(payload, privateKey);

  return {
    deviceSigningPublicKey: Buffer.from(deviceSigningPublicKey).toString('base64'),
    deviceKeyExchangePublicKey: Buffer.from(deviceKeyExchangePublicKey).toString('base64'),
    userRootSigningPublicKey: Buffer.from(userRoot.signing.publicKey).toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
    issuedAt,
    expiresAt,
    label: options.label,
  };
}

// ============================================================================
// Certificate Verification
// ============================================================================

/**
 * Verify a device certificate
 *
 * Checks that the signature is valid: the user root key actually signed
 * the device's public keys. This proves the user endorsed this machine.
 *
 * @param cert - Device certificate to verify
 * @returns true if the certificate signature is valid
 */
export function verifyDeviceCertificate(cert: DeviceCertificate): boolean {
  try {
    if (!Number.isFinite(cert.issuedAt)) {
      return false;
    }
    if (!Number.isFinite(cert.expiresAt)) {
      return false;
    }
    if (cert.expiresAt <= cert.issuedAt) {
      return false;
    }

    const deviceSigningPub = new Uint8Array(Buffer.from(cert.deviceSigningPublicKey, 'base64'));
    const deviceKexPub = new Uint8Array(Buffer.from(cert.deviceKeyExchangePublicKey, 'base64'));
    const userRootPub = new Uint8Array(Buffer.from(cert.userRootSigningPublicKey, 'base64'));
    const signature = new Uint8Array(Buffer.from(cert.signature, 'base64'));

    if (deviceSigningPub.length !== 32 || deviceKexPub.length !== 32 || userRootPub.length !== 32 || signature.length !== 64) {
      return false;
    }

    const payload = buildCertPayload(deviceSigningPub, deviceKexPub, cert.issuedAt, cert.expiresAt);
    return ed25519.verify(signature, payload, userRootPub);
  } catch {
    return false;
  }
}

/**
 * Check if a device certificate has expired
 *
 * @param cert - Device certificate
 * @returns true if expired (expiresAt is set and in the past)
 */
export function isDeviceCertExpired(cert: DeviceCertificate): boolean {
  if (!Number.isFinite(cert.expiresAt)) {
    return true;
  }
  return Date.now() >= cert.expiresAt;
}

/**
 * Extract the user root identity ID from a device certificate
 *
 * @param cert - Device certificate
 * @returns User root identity ID (16-char base64url string)
 */
export function getUserRootIdFromCert(cert: DeviceCertificate): string {
  const userRootPub = new Uint8Array(Buffer.from(cert.userRootSigningPublicKey, 'base64'));
  return deriveIdentityId(userRootPub);
}

/**
 * Extract the machine identity ID from a device certificate
 *
 * @param cert - Device certificate
 * @returns Machine identity ID (16-char base64url string)
 */
export function getMachineIdFromCert(cert: DeviceCertificate): string {
  const devicePub = new Uint8Array(Buffer.from(cert.deviceSigningPublicKey, 'base64'));
  return deriveIdentityId(devicePub);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Build the payload bytes that get signed in a device certificate
 *
 * Format:
 * CERT_DOMAIN || deviceSigningPubKey || deviceKexPubKey || issuedAt (8 bytes BE) || expiresAt (8 bytes BE)
 */
function buildCertPayload(
  deviceSigningPublicKey: Uint8Array,
  deviceKeyExchangePublicKey: Uint8Array,
  issuedAt: number,
  expiresAt: number,
): Uint8Array {
  // issuedAt and expiresAt as 8-byte big-endian each
  const timestampBytes = new Uint8Array(16);
  const view = new DataView(timestampBytes.buffer);
  view.setBigUint64(0, BigInt(issuedAt), false);
  view.setBigUint64(8, BigInt(expiresAt), false);

  // Concatenate: domain || deviceSigningPub || deviceKexPub || issuedAt || expiresAt
  const payload = new Uint8Array(
    CERT_DOMAIN.length + 32 + 32 + 16
  );
  let offset = 0;
  payload.set(CERT_DOMAIN, offset); offset += CERT_DOMAIN.length;
  payload.set(deviceSigningPublicKey, offset); offset += 32;
  payload.set(deviceKeyExchangePublicKey, offset); offset += 32;
  payload.set(timestampBytes, offset);

  return payload;
}
