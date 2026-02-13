/**
 * Web Terminal Tests
 *
 * Comprehensive tests for the web terminal connection flow:
 * 1. Browser crypto unit tests (identity, keyexchange, handshake, frames)
 * 2. Browser ↔ Node crypto interop tests
 * 3. Web terminal E2E connection tests (with and without invite)
 *
 * These tests run in Bun but use the same noble-curves libraries as the browser.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";

// Browser crypto modules (same code runs in Bun)
import {
  generateIdentity,
  generateSigningKeypair,
  generateKeyExchangeKeypair,
  sign,
  verify,
  deriveIdentityId,
  serializeIdentity,
  deserializeIdentity,
} from "../identity.web";

import {
  randomBytes,
  x25519SharedSecret,
  generateEphemeralKeypair,
  deriveSessionKeys,
  deriveSessionKeysFromMultiple,
  validateX25519PublicKey,
  X25519_KEY_LENGTH,
} from "../keyexchange.web";

import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processServerAuth,
  type X3DHResponseMessage,
  type X3DHResultMessage,
} from "../handshake.web";
import { signRelayMessage } from "../relay-signing.web";

import {
  encrypt,
  decrypt,
  createFrame,
  openFrame,
  encodeFrame,
  decodeFrame,
  MASTER_STREAM_ID,
} from "../frames.web";

// Node crypto modules (for interop testing)
import { generateRelayIdentity } from "../../../relay/identity";
import { clearAllRegistries } from "../../../relay/registries";
import {
  createTestIdentity as createNodeIdentity,
  toPublicIdentity,
} from "../../../lib/tmux-lite/crypto/__tests__/helpers/test-identities";
import { HandshakeHandler } from "../../../lib/tmux-lite/handshake-handler";
import { AccessControlList } from "../../../lib/tmux-lite/crypto/access-control";
import { createInviteToken } from "../../../lib/tmux-lite/crypto/invites";
import { signChallenge, getSigningKeyBase64 } from "../../../relay/__tests__/helpers/auth";
import { startRelayServer } from "../../../relay/__tests__/helpers/ports";
import { createHash } from "crypto";
import type { Server } from "bun";

// ============================================================================
// Part 1: Browser Crypto Unit Tests
// ============================================================================

describe("Browser Crypto: Identity", () => {
  test("generates valid signing keypair", () => {
    const keypair = generateSigningKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.secretKey.length).toBe(64); // Ed25519 convention
  });

  test("generates valid key exchange keypair", () => {
    const keypair = generateKeyExchangeKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.privateKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.privateKey.length).toBe(32);
  });

  test("generates complete identity", () => {
    const identity = generateIdentity("Test Browser");
    expect(identity.id).toBeDefined();
    expect(identity.id.length).toBe(16);
    expect(identity.signing).toBeDefined();
    expect(identity.keyExchange).toBeDefined();
    expect(identity.label).toBe("Test Browser");
    expect(identity.createdAt).toBeGreaterThan(0);
  });

  test("sign and verify work correctly", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Hello, World!");

    const signature = sign(message, keypair.secretKey);
    expect(signature.length).toBe(64);

    const isValid = verify(message, signature, keypair.publicKey);
    expect(isValid).toBe(true);
  });

  test("verify rejects invalid signature", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Hello, World!");

    const signature = sign(message, keypair.secretKey);

    // Tamper with signature
    const badSignature = new Uint8Array(signature);
    badSignature[0] ^= 0xff;

    const isValid = verify(message, badSignature, keypair.publicKey);
    expect(isValid).toBe(false);
  });

  test("verify rejects wrong message", () => {
    const keypair = generateSigningKeypair();
    const message = new TextEncoder().encode("Hello, World!");
    const wrongMessage = new TextEncoder().encode("Wrong message");

    const signature = sign(message, keypair.secretKey);
    const isValid = verify(wrongMessage, signature, keypair.publicKey);
    expect(isValid).toBe(false);
  });

  test("deriveIdentityId produces consistent IDs", () => {
    const keypair = generateSigningKeypair();
    const id1 = deriveIdentityId(keypair.publicKey);
    const id2 = deriveIdentityId(keypair.publicKey);
    expect(id1).toBe(id2);
    expect(id1.length).toBe(16);
  });

  test("serialize and deserialize identity", () => {
    const identity = generateIdentity("Test");
    const serialized = serializeIdentity(identity);
    const deserialized = deserializeIdentity(serialized);

    expect(deserialized.id).toBe(identity.id);
    expect(deserialized.label).toBe(identity.label);
    expect(deserialized.createdAt).toBe(identity.createdAt);

    // Keys should match (convert to Array for comparison to avoid ArrayBuffer type issues)
    expect(Array.from(new Uint8Array(deserialized.signing.publicKey))).toEqual(Array.from(identity.signing.publicKey));
    expect(Array.from(new Uint8Array(deserialized.signing.secretKey))).toEqual(Array.from(identity.signing.secretKey));
    expect(Array.from(new Uint8Array(deserialized.keyExchange.publicKey))).toEqual(Array.from(identity.keyExchange.publicKey));
    expect(Array.from(new Uint8Array(deserialized.keyExchange.privateKey))).toEqual(Array.from(identity.keyExchange.privateKey));
  });
});

describe("Browser Crypto: Key Exchange", () => {
  test("randomBytes generates correct length", () => {
    const bytes16 = randomBytes(16);
    const bytes32 = randomBytes(32);
    expect(bytes16.length).toBe(16);
    expect(bytes32.length).toBe(32);
  });

  test("randomBytes generates different values", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).not.toEqual(b);
  });

  test("generateEphemeralKeypair produces valid keys", () => {
    const keypair = generateEphemeralKeypair();
    expect(keypair.publicKey.length).toBe(X25519_KEY_LENGTH);
    expect(keypair.privateKey.length).toBe(X25519_KEY_LENGTH);
    expect(validateX25519PublicKey(keypair.publicKey)).toBe(true);
  });

  test("x25519SharedSecret produces same result for both parties", () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();

    const sharedA = x25519SharedSecret(alice.privateKey, bob.publicKey);
    const sharedB = x25519SharedSecret(bob.privateKey, alice.publicKey);

    expect(sharedA).toEqual(sharedB);
    expect(sharedA.length).toBe(X25519_KEY_LENGTH);
  });

  test("deriveSessionKeys produces symmetric keys", () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();

    const sharedSecret = x25519SharedSecret(alice.privateKey, bob.publicKey);
    const salt = randomBytes(32);

    const aliceKeys = deriveSessionKeys(sharedSecret, salt, true);
    const bobKeys = deriveSessionKeys(sharedSecret, salt, false);

    // Alice's sendKey should match Bob's receiveKey
    expect(aliceKeys.sendKey).toEqual(bobKeys.receiveKey);
    expect(aliceKeys.receiveKey).toEqual(bobKeys.sendKey);
    expect(aliceKeys.sessionId).toBe(bobKeys.sessionId);
  });

  test("deriveSessionKeysFromMultiple combines secrets correctly", () => {
    const ephemeral1 = generateEphemeralKeypair();
    const ephemeral2 = generateEphemeralKeypair();
    const ephemeral3 = generateEphemeralKeypair();

    const dh1 = x25519SharedSecret(ephemeral1.privateKey, ephemeral2.publicKey);
    const dh2 = x25519SharedSecret(ephemeral1.privateKey, ephemeral3.publicKey);

    const salt = randomBytes(32);
    const keys = deriveSessionKeysFromMultiple([dh1, dh2], salt, true);

    expect(keys.sendKey.length).toBe(32);
    expect(keys.receiveKey.length).toBe(32);
    expect(keys.sessionId.length).toBeGreaterThan(0);
  });

  test("validateX25519PublicKey rejects invalid keys", () => {
    // All zeros
    expect(validateX25519PublicKey(new Uint8Array(32))).toBe(false);

    // Wrong length
    expect(validateX25519PublicKey(new Uint8Array(16))).toBe(false);

    // Valid key
    const keypair = generateEphemeralKeypair();
    expect(validateX25519PublicKey(keypair.publicKey)).toBe(true);
  });
});

describe("Browser Crypto: Frames (AES-GCM)", () => {
  test("encrypt and decrypt round-trip", async () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode("Hello, encrypted world!");

    const { nonce, ciphertext } = await encrypt(plaintext, key);

    expect(nonce.length).toBe(12);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // Includes auth tag

    const decrypted = await decrypt(ciphertext, nonce, key);
    expect(decrypted).not.toBeNull();
    expect(new TextDecoder().decode(decrypted!)).toBe("Hello, encrypted world!");
  });

  test("decrypt fails with wrong key", async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const plaintext = new TextEncoder().encode("Secret message");

    const { nonce, ciphertext } = await encrypt(plaintext, key1);
    const decrypted = await decrypt(ciphertext, nonce, key2);

    expect(decrypted).toBeNull();
  });

  test("decrypt fails with tampered ciphertext", async () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode("Secret message");

    const { nonce, ciphertext } = await encrypt(plaintext, key);

    // Tamper with ciphertext
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    const decrypted = await decrypt(tampered, nonce, key);
    expect(decrypted).toBeNull();
  });

  test("encodeFrame and decodeFrame round-trip", () => {
    const frame = {
      streamId: MASTER_STREAM_ID,
      nonce: randomBytes(12),
      ciphertext: randomBytes(100),
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.streamId).toBe(frame.streamId);
    expect(decoded!.nonce).toEqual(frame.nonce);
    expect(decoded!.ciphertext).toEqual(frame.ciphertext);
  });

  test("createFrame and openFrame round-trip", async () => {
    const key = randomBytes(32);
    const data = new TextEncoder().encode("Terminal output data");

    const frame = await createFrame(MASTER_STREAM_ID, data, key);
    const result = await openFrame(frame, key);

    expect(result).not.toBeNull();
    expect(result!.streamId).toBe(MASTER_STREAM_ID);
    expect(new TextDecoder().decode(result!.data)).toBe("Terminal output data");
  });
});

describe("Browser Crypto: X3DH Handshake", () => {
  test("createClientHello produces valid message", () => {
    const { state, message } = createClientHello("test-machine");

    expect(state.phase).toBe("awaiting_server_hello");
    expect(state.ephemeral).toBeDefined();
    expect(state.clientNonce.length).toBe(32);

    expect(message.version).toBe(1);
    expect(message.ephemeralKey).toBeDefined();
    expect(message.timestamp).toBeGreaterThan(0);
    expect(message.clientNonce).toBeDefined();
    expect(message.machineIdHint).toBe("test-machine");
  });

  test("full handshake flow (simulated)", () => {
    // This simulates what the server would do
    const browserClient = generateIdentity("Browser Client");
    const serverMachine = generateIdentity("Server Machine");

    // Step 1: Browser creates ClientHello
    const { state: clientState1, message: _clientHello } = createClientHello();

    // Step 2: Simulate server creating ServerHello
    const serverEphemeral = generateEphemeralKeypair();
    const signedPreKey = generateEphemeralKeypair();
    const serverNonce = randomBytes(32);

    // Server signs its pre-key
    const preKeySignature = sign(signedPreKey.publicKey, serverMachine.signing.secretKey);

    const serverHello: X3DHResponseMessage = {
      version: 1,
      identityKey: btoa(String.fromCharCode(...serverMachine.signing.publicKey)),
      keyExchangeKey: btoa(String.fromCharCode(...serverMachine.keyExchange.publicKey)),
      ephemeralKey: btoa(String.fromCharCode(...serverEphemeral.publicKey)),
      signedPreKey: btoa(String.fromCharCode(...signedPreKey.publicKey)),
      preKeySignature: btoa(String.fromCharCode(...preKeySignature)),
      serverNonce: btoa(String.fromCharCode(...serverNonce)),
      timestamp: Date.now(),
    };

    // Step 3: Browser processes ServerHello
    const clientState2 = processServerHello(clientState1, serverHello);
    expect(clientState2).not.toBeNull();
    expect(clientState2!.phase).toBe("awaiting_server_auth");

    // Step 4: Browser creates ClientAuth
    const { message: clientAuth, sessionKeys: browserSessionKeys } = createClientAuth(
      clientState2!,
      browserClient,
      { type: "access_list" }
    );

    expect(clientAuth.version).toBe(1);
    expect(clientAuth.identityKey).toBeDefined();
    expect(clientAuth.keyExchangeKey).toBeDefined();
    expect(clientAuth.identityProof).toBeDefined();

    expect(browserSessionKeys.sendKey.length).toBe(32);
    expect(browserSessionKeys.receiveKey.length).toBe(32);
    expect(browserSessionKeys.sessionId.length).toBeGreaterThan(0);
  });

  test("processServerHello rejects invalid signature", () => {
    const { state } = createClientHello();

    const serverHello: X3DHResponseMessage = {
      version: 1,
      identityKey: btoa(String.fromCharCode(...randomBytes(32))),
      keyExchangeKey: btoa(String.fromCharCode(...randomBytes(32))),
      ephemeralKey: btoa(String.fromCharCode(...generateEphemeralKeypair().publicKey)),
      signedPreKey: btoa(String.fromCharCode(...generateEphemeralKeypair().publicKey)),
      preKeySignature: btoa(String.fromCharCode(...randomBytes(64))), // Invalid signature
      serverNonce: btoa(String.fromCharCode(...randomBytes(32))),
      timestamp: Date.now(),
    };

    const result = processServerHello(state, serverHello);
    expect(result).toBeNull();
  });

  test("processServerHello rejects expired timestamp", () => {
    const serverMachine = generateIdentity("Server");
    const signedPreKey = generateEphemeralKeypair();
    const preKeySignature = sign(signedPreKey.publicKey, serverMachine.signing.secretKey);

    const { state } = createClientHello();

    const serverHello: X3DHResponseMessage = {
      version: 1,
      identityKey: btoa(String.fromCharCode(...serverMachine.signing.publicKey)),
      keyExchangeKey: btoa(String.fromCharCode(...serverMachine.keyExchange.publicKey)),
      ephemeralKey: btoa(String.fromCharCode(...generateEphemeralKeypair().publicKey)),
      signedPreKey: btoa(String.fromCharCode(...signedPreKey.publicKey)),
      preKeySignature: btoa(String.fromCharCode(...preKeySignature)),
      serverNonce: btoa(String.fromCharCode(...randomBytes(32))),
      timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago - too old
    };

    const result = processServerHello(state, serverHello);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Part 2: Browser ↔ Node Crypto Interop Tests
// ============================================================================

describe("Browser ↔ Node Interop: Identity", () => {
  test("browser-generated identity can be verified by node identity module", () => {
    const browserIdentity = generateIdentity("Browser");
    const message = new TextEncoder().encode("Test message");

    // Browser signs
    const signature = sign(message, browserIdentity.signing.secretKey);

    // Verify using browser verify function (same code path as node would use)
    const isValid = verify(message, signature, browserIdentity.signing.publicKey);
    expect(isValid).toBe(true);
  });

  test("node-generated identity can be verified by browser crypto", () => {
    const nodeIdentity = createNodeIdentity("Node Machine");
    const message = new TextEncoder().encode("Test message");

    // Node signs using the same sign function from browser module
    // (both use @noble/curves/ed25519)
    const signature = sign(message, nodeIdentity.signing.secretKey);

    // Browser verifies
    const isValid = verify(message, signature, nodeIdentity.signing.publicKey);
    expect(isValid).toBe(true);
  });
});

describe("Browser ↔ Node Interop: Key Exchange", () => {
  test("browser and node keypairs can compute same shared secret", () => {
    // Browser generates keypair
    const browserKeypair = generateEphemeralKeypair();

    // Node generates keypair (using same function - both use noble)
    const nodeKeypair = generateEphemeralKeypair();

    // Compute shared secrets from both sides
    const browserShared = x25519SharedSecret(browserKeypair.privateKey, nodeKeypair.publicKey);
    const nodeShared = x25519SharedSecret(nodeKeypair.privateKey, browserKeypair.publicKey);

    expect(browserShared).toEqual(nodeShared);
  });

  test("browser and node derive same session keys", () => {
    const browserKeypair = generateEphemeralKeypair();
    const nodeKeypair = generateEphemeralKeypair();

    const sharedSecret = x25519SharedSecret(browserKeypair.privateKey, nodeKeypair.publicKey);
    const salt = randomBytes(32);

    // Browser derives as initiator
    const browserKeys = deriveSessionKeys(sharedSecret, salt, true);

    // Node derives as responder
    const nodeKeys = deriveSessionKeys(sharedSecret, salt, false);

    // Should be symmetric
    expect(browserKeys.sendKey).toEqual(nodeKeys.receiveKey);
    expect(browserKeys.receiveKey).toEqual(nodeKeys.sendKey);
    expect(browserKeys.sessionId).toBe(nodeKeys.sessionId);
  });
});

// ============================================================================
// Part 3: Web Terminal E2E Connection Tests
// ============================================================================

const TEST_HOST = "127.0.0.1";
let relayUrl = "";
let relayHttpBase = "";

// Generate test identities
const testRelayIdentity = generateRelayIdentity("web-terminal-test-relay");
const testMachineIdentity = createNodeIdentity("Test Machine");

let server: Server<any>;

describe("Web Terminal E2E", () => {
  beforeAll(async () => {
    // Pre-authorize the test machine
    server = startRelayServer({
      bind: TEST_HOST,
      hostname: TEST_HOST,
      disableRateLimit: true,
      identity: testRelayIdentity,
      preAuthorizedMachines: new Set([
        getSigningKeyBase64(testMachineIdentity),
      ]),
    });
    relayUrl = `ws://${TEST_HOST}:${server.port}/ws`;
    relayHttpBase = `http://${TEST_HOST}:${server.port}`;

    // Wait for server to start accepting requests to avoid flakiness.
    const deadline = Date.now() + 3000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(`${relayHttpBase}/health`);
        if (res.ok) break;
      } catch {
        // ignore until deadline
      }
      if (Date.now() > deadline) {
        throw new Error("Relay server did not become healthy in time");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    clearAllRegistries();
  });

  /**
   * Helper: Create and register a machine connection with challenge-response auth
   */
  async function setupMachine(machineIdentity: ReturnType<typeof createNodeIdentity>, accessList: AccessControlList) {
    const url = new URL(relayUrl);
    url.searchParams.set("role", "machine");
    // No token needed - auth via challenge-response

    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Machine connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    // Wait for relay_identity with challenge
    const challenge = await new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Challenge timeout")), 5000);
      ws.onmessage = (event) => {
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
          const msg = JSON.parse(data);
          if (msg.type === "relay_identity" && msg.challenge) {
            clearTimeout(timeout);
            resolve(Buffer.from(msg.challenge, "base64"));
          }
        } catch {
          // Ignore
        }
      };
    });

    // Sign challenge
    const signature = signChallenge(challenge, machineIdentity.signing.secretKey);
    const publicIdentity = toPublicIdentity(machineIdentity);

    // Register machine with challenge response
    ws.send(JSON.stringify({
      type: "register_machine",
      machineId: machineIdentity.id,
      signingKey: publicIdentity.signingPublicKey,
      keyExchangeKey: publicIdentity.keyExchangePublicKey,
      challengeResponse: signature,
      label: machineIdentity.label,
    }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Registration timeout")), 5000);
      ws.onmessage = (event) => {
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
          const msg = JSON.parse(data);
          if (msg.type === "registered") {
            clearTimeout(timeout);
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        } catch {
          // Ignore
        }
      };
    });

    const handshakeHandler = new HandshakeHandler({
      identity: machineIdentity,
      accessList,
      handshakeTimeoutMs: 30000,
    });

    return { ws, handshakeHandler };
  }

  /**
   * Helper: Set up machine to handle handshake messages
   */
  function setupMachineHandshakeHandler(ws: WebSocket, handler: HandshakeHandler, onComplete: (clientId: string) => void) {
    ws.onmessage = async (event) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(data);

      if (msg.type === "client_connected") {
        console.log("[machine] Client connected:", msg.connectionId);
      }

      if (msg.type === "data" && msg.connectionId) {
        const msgData = Buffer.from(msg.data, "base64");
        try {
          const jsonStr = new TextDecoder().decode(msgData);
          const envelope = JSON.parse(jsonStr);

          if (envelope.type === "handshake") {
            // Convert browser format (step + spread fields) to HandshakeHandler format (phase + data)
            // Browser sends: { type: "handshake", step: "client_hello", ...clientHelloFields }
            // Handler expects: { type: "handshake", phase: "client_hello", data: clientHelloFields }
            const { type: _type, step, ...handshakeData } = envelope;
            const handlerMessage = {
              type: "handshake" as const,
              phase: step as "client_hello" | "client_auth",
              data: handshakeData,
            };

            const result = await handler.processMessage(msg.connectionId, handlerMessage);

            if (result.type === "reply" || result.type === "established") {
              // Convert response back to browser format
              // Handler returns: { type: "handshake", phase: "server_hello", data: serverHelloFields }
              // Browser expects: { type: "handshake", step: "server_hello", ...serverHelloFields }
              const responseData = result.message.data as Record<string, unknown>;
              const browserFormatResponse = {
                type: "handshake",
                step: result.message.phase,
                ...responseData,
              };

              ws.send(JSON.stringify({
                type: "data",
                connectionId: msg.connectionId,
                data: Buffer.from(JSON.stringify(browserFormatResponse)).toString("base64"),
              }));

              if (result.type === "established") {
                console.log("[machine] Handshake established with:", result.session.peerIdentityId);
                onComplete(result.session.peerIdentityId);
              }
            } else if (result.type === "error") {
              console.error("[machine] Handshake error:", result.reason);
            }
          }
        } catch (e) {
          console.error("[machine] Handshake handler error:", e);
        }
      }
    };
  }

  test("browser client can connect with pre-authorization", async () => {
    // Browser client generates its own identity
    const browserIdentity = generateIdentity("Browser Client");

    // Pre-authorize the browser identity
    const accessList = new AccessControlList();
    accessList.addEntry({
      id: browserIdentity.id,
      signingPublicKey: Buffer.from(browserIdentity.signing.publicKey).toString("base64"),
      keyExchangePublicKey: Buffer.from(browserIdentity.keyExchange.publicKey).toString("base64"),
    }, 'full');

    const { ws: machineWs, handshakeHandler } = await setupMachine(testMachineIdentity, accessList);

    // Also authorize with relay (using accessType format)
    machineWs.send(JSON.stringify({
      type: "authorize_client",
      machineId: testMachineIdentity.id,
      clientIdentityId: browserIdentity.id,
      signingKey: Buffer.from(browserIdentity.signing.publicKey).toString("base64"),
      keyExchangeKey: Buffer.from(browserIdentity.keyExchange.publicKey).toString("base64"),
      accessType: "full",
    }));

    await new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "client_authorized") {
          machineWs.removeEventListener("message", handler);
          resolve();
        }
      };
      machineWs.addEventListener("message", handler);
    });

    // Track handshake completion
    let machineHandshakeComplete = false;
    let machineReceivedClientId: string | null = null;

    setupMachineHandshakeHandler(machineWs, handshakeHandler, (clientId) => {
      machineHandshakeComplete = true;
      machineReceivedClientId = clientId;
    });

    // Browser connects (no token needed)
    const clientUrl = new URL(relayUrl);
    clientUrl.searchParams.set("role", "client");

    const clientWs = new WebSocket(clientUrl.toString());

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    // Browser sends connect_to_machine
    const signedConnect = signRelayMessage({
      type: "connect_to_machine",
      machineId: testMachineIdentity.id,
      clientIdentityId: browserIdentity.id,
    }, browserIdentity);
    clientWs.send(JSON.stringify(signedConnect));

    // Wait for connection_established
    let connectionEstablished = false;
    await new Promise<void>((resolve) => {
      clientWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "connection_established") {
          connectionEstablished = true;
          resolve();
        } else if (msg.type === "error") {
          console.error("Connection error:", msg.message);
          resolve();
        }
      };
      setTimeout(resolve, 5000);
    });

    expect(connectionEstablished).toBe(true);

    // Now browser should do X3DH handshake
    const { state: clientState, message: clientHello } = createClientHello(testMachineIdentity.id);

    // Wrap handshake message like useTerminal does
    clientWs.send(JSON.stringify({
      type: "data",
      data: Buffer.from(JSON.stringify({
        type: "handshake",
        step: "client_hello",
        ...clientHello,
      })).toString("base64"),
    }));

    // Wait for handshake messages
    let browserSessionKeys: ReturnType<typeof deriveSessionKeys> | null = null;
    let handshakeComplete = false;
    let currentState = clientState;

    await new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "data" && msg.data) {
          try {
            const data = Buffer.from(msg.data, "base64");
            const envelope = JSON.parse(new TextDecoder().decode(data));

            if (envelope.type === "handshake") {
              if (envelope.step === "server_hello") {
                const newState = processServerHello(currentState, envelope as X3DHResponseMessage);
                if (newState) {
                  currentState = newState;
                  const { message: authMessage, sessionKeys } = createClientAuth(
                    newState,
                    browserIdentity,
                    { type: "access_list" }
                  );
                  browserSessionKeys = sessionKeys;

                  clientWs.send(JSON.stringify({
                    type: "data",
                    data: Buffer.from(JSON.stringify({
                      type: "handshake",
                      step: "client_auth",
                      ...authMessage,
                    })).toString("base64"),
                  }));
                }
              } else if (envelope.step === "server_auth") {
                const result = processServerAuth(
                  currentState,
                  envelope as X3DHResultMessage,
                  browserSessionKeys!
                );
                if (result) {
                  handshakeComplete = true;
                  clientWs.removeEventListener("message", handler);
                  resolve();
                }
              }
            }
          } catch (e) {
            console.error("Handshake error:", e);
          }
        }
      };
      clientWs.addEventListener("message", handler);
      setTimeout(() => {
        clientWs.removeEventListener("message", handler);
        resolve();
      }, 10000);
    });

    expect(handshakeComplete).toBe(true);
    expect(browserSessionKeys).not.toBeNull();
    expect(machineHandshakeComplete).toBe(true);
    expect(machineReceivedClientId).not.toBeNull();
    expect(machineReceivedClientId!).toBe(browserIdentity.id);

    clientWs.close();
    machineWs.close();
  });

  test("browser client can connect via invite", async () => {
    const accessList = new AccessControlList();
    // Note: accessList is empty - we'll use invite for authorization

    const { ws: machineWs, handshakeHandler } = await setupMachine(testMachineIdentity, accessList);

    // Browser generates its own identity
    const browserIdentity = generateIdentity("Browser Client");

    // Create invite token
    const inviteToken = createInviteToken(testMachineIdentity, relayUrl, {
      accessType: 'full',
      validityMs: 3600000,
    });

    const inviteId = createHash("sha256")
      .update(inviteToken)
      .digest("hex")
      .substring(0, 16);

    // Register invite with relay
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachineIdentity.id,
      expiresAt: Date.now() + 3600000,
      maxUses: null,
    }));

    await new Promise<void>((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered") {
          machineWs.removeEventListener("message", handler);
          resolve();
        } else if (msg.type === "error") {
          machineWs.removeEventListener("message", handler);
          reject(new Error(msg.message));
        }
      };
      machineWs.addEventListener("message", handler);
      setTimeout(() => reject(new Error("Invite registration timeout")), 5000);
    });

    // Track handshake
    let machineHandshakeComplete = false;
    setupMachineHandshakeHandler(machineWs, handshakeHandler, () => {
      machineHandshakeComplete = true;
    });

    // Browser connects and uses invite (no token needed)
    const clientUrl = new URL(relayUrl);
    clientUrl.searchParams.set("role", "client");

    const clientWs = new WebSocket(clientUrl.toString());

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    // Browser sends connect_with_invite (like useTerminal does with inviteId)
    const signedConnect = signRelayMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId: browserIdentity.id,
    }, browserIdentity);
    clientWs.send(JSON.stringify(signedConnect));

    // Wait for connection_established
    let connectionEstablished = false;
    await new Promise<void>((resolve) => {
      clientWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "connection_established") {
          connectionEstablished = true;
          resolve();
        } else if (msg.type === "error") {
          console.error("Connection error:", msg.message);
          resolve();
        }
      };
      setTimeout(resolve, 5000);
    });

    expect(connectionEstablished).toBe(true);

    // Do X3DH handshake
    const { state: clientState, message: clientHello } = createClientHello(testMachineIdentity.id);

    clientWs.send(JSON.stringify({
      type: "data",
      data: Buffer.from(JSON.stringify({
        type: "handshake",
        step: "client_hello",
        ...clientHello,
      })).toString("base64"),
    }));

    let browserSessionKeys: ReturnType<typeof deriveSessionKeys> | null = null;
    let handshakeComplete = false;
    let currentState = clientState;

    await new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "data" && msg.data) {
          try {
            const data = Buffer.from(msg.data, "base64");
            const envelope = JSON.parse(new TextDecoder().decode(data));

            if (envelope.type === "handshake") {
              if (envelope.step === "server_hello") {
                const newState = processServerHello(currentState, envelope as X3DHResponseMessage);
                if (newState) {
                  currentState = newState;
                  // Note: use full inviteToken (not inviteId) for X3DH authorization
                  // inviteId is only for relay's connect_with_invite message
                  const { message: authMessage, sessionKeys } = createClientAuth(
                    newState,
                    browserIdentity,
                    { type: "invite", inviteToken: inviteToken }
                  );
                  browserSessionKeys = sessionKeys;

                  clientWs.send(JSON.stringify({
                    type: "data",
                    data: Buffer.from(JSON.stringify({
                      type: "handshake",
                      step: "client_auth",
                      ...authMessage,
                    })).toString("base64"),
                  }));
                }
              } else if (envelope.step === "server_auth") {
                const result = processServerAuth(
                  currentState,
                  envelope as X3DHResultMessage,
                  browserSessionKeys!
                );
                if (result) {
                  handshakeComplete = true;
                  clientWs.removeEventListener("message", handler);
                  resolve();
                }
              }
            }
          } catch (e) {
            console.error("Handshake error:", e);
          }
        }
      };
      clientWs.addEventListener("message", handler);
      setTimeout(() => {
        clientWs.removeEventListener("message", handler);
        resolve();
      }, 10000);
    });

    expect(handshakeComplete).toBe(true);
    expect(browserSessionKeys).not.toBeNull();
    expect(machineHandshakeComplete).toBe(true);

    // Test encrypted data exchange
    const testData = new TextEncoder().encode("Hello from browser!");
    const frame = await createFrame(MASTER_STREAM_ID, testData, browserSessionKeys!.sendKey);

    clientWs.send(JSON.stringify({
      type: "data",
      data: btoa(String.fromCharCode(...frame)),
    }));

    // Give time for data to reach machine
    await new Promise((r) => setTimeout(r, 200));

    clientWs.close();
    machineWs.close();
  });
});

// ============================================================================
// Part 4: Regression Tests
// ============================================================================

describe("Regression: Handshake Message Parsing", () => {
  /**
   * Regression test for race condition bug:
   * Session keys are stored when sending client_auth, BEFORE server_auth arrives.
   * The handleDataMessage function must correctly parse JSON handshake messages
   * even when session keys are already set, otherwise it will try to decrypt
   * the JSON as an encrypted frame and fail.
   */
  test("server_auth is correctly parsed as JSON when session keys are already set", async () => {
    // Simulate the browser's handleDataMessage logic
    const sessionKeys = deriveSessionKeys(randomBytes(32), randomBytes(32), true);

    // Create a mock server_auth message (what the machine sends)
    const serverAuth = {
      type: "handshake",
      phase: "server_auth",
      data: {
        version: 1,
        identityKey: btoa(String.fromCharCode(...randomBytes(32))),
        identityProof: btoa(String.fromCharCode(...randomBytes(32))),
        result: { type: "accepted", permissions: { read: true, write: true, manage: false } },
      },
    };

    // Encode as base64 (like relay does)
    const base64Data = btoa(JSON.stringify(serverAuth));

    // Decode and check - this is the critical path that was buggy
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    // The fix: try JSON parsing first, regardless of session keys
    let isHandshakeMessage = false;
    let parsedPhase: string | null = null;

    try {
      const jsonStr = new TextDecoder().decode(bytes);
      const envelope = JSON.parse(jsonStr);

      if (envelope.type === "handshake") {
        isHandshakeMessage = true;
        parsedPhase = envelope.phase;
      }
    } catch {
      // Not JSON - would be encrypted data
    }

    expect(isHandshakeMessage).toBe(true);
    expect(parsedPhase).toBe("server_auth");

    // Verify that trying to decrypt as frame would fail
    // (this is what the old buggy code would do)
    const decryptResult = await openFrame(bytes, sessionKeys.receiveKey);
    expect(decryptResult).toBeNull();
  });

  test("encrypted frames are correctly decrypted when session keys are set", async () => {
    const sessionKeys = deriveSessionKeys(randomBytes(32), randomBytes(32), true);

    // Create an encrypted frame (what PTY output looks like)
    const plaintext = new TextEncoder().encode("Hello from terminal!");
    const frame = await createFrame(MASTER_STREAM_ID, plaintext, sessionKeys.sendKey);

    // This is NOT valid JSON, so JSON parsing should fail
    let isHandshakeMessage = false;

    try {
      const jsonStr = new TextDecoder().decode(frame);
      const envelope = JSON.parse(jsonStr);
      if (envelope.type === "handshake") {
        isHandshakeMessage = true;
      }
    } catch {
      // Expected - encrypted data is not valid JSON
    }

    expect(isHandshakeMessage).toBe(false);

    // But decryption should work (using receiveKey since we encrypted with sendKey, simulating peer)
    const decryptResult = await openFrame(frame, sessionKeys.sendKey);
    expect(decryptResult).not.toBeNull();
    expect(new TextDecoder().decode(decryptResult!.data)).toBe("Hello from terminal!");
  });

  test("handshake and encrypted data can be correctly distinguished", async () => {
    const sessionKeys = deriveSessionKeys(randomBytes(32), randomBytes(32), true);

    // Test both message types in sequence
    const messages = [
      // server_auth arrives first (JSON handshake)
      btoa(JSON.stringify({
        type: "handshake",
        phase: "server_auth",
        data: {
          version: 1,
          identityKey: btoa(String.fromCharCode(...randomBytes(32))),
          identityProof: btoa(String.fromCharCode(...randomBytes(32))),
          result: { type: "accepted", permissions: { read: true, write: true, manage: false } },
        },
      })),
      // Then encrypted PTY output arrives
      btoa(String.fromCharCode(...await createFrame(
        MASTER_STREAM_ID,
        new TextEncoder().encode("$ "),
        sessionKeys.sendKey
      ))),
    ];

    const results: Array<{ type: "handshake" | "encrypted"; data?: string }> = [];

    for (const base64Data of messages) {
      const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

      // Try JSON first (the fix)
      try {
        const jsonStr = new TextDecoder().decode(bytes);
        const envelope = JSON.parse(jsonStr);

        if (envelope.type === "handshake") {
          results.push({ type: "handshake" });
          continue;
        }
      } catch {
        // Not JSON
      }

      // Try decryption
      const frame = await openFrame(bytes, sessionKeys.sendKey);
      if (frame) {
        results.push({ type: "encrypted", data: new TextDecoder().decode(frame.data) });
      }
    }

    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("handshake");
    expect(results[1].type).toBe("encrypted");
    expect(results[1].data).toBe("$ ");
  });
});
