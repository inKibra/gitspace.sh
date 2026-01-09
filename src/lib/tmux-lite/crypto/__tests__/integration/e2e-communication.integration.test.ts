/**
 * Integration tests for end-to-end encrypted communication
 *
 * Tests frame encryption/decryption after handshake establishment.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createClientHello,
  processServerHello,
  createClientAuth,
} from "../../handshake.js";
import {
  HandshakeHandler,
  type EstablishedSession,
} from "../../../handshake-handler.js";
import { AccessControlList } from "../../access-control.js";
import { createFrame, openFrame, MASTER_STREAM_ID } from "../../index.js";
import {
  createTestIdentityPair,
  toPublicIdentity,
  createIdentityFixtures,
} from "../helpers/test-identities.js";
import { runCompleteHandshake, verifyKeyPairing } from "../helpers/handshake-runner.js";
import type { X3DHResponseMessage, SessionKeys } from "../../../../../types/identity.js";

describe("E2E Communication Integration", () => {
  describe("frame encryption after handshake", () => {
    it("should encrypt and decrypt frames with session keys", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Client encrypts with sendKey
      const message = Buffer.from("Hello, machine!");
      const encrypted = createFrame(
        MASTER_STREAM_ID,
        message,
        Buffer.from(clientKeys.sendKey)
      );

      // Machine decrypts with receiveKey (which equals client's sendKey)
      const decrypted = openFrame(encrypted, Buffer.from(machineKeys.receiveKey));

      expect(decrypted).not.toBeNull();
      expect(decrypted!.streamId).toBe(MASTER_STREAM_ID);
      expect(decrypted!.data.toString()).toBe("Hello, machine!");
    });

    it("should handle bidirectional communication", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Client -> Machine
      const clientMsg = Buffer.from("Request from client");
      const encryptedReq = createFrame(
        MASTER_STREAM_ID,
        clientMsg,
        Buffer.from(clientKeys.sendKey)
      );
      const decryptedReq = openFrame(
        encryptedReq,
        Buffer.from(machineKeys.receiveKey)
      );

      expect(decryptedReq?.data.toString()).toBe("Request from client");

      // Machine -> Client
      const machineMsg = Buffer.from("Response from machine");
      const encryptedRes = createFrame(
        MASTER_STREAM_ID,
        machineMsg,
        Buffer.from(machineKeys.sendKey)
      );
      const decryptedRes = openFrame(
        encryptedRes,
        Buffer.from(clientKeys.receiveKey)
      );

      expect(decryptedRes?.data.toString()).toBe("Response from machine");
    });

    it("should fail to decrypt with wrong key", async () => {
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
      const clientKeys = result.clientKeys!;

      // Encrypt with sendKey
      const message = Buffer.from("Secret message");
      const encrypted = createFrame(
        MASTER_STREAM_ID,
        message,
        Buffer.from(clientKeys.sendKey)
      );

      // Try to decrypt with wrong key (receiveKey instead of sendKey)
      const wrongDecrypt = openFrame(
        encrypted,
        Buffer.from(clientKeys.receiveKey)
      );

      expect(wrongDecrypt).toBeNull();
    });

    it("should fail to decrypt with random key", async () => {
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
      const clientKeys = result.clientKeys!;

      // Encrypt normally
      const message = Buffer.from("Secret message");
      const encrypted = createFrame(
        MASTER_STREAM_ID,
        message,
        Buffer.from(clientKeys.sendKey)
      );

      // Try to decrypt with random key
      const randomKey = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        randomKey[i] = Math.floor(Math.random() * 256);
      }

      const wrongDecrypt = openFrame(encrypted, randomKey);
      expect(wrongDecrypt).toBeNull();
    });
  });

  describe("stream IDs", () => {
    it("should handle different stream IDs", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Send on different streams
      const stream0 = createFrame(0, Buffer.from("stream 0"), Buffer.from(clientKeys.sendKey));
      const stream1 = createFrame(1, Buffer.from("stream 1"), Buffer.from(clientKeys.sendKey));
      const stream255 = createFrame(255, Buffer.from("stream 255"), Buffer.from(clientKeys.sendKey));

      const dec0 = openFrame(stream0, Buffer.from(machineKeys.receiveKey));
      const dec1 = openFrame(stream1, Buffer.from(machineKeys.receiveKey));
      const dec255 = openFrame(stream255, Buffer.from(machineKeys.receiveKey));

      expect(dec0?.streamId).toBe(0);
      expect(dec0?.data.toString()).toBe("stream 0");

      expect(dec1?.streamId).toBe(1);
      expect(dec1?.data.toString()).toBe("stream 1");

      expect(dec255?.streamId).toBe(255);
      expect(dec255?.data.toString()).toBe("stream 255");
    });
  });

  describe("message integrity", () => {
    it("should detect tampered ciphertext", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Encrypt a message
      const message = Buffer.from("Sensitive data");
      const encrypted = createFrame(
        MASTER_STREAM_ID,
        message,
        Buffer.from(clientKeys.sendKey)
      );

      // Tamper with the ciphertext
      const tampered = Buffer.from(encrypted);
      tampered[10] ^= 0xff; // Flip bits in the middle

      // Should fail authentication
      const decrypted = openFrame(tampered, Buffer.from(machineKeys.receiveKey));
      expect(decrypted).toBeNull();
    });

    it("should detect truncated message", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Encrypt a message
      const message = Buffer.from("Complete message");
      const encrypted = createFrame(
        MASTER_STREAM_ID,
        message,
        Buffer.from(clientKeys.sendKey)
      );

      // Truncate the message
      const truncated = encrypted.subarray(0, encrypted.length - 10);

      // Should fail
      const decrypted = openFrame(truncated, Buffer.from(machineKeys.receiveKey));
      expect(decrypted).toBeNull();
    });
  });

  describe("session isolation", () => {
    it("should not decrypt messages from different sessions", async () => {
      const fixtures = createIdentityFixtures();
      const accessList = new AccessControlList();
      accessList.addEntry(fixtures.alicePublic);
      accessList.addEntry(fixtures.bobPublic);

      // Alice's session
      const aliceResult = await runCompleteHandshake(
        fixtures.alice,
        fixtures.machine,
        accessList,
        { type: "access_list" }
      );

      // Bob's session
      const bobResult = await runCompleteHandshake(
        fixtures.bob,
        fixtures.machine,
        accessList,
        { type: "access_list" }
      );

      expect(aliceResult.success).toBe(true);
      expect(bobResult.success).toBe(true);

      const aliceKeys = aliceResult.clientKeys!;
      const bobKeys = bobResult.clientKeys!;

      // Alice encrypts a message
      const aliceMsg = Buffer.from("Alice's secret");
      const aliceEncrypted = createFrame(
        MASTER_STREAM_ID,
        aliceMsg,
        Buffer.from(aliceKeys.sendKey)
      );

      // Bob should NOT be able to decrypt Alice's message
      const bobAttempt = openFrame(
        aliceEncrypted,
        Buffer.from(bobKeys.receiveKey)
      );

      expect(bobAttempt).toBeNull();
    });

    it("should isolate keys between repeated handshakes", async () => {
      const { client, machine } = createTestIdentityPair();
      const accessList = new AccessControlList();
      accessList.addEntry(toPublicIdentity(client));

      // First session
      const result1 = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      // Second session
      const result2 = await runCompleteHandshake(
        client,
        machine,
        accessList,
        { type: "access_list" }
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      const keys1 = result1.clientKeys!;
      const keys2 = result2.clientKeys!;

      // Encrypt with first session's keys
      const message = Buffer.from("Session 1 message");
      const encrypted = createFrame(
        MASTER_STREAM_ID,
        message,
        Buffer.from(keys1.sendKey)
      );

      // Should NOT decrypt with second session's keys
      const wrongSession = openFrame(
        encrypted,
        Buffer.from(keys2.receiveKey)
      );

      expect(wrongSession).toBeNull();
    });
  });

  describe("large messages", () => {
    it("should handle large payloads", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Create a large message (64KB)
      const largeMessage = Buffer.alloc(64 * 1024);
      for (let i = 0; i < largeMessage.length; i++) {
        largeMessage[i] = i % 256;
      }

      const encrypted = createFrame(
        MASTER_STREAM_ID,
        largeMessage,
        Buffer.from(clientKeys.sendKey)
      );

      const decrypted = openFrame(
        encrypted,
        Buffer.from(machineKeys.receiveKey)
      );

      expect(decrypted).not.toBeNull();
      expect(decrypted!.data.length).toBe(largeMessage.length);
      expect(Buffer.compare(decrypted!.data, largeMessage)).toBe(0);
    });

    it("should handle empty messages", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Empty message
      const emptyMessage = Buffer.alloc(0);

      const encrypted = createFrame(
        MASTER_STREAM_ID,
        emptyMessage,
        Buffer.from(clientKeys.sendKey)
      );

      const decrypted = openFrame(
        encrypted,
        Buffer.from(machineKeys.receiveKey)
      );

      expect(decrypted).not.toBeNull();
      expect(decrypted!.data.length).toBe(0);
    });
  });

  describe("multiple messages", () => {
    it("should handle many messages in sequence", async () => {
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
      const clientKeys = result.clientKeys!;
      const machineKeys = result.machineSession!.sessionKeys;

      // Send 100 messages
      for (let i = 0; i < 100; i++) {
        const message = Buffer.from(`Message ${i}`);
        const encrypted = createFrame(
          MASTER_STREAM_ID,
          message,
          Buffer.from(clientKeys.sendKey)
        );

        const decrypted = openFrame(
          encrypted,
          Buffer.from(machineKeys.receiveKey)
        );

        expect(decrypted).not.toBeNull();
        expect(decrypted!.data.toString()).toBe(`Message ${i}`);
      }
    });
  });
});
