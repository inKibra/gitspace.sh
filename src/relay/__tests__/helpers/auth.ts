/**
 * Test authentication helpers for relay tests
 *
 * Provides utilities for Ed25519 challenge-response authentication
 * used by the relay server.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import type { Server } from "bun";
import type { Identity } from "../../../types/identity.js";
import type { RelayIdentity } from "../../identity.js";
import type { WebSocketData } from "../../types.js";
import { generateRelayIdentity } from "../../identity.js";
import { createRelayServer } from "../../server.js";
import { signMessage, type SignatureBlock } from "../../signing.js";
import { toPublicIdentity } from "../../../lib/tmux-lite/crypto/__tests__/helpers/test-identities.js";

// ============================================================================
// Challenge-Response Authentication
// ============================================================================

/**
 * Sign a challenge nonce for machine authentication
 *
 * The relay sends a random nonce in the relay_identity message.
 * The machine must sign this nonce with its Ed25519 private key.
 *
 * @param nonce - The challenge nonce bytes (from relay_identity.challenge, base64 decoded)
 * @param signingSecretKey - The machine's Ed25519 secret key (64 bytes: private + public)
 * @returns Base64-encoded signature
 */
export function signChallenge(
  nonce: Uint8Array,
  signingSecretKey: Uint8Array
): string {
  // Ed25519 secretKey is 64 bytes (32 private + 32 public), use first 32 for signing
  // Note: noble ed25519.sign expects 32-byte private key
  const privateKey = signingSecretKey.slice(0, 32);
  const signature = ed25519.sign(nonce, privateKey);
  return Buffer.from(signature).toString("base64");
}

/**
 * Get base64-encoded signing key from identity
 *
 * Used to build the preAuthorizedMachines set for createRelayServer.
 *
 * @param identity - Machine identity
 * @returns Base64-encoded signing public key
 */
export function getSigningKeyBase64(identity: Identity): string {
  return Buffer.from(identity.signing.publicKey).toString("base64");
}

export function signClientMessage<T extends object>(
  message: T,
  identity: Identity
): T & { signature: SignatureBlock } {
  const privateKey = identity.signing.secretKey.slice(0, 32);
  return signMessage(message, privateKey, identity.signing.publicKey);
}

// ============================================================================
// Machine Connection with Authentication
// ============================================================================

/**
 * Connect a machine to the relay and complete challenge-response authentication
 *
 * This handles the full authentication flow:
 * 1. Connect to /ws?role=machine
 * 2. Receive relay_identity with challenge nonce
 * 3. Sign nonce with machine's private key
 * 4. Send register_machine with challengeResponse
 * 5. Wait for "registered" confirmation
 *
 * @param relayUrl - WebSocket URL (e.g., "ws://localhost:3099/ws")
 * @param identity - Machine identity
 * @param options - Optional configuration
 * @returns Connected and authenticated WebSocket
 */
export async function connectMachineWithAuth(
  relayUrl: string,
  identity: Identity,
  options?: {
    label?: string;
    timeoutMs?: number;
  }
): Promise<WebSocket> {
  const { label = identity.label, timeoutMs = 5000 } = options ?? {};

  // Connect without token (new auth flow)
  const url = new URL(relayUrl);
  url.searchParams.set("role", "machine");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Machine WebSocket connection failed"));
    setTimeout(() => reject(new Error("Connection timeout")), timeoutMs);
  });

  // Wait for relay_identity with challenge
  const challenge = await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Challenge timeout")), timeoutMs);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "relay_identity" && msg.challenge) {
          clearTimeout(timeout);
          resolve(Buffer.from(msg.challenge, "base64"));
        }
      } catch {
        // Ignore parse errors
      }
    };
  });

  // Sign challenge and send register_machine
  const signature = signChallenge(challenge, identity.signing.secretKey);
  const publicIdentity = toPublicIdentity(identity);

  ws.send(JSON.stringify({
    type: "register_machine",
    machineId: identity.id,
    signingKey: publicIdentity.signingPublicKey,
    keyExchangeKey: publicIdentity.keyExchangePublicKey,
    challengeResponse: signature,
    label,
  }));

  // Wait for registration confirmation
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Registration timeout")), timeoutMs);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered") {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.message || "Registration failed"));
        }
      } catch {
        // Ignore parse errors
      }
    };
  });

  return ws;
}

/**
 * Connect a machine and wait for the first relay_identity message
 * without completing authentication.
 *
 * Useful for tests that need to inspect the challenge or test failure cases.
 *
 * @param relayUrl - WebSocket URL
 * @param timeoutMs - Timeout in milliseconds
 * @returns WebSocket and challenge details
 */
export async function connectMachineAndGetChallenge(
  relayUrl: string,
  timeoutMs = 5000
): Promise<{
  ws: WebSocket;
  challenge: Uint8Array;
  relayPublicKey: string;
  relayFingerprint: string;
}> {
  const url = new URL(relayUrl);
  url.searchParams.set("role", "machine");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Connection failed"));
    setTimeout(() => reject(new Error("Connection timeout")), timeoutMs);
  });

  const relayIdentity = await new Promise<{
    challenge: Uint8Array;
    publicKey: string;
    fingerprint: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Challenge timeout")), timeoutMs);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "relay_identity") {
          clearTimeout(timeout);
          resolve({
            challenge: Buffer.from(msg.challenge, "base64"),
            publicKey: msg.publicKey,
            fingerprint: msg.fingerprint,
          });
        }
      } catch {
        // Ignore
      }
    };
  });

  return {
    ws,
    challenge: relayIdentity.challenge,
    relayPublicKey: relayIdentity.publicKey,
    relayFingerprint: relayIdentity.fingerprint,
  };
}

// ============================================================================
// Client Connection (no auth needed at relay level)
// ============================================================================

/**
 * Connect a client to the relay
 *
 * Clients no longer need tokens - auth happens via X3DH handshake with machine.
 *
 * @param relayUrl - WebSocket URL
 * @param timeoutMs - Timeout in milliseconds
 * @returns Connected WebSocket
 */
export async function connectClient(
  relayUrl: string,
  timeoutMs = 5000
): Promise<WebSocket> {
  const url = new URL(relayUrl);
  url.searchParams.set("role", "client");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Client WebSocket connection failed"));
    setTimeout(() => reject(new Error("Connection timeout")), timeoutMs);
  });

  return ws;
}

// ============================================================================
// Test Server Creation
// ============================================================================

/**
 * Create a test relay server with pre-authorized machines
 *
 * @param port - Port to listen on
 * @param preAuthorizedMachines - Machine identities to pre-authorize
 * @param options - Additional server options
 * @returns Relay server instance
 */
export function createTestRelayServer(
  port: number,
  preAuthorizedMachines: Identity[],
  options?: {
    hostname?: string;
    label?: string;
  }
): { server: Server<WebSocketData>; relayIdentity: RelayIdentity } {
  const { hostname = "localhost", label = "test-relay" } = options ?? {};

  const relayIdentity = generateRelayIdentity(label);

  const preAuthSet = new Set(
    preAuthorizedMachines.map((id) => getSigningKeyBase64(id))
  );

  const server = createRelayServer({
    port,
    hostname,
    identity: relayIdentity,
    preAuthorizedMachines: preAuthSet,
  });

  return { server, relayIdentity };
}

// ============================================================================
// Message Helpers
// ============================================================================

/**
 * Wait for a specific message type on a WebSocket
 *
 * @param ws - WebSocket to listen on
 * @param messageType - Message type to wait for
 * @param timeoutMs - Timeout in milliseconds
 * @returns Parsed message
 */
export async function waitForMessage<T = unknown>(
  ws: WebSocket,
  messageType: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === messageType) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(msg as T);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          reject(new Error(msg.message || `Error while waiting for ${messageType}`));
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.addEventListener("message", handler);
  });
}

/**
 * Send a message and wait for response
 *
 * @param ws - WebSocket to use
 * @param message - Message to send
 * @param expectedResponseType - Expected response type
 * @param timeoutMs - Timeout in milliseconds
 * @returns Response message
 */
export async function sendAndWait<T = unknown>(
  ws: WebSocket,
  message: object,
  expectedResponseType: string,
  timeoutMs = 5000
): Promise<T> {
  const responsePromise = waitForMessage<T>(ws, expectedResponseType, timeoutMs);
  ws.send(JSON.stringify(message));
  return responsePromise;
}
