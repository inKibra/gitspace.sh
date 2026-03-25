/**
 * Types for the `gssh machine serve` command group
 *
 * Defines configuration, session state, and events for the machine-side daemon.
 */

import type { Identity, SessionKeys, AccessType } from "../types/identity.js";
import { FrameType } from "../lib/tmux-lite/protocol.js";

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if an access type grants write permission (terminal input)
 *
 * Only 'full' access allows writing to the terminal.
 * 'view' is read-only.
 */
export function canWrite(accessType: AccessType | undefined): boolean {
  return accessType === 'full';
}

/**
 * Check if an access type grants management permission
 *
 * Management includes: create/kill sessions, delete workspaces, etc.
 * Only 'full' access allows management operations.
 */
export function canManage(accessType: AccessType | undefined): boolean {
  return accessType === 'full';
}

/**
 * Check if a client can attach to a specific session
 *
 * - 'full' access can attach to any session
 * - 'view' can only attach to the specific session they were invited to
 */
export function canAttachSession(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  targetSessionId: string
): boolean {
  if (accessType === 'full') return true;
  if (accessType === 'view') {
    return grantedSessionId === targetSessionId;
  }
  return false;
}

// ============================================================================
// Configuration Types
// ============================================================================

/** Configuration for the serve command */
export interface ServeOptions {
  /** Relay WebSocket URL */
  relay: string;
  /** Machine identity for authentication */
  identity: Identity;
  /** Shell to spawn (default: $SHELL or /bin/bash) */
  shell?: string;
  /** Extra environment variables for PTY sessions */
  env?: Record<string, string>;
  /** Handshake timeout in milliseconds (default: 30000) */
  handshakeTimeoutMs?: number;
  /** Owner user root ID for strict owner-only authorization */
  ownerUserRootId?: string;
}

// ============================================================================
// Session Types
// ============================================================================

/** State of a client session */
export type ClientSessionState = "handshaking" | "browsing" | "attached" | "closed";

/** Client session data */
export interface ClientSession {
  /** Unique connection ID from relay */
  connectionId: string;
  /** Current session state */
  state: ClientSessionState;
  /** When handshake started (Unix ms) */
  handshakeStartedAt: number;
  /** tmux-lite session socket connection */
  tmuxSocket?: Awaited<ReturnType<typeof Bun.connect>>;
  /** Buffered writer for tmux-lite socket (Bun sockets can partially write under backpressure) */
  tmuxSocketWriter?: {
    write(data: Buffer | Uint8Array | ArrayBuffer): void;
    flush(): void;
    clear(): void;
  };
  /** Path to tmux-lite session socket */
  sessionSocketPath?: string;
  /** Session encryption keys */
  sessionKeys?: SessionKeys;
  /** Granted access type */
  accessType?: AccessType;
  /** Session ID for view access */
  sessionId?: string;
  /** Peer's identity ID */
  peerIdentityId?: string;
  /** Attached tmux-lite session ID (when state === "attached") */
  attachedSessionId?: string;
  /** When true, this attached session is server-enforced read-only */
  viewOnly?: boolean;
  /** True if waiting for initial resize before sending attach-init */
  waitingForResize?: boolean;
  /** Buffer for incomplete frames from tmux-lite socket */
  frameBuffer?: Buffer;
}

// ============================================================================
// Stream IDs (for encrypted relay framing)
// ============================================================================
//
// Stream IDs align with FrameType from tmux-lite protocol:
// - DATA (0) = FrameType.PTY: raw terminal bytes
// - CONTROL (1) = FrameType.CONTROL: JSON control messages (resize, detach, etc.)
//
// See src/lib/tmux-lite/protocol.ts for SessionCtrl/SessionEvent types.

/** Stream IDs for frame routing - aligned with FrameType */
export const STREAM_ID = {
  /** Terminal data stream (same as FrameType.PTY) */
  DATA: FrameType.PTY,
  /** Control messages (same as FrameType.CONTROL) */
  CONTROL: FrameType.CONTROL,
} as const;

// ============================================================================
// Event Types
// ============================================================================

/** Events emitted by the serve daemon */
export type ServeEvent =
  | { type: "client_connected"; connectionId: string }
  | { type: "client_authenticated"; connectionId: string; identityId: string; accessType: AccessType; sessionId?: string }
  | { type: "client_disconnected"; connectionId: string; reason: string }
  | { type: "relay_connected" }
  | { type: "relay_disconnected"; code: number; reason: string }
  | { type: "relay_reconnecting"; attempt: number }
  | { type: "error"; connectionId?: string; error: Error };

/** Event handler for serve events */
export type ServeEventHandler = (event: ServeEvent) => void;

// ============================================================================
// Relay Protocol Types
// ============================================================================

/** Envelope for messages from relay (includes routing info) */
export interface RelayEnvelope {
  /** Connection ID for routing */
  connectionId: string;
  /** Raw message data */
  data: Uint8Array;
}

/** Handshake message envelope */
export interface HandshakeMessageEnvelope {
  type: "handshake";
  phase: "client_hello" | "server_hello" | "client_auth" | "server_auth";
  data: unknown;
}
