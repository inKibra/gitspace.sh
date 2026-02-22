/**
 * Security Integration Tests
 *
 * Tests for security fixes addressing the vulnerabilities in SECURITY_REVIEW.md:
 * 1. Identity signature proof (Issue 1)
 * 2. Permission enforcement (Issue 2)
 * 3. Machine takeover prevention (Issue 3)
 * 4. Access-list-only authorization enforcement
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processClientAuth,
  createServerState,
  processClientHello,
  createServerHello,
} from "../../handshake.js";
import { HandshakeHandler, type HandshakeMessage } from "../../../handshake-handler.js";
import { AccessControlList } from "../../access-control.js";
import { createDeviceCertificate } from "../../device-cert.js";
import { generateMnemonic, mnemonicToUserIdentity } from "../../user-identity.js";
import { sign } from "../../identity.js";
import {
  createTestIdentity,
  createTestIdentityPair,
  toPublicIdentity,
} from "../helpers/test-identities.js";
import { runCompleteHandshake } from "../helpers/handshake-runner.js";
import {
  registerMachine,
  clearAllRegistries,
} from "../../../../../relay/registries.js";
import type { Identity, X3DHAuthMessage, X3DHResponseMessage } from "../../../../../types/identity.js";
import {
  createMockWebSocket,
  asMockWs,
  omit,
  isReplyResult,
  getReplyData,
} from "../../../../../__tests__/test-utils.js";
import type { ServerWebSocket } from "bun";
import type { WebSocketData } from "../../../../../relay/types.js";

function buildDeviceCertificateFor(identity: Identity): string {
  const userRoot = mnemonicToUserIdentity(generateMnemonic());
  const cert = createDeviceCertificate(
    userRoot,
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
  );
  return JSON.stringify(cert);
}

// ============================================================================
// Issue 1: Identity Signature Proof Tests
// ============================================================================

describe("Issue 1: Identity Signature Proof", () => {
  let client: Identity;
  let machine: Identity;
  let accessList: AccessControlList;

  beforeEach(() => {
    ({ client, machine } = createTestIdentityPair());
    accessList = new AccessControlList();
  });

  it("should accept valid handshake with correct identity signature", async () => {
    // Add client to access list
    accessList.addEntry(toPublicIdentity(client), "full");

    const result = await runCompleteHandshake(
      client,
      machine,
      accessList,
      { type: "access_list" }
    );

    expect(result.success).toBe(true);
    expect(result.clientKeys).toBeDefined();
    expect(result.machineSession).toBeDefined();
  });

  it("should reject ClientAuth with forged identity key", async () => {
    // Create two identities - client will claim to be impersonator
    const impersonator = createTestIdentity("Impersonator");

    // Add the impersonator to access list (but attacker won't have their private key)
    accessList.addEntry(toPublicIdentity(impersonator), "full");

    // Manually run handshake to forge the identity key
    const serverState = createServerState(machine);
    const { state: clientState, message: clientHello } = createClientHello(machine.id);

    const stateAfterHello = processClientHello(serverState, clientHello);
    expect(stateAfterHello).not.toBeNull();

    const { state: stateAfterServerHello, message: serverHello } = createServerHello(
      stateAfterHello!,
      machine
    );

    const clientStateAfterServerHello = processServerHello(clientState, serverHello);
    expect(clientStateAfterServerHello).not.toBeNull();

    // Create ClientAuth with client's identity but forging impersonator's public key
    // This should fail because signature won't verify
    const { message: clientAuth } = createClientAuth(
      clientStateAfterServerHello!,
      client, // Use client's keys for signing
      { type: "access_list" },
      buildDeviceCertificateFor(client),
    );

    // Forge the identity key to claim impersonator's identity
    const forgedAuth: X3DHAuthMessage = {
      ...clientAuth,
      identityKey: Buffer.from(impersonator.signing.publicKey).toString("base64"),
    };

    // Process the forged ClientAuth - should fail signature verification
    const result = processClientAuth(stateAfterServerHello, forgedAuth, machine);
    expect(result).toBeNull(); // Should reject due to signature mismatch
  });

  it("should reject ClientAuth with missing identity signature", async () => {
    accessList.addEntry(toPublicIdentity(client), "full");

    // Manually run handshake to create ClientAuth without signature
    const serverState = createServerState(machine);
    const { state: clientState, message: clientHello } = createClientHello(machine.id);

    const stateAfterHello = processClientHello(serverState, clientHello);
    expect(stateAfterHello).not.toBeNull();

    const { state: stateAfterServerHello, message: serverHello } = createServerHello(
      stateAfterHello!,
      machine
    );

    const clientStateAfterServerHello = processServerHello(clientState, serverHello);
    expect(clientStateAfterServerHello).not.toBeNull();

    const { message: clientAuth } = createClientAuth(
      clientStateAfterServerHello!,
      client,
      { type: "access_list" },
      buildDeviceCertificateFor(client),
    );

    // Remove the signature using type-safe utility
    // We cast to X3DHAuthMessage because we're deliberately testing what happens
    // when a required field is missing - the function should reject this
    const authWithoutSignature = omit(clientAuth, 'identitySignature') as unknown as X3DHAuthMessage;

    // Process - should reject due to missing signature
    const result = processClientAuth(stateAfterServerHello, authWithoutSignature, machine);
    expect(result).toBeNull();
  });

  it("should reject ClientAuth with wrong signature", async () => {
    // Another client whose signature we'll use
    const other = createTestIdentity("Other");
    accessList.addEntry(toPublicIdentity(client), "full");

    // Manually run handshake
    const serverState = createServerState(machine);
    const { state: clientState, message: clientHello } = createClientHello(machine.id);

    const stateAfterHello = processClientHello(serverState, clientHello);
    expect(stateAfterHello).not.toBeNull();

    const { state: stateAfterServerHello, message: serverHello } = createServerHello(
      stateAfterHello!,
      machine
    );

    const clientStateAfterServerHello = processServerHello(clientState, serverHello);
    expect(clientStateAfterServerHello).not.toBeNull();

    const { message: clientAuth } = createClientAuth(
      clientStateAfterServerHello!,
      client,
      { type: "access_list" },
      buildDeviceCertificateFor(client),
    );

    // Create a wrong signature (signed by other identity)
    const wrongSignature = sign(
      new Uint8Array(128), // Some random data
      other.signing.secretKey
    );

    const authWithWrongSignature: X3DHAuthMessage = {
      ...clientAuth,
      identitySignature: Buffer.from(wrongSignature).toString("base64"),
    };

    // Process - should reject due to signature verification failure
    const result = processClientAuth(stateAfterServerHello, authWithWrongSignature, machine);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Issue 2: Permission Enforcement Tests
// ============================================================================

describe("Issue 2: Permission Enforcement", () => {
  describe("canWrite permission", () => {
    it("should allow PTY writes for full access clients", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client), "full");

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe("full");
    });

  });

  describe("Access type from access_list authorization", () => {
    it("should always return full access for access_list authorization", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client), "view", "session-abc");

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe("full");
      expect(result.machineSession?.sessionId).toBeUndefined();
    });
  });
});

// ============================================================================
// Issue 3: Machine Takeover Prevention Tests
// ============================================================================

describe("Issue 3: Machine Takeover Prevention", () => {
  beforeEach(() => {
    clearAllRegistries();
  });

  it("should allow initial machine registration", () => {
    const machine = createTestIdentity("Machine");
    const mockWs = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id } })
    );

    const result = registerMachine(
      machine.id,
      "account-alice",
      Buffer.from(machine.signing.publicKey).toString("base64"),
      Buffer.from(machine.keyExchange.publicKey).toString("base64"),
      mockWs,
      "Alice's Machine"
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.registration.machineId).toBe(machine.id);
      expect(result.registration.ownerUserRootId).toBe("account-alice");
    }
  });

  it("should allow re-registration from same account with same keys", () => {
    const machine = createTestIdentity("Machine");
    const mockWs1 = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id, connectionId: "conn-1" } })
    );
    const mockWs2 = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id, connectionId: "conn-2" } })
    );

    const signingKey = Buffer.from(machine.signing.publicKey).toString("base64");
    const keyExchangeKey = Buffer.from(machine.keyExchange.publicKey).toString("base64");

    // First registration
    const result1 = registerMachine(
      machine.id,
      "account-alice",
      signingKey,
      keyExchangeKey,
      mockWs1
    );
    expect(result1.success).toBe(true);

    // Re-registration from same account with same keys
    const result2 = registerMachine(
      machine.id,
      "account-alice",
      signingKey,
      keyExchangeKey,
      mockWs2
    );
    expect(result2.success).toBe(true);
  });

  it("should reject re-registration from different owner", () => {
    const machine = createTestIdentity("Machine");
    const mockWs1 = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id, connectionId: "conn-1" } })
    );
    const mockWs2 = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id, connectionId: "conn-2" } })
    );

    const signingKey = Buffer.from(machine.signing.publicKey).toString("base64");
    const keyExchangeKey = Buffer.from(machine.keyExchange.publicKey).toString("base64");

    // First registration by Alice
    const result1 = registerMachine(
      machine.id,
      "account-alice",
      signingKey,
      keyExchangeKey,
      mockWs1
    );
    expect(result1.success).toBe(true);

    // Attacker Eve tries to hijack
    const result2 = registerMachine(
      machine.id,
      "account-eve", // Different account!
      signingKey,
      keyExchangeKey,
      mockWs2
    );

    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error).toContain("different owner");
    }
  });

  it("should reject re-registration with different signing key", () => {
    const machine = createTestIdentity("Machine");
    const attacker = createTestIdentity("Attacker");
    const mockWs1 = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id, connectionId: "conn-1" } })
    );
    const mockWs2 = asMockWs<ServerWebSocket<WebSocketData>>(
      createMockWebSocket({ data: { machineId: machine.id, connectionId: "conn-2" } })
    );

    const originalSigningKey = Buffer.from(machine.signing.publicKey).toString("base64");
    const originalKeyExchangeKey = Buffer.from(machine.keyExchange.publicKey).toString("base64");
    const attackerSigningKey = Buffer.from(attacker.signing.publicKey).toString("base64");

    // First registration
    const result1 = registerMachine(
      machine.id,
      "account-alice",
      originalSigningKey,
      originalKeyExchangeKey,
      mockWs1
    );
    expect(result1.success).toBe(true);

    // Same account but different signing key (key substitution attack)
    const result2 = registerMachine(
      machine.id,
      "account-alice", // Same account
      attackerSigningKey, // Different key!
      originalKeyExchangeKey,
      mockWs2
    );

    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error).toContain("Signing key mismatch");
    }
  });
});
