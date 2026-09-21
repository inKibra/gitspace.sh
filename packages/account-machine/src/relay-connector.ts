import {
  RELAY_HEARTBEAT_INTERVAL_MS,
  RELAY_HEARTBEAT_MODE,
  RELAY_HEARTBEAT_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  TUNNEL_CHUNK_BYTES,
  createRelayAuthorization,
  decodeTunnelChunk,
  encodeTunnelChunk,
  parseMachineRelayMessage,
  type RelaySocketMessage,
} from '@gitspace/protocol';
import { signedCredentialAuthorityGrantSchema, type SignedCredentialAuthorityGrant } from '@gitspace/protocol/credential-vault';

interface PendingRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  chunks: Uint8Array[];
}

export interface MachineRelayConnectorOptions {
  relayUrl: string;
  machineId: string;
  machineGrant: SignedCredentialAuthorityGrant;
  signingPrivateKey: Uint8Array;
  localOrigin: string;
  onError?: (error: unknown) => void;
}

function encodedGrant(grant: SignedCredentialAuthorityGrant): string {
  const bytes = new TextEncoder().encode(JSON.stringify(signedCredentialAuthorityGrantSchema.parse(grant)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
type BunWebSocket = WebSocket & { terminate(): void };
type BunWebSocketConstructor = new (url: string | URL, options: { headers: Record<string, string> }) => BunWebSocket;
const CONNECT_TIMEOUT_MS = 15_000;


function socketUrl(relayUrl: string, machineId: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/ws`;
  url.search = new URLSearchParams({ role: 'machine', id: machineId, heartbeat: RELAY_HEARTBEAT_MODE }).toString();
  return url;
}

export class MachineRelayConnector {
  private socket: BunWebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatNonce: string | null = null;
  private reconnectDelayMs = 500;
  private stopped = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly forwarding = new Map<string, AbortController>();

  constructor(private readonly options: MachineRelayConnectorOptions) {}

  start(): void {
    if (this.socket || this.reconnectTimer) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    if (this.socket) this.reconnect(this.socket);
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const url = socketUrl(this.options.relayUrl, this.options.machineId);
      const target = `${url.pathname}${url.search}`;
      const headers = {
        authorization: createRelayAuthorization(this.options.signingPrivateKey, target),
        'x-gitspace-machine-grant': encodedGrant(this.options.machineGrant),
      };
      const Socket = WebSocket as unknown as BunWebSocketConstructor;
      const socket = new Socket(url, { headers });
      this.socket = socket;
      this.livenessTimer = setTimeout(() => {
        this.reconnect(socket, new Error('Machine relay connection timed out; reconnecting'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return;
        console.log(`[gitspace-relay] connected ${url.origin}`);
        this.heartbeat(socket);
      });
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return;
        void this.handleMessage(socket, typeof event.data === 'string' ? event.data : '')
          .catch((error) => this.reconnect(socket, error));
      });
      socket.addEventListener('close', (event) => {
        this.reconnect(socket, new Error(`Machine relay closed (${event.code}: ${event.reason || 'no reason'}); reconnecting`));
      });
      socket.addEventListener('error', () => {
        this.reconnect(socket, new Error('Machine relay socket failed; reconnecting'));
      });
    } catch (error) {
      if (this.socket) this.reconnect(this.socket, error);
      else {
        this.options.onError?.(error);
        this.scheduleReconnect();
      }
    }
  }

  private reconnect(socket: BunWebSocket, error?: unknown): void {
    if (this.socket !== socket) return;
    this.socket = null;
    clearTimeout(this.livenessTimer ?? undefined);
    this.livenessTimer = null;
    this.heartbeatNonce = null;
    this.pending.clear();
    // Aborting transport does not roll back mutations. Never replay them on a new socket.
    for (const controller of this.forwarding.values()) controller.abort();
    this.forwarding.clear();
    socket.terminate();
    if (this.stopped) return;
    this.scheduleReconnect();
    if (error) this.options.onError?.(error);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private heartbeat(socket: BunWebSocket): void {
    if (this.socket !== socket) return;
    clearTimeout(this.livenessTimer ?? undefined);
    this.heartbeatNonce = crypto.randomUUID();
    this.livenessTimer = setTimeout(() => {
      this.reconnect(socket, new Error('Machine relay heartbeat timed out; reconnecting (in-flight request outcomes may be unknown)'));
    }, RELAY_HEARTBEAT_TIMEOUT_MS);
    try {
      this.send(socket, {
        version: RELAY_PROTOCOL_VERSION,
        type: 'frame',
        to: `machine:${this.options.machineId}`,
        payload: this.heartbeatNonce,
      });
    } catch (error) {
      this.reconnect(socket, error);
    }
  }

  private async handleMessage(socket: BunWebSocket, input: string): Promise<void> {
    const parsed = parseMachineRelayMessage(input);
    if (parsed.status === 'error') throw new Error(parsed.error.message);
    const message = parsed.value;
    if (message.type === 'frame') {
      if (message.to === `machine:${this.options.machineId}` && message.payload === this.heartbeatNonce) {
        this.heartbeatNonce = null;
        this.reconnectDelayMs = 500;
        clearTimeout(this.livenessTimer ?? undefined);
        this.livenessTimer = setTimeout(() => this.heartbeat(socket), RELAY_HEARTBEAT_INTERVAL_MS);
      }
      return;
    }
    if (message.type === 'tunnel.request.cancel') {
      this.pending.delete(message.requestId);
      this.forwarding.get(message.requestId)?.abort();
      return;
    }
    if (message.type === 'tunnel.request.start') {
      if (this.pending.has(message.requestId) || this.forwarding.has(message.requestId)) {
        throw new Error('Duplicate tunnel request');
      }
      this.pending.set(message.requestId, { method: message.method, path: message.path, headers: message.headers, chunks: [] });
      return;
    }
    if (message.type === 'tunnel.request.chunk') {
      this.pending.get(message.requestId)?.chunks.push(decodeTunnelChunk(message.data));
      return;
    }
    if (message.type !== 'tunnel.request.end') return;
    const pending = this.pending.get(message.requestId);
    this.pending.delete(message.requestId);
    if (!pending) return;
    await this.forward(socket, message.requestId, pending);
  }

  private async forward(socket: BunWebSocket, requestId: string, pending: PendingRequest): Promise<void> {
    const controller = new AbortController();
    this.forwarding.set(requestId, controller);
    try {
      const bodyLength = pending.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const body = bodyLength === 0
        ? undefined
        : new Blob(pending.chunks.map((chunk) => Uint8Array.from(chunk).buffer)).stream();
      const response = await fetch(new URL(pending.path, this.options.localOrigin), {
        method: pending.method,
        headers: pending.headers,
        body,
        signal: controller.signal,
        ...(body ? { duplex: 'half' } : {}),
      } as RequestInit);
      this.send(socket, {
        version: RELAY_PROTOCOL_VERSION,
        type: 'tunnel.response.start',
        requestId,
        status: response.status,
        headers: [...response.headers],
      });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            for (let offset = 0; offset < result.value.byteLength; offset += TUNNEL_CHUNK_BYTES) {
              this.send(socket, {
                version: RELAY_PROTOCOL_VERSION,
                type: 'tunnel.response.chunk',
                requestId,
                data: encodeTunnelChunk(result.value.subarray(offset, offset + TUNNEL_CHUNK_BYTES)),
              });
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      this.send(socket, { version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.end', requestId });
    } catch (error) {
      if (this.socket !== socket || controller.signal.aborted) return;
      this.send(socket, {
        version: RELAY_PROTOCOL_VERSION,
        type: 'tunnel.response.error',
        requestId,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || 'Local request failed',
      });
    } finally {
      if (this.forwarding.get(requestId) === controller) this.forwarding.delete(requestId);
    }
  }

  private send(socket: BunWebSocket, message: RelaySocketMessage): void {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('Machine relay is disconnected');
    socket.send(JSON.stringify(message));
  }
}
