/**
 * Integration tests for authorization scenarios
 *
 * Tests access list and invite token authorization during handshake.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  HandshakeHandler,
  type HandshakeMessage,
} from "../../../handshake-handler.js";
import { AccessControlList } from "../../access-control.js";
import { createInviteToken, isInviteExpired } from "../../invites.js";
import {
  createTestIdentityPair,
  createTestIdentity,
  toPublicIdentity,
  createIdentityFixtures,
} from "../helpers/test-identities.js";
import { runCompleteHandshake } from "../helpers/handshake-runner.js";
import type { X3DHResponseMessage, X3DHResultMessage } from "../../../../../types/identity.js";
import {
  isReplyResult,
  getReplyData,
} from "../../../../../__tests__/test-utils.js";

describe("Authorization Integration", () => {
  describe("access list authorization", () => {
    it("should accept client in access list", async () => {
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

    it("should reject client not in access list", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      // Client NOT added to access list

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not in access list");
    });

    it("should respect session-invite access type", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client), 'session-invite', 'test-session');

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe('session-invite');
    });

    it("should respect full access type", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client), 'full');

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe('full');
    });

    it("should reject with expired access entry", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      // Add with expiry in the past
      const entry = accessList.addEntry(toPublicIdentity(client));
      // Manually set expiry to past
      const entries = accessList.export();
      entries[0].expiresAt = Date.now() - 1000;
      accessList.import(entries);

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not in access list");
    });
  });

  describe("invite token authorization", () => {
    it("should accept valid invite token", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        {
          type: "invite",
          accessType: 'full',
        }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.peerIdentityId).toBe(client.id);
    });

    it("should use access type from invite token", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        {
          type: "invite",
          accessType: 'session-invite',
          sessionId: 'test-session',
        }
      );

      expect(result.success).toBe(true);
      expect(result.machineSession?.accessType).toBe('session-invite');
    });

    it("should add client to access list after invite acceptance", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      expect(accessList.hasAccess(client.id)).toBe(false);

      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        {
          type: "invite",
          accessType: 'full',
        }
      );

      expect(result.success).toBe(true);

      // Client should now be in access list
      expect(accessList.hasAccess(client.id)).toBe(true);
    });

    it("should reject expired invite token", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      // Create an already-expired token
      const result = await runCompleteHandshake(
        client,
        machine,
        accessList,
        {
          type: "invite",
          accessType: 'full',
          validityMs: -1000, // Expired 1 second ago
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("expired");
    });

    it("should reject invite token from different machine", async () => {
      const { client, machine } = createTestIdentityPair();
      const otherMachine = createTestIdentity("Other Machine");
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Create invite from a different machine
      const wrongToken = createInviteToken(otherMachine, "wss://test.relay", {
        accessType: 'full',
      });

      // Start handshake
      const { createClientHello, processServerHello, createClientAuth } =
        await import("../../handshake.js");

      const { state: state1, message: clientHello } = createClientHello();

      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      expect(result1.type).toBe("reply");
      if (!isReplyResult(result1)) throw new Error("Expected reply");
      const serverHello = getReplyData<X3DHResponseMessage>(result1);

      const state2 = processServerHello(state1, serverHello);
      expect(state2).not.toBeNull();

      const { message: clientAuth } = createClientAuth(state2!, client, {
        type: "invite",
        inviteToken: wrongToken,
      });

      const result2 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_auth",
        data: clientAuth,
      });

      // Should return a reply with rejection (not an error)
      // The ServerAuth message contains the rejection reason
      expect(result2.type).toBe("reply");
      if (isReplyResult(result2)) {
        const serverAuth = getReplyData<X3DHResultMessage>(result2);
        expect(serverAuth.result.type).toBe("rejected");
        if (serverAuth.result.type === "rejected") {
          expect(serverAuth.result.reason).toContain("not issued by this machine");
        }
      }
    });
  });

  describe("multiple clients", () => {
    it("should allow multiple clients with different access types", async () => {
      const fixtures = createIdentityFixtures();
      const accessList = new AccessControlList();

      // Alice gets full access
      accessList.addEntry(fixtures.alicePublic, 'full');

      // Bob gets session-invite
      accessList.addEntry(fixtures.bobPublic, 'session-invite', 'test-session');

      const [aliceResult, bobResult] = await Promise.all([
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

      expect(aliceResult.success).toBe(true);
      expect(aliceResult.machineSession?.accessType).toBe('full');

      expect(bobResult.success).toBe(true);
      expect(bobResult.machineSession?.accessType).toBe('session-invite');
    });

    it("should accept authorized and reject unauthorized simultaneously", async () => {
      const fixtures = createIdentityFixtures();
      const accessList = new AccessControlList();

      // Only Alice is authorized
      accessList.addEntry(fixtures.alicePublic);

      const [aliceResult, untrustedResult] = await Promise.all([
        runCompleteHandshake(
          fixtures.alice,
          fixtures.machine,
          accessList,
          { type: "access_list" }
        ),
        runCompleteHandshake(
          fixtures.untrusted,
          fixtures.machine,
          accessList,
          { type: "access_list" }
        ),
      ]);

      expect(aliceResult.success).toBe(true);
      expect(untrustedResult.success).toBe(false);
    });
  });

  describe("access type combinations", () => {
    const accessTypeCombinations: Array<{ accessType: 'full' | 'session-invite'; sessionId?: string }> = [
      { accessType: 'full' },
      { accessType: 'session-invite', sessionId: 'session-1' },
      { accessType: 'session-invite', sessionId: 'session-2' },
    ];

    for (const config of accessTypeCombinations) {
      it(`should correctly grant access type: ${config.accessType}${config.sessionId ? ` with sessionId=${config.sessionId}` : ''}`, async () => {
        const { client, machine } = createTestIdentityPair();
        const accessList = new AccessControlList();
        accessList.addEntry(toPublicIdentity(client), config.accessType, config.sessionId);

        const result = await runCompleteHandshake(
          client,
          machine,
          accessList,
          { type: "access_list" }
        );

        expect(result.success).toBe(true);
        expect(result.machineSession?.accessType).toBe(config.accessType);
      });
    }
  });
});
