/**
 * Integration tests for authorization scenarios
 *
 * Tests user-root ACL authorization during handshake.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  HandshakeHandler,
  type HandshakeMessage,
} from "../../../handshake-handler.js";
import { AccessControlList } from "../../access-control.js";
import {
  createTestIdentityPair,
  createTestIdentity,
  toPublicIdentity,
  createIdentityFixtures,
} from "../helpers/test-identities.js";
import { runCompleteHandshake } from "../helpers/handshake-runner.js";

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

    it("should reject client not authorized by user-root ACL", async () => {
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
      expect(result.error).toContain("owner user root");
    });

    it("should always grant full access for access_list authorization", async () => {
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

    it("should reject when access list entry is expired", async () => {
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
      expect(result.error).toContain("owner user root");
    });
  });

  describe("multiple clients", () => {
    it("should allow multiple clients with different access types", async () => {
      const fixtures = createIdentityFixtures();
      const accessList = new AccessControlList();

      // Alice gets full access
      accessList.addEntry(fixtures.alicePublic, 'full');

      // Bob gets view
      accessList.addEntry(fixtures.bobPublic, 'view', 'test-session');

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
      expect(bobResult.machineSession?.accessType).toBe('full');
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
    const accessTypeCombinations: Array<{ accessType: 'full' | 'view'; sessionId?: string }> = [
      { accessType: 'full' },
      { accessType: 'view', sessionId: 'session-1' },
      { accessType: 'view', sessionId: 'session-2' },
    ];

    for (const config of accessTypeCombinations) {
      it(`should grant full access for ACL entry variant: ${config.accessType}${config.sessionId ? ` with sessionId=${config.sessionId}` : ''}`, async () => {
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
        expect(result.machineSession?.accessType).toBe('full');
      });
    }
  });
});
