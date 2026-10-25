import { z } from 'zod';
import { deviceCanAdminister, DEVICE_SOCKET_PROTOCOL, socketProtocolProof } from '@gitspace/protocol';
import {
  RuntimeBrowserHolderSchema, RuntimeBrowserWatchClientMessageSchema, RuntimeIdentitySchema, RuntimeBrowserWatchQuerySchema, browserUnbase64,
  type RuntimeBrowserHolder, type RuntimeBrowserRemoteInput, type RuntimeBrowserWatchServerMessage,
} from '@gitspace/protocol-runtime';
import { remoteInputCommand } from '@gitspace/runtime-machine/browser-remote-input';
import { jpegSize } from '@gitspace/runtime-machine/browser-screencast';
import { accountAccessResponse, activeAccount } from './account-access.js';
import { closeOpenSocket, SHARE_PROTOCOL } from './browser-share.js';
import type { CdpBrowserShim, CdpEvent, CdpShimClient } from './browser-shim.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, deviceAuthority, withDeviceAuthority } from './device-authority.js';
import { requireWorkspaceAccess } from './runtime-access.js';

/**
 * The Watch dialog's socket (docs/APERTURE-DESIGN.md §7.1–7.2, `BROWSER_WATCH_PATH`): one of the account's signed-in
 * devices watches a workspace's tab live and, while it holds the tab, drives it. Never a share link: the route admits
 * only a device signature, and share viewers have no input at all.
 *
 * Your Chrome's tabs are watched in the relay object (`BrowserWatches`): the extension streams the tab's screencast as it
 * does for a share link (`shareWatch` under the watch's own id, `shareFrame` back) and dispatches your input
 * (`remoteInput`). The cloud browser's tabs are watched in its session object (`CloudWatch`), on a screencast and an
 * input client of its own. Both check, for every input, that you hold the tab from the device that sent it; the
 * extension checks it again. A tab's screencast stops when its last viewer leaves. Nothing typed is logged.
 */

/** Where the route hands a checked socket to the relay object or the cloud browser's session object, with who opened
 * it in `BROWSER_WATCH_VIEWER_HEADER`. Public requests never reach it: the public handler sends only `BROWSER_WATCH_PATH` here, through
 * `serveBrowserWatch`, and a cloud script's sandbox reaches its session object at `/script/` alone. */
export const BROWSER_WATCH_INTERNAL_PATH = '/internal/browser-watch';
export const BROWSER_WATCH_VIEWER_HEADER = 'x-gitspace-watch-viewer';
/** Who opened a watch socket, as the route checked it. `control`: the device may take over and drive tabs (what Stop,
 * Close tab and Focus in Chrome need: a browser administering the account that talks to agents). `protocol`: the
 * offered `Sec-WebSocket-Protocol` the upgrade answers with. */
const WatchViewer = z.object({ deviceId: z.string().min(1).max(256), control: z.boolean(), protocol: z.string().max(8192), query: RuntimeBrowserWatchQuerySchema });
type WatchViewer = z.infer<typeof WatchViewer>;
/** Every watch socket has this tag; the relay's also `browser-watch:<watchId>`, the cloud session's `browser-watch:<targetId>`. */
const WATCH_TAG = 'browser-watch';
/** Sockets watching one tab at most. */
const WATCH_VIEWERS = 8;
/** The largest frame asked for, in each dimension. */
const FRAME_MAX = 1280;
/** A pointer move reaches the tab at most this often per socket; presses, keys and touches always do. */
const MOVE_MS = 16;
/** How often a socket's device is checked again while it sends input: a revoked device's socket closes. */
const DEVICE_CHECK_MS = 60_000;
const MESSAGE_MAX = 4096;
const Size = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
type Size = z.infer<typeof Size>;
const TAKE_OVER_FIRST = 'Take over this tab to use it from here';
const NO_CONTROL = 'This device cannot drive tabs: use a browser signed in to manage this account';

function described(error: unknown) { return error instanceof Error ? error.message : String(error); }
function fail(status: number, code: string, message: string) { return Response.json({ status: 'error', error: { code, message } }, { status, headers: { 'cache-control': 'private, no-store' } }); }
function send(socket: WebSocket, message: RuntimeBrowserWatchServerMessage): void { if (socket.readyState === 1) socket.send(JSON.stringify(message)); }
/** The frame size for viewers' screen areas: the largest of them, at most `FRAME_MAX`, else `FRAME_MAX`. */
function frameSize(sizes: readonly Size[]): Size {
  return { width: Math.min(FRAME_MAX, Math.max(0, ...sizes.map(size => size.width)) || FRAME_MAX), height: Math.min(FRAME_MAX, Math.max(0, ...sizes.map(size => size.height)) || FRAME_MAX) };
}
/** One client message, or null for anything else. */
function clientMessage(data: string | ArrayBuffer) {
  if (typeof data !== 'string' || data.length > MESSAGE_MAX) return null;
  try { return RuntimeBrowserWatchClientMessageSchema.parse(JSON.parse(data)); } catch { return null; }
}
/** Whether this socket's input reaches the tab: its device may drive tabs and holds this one. */
function drives(viewer: { deviceId: string; control: boolean }, holder: RuntimeBrowserHolder | undefined): boolean {
  return viewer.control && holder?.holder === 'you' && holder.device === viewer.deviceId;
}

/**
 * `GET BROWSER_WATCH_PATH`, upgraded, from the account's own origin: the device's signature rides in
 * `Sec-WebSocket-Protocol` as on the directory socket. The device must read the workspace (its scope included); the
 * socket goes to the relay object for your Chrome, or to the workspace's cloud browser session.
 */
export async function serveBrowserWatch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'Watch with GET');
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'UPGRADE_REQUIRED', 'Expected a WebSocket');
  if (request.headers.get('origin') !== new URL(env.ACCOUNT_URL).origin) return fail(403, 'ORIGIN_REJECTED', 'Account origin required');
  const query = RuntimeBrowserWatchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return fail(400, 'BROWSER_WATCH_INVALID', 'A watch names its workspace, browser and tab');
  const offered = socketProtocolProof(request.headers.get('sec-websocket-protocol'), DEVICE_SOCKET_PROTOCOL);
  if (!offered) return fail(400, 'BROWSER_WATCH_INVALID', 'Watch authorization is missing');
  const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({ header: offered.proof, method: 'GET', target: `${url.pathname}${url.search}`, body: new Uint8Array(), capabilities: ['rpc.read'], accountScope: false }, now));
  if (auth.status === 'error') return fail(auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : auth.error.code === 'RPC_FORBIDDEN' ? 403 : 401, auth.error.code, auth.error.message);
  const { device } = auth.value, { projectId, workspaceId } = query.data;
  if ((device.scope.kind === 'project' && device.scope.projectId !== projectId) || (device.scope.kind === 'workspace' && device.scope.workspaceId !== workspaceId)) return fail(403, 'RPC_FORBIDDEN', 'Workspace is outside the device scope');
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  try { await requireWorkspaceAccess(env, env.ACCOUNT_ID, RuntimeIdentitySchema.parse({ projectId, workspaceId }), false); } catch (error) { return fail(404, 'WORKSPACE_UNAVAILABLE', described(error)); }
  const viewer: WatchViewer = { deviceId: device.deviceId, control: device.kind === 'browser' && deviceCanAdminister(device, 'account.admin') && device.capabilities.includes('session.prompt'), protocol: offered.protocol, query: query.data };
  const headers = new Headers(request.headers);
  headers.set(BROWSER_WATCH_VIEWER_HEADER, JSON.stringify(viewer));
  const forwarded = new Request(new URL(BROWSER_WATCH_INTERNAL_PATH, request.url), { method: 'GET', headers });
  return query.data.source === 'chrome' ? env.RELAY.getByName(env.RELAY_NAME).fetch(forwarded) : env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${projectId}:${workspaceId}`).fetch(forwarded);
}

/** The viewer the route checked, or null for a request that did not come through it. */
function checkedViewer(request: Request): WatchViewer | null {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null;
  try { return WatchViewer.parse(JSON.parse(request.headers.get(BROWSER_WATCH_VIEWER_HEADER) ?? 'null')); } catch { return null; }
}
/** Whether a device's grant still verifies; true while the device authority cannot say, so an outage closes nothing. */
export async function browserWatchDeviceActive(env: Env, deviceId: string): Promise<boolean> {
  const view = await deviceAuthority(env).current().catch(() => null);
  return !view || view.device(deviceId, Date.now()) !== null;
}
/** A socket's device, checked again now and then while it watches or sends input: a socket whose device no longer
 * verifies (revoked, expired) closes. */
class DeviceChecks {
  private readonly checked = new Map<string, number>();
  constructor(private readonly ctx: DurableObjectState, private readonly active: (deviceId: string) => Promise<boolean>) {}
  /** Called with each frame and input: the first starts the clock; one `DEVICE_CHECK_MS` later the device is checked
   * in the background, so nothing waits on it. */
  due(socket: WebSocket, socketId: string, deviceId: string): void {
    const now = Date.now(), last = this.checked.get(socketId);
    if (last !== undefined && now - last < DEVICE_CHECK_MS) return;
    this.checked.set(socketId, now);
    if (last === undefined) return;
    this.ctx.waitUntil(this.active(deviceId).then(active => { if (!active) closeOpenSocket(socket, 1008, 'Device authorization expired'); }, () => {}));
  }
  forget(socketId: string): void { this.checked.delete(socketId); }
}

const RelaySocket = z.object({ socketId: z.string().uuid(), watchId: z.string().uuid(), deviceId: z.string(), control: z.boolean(), pairingId: z.string().uuid(), groupId: z.string().uuid(), targetId: z.string(), size: Size.nullable() });
type RelaySocket = z.infer<typeof RelaySocket>;
const Watched = z.object({ url: z.string(), title: z.string(), width: z.number().positive(), height: z.number().positive() });
const HELD = 'browser.watch.held:';

/** What watches of your Chrome's tabs need from the relay object. */
export type BrowserWatchHost = {
  online(pairingId: string): boolean;
  /** The protocol the Chrome's extension last reported. */
  protocol(pairingId: string): Promise<number>;
  request(pairingId: string, command: Record<string, unknown>): Promise<unknown>;
  /** A workspace group neither revoked nor expired, with the Chrome it is on. */
  group(groupId: string): Promise<{ projectId: string; workspaceId: string; pairingId: string } | undefined>;
  /** Whether a viewer's device still verifies (`browserWatchDeviceActive`). */
  deviceActive(deviceId: string): Promise<boolean>;
};

/** Watches of your Chrome's tabs, in the relay object: viewer sockets, the tabs' holders as the extension reports them,
 * frames out and input in. Each watched tab has one watch id, shared by its viewers, under which the extension streams. */
export class BrowserWatches {
  /** The frame size each watch last asked of its extension; forgotten when its Chrome disconnects. */
  private readonly watching = new Map<string, Size>();
  /** The tabs you hold in each group, as its Chrome last reported them (also in storage, for after hibernation). */
  private readonly held = new Map<string, RuntimeBrowserHolder[]>();
  private readonly moves = new Map<string, number>();
  private readonly devices: DeviceChecks;
  constructor(private readonly ctx: DurableObjectState, private readonly host: BrowserWatchHost) { this.devices = new DeviceChecks(ctx, deviceId => host.deviceActive(deviceId)); }

  owns(socket: WebSocket) { return this.ctx.getTags(socket).includes(WATCH_TAG); }
  /** Whether frames and events under this id are a watch's (else they are a share's). */
  has(watchId: string) { return this.ctx.getWebSockets(`${WATCH_TAG}:${watchId}`).length > 0; }

  /** A socket the route checked (`BROWSER_WATCH_INTERNAL_PATH`): a live group of the workspace, on its Chrome. */
  async accept(request: Request): Promise<Response> {
    const viewer = checkedViewer(request);
    if (!viewer || viewer.query.source !== 'chrome') return new Response('Unknown watch', { status: 400 });
    const { query } = viewer, group = await this.host.group(query.groupId);
    if (!group || group.projectId !== query.projectId || group.workspaceId !== query.workspaceId) return new Response('This workspace has no live Chrome group with that id', { status: 404 });
    const tab = this.sockets().filter(({ state }) => state.pairingId === group.pairingId && state.targetId === query.targetId);
    if (tab.length >= WATCH_VIEWERS) return new Response('Too many viewers of this tab', { status: 429 });
    const [client, socket] = Object.values(new WebSocketPair());
    const state: RelaySocket = { socketId: crypto.randomUUID(), watchId: tab[0]?.state.watchId ?? crypto.randomUUID(), deviceId: viewer.deviceId, control: viewer.control, pairingId: group.pairingId, groupId: query.groupId, targetId: query.targetId, size: null };
    socket.serializeAttachment(state);
    this.ctx.acceptWebSocket(socket, [WATCH_TAG, `${WATCH_TAG}:${state.watchId}`]);
    send(socket, { type: 'presence', online: this.host.online(group.pairingId) });
    send(socket, this.control(state, await this.holders(state.groupId)));
    // The tab streams once the upgrade is answered.
    this.ctx.waitUntil(this.watch(state.watchId));
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': viewer.protocol } });
  }

  /** A viewer's message: its screen area, or input for the tab, which goes on only while this device holds it. */
  async message(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const state = RelaySocket.parse(socket.deserializeAttachment()), message = clientMessage(data);
    if (!message) return closeOpenSocket(socket, 1008, 'Invalid watch message');
    if (message.type === 'size') { socket.serializeAttachment({ ...state, size: { width: message.width, height: message.height } } satisfies RelaySocket); return this.watch(state.watchId); }
    if (message.type === 'mouse' && message.event === 'move') {
      const now = Date.now();
      if (now - (this.moves.get(state.socketId) ?? 0) < MOVE_MS) return;
      this.moves.set(state.socketId, now);
    }
    // Held in memory once read, so inputs reach the extension in the order they came.
    const holder = (this.held.get(state.groupId) ?? await this.holders(state.groupId)).find(held => held.targetId === state.targetId);
    if (!drives(state, holder)) return send(socket, { type: 'error', message: state.control ? TAKE_OVER_FIRST : NO_CONTROL });
    if (!this.host.online(state.pairingId)) return send(socket, { type: 'error', message: 'This Chrome is offline' });
    this.devices.due(socket, state.socketId, state.deviceId);
    this.input(socket, state, message);
  }

  private input(socket: WebSocket, state: RelaySocket, input: RuntimeBrowserRemoteInput): void {
    this.host.request(state.pairingId, { operation: 'remoteInput', groupId: state.groupId, targetId: state.targetId, device: state.deviceId, input })
      .catch((error: unknown) => send(socket, { type: 'error', message: `Your input did not reach the tab: ${described(error)}`.slice(0, 1024) }));
  }

  /** A viewer left: the tab streams at the size those left need, or stops. */
  async closed(socket: WebSocket): Promise<void> {
    const state = RelaySocket.safeParse(socket.deserializeAttachment());
    if (!state.success) return;
    this.moves.delete(state.data.socketId);
    this.devices.forget(state.data.socketId);
    await this.watch(state.data.watchId, socket);
  }

  /** A frame from the Chrome, for the watch's viewers on that Chrome. */
  frame(pairingId: string, frame: { shareId: string; data: string; width: number; height: number }): void {
    const text = JSON.stringify({ type: 'frame', data: frame.data, width: frame.width, height: frame.height } satisfies RuntimeBrowserWatchServerMessage);
    for (const { socket, state } of this.sockets(frame.shareId)) if (state.pairingId === pairingId) { socket.send(text); this.devices.due(socket, state.socketId, state.deviceId); }
  }

  /** The watched tab closed (`share` `closed`) or its page changed. */
  event(pairingId: string, event: { shareId: string; event: string; url?: string; title?: string; width?: number; height?: number }): void {
    const viewers = this.sockets(event.shareId).filter(({ state }) => state.pairingId === pairingId);
    if (event.event === 'closed') return this.end(viewers, 'closed');
    const page = Watched.safeParse(event);
    if (event.event === 'page' && page.success) for (const { socket } of viewers) send(socket, { type: 'page', url: page.data.url.slice(0, 8192), title: page.data.title.slice(0, 500), width: Math.max(1, Math.round(page.data.width)), height: Math.max(1, Math.round(page.data.height)) });
  }

  /** A group's tabs you hold, as its Chrome reported them now (extensions from 5.10): each viewer of the group learns
   * who holds its tab and whether its input reaches it. */
  async reported(pairingId: string, groupId: string, held: readonly RuntimeBrowserHolder[] | undefined): Promise<void> {
    if (!held) return;
    const previous = this.held.get(groupId) ?? await this.holders(groupId);
    if (JSON.stringify(previous) === JSON.stringify(held) || (await this.host.group(groupId))?.pairingId !== pairingId) return;
    this.held.set(groupId, [...held]);
    await (held.length ? this.ctx.storage.put(`${HELD}${groupId}`, held) : this.ctx.storage.delete(`${HELD}${groupId}`));
    for (const { socket, state } of this.sockets()) if (state.groupId === groupId) send(socket, this.control(state, held));
  }

  /** A Chrome said hello: its viewers see it online, and its watches stream again. */
  async online(pairingId: string): Promise<void> {
    const ids = new Set<string>();
    for (const { socket, state } of this.sockets()) if (state.pairingId === pairingId) { send(socket, { type: 'presence', online: true }); ids.add(state.watchId); }
    for (const watchId of ids) { this.watching.delete(watchId); await this.watch(watchId); }
  }

  /** A Chrome disconnected: its viewers see it offline; its watches are asked again when it is back. */
  offline(pairingId: string): void {
    for (const { socket, state } of this.sockets()) if (state.pairingId === pairingId) { this.watching.delete(state.watchId); send(socket, { type: 'presence', online: false }); }
  }

  /** A workspace group ended, or its Chrome was unpaired: its viewers are told and disconnected. */
  endGroup(groupId: string): void { this.end(this.sockets().filter(({ state }) => state.groupId === groupId), 'ended'); this.held.delete(groupId); this.ctx.waitUntil(this.ctx.storage.delete(`${HELD}${groupId}`)); }
  endPairing(pairingId: string): void { this.end(this.sockets().filter(({ state }) => state.pairingId === pairingId), 'ended'); }

  /** Asks the extension for the watch's frames at the largest viewer's size, or to stop once nobody watches. */
  private async watch(watchId: string, gone?: WebSocket): Promise<void> {
    const viewers = this.sockets(watchId, gone), first = viewers[0]?.state;
    if (!first) {
      const pairingId = gone ? RelaySocket.safeParse(gone.deserializeAttachment()).data?.pairingId : undefined;
      this.watching.delete(watchId);
      if (pairingId && this.host.online(pairingId)) await this.host.request(pairingId, { operation: 'shareUnwatch', shareId: watchId }).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_watch_unwatch_failed', error: described(error) })));
      return;
    }
    const size = frameSize(viewers.flatMap(({ state }) => state.size ? [state.size] : [])), asked = this.watching.get(watchId);
    if ((asked && asked.width === size.width && asked.height === size.height) || !this.host.online(first.pairingId)) return;
    if (await this.host.protocol(first.pairingId) < SHARE_PROTOCOL) { for (const { socket } of viewers) send(socket, { type: 'error', message: 'Update the GitSpace extension in this Chrome to watch its tabs live' }); return; }
    this.watching.set(watchId, size);
    try {
      const page = Watched.parse(await this.host.request(first.pairingId, { operation: 'shareWatch', shareId: watchId, targetId: first.targetId, maxWidth: size.width, maxHeight: size.height, reportPointer: false }));
      for (const { socket } of this.sockets(watchId)) send(socket, { type: 'page', url: page.url.slice(0, 8192), title: page.title.slice(0, 500), width: Math.max(1, Math.round(page.width)), height: Math.max(1, Math.round(page.height)) });
    } catch (error) {
      this.watching.delete(watchId);
      for (const { socket } of this.sockets(watchId)) send(socket, { type: 'error', message: `This tab cannot be shown: ${described(error)}`.slice(0, 1024) });
    }
  }

  private control(state: RelaySocket, held: readonly RuntimeBrowserHolder[]): RuntimeBrowserWatchServerMessage {
    const holder = held.find(item => item.targetId === state.targetId);
    return { type: 'control', holder: holder ?? null, input: drives(state, holder) };
  }

  private async holders(groupId: string): Promise<RuntimeBrowserHolder[]> {
    const kept = this.held.get(groupId);
    if (kept) return kept;
    const stored = z.array(RuntimeBrowserHolderSchema).catch([]).parse(await this.ctx.storage.get(`${HELD}${groupId}`) ?? []);
    this.held.set(groupId, stored);
    return stored;
  }

  private end(viewers: readonly { socket: WebSocket }[], reason: 'closed' | 'ended'): void {
    for (const { socket } of viewers) { send(socket, { type: 'ended', reason }); closeOpenSocket(socket, 1000, 'Watch ended'); }
  }

  /** Open watch sockets, of one watch or all; `gone` is one closing now. */
  private sockets(watchId?: string, gone?: WebSocket): { socket: WebSocket; state: RelaySocket }[] {
    const open: { socket: WebSocket; state: RelaySocket }[] = [];
    for (const socket of this.ctx.getWebSockets(watchId ? `${WATCH_TAG}:${watchId}` : WATCH_TAG)) {
      const state = RelaySocket.safeParse(socket.deserializeAttachment());
      if (socket !== gone && socket.readyState === 1 && state.success) open.push({ socket, state: state.data });
    }
    return open;
  }
}

const CloudSocket = z.object({ socketId: z.string().uuid(), deviceId: z.string(), control: z.boolean(), targetId: z.string(), size: Size.nullable() });
type CloudSocket = z.infer<typeof CloudSocket>;
/** A cloud tab's screencast for its viewers, on a client of its own: the newest frame waits for its turn
 * (`CLOUD_FRAME_MS`), and the tab's viewport turns input positions into pixels. */
type Screencast = { client: CdpShimClient; sessionId: string | null; size: Size; viewport: Size | null; page: { url: string; title: string } | null; pending: { data: string } | null; waiting: boolean };
/** A cloud tab's frames go to its viewers at most this often (4 a second), the newest when they come faster. */
const CLOUD_FRAME_MS = 250;
const CLOUD_FRAME_QUALITY = 60;
/** Input tells the session it is used at most this often. */
const USED_MS = 30_000;
const TargetInfo = z.object({ targetInfo: z.object({ targetId: z.string(), url: z.string(), title: z.string() }) });
const Frame = z.object({ data: z.string(), sessionId: z.number(), metadata: z.object({ deviceWidth: z.number().optional(), deviceHeight: z.number().optional() }).optional() });

/** What watches of cloud tabs need from the cloud browser's session object. */
export type CloudWatchHost = {
  /** The open browser; undefined while none is open. A watch never opens one. */
  browser(): Promise<CdpBrowserShim> | undefined;
  holder(targetId: string): RuntimeBrowserHolder | undefined;
  /** Your input uses the browser: it does not close as idle meanwhile. Watching alone does not count. */
  used(): void;
  /** Whether a viewer's device still verifies (`browserWatchDeviceActive`). */
  deviceActive(deviceId: string): Promise<boolean>;
};

/** Watches of the cloud browser's tabs, in its session object. */
export class CloudWatch {
  private readonly casts = new Map<string, Screencast>();
  /** Changes to a tab's screencast run one at a time. */
  private readonly changes = new Map<string, Promise<void>>();
  private readonly moves = new Map<string, number>();
  private readonly devices: DeviceChecks;
  private usedAt = 0;
  constructor(private readonly ctx: DurableObjectState, private readonly host: CloudWatchHost) { this.devices = new DeviceChecks(ctx, deviceId => host.deviceActive(deviceId)); }

  owns(socket: WebSocket) { return this.ctx.getTags(socket).includes(WATCH_TAG); }

  /** A socket the route checked: a tab of the open cloud browser. With no browser open there is nothing to watch, and
   * none is opened to show it: the socket hears that the browser ended. Opening it is not use of the browser. */
  async accept(request: Request): Promise<Response> {
    const viewer = checkedViewer(request);
    if (!viewer || viewer.query.source !== 'cloud') return new Response('Unknown watch', { status: 400 });
    const { targetId } = viewer.query;
    if (this.sockets(targetId).length >= WATCH_VIEWERS) return new Response('Too many viewers of this tab', { status: 429 });
    const [client, socket] = Object.values(new WebSocketPair());
    const state: CloudSocket = { socketId: crypto.randomUUID(), deviceId: viewer.deviceId, control: viewer.control, targetId, size: null };
    socket.serializeAttachment(state);
    this.ctx.acceptWebSocket(socket, [WATCH_TAG, `${WATCH_TAG}:${targetId}`]);
    send(socket, this.control(state));
    this.ctx.waitUntil(this.watch(targetId));
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': viewer.protocol } });
  }

  async message(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const state = CloudSocket.parse(socket.deserializeAttachment()), message = clientMessage(data);
    if (!message) return closeOpenSocket(socket, 1008, 'Invalid watch message');
    if (message.type === 'size') { socket.serializeAttachment({ ...state, size: { width: message.width, height: message.height } } satisfies CloudSocket); return this.watch(state.targetId); }
    if (message.type === 'mouse' && message.event === 'move') {
      const now = Date.now();
      if (now - (this.moves.get(state.socketId) ?? 0) < MOVE_MS) return;
      this.moves.set(state.socketId, now);
    }
    if (!drives(state, this.host.holder(state.targetId))) return send(socket, { type: 'error', message: state.control ? TAKE_OVER_FIRST : NO_CONTROL });
    const cast = this.casts.get(state.targetId);
    if (!cast?.sessionId || !cast.viewport) return send(socket, { type: 'error', message: 'The tab is not showing yet' });
    this.devices.due(socket, state.socketId, state.deviceId);
    if (Date.now() - this.usedAt >= USED_MS) { this.usedAt = Date.now(); this.host.used(); }
    const command = remoteInputCommand(message, cast.viewport);
    cast.client.send(command.method, command.params, cast.sessionId).catch((error: unknown) => send(socket, { type: 'error', message: `Your input did not reach the tab: ${described(error)}`.slice(0, 1024) }));
  }

  async closed(socket: WebSocket): Promise<void> {
    const state = CloudSocket.safeParse(socket.deserializeAttachment());
    if (!state.success) return;
    this.moves.delete(state.data.socketId);
    this.devices.forget(state.data.socketId);
    await this.watch(state.data.targetId, socket);
  }

  /** A tab's holder changed (take over, hand back, idle close): its viewers learn whether their input reaches it. */
  holderChanged(targetId: string): void {
    for (const { socket, state } of this.sockets(targetId)) send(socket, this.control(state));
  }

  /** The browser closed (`idle`: nobody used it for the idle time): every viewer hears so and is disconnected; their
   * screencasts went with it. */
  browserClosed(reason: 'idle' | 'ended'): void {
    this.casts.clear();
    this.end(this.sockets(), reason);
  }

  private watch(targetId: string, gone?: WebSocket): Promise<void> {
    const change = (this.changes.get(targetId) ?? Promise.resolve()).then(() => this.update(targetId, gone)).catch((error: unknown) => {
      for (const { socket } of this.sockets(targetId)) send(socket, { type: 'error', message: `This tab cannot be shown: ${described(error)}`.slice(0, 1024) });
    });
    this.changes.set(targetId, change);
    void change.finally(() => { if (this.changes.get(targetId) === change) this.changes.delete(targetId); });
    return change;
  }

  /** Starts the tab's screencast at the largest viewer's size, starts it again at a new size, or stops it once nobody
   * watches (its client lets the tab go, which ends the screencast). */
  private async update(targetId: string, gone?: WebSocket): Promise<void> {
    const viewers = this.sockets(targetId, gone), cast = this.casts.get(targetId);
    if (!viewers.length) {
      if (cast) { this.casts.delete(targetId); await cast.client.close(); }
      return;
    }
    const browser = this.host.browser();
    if (!browser) return this.end(viewers, 'ended');
    const size = frameSize(viewers.flatMap(({ state }) => state.size ? [state.size] : []));
    if (cast) {
      if (cast.sessionId && (cast.size.width !== size.width || cast.size.height !== size.height)) {
        cast.size = size;
        await cast.client.send('Page.startScreencast', { format: 'jpeg', quality: CLOUD_FRAME_QUALITY, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }, cast.sessionId);
      }
      return;
    }
    const shim = await browser;
    const started: Screencast = { client: shim.client(event => this.event(targetId, started, event)), sessionId: null, size, viewport: null, page: null, pending: null, waiting: false };
    this.casts.set(targetId, started);
    try {
      const info = TargetInfo.parse(await started.client.send('Target.getTargetInfo', { targetId })).targetInfo;
      started.page = { url: info.url, title: info.title };
      // Target events tell this client the tab's new address and title, and that it closed.
      await started.client.send('Target.setDiscoverTargets', { discover: true });
      started.sessionId = z.object({ sessionId: z.string() }).parse(await started.client.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      await started.client.send('Page.startScreencast', { format: 'jpeg', quality: CLOUD_FRAME_QUALITY, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }, started.sessionId);
    } catch (error) {
      if (this.casts.get(targetId) === started) this.casts.delete(targetId);
      await started.client.close();
      if (/No target|not found/iu.test(described(error))) return this.end(this.sockets(targetId), 'closed');
      throw error;
    }
  }

  private event(targetId: string, cast: Screencast, event: CdpEvent): void {
    if (this.casts.get(targetId) !== cast) return;
    if (event.method === 'disconnected') return this.browserClosed('ended');
    if (event.method === 'Page.screencastFrame' && event.sessionId === cast.sessionId) {
      const frame = Frame.safeParse(event.params);
      if (!frame.success) return;
      void cast.client.send('Page.screencastFrameAck', { sessionId: frame.data.sessionId }, cast.sessionId).catch(() => {});
      const { deviceWidth, deviceHeight } = frame.data.metadata ?? {};
      if (deviceWidth && deviceHeight && (cast.viewport?.width !== Math.round(deviceWidth) || cast.viewport.height !== Math.round(deviceHeight))) {
        cast.viewport = { width: Math.max(1, Math.round(deviceWidth)), height: Math.max(1, Math.round(deviceHeight)) };
        this.page(targetId, cast);
      }
      cast.pending = { data: frame.data.data };
      if (!cast.waiting) this.sendFrame(targetId, cast);
      return;
    }
    const info = TargetInfo.safeParse(event.params);
    if (event.method === 'Target.targetInfoChanged' && info.success && info.data.targetInfo.targetId === targetId) { cast.page = { url: info.data.targetInfo.url, title: info.data.targetInfo.title }; this.page(targetId, cast); return; }
    const gone = (event.method === 'Target.targetDestroyed' && event.params?.targetId === targetId) || (event.method === 'Target.detachedFromTarget' && cast.sessionId !== null && event.params?.sessionId === cast.sessionId);
    if (gone) { this.casts.delete(targetId); void cast.client.close(); this.end(this.sockets(targetId), 'closed'); }
  }

  /** Sends the tab's newest frame with its image size, then waits `CLOUD_FRAME_MS` before the next. */
  private sendFrame(targetId: string, cast: Screencast): void {
    cast.waiting = false;
    if (this.casts.get(targetId) !== cast || !cast.pending) return;
    const { data } = cast.pending;
    cast.pending = null;
    const size = data.length <= 1_500_000 ? jpegSize(browserUnbase64(data.slice(0, 4096))) : null;
    if (size) {
      const text = JSON.stringify({ type: 'frame', data, width: size.width, height: size.height } satisfies RuntimeBrowserWatchServerMessage);
      for (const { socket, state } of this.sockets(targetId)) { socket.send(text); this.devices.due(socket, state.socketId, state.deviceId); }
    }
    cast.waiting = true;
    setTimeout(() => this.sendFrame(targetId, cast), CLOUD_FRAME_MS);
  }

  private page(targetId: string, cast: Screencast): void {
    if (!cast.page || !cast.viewport) return;
    for (const { socket } of this.sockets(targetId)) send(socket, { type: 'page', url: cast.page.url.slice(0, 8192), title: cast.page.title.slice(0, 500), ...cast.viewport });
  }

  private control(state: CloudSocket): RuntimeBrowserWatchServerMessage {
    const holder = this.host.holder(state.targetId);
    return { type: 'control', holder: holder ?? null, input: drives(state, holder) };
  }

  private end(viewers: readonly { socket: WebSocket }[], reason: 'closed' | 'ended' | 'idle'): void {
    for (const { socket } of viewers) { send(socket, { type: 'ended', reason }); closeOpenSocket(socket, 1000, 'Watch ended'); }
  }

  private sockets(targetId?: string, gone?: WebSocket): { socket: WebSocket; state: CloudSocket }[] {
    const open: { socket: WebSocket; state: CloudSocket }[] = [];
    for (const socket of this.ctx.getWebSockets(targetId ? `${WATCH_TAG}:${targetId}` : WATCH_TAG)) {
      const state = CloudSocket.safeParse(socket.deserializeAttachment());
      if (socket !== gone && socket.readyState === 1 && state.success) open.push({ socket, state: state.data });
    }
    return open;
  }
}
