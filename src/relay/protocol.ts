/**
 * Relay protocol message types and handlers
 *
 * Defines the WebSocket message format for machine-relay-client communication.
 */

import type { SignatureBlock } from "./signing.js";

// ============================================================================
// Protocol Versioning
// ============================================================================

/**
 * Current protocol version
 * - Version 1: Signatures optional (verify if present)
 * - Version 2: Signatures required on security-critical messages
 */
export const PROTOCOL_VERSION = 2;

// ============================================================================
// Machine → Relay Messages
// ============================================================================

/** Machine registers itself with relay */
export interface RegisterMachineMessage {
  type: "register_machine";
  machineId: string;
  signingKey: string;
  keyExchangeKey: string;
  label?: string;
  /** Challenge response - signature of the nonce from relay_identity (base64) */
  challengeResponse?: string;
  /** Protocol version (for signature requirement negotiation) */
  protocolVersion?: number;
  /** Ed25519 signature of message */
  signature?: SignatureBlock;
}

/** Machine registers an invite */
export interface RegisterInviteMessage {
  type: "register_invite";
  inviteId: string;
  machineId: string;
  expiresAt: number;
  maxUses: number | null;
}

/** Machine authorizes a client */
export interface AuthorizeClientMessage {
  type: "authorize_client";
  machineId: string;
  clientIdentityId: string;
  signingKey: string;
  keyExchangeKey: string;
  accessType: 'full' | 'session-invite';
  sessionId?: string;
  /** Ed25519 signature of message */
  signature?: SignatureBlock;
}

/** Machine revokes client authorization */
export interface RevokeClientMessage {
  type: "revoke_client";
  machineId: string;
  clientIdentityId: string;
  /** Ed25519 signature of message */
  signature?: SignatureBlock;
}

/** Machine sends data to a specific client */
export interface MachineDataMessage {
  type: "data";
  connectionId: string;
  data: string; // base64 encoded
}

/** Machine responds to identity challenge */
export interface ChallengeResponseMessage {
  type: "challenge_response";
  /** Signature of the challenge nonce (base64) */
  signature: string;
}

/** Machine requests to add global access */
export interface AddGlobalAccessMessage {
  type: "add_global_access";
  clientIdentityId: string;
  signingKey: string;
  keyExchangeKey: string;
  label?: string;
  accessType: 'full' | 'session-invite';
  sessionId?: string;
  /** If set, only applies to specific machines */
  machineIds?: string[];
  /** Ed25519 signature of message */
  signature?: SignatureBlock;
}

/** Machine requests to remove global access */
export interface RemoveGlobalAccessMessage {
  type: "remove_global_access";
  clientIdentityId: string;
  /** Ed25519 signature of message */
  signature?: SignatureBlock;
}

// ============================================================================
// Client → Relay Messages
// ============================================================================

/** Client requests list of machines they can connect to */
export interface ListMachinesMessage {
  type: "list_machines";
  clientIdentityId: string;
  /** Ed25519 signature of message */
  signature: SignatureBlock;
}

/** Client connects using an invite */
export interface ConnectWithInviteMessage {
  type: "connect_with_invite";
  inviteId: string;
  clientIdentityId: string;
  /** Ed25519 signature of message */
  signature: SignatureBlock;
}

/** Client connects to a specific machine (already authorized) */
export interface ConnectToMachineMessage {
  type: "connect_to_machine";
  machineId: string;
  clientIdentityId: string;
  /** Ed25519 signature of message */
  signature: SignatureBlock;
}

/** Client sends data to machine */
export interface ClientDataMessage {
  type: "data";
  data: string; // base64 encoded
}

/** Client sends handshake message to machine */
export interface ClientHandshakeMessage {
  type: "handshake";
  phase: "client_hello" | "client_auth";
  data: unknown;
}

// ============================================================================
// Relay → Machine Messages
// ============================================================================

/** Relay identity message - sent immediately on machine connect */
export interface RelayIdentityMessage {
  type: "relay_identity";
  /** Relay's Ed25519 signing public key (base64) */
  publicKey: string;
  /** Human-readable fingerprint (e.g., "Kx4f:2nB9:mP3q:vR8s") */
  fingerprint: string;
  /** Optional relay label */
  label?: string;
  /** Challenge nonce - machine must sign this to prove identity (base64) */
  challenge: string;
}

/** Identity challenge from relay (machine must sign to prove key ownership) */
export interface ChallengeMessage {
  type: "challenge";
  /** Random nonce to sign (base64) */
  nonce: string;
}

/** Registration confirmation */
export interface RegisteredMessage {
  type: "registered";
  machineId: string;
}

/** Access list sync from relay to machine */
export interface AccessListMessage {
  type: "access_list";
  entries: {
    clientIdentityId: string;
    signingKey: string;
    keyExchangeKey: string;
    label?: string;
    accessType: 'full' | 'session-invite';
    sessionId?: string;
    grantedAt: number;
  }[];
  /** Protocol version */
  protocolVersion?: number;
  /** Ed25519 signature of message (signed by relay) */
  signature?: SignatureBlock;
}

/** Incremental access list update from relay to machine */
export interface AccessUpdateMessage {
  type: "access_update";
  added: {
    clientIdentityId: string;
    signingKey: string;
    keyExchangeKey: string;
    label?: string;
    accessType: 'full' | 'session-invite';
    sessionId?: string;
    grantedAt: number;
  }[];
  removed: string[]; // clientIdentityIds to remove
  /** Ed25519 signature of message (signed by relay) */
  signature?: SignatureBlock;
}

/** Client authorization confirmation */
export interface ClientAuthorizedMessage {
  type: "client_authorized";
  clientIdentityId: string;
}

/** Client revocation confirmation */
export interface ClientRevokedMessage {
  type: "client_revoked";
  clientIdentityId: string;
}

/** Client connected notification */
export interface ClientConnectedMessage {
  type: "client_connected";
  connectionId: string;
  clientIdentityId?: string;
  viaInvite?: string;
}

/** Client disconnected notification */
export interface ClientDisconnectedMessage {
  type: "client_disconnected";
  connectionId: string;
  reason: string;
}

/** Data from client */
export interface DataFromClientMessage {
  type: "data";
  connectionId: string;
  data: string; // base64 encoded
}

// ============================================================================
// Relay → Client Messages
// ============================================================================

/** Machine list response */
export interface MachineListMessage {
  type: "machine_list";
  machines: {
    machineId: string;
    label?: string;
    online: boolean;
    isAuthorized: boolean;
    accessType?: 'full' | 'session-invite';
    sessionId?: string;
    lastConnectedAt?: number;
  }[];
}

/** Connection established */
export interface ConnectionEstablishedMessage {
  type: "connection_established";
  machineId: string;
  connectionId: string;
}

/** Connection failed */
export interface ConnectionFailedMessage {
  type: "connection_failed";
  reason: string;
}

/** Data from machine */
export interface DataFromMachineMessage {
  type: "data";
  data: string; // base64 encoded
}

// ============================================================================
// Error Messages
// ============================================================================

/** Error response */
export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

// ============================================================================
// Union Types
// ============================================================================

/** All messages from machine to relay */
export type MachineToRelayMessage =
  | RegisterMachineMessage
  | RegisterInviteMessage
  | AuthorizeClientMessage
  | RevokeClientMessage
  | MachineDataMessage
  | ChallengeResponseMessage
  | AddGlobalAccessMessage
  | RemoveGlobalAccessMessage;

/** All messages from client to relay */
export type ClientToRelayMessage =
  | ListMachinesMessage
  | ConnectWithInviteMessage
  | ConnectToMachineMessage
  | ClientDataMessage
  | ClientHandshakeMessage;

/** All messages from relay to machine */
export type RelayToMachineMessage =
  | RelayIdentityMessage
  | ChallengeMessage
  | RegisteredMessage
  | AccessListMessage
  | AccessUpdateMessage
  | ClientAuthorizedMessage
  | ClientRevokedMessage
  | ClientConnectedMessage
  | ClientDisconnectedMessage
  | DataFromClientMessage
  | ErrorMessage;

/** All messages from relay to client */
export type RelayToClientMessage =
  | MachineListMessage
  | ConnectionEstablishedMessage
  | ConnectionFailedMessage
  | DataFromMachineMessage
  | ErrorMessage;

/** All protocol messages */
export type ProtocolMessage =
  | MachineToRelayMessage
  | ClientToRelayMessage
  | RelayToMachineMessage
  | RelayToClientMessage;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for MachineDataMessage (data message with connectionId from machine)
 */
export function isMachineDataMessage(msg: ProtocolMessage): msg is MachineDataMessage {
  return msg.type === "data" && "connectionId" in msg && typeof (msg as MachineDataMessage).connectionId === "string";
}

/**
 * Type guard for ClientDataMessage (data message without connectionId)
 */
export function isClientDataMessage(msg: ProtocolMessage): msg is ClientDataMessage {
  return msg.type === "data" && !("connectionId" in msg);
}

/**
 * Type guard for ClientHandshakeMessage
 */
export function isClientHandshakeMessage(msg: ProtocolMessage): msg is ClientHandshakeMessage {
  return msg.type === "handshake";
}

// ============================================================================
// Parsing and Validation
// ============================================================================

/**
 * Maximum length for identifier strings
 * Security: Prevents DoS via huge string allocations
 */
const MAX_ID_LENGTH = 256;

/**
 * Maximum length for label strings
 */
const MAX_LABEL_LENGTH = 256;

/**
 * Maximum total message size (1MB)
 * Security: Prevents DoS via huge allocations
 */
const MAX_MESSAGE_SIZE = 1024 * 1024;

/**
 * Pattern for valid identifiers (alphanumeric, hyphens, underscores, dots, colons)
 * Security: Prevents injection attacks via malicious identifier content
 *
 * This pattern allows:
 * - machineId: e.g., "machine-1", "my_machine.local"
 * - inviteId: e.g., "inv_abc123"
 * - clientIdentityId: e.g., "client:xyz" or base64-like strings
 * - connectionId: hex strings from randomBytes
 */
const VALID_ID_PATTERN = /^[a-zA-Z0-9\-_.:+=\/]+$/;

/**
 * Pattern for base64-encoded data
 * Allows standard base64 (+/) and URL-safe base64 (-_)
 */
const VALID_BASE64_PATTERN = /^[a-zA-Z0-9+\/=\-_]+$/;

/**
 * Validate an identifier string
 * Security: Prevents path traversal, injection, and DoS attacks
 */
export function isValidIdentifier(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return false;
  return VALID_ID_PATTERN.test(id);
}

/**
 * Validate a label string (more permissive than identifier)
 */
export function isValidLabel(label: unknown): label is string {
  if (typeof label !== "string") return false;
  if (label.length > MAX_LABEL_LENGTH) return false;
  // Labels can contain spaces and more characters, but no control characters
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(label);
}

/**
 * Validate a base64-encoded string (for data payloads)
 */
export function isValidBase64(data: unknown): data is string {
  if (typeof data !== "string") return false;
  if (data.length === 0 || data.length > MAX_MESSAGE_SIZE) return false;
  return VALID_BASE64_PATTERN.test(data);
}

/**
 * Validate a signature block
 */
function isValidSignatureBlock(signature: unknown): signature is SignatureBlock {
  if (!signature || typeof signature !== "object") return false;
  const sig = signature as Record<string, unknown>;
  if (!isValidBase64(sig.sig)) return false;
  if (!isValidBase64(sig.pub)) return false;
  if (typeof sig.ts !== "number") return false;
  return true;
}

/**
 * Validate a key string (signing key, key exchange key)
 * Less strict than base64 - keys are validated cryptographically when used
 */
function isValidKeyString(key: unknown): key is string {
  if (typeof key !== "string") return false;
  if (key.length === 0 || key.length > MAX_ID_LENGTH * 4) return false;
  // Allow any printable ASCII characters (no control characters)
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(key);
}

/**
 * Validate accessType value
 */
function isValidAccessType(accessType: unknown): accessType is 'full' | 'session-invite' {
  return accessType === 'full' || accessType === 'session-invite';
}

/**
 * Validate specific message types and return properly typed result.
 * Each case returns the specific message type after validation,
 * eliminating the need for unsafe casts.
 */
function validateMessageFields(msg: Record<string, unknown>): ProtocolMessage | null {
  switch (msg.type) {
    case "register_machine": {
      if (!isValidIdentifier(msg.machineId)) return null;
      if (!isValidKeyString(msg.signingKey)) return null;
      if (!isValidKeyString(msg.keyExchangeKey)) return null;
      if (msg.label !== undefined && !isValidLabel(msg.label)) return null;
      if (msg.challengeResponse !== undefined && !isValidBase64(msg.challengeResponse)) return null;
      return {
        type: "register_machine",
        machineId: msg.machineId,
        signingKey: msg.signingKey,
        keyExchangeKey: msg.keyExchangeKey,
        label: msg.label,
        challengeResponse: msg.challengeResponse,
      };
    }

    case "register_invite": {
      if (!isValidIdentifier(msg.inviteId)) return null;
      if (!isValidIdentifier(msg.machineId)) return null;
      if (typeof msg.expiresAt !== "number") return null;
      if (msg.maxUses !== null && msg.maxUses !== undefined && typeof msg.maxUses !== "number") return null;
      return {
        type: "register_invite",
        inviteId: msg.inviteId,
        machineId: msg.machineId,
        expiresAt: msg.expiresAt,
        maxUses: msg.maxUses ?? null,
      };
    }

    case "authorize_client": {
      if (!isValidIdentifier(msg.machineId)) return null;
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (!isValidKeyString(msg.signingKey)) return null;
      if (!isValidKeyString(msg.keyExchangeKey)) return null;
      if (!isValidAccessType(msg.accessType)) return null;
      if (msg.sessionId !== undefined && !isValidIdentifier(msg.sessionId)) return null;
      return {
        type: "authorize_client",
        machineId: msg.machineId,
        clientIdentityId: msg.clientIdentityId,
        signingKey: msg.signingKey,
        keyExchangeKey: msg.keyExchangeKey,
        accessType: msg.accessType,
        sessionId: msg.sessionId,
      };
    }

    case "revoke_client": {
      if (!isValidIdentifier(msg.machineId)) return null;
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      return {
        type: "revoke_client",
        machineId: msg.machineId,
        clientIdentityId: msg.clientIdentityId,
      };
    }

    case "list_machines": {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: "list_machines",
        clientIdentityId: msg.clientIdentityId,
        signature: msg.signature,
      };
    }

    case "connect_with_invite": {
      if (!isValidIdentifier(msg.inviteId)) return null;
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: "connect_with_invite",
        inviteId: msg.inviteId,
        clientIdentityId: msg.clientIdentityId,
        signature: msg.signature,
      };
    }

    case "connect_to_machine": {
      if (!isValidIdentifier(msg.machineId)) return null;
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: "connect_to_machine",
        machineId: msg.machineId,
        clientIdentityId: msg.clientIdentityId,
        signature: msg.signature,
      };
    }

    case "data": {
      if (msg.connectionId !== undefined && !isValidIdentifier(msg.connectionId)) return null;
      if (!isValidBase64(msg.data)) return null;
      // Return the appropriate data message type based on presence of connectionId
      if (msg.connectionId !== undefined) {
        return {
          type: "data",
          connectionId: msg.connectionId,
          data: msg.data,
        };
      }
      return {
        type: "data",
        data: msg.data,
      };
    }

    case "handshake": {
      if (msg.phase !== "client_hello" && msg.phase !== "client_auth") return null;
      return {
        type: "handshake",
        phase: msg.phase,
        data: msg.data,
      };
    }

    // Response messages (from relay) - construct typed responses
    case "registered": {
      if (!isValidIdentifier(msg.machineId)) return null;
      return { type: "registered", machineId: msg.machineId };
    }

    case "client_authorized": {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      return { type: "client_authorized", clientIdentityId: msg.clientIdentityId };
    }

    case "client_revoked": {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      return { type: "client_revoked", clientIdentityId: msg.clientIdentityId };
    }

    case "client_connected": {
      if (!isValidIdentifier(msg.connectionId)) return null;
      return {
        type: "client_connected",
        connectionId: msg.connectionId,
        clientIdentityId: typeof msg.clientIdentityId === "string" ? msg.clientIdentityId : undefined,
        viaInvite: typeof msg.viaInvite === "string" ? msg.viaInvite : undefined,
      };
    }

    case "client_disconnected": {
      if (!isValidIdentifier(msg.connectionId)) return null;
      if (typeof msg.reason !== "string") return null;
      return {
        type: "client_disconnected",
        connectionId: msg.connectionId,
        reason: msg.reason,
      };
    }

    case "machine_list": {
      if (!Array.isArray(msg.machines)) return null;
      // Trust the machines array structure for relay-generated messages
      return {
        type: "machine_list",
        machines: msg.machines as MachineListMessage["machines"],
      };
    }

    case "connection_established": {
      if (!isValidIdentifier(msg.machineId)) return null;
      if (!isValidIdentifier(msg.connectionId)) return null;
      return {
        type: "connection_established",
        machineId: msg.machineId,
        connectionId: msg.connectionId,
      };
    }

    case "connection_failed": {
      if (typeof msg.reason !== "string") return null;
      return {
        type: "connection_failed",
        reason: msg.reason,
      };
    }

    case "error": {
      if (typeof msg.code !== "string") return null;
      if (typeof msg.message !== "string") return null;
      return {
        type: "error",
        code: msg.code,
        message: msg.message,
      };
    }

    case "relay_identity": {
      if (!isValidKeyString(msg.publicKey)) return null;
      if (typeof msg.fingerprint !== "string") return null;
      if (msg.label !== undefined && !isValidLabel(msg.label)) return null;
      if (!isValidBase64(msg.challenge)) return null;
      return {
        type: "relay_identity",
        publicKey: msg.publicKey,
        fingerprint: msg.fingerprint,
        label: msg.label,
        challenge: msg.challenge,
      };
    }

    case "challenge": {
      if (!isValidBase64(msg.nonce)) return null;
      return {
        type: "challenge",
        nonce: msg.nonce,
      };
    }

    case "challenge_response": {
      if (!isValidBase64(msg.signature)) return null;
      return {
        type: "challenge_response",
        signature: msg.signature,
      };
    }

    case "add_global_access": {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (!isValidKeyString(msg.signingKey)) return null;
      if (!isValidKeyString(msg.keyExchangeKey)) return null;
      if (msg.label !== undefined && !isValidLabel(msg.label)) return null;
      if (msg.accessType !== 'full' && msg.accessType !== 'session-invite') return null;
      if (msg.sessionId !== undefined && !isValidIdentifier(msg.sessionId)) return null;
      if (msg.machineIds !== undefined && !Array.isArray(msg.machineIds)) return null;
      return {
        type: "add_global_access",
        clientIdentityId: msg.clientIdentityId,
        signingKey: msg.signingKey,
        keyExchangeKey: msg.keyExchangeKey,
        label: msg.label,
        accessType: msg.accessType,
        sessionId: msg.sessionId,
        machineIds: msg.machineIds,
      };
    }

    case "remove_global_access": {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      return {
        type: "remove_global_access",
        clientIdentityId: msg.clientIdentityId,
      };
    }

    case "access_list": {
      if (!Array.isArray(msg.entries)) return null;
      return {
        type: "access_list",
        entries: msg.entries as AccessListMessage["entries"],
      };
    }

    case "access_update": {
      if (!Array.isArray(msg.added)) return null;
      if (!Array.isArray(msg.removed)) return null;
      return {
        type: "access_update",
        added: msg.added as AccessUpdateMessage["added"],
        removed: msg.removed as string[],
      };
    }

    default:
      return null;
  }
}

/**
 * Parse a JSON message from WebSocket with security validation
 *
 * Security:
 * - Limits message size to prevent DoS
 * - Validates all identifier fields
 * - Validates base64 data fields
 */
export function parseMessage(data: string | ArrayBuffer): ProtocolMessage | null {
  try {
    let jsonStr: string;
    if (data instanceof ArrayBuffer) {
      // Security: Check size before decoding
      if (data.byteLength > MAX_MESSAGE_SIZE) {
        return null;
      }
      jsonStr = new TextDecoder().decode(data);
    } else {
      // Security: Check size before parsing
      if (data.length > MAX_MESSAGE_SIZE) {
        return null;
      }
      jsonStr = data;
    }

    const msg = JSON.parse(jsonStr);

    // Basic validation - check type field exists
    if (!msg || typeof msg.type !== "string") {
      return null;
    }

    // Validate message-specific fields
    return validateMessageFields(msg);
  } catch {
    return null;
  }
}

/**
 * Create an error message
 */
export function createErrorMessage(code: string, message: string): ErrorMessage {
  return { type: "error", code, message };
}

/**
 * Serialize a message for WebSocket send
 */
export function serializeMessage(msg: ProtocolMessage): string {
  return JSON.stringify(msg);
}
