/**
 * Relay types - connection and pipe types
 *
 * The relay is a dumb pipe. It doesn't know about users, sessions, or encryption.
 * All it does is:
 * 1. Verify machine identity via Ed25519 challenge-response
 * 2. Manage pipes (machineId -> connections)
 * 3. Broadcast bytes between machine and clients
 */

import type { ServerWebSocket } from "bun";
import type { RelayIdentity } from "./identity.js";

/**
 * WebSocket data attached to each connection
 */
export interface WebSocketData {
  /** Machine ID this connection belongs to (empty until registered/connected) */
  machineId: string;
  /** Role of the connection */
  role: "machine" | "client";
  /** Connection ID (for routing) */
  connectionId: string;
  /** Owner user-root ID for registered machine connections */
  ownerUserRootId?: string;
  /** Client identity ID (for clients, set during connect_to_machine) */
  clientIdentityId?: string;
  /** Permissions (for clients) */
  permissions?: ("read" | "write")[];
}

/**
 * A pipe represents a machine and all clients connected to it
 */
export interface Pipe {
  /** Machine ID */
  machineId: string;
  /** Machine's WebSocket connection (null if not connected) */
  machine: ServerWebSocket<WebSocketData> | null;
  /** All client WebSocket connections */
  clients: Set<ServerWebSocket<WebSocketData>>;
  /** When the pipe was opened */
  openedAt: number;
}

/**
 * Relay server startup configuration.
 * Distinct from RelayEnrollment (persisted client-side enrollment) and
 * RelayDescriptor (TUI/client connection descriptor).
 */
export interface RelayServerConfig {
  /** Port to listen on */
  port: number;
  /** Address to bind to (default: 0.0.0.0) */
  bind?: string;
  /** Preferred hosted hostname; loopback hosts remain allowed for local access (optional) */
  hostname?: string;
  /**
   * Disable best-effort in-memory connection rate limiting.
   * Intended for tests (Bun test runs many short-lived WS connections quickly).
   */
  disableRateLimit?: boolean;
  /** Relay identity (Ed25519 keypair for signing and verification) */
  identity: RelayIdentity;
  /**
   * Pre-authorized machine signing keys (base64 Ed25519 public keys).
   * These machines can connect without an enrollment token for this process.
   * Used for ephemeral local relays where the creating process knows which machine will connect.
   */
  preAuthorizedMachines?: string[] | Set<string>;
}
