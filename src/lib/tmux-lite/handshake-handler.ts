/**
 * Machine-side X3DH handshake handler
 *
 * This class manages X3DH handshakes for multiple concurrent client connections.
 * It processes incoming handshake messages, validates clients via access lists
 * or invite tokens, and returns established sessions on success.
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
import { AccessControlList } from "./crypto/access-control.js";
import { parseInviteToken, isInviteExpired } from "./crypto/invites.js";
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

/** Configuration for HandshakeHandler */
export interface HandshakeHandlerConfig {
  /** Machine's identity for authentication */
  identity: Identity;
  /** Access control list for authorized clients */
  accessList: AccessControlList;
  /**
   * Optional custom invite validator
   * Returns access type if valid, null if rejected
   */
  validateInvite?: (token: string) => Promise<{ accessType: AccessType; sessionId?: string } | null>;
  /** Handshake timeout in milliseconds (default: 30000) */
  handshakeTimeoutMs?: number;
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
  /** Session ID for session-invite access */
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
 *   accessList: acl,
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

    // Check authorization
    const authCheck = await this.checkAuthorization(
      authResult.peerIdentityId,
      authResult.authorization,
      authResult.clientIdentityKey,
      authResult.clientKeyExchangeKey
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

  /**
   * Check client authorization via access list or invite token
   */
  private async checkAuthorization(
    peerIdentityId: string,
    authorization: X3DHAuthMessage["authorization"],
    clientIdentityKey: Uint8Array,
    clientKeyExchangeKey: Uint8Array
  ): Promise<
    | { type: "accepted"; accessType: AccessType; sessionId?: string }
    | { type: "rejected"; reason: string }
  > {
    if (authorization.type === "access_list") {
      // Check access list
      const entry = this.config.accessList.getEntry(peerIdentityId);
      if (!entry) {
        return {
          type: "rejected",
          reason: "Not in access list",
        };
      }

      return {
        type: "accepted",
        accessType: entry.accessType,
        sessionId: entry.sessionId,
      };
    }

    if (authorization.type === "invite") {
      // Validate invite token
      const token = parseInviteToken(authorization.inviteToken);

      if (!token) {
        return {
          type: "rejected",
          reason: "Invalid invite token",
        };
      }

      if (isInviteExpired(token)) {
        return {
          type: "rejected",
          reason: "Invite token expired",
        };
      }

      // Verify token was issued by this machine
      if (token.machineId !== this.config.identity.id) {
        return {
          type: "rejected",
          reason: "Invite token not issued by this machine",
        };
      }

      // Check custom validator if provided
      if (this.config.validateInvite) {
        const customResult = await this.config.validateInvite(
          authorization.inviteToken
        );
        if (!customResult) {
          return {
            type: "rejected",
            reason: "Invite rejected by custom validator",
          };
        }
        return {
          type: "accepted",
          accessType: customResult.accessType,
          sessionId: customResult.sessionId,
        };
      }

      // Use access type from token
      // Security: Only add to permanent access list if NOT a single-use invite
      // Single-use invites grant access for this session only
      if (!token.singleUse) {
        this.config.accessList.addEntry(
          {
            id: peerIdentityId,
            signingPublicKey: Buffer.from(clientIdentityKey).toString("base64"),
            keyExchangePublicKey: Buffer.from(clientKeyExchangeKey).toString("base64"),
          },
          token.accessType,
          token.sessionId
        );
      }

      return {
        type: "accepted",
        accessType: token.accessType,
        sessionId: token.sessionId,
      };
    }

    return {
      type: "rejected",
      reason: "Unknown authorization type",
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
