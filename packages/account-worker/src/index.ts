import { activeAccount } from './account-access.js';
import type { AccountAuthorization } from './account-state.js';
import { machineProtocolInputSchema } from '@gitspace/protocol/deployment';
import { DurableObject } from 'cloudflare:workers';
import {
  RELAY_HEARTBEAT_LEASE_MS,
  RELAY_HEARTBEAT_MODE,
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
  verifyManagedDeviceGrant,
  type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol/credential-vault';
import { WORKER_VERSION_HEADER } from '@gitspace/protocol/deployment';
import application, { CredentialVaultDO, REQUEST_MAX_BYTES } from './application.js';
import { forwardTunnelRequest, relayRequest, tunnelTarget, verifiedTunnelBody, TUNNEL_MAX_BODY_BYTES, TunnelBodyProofSchema, INTERNAL_TUNNEL_BODY_PROOF, INTERNAL_NONCE, INTERNAL_TIMESTAMP, INTERNAL_TUNNEL_MACHINE, INTERNAL_TUNNEL_PATH, INTERNAL_SIGNED_TARGET, INTERNAL_SERVICE_SESSION } from './relay-request.js';
import { handleMcpRequest } from './mcp-server.js';
import { z } from 'zod';
import { rpcBodySha256 } from '@gitspace/protocol/device-grant';
import { fetchInternalService, isHostedServiceHostname } from './service-access.js';
import { ServiceSessions, ServiceSessionSchema, type ServiceSession, serviceCookie, safeServiceReturn, SERVICE_COOKIE, SERVICE_STATE_COOKIE } from './service-sessions.js';
import { AccountBrowserRelay, browserRelayArchive } from './browser-relay.js';
import { RuntimeProjectBrowserPreferencesSchema, type RuntimeProjectBrowserPreferences, type RuntimeAccountBrowserAuthorization, type RuntimeBrowserTrust } from '@gitspace/protocol-runtime';
export * from './application.js';

declare const GITSPACE_WORKER_SHA: string | undefined;
const WORKER_VERSION = typeof GITSPACE_WORKER_SHA === 'string' ? GITSPACE_WORKER_SHA : 'channel';

const INTERNAL_ROLE = 'x-gitspace-role';
const INTERNAL_ENDPOINT_ID = 'x-gitspace-endpoint-id';
const MACHINE_GRANT_HEADER = 'x-gitspace-machine-grant';
const INTERNAL_HEADERS: Record<string, true> = {
  [INTERNAL_NONCE]: true,
  [INTERNAL_TIMESTAMP]: true,
  [INTERNAL_ROLE]: true,
  [INTERNAL_ENDPOINT_ID]: true,
  [INTERNAL_TUNNEL_MACHINE]: true,
  [INTERNAL_TUNNEL_PATH]: true,
  [INTERNAL_SIGNED_TARGET]: true,
  [INTERNAL_SERVICE_SESSION]: true,
  [INTERNAL_TUNNEL_BODY_PROOF]: true,
};
const ARTIFACT_PATH = /^\/artifacts\/([a-f0-9]{64})$/u;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MACHINE_LEASE_MS = 30_000;
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
  socket: WebSocket;
  serviceSocket?: WebSocket;
  session?: ServiceSession;
  method: string;
  origin: string | null;
  resolve: (response: Response) => void;
  responseStarted: boolean;
  dispatched: boolean;
  cleanup: () => void;
  uploadReader?: ReadableStreamDefaultReader<Uint8Array>;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  timeout: number | NodeJS.Timeout;
}

interface RelaySocketAttachment extends SocketAttachment {
  machineGrant?: SignedCredentialAuthorityGrant;
  authorizedUntil?: number;
  heartbeatExpiresAt?: number;
  accountAuthorization?: Extract<AccountAuthorization, { status: 'active' }>;
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
    // A self-signed (managed device) grant is never sufficient on its own: the vault below decides.
    if (!(verifyCredentialAuthorityGrant(grant, credentialProtocolBase64.decode(env.AUTH_PUBLIC_KEY)) ?? verifyManagedDeviceGrant(grant))) {
      return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine issuer proof is invalid or expired');
    }
    if (grant.grant.userId !== env.ACCOUNT_ID) return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine grant belongs to another tenant');
    const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(env.ACCOUNT_ID);
    const result = await vault.authorizeRelayGrant(grant, capability);
    if (result.status === 'ok') {
      return null;
    }
    return jsonError(401, 'MACHINE_GRANT_REJECTED', result.error.message);
  } catch (error) {
    // Current authority is required; never fall back to the offline signature.
    console.error(JSON.stringify({
      event: 'machine_authority_unavailable', machineId: grant.grant.machineId, capability,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    }));
  }
  return jsonError(503, 'MACHINE_AUTHORITY_UNAVAILABLE', 'Machine authority could not be verified');
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Which check made the relay close a machine socket. */
type MachineSocketCloseDetail =
  | { check: 'replaced' | 'heartbeat-expired' | 'grant-missing' | 'grant-machine-mismatch' | 'socket-closed' }
  | { check: 'authority-rejected'; status: number; code: string | null; message: string | null }
  | { check: 'authorization-expired'; authorizedUntil: number };

/** Reads the `jsonError` body `currentMachineAuthority` produced; it carries no grant material. */
async function authorityRejection(response: Response): Promise<MachineSocketCloseDetail> {
  const body: unknown = await response.json().catch(() => null);
  const error = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' ? body.error : null;
  return {
    check: 'authority-rejected',
    status: response.status,
    code: error && 'code' in error && typeof error.code === 'string' ? error.code : null,
    message: error && 'message' in error && typeof error.message === 'string' ? error.message : null,
  };
}

function isoTime(ms: number | undefined): string | null {
  return ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function filteredHeaders(headers: Headers, requestDirection: boolean): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS[lower] || lower.startsWith('cf-') || INTERNAL_HEADERS[lower]) continue;
    if (requestDirection && (lower === 'host' || lower === MACHINE_GRANT_HEADER || (lower === 'authorization' && /^GitSpace\s/iu.test(value)))) continue;
    result.push([name, value]);
  }
  return result;
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
  // Root-signed (paired) or self-signed (managed) claim; vault authority is checked
  // below or, for machine sockets, inside the relay before the socket is accepted.
  const grant = verifyCredentialAuthorityGrant(signedGrant, credentialProtocolBase64.decode(env.AUTH_PUBLIC_KEY)) ?? verifyManagedDeviceGrant(signedGrant);
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
  private readonly serviceSessions = new ServiceSessions(this.ctx.storage, this.env.ACCOUNT_ID, deviceId => this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).serviceDeviceAuthority(deviceId));
  private readonly browserRelay = new AccountBrowserRelay(this.ctx, this.env);
  async serviceApprove(input: { hostname: string; deviceId: string; state: string; returnTo: string }) {
    const ticket = await this.serviceSessions.approve(input);
    await this.scheduleMachineCheck();
    return ticket;
  }
  async serviceRedeem(ticket: string, hostname: string, state: string | null) {
    const session = await this.serviceSessions.redeem(ticket, hostname, state);
    await this.scheduleMachineCheck();
    return session;
  }
  serviceValidate(token: string | null, hostname: string) { return this.serviceSessions.validate(token, hostname); }
  async serviceRevokeDevice(deviceId: string) {
    const sessions = await this.serviceSessions.revokeDevice(deviceId);
    await this.closeServiceSessions(sessions);
    await this.scheduleMachineCheck();
    return sessions;
  }
  async serviceLogout(token: string | null, hostname: string) {
    const sessionId = await this.serviceSessions.logout(token, hostname);
    if (sessionId) await this.closeServiceSessions([sessionId]);
    await this.scheduleMachineCheck();
    return sessionId !== null;
  }
  private async closeServiceSessions(sessionIds: readonly string[]) {
    if (!sessionIds.length) return;
    const revoked = new Set(sessionIds);
    for (const [requestId, pending] of this.pendingTunnels) {
      if (pending.session && revoked.has(pending.session.sessionId)) {
        pending.serviceSocket?.close(1008, 'Service authorization expired');
        await this.failTunnel(requestId, new Error('Service authorization expired'), 401, 'SERVICE_SESSION_EXPIRED');
      }
    }
  }
  private async serviceTunnelAuthorized(requestId: string, pending: PendingTunnel): Promise<boolean> {
    if (!pending.session) return true;
    const session = await this.serviceSessions.validate(pending.session.sessionId, pending.session.hostname).catch(() => null);
    if (session && session.deviceId === pending.session.deviceId) return true;
    pending.serviceSocket?.close(1008, 'Service authorization expired');
    await this.failTunnel(requestId, new Error('Service authorization expired'), 401, 'SERVICE_SESSION_EXPIRED');
    return false;
  }
  browserRelayFetch(request: Request) { return this.browserRelay.fetch(request); }
  browserRelayPair(trust: RuntimeBrowserTrust, endpoint: string) { return this.browserRelay.pair(trust, endpoint); }
  browserRelayStatus() { return this.browserRelay.status(); }
  browserRelayPlacement(projectId: string, pairingId?: string) { return this.browserRelay.placement(projectId, pairingId); }
  browserRelayProjectSettings(projectId: string) { return this.browserRelay.projectSettings(projectId); }
  browserRelaySetProjectSettings(projectId: string, expectedRevision: number, preferences: RuntimeProjectBrowserPreferences) { return this.browserRelay.setProjectSettings(projectId, expectedRevision, preferences); }
  browserRelayUnpair(pairingId: string) { return this.browserRelay.unpair(pairingId); }
  browserRelayConfirm(pairingId: string, fingerprint: string) { return this.browserRelay.confirm(pairingId, fingerprint); }
  browserRelayExecute(authorization: RuntimeAccountBrowserAuthorization) { return this.browserRelay.execute(authorization); }

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
    if (attachment.role === 'machine' && attachment.heartbeatExpiresAt !== undefined) {
      socket.serializeAttachment({ ...this.socketAttachment(socket), heartbeatExpiresAt: Date.now() + RELAY_HEARTBEAT_LEASE_MS });
    }

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
    if (!pending || pending.socket !== socket) return;

    try {
      switch (message.type) {
        case 'tunnel.websocket.open': {
          if (pending.responseStarted) throw new Error('Duplicate service WebSocket');
          if (!await this.serviceTunnelAuthorized(message.requestId, pending)) return;
          const pair = new WebSocketPair();
          const [client, server] = Object.values(pair);
          server.accept();
          pending.serviceSocket = server;
          pending.responseStarted = true;
          clearTimeout(pending.timeout);
          server.addEventListener('message', event => {
            this.ctx.waitUntil((async () => {
              if (!await this.serviceTunnelAuthorized(message.requestId, pending)) return;
              if (!await this.authorizeSocket(socket, true)) return server.close(1008, 'Machine authorization expired');
              socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.data', requestId: message.requestId, binary: typeof event.data !== 'string', data: typeof event.data === 'string' ? event.data : encodeTunnelChunk(new Uint8Array(event.data)) } satisfies TunnelRequestMessage));
            })().catch(() => server.close(1008, 'Service authorization unavailable')));
          });
          server.addEventListener('close', () => {
            if (socket.readyState === 1) socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.close', requestId: message.requestId, code: 1000, reason: '' } satisfies TunnelRequestMessage));
            void this.finishTunnel(message.requestId);
          });
          pending.resolve(new Response(null, { status: 101, webSocket: client }));
          return;
        }
        case 'tunnel.websocket.data':
          if (!await this.serviceTunnelAuthorized(message.requestId, pending)) return;
          pending.serviceSocket?.send(message.binary ? decodeTunnelChunk(message.data) : message.data);
          return;
        case 'tunnel.websocket.close':
          pending.serviceSocket?.close(1000, message.reason);
          await this.finishTunnel(message.requestId);
          return;
        case 'tunnel.response.start': {
          if (pending.responseStarted) throw new Error('Duplicate tunnel response headers');
          const hasBody = pending.method !== 'HEAD' && ![204, 205, 304].includes(message.status);
          const stream = hasBody ? new TransformStream<Uint8Array, Uint8Array>() : null;
          if (stream) {
            const writer = stream.writable.getWriter();
            pending.writer = writer;
            void writer.closed.catch((error) => this.failTunnel(message.requestId, error instanceof Error ? error : new Error(String(error))));
          }
          const headers = new Headers(filteredHeaders(new Headers(message.headers), false));
          const response = this.tunnelCors(new Response(stream?.readable ?? null, { status: message.status, headers }), pending.origin);
          pending.responseStarted = true;
          pending.resolve(response);
          this.refreshTunnelTimeout(message.requestId, pending);
          return;
        }
        case 'tunnel.response.chunk':
          if (!pending.responseStarted) throw new Error('Tunnel body arrived before response headers');
          if (pending.writer) await pending.writer.write(decodeTunnelChunk(message.data));
          this.refreshTunnelTimeout(message.requestId, pending);
          return;
        case 'tunnel.response.end':
          if (!pending.responseStarted) throw new Error('Tunnel ended before response headers');
          if (pending.writer) await pending.writer.close();
          this.finishTunnel(message.requestId);
          return;
        case 'tunnel.response.error':
          this.failTunnel(message.requestId, new Error(message.message));
          return;
      }
    } catch (error) {
      this.failTunnel(message.requestId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.failSocketTunnels(socket, new Error(`Machine disconnected (${code}: ${reason || 'no reason'})`));
    // Transport-only codes such as 1006 cannot be sent in a close frame.
    socket.close();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.failSocketTunnels(socket, new Error('Machine socket failed'));
    socket.close(1011, 'Machine socket failed');
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
      const version = new URL(request.url).searchParams.get('machineProtocol');
      await this.env.TENANT_RELEASES.getByName(this.env.ACCOUNT_ID).machineProtocol(machineGrant.grant.machineId, machineProtocolInputSchema.parse({ version: version === null ? null : Number(version), platform: new URL(request.url).searchParams.get('machinePlatform') }));
    }

    const tag = endpointTag(parsed.data);
    if (parsed.data.role === 'machine') {
      for (const existing of this.ctx.getWebSockets(tag)) {
        this.logMachineSocketClose(existing, 1000, { check: 'replaced' });
        this.failSocketTunnels(existing, new Error('Machine connection was replaced'));
        existing.close(1000, 'Replaced by a newer machine connection');
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: RelaySocketAttachment = {
      ...parsed.data,
      ...(machineGrant ? { machineGrant, authorizedUntil } : {}),
      ...(machineGrant && new URL(request.url).searchParams.get('heartbeat') === RELAY_HEARTBEAT_MODE
        ? { heartbeatExpiresAt: Date.now() + RELAY_HEARTBEAT_LEASE_MS }
        : {}),
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [tag]);
    if (machineGrant) await this.scheduleMachineCheck();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async openTunnel(request: Request): Promise<Response> {
    const machineId = request.headers.get(INTERNAL_TUNNEL_MACHINE);
    const path = request.headers.get(INTERNAL_TUNNEL_PATH);
    const origin = request.headers.get('origin');
    if (!machineId || !path) return this.tunnelCors(jsonError(400, 'INVALID_TUNNEL', 'Tunnel target is missing'), origin);
    let bodyProof: z.infer<typeof TunnelBodyProofSchema> | undefined;
    const rawProof = request.headers.get(INTERNAL_TUNNEL_BODY_PROOF);
    if (rawProof !== null) {
      try { bodyProof = TunnelBodyProofSchema.parse(JSON.parse(rawProof)); }
      catch { return jsonError(400, 'INVALID_TUNNEL', 'Tunnel body proof is invalid'); }
    }
    let session: ServiceSession | undefined;
    const rawSession = request.headers.get(INTERNAL_SERVICE_SESSION);
    if (rawSession !== null) {
      let raw: unknown;
      try { raw = JSON.parse(rawSession); } catch { return jsonError(401, 'SERVICE_SESSION_REJECTED', 'Invalid service session'); }
      const parsed = ServiceSessionSchema.safeParse(raw);
      if (!parsed.success) return jsonError(401, 'SERVICE_SESSION_REJECTED', 'Invalid service session');
      const current = await this.serviceSessions.validate(parsed.data.sessionId, parsed.data.hostname);
      if (!current || current.deviceId !== parsed.data.deviceId || current.hostname !== request.headers.get('x-forwarded-host')) return jsonError(401, 'SERVICE_SESSION_REJECTED', 'Service session expired');
      session = current;
    }
    let machine: WebSocket | undefined;
    for (const socket of this.ctx.getWebSockets(`endpoint:machine:${machineId}`)) {
      if (await this.authorizeSocket(socket, true)) {
        machine = socket;
        break;
      }
    }
    if (!machine) return this.tunnelCors(jsonError(503, 'MACHINE_OFFLINE', `Machine ${machineId} is offline. Check the machine host connection.`), origin);
    if (request.signal.aborted) return this.tunnelCors(jsonError(499, 'TUNNEL_CANCELLED', 'Tunnel request was cancelled before dispatch'), origin);

    const requestId = crypto.randomUUID();
    const { promise: responsePromise, resolve } = Promise.withResolvers<Response>();
    const abort = () => this.failTunnel(requestId, new Error('Tunnel request was cancelled'), 499, 'TUNNEL_CANCELLED');
    const pending: PendingTunnel = {
      socket: machine,
      session,
      method: request.method,
      origin,
      resolve,
      responseStarted: false,
      dispatched: false,
      cleanup: () => request.signal.removeEventListener('abort', abort),
      timeout: setTimeout(
        () => this.failTunnel(requestId, new Error('Timed out waiting for machine response headers'), 504, 'TUNNEL_TIMEOUT'),
        Number(this.env.TUNNEL_HEADER_TIMEOUT_MS),
      ),
    };
    this.pendingTunnels.set(requestId, pending);
    request.signal.addEventListener('abort', abort, { once: true });

    try {
      const tunnelHeaders = new Headers(filteredHeaders(request.headers, true));
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') tunnelHeaders.set('upgrade', 'websocket');
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
      // One request belongs to one socket. A replacement never receives a replay.
      pending.dispatched = true;
      machine.send(JSON.stringify(start));
      void this.sendRequestBody(requestId, pending, request.body && bodyProof ? verifiedTunnelBody(request.body, bodyProof) : request.body).catch((error) => {
        this.failTunnel(requestId, error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      this.failTunnel(requestId, error instanceof Error ? error : new Error(String(error)));
    }
    return responsePromise;
  }

  private async sendRequestBody(requestId: string, pending: PendingTunnel, body: ReadableStream<Uint8Array> | null): Promise<void> {
    const send = async (message: TunnelRequestMessage) => {
      if (!await this.authorizeSocket(pending.socket)) throw new Error('Machine connection is unavailable');
      if (this.pendingTunnels.get(requestId) !== pending) throw new Error('Tunnel request is no longer active');
      pending.socket.send(JSON.stringify(message));
    };
    if (body) {
      const reader = body.getReader();
      pending.uploadReader = reader;
      try {
        while (this.pendingTunnels.get(requestId) === pending) {
          const result = await reader.read();
          if (result.done) break;
          for (let offset = 0; offset < result.value.byteLength; offset += TUNNEL_CHUNK_BYTES) {
            await send({
              version: RELAY_PROTOCOL_VERSION,
              type: 'tunnel.request.chunk',
              requestId,
              data: encodeTunnelChunk(result.value.subarray(offset, offset + TUNNEL_CHUNK_BYTES)),
            });
          }
        }
      } finally {
        delete pending.uploadReader;
        reader.releaseLock();
      }
    }
    await send({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.end', requestId });
  }

  private refreshTunnelTimeout(requestId: string, pending: PendingTunnel): void {
    if (this.pendingTunnels.get(requestId) !== pending) return;
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(
      () => this.failTunnel(requestId, new Error('Machine response stalled'), 504, 'TUNNEL_TIMEOUT'),
      Number(this.env.TUNNEL_IDLE_TIMEOUT_MS),
    );
  }

  private async finishTunnel(requestId: string): Promise<void> {
    const pending = this.pendingTunnels.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTunnels.delete(requestId);
    pending.cleanup();
    if (pending.uploadReader) await pending.uploadReader.cancel().catch(() => {});
  }

  private async failTunnel(requestId: string, error: Error, status = 502, code = 'TUNNEL_TRANSPORT_FAILED'): Promise<void> {
    const pending = this.pendingTunnels.get(requestId);
    if (!pending) return;
    await this.finishTunnel(requestId);
    if (pending.dispatched && pending.socket.readyState === 1 && this.socketAttachment(pending.socket)?.heartbeatExpiresAt !== undefined) {
      try {
        pending.socket.send(JSON.stringify({
          version: RELAY_PROTOCOL_VERSION,
          type: 'tunnel.request.cancel',
          requestId,
        } satisfies TunnelRequestMessage));
      } catch {
        // The failed request is already detached; cancellation cannot roll back remote mutations.
      }
    }
    if (pending.writer) void pending.writer.abort(error).catch(() => {});
    pending.serviceSocket?.close(1011, 'Service tunnel disconnected');
    if (!pending.responseStarted) {
      const message = pending.dispatched
        ? `${error.message}. The remote outcome may be unknown; refresh workspace state before retrying.`
        : error.message;
      pending.resolve(this.tunnelCors(jsonError(status, code, message), pending.origin));
    }
  }

  private failSocketTunnels(socket: WebSocket, error: Error): void {
    for (const [requestId, pending] of this.pendingTunnels) {
      if (pending.socket === socket) this.failTunnel(requestId, error);
    }
  }

  private tunnelCors(response: Response, origin: string | null): Response {
    const allowedOrigin = `https://${this.env.RELAY_NAME}.gitspace.sh`;
    if (origin === allowedOrigin) {
      response.headers.set('access-control-allow-origin', allowedOrigin);
      response.headers.append('vary', 'origin');
    }
    return response;
  }

  async alarm(): Promise<void> {
    await Promise.all(this.ctx.getWebSockets().map((socket) => this.authorizeSocket(socket)));
    await this.closeServiceSessions(await this.serviceSessions.sweep());
    for (const [requestId, pending] of this.pendingTunnels) if (pending.session) await this.serviceTunnelAuthorized(requestId, pending);
    await this.scheduleMachineCheck();
  }

  private async scheduleMachineCheck(): Promise<void> {
    let next = await this.serviceSessions.nextExpiry() ?? Infinity;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(socket);
      if (socket.readyState === 1 && attachment?.role === 'machine') {
        next = Math.min(next, attachment.authorizedUntil ?? Date.now());
        next = Math.min(next, attachment.heartbeatExpiresAt ?? Infinity);
      }
    }
    if (Number.isFinite(next)) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current <= Date.now() || current > next) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
      }
    }
  }

  private async authorizeSocket(socket: WebSocket, force = false): Promise<boolean> {
    if (socket.readyState !== 1) return false;
    const attachment = this.socketAttachment(socket);
    if (attachment?.role === 'client') return true;
    if (attachment?.heartbeatExpiresAt !== undefined && attachment.heartbeatExpiresAt <= Date.now()) {
      this.logMachineSocketClose(socket, 1011, { check: 'heartbeat-expired' });
      this.failSocketTunnels(socket, new Error('Machine relay heartbeat expired; the host is reconnecting'));
      socket.close(1011, 'Machine relay heartbeat expired');
      return false;
    }
    if (!attachment?.machineGrant || attachment.machineGrant.grant.machineId !== attachment.id) {
      this.rejectMachineSocket(socket, { check: attachment?.machineGrant ? 'grant-machine-mismatch' : 'grant-missing' });
      return false;
    }
    const now = Date.now();
    const accountAuthorization = attachment.accountAuthorization;
    const accountFresh = accountAuthorization !== undefined && accountAuthorization.checkedAt <= now
      && now < accountAuthorization.refreshAt && now < accountAuthorization.expiresAt;
    const checking = this.machineChecks.get(socket);
    if (checking) return checking;
    if (!force && accountFresh && (attachment.authorizedUntil ?? 0) > now) return true;
    const check = (async () => {
      let accountLease = accountAuthorization;
      if (!accountFresh) {
        const account = await activeAccount(this.env, this.env.ACCOUNT_ID);
        if (account.status === 'error') {
          this.rejectMachineSocket(socket, { check: 'authority-rejected', status: account.error.code === 'ACCOUNT_AUTHORITY_UNAVAILABLE' ? 503 : 403, code: account.error.code, message: account.error.message });
          return false;
        }
        accountLease = account.value.authorization;
      }
      let authorizedUntil = attachment.authorizedUntil ?? 0;
      if (force || authorizedUntil <= Date.now()) {
        authorizedUntil = machineAuthorizationDeadline(attachment.machineGrant!);
        const rejected = await currentMachineAuthority(this.env, attachment.machineGrant!, 'space.control');
        const rejection = rejected ? await authorityRejection(rejected) : null;
        if (rejection || authorizedUntil <= Date.now() || socket.readyState !== 1) {
          this.rejectMachineSocket(socket, rejection
            ?? (authorizedUntil <= Date.now() ? { check: 'authorization-expired', authorizedUntil } : { check: 'socket-closed' }));
          return false;
        }
      }
      if (!accountLease || Date.now() < accountLease.checkedAt || Date.now() >= accountLease.expiresAt || socket.readyState !== 1) {
        this.rejectMachineSocket(socket, { check: 'authorization-expired', authorizedUntil: accountLease?.expiresAt ?? 0 });
        return false;
      }
      socket.serializeAttachment({ ...this.socketAttachment(socket), authorizedUntil, accountAuthorization: accountLease });
      return true;
    })();
    this.machineChecks.set(socket, check);
    try {
      return await check;
    } finally {
      this.machineChecks.delete(socket);
    }
  }

  private rejectMachineSocket(socket: WebSocket, detail: MachineSocketCloseDetail): void {
    this.logMachineSocketClose(socket, 1008, detail);
    this.failSocketTunnels(socket, new Error('Machine authorization expired or was revoked'));
    socket.close(1008, 'Machine authorization expired or was revoked');
  }

  /** One line per relay-initiated machine close; grants and keys are never logged, only their deadlines. */
  private logMachineSocketClose(socket: WebSocket, closeCode: number, detail: MachineSocketCloseDetail): void {
    const attachment = this.socketAttachment(socket);
    const grant = attachment?.machineGrant;
    let issuerExpiresAt = Infinity;
    for (const issuer of grant?.issuerChain ?? []) issuerExpiresAt = Math.min(issuerExpiresAt, deviceGrantExpiresAt(issuer) ?? Infinity);
    let inFlightTunnels = 0;
    for (const pending of this.pendingTunnels.values()) if (pending.socket === socket) inFlightTunnels++;
    console.warn(JSON.stringify({
      event: 'relay_machine_socket_closed', at: new Date().toISOString(), machineId: attachment?.id ?? null, closeCode,
      ...detail,
      ...('authorizedUntil' in detail ? { authorizedUntil: isoTime(detail.authorizedUntil) } : {}),
      grantGeneration: grant?.grant.generation ?? null,
      grantExpiresAt: isoTime(grant?.grant.expiresAt), issuerExpiresAt: isoTime(issuerExpiresAt),
      leaseUntil: isoTime(attachment?.authorizedUntil), heartbeatExpiresAt: isoTime(attachment?.heartbeatExpiresAt),
      inFlightTunnels,
    }));
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
      ...(typeof raw?.heartbeatExpiresAt === 'number' ? { heartbeatExpiresAt: raw.heartbeatExpiresAt } : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcpRequest(request, env, (signed) => application.fetch(signed, env));
    if (url.pathname === '/v1/accounts/bootstrap' || url.pathname === '/v1/accounts/recover') {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'cache-control': 'private, no-store' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const response = await application.fetch(request, env);
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }
    if (url.pathname.startsWith('/__platform/objects/')) {
      if (request.headers.get('authorization') !== `Bearer ${env.PLATFORM_TOKEN}`) return jsonError(401, 'PROVIDER_UNAUTHORIZED', 'Provider object authorization is required');
      if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError(405, 'METHOD_NOT_ALLOWED', 'Provider object access is read-only');
      const key = decodeURIComponent(url.pathname.slice('/__platform/objects/'.length));
      const object = request.method === 'HEAD' ? await env.DATA.head(key) : await env.DATA.get(key);
      if (!object) return jsonError(404, 'OBJECT_NOT_FOUND', 'Tenant object is unavailable');
      return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(object.size), etag: object.httpEtag } });
    }
    if (isHostedServiceHostname(env, url.hostname)) {
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (unsafe) {
        const origin = request.headers.get('origin');
        if (origin !== null ? origin !== url.origin : request.headers.get('sec-fetch-site') !== 'same-origin') {
          return jsonError(403, 'SERVICE_ORIGIN_REJECTED', 'This service requires its exact origin');
        }
      }
      const relay = env.RELAY.getByName(env.RELAY_NAME);
      if (url.pathname === '/__gitspace/logout') {
        if (request.method !== 'POST') return jsonError(405, 'METHOD_NOT_ALLOWED', 'Service logout requires POST');
        await relay.serviceLogout(serviceCookie(request, SERVICE_COOKIE), url.hostname);
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'set-cookie': `${SERVICE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` } });
      }
      if (url.pathname === '/__gitspace/auth') {
        const redeemed = await relay.serviceRedeem(url.searchParams.get('ticket') ?? '', url.hostname, serviceCookie(request, SERVICE_STATE_COOKIE));
        if (!redeemed) return jsonError(401, 'SERVICE_TICKET_REJECTED', 'Service login expired or was already used');
        const headers = new Headers({ location: redeemed.returnTo, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        headers.append('set-cookie', `${SERVICE_COOKIE}=${redeemed.token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`);
        headers.append('set-cookie', `${SERVICE_STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
        return new Response(null, { status: 303, headers });
      }
      const session = await relay.serviceValidate(serviceCookie(request, SERVICE_COOKIE), url.hostname);
      if (session) return fetchInternalService(env, { kind: 'device', accountId: env.ACCOUNT_ID, deviceId: session.deviceId }, request, session);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return jsonError(401, 'SERVICE_LOGIN_REQUIRED', 'Open this service in the browser to approve access');
      const state = crypto.randomUUID();
      const approval = new URL('/service-access', env.ACCOUNT_URL);
      approval.searchParams.set('hostname', url.hostname);
      approval.searchParams.set('state', state);
      approval.searchParams.set('returnTo', safeServiceReturn(`${url.pathname}${url.search}`) ? `${url.pathname}${url.search}` : '/');
      return new Response(null, { status: 303, headers: { location: approval.href, 'cache-control': 'no-store', 'set-cookie': `${SERVICE_STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300` } });
    }
    if (url.pathname === '/api/browser-relay/extension') return env.RELAY.getByName(env.RELAY_NAME).browserRelayFetch(request);
    if (url.pathname === '/api/services/approve' || /^\/api\/browser-relay\/(pair|status|unpair|confirm|project-status|project-update|extension\.zip)$/u.test(url.pathname)) {
      if (request.method !== 'POST' || request.headers.get('origin') !== new URL(env.ACCOUNT_URL).origin) return jsonError(403, 'ORIGIN_REJECTED', 'Account origin required');
      const declared = request.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) return jsonError(400, 'REQUEST_LENGTH_INVALID', 'Invalid request content length');
      if (declared !== null && Number(declared) > REQUEST_MAX_BYTES) return jsonError(413, 'REQUEST_TOO_LARGE', 'Account request exceeds size limit');
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > REQUEST_MAX_BYTES) return jsonError(413, 'REQUEST_TOO_LARGE', 'Account request exceeds size limit');
      const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
      const mutatesPairing = /^\/api\/browser-relay\/(pair|unpair|confirm|project-update)$/u.test(url.pathname);
      const requiresWrite = mutatesPairing || url.pathname === '/api/services/approve';
      const auth = await vault.authorizeBrowserRequest({ header: request.headers.get('x-gitspace-device'), target: `${url.pathname}${url.search}`, body, capabilities: [requiresWrite ? 'rpc.write' : 'rpc.read'] });
      if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === 'RPC_FORBIDDEN' ? 403 : 401 });
      if (mutatesPairing) {
        const device = await vault.currentDeviceGrant(auth.value.deviceId);
        if (!device || device.kind !== 'browser' || device.scope.kind !== 'user' || !device.capabilities.includes('rpc.write')) return jsonError(403, 'RPC_FORBIDDEN', 'Pairing requires an account-scoped browser with write access');
      }
      const relay = env.RELAY.getByName(env.RELAY_NAME);
      if (url.pathname.endsWith('/extension.zip')) return new Response(Uint8Array.from(browserRelayArchive(env.ACCOUNT_URL)), { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename=\"gitspace-browser-relay.zip\"', 'cache-control': 'no-store' } });
      if (url.pathname === '/api/services/approve') {
        const parsed = z.object({ hostname: z.string(), state: z.string().uuid(), returnTo: z.string() }).safeParse(JSON.parse(new TextDecoder().decode(body)));
        if (!parsed.success || !isHostedServiceHostname(env, parsed.data.hostname) || !safeServiceReturn(parsed.data.returnTo)) return jsonError(400, 'SERVICE_APPROVAL_INVALID', 'Invalid service approval');
        const route = await env.HOSTED_ROUTES.getByName(parsed.data.hostname).get();
        if (!route || route.tenant !== env.ACCOUNT_ID) return jsonError(404, 'SERVICE_ROUTE_NOT_FOUND', 'Service unavailable');
        const ticket = await relay.serviceApprove({ ...parsed.data, deviceId: auth.value.deviceId });
        return Response.json({ status: 'ok', value: { callback: `https://${parsed.data.hostname}/__gitspace/auth?ticket=${encodeURIComponent(ticket)}` } });
      }
      if (url.pathname.endsWith('/pair')) return Response.json({ status: 'ok', value: await relay.browserRelayPair(await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust(), new URL('/api/browser-relay/extension', env.ACCOUNT_URL).href.replace(/^http/u, 'ws')) });
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'ok', value: await relay.browserRelayStatus() });
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(body)); } catch { return jsonError(400, 'PAIRING_REQUEST_INVALID', 'Invalid browser pairing request'); }
      if (url.pathname.endsWith('/project-status') || url.pathname.endsWith('/project-update')) {
        const project = z.object({ projectId: z.string().min(1).max(256) }).safeParse(raw);
        if (!project.success) return jsonError(400, 'PROJECT_BROWSER_REQUEST_INVALID', 'Project identity is required');
        if (url.pathname.endsWith('/project-status')) return Response.json({ status: 'ok', value: await relay.browserRelayProjectSettings(project.data.projectId) });
        const update = z.object({ expectedRevision: z.number().int().nonnegative(), preferences: RuntimeProjectBrowserPreferencesSchema }).safeParse(raw);
        if (!update.success) return jsonError(400, 'PROJECT_BROWSER_REQUEST_INVALID', 'Invalid project Chrome preferences');
        try {
          const value = await relay.browserRelaySetProjectSettings(project.data.projectId, update.data.expectedRevision, update.data.preferences);
          return Response.json({ status: 'ok', value });
        } catch (error) {
          return jsonError(409, 'PROJECT_BROWSER_UPDATE_REJECTED', error instanceof Error ? error.message : 'Project Chrome update rejected');
        }
      }
      const parsed = z.object({ pairingId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).safeParse(raw);
      if (!parsed.success || (url.pathname.endsWith('/confirm') && !parsed.data.fingerprint)) return jsonError(400, 'PAIRING_REQUEST_INVALID', 'A paired browser identity is required');
      const value = url.pathname.endsWith('/unpair') ? await relay.browserRelayUnpair(parsed.data.pairingId)
        : await relay.browserRelayConfirm(parsed.data.pairingId, parsed.data.fingerprint!);
      return Response.json({ status: 'ok', value });
    }
    if (url.pathname === '/api/services/fetch' || url.pathname === '/api/services/trust') {
      const machineId = request.headers.get('x-gitspace-machine') ?? '';
      const target = `${request.method}\n${url.pathname}${url.search}`;
      const auth = await (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(env.ACCOUNT_ID).authorizeMachineRequest(request.headers.get('authorization'), target, machineId);
      if (auth.status === 'error') return Response.json(auth, { status: 401 });
      if (url.pathname.endsWith('/trust')) return Response.json(await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust());
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonError(400, 'SERVICE_URL_REQUIRED', 'Service URL required');
      const headers = new Headers(request.headers);
      const applicationAuthorization = headers.get('x-gitspace-service-authorization');
      headers.delete('x-gitspace-service-authorization');
      headers.delete('authorization');
      if (applicationAuthorization) headers.set('authorization', applicationAuthorization);
      return fetchInternalService(env, { kind: 'device', accountId: env.ACCOUNT_ID, deviceId: machineId }, new Request(targetUrl, { method: request.method, headers, body: request.body, signal: request.signal }));
    }
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return Response.json(
        { status: 'ok', protocolVersion: RELAY_PROTOCOL_VERSION },
        { headers: { 'cache-control': 'no-store', [WORKER_VERSION_HEADER]: WORKER_VERSION } },
      );
    }

    const artifact = ARTIFACT_PATH.exec(url.pathname);
    const genericObject = url.pathname === '/objects';
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
    if (tunnel) {
      let bodyProof: z.infer<typeof TunnelBodyProofSchema> | undefined;
      if (request.headers.has('x-gitspace-device')) {
        const auth = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).authorizeTunnelDeviceRequest({ header: request.headers.get('x-gitspace-device'), target: `${url.pathname}${url.search}`, method: request.method });
        if (auth.status === 'error') return Response.json(auth, { status: 401 });
        const declared = request.headers.get('content-length');
        if (declared === null && request.body !== null) return jsonError(411, 'REQUEST_LENGTH_REQUIRED', 'Tunnel uploads require Content-Length');
        if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) return jsonError(400, 'REQUEST_LENGTH_INVALID', 'Invalid tunnel content length');
        const length = declared === null ? 0 : Number(declared);
        if (length > TUNNEL_MAX_BODY_BYTES) return jsonError(413, 'REQUEST_TOO_LARGE', 'Tunnel uploads are limited to 64 MiB');
        bodyProof = { length, bodySha256: auth.value.bodySha256 };
        if (!request.body && (length !== 0 || auth.value.bodySha256 !== rpcBodySha256(new Uint8Array()))) return jsonError(400, 'REQUEST_BODY_MISMATCH', 'Tunnel body does not match its signed digest and declared length');
      } else {
        const auth = request.headers.has(MACHINE_GRANT_HEADER) ? await authorizedMachineRequest(request, env, null) : authorizedRootRequest(request, env);
        if (auth instanceof Response) return auth;
        if (!await env.RELAY.getByName(env.RELAY_NAME).consumeAuthorization(auth.nonce, auth.timestamp)) return jsonError(401, 'AUTH_REPLAY', 'Tunnel authorization was already used');
      }
      const headers = new Headers(request.headers);
      for (const name of Object.keys(INTERNAL_HEADERS)) headers.delete(name);
      for (const name of ['x-forwarded-host', 'x-gitspace-service-assertion', 'x-gitspace-websocket-probe', 'x-gitspace-service-authorization']) headers.delete(name);
      return forwardTunnelRequest(new Request(request, { headers }), env, tunnel, bodyProof);
    }

    let authorization: Response | { nonce: string; timestamp: number; target: string };
    if (url.pathname === '/ws') {
      const role = url.searchParams.get('role');
      const id = url.searchParams.get('id');
      authorization = role === 'machine'
        ? await authorizedMachineRequest(request, env, id)
        : authorizedRootRequest(request, env);
    } else if (genericObject) {
      authorization = request.headers.has(MACHINE_GRANT_HEADER)
        ? await authorizedMachineRequest(request, env, null)
        : authorizedRootRequest(request, env);
    } else if (artifact) {
      authorization = await authorizedMachineRequest(request, env, null);
    } else {
      return application.fetch(request, env);
    }
    if (authorization instanceof Response) return authorization;

    const stub = env.RELAY.getByName(env.RELAY_NAME);
    if (genericObject) {
      if (!await stub.consumeAuthorization(authorization.nonce, authorization.timestamp)) return jsonError(401, 'AUTH_REPLAY', 'Object authorization was already used');
      const key = url.searchParams.get('key');
      if (!key || new TextEncoder().encode(key).byteLength > 1024) return jsonError(400, 'INVALID_OBJECT_KEY', 'An object key within provider limits is required');
      if (request.method === 'PUT') {
        const object = await env.DATA.put(key, request.body ?? new Uint8Array(), { httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' } });
        return Response.json({ key, size: object.size, etag: object.httpEtag }, { status: 201 });
      }
      if (request.method === 'DELETE') {
        await env.DATA.delete(key);
        return new Response(null, { status: 204 });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError(405, 'METHOD_NOT_ALLOWED', 'Object access supports GET, HEAD, PUT and DELETE');
      const object = request.method === 'HEAD' ? await env.DATA.head(key) : await env.DATA.get(key);
      if (!object) return jsonError(404, 'OBJECT_NOT_FOUND', 'Object is unavailable');
      const headers = new Headers({ 'content-length': String(object.size), etag: object.httpEtag });
      object.writeHttpMetadata(headers);
      return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { headers });
    }
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
    }

    return stub.fetch(relayRequest(request, authorization, headers));
  },
} satisfies ExportedHandler<Env>;
