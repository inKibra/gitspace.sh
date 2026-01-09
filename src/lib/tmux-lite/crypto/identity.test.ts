/**
 * Tests for identity cryptography module
 */

import { describe, expect, test } from "bun:test";
import {
  generateSigningKeypair,
  generateKeyExchangeKeypair,
  generateIdentity,
  deriveIdentityId,
  sign,
  verify,
  serializeIdentity,
  deserializeIdentity,
  getPublicIdentity,
} from "./identity";

describe("Identity - Keypair Generation", () => {
  test("generateSigningKeypair creates valid Ed25519 keypair", () => {
    const keypair = generateSigningKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keypair.secretKey.length).toBe(64);
  });

  test("generateKeyExchangeKeypair creates valid X25519 keypair", () => {
    const keypair = generateKeyExchangeKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.privateKey).toBeInstanceOf(Uint8Array);
    expect(keypair.privateKey.length).toBe(32);
  });

  test("generateIdentity creates complete identity", () => {
    const identity = generateIdentity("Test Label");
    expect(identity.id).toBeTruthy();
    expect(identity.id.length).toBe(16);
    expect(identity.label).toBe("Test Label");
    expect(identity.createdAt).toBeGreaterThan(0);
    expect(identity.signing.publicKey.length).toBe(32);
    expect(identity.signing.secretKey.length).toBe(64);
    expect(identity.keyExchange.publicKey.length).toBe(32);
    expect(identity.keyExchange.privateKey.length).toBe(32);
  });

  test("generateIdentity creates identity without label", () => {
    const identity = generateIdentity();
    expect(identity.id).toBeTruthy();
    expect(identity.label).toBeUndefined();
  });
});

describe("Identity - ID Derivation", () => {
  test("deriveIdentityId produces 16 character base64url string", () => {
    const keypair = generateSigningKeypair();
    const id = deriveIdentityId(keypair.publicKey);
    expect(id.length).toBe(16);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/); // base64url chars
  });

  test("deriveIdentityId is deterministic", () => {
    const keypair = generateSigningKeypair();
    const id1 = deriveIdentityId(keypair.publicKey);
    const id2 = deriveIdentityId(keypair.publicKey);
    expect(id1).toBe(id2);
  });

  test("deriveIdentityId throws on invalid key length", () => {
    const invalidKey = new Uint8Array(31); // Wrong length
    expect(() => deriveIdentityId(invalidKey)).toThrow();
  });

  test("identity ID matches derived ID", () => {
    const identity = generateIdentity();
    const derivedId = deriveIdentityId(identity.signing.publicKey);
    expect(identity.id).toBe(derivedId);
  });
});

describe("Identity - Signing and Verification", () => {
  test("sign creates 64-byte signature", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Hello, World!");
    const signature = sign(message, keypair.secretKey);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
  });

  test("verify accepts valid signature", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Test message");
    const signature = sign(message, keypair.secretKey);
    const isValid = verify(message, signature, keypair.publicKey);
    expect(isValid).toBe(true);
  });

  test("verify rejects invalid signature", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Original message");
    const signature = sign(message, keypair.secretKey);
    
    const wrongMessage = new TextEncoder().encode("Wrong message");
    const isValid = verify(wrongMessage, signature, keypair.publicKey);
    expect(isValid).toBe(false);
  });

  test("verify rejects signature from different keypair", () => {
    const keypair1 = generateSigningKeypair();
    const keypair2 = generateSigningKeypair();
    const message = new TextEncoder().encode("Test");
    const signature = sign(message, keypair1.secretKey);
    const isValid = verify(message, signature, keypair2.publicKey);
    expect(isValid).toBe(false);
  });

  test("sign throws on invalid secret key length", () => {
    const message = new TextEncoder().encode("Test");
    const invalidKey = new Uint8Array(63);
    expect(() => sign(message, invalidKey)).toThrow();
  });

  test("verify throws on invalid signature length", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Test");
    const invalidSig = new Uint8Array(63);
    expect(() => verify(message, invalidSig, keypair.publicKey)).toThrow();
  });

  test("verify throws on invalid public key length", () => {
    const message = new TextEncoder().encode("Test");
    const signature = new Uint8Array(64);
    const invalidKey = new Uint8Array(31);
    expect(() => verify(message, signature, invalidKey)).toThrow();
  });
});

describe("Identity - Serialization", () => {
  test("serializeIdentity converts to base64 strings", () => {
    const identity = generateIdentity("Test");
    const stored = serializeIdentity(identity);
    
    expect(stored.id).toBe(identity.id);
    expect(stored.label).toBe(identity.label);
    expect(stored.createdAt).toBe(identity.createdAt);
    expect(typeof stored.signingPublicKey).toBe("string");
    expect(typeof stored.signingSecretKey).toBe("string");
    expect(typeof stored.keyExchangePublicKey).toBe("string");
    expect(typeof stored.keyExchangePrivateKey).toBe("string");
  });

  test("deserializeIdentity restores identity", () => {
    const original = generateIdentity("Original");
    const stored = serializeIdentity(original);
    const restored = deserializeIdentity(stored);
    
    expect(restored.id).toBe(original.id);
    expect(restored.label).toBe(original.label);
    expect(restored.createdAt).toBe(original.createdAt);
    expect(restored.signing.publicKey).toEqual(original.signing.publicKey);
    expect(restored.signing.secretKey).toEqual(original.signing.secretKey);
    expect(restored.keyExchange.publicKey).toEqual(original.keyExchange.publicKey);
    expect(restored.keyExchange.privateKey).toEqual(original.keyExchange.privateKey);
  });

  test("deserializeIdentity validates ID match", () => {
    const identity = generateIdentity();
    const stored = serializeIdentity(identity);
    
    // Tamper with ID
    stored.id = "InvalidID1234567";
    
    expect(() => deserializeIdentity(stored)).toThrow(/Identity ID mismatch/);
  });

  test("serialization round-trip maintains signature validity", () => {
    const original = generateIdentity();
    const message = new TextEncoder().encode("Test");
    const signature = sign(message, original.signing.secretKey);
    
    const stored = serializeIdentity(original);
    const restored = deserializeIdentity(stored);
    
    const isValid = verify(message, signature, restored.signing.publicKey);
    expect(isValid).toBe(true);
  });
});

describe("Identity - Public Identity Extraction", () => {
  test("getPublicIdentity returns only public information", () => {
    const identity = generateIdentity("Public Test");
    const publicIdentity = getPublicIdentity(identity);
    
    expect(publicIdentity.id).toBe(identity.id);
    expect(publicIdentity.label).toBe(identity.label);
    expect(typeof publicIdentity.signingPublicKey).toBe("string");
    expect(typeof publicIdentity.keyExchangePublicKey).toBe("string");
    
    // Ensure no secret keys are present
    expect(publicIdentity).not.toHaveProperty("signing");
    expect(publicIdentity).not.toHaveProperty("keyExchange");
    expect(publicIdentity).not.toHaveProperty("createdAt");
  });

  test("public identity can be used for verification", () => {
    const identity = generateIdentity();
    const publicIdentity = getPublicIdentity(identity);
    
    const message = new TextEncoder().encode("Verify me");
    const signature = sign(message, identity.signing.secretKey);
    
    // Decode public key from base64
    const publicKey = new Uint8Array(
      Buffer.from(publicIdentity.signingPublicKey, "base64")
    );
    
    const isValid = verify(message, signature, publicKey);
    expect(isValid).toBe(true);
  });
});
