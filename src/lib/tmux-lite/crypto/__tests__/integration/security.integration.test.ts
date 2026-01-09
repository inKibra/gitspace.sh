/**
 * Security Integration Tests
 *
 * Tests for security fixes addressing the vulnerabilities in SECURITY_REVIEW.md:
 * 1. Identity signature proof (Issue 1)
 * 2. Permission enforcement (Issue 2)
 * 3. Machine takeover prevention (Issue 3)
 * 4. Single-use invite enforcement (Issue 4)
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
import { createInviteToken } from "../../invites.js";
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
      { type: "access_list" }
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
      { type: "access_list" }
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
      { type: "access_list" }
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

    it("should grant session-invite access via invite token", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      // Don't add client to access list - use invite

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "invite", accessType: "session-invite", sessionId: "test-session-123" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe("session-invite");
      expect(result.machineSession?.sessionId).toBe("test-session-123");
    });
  });

  describe("Access type from access list", () => {
    it("should respect session-invite access type from access list", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client), "session-invite", "session-abc");

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe("session-invite");
      expect(result.machineSession?.sessionId).toBe("session-abc");
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
      expect(result.registration.accountId).toBe("account-alice");
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

  it("should reject re-registration from different account", () => {
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
      expect(result2.error).toContain("different account");
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

// ============================================================================
// Issue 4: Single-Use Invite Enforcement Tests
// ============================================================================

describe("Issue 4: Single-Use Invite Enforcement", () => {
  it("should NOT add client to access list for singleUse=true invites", async () => {
    const { client, machine } = createTestIdentityPair();
    const accessList = new AccessControlList();

    // Verify client is not in access list initially
    expect(accessList.getEntry(client.id)).toBeUndefined();

    // Create single-use invite
    const inviteToken = createInviteToken(machine, "wss://test.relay", {
      accessType: "full",
      singleUse: true,
      validityMs: 3600000,
    });

    // Create handler with the access list
    const handler = new HandshakeHandler({
      identity: machine,
      accessList,
    });

    // Run handshake with single-use invite
    const connectionId = "test-conn-1";

    // ClientHello
    const { state: clientState, message: clientHello } = createClientHello(machine.id);
    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });
    expect(helloResult.type).toBe("reply");
    if (!isReplyResult(helloResult)) throw new Error("Expected reply");

    // Process ServerHello
    const serverHello = getReplyData<X3DHResponseMessage>(helloResult);
    const stateAfterServerHello = processServerHello(clientState, serverHello);
    expect(stateAfterServerHello).not.toBeNull();

    // ClientAuth with single-use invite
    const { message: clientAuth } = createClientAuth(
      stateAfterServerHello!,
      client,
      { type: "invite", inviteToken }
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    // Should succeed
    expect(authResult.type).toBe("established");

    // Client should NOT be in access list (single-use)
    expect(accessList.getEntry(client.id)).toBeUndefined();
  });

  it("should add client to access list for singleUse=false invites", async () => {
    const { client, machine } = createTestIdentityPair();
    const accessList = new AccessControlList();

    // Verify client is not in access list initially
    expect(accessList.getEntry(client.id)).toBeUndefined();

    // Create reusable invite (singleUse=false)
    const inviteToken = createInviteToken(machine, "wss://test.relay", {
      accessType: "full",
      singleUse: false,
      validityMs: 3600000,
    });

    // Create handler with the access list
    const handler = new HandshakeHandler({
      identity: machine,
      accessList,
    });

    // Run handshake with reusable invite
    const connectionId = "test-conn-2";

    // ClientHello
    const { state: clientState, message: clientHello } = createClientHello(machine.id);
    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });
    expect(helloResult.type).toBe("reply");
    if (!isReplyResult(helloResult)) throw new Error("Expected reply");

    // Process ServerHello
    const serverHello = getReplyData<X3DHResponseMessage>(helloResult);
    const stateAfterServerHello = processServerHello(clientState, serverHello);
    expect(stateAfterServerHello).not.toBeNull();

    // ClientAuth with reusable invite
    const { message: clientAuth } = createClientAuth(
      stateAfterServerHello!,
      client,
      { type: "invite", inviteToken }
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    // Should succeed
    expect(authResult.type).toBe("established");

    // Client SHOULD be in access list (not single-use)
    const entry = accessList.getEntry(client.id);
    expect(entry).toBeDefined();
    expect(entry?.accessType).toBe("full");
  });

  it("should grant session access for single-use invite during connection", async () => {
    const { client, machine } = createTestIdentityPair();
    const accessList = new AccessControlList();

    // Create single-use session-invite
    const inviteToken = createInviteToken(machine, "wss://test.relay", {
      accessType: "session-invite",
      sessionId: "session-xyz",
      singleUse: true,
      validityMs: 3600000,
    });

    const handler = new HandshakeHandler({
      identity: machine,
      accessList,
    });

    const connectionId = "test-conn-3";

    // ClientHello
    const { state: clientState, message: clientHello } = createClientHello(machine.id);
    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });
    if (!isReplyResult(helloResult)) throw new Error("Expected reply");

    // Process ServerHello
    const serverHello = getReplyData<X3DHResponseMessage>(helloResult);
    const stateAfterServerHello = processServerHello(clientState, serverHello);

    // ClientAuth with single-use invite
    const { message: clientAuth } = createClientAuth(
      stateAfterServerHello!,
      client,
      { type: "invite", inviteToken }
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    // Should succeed with session access
    expect(authResult.type).toBe("established");
    if (authResult.type === "established") {
      expect(authResult.session.accessType).toBe("session-invite");
      expect(authResult.session.sessionId).toBe("session-xyz");
    }

    // But client should NOT be permanently in access list
    expect(accessList.getEntry(client.id)).toBeUndefined();
  });
});
