/**
 * Tests for invite token creation and verification
 */

import { describe, it, expect } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type { Identity } from "../../../types/identity.js";
import {
  createInviteToken,
  parseInviteToken,
  getPublicIdentityFromInvite,
  isInviteExpired,
} from "./invites.js";

/**
 * Create a mock machine identity for testing
 */
function createMockIdentity(label = "test-machine"): Identity {
  // Generate Ed25519 keypair for signing
  const signingKeypair = ed25519.keygen();

  // Generate X25519 keypair for key exchange
  const keyExchangeKeypair = x25519.keygen();

  // Create Ed25519 secret key (64 bytes: 32 private + 32 public)
  const secretKey = new Uint8Array(64);
  secretKey.set(signingKeypair.secretKey, 0);
  secretKey.set(signingKeypair.publicKey, 32);

  const id = Buffer.from(signingKeypair.publicKey)
    .toString("base64url")
    .slice(0, 16);

  return {
    id,
    signing: {
      publicKey: signingKeypair.publicKey,
      secretKey,
    },
    keyExchange: {
      publicKey: keyExchangeKeypair.publicKey,
      privateKey: keyExchangeKeypair.secretKey,
    },
    label,
    createdAt: Date.now(),
  };
}

describe("invites", () => {
  describe("createInviteToken", () => {
    it("creates a valid base64url-encoded token", () => {
      const identity = createMockIdentity();
      const token = createInviteToken(identity, "wss://relay.example.com");

      expect(token).toBeString();
      expect(token.length).toBeGreaterThan(0);

      // Should be valid base64url (no +, /, or =)
      expect(token).not.toContain("+");
      expect(token).not.toContain("/");
      expect(token).not.toContain("=");
    });

    it("includes machine identity in token", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.machineId).toBe(identity.id);
      expect(token!.machineSigningKey).toBe(
        Buffer.from(identity.signing.publicKey).toString("base64")
      );
      expect(token!.machineKeyExchangeKey).toBe(
        Buffer.from(identity.keyExchange.publicKey).toString("base64")
      );
    });

    it("includes relay URL in token", () => {
      const identity = createMockIdentity();
      const relayUrl = "wss://relay.example.com";
      const encoded = createInviteToken(identity, relayUrl);
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.relayUrl).toBe(relayUrl);
    });

    it("uses default access type (session-invite)", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.accessType).toBe('session-invite');
    });

    it("accepts custom access type", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        accessType: 'full',
      });
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.accessType).toBe('full');
    });

    it("accepts session ID for session-invite", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        accessType: 'session-invite',
        sessionId: 'session-123',
      });
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.accessType).toBe('session-invite');
      expect(token!.sessionId).toBe('session-123');
    });

    it("sets expiry to 24 hours by default", () => {
      const identity = createMockIdentity();
      const before = Date.now() + 24 * 60 * 60 * 1000;
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const after = Date.now() + 24 * 60 * 60 * 1000;
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.expiresAt).toBeGreaterThanOrEqual(before);
      expect(token!.expiresAt).toBeLessThanOrEqual(after);
    });

    it("accepts custom validity duration", () => {
      const identity = createMockIdentity();
      const oneHour = 60 * 60 * 1000;
      const before = Date.now() + oneHour;
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        validityMs: oneHour,
      });
      const after = Date.now() + oneHour;
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.expiresAt).toBeGreaterThanOrEqual(before);
      expect(token!.expiresAt).toBeLessThanOrEqual(after);
    });

    it("sets singleUse to false by default", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.singleUse).toBe(false);
    });

    it("accepts singleUse option", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        singleUse: true,
      });
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.singleUse).toBe(true);
    });

    it("creates valid signature", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.signature).toBeString();
      expect(token!.signature.length).toBeGreaterThan(0);
    });
  });

  describe("parseInviteToken", () => {
    it("parses valid token", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.version).toBe(1);
      expect(token!.machineId).toBe(identity.id);
    });

    it("returns null for invalid base64", () => {
      const token = parseInviteToken("not-valid-base64!!!");
      expect(token).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const invalidJson = Buffer.from("not json").toString("base64url");
      const token = parseInviteToken(invalidJson);
      expect(token).toBeNull();
    });

    it("returns null for missing fields", () => {
      const incomplete = {
        version: 1,
        machineId: "test",
        // Missing other required fields
      };
      const encoded = Buffer.from(JSON.stringify(incomplete)).toString(
        "base64url"
      );
      const token = parseInviteToken(encoded);
      expect(token).toBeNull();
    });

    it("returns null for invalid signature", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");

      // Decode and tamper with signature
      const tokenJson = Buffer.from(encoded, "base64url").toString("utf-8");
      const token = JSON.parse(tokenJson);
      token.signature = "invalid-signature";
      const tamperedEncoded = Buffer.from(JSON.stringify(token)).toString(
        "base64url"
      );

      const parsed = parseInviteToken(tamperedEncoded);
      expect(parsed).toBeNull();
    });

    it("returns null if payload was modified", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");

      // Decode and tamper with payload (keep signature)
      const tokenJson = Buffer.from(encoded, "base64url").toString("utf-8");
      const token = JSON.parse(tokenJson);
      token.relayUrl = "wss://evil.example.com"; // Change payload
      const tamperedEncoded = Buffer.from(JSON.stringify(token)).toString(
        "base64url"
      );

      const parsed = parseInviteToken(tamperedEncoded);
      expect(parsed).toBeNull();
    });

    it("verifies signature with correct public key", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com");

      // Should succeed - signature is valid
      const token = parseInviteToken(encoded);
      expect(token).not.toBeNull();
    });

    it("rejects token signed with different key", () => {
      const identity1 = createMockIdentity("machine1");
      const identity2 = createMockIdentity("machine2");

      // Create token with identity1
      const encoded = createInviteToken(identity1, "wss://relay.example.com");

      // Decode and replace public key with identity2's key
      const tokenJson = Buffer.from(encoded, "base64url").toString("utf-8");
      const token = JSON.parse(tokenJson);
      token.machineSigningKey = Buffer.from(
        identity2.signing.publicKey
      ).toString("base64");
      const tamperedEncoded = Buffer.from(JSON.stringify(token)).toString(
        "base64url"
      );

      // Should fail - signature doesn't match new public key
      const parsed = parseInviteToken(tamperedEncoded);
      expect(parsed).toBeNull();
    });
  });

  describe("getPublicIdentityFromInvite", () => {
    it("extracts public identity from token", () => {
      const identity = createMockIdentity("my-machine");
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();

      const publicIdentity = getPublicIdentityFromInvite(token!);

      expect(publicIdentity.id).toBe(identity.id);
      expect(publicIdentity.signingPublicKey).toBe(
        Buffer.from(identity.signing.publicKey).toString("base64")
      );
      expect(publicIdentity.keyExchangePublicKey).toBe(
        Buffer.from(identity.keyExchange.publicKey).toString("base64")
      );
      expect(publicIdentity.label).toBeUndefined();
    });

    it("omits label (not included in invite tokens)", () => {
      const identity = createMockIdentity("my-machine");
      const encoded = createInviteToken(identity, "wss://relay.example.com");
      const token = parseInviteToken(encoded);

      const publicIdentity = getPublicIdentityFromInvite(token!);

      expect(publicIdentity.label).toBeUndefined();
    });
  });

  describe("isInviteExpired", () => {
    it("returns false for valid token", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        validityMs: 60 * 60 * 1000, // 1 hour
      });
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(isInviteExpired(token!)).toBe(false);
    });

    it("returns true for expired token", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        validityMs: -1000, // Expired 1 second ago
      });
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(isInviteExpired(token!)).toBe(true);
    });

    it("returns true for token expiring at current time", () => {
      const identity = createMockIdentity();
      const encoded = createInviteToken(identity, "wss://relay.example.com", {
        validityMs: 0, // Expires now
      });
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      // Might be flaky, but should generally be true
      expect(isInviteExpired(token!)).toBe(true);
    });
  });

  describe("integration", () => {
    it("roundtrips token creation and parsing", () => {
      const identity = createMockIdentity("test-machine");
      const relayUrl = "wss://relay.example.com";
      const options = {
        accessType: 'full' as const,
        validityMs: 3600000, // 1 hour
        singleUse: true,
      };

      const encoded = createInviteToken(identity, relayUrl, options);
      const token = parseInviteToken(encoded);

      expect(token).not.toBeNull();
      expect(token!.version).toBe(1);
      expect(token!.machineId).toBe(identity.id);
      expect(token!.relayUrl).toBe(relayUrl);
      expect(token!.accessType).toBe('full');
      expect(token!.singleUse).toBe(true);
      expect(isInviteExpired(token!)).toBe(false);

      const publicIdentity = getPublicIdentityFromInvite(token!);
      expect(publicIdentity.id).toBe(identity.id);
    });

    it("creates URL-safe tokens", () => {
      const identity = createMockIdentity();
      const token = createInviteToken(identity, "wss://relay.example.com");

      // Should be safe to use in URLs
      const url = `https://app.example.com/join?token=${token}`;
      const parsed = new URL(url);
      expect(parsed.searchParams.get("token")).toBe(token);
    });
  });
});
