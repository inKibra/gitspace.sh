/**
 * Tests for browser-specific identity helpers in identity.web.ts
 *
 * Focuses on `createRootSignedDeviceCertificate` — the function that replaced
 * the old self-signed cert pattern in the browser auth flow.
 *
 * Cross-compatibility with the Node/server-side cert verifier is also checked
 * to ensure browser-generated certs are accepted by the relay/machine.
 */

import { describe, it, expect } from 'bun:test';
import {
  generateIdentity,
  createRootSignedDeviceCertificate,
} from '../identity.web.js';
import {
  verifyDeviceCertificate,
  isDeviceCertExpired,
  getUserRootIdFromCert,
} from '../../../lib/tmux-lite/crypto/device-cert.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../../../lib/tmux-lite/crypto/user-identity.js';
import { deriveIdentityId } from '../../../lib/tmux-lite/crypto/identity.js';
import type { DeviceCertificate } from '../../../types/identity.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseDeviceCert(certJson: string): DeviceCertificate {
  return JSON.parse(certJson) as DeviceCertificate;
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── createRootSignedDeviceCertificate ───────────────────────────────────────

describe('createRootSignedDeviceCertificate', () => {
  it('cert deviceSigningPublicKey matches device identity, not root', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    const certDeviceKey = base64ToBytes(cert.deviceSigningPublicKey);
    expect(bytesEqual(certDeviceKey, device.signing.publicKey)).toBe(true);
    // Must NOT be the root key
    expect(bytesEqual(certDeviceKey, root.signing.publicKey)).toBe(false);
  });

  it('cert userRootSigningPublicKey matches root identity, not device', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    const certRootKey = base64ToBytes(cert.userRootSigningPublicKey);
    expect(bytesEqual(certRootKey, root.signing.publicKey)).toBe(true);
    // Must NOT be the device key
    expect(bytesEqual(certRootKey, device.signing.publicKey)).toBe(false);
  });

  it('device key and root key in cert are different (not self-signed)', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    // The critical invariant the handshake now enforces
    expect(cert.deviceSigningPublicKey).not.toBe(cert.userRootSigningPublicKey);
  });

  it('cert key exchange key matches device key exchange key', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    const certKexKey = base64ToBytes(cert.deviceKeyExchangePublicKey);
    expect(bytesEqual(certKexKey, device.keyExchange.publicKey)).toBe(true);
  });

  it('cert has a valid issuedAt timestamp', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const before = Date.now();
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const after = Date.now();
    const cert = parseDeviceCert(certJson);

    expect(cert.issuedAt).toBeGreaterThanOrEqual(before);
    expect(cert.issuedAt).toBeLessThanOrEqual(after);
  });

  it('cert has a future expiresAt', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    expect(cert.expiresAt).toBeGreaterThan(Date.now());
  });

  // ─── Cross-compatibility with Node verifier ───────────────────────────────

  it('browser-generated cert passes the Node-side verifyDeviceCertificate', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    // verifyDeviceCertificate checks the cert's own internal signature
    const isValid = verifyDeviceCertificate(cert);
    expect(isValid).toBe(true);
  });

  it('browser-generated cert is not expired immediately after creation', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    expect(isDeviceCertExpired(cert)).toBe(false);
  });

  it('getUserRootIdFromCert returns the root identity ID', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    const extractedRootId = getUserRootIdFromCert(cert);
    const expectedRootId = deriveIdentityId(root.signing.publicKey);
    expect(extractedRootId).toBe(expectedRootId);
  });

  it('cert signed by one root fails getUserRootIdFromCert check against a different root', () => {
    const root = mnemonicToUserIdentity(generateMnemonic());
    const wrongRoot = mnemonicToUserIdentity(generateMnemonic());
    const device = generateIdentity('Browser Device');
    const certJson = createRootSignedDeviceCertificate(root as unknown as typeof device, device);
    const cert = parseDeviceCert(certJson);

    // The cert embeds the actual root's public key — it won't match wrongRoot
    const embeddedRootId = getUserRootIdFromCert(cert);
    const wrongRootId = deriveIdentityId(wrongRoot.signing.publicKey);
    expect(embeddedRootId).not.toBe(wrongRootId);
  });

  it('different root+device combos produce different certs', () => {
    const root1 = mnemonicToUserIdentity(generateMnemonic());
    const root2 = mnemonicToUserIdentity(generateMnemonic());
    const device1 = generateIdentity('Device 1');
    const device2 = generateIdentity('Device 2');

    const cert1 = createRootSignedDeviceCertificate(root1 as unknown as typeof device1, device1);
    const cert2 = createRootSignedDeviceCertificate(root2 as unknown as typeof device2, device2);

    expect(cert1).not.toBe(cert2);
  });
});
