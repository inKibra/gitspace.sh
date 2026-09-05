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
  deviceGrantExpiresAt,
  type SocketAttachment,
  type TunnelRequestMessage,
} from '@gitspace/protocol';
import {
  credentialProtocolBase64,
  signedCredentialAuthorityGrantSchema,
  verifyCredentialAuthorityGrant,
  type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol/credential-vault';
import { WORKER_VERSION_HEADER } from '@gitspace/protocol/deployment';

declare const GITSPACE_WORKER_SHA: string | undefined;
const WORKER_VERSION = typeof GITSPACE_WORKER_SHA === 'string' ? GITSPACE_WORKER_SHA : 'channel';

const INTERNAL_NONCE = 'x-gitspace-auth-nonce';
const INTERNAL_TIMESTAMP = 'x-gitspace-auth-timestamp';
const INTERNAL_ROLE = 'x-gitspace-role';
const INTERNAL_ENDPOINT_ID = 'x-gitspace-endpoint-id';
const INTERNAL_TUNNEL_MACHINE = 'x-gitspace-tunnel-machine';
const INTERNAL_TUNNEL_PATH = 'x-gitspace-tunnel-path';
const INTERNAL_SIGNED_TARGET = 'x-gitspace-signed-target';
const MACHINE_GRANT_HEADER = 'x-gitspace-machine-grant';
const INTERNAL_HEADERS: Record<string, true> = {
  [INTERNAL_NONCE]: true,
  [INTERNAL_TIMESTAMP]: true,
  [INTERNAL_ROLE]: true,
  [INTERNAL_ENDPOINT_ID]: true,
  [INTERNAL_TUNNEL_MACHINE]: true,
  [INTERNAL_TUNNEL_PATH]: true,
  [INTERNAL_SIGNED_TARGET]: true,
};
const ENDPOINT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const ARTIFACT_PATH = /^\/artifacts\/([a-f0-9]{64})$/u;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MACHINE_LEASE_MS = 30_000;
const AUTHORITY_TIMEOUT_MS = 5_000;
const ENCRYPTED_ARTIFACT_CONTENT_TYPE = 'application/vnd.gitspace.encrypted';
const HOP_BY_HOP_HEADERS: Record<string, true> = {
  connection: true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
};

interface PendingTunnel {
  machineId: string;
  origin: string | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  timeout: number;
}

interface RelaySocketAttachment extends SocketAttachment {
  machineGrant?: SignedCredentialAuthorityGrant;
  authorizedUntil?: number;
}

function machineAuthorizationDeadline(grant: SignedCredentialAuthorityGrant): number {
  let deadline = Math.min(Date.now() + MACHINE_LEASE_MS, grant.grant.expiresAt ?? Infinity);
  for (const issuer of grant.issuerChain ?? []) deadline = Math.min(deadline, deviceGrantExpiresAt(issuer) ?? Infinity);
  return deadline;
}

async function currentMachineAuthority(
  env: Env,
  grant: SignedCredentialAuthorityGrant,
  capability: 'space.control' | 'storage.access',
): Promise<Response | null> {
  try {
    if (!verifyCredentialAuthorityGrant(grant, credentialProtocolBase64.decode(env.AUTH_PUBLIC_KEY))) {
      return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine issuer proof is invalid or expired');
    }
    const response = await fetch(new URL('/v1/relay/authorize', env.OPERATOR_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant, capability }),
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (response.status === 401 || response.status === 403) {
      return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine grant is revoked, stale, or lacks the required capability');
    }
    if (response.ok) {
      const body = await response.json() as { status?: unknown; value?: { authorized?: unknown } };
      if (body?.status === 'ok' && body.value?.authorized === true) return null;
    }
  } catch {
    // Current authority is required; never fall back to the offline signature.
  }
  return jsonError(503, 'MACHINE_AUTHORITY_UNAVAILABLE', 'Machine authority could not be verified');
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function filteredHeaders(headers: Headers, requestDirection: boolean): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS[lower] || lower.startsWith('cf-') || INTERNAL_HEADERS[lower]) continue;
    if (requestDirection && (lower === 'authorization' || lower === 'host' || lower === MACHINE_GRANT_HEADER)) continue;
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

function authorizedRootRequest(request: Request, env: Env): Response | { nonce: string; timestamp: number; target: string } {
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

function decodeMachineGrant(value: string | null) {
  if (!value) return null;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return signedCredentialAuthorityGrantSchema.parse(JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    )));
  } catch {
    return null;
  }
}

async function authorizedMachineRequest(request: Request, env: Env, machineId: string | null): Promise<Response | { nonce: string; timestamp: number; target: string }> {
  const signedGrant = decodeMachineGrant(request.headers.get(MACHINE_GRANT_HEADER));
  if (!signedGrant) return jsonError(401, 'MACHINE_GRANT_REQUIRED', 'Machine credential grant is missing or invalid');
  const grant = verifyCredentialAuthorityGrant(signedGrant, credentialProtocolBase64.decode(env.AUTH_PUBLIC_KEY));
  if (!grant || (machineId !== null && grant.machineId !== machineId)) {
    return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine credential grant is not valid for this relay endpoint');
  }
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  const verified = verifyRelayAuthorization({
    header: request.headers.get('authorization'),
    signingPublicKey: grant.signingPublicKey,
    target,
    maxSkewMs: Number(env.AUTH_MAX_SKEW_MS),
  });
  if (verified.status === 'error') return jsonError(401, 'UNAUTHORIZED', verified.error.message);
  // WebSocket authority is checked inside the DO immediately before replacement.
  const rejected = machineId === null ? await currentMachineAuthority(env, signedGrant, 'storage.access') : null;
  return rejected ?? { ...verified.value, target };
}


function relayRequest(request: Request, authorization: { nonce: string; timestamp: number }, headers: Headers): Request {
  headers.set(INTERNAL_NONCE, authorization.nonce);
  headers.set(INTERNAL_TIMESTAMP, String(authorization.timestamp));
  headers.delete('authorization');
  return new Request(request, { headers });
}

async function artifactDigest(bytes: ArrayBuffer): Promise<{ hex: string; digest: ArrayBuffer }> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { hex, digest };
}

async function handleArtifactRequest(request: Request, env: Env, hash: string): Promise<Response> {
  const key = `artifacts/${hash}`;
  if (request.method === 'PUT') {
    if (request.headers.get('content-type') !== ENCRYPTED_ARTIFACT_CONTENT_TYPE
      || request.headers.get('x-gitspace-encryption') !== 'aes-256-gcm-v1') {
      return jsonError(415, 'ENCRYPTION_REQUIRED', 'Artifact must use the GitSpace encrypted artifact format');
    }
    const length = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ARTIFACT_BYTES) {
      return jsonError(413, 'ARTIFACT_SIZE_INVALID', `Artifact content-length must be between 1 and ${MAX_ARTIFACT_BYTES}`);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== length) return jsonError(400, 'ARTIFACT_LENGTH_MISMATCH', 'Artifact body length does not match content-length');
    const calculated = await artifactDigest(bytes);
    if (calculated.hex !== hash) return jsonError(400, 'ARTIFACT_HASH_MISMATCH', 'Artifact ciphertext does not match its content address');
    await env.BLOBS.put(key, bytes, {
      sha256: calculated.digest,
      httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
      customMetadata: { encryption: 'aes-256-gcm-v1' },
    });
    return Response.json({ hash, bytes: length }, { status: 201 });
  }

  if (request.method === 'HEAD') {
    const object = await env.BLOBS.head(key);
    if (!object) return jsonError(404, 'ARTIFACT_NOT_FOUND', 'Encrypted artifact not found');
    return new Response(null, {
      headers: {
        'content-length': String(object.size),
        etag: object.httpEtag,
        'content-type': ENCRYPTED_ARTIFACT_CONTENT_TYPE,
        'x-gitspace-encryption': object.customMetadata?.encryption ?? 'unknown',
      },
    });
  }

  if (request.method === 'GET') {
    const object = await env.BLOBS.get(key);
    if (!object) return jsonError(404, 'ARTIFACT_NOT_FOUND', 'Encrypted artifact not found');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-length', String(object.size));
    headers.set('etag', object.httpEtag);
    headers.set('x-gitspace-encryption', object.customMetadata?.encryption ?? 'unknown');
    return new Response(object.body, { headers });
  }

  return jsonError(405, 'METHOD_NOT_ALLOWED', 'Artifact route supports PUT, GET, and HEAD');
}

export class UserRelayDO extends DurableObject<Env> {
  private readonly pendingTunnels = new Map<string, PendingTunnel>();
  private readonly machineChecks = new WeakMap<WebSocket, Promise<boolean>>();

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
    if (!nonce || !Number.isSafeInteger(timestamp) || !this.consumeAuthorization(nonce, timestamp)) {
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
    if (!await this.authorizeSocket(socket)) return;

    const message = parsed.value;
    if (message.type === 'frame') {
      for (const target of this.ctx.getWebSockets(`endpoint:${message.to}`)) {
        if (await this.authorizeSocket(target) && await this.authorizeSocket(socket)) target.send(input);
      }
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
        const origin = pending.origin;
        const allowedOrigin = `https://${this.env.RELAY_NAME}.gitspace.sh`;
        if (origin === allowedOrigin) {
          headers.set('access-control-allow-origin', allowedOrigin);
          headers.set('vary', 'origin');
        }
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

  consumeAuthorization(nonce: string, timestamp: number): boolean {
    const expiry = timestamp - Number(this.env.AUTH_MAX_SKEW_MS) * 2;
    this.ctx.storage.sql.exec('DELETE FROM auth_nonces WHERE used_at < ?', expiry);
    try {
      this.ctx.storage.sql.exec('INSERT INTO auth_nonces (nonce, used_at) VALUES (?, ?)', nonce, timestamp);
      return true;
    } catch {
      return false;
    }
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonError(426, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
    }
    const role = request.headers.get(INTERNAL_ROLE);
    const id = request.headers.get(INTERNAL_ENDPOINT_ID);
    const parsed = socketAttachmentSchema.safeParse({ role, id });
    if (!parsed.success) return jsonError(400, 'INVALID_ENDPOINT', 'Invalid relay role or endpoint id');
    const machineGrant = parsed.data.role === 'machine'
      ? decodeMachineGrant(request.headers.get(MACHINE_GRANT_HEADER))
      : null;
    if (parsed.data.role === 'machine' && !machineGrant) {
      return jsonError(401, 'MACHINE_GRANT_REQUIRED', 'Machine credential grant is missing');
    }
    // Begin the lease before the authority check, never after a slow response.
    const authorizedUntil = machineGrant ? machineAuthorizationDeadline(machineGrant) : Date.now() + MACHINE_LEASE_MS;
    if (machineGrant) {
      const rejected = await currentMachineAuthority(this.env, machineGrant, 'space.control');
      if (rejected || authorizedUntil <= Date.now()) return rejected ?? jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine grant has expired');
    }

    const tag = endpointTag(parsed.data);
    if (parsed.data.role === 'machine') {
      for (const existing of this.ctx.getWebSockets(tag)) existing.close(1000, 'Replaced by a newer machine connection');
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: RelaySocketAttachment = {
      ...parsed.data,
      ...(machineGrant ? { machineGrant, authorizedUntil } : {}),
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [tag]);
    if (machineGrant) await this.scheduleMachineCheck();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async openTunnel(request: Request): Promise<Response> {
    const machineId = request.headers.get(INTERNAL_TUNNEL_MACHINE);
    const path = request.headers.get(INTERNAL_TUNNEL_PATH);
    if (!machineId || !path) return jsonError(400, 'INVALID_TUNNEL', 'Tunnel target is missing');
    const machines: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets(`endpoint:machine:${machineId}`)) {
      if (await this.authorizeSocket(socket, true)) machines.push(socket);
    }
    if (machines.length === 0) return jsonError(503, 'MACHINE_OFFLINE', `Machine ${machineId} is offline`);

    const requestId = crypto.randomUUID();
    const {
      promise: responsePromise,
      resolve: resolveResponse,
      reject: rejectResponse,
    } = Promise.withResolvers<Response>();
    const pending: PendingTunnel = {
      machineId,
      origin: request.headers.get('origin'),
      resolve: resolveResponse,
      reject: rejectResponse,
      timeout: setTimeout(() => this.failTunnel(requestId, new Error('Timed out waiting for tunnel response headers')), Number(this.env.TUNNEL_HEADER_TIMEOUT_MS)),
    };
    this.pendingTunnels.set(requestId, pending);

    const tunnelHeaders = new Headers(filteredHeaders(request.headers, true));
    const signedTarget = request.headers.get(INTERNAL_SIGNED_TARGET);
    if (signedTarget) tunnelHeaders.set(INTERNAL_SIGNED_TARGET, signedTarget);
    const start: TunnelRequestMessage = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'tunnel.request.start',
      requestId,
      method: request.method,
      path,
      headers: [...tunnelHeaders],
    };
    const startJson = JSON.stringify(start);
    for (const machine of machines) machine.send(startJson);
    try {
      await this.sendRequestBody(machines, requestId, request.body);
      return await responsePromise;
    } catch (error) {
      this.failTunnel(requestId, error instanceof Error ? error : new Error(String(error)));
      return await responsePromise;
    }
  }

  private async sendRequestBody(machines: WebSocket[], requestId: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
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
            const json = JSON.stringify(message);
            for (const machine of machines) {
              if (!await this.authorizeSocket(machine)) throw new Error('Machine authorization expired');
              machine.send(json);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    const end = JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.end', requestId } satisfies TunnelRequestMessage);
    for (const machine of machines) {
      if (!await this.authorizeSocket(machine)) throw new Error('Machine authorization expired');
      machine.send(end);
    }
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

  async alarm(): Promise<void> {
    await Promise.all(this.ctx.getWebSockets().map((socket) => this.authorizeSocket(socket)));
    await this.scheduleMachineCheck();
  }

  private async scheduleMachineCheck(): Promise<void> {
    let next = Infinity;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(socket);
      if (socket.readyState === 1 && attachment?.role === 'machine') {
        next = Math.min(next, attachment.authorizedUntil ?? Date.now());
      }
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
  }

  private async authorizeSocket(socket: WebSocket, force = false): Promise<boolean> {
    if (socket.readyState !== 1) return false;
    const attachment = this.socketAttachment(socket);
    if (attachment?.role === 'client') return true;
    if (!attachment?.machineGrant || attachment.machineGrant.grant.machineId !== attachment.id) {
      this.rejectMachineSocket(socket, attachment);
      return false;
    }
    const checking = this.machineChecks.get(socket);
    if (checking) return checking;
    if (!force && (attachment.authorizedUntil ?? 0) > Date.now()) return true;
    const check = (async () => {
      const authorizedUntil = machineAuthorizationDeadline(attachment.machineGrant!);
      const rejected = await currentMachineAuthority(this.env, attachment.machineGrant!, 'space.control');
      if (rejected || authorizedUntil <= Date.now() || socket.readyState !== 1) {
        this.rejectMachineSocket(socket, attachment);
        return false;
      }
      socket.serializeAttachment({ ...attachment, authorizedUntil });
      return true;
    })();
    this.machineChecks.set(socket, check);
    try {
      return await check;
    } finally {
      this.machineChecks.delete(socket);
    }
  }

  private rejectMachineSocket(socket: WebSocket, attachment: RelaySocketAttachment | null): void {
    if (attachment?.role === 'machine') {
      this.failMachineTunnels(attachment.id, new Error('Machine authorization expired or was revoked'));
    }
    socket.close(1008, 'Machine authorization expired or was revoked');
  }

  private socketAttachment(socket: WebSocket): RelaySocketAttachment | null {
    const raw = socket.deserializeAttachment() as RelaySocketAttachment | null;
    const parsed = socketAttachmentSchema.safeParse(raw);
    if (!parsed.success) return null;
    const grant = signedCredentialAuthorityGrantSchema.safeParse(raw?.machineGrant);
    return {
      ...parsed.data,
      ...(grant.success ? { machineGrant: grant.data } : {}),
      ...(typeof raw?.authorizedUntil === 'number' ? { authorizedUntil: raw.authorizedUntil } : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return Response.json(
        { status: 'ok', protocolVersion: RELAY_PROTOCOL_VERSION },
        { headers: { 'cache-control': 'no-store', [WORKER_VERSION_HEADER]: WORKER_VERSION } },
      );
    }

    const artifact = ARTIFACT_PATH.exec(url.pathname);
    const tunnel = tunnelTarget(url);
    if (tunnel && request.method === 'OPTIONS') {
      const origin = request.headers.get('origin');
      const allowedOrigin = `https://${env.RELAY_NAME}.gitspace.sh`;
      if (origin !== allowedOrigin) return jsonError(403, 'ORIGIN_REJECTED', 'Tunnel origin is not allowed');
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': allowedOrigin,
          'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, x-gitspace-device, x-gitspace-user',
          'access-control-max-age': '86400',
          vary: 'origin',
        },
      });
    }

    let authorization: Response | { nonce: string; timestamp: number; target: string };
    if (tunnel) {
      authorization = { nonce: crypto.randomUUID(), timestamp: Date.now(), target: `${url.pathname}${url.search}` };
    } else if (url.pathname === '/ws') {
      const role = url.searchParams.get('role');
      const id = url.searchParams.get('id');
      authorization = role === 'machine'
        ? await authorizedMachineRequest(request, env, id)
        : authorizedRootRequest(request, env);
    } else if (artifact) {
      authorization = await authorizedMachineRequest(request, env, null);
    } else {
      return jsonError(404, 'NOT_FOUND', 'Relay route not found');
    }
    if (authorization instanceof Response) return authorization;

    const stub = env.RELAY.getByName(env.RELAY_NAME);
    if (artifact) {
      if (!await stub.consumeAuthorization(authorization.nonce, authorization.timestamp)) {
        return jsonError(401, 'AUTH_REPLAY', 'Relay authorization was already used or is invalid');
      }
      return handleArtifactRequest(request, env, artifact[1]!);
    }

    const headers = new Headers(request.headers);
    if (url.pathname === '/ws') {
      const parsed = socketAttachmentSchema.safeParse({ role: url.searchParams.get('role'), id: url.searchParams.get('id') });
      if (!parsed.success) return jsonError(400, 'INVALID_ENDPOINT', 'Invalid relay role or endpoint id');
      headers.set(INTERNAL_ROLE, parsed.data.role);
      headers.set(INTERNAL_ENDPOINT_ID, parsed.data.id);
    } else if (tunnel) {
      headers.set(INTERNAL_TUNNEL_MACHINE, tunnel.machineId);
      headers.set(INTERNAL_TUNNEL_PATH, tunnel.path);
      headers.set(INTERNAL_SIGNED_TARGET, request.headers.get(INTERNAL_SIGNED_TARGET) ?? `${url.pathname}${url.search}`);
    }

    return stub.fetch(relayRequest(request, authorization, headers));
  },
} satisfies ExportedHandler<Env>;
