import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, DEVICE_SOCKET_PROTOCOL, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import {
  BROWSER_WATCH_PATH, RuntimeAccountBrowserAuthorizationSchema, RuntimeBrowserWatchServerMessageSchema, browserBase64, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate,
  type RuntimeAccountBrowserPlacement, type RuntimeBrowserHolder, type RuntimeBrowserRemoteInput, type RuntimeBrowserWatchServerMessage,
} from '@gitspace/protocol-runtime';
import { BrowserSessionDO } from '../src/browser-session.js';
import { BROWSER_WATCH_INTERNAL_PATH, BROWSER_WATCH_VIEWER_HEADER } from '../src/browser-watch.js';
import type { UserRelayDO } from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Device = { deviceId: string; key: Uint8Array };
type Kind = RuntimeBrowserWatchServerMessage['type'];
const MessageSchema = z.object({ id: z.number().optional(), operation: z.string().optional() }).catchall(z.unknown());
type Message = z.infer<typeof MessageSchema>;
/** Someone in the Watch dialog: what the socket told them, and the next message of a kind. */
type Viewer = { socket: WebSocket; received: RuntimeBrowserWatchServerMessage[]; next<T extends Kind>(type: T): Promise<Extract<RuntimeBrowserWatchServerMessage, { type: T }>> };
const origin = 'https://test.gitspace.sh', encoder = new TextEncoder();
const page = { url: 'https://example.com/docs', title: 'Docs' };
const click: RuntimeBrowserRemoteInput = { type: 'mouse', event: 'down', x: 0.5, y: 0.25, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 };
afterEach(() => { vi.useRealTimers(); });

async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
/** A JPEG's frame header for a `width`×`height` image: enough for its size to be read. */
function jpeg(width: number, height: number) { return browserBase64(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0xff, 0xd9])); }
/** Waits for messages matching `type` in arrival order, each handed out once. */
function waiter<T>(received: T[], matches: (message: T, type: string) => boolean) {
  const taken = new Set<number>(), waiting: { type: string; resolve(message: T): void }[] = [];
  const deliver = () => {
    for (const wait of [...waiting]) {
      const index = received.findIndex((message, position) => !taken.has(position) && matches(message, wait.type)), message = received[index];
      if (index < 0 || message === undefined) continue;
      taken.add(index); waiting.splice(waiting.indexOf(wait), 1); wait.resolve(message);
    }
  };
  return { deliver, next: (type: string) => new Promise<T>(resolve => { waiting.push({ type, resolve }); deliver(); }) };
}
/** Narrows what a watch socket said to one kind of message. */
function isKind<T extends Kind>(message: RuntimeBrowserWatchServerMessage, type: T): message is Extract<RuntimeBrowserWatchServerMessage, { type: T }> { return message.type === type; }
/** Reads what a watch socket says. */
function viewer(socket: WebSocket): Viewer {
  const received: RuntimeBrowserWatchServerMessage[] = [], messages = waiter(received, (message, type) => message.type === type);
  socket.addEventListener('message', event => { received.push(RuntimeBrowserWatchServerMessageSchema.parse(JSON.parse(String(event.data)))); messages.deliver(); });
  socket.accept();
  return { socket, received, next: async type => { const message = await messages.next(type); if (!isKind(message, type)) throw new Error(`Expected ${type}`); return message; } };
}

/** A project with one workspace, and the account's vault. */
async function workspace() {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Watch', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { projectId, workspaceId };
}
/** One of the account's signed-in browsers, as GitSpace enrolls it. */
async function device(label: string): Promise<Device> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write', 'session.prompt'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: `${origin}/v1/devices/enroll` }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label, boundAt: Date.now(), signingPrivateKey: key });
  expect(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  return { deviceId: binding.deviceId, key };
}
/** The Watch dialog's socket through the account's public route, signed by `signer` (none: unsigned). */
async function watch(query: Record<string, string>, signer: Device | null) {
  const path = `${BROWSER_WATCH_PATH}?${new URLSearchParams(query)}`;
  const proof = signer ? signRpcRequest({ deviceId: signer.deviceId, signingPrivateKey: signer.key, method: 'GET', path, body: new Uint8Array() }) : null;
  return exports.default.fetch(new Request(`${origin}${path}`, { headers: { upgrade: 'websocket', origin, ...(proof ? { 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${proof}` } : {}) } }));
}

/** A paired Chrome, confirmed and approved for the project, whose extension answers commands with `answer`. */
async function chrome(relay: UserRelayDO, root: Identity, projectId: string, answer: (message: Message) => unknown) {
  const redeemed = await relay.browserRelayRedeemPairingCode((await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey })).code, '198.51.100.1', 'wss://account.test/api/browser-relay/extension');
  if (!redeemed.ok) throw new Error(redeemed.message);
  const pairing = redeemed.value;
  const socket = (await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': '192.0.2.61' } }))).webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, encoder.encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/131.0.0.0', protocol: 6, takeover: true })); await ready;
  const received: Message[] = [], operations = waiter(received, (message, operation) => message.operation === operation);
  socket.addEventListener('message', event => {
    const message = MessageSchema.parse(JSON.parse(String(event.data)));
    received.push(message); operations.deliver();
    if (typeof message.id !== 'number') return;
    const { id } = message;
    const reply = (value: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, ...value })); };
    void Promise.resolve().then(() => message.operation === 'tabs' ? [] : answer(message)).then(result => reply({ result: result ?? {} }), (error: unknown) => reply({ error: { message: error instanceof Error ? error.message : String(error) } }));
  });
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  const settings = await relay.browserRelayProjectSettings(projectId);
  await relay.browserRelaySetProjectSettings(projectId, settings.revision, { defaultPairingId: pairing.pairingId, approvals: [{ pairingId: pairing.pairingId }] });
  return { socket, received, placement: await relay.browserRelayPlacement(projectId, pairing.pairingId), next: operations.next };
}
/** A step on the Chrome, signed by the workspace: its group now exists there. */
async function group(relay: UserRelayDO, root: Identity, placement: RuntimeAccountBrowserPlacement, projectId: string, workspaceId: string) {
  if (placement.kind !== 'account-relay') throw new Error('Expected a Chrome placement');
  const signer = await keys(), expiresAt = new Date(Date.now() + 60_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: signer.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, signer.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  const signed = await signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: placement.pairingId }, grant } }, signer.key.privateKey, authority);
  expect((await relay.browserRelayExecute(signed)).status).toBe('completed');
  return grant.body.groupId;
}

test('your Chrome’s tab in the Watch dialog: frames go to your signed-in devices, your input only from the device holding the tab, and the screencast stops when the last viewer leaves', async () => {
  const { projectId, workspaceId } = await workspace();
  const laptop = await device('Laptop'), phone = await device('Phone');
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, message => message.operation === 'shareWatch' ? { ...page, width: 1280, height: 800 } : {});
    try {
      if (!browser.placement) throw new Error('Expected an approved Chrome');
      const groupId = await group(relay, root, browser.placement, projectId, workspaceId);
      const query = { source: 'chrome', projectId, workspaceId, groupId, targetId: 'tab-1' };
      // Nothing opens without a device's signature: no share link or token reaches a tab this way.
      expect((await watch(query, null)).status).toBe(400);
      const response = await watch(query, laptop);
      expect(response.headers.get('sec-websocket-protocol')).toMatch(new RegExp(`^${DEVICE_SOCKET_PROTOCOL.replace('.', '\\.')}`, 'u'));
      if (!response.webSocket) throw new Error(`No watch socket (${response.status})`);
      const onLaptop = viewer(response.webSocket);
      expect(await onLaptop.next('control')).toEqual({ type: 'control', holder: null, input: false });
      const watched = await browser.next('shareWatch');
      expect(watched).toMatchObject({ targetId: 'tab-1', maxWidth: 1280, maxHeight: 1280, reportPointer: false });
      const watchId = z.string().uuid().parse(watched.shareId);
      expect(await onLaptop.next('page')).toEqual({ type: 'page', ...page, width: 1280, height: 800 });
      browser.socket.send(JSON.stringify({ shareFrame: { shareId: watchId, data: 'AAAA', width: 32, height: 16 } }));
      expect(await onLaptop.next('frame')).toEqual({ type: 'frame', data: 'AAAA', width: 32, height: 16 });

      // While the agent holds the tab, input reaches nothing.
      onLaptop.socket.send(JSON.stringify(click));
      expect(await onLaptop.next('error')).toEqual({ type: 'error', message: 'Take over this tab to use it from here' });
      const onPhoneSocket = (await watch(query, phone)).webSocket;
      if (!onPhoneSocket) throw new Error('No watch socket for the phone');
      const onPhone = viewer(onPhoneSocket);
      await onPhone.next('control');
      // You took it over from the laptop: the Chrome reports it at once, and each viewer learns whether its input reaches the tab.
      const held: RuntimeBrowserHolder = { targetId: 'tab-1', holder: 'you', since: new Date().toISOString(), by: 'gitspace', device: laptop.deviceId };
      browser.socket.send(JSON.stringify({ group: { groupId, tabs: [{ targetId: 'tab-1', url: page.url, title: page.title, addedBy: 'agent', site: null }], running: 0, held: [held] } }));
      expect(await onLaptop.next('control')).toEqual({ type: 'control', holder: held, input: true });
      expect(await onPhone.next('control')).toEqual({ type: 'control', holder: held, input: false });
      onPhone.socket.send(JSON.stringify(click));
      expect(await onPhone.next('error')).toEqual({ type: 'error', message: 'Take over this tab to use it from here' });
      onLaptop.socket.send(JSON.stringify(click));
      expect(await browser.next('remoteInput')).toMatchObject({ groupId, targetId: 'tab-1', device: laptop.deviceId, input: click });
      expect(browser.received.filter(message => message.operation === 'remoteInput')).toHaveLength(1);

      // The last viewer leaves: the Chrome stops streaming the tab.
      onLaptop.socket.close();
      onPhone.socket.close();
      expect(await browser.next('shareUnwatch')).toEqual(expect.objectContaining({ shareId: watchId }));
    } finally { browser.socket.close(); }
  });
});

const Command = z.object({ id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()), sessionId: z.string().optional() });
type Command = z.infer<typeof Command>;
/** The cloud browser as Browser Run serves it, with one page (`cloud-tab`): each command it got (`next` waits for one
 * by method), and events it sends. Each attach gets a session of its own. */
function browserRun() {
  const commands: Command[] = [], calls = waiter(commands, (command, method) => command.method === method);
  const pair = new WebSocketPair(), upstream = pair[1];
  upstream.accept();
  const info = { targetId: 'cloud-tab', type: 'page', url: page.url, title: page.title, attached: false, canAccessOpener: false };
  const results: Record<string, unknown> = { 'Target.getTargets': { targetInfos: [info] }, 'Target.getTargetInfo': { targetInfo: info }, 'Target.createTarget': { targetId: 'cloud-tab' }, 'Page.getFrameTree': { frameTree: { frame: { id: 'frame', url: page.url } } }, 'Page.navigate': { frameId: 'frame' } };
  let sessions = 0;
  upstream.addEventListener('message', event => {
    const command = Command.parse(JSON.parse(String(event.data)));
    commands.push(command); calls.deliver();
    upstream.send(JSON.stringify({ id: command.id, result: command.method === 'Target.attachToTarget' ? { sessionId: `session-${++sessions}` } : results[command.method] ?? {} }));
  });
  const BROWSER: Fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (new Request(input, init).method === 'POST') return Response.json({ sessionId: 'browser-run' });
      return new Response(null, { status: 101, webSocket: pair[0] });
    },
    connect() { throw new Error('Browser Run takes no sockets'); },
  };
  return { BROWSER, commands, next: calls.next, event: (method: string, params: object, sessionId: string) => upstream.send(JSON.stringify({ method, params, sessionId })) };
}
/** An agent's single step on the cloud browser, which opens it. */
function step(projectId: string, workspaceId: string) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString(), placement = { kind: 'cloud', accountId: env.ACCOUNT_ID };
  const authority = { body: { accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: 'AA==', issuedAt: new Date().toISOString(), expiresAt }, signature: 'AA==' };
  return RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: crypto.randomUUID() }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'open', source: 'headless', url: page.url }, grant: { body: { projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'headless', stepsOnly: [], origins: [], expiresAt }, signature: 'AA==', authority } } }, signature: 'AA==', authority });
}

test('a cloud tab in the Watch dialog: its own screencast for the viewers, your input only while you hold the tab from that device and counted as use, and watching alone never keeps the browser open', async () => {
  const { projectId, workspaceId } = await workspace();
  await runInDurableObject(env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${projectId}:${workspaceId}`), async (_instance, state) => {
    // Made in the object, whose I/O it is.
    const run = browserRun();
    const session = new BrowserSessionDO(state, { ...env, BROWSER: run.BROWSER });
    await session.execute(step(projectId, workspaceId));
    /** A viewer the route checked, with the object's end of its socket (its messages are handed to `session` here). */
    const accept = async (deviceId: string) => {
      const before = new Set(state.getWebSockets('browser-watch'));
      const response = await session.fetch(new Request(`https://browser-session${BROWSER_WATCH_INTERNAL_PATH}`, { headers: { upgrade: 'websocket', [BROWSER_WATCH_VIEWER_HEADER]: JSON.stringify({ deviceId, control: true, protocol: `${DEVICE_SOCKET_PROTOCOL}proof`, query: { source: 'cloud', projectId, workspaceId, targetId: 'cloud-tab' } }) } }));
      const server = state.getWebSockets('browser-watch').find(socket => !before.has(socket));
      if (!response.webSocket || !server) throw new Error(`No watch socket (${response.status})`);
      return { ...viewer(response.webSocket), server };
    };
    const laptop = await accept('laptop');
    expect(await laptop.next('control')).toEqual({ type: 'control', holder: null, input: false });
    const started = await run.next('Page.startScreencast');
    expect(started.params).toEqual({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
    const watching = z.string().parse(started.sessionId);
    run.event('Page.screencastFrame', { data: jpeg(1280, 720), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 720 } }, watching);
    expect(await laptop.next('page')).toEqual({ type: 'page', ...page, width: 1280, height: 720 });
    expect(await laptop.next('frame')).toEqual({ type: 'frame', data: jpeg(1280, 720), width: 1280, height: 720 });
    expect(await run.next('Page.screencastFrameAck')).toMatchObject({ params: { sessionId: 1 }, sessionId: watching });

    // While the agent holds the tab, input reaches nothing.
    await session.webSocketMessage(laptop.server, JSON.stringify(click));
    expect(await laptop.next('error')).toEqual({ type: 'error', message: 'Take over this tab to use it from here' });
    await session.takeOver({ projectId, workspaceId, targetId: 'cloud-tab', device: 'laptop' });
    expect(await laptop.next('control')).toMatchObject({ type: 'control', holder: { targetId: 'cloud-tab', holder: 'you', by: 'gitspace', device: 'laptop' }, input: true });
    const phone = await accept('phone');
    expect(await phone.next('control')).toMatchObject({ type: 'control', input: false });
    await session.webSocketMessage(phone.server, JSON.stringify(click));
    expect(await phone.next('error')).toEqual({ type: 'error', message: 'Take over this tab to use it from here' });
    // Your input is use of the browser: it pushes the idle deadline.
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now() + 3_600_000;
    vi.setSystemTime(now);
    await session.webSocketMessage(laptop.server, JSON.stringify(click));
    expect(await state.storage.getAlarm()).toBe(now + 5 * 60_000);
    expect(await run.next('Input.dispatchMouseEvent')).toMatchObject({ sessionId: watching, params: { type: 'mousePressed', x: 640, y: 180, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } });
    expect(run.commands.filter(command => command.method.startsWith('Input.'))).toHaveLength(1);
    await session.resume({ projectId, workspaceId, targetId: 'cloud-tab' });
    expect(await laptop.next('control')).toEqual({ type: 'control', holder: null, input: false });
    // The last viewer leaves: the screencast's session lets the tab go.
    await session.webSocketClose(phone.server);
    expect(run.commands.some(command => command.method === 'Target.detachFromTarget' && command.params.sessionId === watching)).toBe(false);
    await session.webSocketClose(laptop.server);
    expect(await run.next('Target.detachFromTarget')).toMatchObject({ params: { sessionId: watching } });

    // Watching alone is not use: at the idle time the browser closes under an open viewer, which hears why.
    const left = await accept('laptop');
    await left.next('control');
    await run.next('Page.startScreencast');
    await session.alarm();
    expect(await run.next('Browser.close')).toMatchObject({ method: 'Browser.close' });
    expect(await left.next('ended')).toEqual({ type: 'ended', reason: 'idle' });
  });
});
