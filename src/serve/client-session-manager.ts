/**
 * Client session manager for the serve daemon
 *
 * Manages multiple concurrent client connections:
 * - Routes handshake messages to HandshakeHandler
 * - After handshake, enters "browsing" mode for workspace/session listing
 * - Attaches clients to tmux-lite session sockets when requested
 * - Routes encrypted frames between clients and tmux-lite session sockets
 * - Handles disconnect cleanup
 */

import { HandshakeHandler, type HandshakeMessage, type EstablishedSession } from "../lib/tmux-lite/handshake-handler.js";
import { createFrame, openFrame, MASTER_STREAM_ID } from "../lib/tmux-lite/crypto/frames.js";
import { encodeControl, encodePTY, parseFrames, decodeControl, FrameType, type SessionEvent } from "../lib/tmux-lite/protocol.js";
import { RemoteSessionHandler, type RemoteClientSession } from "../lib/remote-session/index.js";
import { STREAM_ID, canWrite, type ServeOptions, type ClientSession, type ServeEventHandler, type HandshakeMessageEnvelope } from "./types.js";
import { createBufferedSocketWriter } from "../utils/bun-socket-writer.js";
import { serializeRemoteMessage } from "../lib/remote-session/protocol.js";
import type { AgentStateUpdateDelta, WorkspaceAgentState } from "../lib/tmux-lite/agent-event-manager.js";
import type { SessionKeys } from "../types/identity.js";

// ============================================================================
// ClientSessionManager Class
// ============================================================================

/**
 * Manages client sessions for the serve daemon
 *
 * @example
 * ```typescript
 * const manager = new ClientSessionManager({
 *   relay: "wss://relay.example.com",
 *   identity: machineIdentity,
 * });
 *
 * manager.onEvent((event) => {
 *   if (event.type === "client_authenticated") {
 *     console.log(`Client ${event.identityId} connected`);
 *   }
 * });
 *
 * // Handle incoming message
 * const response = await manager.handleMessage(connectionId, data);
 * if (response) {
 *   relay.send(connectionId, response);
 * }
 * ```
 */
export class ClientSessionManager {
  private sessions: Map<string, ClientSession> = new Map();
  private handshakeHandler: HandshakeHandler;
  private remoteSessionHandler: RemoteSessionHandler;
  private options: ServeOptions;
  private eventHandler: ServeEventHandler | null = null;

  constructor(options: ServeOptions) {
    this.options = options;
    this.handshakeHandler = new HandshakeHandler({
      identity: options.identity,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      ownerUserRootId: options.ownerUserRootId,
    });
    this.remoteSessionHandler = new RemoteSessionHandler(options.remoteSessionOptions);
  }

  private writeToTmuxSocket(session: ClientSession, frame: Buffer): void {
    if (session.tmuxSocketWriter) {
      session.tmuxSocketWriter.write(frame);
      return;
    }
    session.tmuxSocket?.write(frame);
  }

  private registerBrowsingPushes(connectionId: string, sessionKeys: SessionKeys): void {
    const sendToClient = this.createSendCallback(connectionId);
    setTimeout(() => {
      const current = this.sessions.get(connectionId);
      if (!current || current.state !== 'browsing' || current.sessionKeys !== sessionKeys) {
        return;
      }
      void this.remoteSessionHandler.onClientEntersBrowsing(connectionId, async (msg) => {
        const json = serializeRemoteMessage(msg);
        const data = new TextEncoder().encode(json);
        const frame = await createFrame(0, data, sessionKeys.sendKey);
        sendToClient(Buffer.from(frame));
      });
    }, 0);
  }

  /**
   * Initialize async resources (like tmux-lite connection)
   */
  async initialize(): Promise<void> {
    await this.remoteSessionHandler.initialize();
  }

  /**
   * Set event handler for session events
   */
  onEvent(handler: ServeEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Emit an event
   */
  private emit(event: Parameters<ServeEventHandler>[0]): void {
    this.eventHandler?.(event);
  }

  /**
   * Get number of active sessions
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get number of established sessions (post-handshake: browsing or attached)
   */
  get establishedSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === "browsing" || session.state === "attached") count++;
    }
    return count;
  }

  /**
   * Get session by connection ID
   */
  getSession(connectionId: string): ClientSession | undefined {
    return this.sessions.get(connectionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): ClientSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Handle a new client connection
   */
  handleConnect(connectionId: string): void {
    // Create new session in handshaking state
    const session: ClientSession = {
      connectionId,
      state: "handshaking",
      handshakeStartedAt: Date.now(),
    };
    this.sessions.set(connectionId, session);

    this.emit({ type: "client_connected", connectionId });
  }

  /**
   * Handle incoming message from a client
   *
   * Routes to handshake handler or PTY session based on state.
   *
   * @param connectionId - Client connection ID
   * @param data - Raw message data
   * @returns Response to send back (if any)
   */
  async handleMessage(
    connectionId: string,
    data: Uint8Array
  ): Promise<Uint8Array | null> {
    let session = this.sessions.get(connectionId);

    // New connection - create session
    if (!session) {
      this.handleConnect(connectionId);
      session = this.sessions.get(connectionId)!;
    }

    // Handle based on session state
    if (session.state === "handshaking") {
      return this.handleHandshakeMessage(connectionId, session, data);
    }

    if (session.state === "browsing") {
      // Handle browse commands (list_workspaces, list_sessions, attach_session, etc.)
      return this.handleBrowseMessage(connectionId, session, data);
    }

    if (session.state === "attached" && session.tmuxSocket) {
      // Decrypt and route to tmux-lite session based on stream ID
      return this.handleAttachedMessage(connectionId, session, data);
    }

    // Invalid state
    console.warn(`[session-manager] Message in invalid state: ${session.state}`);
    return null;
  }

  private returnAttachedSessionToBrowsing(
    connectionId: string,
    session: ClientSession,
    options: {
      socket?: ClientSession['tmuxSocket'];
      writer?: ClientSession['tmuxSocketWriter'];
      sendDetachControl?: boolean;
    } = {},
  ): void {
    const socket = options.socket ?? session.tmuxSocket;
    const writer = options.writer ?? session.tmuxSocketWriter;
    session.tmuxSocket = undefined;
    session.tmuxSocketWriter = undefined;
    session.state = 'browsing';
    session.attachedSessionId = undefined;
    session.viewOnly = undefined;
    session.sessionSocketPath = undefined;
    session.waitingForResize = undefined;
    session.frameBuffer = undefined;

    if (socket) {
      try {
        if (options.sendDetachControl) {
          const frame = encodeControl({ type: 'detach' });
          if (writer) writer.write(frame);
          else socket.write(frame);
        }
        socket.end();
      } catch {
        // Socket may already be closed
      }
    }

    if (session.sessionKeys) {
      this.registerBrowsingPushes(connectionId, session.sessionKeys);
    }
  }


  /**
   * Handle message in attached state - route to tmux-lite session based on stream ID
   */
  private async handleAttachedMessage(
    connectionId: string,
    session: ClientSession,
    data: Uint8Array
  ): Promise<Uint8Array | null> {
    if (!session.sessionKeys || !session.tmuxSocket) {
      console.error("[session-manager] handleAttachedMessage: missing sessionKeys or tmuxSocket");
      return null;
    }

    try {
      // Decrypt the frame
      const result = openFrame(data, session.sessionKeys.receiveKey);
      if (!result) {
        console.error("[session-manager] Failed to decrypt attached frame");
        return null;
      }

      // Debug: console.log(`[session-manager] Attached message: streamId=${result.streamId}, dataLen=${result.data.length}`);

      if (result.streamId === STREAM_ID.CONTROL) {
        // Control message (resize, detach) - parse and encode for tmux-lite protocol
        const msg = JSON.parse(new TextDecoder().decode(result.data));
        console.log(`[session-manager] Control message: ${msg.type}`);

        if (msg.type === "detach") {
          // Handle detach specially - close tmux socket and send response to client
          // while keeping the authenticated connection in browsing mode.
          const socket = session.tmuxSocket;
          const writer = session.tmuxSocketWriter;
          this.returnAttachedSessionToBrowsing(connectionId, session, {
            socket,
            writer,
            sendDetachControl: true,
          });

          // Send detached response to client
          const detachedMsg = JSON.stringify({ type: "detached" });
          const detachedData = new TextEncoder().encode(detachedMsg);
          const frame = createFrame(STREAM_ID.DATA, detachedData, session.sessionKeys.sendKey);
          console.log("[session-manager] Sent detached response, returning to browsing mode");
          return frame;
        }

        if (msg.type === "resize" && session.waitingForResize) {
          // First resize - send attach-init with actual dimensions
          console.log(`[session-manager] First resize: ${msg.cols}x${msg.rows} - sending attach-init`);
          session.waitingForResize = false;
          this.writeToTmuxSocket(session, encodeControl({ type: "attach-init", cols: msg.cols, rows: msg.rows, clientType: "web" }));
          return null; // attach-init handles the resize
        }

        // Other control messages (resize after init) - encode for tmux-lite and send
        this.writeToTmuxSocket(session, encodeControl(msg));
      } else {
        // Raw PTY input (STREAM_ID.DATA) - send directly to socket
        // Security: Check write permission before forwarding input
        if (session.viewOnly || !canWrite(session.accessType)) {
          console.warn(`[session-manager] Read-only client ${connectionId} attempted PTY write - denied`);
          return null; // Silently drop input from read-only clients
        }

        // Only forward if we've sent attach-init (waitingForResize is false)
        if (!session.waitingForResize) {
          // Wrap PTY data in a frame for the framed protocol
          this.writeToTmuxSocket(session, encodePTY(result.data));
        } else {
          console.warn("[session-manager] Ignoring PTY data before attach-init");
        }
      }

      return null;
    } catch (e) {
      console.error("[session-manager] Error handling attached message:", e);
      return null;
    }
  }

  /**
   * Handle browse message (encrypted command in browsing state)
   */
  private async handleBrowseMessage(
    connectionId: string,
    session: ClientSession,
    data: Uint8Array
  ): Promise<Uint8Array | null> {
    if (!session.sessionKeys) {
      console.error("[session-manager] No session keys for browse message");
      return null;
    }

    // Create RemoteClientSession adapter for the handler
    const remoteSession: RemoteClientSession = {
      connectionId,
      state: "browsing",
      sessionKeys: session.sessionKeys,
      accessType: session.accessType,
      grantedSessionId: session.sessionId,
    };

    // Create send callback that captures the raw encrypted response
    // Don't wrap in JSON here - serve.ts handles the relay envelope
    const sendToClient = this.createSendCallback(connectionId);
    let responseData: Uint8Array | null = null;
    const sendResponse = (encryptedFrame: Uint8Array) => {
      if (responseData === null) {
        responseData = encryptedFrame;
        return;
      }
      sendToClient(Buffer.from(encryptedFrame));
    };

    // Handle the message through RemoteSessionHandler
    await this.remoteSessionHandler.handleMessage(remoteSession, data, sendResponse);

    // Check if we're now attached (after attach_session command)
    if (remoteSession.state === "attached" && remoteSession.attachedSessionId) {
      this.remoteSessionHandler.onClientLeavesBrowsing(connectionId);
      session.state = "attached";
      session.attachedSessionId = remoteSession.attachedSessionId;
      session.viewOnly = remoteSession.viewOnly ?? false;
      session.sessionSocketPath = remoteSession.sessionSocketPath;

      // Connect to tmux-lite session socket for PTY I/O
      await this.attachToTmuxLiteSession(connectionId, session);
    }

    return responseData;
  }

  /**
   * Handle handshake message
   */
  private async handleHandshakeMessage(
    connectionId: string,
    session: ClientSession,
    data: Uint8Array
  ): Promise<Uint8Array | null> {
    try {
      // Parse as JSON handshake message
      const jsonStr = new TextDecoder().decode(data);
      const envelope = JSON.parse(jsonStr) as HandshakeMessageEnvelope;

      if (envelope.type !== "handshake") {
        console.warn(`[session-manager] Expected handshake, got: ${envelope.type}`);
        return null;
      }

      // Process through HandshakeHandler
      const result = await this.handshakeHandler.processMessage(connectionId, envelope as HandshakeMessage);

      switch (result.type) {
        case "reply": {
          // Send reply back to client
          return new TextEncoder().encode(JSON.stringify(result.message));
        }

        case "established": {
          // Handshake complete - spawn PTY and send ServerAuth
          return this.handleHandshakeEstablished(connectionId, session, result.session, result.message);
        }

        case "error": {
          console.error(`[session-manager] Handshake error: ${result.reason}`);
          this.emit({ type: "error", connectionId, error: new Error(result.reason) });

          if (result.close) {
            this.handleDisconnect(connectionId, result.reason);
          }
          return null;
        }
      }
    } catch (e) {
      console.error("[session-manager] Handshake message parse error:", e);
      this.emit({
        type: "error",
        connectionId,
        error: new Error(`Invalid handshake message: ${e instanceof Error ? e.message : String(e)}`),
      });
      return null;
    }
  }

  /**
   * Handle successful handshake - enter browsing mode
   */
  private handleHandshakeEstablished(
    connectionId: string,
    session: ClientSession,
    established: EstablishedSession,
    serverAuthMessage: HandshakeMessage
  ): Uint8Array | null {
    // Update session state - enter browsing mode (not spawning PTY yet)
    session.state = "browsing";
    session.viewOnly = undefined;
    session.sessionKeys = established.sessionKeys;
    session.accessType = established.accessType;
    session.sessionId = established.sessionId;
    session.peerIdentityId = established.peerIdentityId;

    // Emit event
    this.emit({
      type: "client_authenticated",
      connectionId,
      identityId: established.peerIdentityId,
      accessType: established.accessType,
      sessionId: established.sessionId,
    });

    // Register this client for machine snapshot pushes only after the handshake
    // response has been flushed back to the client. Otherwise the initial
    // machine_snapshot can race ahead of server_auth, get delivered as an
    // encrypted pre-handshake payload, and be dropped by the browser backend.
    this.registerBrowsingPushes(connectionId, established.sessionKeys);

    // Client can now send list_workspaces, list_sessions, attach_session commands
    // PTY will be spawned when attach_session is received

    // Return ServerAuth message from HandshakeHandler
    return new TextEncoder().encode(JSON.stringify(serverAuthMessage));
  }

  /**
   * Attach to a tmux-lite session socket for PTY I/O
   * This is the proper way to connect - through the existing tmux-lite session
   */
  private async attachToTmuxLiteSession(connectionId: string, session: ClientSession): Promise<void> {
    if (!session.sessionKeys || !session.sessionSocketPath) {
      console.error("[session-manager] Cannot attach: missing session keys or socket path");
      return;
    }

    const sendToClient = this.createSendCallback(connectionId);

    try {
      // Connect to tmux-lite session socket
      const socket = await Bun.connect({
        unix: session.sessionSocketPath,
        socket: {
          drain: () => {
            session.tmuxSocketWriter?.flush();
          },
          data: (sock, data) => {
            if (!session.sessionKeys) return;

            // Accumulate in frame buffer (for handling partial frames)
            const prev = session.frameBuffer || Buffer.alloc(0);
            const buf = Buffer.concat([prev, Buffer.from(data)]);

            // Parse frames from the accumulated buffer
            let frames;
            let remaining;
            try {
              const result = parseFrames(buf);
              frames = result.frames;
              remaining = result.remaining;
            } catch (err) {
              // Protocol error - likely desync or corrupted data
              const msg = err instanceof Error ? err.message : 'Frame parse error';
              console.error(`[session-manager] Frame parse error: ${msg}`);
              this.handleDisconnect(connectionId, `Frame parse error: ${msg}`);
              return;
            }
            // Copy remaining bytes - subarray references can become invalid when Bun reuses buffers
            session.frameBuffer = Buffer.from(remaining);

            for (const frame of frames) {
              if (frame.type === FrameType.CONTROL) {
                // Decode and handle control events
                const event = decodeControl(frame.payload) as SessionEvent;

                if (event.type === "exited") {
                  console.log(`[session-manager] Session exited: ${event.code}`);
                  const exitedSessionId = session.attachedSessionId;
                  this.returnAttachedSessionToBrowsing(connectionId, session);

                  if (exitedSessionId) {
                    const exitMsg = JSON.stringify({ type: "session_exited", sessionId: exitedSessionId, exitCode: event.code });
                    const exitData = new TextEncoder().encode(exitMsg);
                    const encFrame = createFrame(STREAM_ID.DATA, exitData, session.sessionKeys.sendKey);
                    sendToClient(Buffer.from(encFrame));
                  }
                  return;
                } else if (event.type === "kicked") {
                  console.log("[session-manager] Session kicked");
                  this.returnAttachedSessionToBrowsing(connectionId, session);
                  const detachedMsg = JSON.stringify({ type: "detached" });
                  const detachedData = new TextEncoder().encode(detachedMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, detachedData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                  return;
                } else if (event.type === "wide_event") {
                  const eventMsg = JSON.stringify({ type: "wide_event", event: event.event });
                  const eventData = new TextEncoder().encode(eventMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, eventData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                } else if (event.type === 'session-meta') {
                  const metaMsg = JSON.stringify(event);
                  const metaData = new TextEncoder().encode(metaMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, metaData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                }
                // Ignore attach-ready and attached - handled by client
              } else if (frame.type === FrameType.PTY) {
                // Forward PTY data to web client
                const encFrame = createFrame(STREAM_ID.DATA, frame.payload, session.sessionKeys.sendKey);
                sendToClient(Buffer.from(encFrame));
              }
            }
          },

          close: () => {
            // Check if this was a voluntary detach (tmuxSocket already cleared)
            // vs an unexpected close
            if (session.tmuxSocket) {
              console.log("[session-manager] tmux-lite socket closed unexpectedly");
              this.handleDisconnect(connectionId, "Session closed");
            } else {
              console.log("[session-manager] tmux-lite socket closed (detached)");
            }
          },

          error: (_, e) => {
            console.error("[session-manager] tmux-lite socket error:", e);
            this.handleDisconnect(connectionId, e.message);
          },
        }
      });

      // Store socket reference
      session.tmuxSocket = socket;
      session.tmuxSocketWriter = createBufferedSocketWriter(socket);

      // Don't send attach-init yet - wait for the first resize from client
      // This ensures tmux-lite receives the actual terminal dimensions
      session.waitingForResize = true;

      console.log(`[session-manager] Connected to tmux-lite session: ${session.sessionSocketPath} (waiting for resize)`);
    } catch (e) {
      console.error("[session-manager] Failed to connect to tmux-lite session:", e);
      this.handleDisconnect(connectionId, "Failed to connect to session");
    }
  }

  /**
   * Create a callback to send data to a specific client
   *
   * This is set by the serve command to route through the relay.
   */
  private sendCallbacks: Map<string, (data: Buffer) => void> = new Map();

  /**
   * Register a send callback for a connection
   */
  setSendCallback(connectionId: string, callback: (data: Buffer) => void): void {
    this.sendCallbacks.set(connectionId, callback);
  }

  /**
   * Create send callback for a connection
   */
  private createSendCallback(connectionId: string): (data: Buffer) => void {
    return (data: Buffer) => {
      const callback = this.sendCallbacks.get(connectionId);
      if (callback) {
        callback(data);
      } else {
        console.warn(`[session-manager] No send callback for ${connectionId}`);
      }
    };
  }

  /**
   * Handle client disconnect
   */
  handleDisconnect(connectionId: string, reason: string = "disconnected"): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    // Close tmux-lite socket if active
    if (session.tmuxSocket) {
      try {
        // Send detach message before closing (using framed protocol)
        this.writeToTmuxSocket(session, encodeControl({ type: "detach" }));
        session.tmuxSocket.end();
      } catch {
        // Socket may already be closed
      }
      session.tmuxSocket = undefined;
      session.tmuxSocketWriter = undefined;
      session.frameBuffer = undefined;
    }

    // Cleanup handshake state
    this.handshakeHandler.cleanup(connectionId);
    this.remoteSessionHandler.cleanupConnection(connectionId);

    // Remove send callback
    this.sendCallbacks.delete(connectionId);

    // Remove session
    session.state = "closed";
    this.sessions.delete(connectionId);

    this.emit({ type: "client_disconnected", connectionId, reason });
  }

  /**
   * Send a full agent state snapshot to a specific authenticated client.
   * Called when a new client completes the handshake.
   */
  async sendAgentStateSnapshot(connectionId: string, workspaces: Record<string, WorkspaceAgentState>): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session?.sessionKeys || session.state !== 'browsing') return;
    try {
      const msg = serializeRemoteMessage({
        type: 'agent_state_snapshot',
        workspaces: Object.values(workspaces),
      });
      const data = new TextEncoder().encode(msg);
      const frame = await createFrame(0, data, session.sessionKeys.sendKey);
      const sendToClient = this.createSendCallback(connectionId);
      sendToClient(Buffer.from(frame));
    } catch {
      // Non-fatal — client can request a refresh
    }
  }

  /**
   * Broadcast an agent state delta to all authenticated browsing clients.
   * Called by AgentEventManager whenever state changes.
   */
  async broadcastAgentStateUpdate(delta: AgentStateUpdateDelta): Promise<void> {
    const msg = serializeRemoteMessage({ type: 'agent_state_update', delta });
    const data = new TextEncoder().encode(msg);
    const promises: Promise<void>[] = [];

    for (const [connectionId, session] of this.sessions) {
      if (session.state !== 'browsing' || !session.sessionKeys) continue;
      promises.push(
        (async () => {
          try {
            const frame = await createFrame(0, data, session.sessionKeys!.sendKey);
            const sendToClient = this.createSendCallback(connectionId);
            sendToClient(Buffer.from(frame));
          } catch {
            // Non-fatal — skip this client
          }
        })(),
      );
    }

    await Promise.allSettled(promises);
  }

  /**
   * Clean up all sessions
   */
  async cleanup(): Promise<void> {
    for (const [connectionId] of this.sessions) {
      this.handleDisconnect(connectionId, "server shutdown");
    }
    await this.remoteSessionHandler.cleanup();
  }
}
