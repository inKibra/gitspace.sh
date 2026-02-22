/**
 * Relay client - WebSocket connection from client to relay
 *
 * Handles:
 * - Connection to relay server
 * - X3DH handshake for mutual authentication and key exchange
 * - Reconnection with exponential backoff
 * - Sending/receiving encrypted frames
 */

import {
  createFrame,
  openFrame,
  MASTER_STREAM_ID,
} from "./crypto";
import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processServerAuth,
  type X3DHClientState,
} from "./crypto/handshake.js";
import type {
  Identity,
  SessionKeys,
  AccessType,
  X3DHResponseMessage,
  X3DHAuthMessage,
  X3DHResultMessage,
} from "../../types/identity.js";
import { signMessage, type SignatureBlock } from "../../relay/signing.js";

/** Relay client configuration (identity/X3DH handshake) */
export interface RelayClientConfig {
  /** Relay WebSocket URL (e.g., wss://relay.example.com/ws) */
  relayUrl: string;
  /** Machine ID hint for relay routing */
  machineId?: string;
  /** Client's identity for authentication */
  identity: Identity;
  /** JSON-serialized device certificate for relay + handshake authorization */
  deviceCertificate: string;
}

/** Connection state */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "connected"
  | "reconnecting";

/** Relay client events */
export interface RelayClientEvents {
  /** Called when connected to relay */
  onConnect?: () => void;
  /** Called when disconnected from relay */
  onDisconnect?: (code: number, reason: string) => void;
  /** Called when a message is received (already decrypted) */
  onMessage?: (streamId: number, data: Buffer) => void;
  /** Called on connection error */
  onError?: (error: Error) => void;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
  /** Called when handshake completes */
  onHandshakeComplete?: (peerIdentityId: string, accessType: AccessType, sessionId?: string) => void;
}

/**
 * Relay client for identity-based connections
 *
 * Uses X3DH handshake with Ed25519/X25519 keys.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private events: RelayClientEvents;
  private state: ConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readKey: Buffer | null = null;
  private writeKey: Buffer | null = null;

  // X3DH handshake state (identity mode)
  private handshakeState: X3DHClientState | null = null;
  private sessionKeys: SessionKeys | null = null;
  private peerIdentityId: string | null = null;
  private accessType: AccessType | null = null;
  private sessionId: string | undefined = undefined;

  /** Maximum reconnect attempts */
  private readonly maxReconnectAttempts = 10;
  /** Base reconnect delay in ms */
  private readonly baseReconnectDelay = 1000;
  /** Maximum reconnect delay in ms */
  private readonly maxReconnectDelay = 30000;

  /**
   * Create a new relay client
   *
   * @param config - Client configuration
   * @param events - Event handlers
   */
  constructor(config: RelayClientConfig, events: RelayClientEvents = {}) {
    this.config = config;
    this.events = events;
  }

  /** Get current connection state */
  getState(): ConnectionState {
    return this.state;
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.state === "connected" && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Get peer identity ID */
  getPeerIdentityId(): string | null {
    return this.peerIdentityId;
  }

  /** Get current access type */
  getAccessType(): AccessType | null {
    return this.accessType;
  }

  /** Get current session ID */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Connect to the relay server
   */
  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "connected" || this.state === "handshaking") {
      return;
    }

    this.setState("connecting");
    this.doConnect();
  }

  /**
   * Disconnect from the relay server
   */
  disconnect(): void {
    this.cancelReconnect();
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.setState("disconnected");
  }

  /**
   * Send data to all connected clients (via relay)
   *
   * @param data - Plaintext data to send (will be encrypted)
   * @param streamId - Stream ID (default: master stream)
   */
  send(data: Buffer | Uint8Array, streamId = MASTER_STREAM_ID): boolean {
    if (!this.isConnected() || !this.writeKey) {
      return false;
    }

    try {
      const frame = createFrame(streamId, data, this.writeKey);

      // Relay mode: wrap encrypted frame in JSON data message
      this.ws!.send(JSON.stringify({
        type: "data",
        data: Buffer.from(frame).toString("base64"),
      }));
      return true;
    } catch (e) {
      console.error("[relay-client] Send error:", e);
      return false;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onStateChange?.(state);
    }
  }

  private doConnect(): void {
    const { relayUrl, machineId } = this.config;

    // Build WebSocket URL
    const url = new URL(relayUrl);
    if (machineId) {
      url.searchParams.set("m", machineId);
    }
    url.searchParams.set("role", "client");

    try {
      this.ws = new WebSocket(url.toString());
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        console.log("[relay-client] Connected to relay");
        this.reconnectAttempts = 0;

        // Need to send protocol message for routing
        // Then wait for connection_established before starting handshake
        this.sendConnectToMachine();
        // Handshake will start when we receive connection_established
      };

      this.ws.onclose = (event) => {
        console.log(
          `[relay-client] Disconnected: ${event.code} ${event.reason}`
        );
        this.ws = null;
        this.handshakeState = null;
        this.events.onDisconnect?.(event.code, event.reason);

        // Auto-reconnect unless explicitly disconnected
        if (this.state !== "disconnected") {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (event) => {
        console.error("[relay-client] WebSocket error:", event);
        this.events.onError?.(new Error("WebSocket error"));
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    } catch (e) {
      console.error("[relay-client] Connection error:", e);
      this.events.onError?.(e as Error);
      this.scheduleReconnect();
    }
  }

  /**
   * Start X3DH handshake (identity mode)
   */
  private startHandshake(): void {
    if (!this.ws) {
      return;
    }

    console.log("[relay-client] Starting X3DH handshake");

    // Create ClientHello
    const { state, message } = createClientHello(this.config.machineId);
    this.handshakeState = state;

    // Send as JSON (handshake messages are not encrypted)
    this.ws.send(JSON.stringify({ type: "handshake", phase: "client_hello", data: message }));
  }

  private signClientMessage<T extends object>(message: T): T & { signature: SignatureBlock } {
    const privateKey = this.config.identity.signing.secretKey.slice(0, 32);
    const publicKey = this.config.identity.signing.publicKey;
    return signMessage(message, privateKey, publicKey);
  }

  /**
   * Send connect_to_machine protocol message for direct connection
   */
  private sendConnectToMachine(): void {
    if (!this.ws) {
      return;
    }

    if (!this.config.deviceCertificate) {
      this.events.onError?.(new Error("Device certificate is required for direct connections"));
      this.disconnect();
      return;
    }

    const clientIdentityId = this.config.identity.id;
    const machineId = this.config.machineId;

    console.log("[relay-client] Sending connect_to_machine");
    const signed = this.signClientMessage({
      type: "connect_to_machine",
      machineId,
      clientIdentityId,
      deviceCertificate: this.config.deviceCertificate,
    });
    this.ws.send(JSON.stringify(signed));
  }

  private handleMessage(data: ArrayBuffer | string): void {
    try {
      const jsonData = data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : data;

      const msg = JSON.parse(jsonData);

      // Handle relay protocol messages
      if (msg.type === "connection_established") {
        console.log("[relay-client] Connection established to machine:", msg.machineId);
        // Now start X3DH handshake - relay has set up the connection
        this.setState("handshaking");
        this.startHandshake();
        return;
      }

      if (msg.type === "error") {
        console.error("[relay-client] Relay error:", msg.message);
        this.events.onError?.(new Error(msg.message || "Relay error"));
        this.disconnect();
        return;
      }

      if (msg.type === "handshake" && this.state === "handshaking") {
        this.handleHandshakeMessage(msg);
        return;
      }

      if (msg.type === "data" && msg.data && this.state === "handshaking") {
        // Handle handshake wrapped in data message from relay
        try {
          const decodedData = Buffer.from(msg.data, "base64").toString("utf-8");
          const innerMsg = JSON.parse(decodedData);
          if (innerMsg.type === "handshake") {
            this.handleHandshakeMessage(innerMsg);
          }
        } catch {
          // Ignore non-handshake data during handshaking
        }
        return;
      }

      if (msg.type === "data" && msg.data && this.state === "connected" && this.readKey) {
        const frameBuffer = Buffer.from(msg.data, "base64");
        const result = openFrame(frameBuffer, this.readKey);
        if (result) {
          this.events.onMessage?.(result.streamId, result.data);
        } else {
          console.warn("[relay-client] Failed to decrypt frame");
        }
      }
    } catch (e) {
      console.error("[relay-client] Message handling error:", e);
    }
  }

  /**
   * Handle X3DH handshake messages
   */
  private handleHandshakeMessage(msg: { type: string; phase: string; data: unknown }): void {
    if (!this.handshakeState || !this.ws) {
      return;
    }

    try {
      switch (msg.phase) {
        case "server_hello": {
          console.log("[relay-client] Received ServerHello");

          // Process ServerHello
          const serverHello = msg.data as X3DHResponseMessage;
          const newState = processServerHello(this.handshakeState, serverHello);

          if (!newState) {
            console.error("[relay-client] Invalid ServerHello");
            this.events.onError?.(new Error("Handshake failed: invalid ServerHello"));
            this.disconnect();
            return;
          }

          // Create and send ClientAuth
          const authorization: X3DHAuthMessage["authorization"] = { type: "access_list" };

          const { state, message, sessionKeys } = createClientAuth(
            newState,
            this.config.identity,
            authorization,
            this.config.deviceCertificate,
          );

          this.handshakeState = state;
          this.sessionKeys = sessionKeys;

          console.log("[relay-client] Sending ClientAuth");
          this.ws.send(JSON.stringify({ type: "handshake", phase: "client_auth", data: message }));
          break;
        }

        case "server_auth": {
          console.log("[relay-client] Received ServerAuth");

          if (!this.sessionKeys) {
            console.error("[relay-client] Missing session keys");
            this.disconnect();
            return;
          }

          // Process ServerAuth
          const serverAuth = msg.data as X3DHResultMessage;
          const result = processServerAuth(this.handshakeState, serverAuth, this.sessionKeys);

          if (!result) {
            console.error("[relay-client] Handshake failed: invalid ServerAuth");
            this.events.onError?.(new Error("Handshake failed: authentication rejected"));
            this.disconnect();
            return;
          }

          // Check if accepted
          if (result.authResult.type === "rejected") {
            console.error("[relay-client] Access denied:", result.authResult.reason);
            this.events.onError?.(new Error(`Access denied: ${result.authResult.reason}`));
            this.disconnect();
            return;
          }

          // Handshake complete - set up encryption keys
          this.peerIdentityId = result.peerIdentityId;
          this.accessType = result.authResult.accessType;
          this.sessionId = result.authResult.sessionId;

          // Convert session keys to Buffers for frame encryption
          this.writeKey = Buffer.from(result.sessionKeys.sendKey);
          this.readKey = Buffer.from(result.sessionKeys.receiveKey);

          console.log("[relay-client] Handshake complete, session established");
          this.setState("connected");
          this.events.onConnect?.();
          this.events.onHandshakeComplete?.(this.peerIdentityId, this.accessType, this.sessionId);
          break;
        }

        default:
          console.warn("[relay-client] Unknown handshake phase:", msg.phase);
      }
    } catch (e) {
      console.error("[relay-client] Handshake error:", e);
      this.events.onError?.(new Error(`Handshake error: ${e instanceof Error ? e.message : String(e)}`));
      this.disconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[relay-client] Max reconnect attempts reached");
      this.setState("disconnected");
      return;
    }

    this.setState("reconnecting");
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1) +
        Math.random() * 1000,
      this.maxReconnectDelay
    );

    console.log(
      `[relay-client] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
