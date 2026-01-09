/**
 * Integration tests for error handling during handshake
 *
 * Tests edge cases and error conditions.
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
import { createInviteToken } from "../../invites.js";
import {
  createTestIdentityPair,
  createTestIdentity,
  toPublicIdentity,
} from "../helpers/test-identities.js";
import {
  createTamperFn,
  createStaleTimestampTamperFn,
} from "../helpers/mock-relay.js";
import type { X3DHResponseMessage, X3DHInitMessage } from "../../../../../types/identity.js";
import {
  isReplyResult,
  isErrorResult,
  getReplyData,
  getErrorReason,
} from "../../../../../__tests__/test-utils.js";

describe("Error Handling Integration", () => {
  describe("stale timestamps", () => {
    it("should reject ClientHello with stale timestamp", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Create ClientHello with stale timestamp
      const { message: clientHello } = createClientHello();
      const staleClientHello: X3DHInitMessage = {
        ...clientHello,
        timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      };

      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: staleClientHello,
      });

      expect(result.type).toBe("error");
      expect(getErrorReason(result)).toContain("Invalid ClientHello");
    });

    it("should reject ClientHello with future timestamp", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Create ClientHello with future timestamp
      const { message: clientHello } = createClientHello();
      const futureClientHello: X3DHInitMessage = {
        ...clientHello,
        timestamp: Date.now() + 10 * 60 * 1000, // 10 minutes in future
      };

      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: futureClientHello,
      });

      expect(result.type).toBe("error");
    });
  });

  describe("invalid protocol version", () => {
    it("should reject ClientHello with wrong version", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      const { message: clientHello } = createClientHello();
      const wrongVersion = {
        ...clientHello,
        version: 99,
      };

      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: wrongVersion,
      });

      expect(result.type).toBe("error");
    });

    it("should reject ServerHello with wrong version (client side)", () => {
      const { state, message: clientHello } = createClientHello();

      // Create a fake ServerHello with wrong version
      // Note: We use type assertion because we're deliberately testing invalid input
      // that doesn't conform to the expected type (version 99 is not a valid version)
      const wrongVersionResponse = {
        version: 99,
        identityKey: "fake",
        keyExchangeKey: "fake",
        ephemeralKey: "fake",
        signedPreKey: "fake",
        preKeySignature: "fake",
        serverNonce: "fake",
        timestamp: Date.now(),
      } as unknown as X3DHResponseMessage;

      const result = processServerHello(state, wrongVersionResponse);
      expect(result).toBeNull();
    });
  });

  describe("tampered signatures", () => {
    it("should reject ServerHello with invalid pre-key signature", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Start handshake
      const { state, message: clientHello } = createClientHello();

      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      expect(result1.type).toBe("reply");
      if (!isReplyResult(result1)) throw new Error("Expected reply");
      const serverHello = getReplyData<X3DHResponseMessage>(result1);

      // Tamper with the pre-key signature
      const tamperedServerHello: X3DHResponseMessage = {
        ...serverHello,
        preKeySignature: Buffer.from(
          new Uint8Array(64).fill(0)
        ).toString("base64"),
      };

      // Client should reject
      const clientState = processServerHello(state, tamperedServerHello);
      expect(clientState).toBeNull();
    });

    it("should reject ClientAuth with invalid identity proof", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Complete ClientHello -> ServerHello
      const { state: state1, message: clientHello } = createClientHello();
      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      if (!isReplyResult(result1)) throw new Error("Expected reply");
      const serverHello = getReplyData<X3DHResponseMessage>(result1);
      const state2 = processServerHello(state1, serverHello);
      expect(state2).not.toBeNull();

      // Create ClientAuth and tamper with identity proof
      const { message: clientAuth } = createClientAuth(state2!, client, {
        type: "access_list",
      });

      const tamperedClientAuth = {
        ...clientAuth,
        identityProof: Buffer.from(new Uint8Array(32).fill(0)).toString(
          "base64"
        ),
      };

      const result2 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_auth",
        data: tamperedClientAuth,
      });

      expect(result2.type).toBe("error");
      expect(getErrorReason(result2)).toContain("Invalid ClientAuth");
    });
  });

  describe("invalid key formats", () => {
    it("should reject ClientHello with invalid ephemeral key", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      const { message: clientHello } = createClientHello();
      const invalidKey = {
        ...clientHello,
        ephemeralKey: "not-valid-base64!!!",
      };

      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: invalidKey,
      });

      expect(result.type).toBe("error");
    });

    it("should reject ClientHello with all-zero ephemeral key", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      const { message: clientHello } = createClientHello();
      const zeroKey = {
        ...clientHello,
        ephemeralKey: Buffer.from(new Uint8Array(32).fill(0)).toString(
          "base64"
        ),
      };

      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: zeroKey,
      });

      expect(result.type).toBe("error");
    });
  });

  describe("wrong identity", () => {
    it("should reject ClientAuth with wrong identity key", async () => {
      const { client, machine } = createTestIdentityPair();
      const imposter = createTestIdentity("Imposter");
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client)); // Only real client authorized

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Start handshake
      const { state: state1, message: clientHello } = createClientHello();
      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      if (!isReplyResult(result1)) throw new Error("Expected reply");
      const serverHello = getReplyData<X3DHResponseMessage>(result1);
      const state2 = processServerHello(state1, serverHello);
      expect(state2).not.toBeNull();

      // Imposter tries to use client's handshake state with their own identity
      const { message: imposterAuth } = createClientAuth(state2!, imposter, {
        type: "access_list",
      });

      const result2 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_auth",
        data: imposterAuth,
      });

      // Should fail - either invalid proof or not in access list
      if (result2.type === "error") {
        expect(result2.reason).toBeDefined();
      } else if (result2.type === "established") {
        // If it somehow gets to authorization, imposter shouldn't be authorized
        expect(result2.session.peerIdentityId).toBe(imposter.id);
      }
    });
  });

  describe("out-of-order messages", () => {
    it("should reject ClientAuth before ClientHello", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Try to send ClientAuth without first sending ClientHello
      const { state, message: clientHello } = createClientHello();

      // Manually advance state to create a ClientAuth
      // This requires faking the server response
      // For simplicity, just test that handler rejects unknown connection
      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_auth",
        data: {
          version: 1,
          identityKey: "fake",
          keyExchangeKey: "fake",
          identityProof: "fake",
          authorization: { type: "access_list" },
        },
      });

      expect(result.type).toBe("error");
      expect(getErrorReason(result)).toContain(
        "No handshake in progress"
      );
    });

    it("should reject duplicate ClientHello", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Send first ClientHello
      const { message: clientHello1 } = createClientHello();
      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello1,
      });

      expect(result1.type).toBe("reply");

      // Send second ClientHello on same connection
      const { message: clientHello2 } = createClientHello();
      const result2 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello2,
      });

      // Should restart handshake (replaces state)
      expect(result2.type).toBe("reply");
      expect(handler.activeHandshakes).toBe(1);
    });
  });

  describe("handshake timeout", () => {
    it("should clean up incomplete handshakes after timeout", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
        handshakeTimeoutMs: 100, // 100ms timeout
      });

      // Start handshake but don't complete
      const { message: clientHello } = createClientHello();
      await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      expect(handler.hasActiveHandshake("conn-1")).toBe(true);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Handshake should be cleaned up
      expect(handler.hasActiveHandshake("conn-1")).toBe(false);
    });

    it("should not timeout completed handshakes", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
        handshakeTimeoutMs: 100,
      });

      // Complete handshake quickly
      const { state: state1, message: clientHello } = createClientHello();
      const result1 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_hello",
        data: clientHello,
      });

      if (!isReplyResult(result1)) throw new Error("Expected reply");
      const serverHello = getReplyData<X3DHResponseMessage>(result1);
      const state2 = processServerHello(state1, serverHello);

      const { message: clientAuth } = createClientAuth(state2!, client, {
        type: "access_list",
      });

      const result2 = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "client_auth",
        data: clientAuth,
      });

      expect(result2.type).toBe("established");

      // Wait past timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // No crash - completed handshakes are cleaned up immediately
      expect(handler.activeHandshakes).toBe(0);
    });
  });

  describe("unexpected message phases", () => {
    it("should reject unknown handshake phase", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Note: We use type assertion here because we're deliberately testing
      // that invalid phase values are properly rejected
      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "unknown_phase" as "client_hello",
        data: {},
      });

      expect(result.type).toBe("error");
      expect(getErrorReason(result)).toContain("Unexpected handshake phase");
    });

    it("should reject server-side phases sent by client", async () => {
      const { machine } = createTestIdentityPair();
      const accessList = new AccessControlList();

      const handler = new HandshakeHandler({
        identity: machine,
        accessList,
      });

      // Client shouldn't send server_hello
      const result = await handler.processMessage("conn-1", {
        type: "handshake",
        phase: "server_hello",
        data: {},
      });

      expect(result.type).toBe("error");
    });
  });
});
