/**
 * Machine-side X3DH handshake handler
 *
 * This class manages X3DH handshakes for multiple concurrent client connections.
 * It processes incoming handshake messages, validates clients via user-root
 * certificate authorization, and returns established sessions
 * on success.
 *
 * The relay server forwards raw bytes between clients and machines - the handshake
 * is peer-to-peer between the CLIENT and MACHINE.
 *
 * Message flow:
 * 1. ClientHello → Machine creates state, returns ServerHello
 * 2. ClientAuth → Machine validates auth, returns ServerAuth with accept/reject
 * 3. On accept → Returns established session with keys
 *
 * @module handshake-handler
 */

import {
  createServerState,
  processClientHello,
  createServerHello,
  processClientAuth,
  createServerAuth,
  type X3DHServerState,
} from "./crypto/handshake.js";
import type {
  Identity,
  SessionKeys,
  AccessType,
  X3DHInitMessage,
  X3DHAuthMessage,
} from "../../types/identity.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Callback to check user-root-keyed access (e.g., via vault_access_list).
 *
 * @param ownerUserRootId - The machine owner's user root ID
 * @param clientUserRootId - The connecting client's user root ID (from device cert)
 * @returns true if the client's user root is authorized
 */
export type UserRootAccessCheck = (
  ownerUserRootId: string,
  clientUserRootId: string,
  machineId?: string,
) => boolean | Promise<boolean>;

/** Configuration for HandshakeHandler */
export interface HandshakeHandlerConfig {
  /** Machine's identity for authentication */
  identity: Identity;
  /** Handshake timeout in milliseconds (default: 30000) */
  handshakeTimeoutMs?: number;
  /**
   * Optional user-root-keyed access check.
   * When a client presents a valid device certificate, this callback is used
   * to check if the client's user root ID is authorized (via vault_access_list).
   */
  checkUserRootAccess?: UserRootAccessCheck;
  /**
   * Machine owner's user root ID.
   * Required for user-root-keyed ACL checks — if the client's device cert
   * maps to the same user root, they are auto-accepted as owner.
   */
  ownerUserRootId?: string;
}

/** Per-connection handshake state */
interface HandshakeContext {
  /** X3DH server state */
  state: X3DHServerState;
  /** When handshake started (for timeout) */
  startedAt: number;
  /** Timeout handle for cleanup */
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/** Handshake message envelope */
export interface HandshakeMessage {
  type: "handshake";
  phase: "client_hello" | "server_hello" | "client_auth" | "server_auth";
  data: unknown;
}

/** Result of processing a handshake message */
export type ProcessResult =
  | { type: "reply"; message: HandshakeMessage }
  | { type: "established"; session: EstablishedSession; message: HandshakeMessage }
  | { type: "error"; reason: string; close: boolean };

/** Established session after successful handshake */
export interface EstablishedSession {
  /** Connection ID (maps to relay connection) */
  connectionId: string;
  /** Peer's identity ID */
  peerIdentityId: string;
  /** Granted access type */
  accessType: AccessType;
  /** Optional session ID for scoped access */
  sessionId?: string;
  /** Derived session keys for encryption */
  sessionKeys: SessionKeys;
  /** When session was established (Unix ms) */
  establishedAt: number;
}

// ============================================================================
// HandshakeHandler Class
// ============================================================================

/**
 * Handles X3DH handshakes for multiple concurrent client connections
 *
 * @example
 * ```typescript
 * const handler = new HandshakeHandler({
 *   identity: machineIdentity,
 * });
 *
 * // On receiving a handshake message from client
 * const result = await handler.processMessage(connectionId, message);
 * if (result.type === "reply") {
 *   relay.send(connectionId, result.message);
 * } else if (result.type === "established") {
 *   sessions.set(connectionId, result.session);
 * } else if (result.type === "error") {
 *   console.error(result.reason);
 *   if (result.close) relay.close(connectionId);
 * }
 *
 * // On client disconnect
 * handler.cleanup(connectionId);
 * ```
 */
export class HandshakeHandler {
  private config: HandshakeHandlerConfig;
  private contexts: Map<string, HandshakeContext> = new Map();
  private readonly defaultTimeoutMs = 30000;

  /**
   * Create a new HandshakeHandler
   *
   * @param config - Handler configuration
   */
  constructor(config: HandshakeHandlerConfig) {
    this.config = config;
  }

  /**
   * Process an incoming handshake message from a client
   *
   * @param connectionId - Unique identifier for this connection
   * @param message - Handshake message to process
   * @returns Processing result (reply, established, or error)
   */
  async processMessage(
    connectionId: string,
    message: HandshakeMessage
  ): Promise<ProcessResult> {
    try {
      switch (message.phase) {
        case "client_hello":
          return this.handleClientHello(connectionId, message.data as X3DHInitMessage);

        case "client_auth":
          return await this.handleClientAuth(connectionId, message.data as X3DHAuthMessage);

        default:
          return {
            type: "error",
            reason: `Unexpected handshake phase: ${message.phase}`,
            close: true,
          };
      }
    } catch (error) {
      return {
        type: "error",
        reason: `Handshake error: ${error instanceof Error ? error.message : String(error)}`,
        close: true,
      };
    }
  }

  /**
   * Handle ClientHello message (phase 1)
   *
   * Creates fresh server state and returns ServerHello
   */
  private handleClientHello(
    connectionId: string,
    clientHello: X3DHInitMessage
  ): ProcessResult {
    // Clean up any existing state for this connection
    this.cleanup(connectionId);

    // Create fresh server state
    const serverState = createServerState(this.config.identity);

    // Process ClientHello
    const newState = processClientHello(serverState, clientHello);
    if (!newState) {
      return {
        type: "error",
        reason: "Invalid ClientHello",
        close: true,
      };
    }

    // Create ServerHello response
    const { state: stateAfterHello, message: serverHello } = createServerHello(
      newState,
      this.config.identity
    );

    // Store context with timeout
    const timeoutMs = this.config.handshakeTimeoutMs ?? this.defaultTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      this.cleanup(connectionId);
    }, timeoutMs);

    this.contexts.set(connectionId, {
      state: stateAfterHello,
      startedAt: Date.now(),
      timeoutHandle,
    });

    return {
      type: "reply",
      message: {
        type: "handshake",
        phase: "server_hello",
        data: serverHello,
      },
    };
  }

  /**
   * Handle ClientAuth message (phase 2)
   *
   * Validates client identity and authorization, returns ServerAuth
   */
  private async handleClientAuth(
    connectionId: string,
    clientAuth: X3DHAuthMessage
  ): Promise<ProcessResult> {
    // Get existing context
    const context = this.contexts.get(connectionId);
    if (!context) {
      return {
        type: "error",
        reason: "No handshake in progress for this connection",
        close: true,
      };
    }

    // Clear timeout (we're completing the handshake)
    if (context.timeoutHandle) {
      clearTimeout(context.timeoutHandle);
    }

    // Process ClientAuth to get peer identity
    const authResult = processClientAuth(
      context.state,
      clientAuth,
      this.config.identity
    );

    if (!authResult) {
      this.cleanup(connectionId);
      return {
        type: "error",
        reason: "Invalid ClientAuth or identity proof",
        close: true,
      };
    }

    // Check authorization (device-keyed, then user-root-keyed fallback)
    const authCheck = await this.checkAuthorization(
      authResult.authorization,
      authResult.userRootId
    );

    // Create ServerAuth response
    const { message: serverAuth, sessionKeys } = createServerAuth(
      this.config.identity,
      context.state,
      authResult.clientIdentityKey,
      authCheck
    );

    // Clean up handshake context
    this.cleanup(connectionId);

    // If rejected, send ServerAuth with rejection and close
    if (authCheck.type === "rejected") {
      return {
        type: "reply",
        message: {
          type: "handshake",
          phase: "server_auth",
          data: serverAuth,
        },
      };
    }

    // Success! Return established session with ServerAuth message
    const session: EstablishedSession = {
      connectionId,
      peerIdentityId: authResult.peerIdentityId,
      accessType: authCheck.accessType,
      sessionId: authCheck.sessionId,
      sessionKeys,
      establishedAt: Date.now(),
    };

    // Return established session with ServerAuth message
    // The caller should send the ServerAuth reply then handle the established session
    return {
      type: "established",
      session,
      message: {
        type: "handshake",
        phase: "server_auth",
        data: serverAuth,
      },
    };
  }

  /** Check client authorization via user-root ACL. */
  private async checkAuthorization(
    authorization: X3DHAuthMessage["authorization"],
    userRootId?: string
  ): Promise<
    | { type: "accepted"; accessType: AccessType; sessionId?: string }
    | { type: "rejected"; reason: string }
  > {
    if (!userRootId) {
      return {
        type: "rejected",
        reason: "Device certificate required",
      };
    }

    if (!this.config.ownerUserRootId) {
      return {
        type: "rejected",
        reason: "Machine owner user root is not configured",
      };
    }

    // Auto-accept owner (same user root as machine)
    if (userRootId === this.config.ownerUserRootId) {
      return {
        type: "accepted",
        accessType: "full",
      };
    }

    if (!this.config.checkUserRootAccess) {
      return {
        type: "rejected",
        reason: "Machine user-root ACL is not configured",
      };
    }

    // Check vault access list via callback
    const granted = await this.config.checkUserRootAccess(
      this.config.ownerUserRootId,
      userRootId,
      this.config.identity.id,
    );
    if (granted) {
      return {
        type: "accepted",
        accessType: "full",
      };
    }

    return {
      type: "rejected",
      reason: "User root is not authorized",
    };
  }

  /**
   * Clean up state for a disconnected client
   *
   * Call this when a client disconnects to free resources
   *
   * @param connectionId - Connection ID to clean up
   */
  cleanup(connectionId: string): void {
    const context = this.contexts.get(connectionId);
    if (context) {
      if (context.timeoutHandle) {
        clearTimeout(context.timeoutHandle);
      }
      this.contexts.delete(connectionId);
    }
  }

  /**
   * Get number of active handshakes
   */
  get activeHandshakes(): number {
    return this.contexts.size;
  }

  /**
   * Check if a connection has an active handshake
   */
  hasActiveHandshake(connectionId: string): boolean {
    return this.contexts.has(connectionId);
  }
}
