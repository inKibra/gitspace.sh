/**
 * X3DH (Extended Triple Diffie-Hellman) handshake protocol implementation
 *
 * This module implements a 4-message mutual authentication handshake:
 * 1. ClientHello: Client sends ephemeral key and nonce
 * 2. ServerHello: Server sends identity, signed pre-key, ephemeral key, and nonce
 * 3. ClientAuth: Client proves identity and provides authorization
 * 4. ServerAuth: Server proves identity and returns authorization result
 *
 * The handshake provides:
 * - Perfect forward secrecy (ephemeral keys)
 * - Mutual authentication (both parties prove identity)
 * - Authorization (access lists)
 * - Protection against replay attacks (nonces, timestamps)
 * - Protection against man-in-the-middle (signed pre-keys)
 *
 * Key derivation uses triple DH:
 * - DH1 = client_ephemeral × server_signed_prekey
 * - DH2 = client_ephemeral × server_identity_keyexchange
 * - DH3 = client_ephemeral × server_ephemeral
 *
 * @module handshake
 */

import { randomBytes } from "node:crypto";
import { createHmac } from "node:crypto";
import { sign, verify, deriveIdentityId } from "./identity.js";
import {
  x25519SharedSecret,
  generateEphemeralKeypair,
  deriveSessionKeysFromMultiple,
  validateX25519PublicKey,
} from "./keyexchange.js";
import {
  verifyDeviceCertificate,
  isDeviceCertExpired,
  getUserRootIdFromCert,
} from "./device-cert.js";
import type {
  Identity,
  DeviceCertificate,
  KeyExchangeKeypair,
  SessionKeys,
  X3DHInitMessage,
  X3DHResponseMessage,
  X3DHAuthMessage,
  X3DHResultMessage,
  HandshakePhase,
} from "../../../types/identity.js";

// ============================================================================
// Constants
// ============================================================================

/** Nonce length (32 bytes, 256 bits) */
const NONCE_LENGTH = 32;

/** Maximum allowed clock skew for timestamp validation (5 minutes) */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/** Protocol version */
const PROTOCOL_VERSION = 1;

// ============================================================================
// Client State
// ============================================================================

/**
 * Client-side handshake state
 *
 * Tracks the client's progress through the handshake phases and
 * maintains ephemeral keys and received server information.
 */
export interface X3DHClientState {
  /** Current handshake phase */
  phase: HandshakePhase;
  /** Client's ephemeral keypair */
  ephemeral: KeyExchangeKeypair;
  /** Client-generated nonce for replay protection */
  clientNonce: Uint8Array;
  /** Server's nonce (received in ServerHello) */
  serverNonce?: Uint8Array;
  /** Server's Ed25519 identity public key (received in ServerHello) */
  peerIdentityKey?: Uint8Array;
  /** Server's X25519 key exchange public key (received in ServerHello) */
  peerKeyExchangeKey?: Uint8Array;
  /** Server's ephemeral X25519 public key (received in ServerHello) */
  peerEphemeralKey?: Uint8Array;
  /** Server's signed X25519 pre-key (received in ServerHello) */
  peerSignedPreKey?: Uint8Array;
}

// ============================================================================
// Server State
// ============================================================================

/**
 * Server-side handshake state
 *
 * Tracks the server's progress through the handshake phases and
 * maintains pre-signed keys and received client information.
 */
export interface X3DHServerState {
  /** Current handshake phase */
  phase: HandshakePhase;
  /** Server's signed pre-key (signed with identity key) */
  signedPreKey: KeyExchangeKeypair;
  /** Signature over signedPreKey.publicKey using identity signing key */
  signedPreKeySignature: Uint8Array;
  /** Server's ephemeral keypair */
  ephemeral: KeyExchangeKeypair;
  /** Server-generated nonce for replay protection */
  serverNonce: Uint8Array;
  /** Client's nonce (received in ClientHello) */
  clientNonce?: Uint8Array;
  /** Client's ephemeral X25519 public key (received in ClientHello) */
  clientEphemeralKey?: Uint8Array;
}

// ============================================================================
// Client-Side Functions
// ============================================================================

/**
 * Create initial ClientHello message
 *
 * Initiates the handshake by generating an ephemeral keypair and nonce.
 * The client sends their ephemeral public key and nonce to the server.
 *
 * @param machineIdHint - Optional machine ID for relay routing
 * @returns Client state and ClientHello message
 * @throws {Error} If key or nonce generation fails
 *
 * @example
 * ```typescript
 * const { state, message } = createClientHello("machine-123");
 * // Send message to server
 * await relay.send(message);
 * ```
 */
export function createClientHello(machineIdHint?: string): {
  state: X3DHClientState;
  message: X3DHInitMessage;
} {
  // Generate ephemeral keypair and nonce
  const ephemeral = generateEphemeralKeypair();
  const clientNonce = randomBytes(NONCE_LENGTH);

  const state: X3DHClientState = {
    phase: "awaiting_server_hello",
    ephemeral,
    clientNonce,
  };

  const message: X3DHInitMessage = {
    version: PROTOCOL_VERSION,
    ephemeralKey: Buffer.from(ephemeral.publicKey).toString("base64"),
    timestamp: Date.now(),
    clientNonce: Buffer.from(clientNonce).toString("base64"),
    machineIdHint,
  };

  return { state, message };
}

/**
 * Process ServerHello response
 *
 * Validates the server's response including:
 * - Protocol version
 * - Timestamp (replay protection)
 * - Signature on signed pre-key (authenticity)
 * - Public key validity
 *
 * @param state - Current client state (must be in awaiting_server_hello phase)
 * @param response - ServerHello message from server
 * @returns Updated client state, or null if validation fails
 *
 * @example
 * ```typescript
 * const message = await relay.receive();
 * const newState = processServerHello(state, message);
 * if (!newState) {
 *   throw new Error("Invalid ServerHello");
 * }
 * ```
 */
export function processServerHello(
  state: X3DHClientState,
  response: X3DHResponseMessage
): X3DHClientState | null {
  // Validate phase
  if (state.phase !== "awaiting_server_hello") {
    return null;
  }

  // Validate protocol version
  if (response.version !== PROTOCOL_VERSION) {
    return null;
  }

  // Validate timestamp (replay protection)
  const now = Date.now();
  const timeDiff = Math.abs(now - response.timestamp);
  if (timeDiff > MAX_TIMESTAMP_SKEW_MS) {
    return null;
  }

  try {
    // Decode server keys
    const peerIdentityKey = new Uint8Array(
      Buffer.from(response.identityKey, "base64")
    );
    const peerKeyExchangeKey = new Uint8Array(
      Buffer.from(response.keyExchangeKey, "base64")
    );
    const peerEphemeralKey = new Uint8Array(
      Buffer.from(response.ephemeralKey, "base64")
    );
    const peerSignedPreKey = new Uint8Array(
      Buffer.from(response.signedPreKey, "base64")
    );
    const preKeySignature = new Uint8Array(
      Buffer.from(response.preKeySignature, "base64")
    );
    const serverNonce = new Uint8Array(
      Buffer.from(response.serverNonce, "base64")
    );

    // Validate key lengths
    if (peerIdentityKey.length !== 32) return null;
    if (serverNonce.length !== NONCE_LENGTH) return null;

    // Validate X25519 public keys
    if (!validateX25519PublicKey(peerKeyExchangeKey)) return null;
    if (!validateX25519PublicKey(peerEphemeralKey)) return null;
    if (!validateX25519PublicKey(peerSignedPreKey)) return null;

    // Verify signature on signed pre-key
    const isValid = verify(peerSignedPreKey, preKeySignature, peerIdentityKey);
    if (!isValid) {
      return null;
    }

    // Update state
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
 *
 * Computes session keys and proves client identity. The identity proof
 * is an HMAC over both nonces using a shared secret derived from the
 * client's signing key.
 *
 * Session keys are derived from triple DH:
 * - DH1 = client_ephemeral × server_signed_prekey
 * - DH2 = client_ephemeral × server_identity_keyexchange
 * - DH3 = client_ephemeral × server_ephemeral
 *
 * @param state - Current client state (must be in awaiting_server_auth phase)
 * @param identity - Client's identity for authentication
 * @param authorization - Authorization method (access list)
 * @returns Updated state, ClientAuth message, and derived session keys
 * @throws {Error} If state is invalid or key derivation fails
 *
 * @example
 * ```typescript
 * const { state: newState, message, sessionKeys } = createClientAuth(
 *   state,
 *   myIdentity,
 *   { type: "access_list" }
 * );
 * await relay.send(message);
 * // Store sessionKeys for later use
 * ```
 */
export function createClientAuth(
  state: X3DHClientState,
  identity: Identity,
  authorization: X3DHAuthMessage["authorization"],
  deviceCertificate: string
): {
  state: X3DHClientState;
  message: X3DHAuthMessage;
  sessionKeys: SessionKeys;
} {
  // Validate phase
  if (state.phase !== "awaiting_server_auth") {
    throw new Error(
      `Invalid phase for ClientAuth: ${state.phase}, expected awaiting_server_auth`
    );
  }

  // Ensure we have server keys
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
  // DH1: client_ephemeral × server_signed_prekey
  const dh1 = x25519SharedSecret(
    state.ephemeral.privateKey,
    state.peerSignedPreKey
  );

  // DH2: client_ephemeral × server_identity_keyexchange
  const dh2 = x25519SharedSecret(
    state.ephemeral.privateKey,
    state.peerKeyExchangeKey
  );

  // DH3: client_ephemeral × server_ephemeral
  const dh3 = x25519SharedSecret(
    state.ephemeral.privateKey,
    state.peerEphemeralKey
  );

  // Derive session keys from triple DH
  const salt = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
  salt.set(state.clientNonce, 0);
  salt.set(state.serverNonce, state.clientNonce.length);

  const sessionKeys = deriveSessionKeysFromMultiple(
    [dh1, dh2, dh3],
    salt,
    true // Client is initiator
  );

  // Create identity proof (HMAC over both nonces)
  const transcript = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
  transcript.set(state.clientNonce, 0);
  transcript.set(state.serverNonce, state.clientNonce.length);

  const identityProof = createHmac("sha256", sessionKeys.sendKey)
    .update(transcript)
    .digest();

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

  // Create message
  if (!deviceCertificate) {
    throw new Error('Device certificate required for handshake authorization (owner identity binding)');
  }

  const message: X3DHAuthMessage = {
    version: PROTOCOL_VERSION,
    identityKey: Buffer.from(identity.signing.publicKey).toString("base64"),
    keyExchangeKey: Buffer.from(identity.keyExchange.publicKey).toString(
      "base64"
    ),
    identityProof: Buffer.from(identityProof).toString("base64"),
    identitySignature: Buffer.from(identitySignature).toString("base64"),
    authorization,
    deviceCertificate,
  };

  const newState: X3DHClientState = {
    ...state,
    phase: "awaiting_server_auth",
  };

  return { state: newState, message, sessionKeys };
}

/**
 * Process ServerAuth response
 *
 * Validates the server's identity proof and checks authorization result.
 * On success, returns the established session keys and permissions.
 *
 * @param state - Current client state
 * @param response - ServerAuth message from server
 * @param sessionKeys - Session keys derived in createClientAuth
 * @returns Handshake result with session keys and permissions, or null if validation fails
 *
 * @example
 * ```typescript
 * const response = await relay.receive();
 * const result = processServerAuth(state, response, sessionKeys);
 * if (!result) {
 *   throw new Error("Handshake failed");
 * }
 * console.log("Connected with accessType:", result.authResult.accessType);
 * ```
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
  // Validate protocol version
  if (response.version !== PROTOCOL_VERSION) {
    return null;
  }

  // Check authorization result
  if (response.result.type === "rejected") {
    return null;
  }

  try {
    // Decode server identity key
    const serverIdentityKey = new Uint8Array(
      Buffer.from(response.identityKey, "base64")
    );

    // Verify it matches what we received in ServerHello
    if (!state.peerIdentityKey) {
      return null;
    }

    if (!arraysEqual(serverIdentityKey, state.peerIdentityKey)) {
      return null;
    }

    // Verify identity proof
    const identityProof = new Uint8Array(
      Buffer.from(response.identityProof, "base64")
    );

    // Recreate transcript
    if (!state.serverNonce) {
      return null;
    }

    const transcript = new Uint8Array(
      state.clientNonce.length + state.serverNonce.length
    );
    transcript.set(state.clientNonce, 0);
    transcript.set(state.serverNonce, state.clientNonce.length);

    // Verify HMAC
    const expectedProof = createHmac("sha256", sessionKeys.receiveKey)
      .update(transcript)
      .digest();

    if (!arraysEqual(identityProof, expectedProof)) {
      return null;
    }

    // Derive peer identity ID
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

// ============================================================================
// Server-Side Functions
// ============================================================================

/**
 * Create server state for a new handshake
 *
 * Generates and signs a pre-key, and creates an ephemeral keypair.
 * The signed pre-key provides authentication and the ephemeral key
 * provides forward secrecy.
 *
 * @param identity - Server's identity
 * @returns Initial server state
 * @throws {Error} If key generation or signing fails
 *
 * @example
 * ```typescript
 * const serverState = createServerState(machineIdentity);
 * // Keep state in memory for this handshake
 * handshakes.set(sessionId, serverState);
 * ```
 */
export function createServerState(identity: Identity): X3DHServerState {
  // Generate signed pre-key
  const signedPreKey = generateEphemeralKeypair();
  const signedPreKeySignature = sign(
    signedPreKey.publicKey,
    identity.signing.secretKey
  );

  // Generate ephemeral keypair
  const ephemeral = generateEphemeralKeypair();

  // Generate server nonce
  const serverNonce = randomBytes(NONCE_LENGTH);

  return {
    phase: "idle",
    signedPreKey,
    signedPreKeySignature,
    ephemeral,
    serverNonce,
  };
}

/**
 * Process ClientHello message
 *
 * Validates the client's initial message and extracts their ephemeral
 * public key and nonce.
 *
 * @param state - Current server state (must be in idle phase)
 * @param message - ClientHello message from client
 * @returns Updated server state, or null if validation fails
 *
 * @example
 * ```typescript
 * const clientHello = await relay.receive();
 * const newState = processClientHello(state, clientHello);
 * if (!newState) {
 *   throw new Error("Invalid ClientHello");
 * }
 * ```
 */
export function processClientHello(
  state: X3DHServerState,
  message: X3DHInitMessage
): X3DHServerState | null {
  // Validate phase
  if (state.phase !== "idle") {
    return null;
  }

  // Validate protocol version
  if (message.version !== PROTOCOL_VERSION) {
    return null;
  }

  // Validate timestamp (replay protection)
  const now = Date.now();
  const timeDiff = Math.abs(now - message.timestamp);
  if (timeDiff > MAX_TIMESTAMP_SKEW_MS) {
    return null;
  }

  try {
    // Decode client ephemeral key and nonce
    const clientEphemeralKey = new Uint8Array(
      Buffer.from(message.ephemeralKey, "base64")
    );
    const clientNonce = new Uint8Array(
      Buffer.from(message.clientNonce, "base64")
    );

    // Validate key and nonce lengths
    if (!validateX25519PublicKey(clientEphemeralKey)) return null;
    if (clientNonce.length !== NONCE_LENGTH) return null;

    // Update state
    return {
      ...state,
      phase: "awaiting_client_auth",
      clientEphemeralKey,
      clientNonce,
    };
  } catch {
    return null;
  }
}

/**
 * Create ServerHello response
 *
 * Sends the server's identity, signed pre-key, ephemeral key, and nonce
 * to the client.
 *
 * @param state - Current server state (must be in awaiting_client_auth phase)
 * @param identity - Server's identity
 * @returns Updated state and ServerHello message
 * @throws {Error} If state is invalid
 *
 * @example
 * ```typescript
 * const { state: newState, message } = createServerHello(state, machineIdentity);
 * await relay.send(message);
 * ```
 */
export function createServerHello(
  state: X3DHServerState,
  identity: Identity
): { state: X3DHServerState; message: X3DHResponseMessage } {
  // Validate phase
  if (state.phase !== "awaiting_client_auth") {
    throw new Error(
      `Invalid phase for ServerHello: ${state.phase}, expected awaiting_client_auth`
    );
  }

  const message: X3DHResponseMessage = {
    version: PROTOCOL_VERSION,
    identityKey: Buffer.from(identity.signing.publicKey).toString("base64"),
    keyExchangeKey: Buffer.from(identity.keyExchange.publicKey).toString("base64"),
    ephemeralKey: Buffer.from(state.ephemeral.publicKey).toString("base64"),
    signedPreKey: Buffer.from(state.signedPreKey.publicKey).toString("base64"),
    preKeySignature: Buffer.from(state.signedPreKeySignature).toString(
      "base64"
    ),
    serverNonce: Buffer.from(state.serverNonce).toString("base64"),
    timestamp: Date.now(),
  };

  return { state, message };
}

/**
 * Process ClientAuth message
 *
 * Validates the client's identity proof and authorization.
 * Returns the client's identity ID and authorization method for
 * access control checks.
 *
 * @param state - Current server state
 * @param message - ClientAuth message from client
 * @param identity - Server's identity
 * @returns Client identity ID and authorization, or null if validation fails
 *
 * @example
 * ```typescript
 * const clientAuth = await relay.receive();
 * const result = processClientAuth(state, clientAuth, machineIdentity);
 * if (!result) {
 *   // Send rejection
 *   return;
 * }
 * // Check authorization (access list)
 * const permissions = await checkAuthorization(result);
 * ```
 */
export function processClientAuth(
  state: X3DHServerState,
  message: X3DHAuthMessage,
  identity: Identity
): {
  peerIdentityId: string;
  authorization: X3DHAuthMessage["authorization"];
  clientIdentityKey: Uint8Array;
  clientKeyExchangeKey: Uint8Array;
  /** User root identity ID extracted from a verified device certificate, if present */
  userRootId?: string;
} | null {
  // Validate protocol version
  if (message.version !== PROTOCOL_VERSION) {
    return null;
  }

  // Ensure we have client ephemeral key
  if (!state.clientEphemeralKey || !state.clientNonce) {
    return null;
  }

  try {
    // Decode client identity keys
    const clientIdentityKey = new Uint8Array(
      Buffer.from(message.identityKey, "base64")
    );
    const clientKeyExchangeKey = new Uint8Array(
      Buffer.from(message.keyExchangeKey, "base64")
    );
    const identityProof = new Uint8Array(
      Buffer.from(message.identityProof, "base64")
    );

    // Decode identity signature (required for security)
    if (!message.identitySignature) {
      return null; // Signature is required
    }
    const identitySignature = new Uint8Array(
      Buffer.from(message.identitySignature, "base64")
    );

    // Validate key lengths
    if (clientIdentityKey.length !== 32) return null;
    if (!validateX25519PublicKey(clientKeyExchangeKey)) return null;
    if (identitySignature.length !== 64) return null; // Ed25519 signature is 64 bytes

    // Compute triple DH (server side)
    // DH1: server_signed_prekey × client_ephemeral
    const dh1 = x25519SharedSecret(
      state.signedPreKey.privateKey,
      state.clientEphemeralKey
    );

    // DH2: server_identity_keyexchange × client_ephemeral
    const dh2 = x25519SharedSecret(
      identity.keyExchange.privateKey,
      state.clientEphemeralKey
    );

    // DH3: server_ephemeral × client_ephemeral
    const dh3 = x25519SharedSecret(
      state.ephemeral.privateKey,
      state.clientEphemeralKey
    );

    // Derive session keys (server is NOT initiator)
    const salt = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
    salt.set(state.clientNonce, 0);
    salt.set(state.serverNonce, state.clientNonce.length);

    const sessionKeys = deriveSessionKeysFromMultiple(
      [dh1, dh2, dh3],
      salt,
      false // Server is NOT initiator
    );

    // Verify identity proof
    const transcript = new Uint8Array(
      state.clientNonce.length + state.serverNonce.length
    );
    transcript.set(state.clientNonce, 0);
    transcript.set(state.serverNonce, state.clientNonce.length);

    const expectedProof = createHmac("sha256", sessionKeys.receiveKey)
      .update(transcript)
      .digest();

    if (!arraysEqual(identityProof, expectedProof)) {
      return null;
    }

    // Verify identity signature - this proves the client possesses the signing key
    // Recreate signature transcript: clientEphemeral || serverEphemeral || clientNonce || serverNonce
    const signatureTranscript = new Uint8Array(
      state.clientEphemeralKey.length +
      state.ephemeral.publicKey.length +
      state.clientNonce.length +
      state.serverNonce.length
    );
    let sigOffset = 0;
    signatureTranscript.set(state.clientEphemeralKey, sigOffset);
    sigOffset += state.clientEphemeralKey.length;
    signatureTranscript.set(state.ephemeral.publicKey, sigOffset);
    sigOffset += state.ephemeral.publicKey.length;
    signatureTranscript.set(state.clientNonce, sigOffset);
    sigOffset += state.clientNonce.length;
    signatureTranscript.set(state.serverNonce, sigOffset);

    // Verify the signature using the client's claimed identity key
    const isValidSignature = verify(signatureTranscript, identitySignature, clientIdentityKey);
    if (!isValidSignature) {
      return null; // Client cannot prove they own the signing key
    }

    // Derive peer identity ID
    const peerIdentityId = deriveIdentityId(clientIdentityKey);

    // A valid device certificate is mandatory for all authorization modes.
    if (!message.deviceCertificate) {
      return null;
    }

    // Verify device certificate
    let userRootId: string | undefined;
    try {
      const cert: DeviceCertificate = JSON.parse(message.deviceCertificate);

      // Verify the certificate signature
      if (!verifyDeviceCertificate(cert)) {
        return null; // Invalid certificate signature — reject handshake
      }

      // Check certificate expiry
      if (isDeviceCertExpired(cert)) {
        return null; // Expired certificate — reject handshake
      }

      // Reject self-signed certs where the device key IS the root key.
      // A correctly-issued device cert must have deviceSigningPublicKey !== userRootSigningPublicKey.
      // Self-signed certs collapse root/device separation and are not permitted.
      if (cert.deviceSigningPublicKey === cert.userRootSigningPublicKey) {
        return null; // Self-root-as-device cert — reject handshake
      }

      // Verify the certificate's device signing key matches the client's identity key
      const certDeviceSigningKey = new Uint8Array(Buffer.from(cert.deviceSigningPublicKey, 'base64'));
      if (!arraysEqual(certDeviceSigningKey, clientIdentityKey)) {
        return null; // Certificate doesn't match client identity — reject handshake
      }

      // Certificate is valid and matches — extract user root ID
      userRootId = getUserRootIdFromCert(cert);
    } catch {
      // Malformed certificate JSON — reject handshake
      return null;
    }

    return {
      peerIdentityId,
      authorization: message.authorization,
      clientIdentityKey,
      clientKeyExchangeKey,
      userRootId,
    };
  } catch {
    return null;
  }
}

/**
 * Create ServerAuth response
 *
 * Sends the server's identity proof and authorization result.
 * Also computes and returns the session keys for the established session.
 *
 * @param identity - Server's identity
 * @param state - Current server state
 * @param clientIdentityKey - Client's identity public key (from processClientAuth)
 * @param result - Authorization result (accepted or rejected)
 * @returns ServerAuth message and session keys
 * @throws {Error} If state is invalid or key derivation fails
 *
 * @example
 * ```typescript
 * const permissions = { read: true, write: true, manage: false };
 * const { message, sessionKeys } = createServerAuth(
 *   machineIdentity,
 *   state,
 *   clientIdentityKey,
 *   { type: "accepted", permissions }
 * );
 * await relay.send(message);
 * // Store sessionKeys for this session
 * sessions.set(sessionId, sessionKeys);
 * ```
 */
export function createServerAuth(
  identity: Identity,
  state: X3DHServerState,
  _clientIdentityKey: Uint8Array,
  result: X3DHResultMessage["result"]
): { message: X3DHResultMessage; sessionKeys: SessionKeys } {
  // Ensure we have client keys
  if (!state.clientEphemeralKey || !state.clientNonce) {
    throw new Error("Missing client keys in state");
  }

  // Compute triple DH (same as in processClientAuth)
  const dh1 = x25519SharedSecret(
    state.signedPreKey.privateKey,
    state.clientEphemeralKey
  );
  const dh2 = x25519SharedSecret(
    identity.keyExchange.privateKey,
    state.clientEphemeralKey
  );
  const dh3 = x25519SharedSecret(
    state.ephemeral.privateKey,
    state.clientEphemeralKey
  );

  // Derive session keys
  const salt = new Uint8Array(state.clientNonce.length + state.serverNonce.length);
  salt.set(state.clientNonce, 0);
  salt.set(state.serverNonce, state.clientNonce.length);

  const sessionKeys = deriveSessionKeysFromMultiple(
    [dh1, dh2, dh3],
    salt,
    false // Server is NOT initiator
  );

  // Create identity proof
  const transcript = new Uint8Array(
    state.clientNonce.length + state.serverNonce.length
  );
  transcript.set(state.clientNonce, 0);
  transcript.set(state.serverNonce, state.clientNonce.length);

  const identityProof = createHmac("sha256", sessionKeys.sendKey)
    .update(transcript)
    .digest();

  const message: X3DHResultMessage = {
    version: PROTOCOL_VERSION,
    identityKey: Buffer.from(identity.signing.publicKey).toString("base64"),
    identityProof: Buffer.from(identityProof).toString("base64"),
    result,
  };

  return { message, sessionKeys };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Compare two Uint8Arrays for equality (constant-time)
 *
 * @param a - First array
 * @param b - Second array
 * @returns True if arrays are equal, false otherwise
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}
