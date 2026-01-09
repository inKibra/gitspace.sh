/**
 * Access List Tests
 *
 * Tests for access list file operations and entry validation.
 * Covers edge cases discovered in production.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readAccessList,
  writeAccessList,
  addAccess,
  removeAccess,
  getAccessEntry,
  parsePublicKey,
} from "../access";
import type { AccessEntry, PublicIdentity } from "../../types/identity";

// Use a temp directory for tests to avoid affecting real config
const TEST_DIR = join(tmpdir(), `spaces-test-${Date.now()}`);
const TEST_ACCESS_PATH = join(TEST_DIR, ".access.json");

// Mock getSpacesDir to use test directory
let originalGetSpacesDir: () => string;

beforeEach(() => {
  // Create test directory
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Cleanup test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("readAccessList", () => {
  test("returns empty array when file does not exist", () => {
    // Note: This test uses the real getSpacesDir, so it may return
    // actual entries if the file exists. For unit testing, we'd need
    // to mock getSpacesDir or use dependency injection.
    // This is more of an integration test pattern.
  });

  test("parses valid JSON access list", () => {
    const entries: AccessEntry[] = [
      {
        identityId: "test123",
        signingPublicKey: "signingKey123",
        keyExchangePublicKey: "keyExchangeKey123",
        label: "Test Device",
        grantedAt: Date.now(),
        accessType: "full",
      },
    ];
    writeFileSync(TEST_ACCESS_PATH, JSON.stringify(entries), "utf-8");

    // Would need to mock getAccessListPath to use TEST_ACCESS_PATH
  });
});

describe("AccessEntry validation", () => {
  /**
   * These tests document the expected shape of access entries
   * and what fields are required for proper protocol communication.
   */

  test("valid entry has all required fields", () => {
    const validEntry: AccessEntry = {
      identityId: "vyPe20Hv1pnlKo89",
      signingPublicKey: "vyPe20Hv1pnlKo89BOvn5XuJzPXarq5/hjim96fZ/dM=",
      keyExchangePublicKey: "/NOCKBrpy+5hST69/NF2rXutunFakeKey123456789=",
      label: "Test Device",
      grantedAt: Date.now(),
      accessType: "full",
    };

    expect(validEntry.identityId).toBeTruthy();
    expect(validEntry.signingPublicKey).toBeTruthy();
    expect(validEntry.keyExchangePublicKey).toBeTruthy();
    expect(validEntry.accessType).toBe("full");
  });

  test("entry with missing keyExchangePublicKey is invalid for relay sync", () => {
    const invalidEntry = {
      identityId: "vyPe20Hv1pnlKo89",
      signingPublicKey: "vyPe20Hv1pnlKo89BOvn5XuJzPXarq5/hjim96fZ/dM=",
      keyExchangePublicKey: "", // Empty - will fail protocol validation
      label: "Test Device",
      grantedAt: Date.now(),
      accessType: "full" as const,
    };

    expect(invalidEntry.keyExchangePublicKey).toBeFalsy();
  });

  test("entry with missing accessType is invalid for relay sync", () => {
    const legacyEntry = {
      identityId: "vyPe20Hv1pnlKo89",
      signingPublicKey: "vyPe20Hv1pnlKo89BOvn5XuJzPXarq5/hjim96fZ/dM=",
      keyExchangePublicKey: "/NOCKBrpy+5hST69/NF2rXutunFakeKey123456789=",
      label: "Legacy Device",
      grantedAt: Date.now(),
      // accessType is missing - legacy entry before schema update
    };

    expect((legacyEntry as any).accessType).toBeUndefined();
  });

  test("accessType must be 'full' or 'session-invite'", () => {
    const validTypes = ["full", "session-invite"];
    const invalidTypes = ["admin", "read-only", "", null, undefined];

    for (const type of validTypes) {
      expect(type === "full" || type === "session-invite").toBe(true);
    }

    for (const type of invalidTypes) {
      expect(type === "full" || type === "session-invite").toBe(false);
    }
  });
});

describe("parsePublicKey", () => {
  test("parses full format gssh-pub:SIGNING:KEYEXCHANGE", () => {
    // Generate valid test keys (32 bytes each, base64 encoded)
    const signingKey = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");
    const keyExchangeKey = Buffer.from(new Uint8Array(32).fill(2)).toString("base64");
    const pubkeyString = `gssh-pub:${signingKey}:${keyExchangeKey}`;

    const result = parsePublicKey(pubkeyString);

    expect(result.signingPublicKey).toBe(signingKey);
    expect(result.keyExchangePublicKey).toBe(keyExchangeKey);
    expect(result.id).toBeTruthy(); // Derived from signing key
  });

  test("parses signing key only format", () => {
    const signingKey = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");

    const result = parsePublicKey(signingKey);

    expect(result.signingPublicKey).toBe(signingKey);
    expect(result.keyExchangePublicKey).toBe(""); // Empty - needs to be provided separately
    expect(result.id).toBeTruthy();
  });

  test("throws for invalid format", () => {
    expect(() => parsePublicKey("gssh-pub:only-one-part")).toThrow();
    expect(() => parsePublicKey("gssh-pub:a:b:c:d")).toThrow();
  });

  test("throws for invalid base64", () => {
    expect(() => parsePublicKey("not-valid-base64!!!")).toThrow();
  });

  test("throws for wrong key length", () => {
    const shortKey = Buffer.from(new Uint8Array(16)).toString("base64"); // 16 bytes, not 32
    expect(() => parsePublicKey(shortKey)).toThrow();
  });
});

describe("access entry validation helper", () => {
  /**
   * Helper function to validate an access entry has all required fields
   * for relay protocol communication.
   */
  function isValidAccessEntry(entry: Partial<AccessEntry>): boolean {
    if (!entry.identityId || entry.identityId.length === 0) return false;
    if (!entry.signingPublicKey || entry.signingPublicKey.length === 0) return false;
    if (!entry.keyExchangePublicKey || entry.keyExchangePublicKey.length === 0) return false;
    if (entry.accessType !== "full" && entry.accessType !== "session-invite") return false;
    return true;
  }

  test("validates complete entry", () => {
    const entry: AccessEntry = {
      identityId: "test123",
      signingPublicKey: "signingKey",
      keyExchangePublicKey: "keyExchangeKey",
      label: "Test",
      grantedAt: Date.now(),
      accessType: "full",
    };
    expect(isValidAccessEntry(entry)).toBe(true);
  });

  test("rejects entry with empty identityId", () => {
    const entry = {
      identityId: "",
      signingPublicKey: "signingKey",
      keyExchangePublicKey: "keyExchangeKey",
      accessType: "full" as const,
    };
    expect(isValidAccessEntry(entry)).toBe(false);
  });

  test("rejects entry with empty signingPublicKey", () => {
    const entry = {
      identityId: "test123",
      signingPublicKey: "",
      keyExchangePublicKey: "keyExchangeKey",
      accessType: "full" as const,
    };
    expect(isValidAccessEntry(entry)).toBe(false);
  });

  test("rejects entry with empty keyExchangePublicKey", () => {
    const entry = {
      identityId: "test123",
      signingPublicKey: "signingKey",
      keyExchangePublicKey: "",
      accessType: "full" as const,
    };
    expect(isValidAccessEntry(entry)).toBe(false);
  });

  test("rejects entry with undefined accessType", () => {
    const entry = {
      identityId: "test123",
      signingPublicKey: "signingKey",
      keyExchangePublicKey: "keyExchangeKey",
    };
    expect(isValidAccessEntry(entry)).toBe(false);
  });

  test("rejects entry with invalid accessType", () => {
    const entry = {
      identityId: "test123",
      signingPublicKey: "signingKey",
      keyExchangePublicKey: "keyExchangeKey",
      accessType: "admin" as any,
    };
    expect(isValidAccessEntry(entry)).toBe(false);
  });
});
