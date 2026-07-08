/**
 * Relay protocol message types and handlers
 *
 * Defines the WebSocket message format for machine-relay-client communication.
 */

import type { SignatureBlock } from "./signing.js";

export type SyncCategory =
  | "fundamental"
  | "integrations"
  | "project/workspace"
  | "preferences";

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
  /** One-time bootstrap token for first cloud-machine registration */
  bootstrapToken?: string;
  /** One-time register permit minted by unlock_request */
  registerPermit?: string;
  /** One-time relay-machine invite token for machine enrollment */
  enrollmentToken?: string;
  /** JSON-serialized device certificate signed by owner's user root identity.
   *  If present and valid, the relay can auto-authorize the machine when the
   *  certificate's userRootId matches the relay's owner. */
  deviceCertificate?: string;
  /** Ed25519 signature of message */
  signature?: SignatureBlock;
}

/** Machine requests identity unlock material using a one-time token */
export interface UnlockRequestMessage {
  type: 'unlock_request';
  workspaceId: string;
  unlockToken: string;
  /** Machine ephemeral X25519 public key (base64) */
  ephemeralKey: string;
}

/** Machine sends data to a specific client */
export interface MachineDataMessage {
  type: "data";
  connectionId: string;
  data: string; // base64 encoded
}

// ============================================================================
// Client → Relay Messages (Owner/Admin)
// ============================================================================

/**
 * Client (owner) unlocks the relay vault.
 *
 * The client proves ownership by providing an HMAC proof derived from the
 * user root private key and a challenge nonce. The relay then re-derives
 * the vault key and unlocks encrypted machine data.
 *
 * Flow:
 * 1. Client connects as role=client
 * 2. Client sends unlock_relay with userRootPublicKey + proof
 * 3. Relay verifies proof, derives vault key, unlocks vault
 * 4. Relay responds with unlock_relay_result
 */
export interface UnlockRelayMessage {
  type: "unlock_relay";
  /** Owner's user root Ed25519 signing public key (base64) */
  userRootPublicKey: string;
  /** HMAC-SHA256 proof: HMAC(relay_challenge, user_root_private_key) (base64) */
  proof: string;
  /** Ed25519 signature of message */
  signature: SignatureBlock;
}

// ============================================================================
// Client → Relay Messages (Regular)
// ============================================================================

/** Client requests list of machines they can connect to */
export interface ListMachinesMessage {
  type: "list_machines";
  clientIdentityId: string;
  /** JSON-serialized DeviceCertificate for user-root derivation */
  deviceCertificate: string;
  /** Ed25519 signature of message */
  signature: SignatureBlock;
}

/** Client connects to a specific machine (already authorized) */
export interface ConnectToMachineMessage {
  type: "connect_to_machine";
  machineId: string;
  clientIdentityId: string;
  /** JSON-serialized DeviceCertificate for user-root derivation */
  deviceCertificate: string;
  /** Ed25519 signature of message */
  signature: SignatureBlock;
}

/** Client creates a root-signed invite on the relay */
export interface CreateRootInviteMessage {
  type: 'create_root_invite';
  clientIdentityId: string;
  deviceCertificate: string;
  inviteToken: string;
  signature: SignatureBlock;
}

/** Client lists root-signed invites they own */
export interface ListRootInvitesMessage {
  type: 'list_root_invites';
  clientIdentityId: string;
  deviceCertificate: string;
  inviteType?: 'relay-machine';
  signature: SignatureBlock;
}

/** Client revokes a root-signed invite they own */
export interface RevokeRootInviteMessage {
  type: 'revoke_root_invite';
  clientIdentityId: string;
  deviceCertificate: string;
  inviteId: string;
  signature: SignatureBlock;
}

/** Compare local category revisions against relay revisions */
export interface OwnerSyncCompareMessage {
  type: 'owner_sync_compare';
  clientIdentityId: string;
  deviceCertificate: string;
  localRevisions?: Partial<Record<SyncCategory, number>>;
  signature: SignatureBlock;
}

/** Pull encrypted owner sync categories from relay */
export interface OwnerSyncPullMessage {
  type: 'owner_sync_pull';
  clientIdentityId: string;
  deviceCertificate: string;
  categories?: SyncCategory[];
  signature: SignatureBlock;
}

/** Acquire V1 global owner sync lock */
export interface OwnerSyncLockMessage {
  type: 'owner_sync_lock';
  clientIdentityId: string;
  deviceCertificate: string;
  scope: 'global';
  writerId: string;
  ttlMs?: number;
  signature: SignatureBlock;
}

/** Push encrypted owner sync category record */
export interface OwnerSyncPushMessage {
  type: 'owner_sync_push';
  clientIdentityId: string;
  deviceCertificate: string;
  lockId: string;
  record: {
    category: SyncCategory;
    expectedRevision: number;
    updatedAt: number;
    writerId: string;
    checksum: string;
    ciphertext: string;
  };
  signature: SignatureBlock;
}

/** Release V1 global owner sync lock */
export interface OwnerSyncUnlockMessage {
  type: 'owner_sync_unlock';
  clientIdentityId: string;
  deviceCertificate: string;
  lockId: string;
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

/** Unlock grant payload from relay to machine */
export interface UnlockGrantMessage {
  type: 'unlock_grant';
  workspaceId: string;
  tokenId: string;
  /** One-time permit required for register_machine */
  registerPermit: string;
  /** Sealed identity payload (base64) */
  ciphertext: string;
  /** Relay ephemeral X25519 public key (base64) */
  relayEphemeralKey: string;
  /** HKDF salt (base64) */
  salt: string;
  /** Register permit expiry timestamp */
  expiresAt: string;
}

/** Client connected notification */
export interface ClientConnectedMessage {
  type: "client_connected";
  connectionId: string;
  clientIdentityId?: string;
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

/** Vault unlock result */
export interface UnlockRelayResultMessage {
  type: "unlock_relay_result";
  success: boolean;
  /** Error message if success=false */
  error?: string;
  /** Number of machine unlock keys available after unlock */
  machineCount?: number;
}

/** Machine list response */
export interface MachineListMessage {
  type: "machine_list";
  machines: {
    machineId: string;
    label?: string;
    online: boolean;
    isAuthorized: boolean;
    accessType?: 'full';
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

/** Root invite created confirmation */
export interface RootInviteCreatedMessage {
  type: 'root_invite_created';
  inviteId: string;
}

/** Root invite revoked confirmation */
export interface RootInviteRevokedMessage {
  type: 'root_invite_revoked';
  inviteId: string;
}

/** Root invite list response */
export interface RootInviteListMessage {
  type: 'root_invite_list';
  invites: {
    inviteId: string;
    inviteType: 'relay-machine';
    relayUrl: string;
    label?: string;
    maxUses: number | null;
    usedCount: number;
    expiresAt: string;
    createdAt: string;
    revokedAt?: string;
    machineId?: string;
    targetMachineSigningKey?: string;
    targetMachineKeyExchangeKey?: string;
  }[];
}

/** Owner sync compare response */
export interface OwnerSyncCompareResultMessage {
  type: 'owner_sync_compare_result';
  serverRevisions: Record<SyncCategory, number>;
  changedCategories: SyncCategory[];
}

/** Owner sync pull response record */
export interface OwnerSyncRecordMessage {
  ownerUserRootId: string;
  category: SyncCategory;
  revision: number;
  updatedAt: number;
  writerId: string;
  checksum: string;
  ciphertext: string;
}

/** Owner sync pull response */
export interface OwnerSyncPullResultMessage {
  type: 'owner_sync_pull_result';
  records: OwnerSyncRecordMessage[];
}

/** Owner sync lock grant */
export interface OwnerSyncLockGrantedMessage {
  type: 'owner_sync_lock_granted';
  scope: 'global';
  lockId: string;
  expiresAt: number;
}

/** Owner sync push result */
export interface OwnerSyncPushResultMessage {
  type: 'owner_sync_push_result';
  category: SyncCategory;
  revision: number;
  updatedAt: number;
}

/** Owner sync unlock result */
export interface OwnerSyncUnlockResultMessage {
  type: 'owner_sync_unlock_result';
  released: boolean;
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
  | UnlockRequestMessage
  | MachineDataMessage;

/** All messages from client to relay */
export type ClientToRelayMessage =
  | UnlockRelayMessage
  | ListMachinesMessage
  | ConnectToMachineMessage
  | CreateRootInviteMessage
  | ListRootInvitesMessage
  | RevokeRootInviteMessage
  | OwnerSyncCompareMessage
  | OwnerSyncPullMessage
  | OwnerSyncLockMessage
  | OwnerSyncPushMessage
  | OwnerSyncUnlockMessage
  | ClientDataMessage
  | ClientHandshakeMessage;

/** All messages from relay to machine */
export type RelayToMachineMessage =
  | RelayIdentityMessage
  | ChallengeMessage
  | UnlockGrantMessage
  | RegisteredMessage
  | ClientConnectedMessage
  | ClientDisconnectedMessage
  | DataFromClientMessage
  | ErrorMessage;

/** All messages from relay to client */
export type RelayToClientMessage =
  | UnlockRelayResultMessage
  | MachineListMessage
  | ConnectionEstablishedMessage
  | ConnectionFailedMessage
  | RootInviteCreatedMessage
  | RootInviteRevokedMessage
  | RootInviteListMessage
  | OwnerSyncCompareResultMessage
  | OwnerSyncPullResultMessage
  | OwnerSyncLockGrantedMessage
  | OwnerSyncPushResultMessage
  | OwnerSyncUnlockResultMessage
  | DataFromMachineMessage
  | ErrorMessage;

/** All protocol messages */

/** Relay→machine: fetch the bytes behind a share link (artifact-share.ts).
 *  Deliberately NOT E2E — share links exist to serve unauthenticated
 *  browsers; the relay is trusted with exactly the shared bytes, per link. */
export interface ShareReadMessage {
  type: 'share_read';
  requestId: string;
  token: string;
  /** Renderer dependency fetch (validated against the cap scope machine-side). */
  subPath?: string;
}

/** Machine→relay: one chunk of a share read (final chunk sets done; errors
 *  set error and done). First chunk carries the response metadata. */
export interface ShareReadChunkMessage {
  type: 'share_read_chunk';
  requestId: string;
  seq: number;
  dataBase64?: string;
  done?: boolean;
  error?: string;
  contentType?: string;
  disposition?: string;
  fileName?: string;
  relPath?: string;
  pinnedCommit?: string;
  expiresAt?: number;
}

export type ProtocolMessage =
  | ShareReadMessage
  | ShareReadChunkMessage
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

function isSyncCategory(value: unknown): value is SyncCategory {
  return value === "fundamental"
    || value === "integrations"
    || value === "project/workspace"
    || value === "preferences";
}

function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidTimestampMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
      if (msg.protocolVersion !== undefined && typeof msg.protocolVersion !== 'number') return null;
      if (msg.bootstrapToken !== undefined && !isValidIdentifier(msg.bootstrapToken)) return null;
      if (msg.registerPermit !== undefined && !isValidIdentifier(msg.registerPermit)) return null;
      if (msg.enrollmentToken !== undefined && !isValidKeyString(msg.enrollmentToken)) return null;
      if (
        msg.deviceCertificate !== undefined
        && (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0)
      ) return null;
      return {
        type: "register_machine",
        machineId: msg.machineId,
        signingKey: msg.signingKey,
        keyExchangeKey: msg.keyExchangeKey,
        label: msg.label,
        challengeResponse: msg.challengeResponse,
        protocolVersion: msg.protocolVersion,
        bootstrapToken: msg.bootstrapToken,
        registerPermit: msg.registerPermit,
        enrollmentToken: msg.enrollmentToken,
        deviceCertificate: msg.deviceCertificate,
      };
    }

    case 'share_read': {
      if (!isValidIdentifier(msg.requestId)) return null;
      if (typeof msg.token !== 'string' || msg.token.length === 0 || msg.token.length > 8192) return null;
      if (msg.subPath !== undefined && (typeof msg.subPath !== 'string' || msg.subPath.length === 0 || msg.subPath.length > 1024 || msg.subPath.includes('..'))) return null;
      return { type: 'share_read', requestId: msg.requestId, token: msg.token, subPath: msg.subPath };
    }

    case 'share_read_chunk': {
      if (!isValidIdentifier(msg.requestId)) return null;
      if (typeof msg.seq !== 'number' || !Number.isFinite(msg.seq) || msg.seq < 0) return null;
      if (msg.dataBase64 !== undefined && !isValidBase64(msg.dataBase64)) return null;
      if (msg.done !== undefined && typeof msg.done !== 'boolean') return null;
      if (msg.error !== undefined && (typeof msg.error !== 'string' || msg.error.length > 512)) return null;
      if (msg.contentType !== undefined && (typeof msg.contentType !== 'string' || msg.contentType.length > 128)) return null;
      if (msg.disposition !== undefined && msg.disposition !== 'inline' && msg.disposition !== 'attachment') return null;
      if (msg.fileName !== undefined && (typeof msg.fileName !== 'string' || msg.fileName.length > 256)) return null;
      if (msg.relPath !== undefined && (typeof msg.relPath !== 'string' || msg.relPath.length > 1024)) return null;
      if (msg.pinnedCommit !== undefined && (typeof msg.pinnedCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(msg.pinnedCommit))) return null;
      if (msg.expiresAt !== undefined && typeof msg.expiresAt !== 'number') return null;
      return {
        type: 'share_read_chunk',
        requestId: msg.requestId,
        seq: msg.seq,
        dataBase64: msg.dataBase64,
        done: msg.done,
        error: msg.error,
        contentType: msg.contentType,
        disposition: msg.disposition as 'inline' | 'attachment' | undefined,
        fileName: msg.fileName,
        relPath: msg.relPath,
        pinnedCommit: msg.pinnedCommit,
        expiresAt: msg.expiresAt,
      };
    }

    case 'unlock_request': {
      if (!isValidIdentifier(msg.workspaceId)) return null;
      if (!isValidIdentifier(msg.unlockToken)) return null;
      if (!isValidBase64(msg.ephemeralKey)) return null;
      return {
        type: 'unlock_request',
        workspaceId: msg.workspaceId,
        unlockToken: msg.unlockToken,
        ephemeralKey: msg.ephemeralKey,
      };
    }

    case "list_machines": {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: "list_machines",
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        signature: msg.signature,
      };
    }

    case "connect_to_machine": {
      if (!isValidIdentifier(msg.machineId)) return null;
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: "connect_to_machine",
        machineId: msg.machineId,
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        signature: msg.signature,
      };
    }

    case 'create_root_invite': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidKeyString(msg.inviteToken)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: 'create_root_invite',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        inviteToken: msg.inviteToken,
        signature: msg.signature,
      };
    }

    case 'list_root_invites': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (msg.inviteType !== undefined && msg.inviteType !== 'relay-machine') {
        return null;
      }
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: 'list_root_invites',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        inviteType: msg.inviteType,
        signature: msg.signature,
      };
    }

    case 'revoke_root_invite': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidIdentifier(msg.inviteId)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: 'revoke_root_invite',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        inviteId: msg.inviteId,
        signature: msg.signature,
      };
    }

    case 'owner_sync_compare': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;

      if (msg.localRevisions !== undefined) {
        if (!msg.localRevisions || typeof msg.localRevisions !== 'object') return null;
        const localRevisions = msg.localRevisions as Record<string, unknown>;
        for (const [key, value] of Object.entries(localRevisions)) {
          if (!isSyncCategory(key)) return null;
          if (!isValidRevision(value)) return null;
        }
      }

      return {
        type: 'owner_sync_compare',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        localRevisions: msg.localRevisions as Partial<Record<SyncCategory, number>> | undefined,
        signature: msg.signature,
      };
    }

    case 'owner_sync_pull': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      if (msg.categories !== undefined) {
        if (!Array.isArray(msg.categories)) return null;
        for (const category of msg.categories) {
          if (!isSyncCategory(category)) return null;
        }
      }

      return {
        type: 'owner_sync_pull',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        categories: msg.categories as SyncCategory[] | undefined,
        signature: msg.signature,
      };
    }

    case 'owner_sync_lock': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (msg.scope !== 'global') return null;
      if (!isValidIdentifier(msg.writerId)) return null;
      if (msg.ttlMs !== undefined && (!isValidTimestampMs(msg.ttlMs) || msg.ttlMs === 0)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;

      return {
        type: 'owner_sync_lock',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        scope: 'global',
        writerId: msg.writerId,
        ttlMs: msg.ttlMs,
        signature: msg.signature,
      };
    }

    case 'owner_sync_push': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidIdentifier(msg.lockId)) return null;
      if (!msg.record || typeof msg.record !== 'object') return null;
      const record = msg.record as Record<string, unknown>;
      if (!isSyncCategory(record.category)) return null;
      if (!isValidRevision(record.expectedRevision)) return null;
      if (!isValidTimestampMs(record.updatedAt)) return null;
      if (!isValidIdentifier(record.writerId)) return null;
      if (!isValidKeyString(record.checksum)) return null;
      if (!isValidBase64(record.ciphertext)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;

      return {
        type: 'owner_sync_push',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        lockId: msg.lockId,
        record: {
          category: record.category,
          expectedRevision: record.expectedRevision,
          updatedAt: record.updatedAt,
          writerId: record.writerId,
          checksum: record.checksum,
          ciphertext: record.ciphertext,
        } as OwnerSyncPushMessage['record'],
        signature: msg.signature,
      };
    }

    case 'owner_sync_unlock': {
      if (!isValidIdentifier(msg.clientIdentityId)) return null;
      if (typeof msg.deviceCertificate !== 'string' || msg.deviceCertificate.length === 0) return null;
      if (!isValidIdentifier(msg.lockId)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;

      return {
        type: 'owner_sync_unlock',
        clientIdentityId: msg.clientIdentityId,
        deviceCertificate: msg.deviceCertificate,
        lockId: msg.lockId,
        signature: msg.signature,
      };
    }

    case "unlock_relay": {
      if (!isValidKeyString(msg.userRootPublicKey)) return null;
      if (!isValidBase64(msg.proof)) return null;
      if (!isValidSignatureBlock(msg.signature)) return null;
      return {
        type: "unlock_relay",
        userRootPublicKey: msg.userRootPublicKey,
        proof: msg.proof,
        signature: msg.signature,
      };
    }

    case "unlock_relay_result": {
      if (typeof msg.success !== "boolean") return null;
      if (msg.error !== undefined && typeof msg.error !== "string") return null;
      if (msg.machineCount !== undefined && typeof msg.machineCount !== "number") return null;
      return {
        type: "unlock_relay_result",
        success: msg.success,
        error: msg.error,
        machineCount: msg.machineCount,
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

    case "client_connected": {
      if (!isValidIdentifier(msg.connectionId)) return null;
      return {
        type: "client_connected",
        connectionId: msg.connectionId,
        clientIdentityId: typeof msg.clientIdentityId === "string" ? msg.clientIdentityId : undefined,
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

    case 'root_invite_created': {
      if (!isValidIdentifier(msg.inviteId)) return null;
      return {
        type: 'root_invite_created',
        inviteId: msg.inviteId,
      };
    }

    case 'root_invite_revoked': {
      if (!isValidIdentifier(msg.inviteId)) return null;
      return {
        type: 'root_invite_revoked',
        inviteId: msg.inviteId,
      };
    }

    case 'root_invite_list': {
      if (!Array.isArray(msg.invites)) return null;
      return {
        type: 'root_invite_list',
        invites: msg.invites as RootInviteListMessage['invites'],
      };
    }

    case 'owner_sync_compare_result': {
      if (!msg.serverRevisions || typeof msg.serverRevisions !== 'object') return null;
      const revisions = msg.serverRevisions as Record<string, unknown>;
      for (const [key, value] of Object.entries(revisions)) {
        if (!isSyncCategory(key)) return null;
        if (!isValidRevision(value)) return null;
      }
      if (!Array.isArray(msg.changedCategories)) return null;
      for (const category of msg.changedCategories) {
        if (!isSyncCategory(category)) return null;
      }
      return {
        type: 'owner_sync_compare_result',
        serverRevisions: revisions as Record<SyncCategory, number>,
        changedCategories: msg.changedCategories as SyncCategory[],
      };
    }

    case 'owner_sync_pull_result': {
      if (!Array.isArray(msg.records)) return null;
      for (const record of msg.records) {
        if (!record || typeof record !== 'object') return null;
        const row = record as Record<string, unknown>;
        if (!isValidIdentifier(row.ownerUserRootId)) return null;
        if (!isSyncCategory(row.category)) return null;
        if (!isValidRevision(row.revision)) return null;
        if (!isValidTimestampMs(row.updatedAt)) return null;
        if (!isValidIdentifier(row.writerId)) return null;
        if (!isValidKeyString(row.checksum)) return null;
        if (!isValidBase64(row.ciphertext)) return null;
      }
      return {
        type: 'owner_sync_pull_result',
        records: msg.records as OwnerSyncRecordMessage[],
      };
    }

    case 'owner_sync_lock_granted': {
      if (msg.scope !== 'global') return null;
      if (!isValidIdentifier(msg.lockId)) return null;
      if (!isValidTimestampMs(msg.expiresAt)) return null;
      return {
        type: 'owner_sync_lock_granted',
        scope: 'global',
        lockId: msg.lockId,
        expiresAt: msg.expiresAt,
      };
    }

    case 'owner_sync_push_result': {
      if (!isSyncCategory(msg.category)) return null;
      if (!isValidRevision(msg.revision)) return null;
      if (!isValidTimestampMs(msg.updatedAt)) return null;
      return {
        type: 'owner_sync_push_result',
        category: msg.category,
        revision: msg.revision,
        updatedAt: msg.updatedAt,
      };
    }

    case 'owner_sync_unlock_result': {
      if (typeof msg.released !== 'boolean') return null;
      return {
        type: 'owner_sync_unlock_result',
        released: msg.released,
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

    case 'unlock_grant': {
      if (!isValidIdentifier(msg.workspaceId)) return null;
      if (!isValidIdentifier(msg.tokenId)) return null;
      if (!isValidIdentifier(msg.registerPermit)) return null;
      if (!isValidBase64(msg.ciphertext)) return null;
      if (!isValidBase64(msg.relayEphemeralKey)) return null;
      if (!isValidBase64(msg.salt)) return null;
      if (typeof msg.expiresAt !== 'string') return null;
      return {
        type: 'unlock_grant',
        workspaceId: msg.workspaceId,
        tokenId: msg.tokenId,
        registerPermit: msg.registerPermit,
        ciphertext: msg.ciphertext,
        relayEphemeralKey: msg.relayEphemeralKey,
        salt: msg.salt,
        expiresAt: msg.expiresAt,
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
