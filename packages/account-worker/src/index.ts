import { accountStatus } from './account-access.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE, deviceAuthority, withDeviceAuthority } from './device-authority.js';
import { appendRuntimeQa } from './runtime-services.js';
import { machineProtocolInputSchema } from '@gitspace/protocol/deployment';
import {
  RELAY_HEARTBEAT_LEASE_MS,
  RELAY_HEARTBEAT_MODE,
  RELAY_NOTICE_MODE,
  RELAY_PING_MESSAGE,
  RELAY_PONG_MESSAGE,
  RELAY_PROTOCOL_VERSION,
  relayNoticeSchema,
  TUNNEL_CHUNK_BYTES,
  decodeTunnelChunk,
  encodeTunnelChunk,
  endpointTag,
  parseRelaySocketMessage,
  socketAttachmentSchema,
  verifyRelayAuthorization,
  deviceGrantExpiresAt,
  SIGNED_REQUEST_EXPIRED_CODE,
  SIGNED_REQUEST_EXPIRED_MESSAGE,
  SIGNED_REQUEST_MAX_AGE_MS,
  machineAnnouncesResource,
  machineLiveResource,
  hostedServiceUrlKind,
  type LiveUnwatchedMessage,
  type RelayNotice,
  type RelayNoticeMessage,
  type SocketAttachment,
  type TunnelRequestMessage,
  type TunnelResponseMessage,
} from '@gitspace/protocol';
import {
  credentialProtocolBase64,
  signedCredentialAuthorityGrantSchema,
  verifyCredentialAuthorityGrant,
  verifyManagedDeviceGrant,
  type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol/credential-vault';
import { WORKER_VERSION_HEADER } from '@gitspace/protocol/deployment';
import application, { REQUEST_MAX_BYTES } from './application.js';
import { forwardTunnelRequest, relayRequest, tunnelTarget, verifiedTunnelBody, TUNNEL_MAX_BODY_BYTES, TunnelBodyProofSchema, INTERNAL_TUNNEL_BODY_PROOF, INTERNAL_TUNNEL_MACHINE, INTERNAL_TUNNEL_PATH, INTERNAL_SIGNED_TARGET, INTERNAL_SERVICE_SESSION } from './relay-request.js';
import { handleMcpRequest } from './mcp-server.js';
import { z } from 'zod';
import { rpcBodySha256 } from '@gitspace/protocol/device-grant';
import { fetchInternalService, isHostedServiceHostname, isWorkspaceServiceHostname } from './service-access.js';
import { serveIngress } from './service-ingress.js';
import { ServiceSessions, ServiceSessionSchema, sameServiceCaller, type ServiceSession, type ServiceWorkspace, serviceCookie, safeServiceReturn, SERVICE_COOKIE, SERVICE_STATE_COOKIE } from './service-sessions.js';
import { AccountBrowserRelay, BROWSER_SCRIPT_PATH, browserRelayArchive } from './browser-relay.js';
import { BROWSER_UPLOAD_PATH, browserRouteReply, readBrowserSignedRequest, serveBrowserUpload, type BrowserSignedRequest, type BrowserUploadStep } from './browser-upload.js';
import { BROWSER_COMMENT_PATH, BROWSER_WORKSPACES_PATH, type RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { BROWSER_SHARE_PATH, browserShareAccount, serveBrowserShare } from './browser-share.js';
import { BROWSER_WATCH_INTERNAL_PATH, browserWatchDeviceActive, serveBrowserWatch } from './browser-watch.js';
import { serveBrowserCaptureShare } from './browser-capture-share.js';
import { BROWSER_CAPTURE_SHARE_PATH, type RuntimeBrowserCaptureShareComment } from '@gitspace/protocol-runtime';
import { BROWSER_WATCH_PATH } from '@gitspace/protocol-runtime';
import { mintUploadLink, serveUploadLink } from './upload-link.js';
import { UPLOAD_LINK_PATH } from '@gitspace/protocol/rpc-contract';
import { workspaceDrive } from './workspace-drive.js';
import { RuntimeBrowserNameSchema, RuntimeBrowserNoteSchema, RuntimeIdentitySchema, RuntimeProjectBrowserPreferencesSchema, type RuntimeProjectBrowserPreferences, type RuntimeAccountBrowserAuthorization, type RuntimeBrowserTrust } from '@gitspace/protocol-runtime';
import { notifyBrowsers } from './live-notices.js';
import { BudgetedDurableObject, platformStorageControl } from './storage-quarantine.js';
export {
  AccountStateDO, CredentialVaultDO, FleetCatalogDO, GitHubAppDO, HostedRouteRegistryDO,
  ProjectAuthorityDO, ProjectCronsDO, ProjectSecretsDO, SpaceAuthorityDO,
  SpaceContextDO, TenantReleasesDO, UserMcpConnectionsDO, UserProjectIndexDO,
  UserSettingsDO, UserSkillsDO, UserStorageDO,
} from './application.js';
export { BrowserSessionCdp, BrowserSessionDO, BrowserSessionFiles } from './browser-session.js';
export { StorageMigrationDO } from './storage-migration.js';
declare const GITSPACE_WORKER_SHA: string | undefined;
const WORKER_VERSION = typeof GITSPACE_WORKER_SHA === 'string' ? GITSPACE_WORKER_SHA : 'channel';

const INTERNAL_ROLE = 'x-gitspace-role';
const INTERNAL_ENDPOINT_ID = 'x-gitspace-endpoint-id';
const MACHINE_GRANT_HEADER = 'x-gitspace-machine-grant';
const INTERNAL_HEADERS: Record<string, true> = {
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
  session?: ServiceSession;
  method: string;
  origin: string | null;
  resolve: (response: Response) => void;
  responseStarted: boolean;
  dispatched: boolean;
  cleanup: () => void;
  uploadReader?: ReadableStreamDefaultReader<Uint8Array>;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

interface RelaySocketAttachment extends SocketAttachment {
  machineGrant?: SignedCredentialAuthorityGrant;
  heartbeatExpiresAt?: number;
  /** The machine understands `notice` messages. */
  notices?: boolean;
  /** One machine connection; the service WebSockets it carries are bound to it, not to a later connection. */
  connectionId?: string;
}

/** Machine and client endpoint sockets. */
const ENDPOINT_SOCKET_TAG = 'endpoint';
/** A browser's service WebSocket, tunnelled to a machine. Everything about it lives in its attachment, so the relay
 * hibernates while it is open. */
const SERVICE_SOCKET_TAG = 'service';
const ServiceSocketAttachmentSchema = z.object({
  role: z.literal('service'),
  requestId: z.string(),
  machineId: z.string(),
  connectionId: z.string(),
  session: ServiceSessionSchema.optional(),
});
type ServiceSocketAttachment = z.infer<typeof ServiceSocketAttachmentSchema>;

function serviceSocketAttachment(socket: WebSocket): ServiceSocketAttachment | null {
  const parsed = ServiceSocketAttachmentSchema.safeParse(socket.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

/** Closes a socket the relay still holds open; one already closing is left to finish. */
function closeOpenSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === 1) socket.close(code, reason);
}

/** A presence report that failed is retried after this long, doubling with each failure. */
const PRESENCE_RETRY_MS = 5_000;
/** Retries after the first failure: 5 s to 5 min 20 s, about 10.6 minutes in all. One more failure gives up: each
 * workspace that could not be told gets a QA item, and the machine's next connect, disconnect or presence read tries
 * afresh. */
const PRESENCE_RETRIES = 7;
const PRESENCE_SEEDED = 'presence-seeded';

/** When a machine grant stops authorizing: its own expiry or its earliest issuer's; Infinity when none expires.
 * Revocation is not a deadline: the vault tells the relay (`machineCredentialsChanged`). */
function machineAuthorizationDeadline(grant: SignedCredentialAuthorityGrant): number {
  let deadline = grant.grant.expiresAt ?? Infinity;
  for (const issuer of grant.issuerChain ?? []) deadline = Math.min(deadline, deviceGrantExpiresAt(issuer) ?? Infinity);
  return deadline;
}

/** Current authority for a machine grant and its account, from the isolate's cached registry. */
async function currentMachineAuthority(
  env: Env,
  grant: SignedCredentialAuthorityGrant,
  capability: 'space.control' | 'storage.access',
): Promise<Response | null> {
  if (grant.grant.userId !== env.ACCOUNT_ID) return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine grant belongs to another tenant');
  const result = await withDeviceAuthority(env, (view, now) => {
    const authorized = view.authorizeRelayGrant(grant, capability, now);
    if (authorized.status === 'error') return authorized;
    const account = accountStatus(env, view, env.ACCOUNT_ID);
    return account.status === 'error' ? { ...account, miss: false } : authorized;
  });
  if (result.status === 'ok') return null;
  const { code, message } = result.error;
  if (code === DEVICE_AUTHORITY_UNAVAILABLE || code === 'ACCOUNT_AUTHORITY_UNAVAILABLE') return jsonError(503, code, message);
  if (code === 'ACCOUNT_UNAVAILABLE') return jsonError(403, code, message);
  return jsonError(401, 'MACHINE_GRANT_REJECTED', message);
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


function authorizedRootRequest(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const verified = verifyRelayAuthorization({
    header: request.headers.get('authorization'),
    signingPublicKey: env.AUTH_PUBLIC_KEY,
    target: `${url.pathname}${url.search}`,
    maxSkewMs: SIGNED_REQUEST_MAX_AGE_MS,
  });
  if (verified.status === 'ok') return null;
  return verified.error.expired ? jsonError(401, SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE) : jsonError(401, 'UNAUTHORIZED', verified.error.message);
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

async function authorizedMachineRequest(request: Request, env: Env, machineId: string | null): Promise<Response | null> {
  const signedGrant = decodeMachineGrant(request.headers.get(MACHINE_GRANT_HEADER));
  if (!signedGrant) return jsonError(401, 'MACHINE_GRANT_REQUIRED', 'Machine credential grant is missing or invalid');
  // Root-signed (paired) or self-signed (managed) claim; current authority is checked
  // below or, for machine sockets, inside the relay before the socket is accepted.
  const grant = verifyCredentialAuthorityGrant(signedGrant, credentialProtocolBase64.decode(env.AUTH_PUBLIC_KEY)) ?? verifyManagedDeviceGrant(signedGrant);
  if (!grant || (machineId !== null && grant.machineId !== machineId)) {
    return jsonError(401, 'MACHINE_GRANT_REJECTED', 'Machine credential grant is not valid for this relay endpoint');
  }
  const url = new URL(request.url);
  const verified = verifyRelayAuthorization({
    header: request.headers.get('authorization'),
    signingPublicKey: grant.signingPublicKey,
    target: `${url.pathname}${url.search}`,
    maxSkewMs: SIGNED_REQUEST_MAX_AGE_MS,
  });
  if (verified.status === 'error') {
    return verified.error.expired ? jsonError(401, SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE) : jsonError(401, 'UNAUTHORIZED', verified.error.message);
  }
  // WebSocket authority is checked inside the DO immediately before replacement.
  return machineId === null ? currentMachineAuthority(env, signedGrant, 'storage.access') : null;
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

export class UserRelayDO extends BudgetedDurableObject {
  private readonly pendingTunnels = new Map<string, PendingTunnel>();
  private readonly serviceSessions = new ServiceSessions(this.ctx.storage, this.env.ACCOUNT_ID, async (deviceId) => {
    const view = await deviceAuthority(this.env).current();
    if (!view) throw new Error(DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE);
    return view.serviceDeviceAuthority(deviceId, Date.now());
  });
  private readonly browserRelay = new AccountBrowserRelay(this.ctx, this.env, identity => workspaceDrive(this.env, identity), browserShareAccount(this.env), () => this.scheduleAlarm(), deviceId => browserWatchDeviceActive(this.env, deviceId));
  async serviceApprove(input: { hostname: string; deviceId: string; state: string; returnTo: string }) {
    const ticket = await this.serviceSessions.approve(input);
    await this.scheduleAlarm();
    return ticket;
  }
  async serviceRedeem(ticket: string, hostname: string, state: string | null) {
    const session = await this.serviceSessions.redeem(ticket, hostname, state);
    await this.scheduleAlarm();
    return session;
  }
  serviceValidate(token: string | null, hostname: string) { return this.serviceSessions.validate(token, hostname); }
  async serviceRevokeDevice(deviceId: string) {
    const sessions = await this.serviceSessions.revokeDevice(deviceId);
    await this.closeServiceSessions(sessions);
    await this.scheduleAlarm();
    return sessions;
  }
  async serviceLogout(token: string | null, hostname: string) {
    const sessionId = await this.serviceSessions.logout(token, hostname);
    if (sessionId) await this.closeServiceSessions([sessionId]);
    await this.scheduleAlarm();
    return sessionId !== null;
  }
  /** A workspace's cloud browser's session for one of that workspace's live hostnames (workspace or machine URL), for
   * its browser session object to set as a cookie. Minting again renews it. */
  async serviceCloudSession(hostname: string, workspace: ServiceWorkspace) {
    if (!await isWorkspaceServiceHostname(this.env, workspace, hostname, workspace)) throw new Error('Not a live service of this workspace');
    const session = await this.serviceSessions.cloud(hostname, workspace);
    await this.scheduleAlarm();
    return session;
  }
  /** Ends a workspace's cloud browser sessions and the requests and WebSockets open on them. */
  async serviceRevokeCloud(workspace: ServiceWorkspace) {
    await this.closeServiceSessions(await this.serviceSessions.revokeCloud(workspace));
    await this.scheduleAlarm();
  }
  private async closeServiceSessions(sessionIds: readonly string[]) {
    if (!sessionIds.length) return;
    const revoked = new Set(sessionIds);
    for (const [requestId, pending] of this.pendingTunnels) {
      if (pending.session && revoked.has(pending.session.sessionId)) {
        await this.failTunnel(requestId, new Error('Service authorization expired'), 401, 'SERVICE_SESSION_EXPIRED');
      }
    }
    for (const socket of this.ctx.getWebSockets(SERVICE_SOCKET_TAG)) {
      const service = serviceSocketAttachment(socket);
      if (service?.session && revoked.has(service.session.sessionId)) closeOpenSocket(socket, 1008, 'Service authorization expired');
    }
  }
  private async serviceTunnelAuthorized(requestId: string, pending: PendingTunnel): Promise<boolean> {
    if (!pending.session) return true;
    const session = await this.serviceSessions.validate(pending.session.sessionId, pending.session.hostname).catch(() => null);
    if (session && sameServiceCaller(session.caller, pending.session.caller)) return true;
    await this.failTunnel(requestId, new Error('Service authorization expired'), 401, 'SERVICE_SESSION_EXPIRED');
    return false;
  }
  private async serviceSocketAuthorized(socket: WebSocket, service: ServiceSocketAttachment): Promise<boolean> {
    if (!service.session) return true;
    const session = await this.serviceSessions.validate(service.session.sessionId, service.session.hostname).catch(() => null);
    if (session && sameServiceCaller(session.caller, service.session.caller)) return true;
    closeOpenSocket(socket, 1008, 'Service authorization expired');
    return false;
  }
  /** The machine connection a service WebSocket was opened on. */
  private tunnelMachine(service: ServiceSocketAttachment): WebSocket | undefined {
    return this.ctx.getWebSockets(`endpoint:machine:${service.machineId}`).find(socket => this.socketAttachment(socket)?.connectionId === service.connectionId);
  }
  /** The service WebSocket a machine connection carries for `requestId`. */
  private tunnelService(requestId: string, machine: RelaySocketAttachment): { socket: WebSocket; service: ServiceSocketAttachment } | null {
    for (const socket of this.ctx.getWebSockets(`tunnel:${requestId}`)) {
      const service = serviceSocketAttachment(socket);
      if (service && service.connectionId === machine.connectionId) return { socket, service };
    }
    return null;
  }
  /** Browser → machine. */
  private async serviceSocketMessage(socket: WebSocket, input: string | ArrayBuffer): Promise<void> {
    const service = serviceSocketAttachment(socket);
    if (!service) return closeOpenSocket(socket, 1011, 'Missing socket identity');
    if (!await this.serviceSocketAuthorized(socket, service)) return;
    const machine = this.tunnelMachine(service);
    if (!machine || !await this.authorizeSocket(machine)) return closeOpenSocket(socket, 1011, 'Service tunnel disconnected');
    machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.data', requestId: service.requestId, binary: typeof input !== 'string', data: typeof input === 'string' ? input : encodeTunnelChunk(new Uint8Array(input)) } satisfies TunnelRequestMessage));
  }
  /** Machine → browser. */
  private async machineServiceMessage(socket: WebSocket, service: ServiceSocketAttachment, message: TunnelResponseMessage): Promise<void> {
    if (message.type === 'tunnel.websocket.data') {
      if (await this.serviceSocketAuthorized(socket, service)) socket.send(message.binary ? decodeTunnelChunk(message.data) : message.data);
      return;
    }
    if (message.type === 'tunnel.websocket.close') return closeOpenSocket(socket, 1000, message.reason);
    closeOpenSocket(socket, 1011, message.type === 'tunnel.response.error' ? 'Service WebSocket failed' : 'Service tunnel disconnected');
  }
  /** A closed service WebSocket closes the machine's end. */
  private serviceSocketGone(socket: WebSocket): void {
    const service = serviceSocketAttachment(socket);
    const machine = service ? this.tunnelMachine(service) : undefined;
    if (!service || machine?.readyState !== 1) return;
    machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.websocket.close', requestId: service.requestId, code: 1000, reason: '' } satisfies TunnelRequestMessage));
  }
  browserRelayPair(trust: RuntimeBrowserTrust) { return this.browserRelay.pair(trust); }
  /** A short pairing code your Chrome's extension redeems (public `/api/browser-relay/pairing-code`), limited per address and code. */
  browserRelayRedeemPairingCode(code: string, ip: string, endpoint: string) { return this.browserRelay.redeemPairingCode(code, ip, endpoint); }
  browserRelayStatus() { return this.browserRelay.status(); }
  browserRelayPlacement(projectId: string, pairingId?: string) { return this.browserRelay.placement(projectId, pairingId); }
  browserRelayProjectSettings(projectId: string) { return this.browserRelay.projectSettings(projectId); }
  browserRelaySetProjectSettings(projectId: string, expectedRevision: number, preferences: RuntimeProjectBrowserPreferences) { return this.browserRelay.setProjectSettings(projectId, expectedRevision, preferences); }
  /** Browser powers (`browser-powers.ts`): what a workspace's agents may do beyond its sites on each approved Chrome,
   * and Everything for the workspace on one Chrome, allowed for an hour or ended. */
  browserRelayPowers(projectId: string, workspaceId: string) { return this.browserRelay.powers(projectId, workspaceId); }
  browserRelayEverything(projectId: string, workspaceId: string, pairingId: string, on: boolean) { return this.browserRelay.everything(projectId, workspaceId, pairingId, on); }
  browserRelayUnpair(pairingId: string) { return this.browserRelay.unpair(pairingId); }
  browserRelayConfirm(pairingId: string, fingerprint: string) { return this.browserRelay.confirm(pairingId, fingerprint); }
  browserRelaySetChrome(pairingId: string, change: { name?: string; note?: string }) { return this.browserRelay.setChrome(pairingId, change); }
  browserRelayExecute(authorization: RuntimeAccountBrowserAuthorization) { return this.browserRelay.execute(authorization); }
  /** A workspace's cloud browser session says its browser opened, is still in use, or closed. */
  browserRelayCloudOpen(session: string, open: boolean) { return this.browserRelay.cloudOpen(session, open); }
  /** An archived or deleted workspace's Chrome groups end, and its cloud browser's service sessions with them. */
  async browserRelayRetireWorkspace(projectId: string, workspaceId: string) {
    await this.browserRelay.retireWorkspace(projectId, workspaceId);
    await this.serviceRevokeCloud({ projectId, workspaceId });
  }
  /** A script on a Chrome (`browser.run`) begins with its signed run authority and ends from the browser session. */
  browserRelayScriptBegin(authorization: RuntimeAccountBrowserAuthorization) { return this.browserRelay.scriptBegin(authorization); }
  browserRelayScriptEnd(token: string) { return this.browserRelay.scriptEnd(token); }
  /** One step of a file upload from a Chrome extension (`serveBrowserUpload`). */
  browserRelayUpload(step: BrowserUploadStep) { return this.browserRelay.upload(step); }
  /** Share links (`browser-share.ts`): a request your Chrome signed, a link's greeting, and a viewer joining. */
  browserRelayShare(request: BrowserSignedRequest, body: unknown) { return this.browserRelay.shareRequest(request, body); }
  browserSharePreview(shareId: string, secret: string, owner: boolean) { return this.browserRelay.sharePreview(shareId, secret, owner); }
  browserShareJoin(shareId: string, secret: string) { return this.browserRelay.shareJoin(shareId, secret); }
  /** Comments (`browser-comments.ts`): a request your Chrome's in-page comment tool signed, and a thread a workspace
   * changed (the agent's or the Browser tab's), for its share's viewers and the workspace's Chromes. */
  browserRelayComment(request: BrowserSignedRequest, body: unknown) { return this.browserRelay.commentRequest(request, body); }
  browserRelayCommentChanged(workspace: { projectId: string; workspaceId: string }, thread: RuntimeBrowserCommentThread) { return this.browserRelay.commentChanged(workspace, thread); }
  /** A request your Chrome's popup signed with its pairing key: the workspaces it may add a tab to, or adding one. */
  browserRelayWorkspaces(request: BrowserSignedRequest, body: unknown) { return this.browserRelay.workspaceRequest(request, body); }
  /** Capture share links (`browser-capture-share.ts`): a workspace's from its Browser tab, a request your Chrome signed,
   * and a link's greeting, open, file check and comments. */
  browserCaptureShares(workspace: { projectId: string; workspaceId: string }) { return this.browserRelay.captureShareList(workspace); }
  browserCaptureShareCreate(workspace: { projectId: string; workspaceId: string }, input: { captureId: string; comment: boolean; expiresInMinutes: number }) { return this.browserRelay.captureShareCreate(workspace, input); }
  browserCaptureShareRevoke(workspace: { projectId: string; workspaceId: string }, captureShareId: string) { return this.browserRelay.captureShareRevoke(workspace, captureShareId); }
  browserCaptureShareChrome(request: BrowserSignedRequest, body: unknown) { return this.browserRelay.captureShareRequest(request, body); }
  browserCaptureSharePreview(captureShareId: string, secret: string) { return this.browserRelay.captureSharePreview(captureShareId, secret); }
  browserCaptureShareOpen(captureShareId: string, secret: string, viewer: { name: string; guest: boolean }) { return this.browserRelay.captureShareOpen(captureShareId, secret, viewer); }
  browserCaptureShareLive(captureShareId: string) { return this.browserRelay.captureShareLive(captureShareId); }
  browserCaptureShareComment(captureShareId: string, viewer: { name: string; guest: boolean }, request: RuntimeBrowserCaptureShareComment) { return this.browserRelay.captureShareComment(captureShareId, viewer, request); }

  private presenceLine: Promise<void> = Promise.resolve();
  private alarmLine: Promise<void> = Promise.resolve();
  /** When machine presence is next reconciled against the live sockets, after a restart. */
  private presenceCheckAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Ping-mode machines are answered without waking the relay; the answer's time extends their heartbeat lease.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING_MESSAGE, RELAY_PONG_MESSAGE));
    ctx.blockConcurrencyWhile(async () => {
      // Relay authorizations are bounded by the 60-second clock window, not single-use nonces.
      ctx.storage.sql.exec('DROP TABLE IF EXISTS auth_nonces');
      // The machines this relay last reported connected.
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS machine_presence(machine_id TEXT PRIMARY KEY)');
      // Machines whose last presence report failed: how many times in a row, and when the next try is due.
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS presence_retries(machine_id TEXT PRIMARY KEY, failures INTEGER NOT NULL, due_at INTEGER NOT NULL)');
      // A restart (a deploy) drops sockets without close events. A reported machine with no socket that has not
      // reconnected within one heartbeat lease is reported gone. Until presence is first seeded, the fleet's online
      // machines count as reported. A wake from hibernation keeps every socket and schedules nothing.
      const holders = new Set(ctx.getWebSockets(ENDPOINT_SOCKET_TAG).flatMap(socket => {
        const attachment = this.socketAttachment(socket);
        return attachment?.role === 'machine' ? [attachment.id] : [];
      }));
      const absent = ctx.storage.sql.exec<{ machine_id: string }>('SELECT machine_id FROM machine_presence').toArray().some(row => !holders.has(row.machine_id));
      if (absent || await ctx.storage.get(PRESENCE_SEEDED) !== true) {
        this.presenceCheckAt = Date.now() + RELAY_HEARTBEAT_LEASE_MS;
        await this.scheduleAlarm();
      }
    });
  }

  /** Every read of a machine's presence (the fleet's machines, a workspace's attachments) asks this first. A machine
   * whose last answered ping is older than its heartbeat lease is closed and reported offline now, with the notices a
   * close sends, so a read never sees a silent machine online past the lease. No timer watches idle machines. */
  async confirmMachinePresence(machineIds: readonly string[]): Promise<void> {
    await Promise.all(machineIds.map(async machineId => {
      for (const socket of this.ctx.getWebSockets(`endpoint:machine:${machineId}`)) this.heartbeatLive(socket);
      await this.reconcilePresence(machineId);
    }));
  }

  /** The vault changed a credential: machine sockets and service sessions are checked against a registry loaded after
   * the change. Views other requests hold are left to converge as before. */
  async machineCredentialsChanged(): Promise<void> {
    const machines = this.ctx.getWebSockets(ENDPOINT_SOCKET_TAG).filter(socket => this.socketAttachment(socket)?.role === 'machine');
    if (machines.length === 0 && await this.serviceSessions.nextExpiry() === null) return;
    await deviceAuthority(this.env).refreshed();
    await Promise.all(machines.map(socket => this.authorizeSocket(socket)));
    await this.closeServiceSessions(await this.serviceSessions.sweep());
    await this.scheduleAlarm();
  }

  /** One notice to each named machine's notice-capable sockets. It carries no state, so a machine that misses one
   * loses nothing: it fetches every topic whenever its connection opens. */
  notifyMachines(machineIds: readonly string[] | 'all', notice: RelayNotice): void {
    const message = JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'notice', ...relayNoticeSchema.parse(notice) } satisfies RelayNoticeMessage);
    const sockets = machineIds === 'all' ? this.ctx.getWebSockets() : machineIds.flatMap(machineId => this.ctx.getWebSockets(`endpoint:machine:${machineId}`));
    for (const socket of sockets) {
      if (socket.readyState !== 1 || this.socketAttachment(socket)?.notices !== true) continue;
      try { socket.send(message); } catch { /* A socket closing now reconnects and catches up. */ }
    }
  }

  /** A machine is connected while one of its sockets is open and inside its heartbeat lease. */
  private machineConnected(machineId: string): boolean {
    return this.ctx.getWebSockets(`endpoint:machine:${machineId}`).some(socket => {
      const attachment = this.socketAttachment(socket);
      const expiresAt = attachment ? this.heartbeatExpiresAt(socket, attachment) : undefined;
      return socket.readyState === 1 && (expiresAt === undefined || expiresAt > Date.now());
    });
  }

  /** Presence is written only when it changes: to the fleet, then to each workspace attaching the machine. Passes are
  * serialized and each reads the live sockets, so interleaved opens and closes converge on the final state. An accepted
  * socket always tells the workspaces (they write only on change), so a workspace that missed a report catches up on
  * the machine's next connection; a workspace that cannot be told keeps the state unreported and is retried with
  * backoff (`PRESENCE_RETRIES`). */
  private reconcilePresence(machineId: string, accepted = false): Promise<void> {
    const run = this.presenceLine.then(async () => {
      const connected = this.machineConnected(machineId);
      const reported = this.ctx.storage.sql.exec('SELECT 1 FROM machine_presence WHERE machine_id=?', machineId).toArray().length > 0;
      if (reported === connected && !(accepted && connected)) {
        this.ctx.storage.sql.exec('DELETE FROM presence_retries WHERE machine_id=?', machineId);
        return;
      }
      let unreached: { projectId: string; workspaceId: string }[] = [];
      try {
        const workspaces = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).machinePresence(machineId, connected);
        const failed = await Promise.all(workspaces.map(workspace => this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${workspace.workspaceId}`).runtimeMachinePresence(machineId, connected).then(() => false, (error: unknown) => {
          console.error(JSON.stringify({ event: 'relay_presence_workspace_failed', machineId, workspaceId: workspace.workspaceId, message: error instanceof Error ? error.message : String(error) }));
          return true;
        })));
        unreached = workspaces.filter((_workspace, index) => failed[index]);
        if (unreached.length) throw new Error('A workspace did not record the machine presence');
        if (connected) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO machine_presence(machine_id) VALUES(?)', machineId);
        else this.ctx.storage.sql.exec('DELETE FROM machine_presence WHERE machine_id=?', machineId);
        this.ctx.storage.sql.exec('DELETE FROM presence_retries WHERE machine_id=?', machineId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'relay_presence_failed', machineId, connected, message }));
        // Unreported, a connected machine is pushed again by the retry.
        if (connected) this.ctx.storage.sql.exec('DELETE FROM machine_presence WHERE machine_id=?', machineId);
        const failures = (this.ctx.storage.sql.exec<{ failures: number }>('SELECT failures FROM presence_retries WHERE machine_id=?', machineId).toArray()[0]?.failures ?? 0) + 1;
        if (failures <= PRESENCE_RETRIES) {
          this.ctx.storage.sql.exec('INSERT INTO presence_retries(machine_id,failures,due_at) VALUES(?,?,?) ON CONFLICT(machine_id) DO UPDATE SET failures=excluded.failures, due_at=excluded.due_at', machineId, failures, Date.now() + PRESENCE_RETRY_MS * 2 ** (failures - 1));
          await this.scheduleAlarm();
          return;
        }
        this.ctx.storage.sql.exec('DELETE FROM presence_retries WHERE machine_id=?', machineId);
        await this.scheduleAlarm();
        console.error(JSON.stringify({ event: 'relay_presence_gave_up', machineId, connected, failures, message, workspaces: unreached.map(workspace => workspace.workspaceId) }));
        const text = `GitSpace could not record that machine ${machineId} is ${connected ? 'online' : 'offline'} in this workspace after ${failures} tries over about 10 minutes (${message}). It shows the old state until the machine next connects or disconnects.`;
        await Promise.all(unreached.map(workspace => appendRuntimeQa(this.env, RuntimeIdentitySchema.parse(workspace), crypto.randomUUID(), { message: text }).catch((qaError: unknown) => {
          console.error(JSON.stringify({ event: 'relay_presence_report_failed', machineId, workspaceId: workspace.workspaceId, message: qaError instanceof Error ? qaError.message : String(qaError) }));
        })));
      }
    });
    this.presenceLine = run.catch(() => {});
    return run;
  }

  /** Reconciles every machine reported connected or holding a socket; a socket holder is re-asserted to its workspaces. */
  private async sweepPresence(): Promise<void> {
    if (await this.ctx.storage.get(PRESENCE_SEEDED) !== true) {
      // Machines marked online before the relay owned presence are reported connected, so a gone one goes offline.
      for (const machine of await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).listMachines()) {
        if (machine.state === 'online') this.ctx.storage.sql.exec('INSERT OR IGNORE INTO machine_presence(machine_id) VALUES(?)', machine.id);
      }
      await this.ctx.storage.put(PRESENCE_SEEDED, true);
    }
    const holders = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(socket);
      if (attachment?.role === 'machine') holders.add(attachment.id);
    }
    const machines = new Set([...this.ctx.storage.sql.exec<{ machine_id: string }>('SELECT machine_id FROM machine_presence').toArray().map(row => row.machine_id), ...holders]);
    for (const machineId of machines) await this.reconcilePresence(machineId, holders.has(machineId));
  }
  async fetch(request: Request): Promise<Response> {

    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.acceptSocket(request);
    if (url.pathname.startsWith('/tunnel/')) return this.openTunnel(request);
    // A Chrome extension's socket. It arrives here through the stub's `fetch`, never as an RPC argument: an incoming
    // request carries its abort signal, which RPC cannot pass.
    if (url.pathname === '/api/browser-relay/extension') return this.browserRelay.fetch(request);
    // A share viewer's socket; it says hello with the token its join sealed.
    if (/^\/api\/shares\/[^/]+\/live$/u.test(url.pathname)) return this.browserRelay.shareFetch(request);
    // The Watch dialog's socket on a Chrome tab, checked by the public route (`serveBrowserWatch`), which alone sends here.
    if (url.pathname === BROWSER_WATCH_INTERNAL_PATH) return this.browserRelay.watchFetch(request);
    // A script's CDP connection to a Chrome, from the browser session's sandbox binding. The public handler forwards
    // only `/ws`, `/tunnel/`, the extension's socket and share viewers' sockets here, so this path is internal; its
    // token admits a live run alone.
    if (url.pathname.startsWith(BROWSER_SCRIPT_PATH)) return this.browserRelay.scriptFetch(request);
    return jsonError(404, 'NOT_FOUND', 'Relay route not found');
  }

  async webSocketMessage(socket: WebSocket, input: string | ArrayBuffer): Promise<void> {
    if (this.ctx.getTags(socket).includes(SERVICE_SOCKET_TAG)) return this.serviceSocketMessage(socket, input);
    if (this.browserRelay.owns(socket)) return this.browserRelay.webSocketMessage(socket, input);
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
    if (message.type === 'live.notice') {
      const { workspace, resource, cursor } = message;
      // A machine announces only its own terminals and its own start; anything else is dropped.
      if (!machineAnnouncesResource(attachment.id, workspace, resource)) {
        console.warn(JSON.stringify({ event: 'live_notice_rejected', machineId: attachment.id, workspace, resource }));
        return;
      }
      // Never awaited: the machine does not wait on the tabs. Unwatched, the machine may stop observing the resource.
      this.ctx.waitUntil(notifyBrowsers(this.env, [{ project: null, workspace, resource, version: cursor }]).then(([delivered]) => {
        if (delivered !== 0 || socket.readyState !== 1) return;
        try { socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'live.unwatched', workspace, resource, cursor } satisfies LiveUnwatchedMessage)); } catch { /* A closing machine's observers are announced again on reconnect. */ }
      }));
      return;
    }
    const service = this.tunnelService(message.requestId, attachment);
    if (service) return this.machineServiceMessage(service.socket, service.service, message);
    const pending = this.pendingTunnels.get(message.requestId);
    if (!pending || pending.socket !== socket) return;

    try {
      switch (message.type) {
        case 'tunnel.websocket.open': {
          if (pending.responseStarted) throw new Error('Duplicate service WebSocket');
          const connectionId = attachment.connectionId;
          if (!connectionId) throw new Error('Machine connection has no identity');
          if (!await this.serviceTunnelAuthorized(message.requestId, pending)) return;
          const [client, server] = Object.values(new WebSocketPair());
          server.serializeAttachment({ role: 'service', requestId: message.requestId, machineId: attachment.id, connectionId, ...(pending.session ? { session: pending.session } : {}) } satisfies ServiceSocketAttachment);
          this.ctx.acceptWebSocket(server, [SERVICE_SOCKET_TAG, `tunnel:${message.requestId}`, `tunnel-connection:${connectionId}`]);
          pending.responseStarted = true;
          pending.resolve(new Response(null, { status: 101, webSocket: client }));
          // The request is answered; from here the socket's attachment carries the tunnel.
          await this.finishTunnel(message.requestId);
          return;
        }
        case 'tunnel.websocket.data':
        case 'tunnel.websocket.close':
          throw new Error('Service WebSocket is not open');
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
          return;
        }
        case 'tunnel.response.chunk':
          if (!pending.responseStarted) throw new Error('Tunnel body arrived before response headers');
          if (pending.writer) await pending.writer.write(decodeTunnelChunk(message.data));
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
    if (this.ctx.getTags(socket).includes(SERVICE_SOCKET_TAG)) {
      this.serviceSocketGone(socket);
      socket.close();
      return;
    }
    if (this.browserRelay.owns(socket)) return this.browserRelay.webSocketClose(socket);
    this.failSocketTunnels(socket, new Error(`Machine disconnected (${code}: ${reason || 'no reason'})`));
    // Transport-only codes such as 1006 cannot be sent in a close frame.
    socket.close();
    await this.socketGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    if (this.ctx.getTags(socket).includes(SERVICE_SOCKET_TAG)) {
      this.serviceSocketGone(socket);
      closeOpenSocket(socket, 1011, 'Service WebSocket failed');
      return;
    }
    if (this.browserRelay.owns(socket)) return this.browserRelay.webSocketError(socket);
    this.failSocketTunnels(socket, new Error('Machine socket failed'));
    socket.close(1011, 'Machine socket failed');
    await this.socketGone(socket);
  }

  /** A closed machine socket leaves its machine offline unless a replacement socket remains. */
  private socketGone(socket: WebSocket): Promise<void> {
    const attachment = this.socketAttachment(socket);
    return attachment?.role === 'machine' ? this.reconcilePresence(attachment.id) : Promise.resolve();
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
    const authorizedUntil = machineGrant ? machineAuthorizationDeadline(machineGrant) : Infinity;
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
    const query = new URL(request.url).searchParams;
    const heartbeat = query.get('heartbeat');
    const attachment: RelaySocketAttachment = {
      ...parsed.data,
      ...(machineGrant ? { machineGrant } : {}),
      ...(machineGrant && heartbeat === RELAY_HEARTBEAT_MODE
        ? { heartbeatExpiresAt: Date.now() + RELAY_HEARTBEAT_LEASE_MS }
        : {}),
      ...(machineGrant && query.get('notices') === RELAY_NOTICE_MODE ? { notices: true } : {}),
      ...(machineGrant ? { connectionId: crypto.randomUUID() } : {}),
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [ENDPOINT_SOCKET_TAG, tag]);
    if (machineGrant) {
      if (Number.isFinite(authorizedUntil)) await this.armBy(authorizedUntil);
      this.ctx.waitUntil(this.reconcilePresence(parsed.data.id, true));
      // The machine's terminal observers may be gone: tabs showing its terminals read them again, which restarts them.
      this.ctx.waitUntil(notifyBrowsers(this.env, [{ project: null, workspace: null, resource: machineLiveResource(parsed.data.id), version: Date.now() }]));
    }
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
      if (!current || !sameServiceCaller(current.caller, parsed.data.caller) || current.hostname !== request.headers.get('x-forwarded-host')) return jsonError(401, 'SERVICE_SESSION_REJECTED', 'Service session expired');
      session = current;
    }
    let machine: WebSocket | undefined;
    for (const socket of this.ctx.getWebSockets(`endpoint:machine:${machineId}`)) {
      if (await this.authorizeSocket(socket)) {
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
    };
    this.pendingTunnels.set(requestId, pending);
    request.signal.addEventListener('abort', abort, { once: true });
    // A machine with work in flight is watched until the work ends: its silence fails the work by its heartbeat lease.
    const machineAttachment = this.socketAttachment(machine);
    await this.armBy(machineAttachment ? this.heartbeatExpiresAt(machine, machineAttachment) : undefined);

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

  private async finishTunnel(requestId: string): Promise<void> {
    const pending = this.pendingTunnels.get(requestId);
    if (!pending) return;
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
    const connectionId = this.socketAttachment(socket)?.connectionId;
    if (connectionId) for (const service of this.ctx.getWebSockets(`tunnel-connection:${connectionId}`)) closeOpenSocket(service, 1011, 'Service tunnel disconnected');
  }

  private tunnelCors(response: Response, origin: string | null): Response {
    const allowedOrigin = `https://${this.env.RELAY_NAME}.gitspace.sh`;
    if (origin === allowedOrigin) {
      response.headers.set('access-control-allow-origin', allowedOrigin);
      response.headers.append('vary', 'origin');
    }
    return response;
  }

  /** Each wake handles what is due and arms the next real deadline, or none. */
  async alarm(): Promise<void> {
    await Promise.all(this.ctx.getWebSockets(ENDPOINT_SOCKET_TAG).map((socket) => this.authorizeSocket(socket)));
    await this.closeServiceSessions(await this.serviceSessions.sweep());
    for (const [requestId, pending] of this.pendingTunnels) if (pending.session) await this.serviceTunnelAuthorized(requestId, pending);
    for (const socket of this.ctx.getWebSockets(SERVICE_SOCKET_TAG)) {
      const service = serviceSocketAttachment(socket);
      if (service) await this.serviceSocketAuthorized(socket, service);
    }
    if (this.presenceCheckAt !== null && this.presenceCheckAt <= Date.now()) {
      this.presenceCheckAt = null;
      await this.sweepPresence();
    }
    for (const { machine_id: machineId } of this.ctx.storage.sql.exec<{ machine_id: string }>('SELECT machine_id FROM presence_retries WHERE due_at<=?', Date.now()).toArray()) await this.reconcilePresence(machineId);
    await this.browserRelay.alarm().catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_share_alarm_failed', error: error instanceof Error ? error.message : String(error) })));
    await this.scheduleAlarm();
  }

  /** The earliest deadline any work names: a service session's or ticket's expiry, a machine grant's expiry, the
   * heartbeat lease of a machine carrying a tunnel or service WebSocket, the presence check after a restart, a failed
   * presence report's next try, and the browser relay's share deadlines. Null when nothing is due. */
  private async nextDeadline(): Promise<number | null> {
    let next = await this.serviceSessions.nextExpiry() ?? Infinity;
    for (const socket of this.ctx.getWebSockets(ENDPOINT_SOCKET_TAG)) {
      const attachment = this.socketAttachment(socket);
      if (socket.readyState !== 1 || attachment?.role !== 'machine') continue;
      if (attachment.machineGrant) next = Math.min(next, machineAuthorizationDeadline(attachment.machineGrant));
      if (this.carriesWork(socket, attachment)) next = Math.min(next, this.heartbeatExpiresAt(socket, attachment) ?? Infinity);
    }
    const retry = this.ctx.storage.sql.exec<{ due_at: number | null }>('SELECT MIN(due_at) AS due_at FROM presence_retries').one().due_at;
    next = Math.min(next, this.presenceCheckAt ?? Infinity, retry ?? Infinity, await this.browserRelay.nextDeadline() ?? Infinity);
    return Number.isFinite(next) ? next : null;
  }

  /** Arms the alarm at the next deadline, or clears it; an unchanged alarm is not written again. */
  private scheduleAlarm(): Promise<void> {
    const run = this.alarmLine.then(async () => {
      const next = await this.nextDeadline();
      const current = await this.ctx.storage.getAlarm();
      if (next === null) {
        if (current !== null) await this.ctx.storage.deleteAlarm();
        return;
      }
      const at = Math.max(Date.now() + 1, next);
      if (current !== at) await this.ctx.storage.setAlarm(at);
    });
    this.alarmLine = run.catch(() => {});
    return run;
  }

  /** Brings the alarm forward to `deadline` when it is earlier. Work that ends leaves the alarm alone: that wake finds
   * nothing due and arms the next deadline or none, so a short request costs no alarm writes beyond this one. */
  private armBy(deadline: number | undefined): Promise<void> {
    const run = this.alarmLine.then(async () => {
      if (deadline === undefined) return;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > deadline) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, deadline));
    });
    this.alarmLine = run.catch(() => {});
    return run;
  }

  /** A machine connection carries work while a tunnel request waits on it or a service WebSocket rides it. */
  private carriesWork(socket: WebSocket, attachment: RelaySocketAttachment): boolean {
    for (const pending of this.pendingTunnels.values()) if (pending.socket === socket) return true;
    return attachment.connectionId !== undefined && this.ctx.getWebSockets(`tunnel-connection:${attachment.connectionId}`).length > 0;
  }

  /** False, after closing the socket and reporting its machine, once its last answered ping is older than the lease. */
  private heartbeatLive(socket: WebSocket): boolean {
    const attachment = this.socketAttachment(socket);
    const heartbeatExpiresAt = attachment ? this.heartbeatExpiresAt(socket, attachment) : undefined;
    if (heartbeatExpiresAt === undefined || heartbeatExpiresAt > Date.now()) return true;
    if (socket.readyState !== 1) return false;
    this.logMachineSocketClose(socket, 1011, { check: 'heartbeat-expired' });
    this.failSocketTunnels(socket, new Error('Machine relay heartbeat expired; the host is reconnecting'));
    socket.close(1011, 'Machine relay heartbeat expired');
    this.ctx.waitUntil(this.socketGone(socket));
    return false;
  }

  /** Frames, tunnel traffic and alarms all recheck the isolate's cached registry; none calls the vault. */
  private async authorizeSocket(socket: WebSocket): Promise<boolean> {
    if (socket.readyState !== 1) return false;
    const attachment = this.socketAttachment(socket);
    if (attachment?.role === 'client') return true;
    if (!this.heartbeatLive(socket)) return false;
    if (!attachment?.machineGrant || attachment.machineGrant.grant.machineId !== attachment.id) {
      this.rejectMachineSocket(socket, { check: attachment?.machineGrant ? 'grant-machine-mismatch' : 'grant-missing' });
      return false;
    }
    const authorizedUntil = machineAuthorizationDeadline(attachment.machineGrant);
    const rejected = await currentMachineAuthority(this.env, attachment.machineGrant, 'space.control');
    const rejection = rejected ? await authorityRejection(rejected) : null;
    if (rejection || authorizedUntil <= Date.now() || socket.readyState !== 1) {
      this.rejectMachineSocket(socket, rejection
        ?? (authorizedUntil <= Date.now() ? { check: 'authorization-expired', authorizedUntil } : { check: 'socket-closed' }));
      return false;
    }
    return true;
  }

  private rejectMachineSocket(socket: WebSocket, detail: MachineSocketCloseDetail): void {
    this.logMachineSocketClose(socket, 1008, detail);
    this.failSocketTunnels(socket, new Error('Machine authorization expired or was revoked'));
    socket.close(1008, 'Machine authorization expired or was revoked');
    this.ctx.waitUntil(this.socketGone(socket));
  }

  /** A machine's pings are answered by the auto-response, whose last time extends its lease. Undefined for a machine
   * that sends no pings. */
  private heartbeatExpiresAt(socket: WebSocket, attachment: RelaySocketAttachment): number | undefined {
    if (attachment.heartbeatExpiresAt === undefined) return undefined;
    const answered = this.ctx.getWebSocketAutoResponseTimestamp(socket);
    return Math.max(attachment.heartbeatExpiresAt, answered === null ? 0 : answered.getTime() + RELAY_HEARTBEAT_LEASE_MS);
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
      heartbeatExpiresAt: isoTime(attachment?.heartbeatExpiresAt),
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
      ...(typeof raw?.heartbeatExpiresAt === 'number' ? { heartbeatExpiresAt: raw.heartbeatExpiresAt } : {}),
      ...(raw?.notices === true ? { notices: true } : {}),
      ...(typeof raw?.connectionId === 'string' ? { connectionId: raw.connectionId } : {}),
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
    if (url.pathname === '/__platform/storage') {
      if (request.headers.get('authorization') !== `Bearer ${env.PLATFORM_TOKEN}`) return jsonError(401, 'PROVIDER_UNAUTHORIZED', 'Provider storage authorization is required');
      if (request.method !== 'POST') return jsonError(405, 'METHOD_NOT_ALLOWED', 'Storage control requires POST');
      return platformStorageControl(request, env);
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
      // A declared route of a workspace URL admits signed callers by credential alone: no origin check, cookie or sign-in.
      const resolved = hostedServiceUrlKind(url.hostname) === 'workspace' ? await env.HOSTED_ROUTES.getByName(url.hostname).resolve(request.method, url.pathname) : undefined;
      if (resolved?.ingress && resolved.ingress.tenant === env.ACCOUNT_ID) return serveIngress(env, request, resolved.ingress, resolved);
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
      if (session) return fetchInternalService(env, session.caller, request, session, resolved);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return jsonError(401, 'SERVICE_LOGIN_REQUIRED', 'Open this service in the browser to approve access');
      const state = crypto.randomUUID();
      const approval = new URL('/service-access', env.ACCOUNT_URL);
      approval.searchParams.set('hostname', url.hostname);
      approval.searchParams.set('state', state);
      approval.searchParams.set('returnTo', safeServiceReturn(`${url.pathname}${url.search}`) ? `${url.pathname}${url.search}` : '/');
      return new Response(null, { status: 303, headers: { location: approval.href, 'cache-control': 'no-store', 'set-cookie': `${SERVICE_STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300` } });
    }
    if (url.pathname === '/api/browser-relay/extension') return env.RELAY.getByName(env.RELAY_NAME).fetch(request);
    // A short pairing code typed into your Chrome's extension popup: public, so the relay limits wrong codes per address
    // and per code; it answers the pairing's details once.
    if (url.pathname === '/api/browser-relay/pairing-code') {
      if (request.method !== 'POST' || !/^chrome-extension:\/\/[a-p]{32}$/u.test(request.headers.get('origin') ?? '')) return jsonError(403, 'ORIGIN_REJECTED', 'Chrome extension origin required');
      const text = Number(request.headers.get('content-length') ?? 0) > 1024 ? '' : await request.text();
      let raw: unknown = null;
      try { raw = JSON.parse(text); } catch { /* answered below as a missing code */ }
      const parsed = z.object({ code: z.string().max(64) }).safeParse(raw);
      if (!parsed.success) return jsonError(400, 'PAIRING_CODE_INVALID', 'A pairing code is required');
      const redeemed = await env.RELAY.getByName(env.RELAY_NAME).browserRelayRedeemPairingCode(parsed.data.code, request.headers.get('cf-connecting-ip') ?? '', new URL('/api/browser-relay/extension', env.ACCOUNT_URL).href.replace(/^http/u, 'ws'));
      return redeemed.ok ? Response.json({ status: 'ok', value: redeemed.value }) : jsonError(redeemed.status, redeemed.code, redeemed.message);
    }
    // Upload bytes (Inspector files, your Chrome's downloads and captures) go through upload links, outside RPC's base64
    // chunks and the relay WebSocket; your Chrome begins its uploads signed by its pairing key.
    if (url.pathname.startsWith(`${UPLOAD_LINK_PATH}/`)) return serveUploadLink(request, env, { relay: env.RELAY.getByName(env.RELAY_NAME), drive: identity => workspaceDrive(env, identity) });
    if (url.pathname === BROWSER_UPLOAD_PATH) return serveBrowserUpload(request, { relay: env.RELAY.getByName(env.RELAY_NAME), link: target => mintUploadLink(env, { kind: 'browser', ...target }) });
    // Share links: public, before device authority (a join signed by one of the account's devices is checked there).
    if (url.pathname === BROWSER_SHARE_PATH || url.pathname.startsWith('/api/shares/')) return serveBrowserShare(request, env);
    // Your Chrome's in-page comment tool, signed by its pairing key.
    if (url.pathname === BROWSER_COMMENT_PATH) {
      const read = await readBrowserSignedRequest(request, 'comment');
      return browserRouteReply(read.ok ? await env.RELAY.getByName(env.RELAY_NAME).browserRelayComment(read.request, read.body) : read);
    }
    // Your Chrome's popup adding a tab to a workspace, signed by its pairing key.
    if (url.pathname === BROWSER_WORKSPACES_PATH) {
      const read = await readBrowserSignedRequest(request, 'workspace');
      return browserRouteReply(read.ok ? await env.RELAY.getByName(env.RELAY_NAME).browserRelayWorkspaces(read.request, read.body) : read);
    }
    // Capture share links: public, before device authority (an open signed by one of the account's devices is checked there).
    if (url.pathname === BROWSER_CAPTURE_SHARE_PATH || url.pathname.startsWith('/api/capture-shares/')) return serveBrowserCaptureShare(request, env);
    // The Watch dialog's socket: a tab's live frames and, while you hold it from this device, your input.
    if (url.pathname === BROWSER_WATCH_PATH) return serveBrowserWatch(request, env);
    if (url.pathname === '/api/services/approve' || /^\/api\/browser-relay\/(pair|status|unpair|confirm|chrome|project-status|project-update|extension\.zip)$/u.test(url.pathname)) {
      if (request.method !== 'POST' || request.headers.get('origin') !== new URL(env.ACCOUNT_URL).origin) return jsonError(403, 'ORIGIN_REJECTED', 'Account origin required');
      const declared = request.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) return jsonError(400, 'REQUEST_LENGTH_INVALID', 'Invalid request content length');
      if (declared !== null && Number(declared) > REQUEST_MAX_BYTES) return jsonError(413, 'REQUEST_TOO_LARGE', 'Account request exceeds size limit');
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > REQUEST_MAX_BYTES) return jsonError(413, 'REQUEST_TOO_LARGE', 'Account request exceeds size limit');
      const mutatesPairing = /^\/api\/browser-relay\/(pair|unpair|confirm|chrome|project-update)$/u.test(url.pathname);
      const requiresWrite = mutatesPairing || url.pathname === '/api/services/approve';
      const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({
        header: request.headers.get('x-gitspace-device'), method: 'POST', target: `${url.pathname}${url.search}`, body,
        capabilities: [requiresWrite ? 'rpc.write' : 'rpc.read'], browserOnly: true, accountScope: true,
      }, now));
      if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === 'RPC_FORBIDDEN' ? 403 : auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401 });
      const relay = env.RELAY.getByName(env.RELAY_NAME);
      if (url.pathname.endsWith('/extension.zip')) return new Response(Uint8Array.from(browserRelayArchive(env.ACCOUNT_URL)), { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename=\"gitspace-browser-relay.zip\"', 'cache-control': 'no-store' } });
      if (url.pathname === '/api/services/approve') {
        const parsed = z.object({ hostname: z.string(), state: z.string().uuid(), returnTo: z.string() }).safeParse(JSON.parse(new TextDecoder().decode(body)));
        if (!parsed.success || !isHostedServiceHostname(env, parsed.data.hostname) || !safeServiceReturn(parsed.data.returnTo)) return jsonError(400, 'SERVICE_APPROVAL_INVALID', 'Invalid service approval');
        // A workspace URL whose machine is offline is still approvable, so the browser reaches its offline answer.
        const registry = env.HOSTED_ROUTES.getByName(parsed.data.hostname);
        const tenant = (await registry.get())?.tenant ?? (await registry.offline())?.tenant;
        if (tenant !== env.ACCOUNT_ID) return jsonError(404, 'SERVICE_ROUTE_NOT_FOUND', 'Service unavailable');
        const ticket = await relay.serviceApprove({ ...parsed.data, deviceId: auth.value.device.deviceId });
        return Response.json({ status: 'ok', value: { callback: `https://${parsed.data.hostname}/__gitspace/auth?ticket=${encodeURIComponent(ticket)}` } });
      }
      if (url.pathname.endsWith('/pair')) return Response.json({ status: 'ok', value: await relay.browserRelayPair(await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust()) });
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'ok', value: await relay.browserRelayStatus() });
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(body)); } catch { return jsonError(400, 'PAIRING_REQUEST_INVALID', 'Invalid browser pairing request'); }
      if (url.pathname.endsWith('/project-status') || url.pathname.endsWith('/project-update')) {
        const project = z.object({ projectId: z.string().min(1).max(256) }).safeParse(raw);
        if (!project.success) return jsonError(400, 'PROJECT_BROWSER_REQUEST_INVALID', 'Project identity is required');
        if (url.pathname.endsWith('/project-status')) return Response.json({ status: 'ok', value: await relay.browserRelayProjectSettings(project.data.projectId) });
        const update = z.object({ expectedRevision: z.number().int().nonnegative(), preferences: RuntimeProjectBrowserPreferencesSchema }).safeParse(raw);
        if (!update.success) return jsonError(400, 'PROJECT_BROWSER_REQUEST_INVALID', `Invalid project Chrome preferences: ${update.error.issues.map(issue => issue.message).join('; ')}`);
        try {
          const value = await relay.browserRelaySetProjectSettings(project.data.projectId, update.data.expectedRevision, update.data.preferences);
          return Response.json({ status: 'ok', value });
        } catch (error) {
          return jsonError(409, 'PROJECT_BROWSER_UPDATE_REJECTED', error instanceof Error ? error.message : 'Project Chrome update rejected');
        }
      }
      if (url.pathname.endsWith('/chrome')) {
        const change = z.object({ pairingId: z.string().uuid(), name: RuntimeBrowserNameSchema.optional(), note: RuntimeBrowserNoteSchema.optional() }).safeParse(raw);
        if (!change.success) return jsonError(400, 'PAIRING_REQUEST_INVALID', 'A paired browser and a valid name or note are required');
        try { return Response.json({ status: 'ok', value: await relay.browserRelaySetChrome(change.data.pairingId, { name: change.data.name, note: change.data.note }) }); }
        catch (error) { return jsonError(404, 'PAIRING_NOT_FOUND', error instanceof Error ? error.message : 'Unknown browser pairing'); }
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
      const auth = await withDeviceAuthority(env, (view, now) => view.authorizeMachineRelay(request.headers.get('authorization'), target, machineId, now));
      if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401 });
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
        // Admit identity only; the tunnel destination retains procedure and scope authorization.
        const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({
          header: request.headers.get('x-gitspace-device'), method: request.method, target: `${url.pathname}${url.search}`, body: null, capabilities: [], accountScope: false,
        }, now));
        if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401 });
        const declared = request.headers.get('content-length');
        if (declared === null && request.body !== null) return jsonError(411, 'REQUEST_LENGTH_REQUIRED', 'Tunnel uploads require Content-Length');
        if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) return jsonError(400, 'REQUEST_LENGTH_INVALID', 'Invalid tunnel content length');
        const length = declared === null ? 0 : Number(declared);
        if (length > TUNNEL_MAX_BODY_BYTES) return jsonError(413, 'REQUEST_TOO_LARGE', 'Tunnel uploads are limited to 64 MiB');
        bodyProof = { length, bodySha256: auth.value.bodySha256 };
        if (!request.body && (length !== 0 || auth.value.bodySha256 !== rpcBodySha256(new Uint8Array()))) return jsonError(400, 'REQUEST_BODY_MISMATCH', 'Tunnel body does not match its signed digest and declared length');
      } else {
        const rejected = request.headers.has(MACHINE_GRANT_HEADER) ? await authorizedMachineRequest(request, env, null) : authorizedRootRequest(request, env);
        if (rejected) return rejected;
      }
      const headers = new Headers(request.headers);
      for (const name of Object.keys(INTERNAL_HEADERS)) headers.delete(name);
      for (const name of ['x-forwarded-host', 'x-gitspace-service-assertion', 'x-gitspace-websocket-probe', 'x-gitspace-service-authorization']) headers.delete(name);
      return forwardTunnelRequest(new Request(request, { headers }), env, tunnel, bodyProof);
    }

    let rejected: Response | null;
    if (url.pathname === '/ws') {
      const role = url.searchParams.get('role');
      const id = url.searchParams.get('id');
      rejected = role === 'machine'
        ? await authorizedMachineRequest(request, env, id)
        : authorizedRootRequest(request, env);
    } else if (genericObject) {
      rejected = request.headers.has(MACHINE_GRANT_HEADER)
        ? await authorizedMachineRequest(request, env, null)
        : authorizedRootRequest(request, env);
    } else if (artifact) {
      rejected = await authorizedMachineRequest(request, env, null);
    } else {
      return application.fetch(request, env);
    }
    if (rejected) return rejected;

    if (genericObject) {
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
    if (artifact) return handleArtifactRequest(request, env, artifact[1]!);

    const headers = new Headers(request.headers);
    if (url.pathname === '/ws') {
      const parsed = socketAttachmentSchema.safeParse({ role: url.searchParams.get('role'), id: url.searchParams.get('id') });
      if (!parsed.success) return jsonError(400, 'INVALID_ENDPOINT', 'Invalid relay role or endpoint id');
      headers.set(INTERNAL_ROLE, parsed.data.role);
      headers.set(INTERNAL_ENDPOINT_ID, parsed.data.id);
    }

    return env.RELAY.getByName(env.RELAY_NAME).fetch(relayRequest(request, headers));
  },
} satisfies ExportedHandler<Env>;
