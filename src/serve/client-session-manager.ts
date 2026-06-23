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
import { STREAM_ID, canWrite, canManage, type ServeOptions, type ClientSession, type AttachedPane, type ServeEventHandler, type HandshakeMessageEnvelope } from "./types.js";
import { createBufferedSocketWriter } from "../utils/bun-socket-writer.js";
import { serializeRemoteMessage } from "../lib/remote-session/protocol.js";
import type { AgentStateUpdateDelta, WorkspaceAgentState } from "../lib/tmux-lite/agent-event-manager.js";
import { send as sendTmuxLiteCommand, ensureServer as ensureTmuxLiteServer } from "../lib/tmux-lite/cli.js";
import type { Command as TmuxCommand, Response as TmuxResponse } from "../lib/tmux-lite/protocol.js";
import type { SessionKeys } from "../types/identity.js";
import { logger } from "../utils/logger.js";

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
  private readonly inboundMessageQueues = new Map<string, Promise<Uint8Array | null>>();

  constructor(options: ServeOptions) {
    this.options = options;
    this.handshakeHandler = new HandshakeHandler({
      identity: options.identity,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      ownerUserRootId: options.ownerUserRootId,
    });
    this.remoteSessionHandler = new RemoteSessionHandler();
  }

  private writeToTmuxSocket(pane: AttachedPane, frame: Buffer): void {
    if (pane.tmuxSocketWriter) {
      pane.tmuxSocketWriter.write(frame);
      return;
    }
    pane.tmuxSocket?.write(frame);
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
      if (session.state === "browsing") count++;
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
      attachedPanes: new Map(),
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
    const session = this.sessions.get(connectionId);
    if (session && session.state !== "handshaking") {
      return this.handleMessageNow(connectionId, data);
    }

    const previous = this.inboundMessageQueues.get(connectionId) ?? Promise.resolve<Uint8Array | null>(null);
    const next = previous
      .catch(() => null)
      .then(() => this.handleMessageNow(connectionId, data));
    this.inboundMessageQueues.set(connectionId, next);
    try {
      return await next;
    } finally {
      if (this.inboundMessageQueues.get(connectionId) === next) {
        this.inboundMessageQueues.delete(connectionId);
      }
    }
  }

  private async handleMessageNow(
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
      return this.handleEncryptedSessionMessage(connectionId, session, data);
    }

    // Invalid state
    console.warn(`[session-manager] Message in invalid state: ${session.state}`);
    return null;
  }

  private detachPane(session: ClientSession, pane: AttachedPane, options: { sendDetachControl?: boolean } = {}): void {
    session.attachedPanes.delete(pane.streamId);
    pane.tmuxSocketWriter?.clear();
    if (pane.tmuxSocket) {
      try {
        if (options.sendDetachControl) {
          const frame = encodeControl({ type: 'detach' });
          if (pane.tmuxSocketWriter) pane.tmuxSocketWriter.write(frame);
          else pane.tmuxSocket.write(frame);
        }
        pane.tmuxSocket.end();
      } catch {
        // Socket may already be closed.
      }
    }
    pane.tmuxSocket = null;
    pane.tmuxSocketWriter = null;
    pane.frameBuffer = Buffer.alloc(0);
  }

  private detachAllPanes(session: ClientSession, options: { sendDetachControl?: boolean } = {}): void {
    for (const pane of [...session.attachedPanes.values()]) {
      this.detachPane(session, pane, options);
    }
  }


  private async handleEncryptedSessionMessage(
    connectionId: string,
    session: ClientSession,
    data: Uint8Array
  ): Promise<Uint8Array | null> {
    if (!session.sessionKeys) {
      console.error("[session-manager] handleEncryptedSessionMessage: missing sessionKeys");
      return null;
    }

    try {
      const result = openFrame(data, session.sessionKeys.receiveKey);
      if (!result) {
        console.error("[session-manager] Failed to decrypt session frame");
        return null;
      }

      if (result.streamId === STREAM_ID.CONTROL) {
        const msg = JSON.parse(new TextDecoder().decode(result.data));

        const ATTACHED_COMMAND_TYPES = new Set([
          'prompt_agent_session',
          'abort_agent_session',
          'interrupt_agent_session',
          'respond_agent_permission',
          'respond_agent_dialog',
        ]);

        if (ATTACHED_COMMAND_TYPES.has(msg.type)) {
          const responseMsg = await this.handleAttachedCommand(session, msg);
          if (responseMsg) {
            const respData = new TextEncoder().encode(JSON.stringify(responseMsg));
            return createFrame(STREAM_ID.CONTROL, respData, session.sessionKeys.sendKey);
          }
          return null;
        }

        if (msg.type === 'detach_all') {
          this.detachAllPanes(session, { sendDetachControl: true });
          return null;
        }

        if (msg.type === 'detach') {
          const pane = session.attachedPanes.get(msg.streamId);
          if (!pane) return null;
          this.detachPane(session, pane, { sendDetachControl: true });
          const detachedData = new TextEncoder().encode(JSON.stringify({ type: 'detached', streamId: msg.streamId }));
          return createFrame(STREAM_ID.DATA, detachedData, session.sessionKeys.sendKey);
        }

        if (msg.type === 'resize') {
          const pane = session.attachedPanes.get(msg.streamId);
          if (pane) {
            this.writeToTmuxSocket(pane, encodeControl({ type: 'resize', cols: msg.cols, rows: msg.rows }));
          }
          return null;
        }

        if (msg.type === 'attach_session') {
          return this.handleBrowseMessage(connectionId, session, data);
        }


        if (msg.requestId && typeof msg.type === 'string') {
          return this.handleBrowseMessage(connectionId, session, data);
        }

        return null;
      }

      const pane = session.attachedPanes.get(result.streamId);
      if (!pane) {
        return null;
      }
      if (pane.viewOnly || !canWrite(session.accessType)) {
        console.warn(`[session-manager] Read-only client ${connectionId} attempted PTY write - denied`);
        return null;
      }
      this.writeToTmuxSocket(pane, encodePTY(result.data));
      return null;
    } catch (e) {
      console.error("[session-manager] Error handling encrypted session message:", e);
      return null;
    }
  }

  /**
   * Handle an explicit command message while in attached state (agent interaction only).
   * Returns the CommandResponse to send back, or null on error.
   */
  private async handleAttachedCommand(
    session: ClientSession,
    msg: { type: string; requestId: string; [key: string]: unknown },
  ): Promise<{ type: 'command_response'; requestId: string; response: TmuxResponse } | null> {
    if (!canManage(session.accessType)) {
      return { type: 'command_response', requestId: msg.requestId, response: { type: 'error', message: 'Permission denied' } };
    }
    try {
      let tmuxCommand: TmuxCommand;
      switch (msg.type) {
        case 'prompt_agent_session':
          tmuxCommand = {
            type: 'agent-prompt',
            target: msg.target as any,
            agentSessionId: msg.agentSessionId as string,
            text: msg.text as string,
            images: msg.images as any,
            streamingBehavior: msg.streamingBehavior as any,
          };
          break;
        case 'abort_agent_session':
          tmuxCommand = { type: 'agent-abort', target: msg.target as any, agentSessionId: msg.agentSessionId as string };
          break;
        case 'interrupt_agent_session':
          tmuxCommand = { type: 'agent-interrupt', target: msg.target as any, agentSessionId: msg.agentSessionId as string };
          break;
        case 'respond_agent_permission':
          tmuxCommand = {
            type: 'agent-permission',
            target: msg.target as any,
            agentSessionId: msg.agentSessionId as string,
            permissionId: msg.permissionId as string,
            response: msg.response as 'allow' | 'deny',
          };
          break;
        case 'respond_agent_dialog':
          tmuxCommand = {
            type: 'agent-dialog-response',
            dialogId: msg.dialogId as string,
            dialogType: msg.dialogType as any,
            value: msg.value as any,
          };
          break;
        default:
          return { type: 'command_response', requestId: msg.requestId, response: { type: 'error', message: `Command ${msg.type} not allowed while attached` } };
      }
      await ensureTmuxLiteServer();
      const response = await sendTmuxLiteCommand(tmuxCommand);
      return { type: 'command_response', requestId: msg.requestId, response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { type: 'command_response', requestId: msg.requestId, response: { type: 'error', message } };
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

    if (remoteSession.state === "attached" && remoteSession.attachedSessionId) {
      if (remoteSession.streamId === undefined || !remoteSession.sessionSocketPath) {
        throw new Error('attach_session resolved without streamId or socket path');
      }
      const existingPane = session.attachedPanes.get(remoteSession.streamId);
      if (existingPane) {
        this.detachPane(session, existingPane, { sendDetachControl: true });
      }
      const pane: AttachedPane = {
        streamId: remoteSession.streamId,
        sessionId: remoteSession.attachedSessionId,
        sessionName: remoteSession.attachedSessionName ?? remoteSession.attachedSessionId,
        tmuxSocket: null,
        tmuxSocketWriter: null,
        sessionSocketPath: remoteSession.sessionSocketPath,
        initialCols: remoteSession.initialCols ?? 80,
        initialRows: remoteSession.initialRows ?? 24,
        viewOnly: remoteSession.viewOnly ?? false,
        frameBuffer: Buffer.alloc(0),
      };
      session.attachedPanes.set(pane.streamId, pane);
      await this.attachToTmuxLiteSession(connectionId, session, pane);
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
      // Parse as JSON handshake message. During handshake establishment, a later
      // encrypted frame can arrive before the state flip completes; ignore obviously
      // non-JSON payloads instead of treating them as fatal handshake errors.
      const jsonStr = new TextDecoder().decode(data);
      const trimmed = jsonStr.trimStart();
      if (!trimmed.startsWith('{')) {
        console.warn('[session-manager] Ignoring non-JSON payload while handshaking');
        return null;
      }
      const envelope = JSON.parse(trimmed) as HandshakeMessageEnvelope;

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
    session.attachedPanes.clear();
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
  private async attachToTmuxLiteSession(connectionId: string, session: ClientSession, pane: AttachedPane): Promise<void> {
    if (!session.sessionKeys) {
      console.error("[session-manager] Cannot attach: missing session keys");
      return;
    }

    const sendToClient = this.createSendCallback(connectionId);

    try {
      const socket = await Bun.connect({
        unix: pane.sessionSocketPath,
        socket: {
          drain: () => {
            pane.tmuxSocketWriter?.flush();
          },
          data: (sock, data) => {
            if (!session.sessionKeys) return;
            if (pane.tmuxSocket !== sock) return;

            const buf = Buffer.concat([pane.frameBuffer, Buffer.from(data)]);
            let frames;
            let remaining;
            try {
              const result = parseFrames(buf);
              frames = result.frames;
              remaining = result.remaining;
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Frame parse error';
              console.error(`[session-manager] Frame parse error: ${msg}`);
              this.handleDisconnect(connectionId, `Frame parse error: ${msg}`);
              return;
            }
            pane.frameBuffer = Buffer.from(remaining);

            for (const frame of frames) {
              if (frame.type === FrameType.CONTROL) {
                const event = decodeControl(frame.payload) as SessionEvent;

                if (event.type === "exited") {
                  console.log(`[session-manager] Session exited: ${event.code}`);
                  this.detachPane(session, pane);
                  const exitMsg = JSON.stringify({
                    type: "session_exited",
                    sessionId: pane.sessionId,
                    streamId: pane.streamId,
                    exitCode: event.code,
                  });
                  const exitData = new TextEncoder().encode(exitMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, exitData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                  return;
                }

                if (event.type === "kicked") {
                  console.log("[session-manager] Session kicked");
                  this.detachPane(session, pane);
                  const detachedMsg = JSON.stringify({ type: "detached", streamId: pane.streamId });
                  const detachedData = new TextEncoder().encode(detachedMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, detachedData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                  return;
                }

                if (event.type === "wide_event") {
                  const eventMsg = JSON.stringify({ type: "wide_event", event: event.event });
                  const eventData = new TextEncoder().encode(eventMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, eventData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                  continue;
                }

                if (event.type === 'session-meta') {
                  const metaMsg = JSON.stringify({ ...event, streamId: pane.streamId });
                  const metaData = new TextEncoder().encode(metaMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, metaData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                  continue;
                }

                if (event.type === 'attached') {
                  const attachedMsg = JSON.stringify({
                    type: 'attached',
                    streamId: pane.streamId,
                    sessionId: pane.sessionId,
                    sessionName: pane.sessionName,
                    viewOnly: pane.viewOnly,
                  });
                  const attachedData = new TextEncoder().encode(attachedMsg);
                  const encFrame = createFrame(STREAM_ID.DATA, attachedData, session.sessionKeys.sendKey);
                  sendToClient(Buffer.from(encFrame));
                }
              } else if (frame.type === FrameType.PTY) {
                const encFrame = createFrame(pane.streamId, frame.payload, session.sessionKeys.sendKey);
                sendToClient(Buffer.from(encFrame));
              }
            }
          },

          close: () => {
            if (pane.tmuxSocket === socket) {
              console.log("[session-manager] tmux-lite pane socket closed unexpectedly");
              this.detachPane(session, pane);
              const detachedMsg = JSON.stringify({ type: "detached", streamId: pane.streamId });
              const detachedData = new TextEncoder().encode(detachedMsg);
              const encFrame = createFrame(STREAM_ID.DATA, detachedData, session.sessionKeys!.sendKey);
              sendToClient(Buffer.from(encFrame));
            }
          },

          error: (sock, e) => {
            if (pane.tmuxSocket === sock) {
              logger.error(`[session-manager] tmux-lite socket error for ${connectionId}: ${e.message}`);
              this.detachPane(session, pane);
            }
          },
        }
      });

      pane.tmuxSocket = socket;
      pane.tmuxSocketWriter = createBufferedSocketWriter(socket);
      this.writeToTmuxSocket(pane, encodeControl({
        type: 'attach-init',
        cols: pane.initialCols,
        rows: pane.initialRows,
        clientType: 'web',
      }));
      console.log(`[session-manager] Connected to tmux-lite session: ${pane.sessionSocketPath} stream=${pane.streamId} (sent attach-init ${pane.initialCols}x${pane.initialRows})`);
    } catch (e) {
      console.error("[session-manager] Failed to connect to tmux-lite session:", e);
      this.detachPane(session, pane);
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to connect to session: ${msg}`);
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

    this.detachAllPanes(session, { sendDetachControl: true });

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
      if (!session.sessionKeys || session.state !== 'browsing') continue;
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
   * Broadcast a raw remote-session message to all authenticated browsing clients.
   * Used for host UI dialog requests and events.
   */
  async broadcastRawMessage(message: Record<string, unknown>): Promise<void> {
    const msg = serializeRemoteMessage(message as any);
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
