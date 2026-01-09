/**
 * Type definitions for identity and access control
 */

// ============================================================================
// Keypair Types
// ============================================================================

/** Ed25519 signing keypair */
export interface SigningKeypair {
  /** 32-byte public key */
  publicKey: Uint8Array;
  /** 64-byte secret key (includes public key suffix per Ed25519 convention) */
  secretKey: Uint8Array;
}

/** X25519 key exchange keypair */
export interface KeyExchangeKeypair {
  /** 32-byte public key */
  publicKey: Uint8Array;
  /** 32-byte private key */
  privateKey: Uint8Array;
}

// ============================================================================
// Identity Types
// ============================================================================

/** Complete identity (signing + key exchange) */
export interface Identity {
  /** Unique identifier derived from signing public key (first 16 chars of base64url) */
  id: string;
  /** Ed25519 keypair for signing */
  signing: SigningKeypair;
  /** X25519 keypair for key exchange */
  keyExchange: KeyExchangeKeypair;
  /** Human-readable label */
  label?: string;
  /** Creation timestamp (Unix ms) */
  createdAt: number;
}

/** Serializable identity for JSON storage (base64 encoded keys) */
export interface StoredIdentity {
  id: string;
  signingPublicKey: string;
  /** Encrypted with password-derived key */
  signingSecretKey: string;
  keyExchangePublicKey: string;
  /** Encrypted with password-derived key */
  keyExchangePrivateKey: string;
  label?: string;
  createdAt: number;
}

/** Public identity info (safe to share) */
export interface PublicIdentity {
  id: string;
  signingPublicKey: string;
  keyExchangePublicKey: string;
  label?: string;
}

// ============================================================================
// Access Control Types
// ============================================================================

/**
 * Access type for a client
 * - 'full': Complete machine access (browse, create sessions, etc.)
 * - 'session-invite': View-only access to a specific session
 */
export type AccessType = 'full' | 'session-invite';

/**
 * @deprecated Use AccessType instead. Kept for backwards compatibility during migration.
 */
export interface AccessPermissions {
  /** Can read terminal output */
  read: boolean;
  /** Can send terminal input */
  write: boolean;
  /** Can manage sessions (create/kill) */
  manage: boolean;
}

/** Helper to convert AccessType to legacy AccessPermissions */
export function accessTypeToPermissions(accessType: AccessType): AccessPermissions {
  if (accessType === 'full') {
    return { read: true, write: true, manage: true };
  }
  // session-invite is read-only
  return { read: true, write: false, manage: false };
}

/** Helper to convert legacy AccessPermissions to AccessType */
export function permissionsToAccessType(permissions: AccessPermissions): AccessType {
  if (permissions.write || permissions.manage) {
    return 'full';
  }
  return 'session-invite';
}

/** Access list entry for authorized public keys */
export interface AccessEntry {
  /** Identity ID (derived from signing public key) */
  identityId: string;
  /** Public signing key (base64) */
  signingPublicKey: string;
  /** Public key exchange key (base64) */
  keyExchangePublicKey: string;
  /** Human-readable label */
  label?: string;
  /** When access was granted (Unix ms) */
  grantedAt: number;
  /** Access type granted */
  accessType: AccessType;
  /** Optional expiry time (Unix ms) */
  expiresAt?: number;
  /** For session-invite: the specific session ID this grants access to */
  sessionId?: string;
}

// ============================================================================
// Invite Token Types
// ============================================================================

/** Signed invite token for sharing access */
export interface InviteToken {
  /** Token version */
  version: 1;
  /** Machine's identity ID */
  machineId: string;
  /** Machine's public signing key (base64) */
  machineSigningKey: string;
  /** Machine's public key exchange key (base64) */
  machineKeyExchangeKey: string;
  /** Relay URL to connect */
  relayUrl: string;
  /** Access type being granted */
  accessType: AccessType;
  /** For session-invite: the specific session ID */
  sessionId?: string;
  /** Expiry timestamp (Unix ms) */
  expiresAt: number;
  /** Single use? */
  singleUse: boolean;
  /** Signature over token data (base64) */
  signature: string;
}

/** Options for creating an invite token */
export interface CreateInviteOptions {
  /** Access type to grant (default: 'session-invite') */
  accessType?: AccessType;
  /** For session-invite: the specific session ID */
  sessionId?: string;
  /** Validity duration in milliseconds */
  validityMs?: number;
  /** Whether invite can only be used once */
  singleUse?: boolean;
}

// ============================================================================
// Session Key Types
// ============================================================================

/** Derived session keys from handshake */
export interface SessionKeys {
  /** Key for encrypting data we send (32 bytes) */
  sendKey: Uint8Array;
  /** Key for decrypting data we receive (32 bytes) */
  receiveKey: Uint8Array;
  /** Session ID (for key rotation tracking) */
  sessionId: string;
}

// ============================================================================
// Handshake Message Types
// ============================================================================

/** X3DH handshake initiation message from client */
export interface X3DHInitMessage {
  /** Protocol version */
  version: 1;
  /** Client's ephemeral X25519 public key (base64) */
  ephemeralKey: string;
  /** Timestamp for replay protection (Unix ms) */
  timestamp: number;
  /** Client nonce (base64, 32 bytes random) */
  clientNonce: string;
  /** Optional: Machine ID hint for routing */
  machineIdHint?: string;
}

/** X3DH response message from machine */
export interface X3DHResponseMessage {
  /** Protocol version */
  version: 1;
  /** Machine's identity public key - Ed25519 (base64) */
  identityKey: string;
  /** Machine's key exchange public key - X25519 (base64) */
  keyExchangeKey: string;
  /** Machine's ephemeral X25519 public key (base64) */
  ephemeralKey: string;
  /** Machine's signed pre-key - X25519 (base64) */
  signedPreKey: string;
  /** Signature over signedPreKey using identity key (base64) */
  preKeySignature: string;
  /** Server nonce (base64, 32 bytes random) */
  serverNonce: string;
  /** Timestamp (Unix ms) */
  timestamp: number;
}

/** Client authentication message */
export interface X3DHAuthMessage {
  /** Protocol version */
  version: 1;
  /** Client's identity public key - Ed25519 (base64) */
  identityKey: string;
  /** Client's key exchange public key - X25519 (base64) */
  keyExchangeKey: string;
  /** HMAC proof binding client identity to session (base64) */
  identityProof: string;
  /**
   * Ed25519 signature over handshake transcript proving key ownership (base64).
   * Signs: clientEphemeral || serverEphemeral || clientNonce || serverNonce
   * This proves the client possesses the private key for identityKey.
   */
  identitySignature: string;
  /** Authorization type and data */
  authorization:
    | { type: "access_list" }
    | { type: "invite"; inviteToken: string };
}

/** Server authentication/result message */
export interface X3DHResultMessage {
  /** Protocol version */
  version: 1;
  /** Machine's identity public key (base64) */
  identityKey: string;
  /** HMAC proof binding machine identity to session (base64) */
  identityProof: string;
  /** Authorization result */
  result:
    | { type: "accepted"; accessType: AccessType; sessionId?: string }
    | { type: "rejected"; reason: string };
}

/** Handshake state phases */
export type HandshakePhase =
  | "idle"
  | "awaiting_server_hello"
  | "awaiting_client_auth"
  | "awaiting_server_auth"
  | "established"
  | "failed";

/** Handshake result on success */
export interface X3DHHandshakeResult {
  sessionKeys: SessionKeys;
  peerIdentityId: string;
  accessType: AccessType;
  /** For session-invite: the specific session ID access was granted to */
  sessionId?: string;
}

// ============================================================================
// Machine Identity Types
// ============================================================================

/** Machine identity configuration stored locally */
export interface MachineIdentity {
  /** Unique machine ID (same as identity.id) */
  machineId: string;
  /** Human-readable machine name */
  machineName: string;
  /** Relay server URL this machine uses */
  relayUrl: string;
  /** ISO timestamp when registered */
  registeredAt: string;
}
