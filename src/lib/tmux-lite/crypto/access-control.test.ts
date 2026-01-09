/**
 * Unit tests for access control list management
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  AccessControlList,
  DEFAULT_ACCESS_TYPE,
  isAccessExpired,
} from "./access-control.js";
import { generateIdentity, getPublicIdentity, sign } from "./identity.js";
import type { AccessEntry, PublicIdentity } from "../../../types/identity.js";

describe("AccessControlList", () => {
  let acl: AccessControlList;
  let identity1: ReturnType<typeof generateIdentity>;
  let identity2: ReturnType<typeof generateIdentity>;
  let publicIdentity1: PublicIdentity;
  let publicIdentity2: PublicIdentity;

  beforeEach(() => {
    acl = new AccessControlList();
    identity1 = generateIdentity("User 1");
    identity2 = generateIdentity("User 2");
    publicIdentity1 = getPublicIdentity(identity1);
    publicIdentity2 = getPublicIdentity(identity2);
  });

  describe("addEntry", () => {
    it("should add a new entry with default access type", () => {
      const entry = acl.addEntry(publicIdentity1);

      expect(entry.identityId).toBe(publicIdentity1.id);
      expect(entry.signingPublicKey).toBe(publicIdentity1.signingPublicKey);
      expect(entry.keyExchangePublicKey).toBe(
        publicIdentity1.keyExchangePublicKey
      );
      expect(entry.label).toBe(publicIdentity1.label);
      expect(entry.accessType).toBe(DEFAULT_ACCESS_TYPE);
      expect(entry.grantedAt).toBeGreaterThan(0);
      expect(entry.expiresAt).toBeUndefined();
    });

    it("should add a new entry with custom access type", () => {
      const entry = acl.addEntry(publicIdentity1, 'session-invite');

      expect(entry.accessType).toBe('session-invite');
    });

    it("should add a new entry with session ID for session-invite", () => {
      const entry = acl.addEntry(publicIdentity1, 'session-invite', 'session-123');

      expect(entry.accessType).toBe('session-invite');
      expect(entry.sessionId).toBe('session-123');
    });

    it("should replace existing entry", () => {
      const entry1 = acl.addEntry(publicIdentity1, 'full');
      const entry2 = acl.addEntry(publicIdentity1, 'session-invite');

      expect(acl.size).toBe(1);
      expect(entry2.accessType).toBe('session-invite');
      expect(entry2.grantedAt).toBeGreaterThanOrEqual(entry1.grantedAt);
    });

    it("should handle identity without label", () => {
      const identityNoLabel = generateIdentity();
      const publicIdentityNoLabel = getPublicIdentity(identityNoLabel);
      const entry = acl.addEntry(publicIdentityNoLabel);

      expect(entry.label).toBeUndefined();
    });
  });

  describe("removeEntry", () => {
    it("should remove an existing entry", () => {
      acl.addEntry(publicIdentity1);
      const removed = acl.removeEntry(publicIdentity1.id);

      expect(removed).toBe(true);
      expect(acl.size).toBe(0);
    });

    it("should return false when removing non-existent entry", () => {
      const removed = acl.removeEntry("non-existent-id");

      expect(removed).toBe(false);
    });

    it("should not affect other entries", () => {
      acl.addEntry(publicIdentity1);
      acl.addEntry(publicIdentity2);

      acl.removeEntry(publicIdentity1.id);

      expect(acl.size).toBe(1);
      expect(acl.hasAccess(publicIdentity2.id)).toBe(true);
    });
  });

  describe("hasAccess", () => {
    it("should return true for existing entry", () => {
      acl.addEntry(publicIdentity1);

      expect(acl.hasAccess(publicIdentity1.id)).toBe(true);
    });

    it("should return false for non-existent entry", () => {
      expect(acl.hasAccess("non-existent-id")).toBe(false);
    });

    it("should return false for expired entry", () => {
      const entry = acl.addEntry(publicIdentity1);
      // Manually set expiry in the past
      entry.expiresAt = Date.now() - 1000;
      acl.import([entry]);

      expect(acl.hasAccess(publicIdentity1.id)).toBe(false);
    });

    it("should return true for entry with future expiry", () => {
      const entry = acl.addEntry(publicIdentity1);
      entry.expiresAt = Date.now() + 10000;
      acl.import([entry]);

      expect(acl.hasAccess(publicIdentity1.id)).toBe(true);
    });
  });

  describe("hasFullAccess", () => {
    it("should return true for entry with full access", () => {
      acl.addEntry(publicIdentity1, 'full');

      expect(acl.hasFullAccess(publicIdentity1.id)).toBe(true);
    });

    it("should return false for session-invite entry", () => {
      acl.addEntry(publicIdentity1, 'session-invite');

      expect(acl.hasFullAccess(publicIdentity1.id)).toBe(false);
    });

    it("should return false for non-existent entry", () => {
      expect(acl.hasFullAccess("non-existent-id")).toBe(false);
    });

    it("should return false for expired entry", () => {
      const entry = acl.addEntry(publicIdentity1, 'full');
      entry.expiresAt = Date.now() - 1000;
      acl.import([entry]);

      expect(acl.hasFullAccess(publicIdentity1.id)).toBe(false);
    });
  });

  describe("hasSessionAccess", () => {
    it("should return true for matching session", () => {
      acl.addEntry(publicIdentity1, 'session-invite', 'session-123');

      expect(acl.hasSessionAccess(publicIdentity1.id, 'session-123')).toBe(true);
    });

    it("should return false for non-matching session", () => {
      acl.addEntry(publicIdentity1, 'session-invite', 'session-123');

      expect(acl.hasSessionAccess(publicIdentity1.id, 'session-456')).toBe(false);
    });

    it("should return true for full access entry", () => {
      acl.addEntry(publicIdentity1, 'full');

      expect(acl.hasSessionAccess(publicIdentity1.id, 'any-session')).toBe(true);
    });

    it("should return false for non-existent entry", () => {
      expect(acl.hasSessionAccess("non-existent-id", 'session-123')).toBe(false);
    });
  });

  describe("getEntry", () => {
    it("should return entry for existing identity", () => {
      const added = acl.addEntry(publicIdentity1);
      const retrieved = acl.getEntry(publicIdentity1.id);

      expect(retrieved).toEqual(added);
    });

    it("should return undefined for non-existent identity", () => {
      const entry = acl.getEntry("non-existent-id");

      expect(entry).toBeUndefined();
    });

    it("should return undefined for expired entry", () => {
      const entry = acl.addEntry(publicIdentity1);
      entry.expiresAt = Date.now() - 1000;
      acl.import([entry]);

      expect(acl.getEntry(publicIdentity1.id)).toBeUndefined();
    });
  });

  describe("getAllEntries", () => {
    it("should return empty array when no entries", () => {
      expect(acl.getAllEntries()).toEqual([]);
    });

    it("should return all entries", () => {
      acl.addEntry(publicIdentity1);
      acl.addEntry(publicIdentity2);

      const entries = acl.getAllEntries();

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.identityId)).toContain(publicIdentity1.id);
      expect(entries.map((e) => e.identityId)).toContain(publicIdentity2.id);
    });

    it("should include expired entries", () => {
      const entry = acl.addEntry(publicIdentity1);
      entry.expiresAt = Date.now() - 1000;
      acl.import([entry]);

      const entries = acl.getAllEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].identityId).toBe(publicIdentity1.id);
    });
  });

  describe("updateAccessType", () => {
    it("should update access type for existing entry", () => {
      acl.addEntry(publicIdentity1, 'full');

      const updated = acl.updateAccessType(publicIdentity1.id, 'session-invite', 'session-123');

      expect(updated).toBe(true);
      const entry = acl.getEntry(publicIdentity1.id);
      expect(entry?.accessType).toBe('session-invite');
      expect(entry?.sessionId).toBe('session-123');
    });

    it("should return false for non-existent entry", () => {
      const updated = acl.updateAccessType("non-existent-id", 'full');

      expect(updated).toBe(false);
    });
  });

  describe("updateLabel", () => {
    it("should update label for existing entry", () => {
      acl.addEntry(publicIdentity1);

      const updated = acl.updateLabel(publicIdentity1.id, "New Label");

      expect(updated).toBe(true);
      const entry = acl.getEntry(publicIdentity1.id);
      expect(entry?.label).toBe("New Label");
    });

    it("should return false for non-existent entry", () => {
      const updated = acl.updateLabel("non-existent-id", "Label");

      expect(updated).toBe(false);
    });
  });

  describe("verifyAndCheckAccess", () => {
    it("should return entry for valid signature with access", () => {
      const entry = acl.addEntry(publicIdentity1);

      const message = new TextEncoder().encode("test message");
      const signature = sign(message, identity1.signing.secretKey);

      const result = acl.verifyAndCheckAccess(
        message,
        signature,
        identity1.signing.publicKey
      );

      expect(result).toEqual(entry);
    });

    it("should return null for invalid signature", () => {
      acl.addEntry(publicIdentity1);

      const message = new TextEncoder().encode("test message");
      const wrongMessage = new TextEncoder().encode("wrong message");
      const signature = sign(message, identity1.signing.secretKey);

      const result = acl.verifyAndCheckAccess(
        wrongMessage,
        signature,
        identity1.signing.publicKey
      );

      expect(result).toBeNull();
    });

    it("should return null for identity without access", () => {
      const message = new TextEncoder().encode("test message");
      const signature = sign(message, identity1.signing.secretKey);

      const result = acl.verifyAndCheckAccess(
        message,
        signature,
        identity1.signing.publicKey
      );

      expect(result).toBeNull();
    });

    it("should return null for expired entry", () => {
      const entry = acl.addEntry(publicIdentity1);
      entry.expiresAt = Date.now() - 1000;
      acl.import([entry]);

      const message = new TextEncoder().encode("test message");
      const signature = sign(message, identity1.signing.secretKey);

      const result = acl.verifyAndCheckAccess(
        message,
        signature,
        identity1.signing.publicKey
      );

      expect(result).toBeNull();
    });

    it("should return null for signature from different identity", () => {
      acl.addEntry(publicIdentity1);

      const message = new TextEncoder().encode("test message");
      const signature = sign(message, identity2.signing.secretKey);

      const result = acl.verifyAndCheckAccess(
        message,
        signature,
        identity1.signing.publicKey
      );

      expect(result).toBeNull();
    });
  });

  describe("export", () => {
    it("should export empty list", () => {
      const exported = acl.export();

      expect(exported).toEqual([]);
    });

    it("should export all entries", () => {
      acl.addEntry(publicIdentity1);
      acl.addEntry(publicIdentity2);

      const exported = acl.export();

      expect(exported).toHaveLength(2);
      expect(exported.map((e) => e.identityId)).toContain(publicIdentity1.id);
      expect(exported.map((e) => e.identityId)).toContain(publicIdentity2.id);
    });

    it("should export serializable JSON", () => {
      acl.addEntry(publicIdentity1);

      const exported = acl.export();
      const json = JSON.stringify(exported);
      const parsed = JSON.parse(json) as AccessEntry[];

      expect(parsed).toHaveLength(1);
      expect(parsed[0].identityId).toBe(publicIdentity1.id);
    });
  });

  describe("import", () => {
    it("should import entries", () => {
      const entry1 = acl.addEntry(publicIdentity1);
      const entry2 = acl.addEntry(publicIdentity2);
      const exported = acl.export();

      const newAcl = new AccessControlList();
      newAcl.import(exported);

      expect(newAcl.size).toBe(2);
      expect(newAcl.getEntry(publicIdentity1.id)).toEqual(entry1);
      expect(newAcl.getEntry(publicIdentity2.id)).toEqual(entry2);
    });

    it("should clear existing entries on import", () => {
      acl.addEntry(publicIdentity1);

      const entry2: AccessEntry = {
        identityId: publicIdentity2.id,
        signingPublicKey: publicIdentity2.signingPublicKey,
        keyExchangePublicKey: publicIdentity2.keyExchangePublicKey,
        label: publicIdentity2.label,
        grantedAt: Date.now(),
        accessType: 'full',
      };

      acl.import([entry2]);

      expect(acl.size).toBe(1);
      expect(acl.hasAccess(publicIdentity1.id)).toBe(false);
      expect(acl.hasAccess(publicIdentity2.id)).toBe(true);
    });

    it("should handle empty import", () => {
      acl.addEntry(publicIdentity1);

      acl.import([]);

      expect(acl.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("should remove all entries", () => {
      acl.addEntry(publicIdentity1);
      acl.addEntry(publicIdentity2);

      acl.clear();

      expect(acl.size).toBe(0);
      expect(acl.getAllEntries()).toEqual([]);
    });

    it("should handle clearing empty list", () => {
      acl.clear();

      expect(acl.size).toBe(0);
    });
  });

  describe("size", () => {
    it("should return 0 for empty list", () => {
      expect(acl.size).toBe(0);
    });

    it("should return correct count", () => {
      acl.addEntry(publicIdentity1);
      expect(acl.size).toBe(1);

      acl.addEntry(publicIdentity2);
      expect(acl.size).toBe(2);

      acl.removeEntry(publicIdentity1.id);
      expect(acl.size).toBe(1);
    });
  });
});

describe("isAccessExpired", () => {
  it("should return false for entry without expiry", () => {
    const entry: AccessEntry = {
      identityId: "test-id",
      signingPublicKey: "test-key",
      keyExchangePublicKey: "test-kx-key",
      grantedAt: Date.now(),
      accessType: 'full',
    };

    expect(isAccessExpired(entry)).toBe(false);
  });

  it("should return false for entry with future expiry", () => {
    const entry: AccessEntry = {
      identityId: "test-id",
      signingPublicKey: "test-key",
      keyExchangePublicKey: "test-kx-key",
      grantedAt: Date.now(),
      accessType: 'full',
      expiresAt: Date.now() + 10000,
    };

    expect(isAccessExpired(entry)).toBe(false);
  });

  it("should return true for entry with past expiry", () => {
    const entry: AccessEntry = {
      identityId: "test-id",
      signingPublicKey: "test-key",
      keyExchangePublicKey: "test-kx-key",
      grantedAt: Date.now() - 2000,
      accessType: 'full',
      expiresAt: Date.now() - 1000,
    };

    expect(isAccessExpired(entry)).toBe(true);
  });

  it("should return true for entry expiring now", () => {
    const now = Date.now();
    const entry: AccessEntry = {
      identityId: "test-id",
      signingPublicKey: "test-key",
      keyExchangePublicKey: "test-kx-key",
      grantedAt: now - 1000,
      accessType: 'full',
      expiresAt: now,
    };

    expect(isAccessExpired(entry)).toBe(true);
  });
});

describe("DEFAULT_ACCESS_TYPE", () => {
  it("should be full access", () => {
    expect(DEFAULT_ACCESS_TYPE).toBe('full');
  });
});
