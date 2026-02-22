/**
 * Tests for device certificate creation and verification
 */

import { describe, expect, test } from "bun:test";
import {
  createDeviceCertificate,
  verifyDeviceCertificate,
  isDeviceCertExpired,
  getUserRootIdFromCert,
  getMachineIdFromCert,
} from "./device-cert";
import {
  generateMnemonic,
  mnemonicToUserIdentity,
} from "./user-identity";
import { generateIdentity, deriveIdentityId } from "./identity";

// ============================================================================
// Helpers
// ============================================================================

function createTestUserRoot() {
  const mnemonic = generateMnemonic();
  return mnemonicToUserIdentity(mnemonic);
}

function createTestMachine() {
  return generateIdentity("test-machine");
}

// ============================================================================
// Certificate Creation
// ============================================================================

describe("Device Certificate - Creation", () => {
  test("createDeviceCertificate returns valid structure", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    expect(typeof cert.deviceSigningPublicKey).toBe("string");
    expect(typeof cert.deviceKeyExchangePublicKey).toBe("string");
    expect(typeof cert.userRootSigningPublicKey).toBe("string");
    expect(typeof cert.signature).toBe("string");
    expect(typeof cert.issuedAt).toBe("number");
    expect(cert.issuedAt).toBeGreaterThan(0);
  });

  test("certificate contains correct device public keys", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const deviceSigningPub = new Uint8Array(
      Buffer.from(cert.deviceSigningPublicKey, "base64")
    );
    const deviceKexPub = new Uint8Array(
      Buffer.from(cert.deviceKeyExchangePublicKey, "base64")
    );

    expect(Buffer.from(deviceSigningPub).toString("hex")).toBe(
      Buffer.from(machine.signing.publicKey).toString("hex")
    );
    expect(Buffer.from(deviceKexPub).toString("hex")).toBe(
      Buffer.from(machine.keyExchange.publicKey).toString("hex")
    );
  });

  test("certificate contains correct user root public key", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const userRootPub = new Uint8Array(
      Buffer.from(cert.userRootSigningPublicKey, "base64")
    );
    expect(Buffer.from(userRootPub).toString("hex")).toBe(
      Buffer.from(userRoot.signing.publicKey).toString("hex")
    );
  });

  test("throws on invalid device signing key length", () => {
    const userRoot = createTestUserRoot();
    const shortKey = new Uint8Array(16);
    const validKey = new Uint8Array(32);

    expect(() =>
      createDeviceCertificate(userRoot, shortKey, validKey)
    ).toThrow("Invalid device signing public key length: 16, expected 32");
  });

  test("throws on invalid device key exchange key length", () => {
    const userRoot = createTestUserRoot();
    const validKey = new Uint8Array(32);
    const shortKey = new Uint8Array(16);

    expect(() =>
      createDeviceCertificate(userRoot, validKey, shortKey)
    ).toThrow(
      "Invalid device key exchange public key length: 16, expected 32"
    );
  });
});

// ============================================================================
// Certificate Verification
// ============================================================================

describe("Device Certificate - Verification", () => {
  test("verifyDeviceCertificate returns true for valid certificate", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    expect(verifyDeviceCertificate(cert)).toBe(true);
  });

  test("verification fails with tampered device signing key", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    // Tamper with device signing public key
    const fakeKey = new Uint8Array(32);
    fakeKey.fill(0x42);
    const tampered = {
      ...cert,
      deviceSigningPublicKey: Buffer.from(fakeKey).toString("base64"),
    };

    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });

  test("verification fails with tampered device kex key", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const fakeKey = new Uint8Array(32);
    fakeKey.fill(0x42);
    const tampered = {
      ...cert,
      deviceKeyExchangePublicKey: Buffer.from(fakeKey).toString("base64"),
    };

    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });

  test("verification fails with tampered user root key", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    // Use a different user's key
    const otherUser = createTestUserRoot();
    const tampered = {
      ...cert,
      userRootSigningPublicKey: Buffer.from(
        otherUser.signing.publicKey
      ).toString("base64"),
    };

    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });

  test("verification fails with tampered signature", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const fakeSig = new Uint8Array(64);
    fakeSig.fill(0x00);
    const tampered = {
      ...cert,
      signature: Buffer.from(fakeSig).toString("base64"),
    };

    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });

  test("verification fails with tampered issuedAt timestamp", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const tampered = { ...cert, issuedAt: cert.issuedAt + 1 };
    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });

  test("verification fails with tampered expiresAt timestamp", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const tampered = { ...cert, expiresAt: cert.expiresAt + 1 };
    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });

  test("verification fails with wrong-length keys", () => {
    const cert = {
      deviceSigningPublicKey: Buffer.from(new Uint8Array(16)).toString(
        "base64"
      ),
      deviceKeyExchangePublicKey: Buffer.from(new Uint8Array(32)).toString(
        "base64"
      ),
      userRootSigningPublicKey: Buffer.from(new Uint8Array(32)).toString(
        "base64"
      ),
      signature: Buffer.from(new Uint8Array(64)).toString("base64"),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000,
    };

    expect(verifyDeviceCertificate(cert)).toBe(false);
  });

  test("verification handles invalid base64 gracefully", () => {
    const cert = {
      deviceSigningPublicKey: "not-valid-base64!!!",
      deviceKeyExchangePublicKey: "also-invalid",
      userRootSigningPublicKey: "still-invalid",
      signature: "nope",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000,
    };

    expect(verifyDeviceCertificate(cert)).toBe(false);
  });

  test("certificate signed by different user fails verification", () => {
    const user1 = createTestUserRoot();
    const user2 = createTestUserRoot();
    const machine = createTestMachine();

    // Cert signed by user1 but claims user2's key
    const cert = createDeviceCertificate(
      user1,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    // Replace user root key with user2's (signature doesn't match)
    const tampered = {
      ...cert,
      userRootSigningPublicKey: Buffer.from(
        user2.signing.publicKey
      ).toString("base64"),
    };

    expect(verifyDeviceCertificate(tampered)).toBe(false);
  });
});

// ============================================================================
// Certificate Expiry
// ============================================================================

describe("Device Certificate - Expiry", () => {
  test("new certificate includes expiresAt and is not expired", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    expect(cert.expiresAt).toBeDefined();
    expect(isDeviceCertExpired(cert)).toBe(false);
  });

  test("certificate missing expiresAt is treated as expired", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const legacyCert = { ...cert } as Record<string, unknown>;
    delete legacyCert.expiresAt;
    expect(isDeviceCertExpired(legacyCert as any)).toBe(true);
    expect(verifyDeviceCertificate(legacyCert as any)).toBe(false);
  });

  test("certificate with future expiresAt is not expired", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const certWithExpiry = { ...cert, expiresAt: Date.now() + 3600000 };
    expect(isDeviceCertExpired(certWithExpiry)).toBe(false);
  });

  test("certificate with past expiresAt is expired", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const certWithExpiry = { ...cert, expiresAt: Date.now() - 1000 };
    expect(isDeviceCertExpired(certWithExpiry)).toBe(true);
  });

  test("certificate with expiresAt exactly now is expired", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const now = Date.now();
    const certWithExpiry = { ...cert, expiresAt: now };
    // Date.now() >= expiresAt → expired
    expect(isDeviceCertExpired(certWithExpiry)).toBe(true);
  });
});

// ============================================================================
// ID Extraction
// ============================================================================

describe("Device Certificate - ID Extraction", () => {
  test("getUserRootIdFromCert returns correct user root ID", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    expect(getUserRootIdFromCert(cert)).toBe(userRoot.id);
  });

  test("getMachineIdFromCert returns correct machine ID", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const expectedMachineId = deriveIdentityId(machine.signing.publicKey);
    expect(getMachineIdFromCert(cert)).toBe(expectedMachineId);
    expect(getMachineIdFromCert(cert)).toBe(machine.id);
  });

  test("extracted IDs are 16-char base64url strings", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    const userId = getUserRootIdFromCert(cert);
    const machineId = getMachineIdFromCert(cert);

    expect(userId.length).toBe(16);
    expect(machineId.length).toBe(16);
    expect(userId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(machineId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("user root ID and machine ID are different", () => {
    const userRoot = createTestUserRoot();
    const machine = createTestMachine();

    const cert = createDeviceCertificate(
      userRoot,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    expect(getUserRootIdFromCert(cert)).not.toBe(getMachineIdFromCert(cert));
  });
});

// ============================================================================
// Multiple Devices Same User
// ============================================================================

describe("Device Certificate - Multi-Device", () => {
  test("same user can certify multiple machines", () => {
    const userRoot = createTestUserRoot();
    const machine1 = createTestMachine();
    const machine2 = createTestMachine();

    const cert1 = createDeviceCertificate(
      userRoot,
      machine1.signing.publicKey,
      machine1.keyExchange.publicKey
    );
    const cert2 = createDeviceCertificate(
      userRoot,
      machine2.signing.publicKey,
      machine2.keyExchange.publicKey
    );

    // Both valid
    expect(verifyDeviceCertificate(cert1)).toBe(true);
    expect(verifyDeviceCertificate(cert2)).toBe(true);

    // Same user root
    expect(getUserRootIdFromCert(cert1)).toBe(getUserRootIdFromCert(cert2));

    // Different machine IDs
    expect(getMachineIdFromCert(cert1)).not.toBe(getMachineIdFromCert(cert2));
  });

  test("different users certifying same machine produce different certs", () => {
    const user1 = createTestUserRoot();
    const user2 = createTestUserRoot();
    const machine = createTestMachine();

    const cert1 = createDeviceCertificate(
      user1,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );
    const cert2 = createDeviceCertificate(
      user2,
      machine.signing.publicKey,
      machine.keyExchange.publicKey
    );

    // Both valid
    expect(verifyDeviceCertificate(cert1)).toBe(true);
    expect(verifyDeviceCertificate(cert2)).toBe(true);

    // Different user roots
    expect(getUserRootIdFromCert(cert1)).not.toBe(
      getUserRootIdFromCert(cert2)
    );

    // Same machine
    expect(getMachineIdFromCert(cert1)).toBe(getMachineIdFromCert(cert2));

    // Different signatures
    expect(cert1.signature).not.toBe(cert2.signature);
  });
});
