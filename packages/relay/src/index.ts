import { DurableObject } from 'cloudflare:workers';
import {
  RELAY_PROTOCOL_VERSION,
  TUNNEL_CHUNK_BYTES,
  decodeTunnelChunk,
  encodeTunnelChunk,
  endpointTag,
  parseRelaySocketMessage,
  socketAttachmentSchema,
  verifyRelayAuthorization,
  type SocketAttachment,
  type TunnelRequestMessage,
} from '@gitspace/protocol';

const INTERNAL_NONCE = 'x-gitspace-auth-nonce';
const INTERNAL_TIMESTAMP = 'x-gitspace-auth-timestamp';
const INTERNAL_ROLE = 'x-gitspace-role';
const INTERNAL_ENDPOINT_ID = 'x-gitspace-endpoint-id';
const INTERNAL_TUNNEL_MACHINE = 'x-gitspace-tunnel-machine';
const INTERNAL_TUNNEL_PATH = 'x-gitspace-tunnel-path';
const ENDPOINT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface PendingTunnel {
  machineId: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  timeout: number;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function filteredHeaders(headers: Headers, requestDirection: boolean): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('cf-') || lower.startsWith('x-gitspace-')) continue;
    if (requestDirection && (lower === 'authorization' || lower === 'host')) continue;
    result.push([name, value]);
  }
  return result;
}

function tunnelTarget(url: URL): { machineId: string; path: string } | null {
  const match = /^\/tunnel\/([^/]+)(\/.*)?$/u.exec(url.pathname);
  if (!match) return null;
  const machineId = decodeURIComponent(match[1]!);
  if (!ENDPOINT_ID.test(machineId)) return null;
  return { machineId, path: `${match[2] ?? '/'}${url.search}` };
}

function authorizedRequest(request: Request, env: Env): Response | { nonce: string; timestamp: number; target: string } {
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  const verified = verifyRelayAuthorization({
    header: request.headers.get('authorization'),
    signingPublicKey: env.AUTH_PUBLIC_KEY,
    target,
    maxSkewMs: Number(env.AUTH_MAX_SKEW_MS),
  });
  return verified.status === 'error'
    ? jsonError(401, 'UNAUTHORIZED', verified.error.message)
    : { ...verified.value, target };
}

function relayRequest(request: Request, authorization: { nonce: string; timestamp: number }, headers: Headers): Request {
  headers.set(INTERNAL_NONCE, authorization.nonce);
  headers.set(INTERNAL_TIMESTAMP, String(authorization.timestamp));
  headers.delete('authorization');
  return new Request(request, { headers });
}

export class UserRelayDO extends DurableObject<Env> {
  private readonly pendingTunnels = new Map<string, PendingTunnel>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS auth_nonces (
          nonce TEXT PRIMARY KEY,
          used_at INTEGER NOT NULL
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const nonce = request.headers.get(INTERNAL_NONCE);
    const timestamp = Number(request.headers.get(INTERNAL_TIMESTAMP));
    if (!nonce || !Number.isSafeInteger(timestamp) || !this.consumeNonce(nonce, timestamp)) {
      return jsonError(401, 'AUTH_REPLAY', 'Relay authorization was already used or is invalid');
    }

    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.acceptSocket(request);
    if (url.pathname.startsWith('/tunnel/')) return this.openTunnel(request);
    return jsonError(404, 'NOT_FOUND', 'Relay route not found');
  }

  async webSocketMessage(socket: WebSocket, input: string | ArrayBuffer): Promise<void> {
    if (typeof input !== 'string') {
      socket.close(1003, 'Text protocol required');
      return;
    }
    const parsed = parseRelaySocketMessage(input);
    if (parsed.status === 'error') {
      socket.close(1007, 'Invalid relay message');
      return;
    }
    const attachment = this.socketAttachment(socket);
    if (!attachment) {
      socket.close(1011, 'Missing socket identity');
      return;
    }

    const message = parsed.value;
    if (message.type === 'frame') {
      for (const target of this.ctx.getWebSockets(`endpoint:${message.to}`)) target.send(input);
      return;
    }
    if (attachment.role !== 'machine') {
      socket.close(1008, 'Only machines may answer tunnel requests');
      return;
    }
    const pending = this.pendingTunnels.get(message.requestId);
    if (!pending || pending.machineId !== attachment.id) return;

    switch (message.type) {
      case 'tunnel.response.start': {
        if (pending.writer) return;
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        pending.writer = stream.writable.getWriter();
        const headers = new Headers(filteredHeaders(new Headers(message.headers), false));
        pending.resolve(new Response(stream.readable, { status: message.status, headers }));
        this.refreshTunnelTimeout(message.requestId, pending);
        return;
      }
      case 'tunnel.response.chunk':
        if (!pending.writer) return;
        await pending.writer.write(decodeTunnelChunk(message.data));
        this.refreshTunnelTimeout(message.requestId, pending);
        return;
      case 'tunnel.response.end':
        if (!pending.writer) {
          this.failTunnel(message.requestId, new Error('Tunnel ended before response headers'));
          return;
        }
        await pending.writer.close();
        this.finishTunnel(message.requestId);
        return;
      case 'tunnel.response.error':
        this.failTunnel(message.requestId, new Error(message.message));
        return;
      default:
        return;
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = this.socketAttachment(socket);
    if (attachment?.role === 'machine') this.failMachineTunnels(attachment.id, new Error(`Machine disconnected (${code}: ${reason})`));
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = this.socketAttachment(socket);
    if (attachment?.role === 'machine') this.failMachineTunnels(attachment.id, new Error('Machine socket failed'));
  }

  private consumeNonce(nonce: string, timestamp: number): boolean {
    const expiry = timestamp - Number(this.env.AUTH_MAX_SKEW_MS) * 2;
    this.ctx.storage.sql.exec('DELETE FROM auth_nonces WHERE used_at < ?', expiry);
    try {
      this.ctx.storage.sql.exec('INSERT INTO auth_nonces (nonce, used_at) VALUES (?, ?)', nonce, timestamp);
      return true;
    } catch {
      return false;
    }
  }

  private acceptSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonError(426, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
    }
    const role = request.headers.get(INTERNAL_ROLE);
    const id = request.headers.get(INTERNAL_ENDPOINT_ID);
    const parsed = socketAttachmentSchema.safeParse({ role, id });
    if (!parsed.success) return jsonError(400, 'INVALID_ENDPOINT', 'Invalid relay role or endpoint id');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = parsed.data;
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [endpointTag(attachment)]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async openTunnel(request: Request): Promise<Response> {
    const machineId = request.headers.get(INTERNAL_TUNNEL_MACHINE);
    const path = request.headers.get(INTERNAL_TUNNEL_PATH);
    if (!machineId || !path) return jsonError(400, 'INVALID_TUNNEL', 'Tunnel target is missing');
    const machine = this.ctx.getWebSockets(`endpoint:machine:${machineId}`)[0];
    if (!machine) return jsonError(503, 'MACHINE_OFFLINE', `Machine ${machineId} is offline`);

    const requestId = crypto.randomUUID();
    const {
      promise: responsePromise,
      resolve: resolveResponse,
      reject: rejectResponse,
    } = Promise.withResolvers<Response>();
    const pending: PendingTunnel = {
      machineId,
      resolve: resolveResponse,
      reject: rejectResponse,
      timeout: setTimeout(() => this.failTunnel(requestId, new Error('Timed out waiting for tunnel response headers')), Number(this.env.TUNNEL_HEADER_TIMEOUT_MS)),
    };
    this.pendingTunnels.set(requestId, pending);

    const start: TunnelRequestMessage = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'tunnel.request.start',
      requestId,
      method: request.method,
      path,
      headers: filteredHeaders(request.headers, true),
    };
    machine.send(JSON.stringify(start));
    try {
      await this.sendRequestBody(machine, requestId, request.body);
      return await responsePromise;
    } catch (error) {
      this.failTunnel(requestId, error instanceof Error ? error : new Error(String(error)));
      return await responsePromise;
    }
  }

  private async sendRequestBody(machine: WebSocket, requestId: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body) {
      const reader = body.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          for (let offset = 0; offset < result.value.byteLength; offset += TUNNEL_CHUNK_BYTES) {
            const message: TunnelRequestMessage = {
              version: RELAY_PROTOCOL_VERSION,
              type: 'tunnel.request.chunk',
              requestId,
              data: encodeTunnelChunk(result.value.subarray(offset, offset + TUNNEL_CHUNK_BYTES)),
            };
            machine.send(JSON.stringify(message));
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    const end: TunnelRequestMessage = { version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.end', requestId };
    machine.send(JSON.stringify(end));
  }

  private refreshTunnelTimeout(requestId: string, pending: PendingTunnel): void {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(
      () => this.failTunnel(requestId, new Error('Tunnel response stalled')),
      Number(this.env.TUNNEL_IDLE_TIMEOUT_MS),
    );
  }

  private finishTunnel(requestId: string): void {
    const pending = this.pendingTunnels.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTunnels.delete(requestId);
  }

  private failTunnel(requestId: string, error: Error): void {
    const pending = this.pendingTunnels.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTunnels.delete(requestId);
    if (pending.writer) void pending.writer.abort(error);
    else pending.reject(error);
  }

  private failMachineTunnels(machineId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingTunnels) {
      if (pending.machineId === machineId) this.failTunnel(requestId, error);
    }
  }

  private socketAttachment(socket: WebSocket): SocketAttachment | null {
    const parsed = socketAttachmentSchema.safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', protocolVersion: RELAY_PROTOCOL_VERSION });
    }
    const authorization = authorizedRequest(request, env);
    if (authorization instanceof Response) return authorization;

    const headers = new Headers(request.headers);
    if (url.pathname === '/ws') {
      const parsed = socketAttachmentSchema.safeParse({ role: url.searchParams.get('role'), id: url.searchParams.get('id') });
      if (!parsed.success) return jsonError(400, 'INVALID_ENDPOINT', 'Invalid relay role or endpoint id');
      headers.set(INTERNAL_ROLE, parsed.data.role);
      headers.set(INTERNAL_ENDPOINT_ID, parsed.data.id);
    } else {
      const tunnel = tunnelTarget(url);
      if (!tunnel) return jsonError(404, 'NOT_FOUND', 'Relay route not found');
      headers.set(INTERNAL_TUNNEL_MACHINE, tunnel.machineId);
      headers.set(INTERNAL_TUNNEL_PATH, tunnel.path);
    }

    const stub = env.RELAY.getByName(env.RELAY_NAME);
    return stub.fetch(relayRequest(request, authorization, headers));
  },
} satisfies ExportedHandler<Env>;
