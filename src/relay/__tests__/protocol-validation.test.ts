/**
 * Protocol Validation Tests
 *
 * Tests message parsing and validation for the relay protocol.
 * Focuses on edge cases and error conditions discovered in production.
 */

import { describe, expect, test } from "bun:test";
import {
  parseMessage,
  isValidIdentifier,
  isValidBase64,
} from "../protocol";

describe("parseMessage", () => {
  describe("direct auth message validation", () => {
    const validSignature = {
      sig: "dGVzdC1zaWduYXR1cmU=",
      pub: "dGVzdC1wdWJsaWMta2V5",
      ts: Date.now(),
    };

    test("parses valid list_machines message", () => {
      const result = parseMessage(JSON.stringify({
        type: "list_machines",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        deviceCertificate: "{\"deviceSigningPublicKey\":\"abc\"}",
        signature: validSignature,
      }));
      expect(result).not.toBeNull();
      expect(result?.type).toBe("list_machines");
    });

    test("rejects list_machines without deviceCertificate", () => {
      const result = parseMessage(JSON.stringify({
        type: "list_machines",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        signature: validSignature,
      }));
      expect(result).toBeNull();
    });

    test("rejects list_machines with empty deviceCertificate", () => {
      const result = parseMessage(JSON.stringify({
        type: "list_machines",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        deviceCertificate: "",
        signature: validSignature,
      }));
      expect(result).toBeNull();
    });

    test("rejects list_machines without signature", () => {
      const result = parseMessage(JSON.stringify({
        type: "list_machines",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        deviceCertificate: "{\"deviceSigningPublicKey\":\"abc\"}",
      }));
      expect(result).toBeNull();
    });

    test("parses valid connect_to_machine message", () => {
      const result = parseMessage(JSON.stringify({
        type: "connect_to_machine",
        machineId: "R0lENwJ57_naVQ3h",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        deviceCertificate: "{\"deviceSigningPublicKey\":\"abc\"}",
        signature: validSignature,
      }));
      expect(result).not.toBeNull();
      expect(result?.type).toBe("connect_to_machine");
    });

    test("rejects connect_to_machine without signature", () => {
      const result = parseMessage(JSON.stringify({
        type: "connect_to_machine",
        machineId: "R0lENwJ57_naVQ3h",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        deviceCertificate: "{\"deviceSigningPublicKey\":\"abc\"}",
      }));
      expect(result).toBeNull();
    });

    test("rejects connect_to_machine without deviceCertificate", () => {
      const result = parseMessage(JSON.stringify({
        type: "connect_to_machine",
        machineId: "R0lENwJ57_naVQ3h",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        signature: validSignature,
      }));
      expect(result).toBeNull();
    });

    test("rejects connect_to_machine with empty clientIdentityId", () => {
      const result = parseMessage(JSON.stringify({
        type: "connect_to_machine",
        machineId: "R0lENwJ57_naVQ3h",
        clientIdentityId: "",
        deviceCertificate: "{\"deviceSigningPublicKey\":\"abc\"}",
        signature: validSignature,
      }));
      expect(result).toBeNull();
    });

    test("rejects legacy connect_with_invite messages", () => {
      const result = parseMessage(JSON.stringify({
        type: "connect_with_invite",
        inviteId: "invite1234abcd567",
        clientIdentityId: "vyPe20Hv1pnlKo89",
        deviceCertificate: "{\"deviceSigningPublicKey\":\"abc\"}",
        signature: validSignature,
      }));
      expect(result).toBeNull();
    });
  });

  describe("register_machine validation", () => {
    const validRegisterMachine = {
      type: "register_machine",
      machineId: "R0lENwJ57_naVQ3h",
      signingKey: "vyPe20Hv1pnlKo89BOvn5XuJzPXarq5/hjim96fZ/dM=",
      keyExchangeKey: "/NOCKBrpy+5hST69/NF2rXutunFakeKey123456789=",
    };

    test("parses valid register_machine message", () => {
      const result = parseMessage(JSON.stringify(validRegisterMachine));
      expect(result).not.toBeNull();
      expect(result?.type).toBe("register_machine");
    });

    test("accepts message with optional label", () => {
      const msg = { ...validRegisterMachine, label: "My Machine" };
      const result = parseMessage(JSON.stringify(msg));
      expect(result).not.toBeNull();
    });

    test("accepts message with optional challengeResponse", () => {
      const msg = { ...validRegisterMachine, challengeResponse: "base64signature==" };
      const result = parseMessage(JSON.stringify(msg));
      expect(result).not.toBeNull();
    });

    test("rejects message with missing machineId", () => {
      const msg = { ...validRegisterMachine };
      delete (msg as any).machineId;
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });
  });

  describe('unlock_request validation', () => {
    const validUnlock = {
      type: 'unlock_request',
      workspaceId: 'ws-abc123',
      unlockToken: 'tok_abc123',
      ephemeralKey: '3QKQ3Fjwq5iPk9qk2x6R2A6f7vG8hQ1r3sYkN0Lz9mU=',
    };

    test('parses valid unlock_request message', () => {
      const result = parseMessage(JSON.stringify(validUnlock));
      expect(result).not.toBeNull();
      expect(result?.type).toBe('unlock_request');
    });

    test('rejects unlock_request with missing workspaceId', () => {
      const msg = { ...validUnlock } as any;
      delete msg.workspaceId;
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });

    test('rejects unlock_request with empty token', () => {
      const msg = { ...validUnlock, unlockToken: '' };
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });

    test('rejects unlock_request with missing ephemeralKey', () => {
      const msg = { ...validUnlock } as any;
      delete msg.ephemeralKey;
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });
  });

  describe('unlock_grant validation', () => {
    const validGrant = {
      type: 'unlock_grant',
      workspaceId: 'ws-abc123',
      tokenId: 'tok-id-123',
      registerPermit: 'permit-123',
      ciphertext: '3QKQ3Fjwq5iPk9qk2x6R2A6f7vG8hQ1r3sYkN0Lz9mU=',
      relayEphemeralKey: '4QKQ3Fjwq5iPk9qk2x6R2A6f7vG8hQ1r3sYkN0Lz9mU=',
      salt: '5QKQ3Fjwq5iPk9qk2x6R2A6f7vG8hQ1r3sYkN0Lz9mU=',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    test('parses valid unlock_grant message', () => {
      const result = parseMessage(JSON.stringify(validGrant));
      expect(result).not.toBeNull();
      expect(result?.type).toBe('unlock_grant');
    });

    test('rejects unlock_grant missing ciphertext', () => {
      const msg = { ...validGrant } as any;
      delete msg.ciphertext;
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });

    test('rejects unlock_grant missing registerPermit', () => {
      const msg = { ...validGrant } as any;
      delete msg.registerPermit;
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });
  });

  describe("data message validation", () => {
    test("parses machine data message with connectionId", () => {
      const msg = {
        type: "data",
        connectionId: "abc123def456",
        data: "SGVsbG8gV29ybGQ=", // base64 "Hello World"
      };
      const result = parseMessage(JSON.stringify(msg));
      expect(result).not.toBeNull();
      expect(result?.type).toBe("data");
    });

    test("parses client data message without connectionId", () => {
      const msg = {
        type: "data",
        data: "SGVsbG8gV29ybGQ=",
      };
      const result = parseMessage(JSON.stringify(msg));
      expect(result).not.toBeNull();
    });

    test("rejects data message with empty data", () => {
      const msg = {
        type: "data",
        data: "",
      };
      const result = parseMessage(JSON.stringify(msg));
      expect(result).toBeNull();
    });
  });

  describe("error handling", () => {
    test("returns null for invalid JSON", () => {
      const result = parseMessage("not valid json");
      expect(result).toBeNull();
    });

    test("returns null for empty string", () => {
      const result = parseMessage("");
      expect(result).toBeNull();
    });

    test("returns null for message without type", () => {
      const result = parseMessage(JSON.stringify({ foo: "bar" }));
      expect(result).toBeNull();
    });

    test("returns null for unknown message type", () => {
      const result = parseMessage(JSON.stringify({ type: "unknown_type" }));
      expect(result).toBeNull();
    });

    test("returns null for message exceeding size limit", () => {
      const hugeData = "x".repeat(2 * 1024 * 1024); // 2MB
      const result = parseMessage(hugeData);
      expect(result).toBeNull();
    });
  });
});

describe("isValidIdentifier", () => {
  test("accepts alphanumeric identifiers", () => {
    expect(isValidIdentifier("abc123")).toBe(true);
    expect(isValidIdentifier("ABC123")).toBe(true);
  });

  test("accepts identifiers with allowed special chars", () => {
    expect(isValidIdentifier("machine-1")).toBe(true);
    expect(isValidIdentifier("machine_1")).toBe(true);
    expect(isValidIdentifier("machine.local")).toBe(true);
    expect(isValidIdentifier("client:xyz")).toBe(true);
    expect(isValidIdentifier("key+value")).toBe(true);
    expect(isValidIdentifier("base64/chars")).toBe(true);
    expect(isValidIdentifier("equals=sign")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidIdentifier("")).toBe(false);
  });

  test("rejects identifiers with spaces", () => {
    expect(isValidIdentifier("has space")).toBe(false);
  });

  test("rejects identifiers with control characters", () => {
    expect(isValidIdentifier("has\nnewline")).toBe(false);
    expect(isValidIdentifier("has\ttab")).toBe(false);
  });

  test("rejects very long identifiers", () => {
    const longId = "x".repeat(500);
    expect(isValidIdentifier(longId)).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isValidIdentifier(123 as any)).toBe(false);
    expect(isValidIdentifier(null as any)).toBe(false);
    expect(isValidIdentifier(undefined as any)).toBe(false);
  });
});

describe("isValidBase64", () => {
  test("accepts valid base64 strings", () => {
    expect(isValidBase64("SGVsbG8gV29ybGQ=")).toBe(true);
    expect(isValidBase64("YWJjMTIz")).toBe(true);
  });

  test("accepts base64url strings", () => {
    expect(isValidBase64("abc-def_ghi")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidBase64("")).toBe(false);
  });

  test("rejects strings with invalid characters", () => {
    expect(isValidBase64("has space")).toBe(false);
    expect(isValidBase64("has\nnewline")).toBe(false);
  });

  test("rejects very long strings", () => {
    const longData = "x".repeat(2 * 1024 * 1024);
    expect(isValidBase64(longData)).toBe(false);
  });
});
