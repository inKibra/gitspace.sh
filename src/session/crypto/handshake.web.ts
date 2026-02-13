/**
 * Browser-compatible X3DH handshake protocol implementation
 *
 * Client-side only (browser doesn't need server-side functions)
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { verify, deriveIdentityId, sign } from "./identity.web";
import {
  x25519SharedSecret,
  generateEphemeralKeypair,
  deriveSessionKeysFromMultiple,
  validateX25519PublicKey,
  randomBytes,
} from "./keyexchange.web";
import type {
  Identity,
  KeyExchangeKeypair,
  SessionKeys,
} from "../../types/identity";

// Constants
const NONCE_LENGTH = 32;
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const PROTOCOL_VERSION = 1;

// ============================================================================
// Types
// ============================================================================

export type HandshakePhase =
  | "idle"
  | "awaiting_server_hello"
  | "awaiting_server_auth"
  | "established"
  | "failed";

export interface X3DHInitMessage {
  version: number;
  ephemeralKey: string;
  timestamp: number;
  clientNonce: string;
  machineIdHint?: string;
}

export interface X3DHResponseMessage {
  version: number;
  identityKey: string;
  keyExchangeKey: string;
  ephemeralKey: string;
  signedPreKey: string;
  preKeySignature: string;
  serverNonce: string;
  timestamp: number;
}

export interface X3DHAuthMessage {
  version: number;
  identityKey: string;
  keyExchangeKey: string;
  identityProof: string;
  /**
   * Ed25519 signature over handshake transcript proving key ownership (base64).
   * Signs: clientEphemeral || serverEphemeral || clientNonce || serverNonce
   */
  identitySignature: string;
  authorization:
    | { type: "invite"; inviteToken: string }
    | { type: "access_list" };
}

/** Access type for a client */
export type AccessType = 'full' | 'session-invite';

export interface X3DHResultMessage {
  version: number;
  identityKey: string;
  identityProof: string;
  result:
    | { type: "accepted"; accessType: AccessType; sessionId?: string }
    | { type: "rejected"; reason: string };
}

export interface X3DHClientState {
  phase: HandshakePhase;
  ephemeral: KeyExchangeKeypair;
  clientNonce: Uint8Array;
  serverNonce?: Uint8Array;
  peerIdentityKey?: Uint8Array;
  peerKeyExchangeKey?: Uint8Array;
  peerEphemeralKey?: Uint8Array;
  peerSignedPreKey?: Uint8Array;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for X3DHResponseMessage (ServerHello response)
 */
export function isX3DHResponseMessage(data: unknown): data is X3DHResponseMessage {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.version === 'number' &&
    typeof d.identityKey === 'string' &&
    typeof d.keyExchangeKey === 'string' &&
    typeof d.ephemeralKey === 'string' &&
    typeof d.signedPreKey === 'string' &&
    typeof d.preKeySignature === 'string' &&
    typeof d.serverNonce === 'string' &&
    typeof d.timestamp === 'number'
  );
}

/**
 * Type guard for X3DHResultMessage (ServerAuth response)
 */
export function isX3DHResultMessage(data: unknown): data is X3DHResultMessage {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (
    typeof d.version !== 'number' ||
    typeof d.identityKey !== 'string' ||
    typeof d.identityProof !== 'string' ||
    !d.result ||
    typeof d.result !== 'object'
  ) {
    return false;
  }
  const result = d.result as Record<string, unknown>;
  if (result.type === 'accepted') {
    // accessType must be 'full' or 'session-invite'
    return result.accessType === 'full' || result.accessType === 'session-invite';
  } else if (result.type === 'rejected') {
    return typeof result.reason === 'string';
  }
  return false;
}

// ============================================================================
// Base64 Helpers
// ============================================================================

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ============================================================================
// Client-Side Functions
// ============================================================================

/**
 * Create initial ClientHello message
 */
export function createClientHello(machineIdHint?: string): {
  state: X3DHClientState;
  message: X3DHInitMessage;
} {
  const ephemeral = generateEphemeralKeypair();
  const clientNonce = randomBytes(NONCE_LENGTH);

  const state: X3DHClientState = {
    phase: "awaiting_server_hello",
    ephemeral,
    clientNonce,
  };

  const message: X3DHInitMessage = {
    version: PROTOCOL_VERSION,
    ephemeralKey: toBase64(ephemeral.publicKey),
    timestamp: Date.now(),
    clientNonce: toBase64(clientNonce),
    machineIdHint,
  };

  return { state, message };
}

/**
 * Process ServerHello response
 */
export function processServerHello(
  state: X3DHClientState,
  response: X3DHResponseMessage
): X3DHClientState | null {
  if (state.phase !== "awaiting_server_hello") {
    return null;
  }

  if (response.version !== PROTOCOL_VERSION) {
    return null;
  }

  // Validate timestamp
  const now = Date.now();
  const timeDiff = Math.abs(now - response.timestamp);
  if (timeDiff > MAX_TIMESTAMP_SKEW_MS) {
    return null;
  }

  try {
    const peerIdentityKey = fromBase64(response.identityKey);
    const peerKeyExchangeKey = fromBase64(response.keyExchangeKey);
    const peerEphemeralKey = fromBase64(response.ephemeralKey);
    const peerSignedPreKey = fromBase64(response.signedPreKey);
    const preKeySignature = fromBase64(response.preKeySignature);
    const serverNonce = fromBase64(response.serverNonce);

    // Validate lengths
    if (peerIdentityKey.length !== 32) return null;
    if (serverNonce.length !== NONCE_LENGTH) return null;

    // Validate X25519 keys
    if (!validateX25519PublicKey(peerKeyExchangeKey)) return null;
    if (!validateX25519PublicKey(peerEphemeralKey)) return null;
    if (!validateX25519PublicKey(peerSignedPreKey)) return null;

    // Verify signature on signed pre-key
    const isValid = verify(peerSignedPreKey, preKeySignature, peerIdentityKey);
    if (!isValid) {
      return null;
    }

    return {
      ...state,
      phase: "awaiting_server_auth",
      serverNonce,
      peerIdentityKey,
      peerKeyExchangeKey,
      peerEphemeralKey,
      peerSignedPreKey,
    };
  } catch {
    return null;
  }
}

/**
 * Create ClientAuth message
 */
export function createClientAuth(
  state: X3DHClientState,
  identity: Identity,
  authorization: X3DHAuthMessage["authorization"]
): {
  state: X3DHClientState;
  message: X3DHAuthMessage;
  sessionKeys: SessionKeys;
} {
  if (state.phase !== "awaiting_server_auth") {
    throw new Error(`Invalid phase for ClientAuth: ${state.phase}`);
  }

  if (
    !state.peerSignedPreKey ||
    !state.peerEphemeralKey ||
    !state.peerIdentityKey ||
    !state.peerKeyExchangeKey ||
    !state.serverNonce
  ) {
    throw new Error("Missing server keys in state");
  }

  // Compute triple DH
  const dh1 = x25519SharedSecret(state.ephemeral.privateKey, state.peerSignedPreKey);
  const dh2 = x25519SharedSecret(state.ephemeral.privateKey, state.peerKeyExchangeKey);
  const dh3 = x25519SharedSecret(state.ephemeral.privateKey, state.peerEphemeralKey);

  // Derive session keys
  const salt = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
  salt.set(state.clientNonce, 0);
  salt.set(state.serverNonce, state.clientNonce.length);

  const sessionKeys = deriveSessionKeysFromMultiple([dh1, dh2, dh3], salt, true);

  // Create identity proof (HMAC over both nonces)
  const transcript = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
  transcript.set(state.clientNonce, 0);
  transcript.set(state.serverNonce, state.clientNonce.length);

  const identityProof = hmac(sha256, sessionKeys.sendKey, transcript);

  // Create signature transcript for identity proof
  // This proves the client possesses the signing key, not just knows the public key
  // Signs: clientEphemeral || serverEphemeral || clientNonce || serverNonce
  const signatureTranscript = new Uint8Array(
    state.ephemeral.publicKey.length +
    state.peerEphemeralKey.length +
    state.clientNonce.length +
    state.serverNonce.length
  );
  let offset = 0;
  signatureTranscript.set(state.ephemeral.publicKey, offset);
  offset += state.ephemeral.publicKey.length;
  signatureTranscript.set(state.peerEphemeralKey, offset);
  offset += state.peerEphemeralKey.length;
  signatureTranscript.set(state.clientNonce, offset);
  offset += state.clientNonce.length;
  signatureTranscript.set(state.serverNonce, offset);

  // Sign the transcript with the client's identity signing key
  const identitySignature = sign(signatureTranscript, identity.signing.secretKey);

  const message: X3DHAuthMessage = {
    version: PROTOCOL_VERSION,
    identityKey: toBase64(identity.signing.publicKey),
    keyExchangeKey: toBase64(identity.keyExchange.publicKey),
    identityProof: toBase64(identityProof),
    identitySignature: toBase64(identitySignature),
    authorization,
  };

  const newState: X3DHClientState = {
    ...state,
    phase: "awaiting_server_auth",
  };

  return { state: newState, message, sessionKeys };
}

/**
 * Process ServerAuth response
 */
export function processServerAuth(
  state: X3DHClientState,
  response: X3DHResultMessage,
  sessionKeys: SessionKeys
): {
  sessionKeys: SessionKeys;
  peerIdentityId: string;
  authResult: X3DHResultMessage["result"];
} | null {
  if (response.version !== PROTOCOL_VERSION) {
    return null;
  }

  if (response.result.type === "rejected") {
    return null;
  }

  try {
    const serverIdentityKey = fromBase64(response.identityKey);

    // Verify it matches ServerHello
    if (!state.peerIdentityKey) {
      return null;
    }

    if (!arraysEqual(serverIdentityKey, state.peerIdentityKey)) {
      return null;
    }

    // Verify identity proof
    const identityProof = fromBase64(response.identityProof);

    if (!state.serverNonce) {
      return null;
    }

    const transcript = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
    transcript.set(state.clientNonce, 0);
    transcript.set(state.serverNonce, state.clientNonce.length);

    const expectedProof = hmac(sha256, sessionKeys.receiveKey, transcript);

    if (!arraysEqual(identityProof, expectedProof)) {
      return null;
    }

    const peerIdentityId = deriveIdentityId(serverIdentityKey);

    return {
      sessionKeys,
      peerIdentityId,
      authResult: response.result,
    };
  } catch {
    return null;
  }
}
