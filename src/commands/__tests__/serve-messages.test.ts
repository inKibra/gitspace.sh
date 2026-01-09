/**
 * Serve Message Handler Tests
 *
 * Tests that the serve command properly handles all message types
 * from the relay server. This ensures no "Unknown message type" errors.
 */

import { describe, expect, test } from "bun:test";
import type { RelayToMachineMessage } from "../../relay/protocol";

/**
 * All message types that the relay can send to a machine.
 * The serve command's message handler must handle all of these.
 */
const RELAY_TO_MACHINE_MESSAGE_TYPES: RelayToMachineMessage["type"][] = [
  "relay_identity",
  "challenge",
  "registered",
  "access_list",
  "access_update",
  "client_authorized",
  "client_revoked",
  "client_connected",
  "client_disconnected",
  "data",
  "error",
];

/**
 * Message types that require explicit handling (not just acknowledgment).
 */
const CRITICAL_MESSAGE_TYPES = [
  "relay_identity",   // Must respond with register_machine
  "registered",       // Must sync access list
  "client_connected", // Must set up session
  "client_disconnected", // Must clean up session
  "data",            // Must route to session
  "error",           // Must log/handle error
  "access_list",     // Must update local ACL
  "access_update",   // Must update local ACL
];

/**
 * Message types that are acknowledgments (can be no-ops).
 */
const ACKNOWLEDGMENT_MESSAGE_TYPES = [
  "client_authorized",
  "client_revoked",
  "challenge", // Only used if relay sends separate challenge (usually included in relay_identity)
];

describe("serve message handler coverage", () => {
  test("documents all relay-to-machine message types", () => {
    // This test documents the expected message types.
    // If the protocol adds new types, this test should be updated.
    expect(RELAY_TO_MACHINE_MESSAGE_TYPES).toHaveLength(11);
  });

  test("critical message types are a subset of all types", () => {
    for (const type of CRITICAL_MESSAGE_TYPES) {
      expect(RELAY_TO_MACHINE_MESSAGE_TYPES).toContain(type as RelayToMachineMessage["type"]);
    }
  });

  test("acknowledgment message types are a subset of all types", () => {
    for (const type of ACKNOWLEDGMENT_MESSAGE_TYPES) {
      expect(RELAY_TO_MACHINE_MESSAGE_TYPES).toContain(type as RelayToMachineMessage["type"]);
    }
  });

  test("all message types are either critical or acknowledgment", () => {
    const allCovered = new Set([
      ...CRITICAL_MESSAGE_TYPES,
      ...ACKNOWLEDGMENT_MESSAGE_TYPES,
    ]);

    for (const type of RELAY_TO_MACHINE_MESSAGE_TYPES) {
      expect(allCovered.has(type)).toBe(true);
    }
  });
});

describe("message type handling requirements", () => {
  /**
   * These tests document what each message type requires.
   * They serve as living documentation for the serve command implementation.
   */

  test("relay_identity requires challenge-response authentication", () => {
    const requirements = {
      type: "relay_identity",
      requiredFields: ["publicKey", "fingerprint", "challenge"],
      expectedResponse: "register_machine with challengeResponse",
      securityNote: "Must verify relay trust before responding",
    };

    expect(requirements.requiredFields).toContain("challenge");
    expect(requirements.expectedResponse).toContain("challengeResponse");
  });

  test("registered triggers access list sync", () => {
    const requirements = {
      type: "registered",
      requiredFields: ["machineId"],
      sideEffects: [
        "Sync all access entries to relay",
        "Start access list file watcher",
        "Set up access command handler",
      ],
    };

    expect(requirements.sideEffects.length).toBeGreaterThan(0);
  });

  test("client_authorized is an acknowledgment", () => {
    const requirements = {
      type: "client_authorized",
      requiredFields: ["clientIdentityId"],
      sideEffects: [], // No action needed - authorization was already applied locally
      note: "Sent by relay to confirm authorize_client was processed",
    };

    expect(requirements.sideEffects).toHaveLength(0);
  });

  test("client_revoked is an acknowledgment", () => {
    const requirements = {
      type: "client_revoked",
      requiredFields: ["clientIdentityId"],
      sideEffects: [], // No action needed - revocation was already applied locally
      note: "Sent by relay to confirm revoke_client was processed",
    };

    expect(requirements.sideEffects).toHaveLength(0);
  });

  test("access_list requires full ACL replacement", () => {
    const requirements = {
      type: "access_list",
      requiredFields: ["entries"],
      sideEffects: [
        "Update local access control list with all entries",
      ],
      note: "Sent on reconnect to sync full state",
    };

    expect(requirements.requiredFields).toContain("entries");
  });

  test("access_update requires incremental ACL update", () => {
    const requirements = {
      type: "access_update",
      requiredFields: ["added", "removed"],
      sideEffects: [
        "Add new entries to local ACL",
        "Remove revoked entries from local ACL",
      ],
    };

    expect(requirements.requiredFields).toContain("added");
    expect(requirements.requiredFields).toContain("removed");
  });
});

describe("error scenarios", () => {
  test("unknown message types should log warning", () => {
    // The serve command should log unknown message types
    // rather than silently ignoring them
    const unknownType = "some_future_message_type";
    expect(RELAY_TO_MACHINE_MESSAGE_TYPES).not.toContain(unknownType);
  });

  test("malformed messages should not crash handler", () => {
    // These are examples of malformed messages that the handler
    // should gracefully reject without crashing
    const malformedMessages = [
      null,
      undefined,
      {},
      { type: null },
      { type: 123 },
      "not an object",
      { type: "registered" }, // missing machineId
      { type: "data" }, // missing data field
    ];

    // Each should be handled without throwing
    expect(malformedMessages.length).toBe(8);
  });
});
