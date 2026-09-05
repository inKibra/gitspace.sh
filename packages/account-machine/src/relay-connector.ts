import {
  RELAY_PROTOCOL_VERSION,
  TUNNEL_CHUNK_BYTES,
  createRelayAuthorization,
  decodeTunnelChunk,
  encodeTunnelChunk,
  parseTunnelRequestMessage,
  type TunnelResponseMessage,
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
type BunWebSocketConstructor = new (url: string | URL, options: { headers: Record<string, string> }) => WebSocket;


function socketUrl(relayUrl: string, machineId: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/ws`;
  url.search = new URLSearchParams({ role: 'machine', id: machineId }).toString();
  return url;
}

export class MachineRelayConnector {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 500;
  private stopped = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: MachineRelayConnectorOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'Machine stopping');
    this.socket = null;
    this.pending.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = socketUrl(this.options.relayUrl, this.options.machineId);
    const target = `${url.pathname}${url.search}`;
    const headers = {
      authorization: createRelayAuthorization(this.options.signingPrivateKey, target),
      'x-gitspace-machine-grant': encodedGrant(this.options.machineGrant),
    };
    const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;
    const socket = new BunWebSocket(url, { headers });
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectDelayMs = 500;
      console.log(`[gitspace-relay] connected ${url.origin}`);
    });
    socket.addEventListener('message', (event) => {
      void this.handleMessage(socket, typeof event.data === 'string' ? event.data : '').catch((error) => this.options.onError?.(error));
    });
    socket.addEventListener('close', (event) => {
      if (!this.stopped && event.code !== 1000) this.options.onError?.(new Error(`Machine relay closed (${event.code}: ${event.reason || 'no reason'})`));
      this.reconnect(socket);
    });
    socket.addEventListener('error', (error) => this.options.onError?.(error));
  }

  private reconnect(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.pending.clear();
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleMessage(socket: WebSocket, input: string): Promise<void> {
    const parsed = parseTunnelRequestMessage(input);
    if (parsed.status === 'error') throw new Error(parsed.error.message);
    const message = parsed.value;
    if (message.type === 'tunnel.request.start') {
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

  private async forward(socket: WebSocket, requestId: string, pending: PendingRequest): Promise<void> {
    try {
      const bodyLength = pending.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const body = bodyLength === 0
        ? undefined
        : new Blob(pending.chunks.map((chunk) => Uint8Array.from(chunk).buffer)).stream();
      const response = await fetch(new URL(pending.path, this.options.localOrigin), {
        method: pending.method,
        headers: pending.headers,
        body,
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
      this.send(socket, {
        version: RELAY_PROTOCOL_VERSION,
        type: 'tunnel.response.error',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private send(socket: WebSocket, message: TunnelResponseMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
