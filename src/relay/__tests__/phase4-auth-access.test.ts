/**
 * Phase 4: Auth + Access Control Tests
 *
 * Tests:
 * 1. Protocol validation for new message types (unlock_relay, etc.)
 * 2. Device certificate verification in X3DH handshake processClientAuth
 * 3. User-root-keyed ACL fallback in HandshakeHandler
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { parseMessage } from "../protocol.js";
import {
  createServerState,
  processClientHello,
  createServerHello,
  processClientAuth,
  createClientHello,
  createClientAuth,
} from "../../lib/tmux-lite/crypto/handshake.js";
import {
  HandshakeHandler,
  type HandshakeMessage,
} from "../../lib/tmux-lite/handshake-handler.js";
import { AccessControlList } from "../../lib/tmux-lite/crypto/access-control.js";
import { createDeviceCertificate } from "../../lib/tmux-lite/crypto/device-cert.js";
import { generateMnemonic, mnemonicToUserIdentity } from "../../lib/tmux-lite/crypto/user-identity.js";
import {
  createTestIdentityPair,
} from "../../lib/tmux-lite/crypto/__tests__/helpers/test-identities.js";
import type { X3DHAuthMessage, X3DHResponseMessage } from "../../types/identity.js";

// ============================================================================
// Protocol Validation Tests
// ============================================================================

describe("Protocol validation — Phase 4 messages", () => {
  describe("unlock_relay", () => {
    const validUnlockRelay = {
      type: "unlock_relay",
      userRootPublicKey: "dGVzdC1wdWJsaWMta2V5LWJhc2U2NC1lbmNvZGVk",
      proof: "dGVzdC1wcm9vZi1iYXNlNjQ=",
      signature: {
        sig: "dGVzdC1zaWduYXR1cmU=",
        pub: "dGVzdC1wdWJsaWMta2V5",
        ts: Date.now(),
      },
    };

    test("parses valid unlock_relay message", () => {
      const result = parseMessage(JSON.stringify(validUnlockRelay));
      expect(result).not.toBeNull();
      expect(result?.type).toBe("unlock_relay");
    });

    test("rejects missing userRootPublicKey", () => {
      const msg = { ...validUnlockRelay };
      delete (msg as any).userRootPublicKey;
      expect(parseMessage(JSON.stringify(msg))).toBeNull();
    });

    test("rejects missing proof", () => {
      const msg = { ...validUnlockRelay };
      delete (msg as any).proof;
      expect(parseMessage(JSON.stringify(msg))).toBeNull();
    });

    test("rejects missing signature", () => {
      const msg = { ...validUnlockRelay };
      delete (msg as any).signature;
      expect(parseMessage(JSON.stringify(msg))).toBeNull();
    });
  });


  describe("unlock_relay_result", () => {
    test("parses success result", () => {
      const result = parseMessage(JSON.stringify({
        type: "unlock_relay_result",
        success: true,
        machineCount: 3,
      }));
      expect(result).not.toBeNull();
      expect(result?.type).toBe("unlock_relay_result");
      expect((result as any).success).toBe(true);
      expect((result as any).machineCount).toBe(3);
    });

    test("parses failure result with error", () => {
      const result = parseMessage(JSON.stringify({
        type: "unlock_relay_result",
        success: false,
        error: "Not the vault owner",
      }));
      expect(result).not.toBeNull();
      expect((result as any).success).toBe(false);
      expect((result as any).error).toBe("Not the vault owner");
    });

    test("rejects missing success field", () => {
      expect(parseMessage(JSON.stringify({
        type: "unlock_relay_result",
        machineCount: 3,
      }))).toBeNull();
    });
  });

});

// ============================================================================
// Device Certificate in X3DH Handshake Tests
// ============================================================================

describe("Device certificate in processClientAuth", () => {
  test("rejects access_list handshake without device certificate", () => {
    const { client, machine } = createTestIdentityPair();

    // Run through handshake phases
    const { state: clientState, message: clientHello } = createClientHello();
    const serverState = createServerState(machine);
    const afterHello = processClientHello(serverState, clientHello)!;
    expect(afterHello).not.toBeNull();

    const { state: afterServerHello, message: serverHello } = createServerHello(afterHello, machine);
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );
    expect(clientAfterServerHello).not.toBeNull();

    expect(() => {
      createClientAuth(
        clientAfterServerHello!,
        client,
        { type: "access_list" },
        undefined as unknown as string,
      );
    }).toThrow("Device certificate required");
  });

  test("extracts userRootId from valid device certificate", () => {
    const { client, machine } = createTestIdentityPair();

    // Create a user root identity and device cert for the client
    const mnemonic = generateMnemonic();
    const userRoot = mnemonicToUserIdentity(mnemonic);
    const cert = createDeviceCertificate(
      userRoot,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    // Run through handshake phases
    const { state: clientState, message: clientHello } = createClientHello();
    const serverState = createServerState(machine);
    const afterHello = processClientHello(serverState, clientHello)!;
    const { state: afterServerHello, message: serverHello } = createServerHello(afterHello, machine);
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(cert)
    );

    const result = processClientAuth(afterServerHello, clientAuth, machine);
    expect(result).not.toBeNull();
    expect(result!.userRootId).toBeDefined();
    expect(typeof result!.userRootId).toBe("string");
    expect(result!.userRootId!.length).toBeGreaterThan(0);
  });

  test("rejects handshake with invalid device certificate signature", () => {
    const { client, machine } = createTestIdentityPair();

    // Create a cert signed by a DIFFERENT user root
    const mnemonic1 = generateMnemonic();
    const userRoot1 = mnemonicToUserIdentity(mnemonic1);
    const cert = createDeviceCertificate(
      userRoot1,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    // Tamper with the signature
    const tamperedCert = { ...cert, signature: "AAAA" + cert.signature.slice(4) };

    const { state: clientState, message: clientHello } = createClientHello();
    const serverState = createServerState(machine);
    const afterHello = processClientHello(serverState, clientHello)!;
    const { state: afterServerHello, message: serverHello } = createServerHello(afterHello, machine);
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(tamperedCert)
    );

    const result = processClientAuth(afterServerHello, clientAuth, machine);
    expect(result).toBeNull(); // Should reject
  });

  test("rejects handshake with cert for wrong device key", () => {
    const { client, machine } = createTestIdentityPair();
    const otherClient = require("../../lib/tmux-lite/crypto/__tests__/helpers/test-identities.js").createTestIdentity("Other");

    // Create a valid cert but for a DIFFERENT device
    const mnemonic = generateMnemonic();
    const userRoot = mnemonicToUserIdentity(mnemonic);
    const cert = createDeviceCertificate(
      userRoot,
      otherClient.signing.publicKey, // Wrong key!
      otherClient.keyExchange.publicKey,
    );

    const { state: clientState, message: clientHello } = createClientHello();
    const serverState = createServerState(machine);
    const afterHello = processClientHello(serverState, clientHello)!;
    const { state: afterServerHello, message: serverHello } = createServerHello(afterHello, machine);
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(cert)
    );

    const result = processClientAuth(afterServerHello, clientAuth, machine);
    expect(result).toBeNull(); // Cert device key doesn't match client identity
  });

  test("rejects handshake with expired device certificate", () => {
    const { client, machine } = createTestIdentityPair();

    const mnemonic = generateMnemonic();
    const userRoot = mnemonicToUserIdentity(mnemonic);
    const cert = createDeviceCertificate(
      userRoot,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    // Force expiry in the past
    const expiredCert = { ...cert, expiresAt: Date.now() - 1000 };
    // Re-sign is not needed because we're testing the expiry check happens before re-verification
    // Actually, we need a properly signed cert with expiresAt set in the past.
    // The verifyDeviceCertificate only checks the signature over (domain || keys || issuedAt),
    // expiresAt is not in the signature payload. So the modified cert is still "valid" signature-wise.

    const { state: clientState, message: clientHello } = createClientHello();
    const serverState = createServerState(machine);
    const afterHello = processClientHello(serverState, clientHello)!;
    const { state: afterServerHello, message: serverHello } = createServerHello(afterHello, machine);
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(expiredCert)
    );

    const result = processClientAuth(afterServerHello, clientAuth, machine);
    expect(result).toBeNull(); // Should reject expired cert
  });
});

// ============================================================================
// User-Root-Keyed ACL in HandshakeHandler Tests
// ============================================================================

describe("HandshakeHandler user-root-keyed ACL", () => {
  test("owner auto-accepted when userRootId matches ownerUserRootId", async () => {
    const { client, machine } = createTestIdentityPair();

    // Create user root identity and cert
    const mnemonic = generateMnemonic();
    const userRoot = mnemonicToUserIdentity(mnemonic);
    const cert = createDeviceCertificate(
      userRoot,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    // Derive the user root ID the same way the handshake would
    const { deriveIdentityId } = require("../../lib/tmux-lite/crypto/identity.js");
    const ownerUserRootId = deriveIdentityId(userRoot.signing.publicKey);

    const accessList = new AccessControlList();
    // Client is NOT in device ACL

    const handler = new HandshakeHandler({
      identity: machine,
      ownerUserRootId,
    });

    // Phase 1: ClientHello
    const { state: clientState, message: clientHello } = createClientHello();
    const connectionId = "test-conn-owner";

    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });
    expect(helloResult.type).toBe("reply");

    // Phase 2: process ServerHello on client side
    const serverHello = (helloResult as any).message.data as X3DHResponseMessage;
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );
    expect(clientAfterServerHello).not.toBeNull();

    // Phase 3: ClientAuth with device cert
    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(cert)
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    // Owner should be auto-accepted with full access
    expect(authResult.type).toBe("established");
    const session = (authResult as any).session;
    expect(session.accessType).toBe("full");
  });

  test("non-owner with user root in vault ACL is accepted", async () => {
    const { client, machine } = createTestIdentityPair();

    // Create user roots for owner and collaborator
    const ownerMnemonic = generateMnemonic();
    const ownerRoot = mnemonicToUserIdentity(ownerMnemonic);
    const collabMnemonic = generateMnemonic();
    const collabRoot = mnemonicToUserIdentity(collabMnemonic);

    // Cert for client, signed by collaborator root
    const cert = createDeviceCertificate(
      collabRoot,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    const { deriveIdentityId } = require("../../lib/tmux-lite/crypto/identity.js");
    const ownerUserRootId = deriveIdentityId(ownerRoot.signing.publicKey);
    const collabUserRootId = deriveIdentityId(collabRoot.signing.publicKey);

    const accessList = new AccessControlList();
    // Client is NOT in device ACL

    const handler = new HandshakeHandler({
      identity: machine,
      ownerUserRootId,
      checkUserRootAccess: async (owner, clientRoot) => {
        // Simulate vault access check — collab is granted
        return owner === ownerUserRootId && clientRoot === collabUserRootId;
      },
    });

    // Phase 1: ClientHello
    const { state: clientState, message: clientHello } = createClientHello();
    const connectionId = "test-conn-collab";

    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });
    expect(helloResult.type).toBe("reply");

    // Phase 2: ServerHello
    const serverHello = (helloResult as any).message.data as X3DHResponseMessage;
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    // Phase 3: ClientAuth with device cert
    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(cert)
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    expect(authResult.type).toBe("established");
    const session = (authResult as any).session;
    expect(session.accessType).toBe("full");
  });

  test("client rejected when not in device ACL and no device cert", async () => {
    const { client, machine } = createTestIdentityPair();

    const mnemonic = generateMnemonic();
    const ownerRoot = mnemonicToUserIdentity(mnemonic);
    const { deriveIdentityId } = require("../../lib/tmux-lite/crypto/identity.js");
    const ownerUserRootId = deriveIdentityId(ownerRoot.signing.publicKey);

    const accessList = new AccessControlList();

    const handler = new HandshakeHandler({
      identity: machine,
      ownerUserRootId,
      checkUserRootAccess: async () => true, // Would accept if cert present
    });

    const { state: clientState, message: clientHello } = createClientHello();
    const connectionId = "test-conn-no-cert";

    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });

    const serverHello = (helloResult as any).message.data as X3DHResponseMessage;
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    expect(() => {
      createClientAuth(
        clientAfterServerHello!,
        client,
        { type: "access_list" },
        undefined as unknown as string,
      );
    }).toThrow("Device certificate required");

    return;
  });

  test("client rejected when user root not in vault ACL", async () => {
    const { client, machine } = createTestIdentityPair();

    const ownerMnemonic = generateMnemonic();
    const ownerRoot = mnemonicToUserIdentity(ownerMnemonic);
    const unknownMnemonic = generateMnemonic();
    const unknownRoot = mnemonicToUserIdentity(unknownMnemonic);

    const cert = createDeviceCertificate(
      unknownRoot,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    const { deriveIdentityId } = require("../../lib/tmux-lite/crypto/identity.js");
    const ownerUserRootId = deriveIdentityId(ownerRoot.signing.publicKey);

    const accessList = new AccessControlList();

    const handler = new HandshakeHandler({
      identity: machine,
      ownerUserRootId,
      checkUserRootAccess: async () => false, // Not in vault ACL
    });

    const { state: clientState, message: clientHello } = createClientHello();
    const connectionId = "test-conn-denied";

    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });

    const serverHello = (helloResult as any).message.data as X3DHResponseMessage;
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(cert)
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    expect(authResult.type).toBe("reply");
    const serverAuth = (authResult as any).message.data;
    expect(serverAuth.result.type).toBe("rejected");
  });

  test("access_list is rejected when owner user root is not configured", async () => {
    const { client, machine } = createTestIdentityPair();
    const mnemonic = generateMnemonic();
    const userRoot = mnemonicToUserIdentity(mnemonic);
    const cert = createDeviceCertificate(
      userRoot,
      client.signing.publicKey,
      client.keyExchange.publicKey,
    );

    const accessList = new AccessControlList();

    // No ownerUserRootId or checkUserRootAccess.
    const handler = new HandshakeHandler({
      identity: machine,
    });

    const { state: clientState, message: clientHello } = createClientHello();
    const connectionId = "test-conn-device-acl";

    const helloResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_hello",
      data: clientHello,
    });

    const serverHello = (helloResult as any).message.data as X3DHResponseMessage;
    const clientAfterServerHello = require("../../lib/tmux-lite/crypto/handshake.js").processServerHello(
      clientState,
      serverHello
    );

    const { message: clientAuth } = createClientAuth(
      clientAfterServerHello!,
      client,
      { type: "access_list" },
      JSON.stringify(cert)
    );

    const authResult = await handler.processMessage(connectionId, {
      type: "handshake",
      phase: "client_auth",
      data: clientAuth,
    });

    expect(authResult.type).toBe("reply");
    const serverAuth = (authResult as any).message.data;
    expect(serverAuth.result.type).toBe("rejected");
  });
});
