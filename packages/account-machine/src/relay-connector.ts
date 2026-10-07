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
import { SERVICE_ASSERTION_HEADER, stripGitSpaceCredentials } from '@gitspace/protocol/service-access';

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

/** Why the current socket was torn down; `code`/`reason` are the relay's close frame. */
interface RelayDisconnect {
  cause: 'close' | 'error' | 'connect-timeout' | 'heartbeat-timeout' | 'protocol' | 'send' | 'connect' | 'stop';
  error?: unknown;
  code?: number;
  reason?: string;
}

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
  private openedAt: number | null = null;
  private stopped = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly forwarding = new Map<string, AbortController>();
  private readonly serviceSockets = new Map<string, WebSocket>();

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
    if (this.socket) this.reconnect(this.socket, { cause: 'stop' });
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
        this.reconnect(socket, { cause: 'connect-timeout', error: new Error('Machine relay connection timed out; reconnecting') });
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return;
        this.openedAt = Date.now();
        console.log(JSON.stringify({ event: 'relay_connected', at: new Date(this.openedAt).toISOString(), origin: url.origin }));
        this.heartbeat(socket);
      });
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return;
        void this.handleMessage(socket, typeof event.data === 'string' ? event.data : '')
          .catch((error) => this.reconnect(socket, { cause: 'protocol', error }));
      });
      socket.addEventListener('close', (event) => {
        this.reconnect(socket, {
          cause: 'close', code: event.code, reason: event.reason,
          error: new Error(`Machine relay closed (${event.code}: ${event.reason || 'no reason'}); reconnecting`),
        });
      });
      socket.addEventListener('error', () => {
        this.reconnect(socket, { cause: 'error', error: new Error('Machine relay socket failed; reconnecting') });
      });
    } catch (error) {
      if (this.socket) this.reconnect(this.socket, { cause: 'connect', error });
      else {
        this.options.onError?.(error);
        this.scheduleReconnect();
      }
    }
  }

  private reconnect(socket: BunWebSocket, disconnect: RelayDisconnect): void {
    if (this.socket !== socket) return;
    const now = Date.now();
    // Aborting transport does not roll back mutations. Never replay them on a new socket.
    const abortedRequests = this.forwarding.size;
    const discardedRequests = this.pending.size;
    const connectionAgeMs = this.openedAt === null ? null : now - this.openedAt;
    this.socket = null;
    this.openedAt = null;
    clearTimeout(this.livenessTimer ?? undefined);
    this.livenessTimer = null;
    this.heartbeatNonce = null;
    this.pending.clear();
    for (const controller of this.forwarding.values()) controller.abort();
    this.forwarding.clear();
    for (const service of this.serviceSockets.values()) service.close(1011, 'Machine relay disconnected');
    this.serviceSockets.clear();
    socket.terminate();
    const { cause, error, code, reason } = disconnect;
    console.warn(JSON.stringify({
      event: 'relay_closed', at: new Date(now).toISOString(), cause,
      ...(code === undefined ? {} : { code, reason: reason ?? '' }),
      connectionAgeMs, abortedRequests, discardedRequests,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    }));
    if (this.stopped) return;
    this.scheduleReconnect();
    if (error) this.options.onError?.(error);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    console.log(JSON.stringify({ event: 'relay_reconnect', at: new Date().toISOString(), delayMs: delay }));
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
      this.reconnect(socket, { cause: 'heartbeat-timeout', error: new Error('Machine relay heartbeat timed out; reconnecting (in-flight request outcomes may be unknown)') });
    }, RELAY_HEARTBEAT_TIMEOUT_MS);
    try {
      this.send(socket, {
        version: RELAY_PROTOCOL_VERSION,
        type: 'frame',
        to: `machine:${this.options.machineId}`,
        payload: this.heartbeatNonce,
      });
    } catch (error) {
      this.reconnect(socket, { cause: 'send', error });
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
    if (message.type === 'tunnel.websocket.data') {
      this.serviceSockets.get(message.requestId)?.send(message.binary ? Uint8Array.from(decodeTunnelChunk(message.data)) : message.data);
      return;
    }
    if (message.type === 'tunnel.websocket.close') {
      this.serviceSockets.get(message.requestId)?.close(1000, message.reason);
      this.serviceSockets.delete(message.requestId);
      return;
    }
    if (message.type === 'tunnel.request.cancel') {
      this.pending.delete(message.requestId);
      this.forwarding.get(message.requestId)?.abort();
      this.serviceSockets.get(message.requestId)?.close();
      this.serviceSockets.delete(message.requestId);
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
      const websocket = new Headers(pending.headers).get('upgrade')?.toLowerCase() === 'websocket';
      if (websocket) {
        const headers = new Headers(pending.headers);
        headers.delete('upgrade'); headers.delete('connection');
        headers.set('x-gitspace-websocket-probe', '1');
        const admitted = await fetch(new URL(pending.path, this.options.localOrigin), { headers, signal: controller.signal });
        if (!admitted.ok) throw new Error('Service WebSocket authorization rejected');
        const raw: unknown = await admitted.json();
        if (!raw || typeof raw !== 'object' || !('url' in raw) || typeof raw.url !== 'string') throw new Error('Invalid service WebSocket target');
        const target = new URL(raw.url);
        if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1') throw new Error('Invalid service WebSocket target');
        headers.delete('host');
        headers.delete('x-gitspace-websocket-probe');
        headers.delete(SERVICE_ASSERTION_HEADER);
        stripGitSpaceCredentials(headers);
        const service: unknown = Reflect.construct(WebSocket, [target, { headers: Object.fromEntries(headers) } satisfies Bun.WebSocketOptions]);
        if (!(service instanceof WebSocket)) throw new Error('Bun WebSocket construction failed');
        this.serviceSockets.set(requestId, service);
        service.binaryType = 'arraybuffer';
        service.addEventListener('open', () => this.send(socket, { version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.open', requestId }));
        service.addEventListener('message', event => this.send(socket, { version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.data', requestId, binary: typeof event.data !== 'string', data: typeof event.data === 'string' ? event.data : encodeTunnelChunk(new Uint8Array(event.data)) }));
        service.addEventListener('close', event => {
          this.serviceSockets.delete(requestId);
          if (this.socket === socket) this.send(socket, { version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.close', requestId, code: event.code, reason: event.reason.slice(0, 123) });
        });
        service.addEventListener('error', () => {
          if (this.socket === socket) this.send(socket, { version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.error', requestId, message: 'Service WebSocket failed' });
        });
        return;
      }
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
