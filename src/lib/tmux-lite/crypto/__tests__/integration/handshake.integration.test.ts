/**
 * Integration tests for X3DH handshake flow
 *
 * Tests the complete 4-message handshake exchange between client and machine.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processServerAuth,
} from "../../handshake.js";
import {
  HandshakeHandler,
  type HandshakeMessage,
} from "../../../handshake-handler.js";
import { AccessControlList } from "../../access-control.js";
import { createDeviceCertificate } from "../../device-cert.js";
import { generateMnemonic, mnemonicToUserIdentity } from "../../user-identity.js";
import {
  createTestIdentityPair,
  toPublicIdentity,
  createIdentityFixtures,
} from "../helpers/test-identities.js";
import {
  runCompleteHandshake,
  verifyKeyPairing,
  verifyKeysUnique,
} from "../helpers/handshake-runner.js";
import type {
  X3DHResponseMessage,
  X3DHResultMessage,
} from "../../../../../types/identity.js";

function buildDeviceCertificateFor(
  identity: import("../../../../../types/identity.js").Identity,
  userRoot: ReturnType<typeof mnemonicToUserIdentity>,
): string {
  const cert = createDeviceCertificate(
    userRoot,
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
  );
  return JSON.stringify(cert);
}

describe("X3DH Handshake Integration", () => {
  describe("complete 4-message exchange", () => {
    it("should complete handshake with access list authorization", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      // Add client to access list with full access
      accessList.addEntry(toPublicIdentity(client), 'full');

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.clientKeys).toBeDefined();
      expect(result.machineSession).toBeDefined();
      expect(result.messageCount).toBe(4);
    });

    it("should derive matching session keys for both parties", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.clientKeys).toBeDefined();
      expect(result.machineSession).toBeDefined();

      // Verify keys are correctly paired
      const paired = verifyKeyPairing(
        result.clientKeys!,
        result.machineSession!.sessionKeys
      );
      expect(paired).toBe(true);
    });

    it("should generate unique keys for each session (forward secrecy)", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      // Run multiple handshakes
      const results = await Promise.all([
        runCompleteHandshake(client, machine, accessList, { type: "access_list" }),
        runCompleteHandshake(client, machine, accessList, { type: "access_list" }),
        runCompleteHandshake(client, machine, accessList, { type: "access_list" }),
      ]);

      // All should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
      }

      // All keys should be unique
      const clientKeysSets = results.map((r) => r.clientKeys!);
      expect(verifyKeysUnique(clientKeysSets)).toBe(true);
    });
  });

  describe("step-by-step handshake", () => {
    it("should complete ClientHello -> ServerHello exchange", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      const handler = new HandshakeHandler({
        identity: machine,
      });

      // Client creates ClientHello
      const { state: clientState, message: clientHello } = createClientHello(
        machine.id
      );

      expect(clientState.phase).toBe("awaiting_server_hello");
      expect(clientHello.version).toBe(1);
      expect(clientHello.ephemeralKey).toBeDefined();

      // Machine processes ClientHello
      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      expect(result.type).toBe("reply");
      if (result.type === "reply") {
        expect(result.message.phase).toBe("server_hello");

        const serverHello = result.message.data as X3DHResponseMessage;
        expect(serverHello.version).toBe(1);
        expect(serverHello.identityKey).toBeDefined();
        expect(serverHello.ephemeralKey).toBeDefined();
        expect(serverHello.signedPreKey).toBeDefined();
        expect(serverHello.preKeySignature).toBeDefined();
        expect(serverHello.serverNonce).toBeDefined();
      }
    });

    it("should complete full manual handshake", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));
      const ownerRoot = mnemonicToUserIdentity(generateMnemonic());
      const ownerUserRootId = ownerRoot.id;

      const handler = new HandshakeHandler({
        identity: machine,
        ownerUserRootId,
      });

      // Step 1: Client creates ClientHello
      const { state: clientState1, message: clientHello } = createClientHello();

      // Step 2: Machine processes ClientHello, returns ServerHello
      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      expect(result1.type).toBe("reply");
      const serverHello = (result1 as { type: "reply"; message: HandshakeMessage })
        .message.data as X3DHResponseMessage;

      // Step 3: Client processes ServerHello
      const clientState2 = processServerHello(clientState1, serverHello);
      expect(clientState2).not.toBeNull();
      expect(clientState2!.phase).toBe("awaiting_server_auth");

      // Step 4: Client creates ClientAuth
      const { message: clientAuth, sessionKeys: clientSessionKeys } = createClientAuth(
        clientState2!,
        client,
        { type: "access_list" },
        buildDeviceCertificateFor(client, ownerRoot),
      );

      // Step 5: Machine processes ClientAuth
      const result2 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_auth",
        data: clientAuth,
      });

      // Should get established session
      expect(result2.type).toBe("established");
      if (result2.type === "established") {
        expect(result2.session.peerIdentityId).toBe(client.id);
        expect(result2.session.accessType).toBe('full');

        // Verify keys are paired
        const paired = verifyKeyPairing(
          clientSessionKeys,
          result2.session.sessionKeys
        );
        expect(paired).toBe(true);
      }
    });
  });

  describe("session information", () => {
    it("should include correct peer identity ID", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.peerIdentityId).toBe(client.id);
    });

    it("should include full access type for access_list authorization", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client), 'view', 'test-session');

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe('full');
    });

    it("should have valid session timestamps", async () => {
      const before = Date.now();

      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      const after = Date.now();

      expect(result.success).toBe(true);
      expect(result.machineSession?.establishedAt).toBeGreaterThanOrEqual(before);
      expect(result.machineSession?.establishedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("concurrent handshakes", () => {
    it("should handle multiple concurrent connections", async () => {
      const fixtures = createIdentityFixtures();
      const accessList = new AccessControlList();
      accessList.addEntry(fixtures.alicePublic);
      accessList.addEntry(fixtures.bobPublic);

      // Run concurrent handshakes with different clients
      const [result1, result2] = await Promise.all([
        runCompleteHandshake(
          fixtures.alice,
          fixtures.machine,
          accessList,
          { type: "access_list" }
        ),
        runCompleteHandshake(
          fixtures.bob,
          fixtures.machine,
          accessList,
          { type: "access_list" }
        ),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Sessions should have different peer IDs
      expect(result1.machineSession?.peerIdentityId).toBe(fixtures.alice.id);
      expect(result2.machineSession?.peerIdentityId).toBe(fixtures.bob.id);

      // Keys should be unique
      expect(
        verifyKeysUnique([result1.clientKeys!, result2.clientKeys!])
      ).toBe(true);
    });

    it("should isolate handshake state per connection", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const handler = new HandshakeHandler({
        identity: machine,
      });

      // Start two handshakes
      const { message: clientHello1 } = createClientHello();
      const { message: clientHello2 } = createClientHello();

      // Process both ClientHellos
      await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello1,
      });

      await handler.processMessage("conn-2", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello2,
      });

      // Both connections should have active handshakes
      expect(handler.hasActiveHandshake("conn-1")).toBe(true);
      expect(handler.hasActiveHandshake("conn-2")).toBe(true);
      expect(handler.activeHandshakes).toBe(2);

      // Cleanup one connection
      handler.cleanup("conn-1");

      expect(handler.hasActiveHandshake("conn-1")).toBe(false);
      expect(handler.hasActiveHandshake("conn-2")).toBe(true);
      expect(handler.activeHandshakes).toBe(1);
    });
  });
});
