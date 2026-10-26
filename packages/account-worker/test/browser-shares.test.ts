import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { RuntimeBrowserConnectedTabSchema, RuntimeBrowserCommentThreadSchema, RuntimeBrowserShareSchema, RuntimeBrowserShareServerMessageSchema, browserBase64, parseBrowserShareLink, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserAuthorizationBody, type RuntimeAccountBrowserPlacement, type RuntimeBrowserShareServerMessage } from '@gitspace/protocol-runtime';
import { workspaceCommentThreads } from '../src/browser-comments.js';
import { BROWSER_UPLOAD_HEADER, browserSignedText, type BrowserSignedLabel } from '../src/browser-upload.js';
import type { UserRelayDO } from '../src/index.js';
import { workspaceDrive } from '../src/workspace-drive.js';
import { tenantRootPrivateKey } from './setup.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
const MessageSchema = z.object({ id: z.number().optional(), operation: z.string().optional() }).catchall(z.unknown());
type Message = z.infer<typeof MessageSchema>;
type Kind = RuntimeBrowserShareServerMessage['type'];
/** A paired Chrome's extension: every message the relay sent it, its answers to commands (`answer`; a throw answers
 * with an error), and a way to wait for the next message of an operation. */
type Chrome = { socket: WebSocket; identity: Identity; pairingId: string; generation: number; received: Message[]; placement: RuntimeAccountBrowserPlacement | null; next(operation: string): Promise<Message> };
/** Someone watching: what the share told them, the next message of a kind, and how their socket closed. */
type Viewer = { socket: WebSocket; received: RuntimeBrowserShareServerMessage[]; next<T extends Kind>(type: T): Promise<Extract<RuntimeBrowserShareServerMessage, { type: T }>>; closed: Promise<{ code: number; reason: string }> };
const Reply = z.object({ status: z.string(), value: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const Joined = z.object({ token: z.string(), viewerId: z.string().uuid(), name: z.string(), guest: z.boolean(), expiresAt: z.string() });
const origin = 'https://test.gitspace.sh', encoder = new TextEncoder();
afterEach(() => { vi.useRealTimers(); });

function hex(bytes: ArrayBuffer | Uint8Array): string { return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
/** Narrows what the share told a viewer to one kind of message. */
function isKind<T extends Kind>(message: RuntimeBrowserShareServerMessage, type: T): message is Extract<RuntimeBrowserShareServerMessage, { type: T }> { return message.type === type; }
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

/** A project with one workspace and its drive. */
async function workspace() {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Shares', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { projectId, workspaceId, drive: workspaceDrive(env, { projectId, workspaceId }) };
}

/** A paired Chrome, confirmed and approved for the project, whose extension reports `protocol`. */
async function chrome(relay: UserRelayDO, root: Identity, projectId: string, options: { protocol: number; ip: string }, answer: (message: Message) => unknown): Promise<Chrome> {
  // GitSpace starts the pairing; the extension redeems its short code for the pairing's details.
  const redeemed = await relay.browserRelayRedeemPairingCode((await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey })).code, '198.51.100.1', 'wss://account.test/api/browser-relay/extension');
  if (!redeemed.ok) throw new Error(redeemed.message);
  const pairing = redeemed.value;
  const socket = (await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': options.ip } }))).webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, encoder.encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/131.0.0.0', protocol: options.protocol })); await ready;
  const received: Message[] = [], operations = waiter(received, (message, operation) => message.operation === operation);
  socket.addEventListener('message', event => {
    const message = MessageSchema.parse(JSON.parse(String(event.data)));
    received.push(message); operations.deliver();
    if (typeof message.id !== 'number') return;
    const { id } = message;
    // Like an extension, it answers only while its socket is open.
    const reply = (value: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, ...value })); };
    void Promise.resolve().then(() => message.operation === 'tabs' ? [] : answer(message)).then(result => reply({ result: result ?? {} }), (error: unknown) => reply({ error: { message: error instanceof Error ? error.message : String(error) } }));
  });
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  const settings = await relay.browserRelayProjectSettings(projectId);
  await relay.browserRelaySetProjectSettings(projectId, settings.revision, { defaultPairingId: pairing.pairingId, approvals: [{ pairingId: pairing.pairingId }] });
  return { socket, identity, pairingId: pairing.pairingId, generation: pairing.generation, received, placement: await relay.browserRelayPlacement(projectId, pairing.pairingId), next: operations.next };
}

/** A command signed by the workspace for the Chrome: a step (`tabs`) in a new group, or a management command. */
async function authorization(root: Identity, placement: RuntimeAccountBrowserPlacement, projectId: string, workspaceId: string, manage?: Extract<RuntimeAccountBrowserAuthorizationBody['command'], { type: 'manage' }>) {
  if (placement.kind !== 'account-relay') throw new Error('Expected a Chrome placement');
  const signer = await keys(), expiresAt = new Date(Date.now() + 60_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: signer.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, signer.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  return signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: manage ? 'browser_control' : 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: manage ?? { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: placement.pairingId }, grant } }, signer.key.privateKey, authority);
}

/** A step on the Chrome: the workspace's group now exists there. */
async function group(relay: UserRelayDO, root: Identity, browser: Chrome, projectId: string, workspaceId: string) {
  if (!browser.placement) throw new Error('Expected an approved Chrome');
  const signed = await authorization(root, browser.placement, projectId, workspaceId);
  if (signed.body.command.type !== 'execute') throw new Error('Expected a step');
  expect((await relay.browserRelayExecute(signed)).status).toBe('completed');
  return signed.body.command.grant.body.groupId;
}

/** A management command from the workspace's Browser tab, answered with its JSON. */
async function manage(relay: UserRelayDO, root: Identity, browser: Chrome, projectId: string, workspaceId: string, command: Extract<RuntimeAccountBrowserAuthorizationBody['command'], { type: 'manage' }>): Promise<unknown> {
  if (!browser.placement) throw new Error('Expected an approved Chrome');
  const reply = (await relay.browserRelayExecute(await authorization(root, browser.placement, projectId, workspaceId, command))).content[0];
  return JSON.parse(reply?.type === 'text' ? reply.text : 'null');
}

/** A request the Chrome's extension signs with its pairing key (`label` share unless said otherwise, to `path`, the
 * share route unless said otherwise). */
async function signed(browser: Pick<Chrome, 'identity' | 'pairingId' | 'generation'>, body: object, options: { label?: BrowserSignedLabel; header?: null; path?: string } = {}) {
  const path = options.path ?? '/api/browser-relay/shares', bytes = encoder.encode(JSON.stringify(body));
  const issuedAt = Date.now(), nonce = hex(crypto.getRandomValues(new Uint8Array(32))), bodySha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', browser.identity.key.privateKey, encoder.encode(browserSignedText(options.label ?? 'share', { pairingId: browser.pairingId, generation: browser.generation, method: 'POST', pathname: path, bodySha256, issuedAt, nonce })))));
  const header = btoa(JSON.stringify({ pairingId: browser.pairingId, generation: browser.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const response = await exports.default.fetch(new Request(`${origin}${path}`, { method: 'POST', headers: options.header === null ? {} : { [BROWSER_UPLOAD_HEADER]: header }, body: bytes }));
  return { ...Reply.parse(await response.json()), status: response.status };
}
async function share(browser: Chrome, body: object) {
  const reply = await signed(browser, { op: 'create', ...body });
  if (reply.status !== 200) throw new Error(`Share refused: ${JSON.stringify(reply)}`);
  const made = RuntimeBrowserShareSchema.parse(reply.value?.share);
  const link = parseBrowserShareLink(made.link, origin);
  if (!link) throw new Error('Unreadable share link');
  return { share: made, ...link };
}

/** A public share route through the account worker. */
async function route(shareId: string, action: 'preview' | 'join', body: object, headers: Record<string, string> = {}) {
  const response = await exports.default.fetch(new Request(`${origin}/api/shares/${shareId}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { ...Reply.parse(await response.json()), status: response.status };
}
/** A viewer's live socket, before it says hello. */
async function socket(shareId: string): Promise<Viewer> {
  const response = await exports.default.fetch(new Request(`${origin}/api/shares/${shareId}/live`, { headers: { upgrade: 'websocket' } }));
  const live = response.webSocket;
  if (!live) throw new Error(`No live socket (${response.status})`);
  const received: RuntimeBrowserShareServerMessage[] = [], messages = waiter(received, (message, type) => message.type === type);
  const closed = new Promise<{ code: number; reason: string }>(resolve => live.addEventListener('close', event => resolve({ code: event.code, reason: event.reason })));
  live.addEventListener('message', event => { received.push(RuntimeBrowserShareServerMessageSchema.parse(JSON.parse(String(event.data)))); messages.deliver(); });
  live.accept();
  return { socket: live, received, closed, next: type => messages.next(type) as never };
}
/** Someone who joined with their name and said hello. */
async function watch(shareId: string, secret: string, name: string) {
  const joined = await route(shareId, 'join', { secret, name });
  expect(joined.status).toBe(200);
  const viewer = await socket(shareId), { token, viewerId } = Joined.parse(joined.value);
  viewer.socket.send(JSON.stringify({ type: 'hello', token }));
  await viewer.next('joined');
  return { ...viewer, viewerId };
}
const page = { url: 'https://example.com/docs', title: 'Docs' };

test('a tab shared from your Chrome: its link greets only with its secret, viewers join to watch its frames and point, and the Chrome draws their named pointers at most ten times a second', async () => {
  const { projectId } = await workspace();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.51' }, message => message.operation === 'shareTab' ? { ...page, groupId: null } : message.operation === 'shareWatch' ? { ...page, width: 1280, height: 800 } : {});
    try {
      // Only this Chrome's key, signing for shares, makes one; a tab in no workspace group takes no comments.
      expect(await signed(browser, { op: 'create', targetId: 'your-tab', comment: false, expiresInMinutes: 60 }, { header: null })).toMatchObject({ status: 401, error: { code: 'SHARE_SIGNATURE_REQUIRED' } });
      expect(await signed(browser, { op: 'create', targetId: 'your-tab', comment: false, expiresInMinutes: 60 }, { label: 'upload' })).toMatchObject({ status: 401, error: { code: 'SHARE_SIGNATURE_INVALID' } });
      expect(await signed(browser, { op: 'create', targetId: 'your-tab', comment: true, expiresInMinutes: 60 })).toMatchObject({ status: 409, error: { message: 'Comments need the tab in a workspace group' } });
      const { share: made, shareId, secret } = await share(browser, { targetId: 'your-tab', comment: false, expiresInMinutes: 60 });
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(made).toMatchObject({ pairingId: browser.pairingId, targetId: 'your-tab', workspace: null, page, comment: false, endReason: null, viewers: [] });
      expect(Date.parse(made.expiresAt) - Date.parse(made.createdAt)).toBe(60 * 60_000);
      expect((await browser.next('shares')).shares).toEqual([made]);
      expect(await signed(browser, { op: 'list' })).toMatchObject({ status: 200, value: { shares: [{ shareId }] } });

      // The greeting needs the secret: a wrong one and an unknown share get the same answer.
      expect(await route(shareId, 'preview', { secret: 'x'.repeat(43) })).toMatchObject({ status: 404, error: { code: 'SHARE_UNKNOWN' } });
      expect(await route(crypto.randomUUID(), 'preview', { secret })).toMatchObject({ status: 404, error: { code: 'SHARE_UNKNOWN' } });
      expect(await route(shareId, 'preview', { secret })).toEqual({ status: 200, value: { sharer: 'test', page: { title: 'Docs', site: 'example.com', icon: null }, comment: false, expiresAt: made.expiresAt, ended: null, browser: null, online: true } });
      expect(await route(shareId, 'join', { secret: 'x'.repeat(43), name: 'Mia' })).toMatchObject({ status: 404, error: { code: 'SHARE_UNKNOWN' } });

      // Mia watches: the Chrome streams the tab at the largest viewer's size, and its frames reach her.
      const mia = await watch(shareId, secret, 'Mia');
      expect(mia.received[0]).toMatchObject({ type: 'joined', viewerId: mia.viewerId, share: { sharer: 'test', comment: false, ended: null }, viewers: [{ viewerId: mia.viewerId, name: 'Mia', guest: true }], threads: [] });
      expect(await browser.next('shareWatch')).toMatchObject({ shareId, targetId: 'your-tab', maxWidth: 1280, maxHeight: 1280 });
      expect(await mia.next('page')).toEqual({ type: 'page', ...page, width: 1280, height: 800 });
      mia.socket.send(JSON.stringify({ type: 'size', width: 800, height: 600 }));
      expect(await browser.next('shareWatch')).toMatchObject({ shareId, maxWidth: 800, maxHeight: 600 });
      browser.socket.send(JSON.stringify({ shareFrame: { shareId, data: 'frame-1', width: 800, height: 500 } }));
      expect(await mia.next('frame')).toEqual({ type: 'frame', data: 'frame-1', width: 800, height: 500 });
      // Neither another share's id nor a view-only share's comment mode reaches anything.
      mia.socket.send(JSON.stringify({ type: 'hit', at: { x: 0.5, y: 0.5 } }));
      expect(await mia.next('error')).toEqual({ type: 'error', message: 'This share is view-only: you can watch and point' });
      mia.socket.send(JSON.stringify({ type: 'comment', at: { x: 0.5, y: 0.5 }, text: 'Too dark' }));
      expect(await mia.next('error')).toEqual({ type: 'error', message: 'This share is view-only: you can watch and point' });
      expect(browser.received.map(message => message.operation)).not.toContain('shareHit');
      expect(browser.received.map(message => message.operation)).not.toContain('shareAnchor');

      const ana = await watch(shareId, secret, 'Ana');
      expect((await mia.next('viewers')).viewers.map(viewer => viewer.name)).toEqual(['Mia']);
      expect((await mia.next('viewers')).viewers.map(viewer => viewer.name).sort()).toEqual(['Ana', 'Mia']);
      // Pointers reach the Chrome named and colored, at most once per tenth of a second, the latest each time. The
      // Chrome's socket may lag the viewers': both joins' pointer lists reach it first.
      const pointers = () => browser.received.filter(message => message.operation === 'sharePointers');
      await expect.poll(() => pointers().length).toBe(2);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
      vi.setSystemTime(Date.now() + 1000);
      const before = pointers().length;
      mia.socket.send(JSON.stringify({ type: 'pointer', at: { x: 0.25, y: 0.5 } }));
      await expect.poll(() => pointers().length).toBe(before + 1);
      expect(pointers().at(-1)).toEqual({ operation: 'sharePointers', shareId, pointers: [{ viewerId: mia.viewerId, name: 'Mia', color: expect.stringMatching(/^#[0-9a-f]{6}$/u), at: { x: 0.25, y: 0.5 } }] });
      for (const x of [0.3, 0.35, 0.4]) mia.socket.send(JSON.stringify({ type: 'pointer', at: { x, y: 0.5 } }));
      ana.socket.send(JSON.stringify({ type: 'pointer', at: { x: 0.9, y: 0.1 } }));
      // Each viewer's messages are taken in order: these answers come after their pointers moved.
      mia.socket.send(JSON.stringify({ type: 'hit', at: { x: 0.5, y: 0.5 } })); await mia.next('error');
      ana.socket.send(JSON.stringify({ type: 'hit', at: { x: 0.5, y: 0.5 } })); await ana.next('error');
      expect(pointers()).toHaveLength(before + 1);
      vi.advanceTimersByTime(100);
      await expect.poll(() => pointers().length).toBe(before + 2);
      expect(pointers().at(-1)).toEqual({ operation: 'sharePointers', shareId, pointers: expect.arrayContaining([{ viewerId: mia.viewerId, name: 'Mia', color: expect.any(String), at: { x: 0.4, y: 0.5 } }, { viewerId: ana.viewerId, name: 'Ana', color: expect.any(String), at: { x: 0.9, y: 0.1 } }]) });
      const pointed = () => mia.received.flatMap(message => message.type === 'viewers' ? [message.viewers.map(({ name, at }) => ({ name, at }))] : []).at(-1);
      await expect.poll(pointed).toEqual(expect.arrayContaining([{ name: 'Mia', at: { x: 0.4, y: 0.5 } }, { name: 'Ana', at: { x: 0.9, y: 0.1 } }]));

      // Ana leaves: the Chrome stops drawing her (on the next tenth of a second); when Mia leaves too, it stops streaming.
      ana.socket.close();
      await expect.poll(() => { vi.advanceTimersByTime(100); return z.array(z.unknown()).parse(pointers().at(-1)?.pointers).length; }).toBe(1);
      vi.useRealTimers();
      mia.socket.close();
      expect(await browser.next('shareUnwatch')).toMatchObject({ shareId });
    } finally { vi.useRealTimers(); browser.socket.close(); }
  });
});

test('a comment share: the latest hit is answered, a comment is anchored by the Chrome as a thread, its crop lands in the workspace drive and the thread in the workspace; replies and resolving reach that share’s viewers and no other share’s; guests never resolve; the audit keeps who joined, commented and ended it', async () => {
  const { projectId, workspaceId, drive } = await workspace();
  const crop = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 7]);
  const target = { box: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, role: 'button', name: 'Buy', text: 'Buy now', selectors: ['#buy'] };
  let groupId = '';
  const firstHit = Promise.withResolvers<void>();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    let hits = 0;
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.52' }, async message => {
      if (message.operation === 'shareTab') return { ...page, groupId };
      if (message.operation === 'shareWatch') return { ...page, width: 1280, height: 800 };
      if (message.operation === 'shareHit') { if (hits++ === 0) await firstHit.promise; return { target }; }
      if (message.operation === 'shareAnchor') return { page, target, region: target.box, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 120 }, crop: browserBase64(crop) };
      return {};
    });
    try {
      groupId = await group(relay, root, browser, projectId, workspaceId);
      const { share: made, shareId, secret } = await share(browser, { targetId: 'your-tab', comment: true, expiresInMinutes: 15 });
      expect(made.workspace).toEqual({ projectId, workspaceId, groupId });
      const mia = await watch(shareId, secret, 'Mia');

      // While one hit test runs, only the latest point asked meanwhile is tested and answered.
      mia.socket.send(JSON.stringify({ type: 'hit', at: { x: 0.1, y: 0.1 } }));
      await browser.next('shareHit');
      mia.socket.send(JSON.stringify({ type: 'hit', at: { x: 0.2, y: 0.2 } }));
      mia.socket.send(JSON.stringify({ type: 'hit', at: { x: 0.3, y: 0.3 } }));
      mia.socket.send(JSON.stringify({ type: 'comment', text: 'Nothing pointed at' }));
      expect(await mia.next('error')).toEqual({ type: 'error', message: 'Point at something or drag over an area to comment on it' });
      firstHit.resolve();
      expect(await mia.next('hit')).toEqual({ type: 'hit', at: { x: 0.3, y: 0.3 }, target });
      expect(browser.received.filter(message => message.operation === 'shareHit').map(message => message.at)).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }]);
      expect(mia.received.filter(message => message.type === 'hit')).toHaveLength(1);

      mia.socket.send(JSON.stringify({ type: 'comment', at: { x: 0.2, y: 0.25 }, text: 'This button is too small' }));
      expect(await browser.next('shareAnchor')).toMatchObject({ shareId, at: { x: 0.2, y: 0.25 } });
      const { thread } = await mia.next('thread');
      const threadId = thread.root.id;
      expect(thread).toEqual({ replies: [], root: {
        id: threadId, threadId, parentId: null, source: { kind: 'share', shareId }, page, by: { kind: 'person', name: 'Mia', guest: true }, text: 'This button is too small', createdAt: expect.any(String), resolved: null,
        anchor: { role: 'button', name: 'Buy', selector: '#buy', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, cropFile: expect.stringMatching(/^browser\/comments\/[0-9a-f-]{36}\.jpg$/u), scroll: { x: 0, y: 120 }, viewport: { w: 1280, h: 800 } },
      } });
      expect(await drive.read(thread.root.anchor?.cropFile ?? '')).toEqual(crop);
      const kept = () => runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`), async (_authority, state) => workspaceCommentThreads(state.storage, { status: 'all' }));
      expect(await kept()).toEqual([thread]);
      // Someone joining later sees the threads so far; a viewer of another share of the workspace sees none of them.
      const ana = await watch(shareId, secret, 'Ana');
      expect(ana.received[0]).toMatchObject({ type: 'joined', threads: [thread] });
      const other = await share(browser, { targetId: 'other-tab', comment: true, expiresInMinutes: 15 });
      const ben = await watch(other.shareId, other.secret, 'Ben');
      expect(ben.received[0]).toMatchObject({ type: 'joined', threads: [] });

      // A guest replies; a guest's resolve is refused.
      ana.socket.send(JSON.stringify({ type: 'commentReply', threadId, text: 'And its label is cut off' }));
      const replied = RuntimeBrowserCommentThreadSchema.parse((await mia.next('thread')).thread);
      expect(replied.replies).toEqual([{ id: expect.any(String), threadId, parentId: threadId, source: { kind: 'share', shareId }, page, anchor: null, by: { kind: 'person', name: 'Ana', guest: true }, text: 'And its label is cut off', createdAt: expect.any(String), resolved: null }]);
      expect((await ana.next('thread')).thread).toEqual(replied);
      ana.socket.send(JSON.stringify({ type: 'commentResolve', threadId }));
      expect(await ana.next('error')).toEqual({ type: 'error', message: 'Only the account’s owner resolves comments' });
      // You resolve it from your Chrome's comment tool: its viewers see it resolved by you.
      const commentRoute = { label: 'comment' as const, path: '/api/browser-relay/comments' };
      const resolved = await signed(browser, { op: 'resolve', groupId, threadId }, commentRoute);
      expect(resolved).toMatchObject({ status: 200, value: { thread: { root: { id: threadId, resolved: { by: 'test', at: expect.any(String) } } } } });
      for (const viewer of [mia, ana]) expect((await viewer.next('thread')).thread).toEqual(resolved.value?.thread);
      expect(await kept()).toEqual([resolved.value?.thread]);
      expect(ben.received.filter(message => message.type === 'thread')).toEqual([]);
      // A thread of one share is not another share's to reply in.
      ben.socket.send(JSON.stringify({ type: 'commentReply', threadId, text: 'Me too' }));
      expect(await ben.next('error')).toEqual({ type: 'error', message: 'Your reply was not saved: This comment thread is not on this share' });
      // Your own comment from your Chrome's comment tool: its crop lands in the drive; it is no share's, so no viewer
      // sees it; the page's threads (whatever its fragment) list it with the share's.
      const chromeComment = { op: 'comment', groupId, page: { url: `${page.url}#intro`, title: page.title }, anchor: { role: 'heading', name: 'Docs', selector: 'h1', box: { x: 0, y: 0, w: 0.5, h: 0.1 } }, crop: browserBase64(crop), text: 'Rename this page' };
      const mine = RuntimeBrowserCommentThreadSchema.parse((await signed(browser, chromeComment, commentRoute)).value?.thread);
      expect(mine.root).toMatchObject({ source: { kind: 'chrome', pairingId: browser.pairingId }, by: { kind: 'person', name: 'test', guest: false }, anchor: { role: 'heading', name: 'Docs', selector: 'h1', cropFile: expect.stringMatching(/^browser\/comments\/[0-9a-f-]{36}\.jpg$/u) } });
      expect(await drive.read(mine.root.anchor?.cropFile ?? '')).toEqual(crop);
      const listed = await signed(browser, { op: 'list', groupId, url: page.url }, commentRoute);
      expect(listed).toMatchObject({ status: 200, value: { name: 'test' } });
      expect(z.array(RuntimeBrowserCommentThreadSchema).parse(listed.value?.threads).map(item => item.root.id)).toEqual([mine.root.id, threadId]);
      expect([mia, ana, ben].map(viewer => viewer.received.filter(message => message.type === 'thread').length)).toEqual([3, 2, 0]);
      // A group that is not this Chrome's takes nothing.
      expect(await signed(browser, { ...chromeComment, groupId: crypto.randomUUID() }, commentRoute)).toMatchObject({ status: 404, error: { code: 'COMMENT_GROUP_UNKNOWN' } });

      const revoked = await signed(browser, { op: 'revoke', shareId });
      expect(revoked).toMatchObject({ status: 200, value: { share: { shareId, endReason: 'revoked', viewers: [] } } });
      for (const viewer of [mia, ana]) {
        expect(await viewer.next('ended')).toEqual({ type: 'ended', reason: 'revoked' });
        expect(await viewer.closed).toMatchObject({ code: 1000 });
      }
      expect(await browser.next('shareEnded')).toEqual({ operation: 'shareEnded', shareId, reason: 'revoked' });
      expect(await browser.next('shareUnwatch')).toMatchObject({ shareId });
      const audit = RuntimeBrowserShareSchema.parse(revoked.value?.share).audit;
      expect(audit.map(({ event, by, guest }) => ({ event, by, guest }))).toEqual([
        { event: 'ended', by: 'you', guest: false }, { event: 'commented', by: 'Ana', guest: true }, { event: 'joined', by: 'Ana', guest: true }, { event: 'commented', by: 'Mia', guest: true },
        { event: 'joined', by: 'Mia', guest: true }, { event: 'created', by: 'you', guest: false },
      ]);
      expect(audit.filter(row => row.event === 'commented').map(row => row.detail)).toEqual(['And its label is cut off', 'This button is too small']);
      expect(await route(shareId, 'join', { secret, name: 'Late' })).toMatchObject({ status: 410, error: { code: 'SHARE_ENDED' } });
    } finally { firstHit.resolve(); browser.socket.close(); }
  });
});

test('from a workspace you share a tab of its group and connect a pasted share link’s tab to it; a Chrome whose extension predates shares is asked to update', async () => {
  const { projectId, workspaceId } = await workspace();
  let groupId = '';
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    // Each Chrome made here becomes the project's only approved one, so the old one is used before the new one exists.
    const old = await chrome(relay, root, projectId, { protocol: 5, ip: '192.0.2.53' }, () => ({}));
    const oldGroup = await group(relay, root, old, projectId, workspaceId);
    await expect(manage(relay, root, old, projectId, workspaceId, { type: 'manage', action: 'shareCreate', groupId: oldGroup, targetId: 'your-tab', comment: false, expiresInMinutes: 60 })).rejects.toThrow('Update the GitSpace extension in Chrome to share tabs');
    expect(await signed(old, { op: 'create', targetId: 'your-tab', comment: false, expiresInMinutes: 60 })).toMatchObject({ status: 409, error: { message: 'Update the GitSpace extension in Chrome to share tabs' } });
    expect(old.received.map(message => message.operation)).not.toContain('shareTab');
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.54' }, message => message.operation === 'shareTab' ? { ...page, groupId: message.targetId === 'grouped-tab' ? groupId : null } : message.operation === 'adoptTab' ? { url: 'https://example.com/pricing', title: 'Pricing' } : {});
    try {
      groupId = await group(relay, root, browser, projectId, workspaceId);
      await expect(manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shareCreate', groupId, targetId: 'loose-tab', comment: true, expiresInMinutes: 60 })).rejects.toThrow('This tab is not in the workspace’s group on that Chrome');
      const made = RuntimeBrowserShareSchema.parse(await manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shareCreate', groupId, targetId: 'grouped-tab', comment: true, expiresInMinutes: 480 }));
      expect(made).toMatchObject({ targetId: 'grouped-tab', workspace: { projectId, workspaceId, groupId }, comment: true });

      // A link you shared from the extension, pasted into this workspace: the secret is checked, a group is needed on
      // its Chrome, and then its tab joins that group.
      const { shareId, secret } = await share(browser, { targetId: 'loose-tab', comment: false, expiresInMinutes: 60 });
      await expect(manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shareConnect', shareId, secret: 'y'.repeat(43) })).rejects.toThrow('This share link is unknown or its secret is wrong');
      expect(await manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shareConnect', shareId, secret })).toEqual({ needsGroup: { pairingId: browser.pairingId } });
      expect(browser.received.map(message => message.operation)).not.toContain('adoptTab');
      const connected = z.object({ connected: RuntimeBrowserConnectedTabSchema }).parse(await manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shareConnect', shareId, secret, groupId }));
      expect(connected.connected).toEqual({ pairingId: browser.pairingId, browser: expect.any(String), groupId, targetId: 'loose-tab', url: 'https://example.com/pricing', title: 'Pricing' });
      expect(await browser.next('adoptTab')).toMatchObject({ groupId, targetId: 'loose-tab' });

      const listed = z.array(RuntimeBrowserShareSchema).parse(await manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shares' }));
      expect(listed.map(item => item.shareId)).toEqual([shareId, made.shareId]);
      expect(listed[0]).toMatchObject({ workspace: { projectId, workspaceId, groupId }, page: { url: 'https://example.com/pricing', title: 'Pricing' }, comment: false });
      expect(listed[0]?.audit.map(row => row.event)).toEqual(['connected', 'created']);

      const ended = RuntimeBrowserShareSchema.parse(await manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shareRevoke', shareId: made.shareId }));
      expect(ended).toMatchObject({ shareId: made.shareId, endReason: 'revoked', endedAt: expect.any(String) });
      // Ended shares stay listed for a day.
      expect(z.array(RuntimeBrowserShareSchema).parse(await manage(relay, root, browser, projectId, workspaceId, { type: 'manage', action: 'shares' })).map(item => item.endReason)).toEqual([null, 'revoked']);
    } finally { old.socket.close(); browser.socket.close(); }
  });
});

test('a share ends for its viewers and its Chrome when it expires or its tab closes; sockets without a valid hello are closed, and a full share takes nobody more', async () => {
  const { projectId } = await workspace();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.55' }, message => message.operation === 'shareTab' ? { ...page, groupId: null } : message.operation === 'shareWatch' ? { ...page, width: 1280, height: 800 } : {});
    try {
      const { shareId, secret } = await share(browser, { targetId: 'your-tab', comment: false, expiresInMinutes: 15 });
      const mia = await watch(shareId, secret, 'Mia');
      const forged = await socket(shareId);
      forged.socket.send(JSON.stringify({ type: 'hello', token: 'not-a-token' }));
      expect(await forged.closed).toEqual({ code: 1008, reason: 'Invalid share token' });
      // A viewer sends its size and pointer right after hello, while the hello is still being checked.
      const eagerJoin = Joined.parse((await route(shareId, 'join', { secret, name: 'Eager' })).value), eager = await socket(shareId);
      eager.socket.send(JSON.stringify({ type: 'hello', token: eagerJoin.token }));
      eager.socket.send(JSON.stringify({ type: 'size', width: 640, height: 480 }));
      eager.socket.send(JSON.stringify({ type: 'pointer', at: { x: 0.5, y: 0.5 } }));
      expect(await eager.next('joined')).toMatchObject({ viewerId: eagerJoin.viewerId });
      expect((await eager.next('viewers')).viewers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Eager', at: { x: 0.5, y: 0.5 } })]));
      eager.socket.close();
      const silent = await socket(shareId);
      const pointless = await socket(shareId);
      pointless.socket.send(JSON.stringify({ type: 'pointer', at: { x: 0.5, y: 0.5 } }));
      expect(await pointless.closed).toEqual({ code: 1008, reason: 'Share hello required' });

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11_000);
      await relay.alarm();
      expect(await silent.closed).toEqual({ code: 1008, reason: 'Share hello timed out' });
      expect(mia.socket.readyState).toBe(WebSocket.OPEN);
      vi.setSystemTime(Date.now() + 15 * 60_000);
      await relay.alarm();
      expect(await mia.next('ended')).toEqual({ type: 'ended', reason: 'expired' });
      expect(await mia.closed).toMatchObject({ code: 1000 });
      expect(await browser.next('shareEnded')).toEqual({ operation: 'shareEnded', shareId, reason: 'expired' });
      expect(await route(shareId, 'preview', { secret })).toMatchObject({ status: 200, value: { ended: 'expired' } });
      expect(await route(shareId, 'join', { secret, name: 'Late' })).toMatchObject({ status: 410, error: { code: 'SHARE_ENDED' } });
      vi.useRealTimers();

      const closing = await share(browser, { targetId: 'other-tab', comment: false, expiresInMinutes: 15 });
      const ana = await watch(closing.shareId, closing.secret, 'Ana');
      browser.socket.send(JSON.stringify({ share: { event: 'closed', shareId: closing.shareId } }));
      expect(await ana.next('ended')).toEqual({ type: 'ended', reason: 'closed' });
      expect(await browser.next('shareEnded')).toEqual({ operation: 'shareEnded', shareId: closing.shareId, reason: 'closed' });

      const crowded = await share(browser, { targetId: 'busy-tab', comment: false, expiresInMinutes: 15 });
      const crowd = [];
      for (let index = 0; index < 20; index++) crowd.push(await watch(crowded.shareId, crowded.secret, `Viewer ${index}`));
      expect(await route(crowded.shareId, 'join', { secret: crowded.secret, name: 'One more' })).toMatchObject({ status: 429, error: { code: 'SHARE_FULL' } });
      for (const viewer of crowd) viewer.socket.close();
    } finally { vi.useRealTimers(); browser.socket.close(); }
  });
});

test('a share wakes the relay at its expiry, and once it ends, a day later to forget it', async () => {
  const { projectId } = await workspace();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO, state) => {
    // The relay's first-start presence check runs first, so the share's deadlines are its only ones.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 36_000);
    await relay.alarm();
    vi.useRealTimers();
    expect(await state.storage.getAlarm()).toBeNull();
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.57' }, message => message.operation === 'shareTab' ? { ...page, groupId: null } : {});
    try {
      const { share: made, shareId } = await share(browser, { targetId: 'your-tab', comment: false, expiresInMinutes: 15 });
      expect(await state.storage.getAlarm()).toBe(Date.parse(made.expiresAt));
      const revoked = await signed(browser, { op: 'revoke', shareId });
      const endedAt = Date.parse(RuntimeBrowserShareSchema.parse(revoked.value?.share).endedAt ?? '');
      const forgetAt = endedAt + 24 * 60 * 60_000;
      expect(await state.storage.getAlarm()).toBe(forgetAt);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(forgetAt);
      await relay.alarm();
      expect([...(await state.storage.list({ prefix: 'browser.relay.share:' })).keys()]).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { vi.useRealTimers(); browser.socket.close(); }
  });
});

test('one of the account’s own devices joins under the account’s name, not as a guest', async () => {
  const { projectId } = await workspace();
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID), deviceKey = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: `${origin}/v1/devices/enroll` }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(deviceKey)), label: 'Your laptop', boundAt: Date.now(), signingPrivateKey: deviceKey });
  expect(await vault.enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  const settings = env.USER_SETTINGS.getByName(env.ACCOUNT_ID), current = await settings.get('test');
  expect(await settings.update('test', { expectedRevision: current.revision, onboardingComplete: current.onboardingComplete, profile: { ...current.profile, displayName: 'Bradley' }, git: current.git, defaults: current.defaults })).toMatchObject({ status: 'ok' });
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.56' }, message => message.operation === 'shareTab' ? { ...page, groupId: null } : {});
    try {
      const { share: made, shareId, secret } = await share(browser, { targetId: 'your-tab', comment: false, expiresInMinutes: 15 });
      // Asked by one of the account's devices, the greeting also names the Chrome holding the tab; asked by anyone else, not.
      const previewPath = `/api/shares/${shareId}/preview`, previewBody = encoder.encode(JSON.stringify({ secret }));
      const signedPreview = signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: deviceKey, method: 'POST', path: previewPath, body: previewBody });
      expect(await route(shareId, 'preview', { secret }, { 'x-gitspace-device': signedPreview })).toMatchObject({ status: 200, value: { sharer: 'Bradley', browser: made.browser } });
      expect(await route(shareId, 'preview', { secret })).toMatchObject({ status: 200, value: { sharer: 'Bradley', browser: null } });
      expect(await route(shareId, 'preview', { secret }, { 'x-gitspace-device': 'forged' })).toMatchObject({ status: 401 });
      const path = `/api/shares/${shareId}/join`, body = encoder.encode(JSON.stringify({ secret, name: 'typed name' }));
      const device = signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: deviceKey, method: 'POST', path, body });
      expect(await route(shareId, 'join', { secret, name: 'typed name' }, { 'x-gitspace-device': device })).toMatchObject({ status: 200, value: { name: 'Bradley', guest: false } });
      expect(await route(shareId, 'join', { secret, name: 'typed name' }, { 'x-gitspace-device': 'forged' })).toMatchObject({ status: 401 });
      expect(await route(shareId, 'join', { secret, name: 'typed name' })).toMatchObject({ status: 200, value: { name: 'typed name', guest: true } });
    } finally { browser.socket.close(); }
  });
});

test('your Chrome sends the shared page’s icon for the greeting, which says whether the Chrome is online, and your own pointer over the tab for the viewers to draw, at most ten times a second', async () => {
  const { projectId } = await workspace();
  const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { protocol: 6, ip: '192.0.2.57' }, message => message.operation === 'shareTab' ? { ...page, groupId: null, icon } : message.operation === 'shareWatch' ? { ...page, width: 1280, height: 800, icon } : {});
    const pointer = (at: { x: number; y: number } | null) => browser.socket.send(JSON.stringify({ share: { event: 'pointer', shareId, at } }));
    const { shareId, secret } = await share(browser, { targetId: 'your-tab', comment: false, expiresInMinutes: 60 });
    try {
      expect(await route(shareId, 'preview', { secret })).toMatchObject({ status: 200, value: { page: { title: 'Docs', site: 'example.com', icon }, online: true } });
      // The tab moves on to a page whose icon is not a small PNG: it shows none.
      browser.socket.send(JSON.stringify({ share: { event: 'page', shareId, url: 'https://example.com/next', title: 'Next', width: 1280, height: 800, icon: 'data:image/svg+xml;base64,PHN2Zz4=' } }));
      await expect.poll(async () => (await route(shareId, 'preview', { secret })).value).toMatchObject({ page: { title: 'Next', icon: null } });

      // Mia watches: the Chrome is asked for your pointer too, and she sees where it is, the latest at most once per
      // tenth of a second.
      const mia = await watch(shareId, secret, 'Mia');
      expect(await browser.next('shareWatch')).toMatchObject({ shareId, reportPointer: true });
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
      vi.setSystemTime(Date.now() + 1000);
      pointer({ x: 0.25, y: 0.5 });
      expect(await mia.next('sharer')).toEqual({ type: 'sharer', at: { x: 0.25, y: 0.5 } });
      for (const x of [0.3, 0.35, 0.4]) pointer({ x, y: 0.5 });
      // The Chrome's messages are taken in order: this frame comes after the pointer moved.
      browser.socket.send(JSON.stringify({ shareFrame: { shareId, data: 'frame-1', width: 800, height: 500 } }));
      await mia.next('frame');
      expect(mia.received.filter(message => message.type === 'sharer')).toHaveLength(1);
      vi.advanceTimersByTime(100);
      expect(await mia.next('sharer')).toEqual({ type: 'sharer', at: { x: 0.4, y: 0.5 } });
      vi.useRealTimers();

      // Someone joining later sees it where it is now; when the Chrome goes, so does the pointer, and the greeting says
      // the Chrome is offline.
      const ana = await watch(shareId, secret, 'Ana');
      expect(await ana.next('sharer')).toEqual({ type: 'sharer', at: { x: 0.4, y: 0.5 } });
      browser.socket.close();
      expect(await mia.next('sharer')).toEqual({ type: 'sharer', at: null });
      expect(await route(shareId, 'preview', { secret })).toMatchObject({ status: 200, value: { online: false } });
      mia.socket.close();
      ana.socket.close();
    } finally { vi.useRealTimers(); if (browser.socket.readyState === WebSocket.OPEN) browser.socket.close(); }
  });
});
