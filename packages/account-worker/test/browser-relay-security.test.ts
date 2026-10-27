import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { BROWSER_EVERYTHING_MS, BROWSER_EXTENSION_PROTOCOL, BROWSER_POWERS_UPDATE, browserBase64, signRuntimeBrowserAuthorityCertificate, signRuntimeAccountBrowserGrant, signRuntimeAccountBrowserAuthorization, type BrowserEverything, type BrowserPower } from '@gitspace/protocol-runtime';
import { hostedBrowserRelay, type HostedBrowserRelay } from './fixtures/hosted-browser-relay.js';

const sockets: WebSocket[] = [];
afterEach(() => { vi.restoreAllMocks(); });
const origin = `chrome-extension://${'a'.repeat(32)}`;
const request = (ip = '192.0.2.1', suppliedOrigin = origin) => new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: suppliedOrigin, 'cf-connecting-ip': ip } });
async function keys() { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
async function connect(relay: HostedBrowserRelay, ip?: string) { const response = await relay.fetch(request(ip)); expect(response.status).toBe(101); if (!response.webSocket) throw new Error('Missing Worker WebSocket'); const socket = response.webSocket; const challenge = frame(socket); socket.accept(); sockets.push(socket); return { socket, challenge: z.object({ serverNonce: z.string() }).parse(await challenge) }; }
type Connection = { socket: WebSocket; challenge: { serverNonce: string } };
type Identity = { key: CryptoKeyPair; publicKey: string };
async function prove(connection: Connection, identity: Identity, pairing: { code: string; pairingId: string }, code = pairing.code, hello: object = {}) { const clientNonce = 'b'.repeat(64); const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${connection.challenge.serverNonce}:${clientNonce}`)))); const reply = frame(connection.socket); connection.socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code })); await reply; const ready = frame(connection.socket); connection.socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/141.0.7390.54', platform: 'Linux', protocol: BROWSER_EXTENSION_PROTOCOL, ...hello })); await ready; }
async function fixture(run: (relay: HostedBrowserRelay, state: DurableObjectState) => Promise<void>) { await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (instance, state) => { try { await run(hostedBrowserRelay(instance), state); } finally { for (const socket of sockets.splice(0)) socket.close(); } }); }
const trust = { algorithm: 'Ed25519' as const, accountId: env.ACCOUNT_ID, publicKey: 'AA==' };

test('a Chrome extension reaches the relay through the public route and is challenged', async () => {
  await env.RELAY.getByName(env.RELAY_NAME).browserRelayPair(trust);
  const response = await SELF.fetch(new URL('/api/browser-relay/extension', env.ACCOUNT_URL), { headers: { upgrade: 'websocket', origin, 'cf-connecting-ip': '192.0.2.9' } });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('Missing Worker WebSocket');
  const challenge = frame(socket); socket.accept(); sockets.push(socket);
  expect(z.object({ serverNonce: z.string() }).parse(await challenge).serverNonce).toMatch(/\S/u);
  for (const open of sockets.splice(0)) open.close();
});
test('forged browser Origin cannot enter Worker extension channel', () => fixture(async relay => { await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); expect((await relay.fetch(request(undefined, 'https://evil.test'))).status).toBe(403); }));
test('unproven candidate does not occupy the account Chrome connection', () => fixture(async relay => { await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); const first = await connect(relay); const second = await connect(relay, '192.0.2.2'); expect(first.challenge.serverNonce).not.toBe(second.challenge.serverNonce); }));
test('new extension key cannot provide agent placement before fingerprint confirmation', () => fixture(async relay => { const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); await prove(await connect(relay), await keys(), pairing); await expect(relay.placement('project', pairing.pairingId)).rejects.toThrow(/confirm/i); }));
test('expired pairing code is rejected at actual Worker channel', () => fixture(async relay => { const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); const identity = await keys(); const connection = await connect(relay); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000); const closed = new Promise<CloseEvent>(resolve => connection.socket.addEventListener('close', resolve, { once: true })); void prove(connection, identity, pairing); expect((await closed).code).toBe(1008); }));
test('multiple pairing invitations do not invalidate independent Chrome identities', () => fixture(async relay => { const first = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); const second = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); await prove(await connect(relay), await keys(), first); await prove(await connect(relay, '192.0.2.2'), await keys(), second); expect(first.pairingId).not.toBe(second.pairingId); }));
test('preauthentication admission is rate limited per IP rather than globally', () => fixture(async relay => { await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); for (let index = 0; index < 8; index++) { const response = await relay.fetch(request()); if (response.webSocket) { response.webSocket.accept(); sockets.push(response.webSocket); response.webSocket.close(); } } expect((await relay.fetch(request())).status).toBe(429); expect((await relay.fetch(request('192.0.2.99'))).status).toBe(101); }));
test('wrong pairing code closes only the offending Worker candidate', () => fixture(async relay => { const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); const connection = await connect(relay); const closed = new Promise<CloseEvent>(resolve => connection.socket.addEventListener('close', resolve, { once: true })); void prove(connection, await keys(), pairing, 'wrong-code'); expect((await closed).code).toBe(1008); }));
test('a different key cannot reclaim a bound pairing', () => fixture(async relay => { const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); const first = await connect(relay); await prove(first, await keys(), pairing); const closedFirst = new Promise<void>(resolve => first.socket.addEventListener('close', () => resolve(), { once: true })); first.socket.close(); await closedFirst; await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'); const second = await connect(relay, '192.0.2.2'); const closed = new Promise<CloseEvent>(resolve => second.socket.addEventListener('close', resolve, { once: true })); void prove(second, await keys(), pairing); expect((await closed).code).toBe(1008); }));
test('confirmed Chromes execute independently and rejecting candidates or forgetting one leaves the other usable', () => fixture(async relay => {
  const root = await keys(), workspace = await keys();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
  const browsers = [];
  for (const name of ['Chrome A', 'Chrome B']) {
    const pairing = await relay.pair({ ...trust, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
    const connection = await connect(relay, name === 'Chrome A' ? '192.0.2.10' : '192.0.2.11');
    await prove(connection, await keys(), pairing);
    const identity = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
    if (!identity || identity.state !== 'pending-confirmation') throw new Error('Expected unconfirmed identity');
    await expect(relay.confirm(pairing.pairingId, '0'.repeat(64))).rejects.toThrow('fingerprint');
    await relay.confirm(pairing.pairingId, identity.pairedKeyFingerprint);
    const settings = await relay.projectSettings('project');
    await relay.setProjectSettings('project', settings.revision, { defaultPairingId: settings.defaultPairingId ?? pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(({ pairingId }) => ({ pairingId })), { pairingId: pairing.pairingId }] });
    const placement = await relay.placement('project', pairing.pairingId);
    const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: name, source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt }, workspace.key.privateKey, authority);
    const operations: string[] = [];
    connection.socket.addEventListener('message', event => { const message = z.object({ id: z.number(), operation: z.string() }).parse(JSON.parse(String(event.data))); operations.push(message.operation); connection.socket.send(JSON.stringify({ id: message.id, result: message.operation === 'tabs' ? [{ title: name }] : {} })); });
    const execute = async () => { const attemptId = crypto.randomUUID(); return relay.execute(await signRuntimeAccountBrowserAuthorization({ scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: pairing.pairingId }, grant } }, workspace.key.privateKey, authority)); };
    browsers.push({ pairing, connection, operations, execute });
  }
  const [first, second] = browsers;
  if (!first || !second) throw new Error('Expected two browsers');
  expect(JSON.stringify(await first.execute())).toContain('Chrome A');
  expect(JSON.stringify(await second.execute())).toContain('Chrome B');
  const invitation = await relay.pair({ ...trust, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
  const intruder = await connect(relay, '192.0.2.12');
  const rejected = new Promise<CloseEvent>(resolve => intruder.socket.addEventListener('close', resolve, { once: true }));
  const badCode = await connect(relay, '192.0.2.13');
  const codeRejected = new Promise<CloseEvent>(resolve => badCode.socket.addEventListener('close', resolve, { once: true }));
  void prove(badCode, await keys(), invitation, 'wrong-code');
  expect((await codeRejected).code).toBe(1008);
  void prove(intruder, await keys(), first.pairing);
  expect((await rejected).code).toBe(1008);
  expect(JSON.stringify(await second.execute())).toContain('Chrome B');
  expect(await relay.placement('project')).toEqual(await relay.placement('project', first.pairing.pairingId));
  await relay.unpair(first.pairing.pairingId);
  await expect(first.execute()).rejects.toThrow('confirmation');
  expect(JSON.stringify(await second.execute())).toContain('Chrome B');
  expect(first.operations.filter(operation => operation === 'tabs')).toHaveLength(1);
  expect(second.operations.filter(operation => operation === 'tabs')).toHaveLength(3);
}));
test('a grant with a site at read reaches only an extension whose hello says it enforces read; an older one is told to update and gets nothing', () => fixture(async relay => {
  const root = await keys(), workspace = await keys();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
  const chrome = async (ip: string, hello: object) => {
    const pairing = await relay.pair({ ...trust, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
    const connection = await connect(relay, ip);
    await prove(connection, await keys(), pairing, pairing.code, hello);
    const identity = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
    if (!identity || identity.state !== 'pending-confirmation') throw new Error('Expected unconfirmed identity');
    await relay.confirm(pairing.pairingId, identity.pairedKeyFingerprint);
    const settings = await relay.projectSettings('project');
    await relay.setProjectSettings('project', settings.revision, { defaultPairingId: settings.defaultPairingId ?? pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(({ pairingId }) => ({ pairingId })), { pairingId: pairing.pairingId }] });
    const placement = await relay.placement('project', pairing.pairingId);
    const authorized: unknown[] = [];
    connection.socket.addEventListener('message', event => { const message = z.object({ id: z.number(), operation: z.string(), authorization: z.unknown().optional() }).parse(JSON.parse(String(event.data))); if (message.operation === 'authorize') authorized.push(message.authorization); connection.socket.send(JSON.stringify({ id: message.id, result: message.operation === 'tabs' ? [] : {} })); });
    const execute = async (read?: string[]) => {
      const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], ...(read ? { read } : {}), origins: ['example.com', 'github.com'], expiresAt }, workspace.key.privateKey, authority);
      const attemptId = crypto.randomUUID();
      return relay.execute(await signRuntimeAccountBrowserAuthorization({ scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: pairing.pairingId }, grant } }, workspace.key.privateKey, authority));
    };
    return { authorized, execute };
  };
  // An extension before 5.9 says no `siteLevels` in its hello.
  const old = await chrome('192.0.2.30', {}), current = await chrome('192.0.2.31', { siteLevels: true });
  await expect(old.execute(['github.com'])).rejects.toThrow('Update the GitSpace extension in this Chrome to 5.9 or later: this version cannot keep agents from clicking or typing on the sites this workspace approved read-only: github.com');
  expect(old.authorized).toEqual([]);
  // Without a site at read it gets the grant shape it knows.
  await old.execute();
  expect(JSON.stringify(old.authorized)).not.toContain('"read"');
  await current.execute(['github.com']);
  expect(current.authorized).toEqual([expect.objectContaining({ body: expect.objectContaining({ command: expect.objectContaining({ grant: expect.objectContaining({ body: expect.objectContaining({ read: ['github.com'] }) }) }) }) })]);
}));
test('powers and Everything reach only an extension whose hello says powers; the relay holds a grant to the approval’s powers and to the Everything you allowed, for the main agent only, until its exact expiry or End now', () => fixture(async relay => {
  const root = await keys(), workspace = await keys();
  const expiresAt = new Date(Date.now() + 2 * BROWSER_EVERYTHING_MS).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
  const chrome = async (ip: string, hello: object) => {
    const pairing = await relay.pair({ ...trust, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
    const connection = await connect(relay, ip);
    await prove(connection, await keys(), pairing, pairing.code, hello);
    const identity = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
    if (!identity || identity.state !== 'pending-confirmation') throw new Error('Expected unconfirmed identity');
    await relay.confirm(pairing.pairingId, identity.pairedKeyFingerprint);
    const settings = await relay.projectSettings('project');
    await relay.setProjectSettings('project', settings.revision, { defaultPairingId: settings.defaultPairingId ?? pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(({ pairingId, powers }) => ({ pairingId, powers })), { pairingId: pairing.pairingId, powers: ['debug'] }] });
    const placement = await relay.placement('project', pairing.pairingId);
    const authorized: unknown[] = [], notices: unknown[] = [], groupId = crypto.randomUUID();
    connection.socket.addEventListener('message', event => {
      const message = z.object({ id: z.number().optional(), operation: z.string(), authorization: z.unknown().optional() }).loose().parse(JSON.parse(String(event.data)));
      if (message.id === undefined) { notices.push(message); return; }
      if (message.operation === 'authorize') authorized.push(message.authorization);
      connection.socket.send(JSON.stringify({ id: message.id, result: message.operation === 'tabs' ? [] : {} }));
    });
    const execute = async (powers: { powers?: BrowserPower[]; everything?: BrowserEverything }, conversationKind: 'main' | 'subagent' = 'main') => {
      const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId, groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt, ...powers }, workspace.key.privateKey, authority);
      const attemptId = crypto.randomUUID(), deadlineAt = new Date(Date.now() + 60_000).toISOString();
      return relay.execute(await signRuntimeAccountBrowserAuthorization({ scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind, taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date().toISOString(), expiresAt: deadlineAt, dispatch: { version: 1, tool: 'browser', deadlineAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: pairing.pairingId }, grant } }, workspace.key.privateKey, authority));
    };
    return { pairingId: pairing.pairingId, groupId, authorized, notices, execute };
  };
  const everythingOf = async (pairingId: string) => (await relay.powers('project', 'workspace')).find(item => item.pairingId === pairingId)?.everything;
  // An extension before 5.11 says no `powers` in its hello: it never gets a grant with powers or Everything.
  const old = await chrome('192.0.2.40', { siteLevels: true }), current = await chrome('192.0.2.41', { siteLevels: true, powers: true });
  await expect(old.execute({ powers: ['debug'] })).rejects.toThrow(BROWSER_POWERS_UPDATE);
  await expect(relay.everything('project', 'workspace', old.pairingId, true)).rejects.toThrow(BROWSER_POWERS_UPDATE);
  expect(old.authorized).toEqual([]);
  expect((await relay.projectSettings('project')).browsers.map(browser => [browser.pairingId, browser.powers, browser.powersSupported])).toEqual([[old.pairingId, ['debug'], false], [current.pairingId, ['debug'], true]]);
  // A grant's powers are the approval's.
  await current.execute({ powers: ['debug'] });
  await expect(current.execute({ powers: ['debug', 'storage'] })).rejects.toThrow('Browser powers changed: storage is no longer turned on');
  // Everything is the one you allowed, for the main agent only, and the Chrome's group hears it.
  await expect(current.execute({ everything: { expiresAt: new Date(Date.now() + 60_000).toISOString() } })).rejects.toThrow('Everything ended for this workspace on this Chrome');
  const allowed = await relay.everything('project', 'workspace', current.pairingId, true);
  if (!allowed) throw new Error('Expected Everything');
  expect(Date.parse(allowed.expiresAt) - Date.now()).toBeGreaterThan(BROWSER_EVERYTHING_MS - 5000);
  await current.execute({ everything: allowed });
  await expect(current.execute({ everything: allowed }, 'subagent')).rejects.toThrow('main-agent-only');
  expect(current.notices).toContainEqual({ operation: 'everything', groupId: current.groupId, expiresAt: allowed.expiresAt });
  // It ends at its signed expiry exactly: on a millisecond before, gone at it.
  const deadline = Date.parse(allowed.expiresAt);
  vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
  expect(await everythingOf(current.pairingId)).toEqual(allowed);
  vi.spyOn(Date, 'now').mockReturnValue(deadline);
  expect(await everythingOf(current.pairingId)).toBeNull();
  vi.restoreAllMocks();
  // End now: a grant still carrying it is refused, and the group hears it ended.
  const again = await relay.everything('project', 'workspace', current.pairingId, true);
  if (!again) throw new Error('Expected Everything');
  await relay.everything('project', 'workspace', current.pairingId, false);
  await expect(current.execute({ everything: again })).rejects.toThrow('Everything ended for this workspace on this Chrome');
  expect(current.notices.at(-1)).toEqual({ operation: 'everything', groupId: current.groupId, expiresAt: null });
}));
test('a single step on a Chrome ends with a `stepEnded` notice, however it ended, only to an extension whose hello says it takes them', () => fixture(async relay => {
  const root = await keys(), workspace = await keys();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
  const chrome = async (ip: string, hello: object) => {
    const pairing = await relay.pair({ ...trust, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
    const connection = await connect(relay, ip);
    await prove(connection, await keys(), pairing, pairing.code, hello);
    const identity = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
    if (!identity || identity.state !== 'pending-confirmation') throw new Error('Expected unconfirmed identity');
    await relay.confirm(pairing.pairingId, identity.pairedKeyFingerprint);
    const settings = await relay.projectSettings('project');
    await relay.setProjectSettings('project', settings.revision, { defaultPairingId: settings.defaultPairingId ?? pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(({ pairingId }) => ({ pairingId })), { pairingId: pairing.pairingId }] });
    const placement = await relay.placement('project', pairing.pairingId);
    const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt }, workspace.key.privateKey, authority);
    const notices: unknown[] = [];
    let refuse = false;
    connection.socket.addEventListener('message', event => {
      const message = z.object({ id: z.number().optional(), operation: z.string() }).loose().parse(JSON.parse(String(event.data)));
      if (message.id === undefined) { notices.push(message); return; }
      connection.socket.send(JSON.stringify(message.operation === 'tabs' && refuse ? { id: message.id, error: { message: 'Signed group discovery required' } } : { id: message.id, result: message.operation === 'tabs' ? [] : {} }));
    });
    const step = async (refused: boolean) => {
      refuse = refused;
      const attemptId = crypto.randomUUID();
      await relay.execute(await signRuntimeAccountBrowserAuthorization({ scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: pairing.pairingId }, grant } }, workspace.key.privateKey, authority)).catch(() => {});
      return attemptId;
    };
    return { notices, step };
  };
  const old = await chrome('192.0.2.50', {}), current = await chrome('192.0.2.51', { stepEnded: true });
  const done = await current.step(false), failed = await current.step(true);
  await old.step(false);
  expect(current.notices).toEqual([{ operation: 'stepEnded', attemptId: done }, { operation: 'stepEnded', attemptId: failed }]);
  expect(old.notices).toEqual([]);
}));
test('a candidate past its pairing deadline is closed and frees its budget on the next admission', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  const idle = [];
  for (let index = 0; index < 4; index++) idle.push(await connect(relay));
  expect((await relay.fetch(request())).status).toBe(429);
  const closed = idle.map(({ socket }) => new Promise<CloseEvent>(resolve => socket.addEventListener('close', resolve, { once: true })));
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
  await connect(relay);
  for (const event of await Promise.all(closed)) expect([event.code, event.reason]).toEqual([1008, 'Pairing timed out']);
}));

test('rotating IPv6 addresses share a normalized /64 prefix budget', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  for (let index = 1; index <= 8; index++) { const connection = await connect(relay, `2001:db8:1:2::${index}`); connection.socket.close(); }
  expect((await relay.fetch(request('2001:0db8:0001:0002:ffff::1'))).status).toBe(429);
  expect((await relay.fetch(request('2001:db8:1:3::1'))).status).toBe(101);
}));

test('pending prefix cap cannot be bypassed by rotating IPv6 addresses', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  for (let index = 1; index <= 4; index++) await connect(relay, `2001:db8:2:3::${index}`);
  expect((await relay.fetch(request('2001:db8:2:3::5'))).status).toBe(429);
  await connect(relay, '2001:db8:2:4::1');
}));

test('expired admission windows are swept without permanent address storage keys', () => fixture(async (relay, state) => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  for (let index = 1; index <= 12; index++) { const connection = await connect(relay, `192.0.2.${index}`); connection.socket.close(); }
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  (await connect(relay, '198.51.100.1')).socket.close();
  const rows = await state.storage.list({ prefix: 'browser.relay.admission' });
  expect(rows.size).toBeLessThanOrEqual(1);
  expect(JSON.stringify([...rows.values()])).not.toContain('192.0.2.');
}));

test('confirmed proof is admitted despite saturated candidates and cannot be replayed', () => fixture(async relay => {
  const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'), identity = await keys();
  const first = await connect(relay);
  await prove(first, identity, pairing);
  const pending = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!pending || pending.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.confirm(pairing.pairingId, pending.pairedKeyFingerprint);
  const closed = Promise.withResolvers<CloseEvent>();
  first.socket.addEventListener('close', closed.resolve, { once: true });
  first.socket.close(); await closed.promise;
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  for (let index = 1; index <= 16; index++) await connect(relay, `198.51.100.${index}`);
  expect((await relay.fetch(request('198.51.100.99'))).status).toBe(429);
  const issuedAt = Date.now(), nonce = 'c'.repeat(64);
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${pairing.pairingId}:${pairing.generation}:${issuedAt}:${nonce}`))));
  const token = `gitspace-admission.${btoa(JSON.stringify({ pairingId: pairing.pairingId, generation: pairing.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
  const authenticated = request('198.51.100.1'); authenticated.headers.set('sec-websocket-protocol', token);
  const attacker = await keys();
  const forgedSignature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', attacker.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${pairing.pairingId}:${pairing.generation}:${issuedAt}:${nonce}`))));
  const forged = request('198.51.100.1');
  forged.headers.set('sec-websocket-protocol', `gitspace-admission.${btoa(JSON.stringify({ pairingId: pairing.pairingId, generation: pairing.generation, issuedAt, nonce, signature: forgedSignature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`);
  expect((await relay.fetch(forged)).status).toBe(403);
  const response = await relay.fetch(authenticated);
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Missing authenticated socket');
  const challenge = frame(response.webSocket); response.webSocket.accept(); sockets.push(response.webSocket);
  await prove({ socket: response.webSocket, challenge: z.object({ serverNonce: z.string() }).parse(await challenge) }, identity, pairing);
  expect((await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId)?.connected).toBe(true);
  expect((await relay.fetch(authenticated)).status).toBe(403);
}));

test('unconfirmed browser product cannot impersonate a trusted confirmation label', () => fixture(async relay => {
  const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  await prove(await connect(relay), await keys(), pairing);
  expect((await relay.status()).pairings[0]).toMatchObject({ chromeVersion: null, platform: null });
  const pending = (await relay.status()).pairings[0];
  if (!pending || pending.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.confirm(pairing.pairingId, pending.pairedKeyFingerprint);
  expect((await relay.status()).pairings[0]).toMatchObject({ chromeVersion: 141, platform: 'Linux' });
}));

test('recent admission proof remains consumed across an older rate window boundary', () => fixture(async relay => {
  const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'), identity = await keys();
  const first = await connect(relay);
  await prove(first, identity, pairing);
  const pending = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!pending || pending.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.confirm(pairing.pairingId, pending.pairedKeyFingerprint);
  const close = async (socket: WebSocket) => { const done = Promise.withResolvers<CloseEvent>(); socket.addEventListener('close', done.resolve, { once: true }); socket.close(); await done.promise; };
  await close(first.socket);
  const start = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const signedRequest = async (nonce: string) => {
    const issuedAt = Date.now();
    const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${pairing.pairingId}:${pairing.generation}:${issuedAt}:${nonce}`))));
    const token = `gitspace-admission.${btoa(JSON.stringify({ pairingId: pairing.pairingId, generation: pairing.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
    const value = request(); value.headers.set('sec-websocket-protocol', token); return value;
  };
  const consume = async (value: Request) => {
    const response = await relay.fetch(value); expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error('Missing authenticated socket');
    const challenge = frame(response.webSocket); response.webSocket.accept(); sockets.push(response.webSocket);
    await prove({ socket: response.webSocket, challenge: z.object({ serverNonce: z.string() }).parse(await challenge) }, identity, pairing);
    await close(response.webSocket);
  };
  await consume(await signedRequest('d'.repeat(64)));
  clock.mockReturnValue(start + 59_000);
  const recent = await signedRequest('e'.repeat(64)); await consume(recent);
  clock.mockReturnValue(start + 61_000);
  expect((await relay.fetch(recent)).status).toBe(403);
}));

test('a Chrome reconnecting with its key while the relay still holds its old socket replaces it and stays online', () => fixture(async relay => {
  const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'), identity = await keys();
  const first = await connect(relay);
  await prove(first, identity, pairing);
  const pending = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!pending || pending.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.confirm(pairing.pairingId, pending.pairedKeyFingerprint);
  // The old socket is still open on the relay: its Chrome went away without a close.
  const replaced = Promise.withResolvers<CloseEvent>();
  first.socket.addEventListener('close', replaced.resolve, { once: true });
  const issuedAt = Date.now(), nonce = 'f'.repeat(64);
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${pairing.pairingId}:${pairing.generation}:${issuedAt}:${nonce}`))));
  const reconnect = request('198.51.100.7');
  reconnect.headers.set('sec-websocket-protocol', `gitspace-admission.${btoa(JSON.stringify({ pairingId: pairing.pairingId, generation: pairing.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`);
  const response = await relay.fetch(reconnect);
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Missing reconnected socket');
  const challenge = frame(response.webSocket); response.webSocket.accept(); sockets.push(response.webSocket);
  await prove({ socket: response.webSocket, challenge: z.object({ serverNonce: z.string() }).parse(await challenge) }, identity, pairing);
  expect(((await replaced.promise).code)).toBe(4001);
  // The old socket's close arriving after the new hello leaves the Chrome online.
  expect((await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId)?.connected).toBe(true);
}));

test('one IPv6 /48 cannot exhaust anonymous capacity or history for another network', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  let admitted = 0;
  for (let index = 0; index < 1100; index++) {
    const response = await relay.fetch(request(`2001:db8:99:${index.toString(16)}::1`));
    if (response.webSocket) { admitted++; response.webSocket.accept(); sockets.push(response.webSocket); }
  }
  expect(admitted).toBeLessThanOrEqual(16);
  await connect(relay, '2001:db8:100::1');
}));

test('anonymous admission requires a live awaiting-key invitation', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  expect((await relay.fetch(request())).status).toBe(403);
}));

test('pending-confirmation proof cannot bypass anonymous admission', () => fixture(async relay => {
  const pairing = await relay.pair(trust, 'wss://account.test/api/browser-relay/extension'), identity = await keys();
  const first = await connect(relay); await prove(first, identity, pairing);
  const closed = frameClosed(first.socket); first.socket.close(); await closed;
  const issuedAt = Date.now(), nonce = 'f'.repeat(64);
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${pairing.pairingId}:${pairing.generation}:${issuedAt}:${nonce}`))));
  const value = request(); value.headers.set('sec-websocket-protocol', `gitspace-admission.${btoa(JSON.stringify({ pairingId: pairing.pairingId, generation: pairing.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`);
  expect((await relay.fetch(value)).status).toBe(403);
  expect((await relay.fetch(request())).status).toBe(403);
}));
function frameClosed(socket: WebSocket) { return new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true })); }

test('rotating IPv6 /64 history stays network-bounded after candidates close', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  let admitted = 0;
  for (let index = 0; index < 1100; index++) {
    const response = await relay.fetch(request(`2001:db8:90:${index.toString(16)}::1`));
    if (response.webSocket) { admitted++; response.webSocket.accept(); sockets.push(response.webSocket); const closed = frameClosed(response.webSocket); response.webSocket.close(); await closed; }
  }
  expect(admitted).toBe(32);
  expect((await relay.fetch(request('2001:db8:90:ffff::1'))).status).toBe(429);
  await connect(relay, '2001:db8:91::1');
}));

test('IPv4 /24 pending budget isolates anonymous networks', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  for (let index = 1; index <= 16; index++) await connect(relay, `198.51.100.${index}`);
  expect((await relay.fetch(request('198.51.100.17'))).status).toBe(429);
  await connect(relay, '198.51.101.1');
}));

const endpoint = 'wss://account.test/api/browser-relay/extension';

test('a short pairing code redeems its pairing’s details once, while it lasts, however it is typed, and they pair the extension’s key', () => fixture(async relay => {
  const started = await relay.start(trust);
  expect(started.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{6}$/u);
  const redeemed = await relay.redeem(` ${started.code.slice(0, 3).toLowerCase()}-${started.code.slice(3)} `, '192.0.2.10', endpoint);
  expect(redeemed).toEqual({ ok: true, value: { code: expect.any(String), pairingId: started.pairingId, generation: 1, trust, endpoint, expiresAt: started.expiresAt } });
  expect(await relay.redeem(started.code, '192.0.2.10', endpoint)).toMatchObject({ ok: false, status: 404 });
  if (!redeemed.ok) throw new Error(redeemed.message);
  await prove(await connect(relay), await keys(), redeemed.value);
  expect((await relay.status()).pairings.find(pairing => pairing.pairingId === started.pairingId)?.state).toBe('pending-confirmation');
  const late = await relay.start(trust);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  expect(await relay.redeem(late.code, '192.0.2.11', endpoint)).toMatchObject({ ok: false, status: 404 });
}));

test('wrong pairing codes are limited per code and per address: a live code tried wrongly too often is withdrawn with its pairing', () => fixture(async relay => {
  const first = await relay.start(trust);
  const wrong = first.code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
  for (let index = 0; index < 10; index++) expect(await relay.redeem(wrong, `203.0.${index}.1`, endpoint)).toMatchObject({ ok: false, status: 404 });
  expect((await relay.status()).pairings.some(pairing => pairing.pairingId === first.pairingId)).toBe(false);
  expect(await relay.redeem(first.code, '203.0.99.1', endpoint)).toMatchObject({ ok: false, status: 404 });
  // Ten wrong codes from one address: the next try from there waits, even with a right code.
  for (let index = 0; index < 10; index++) expect(await relay.redeem(wrong, '192.0.2.20', endpoint)).toMatchObject({ ok: false, status: 404 });
  const second = await relay.start(trust);
  expect(await relay.redeem(second.code, '192.0.2.20', endpoint)).toMatchObject({ ok: false, status: 429 });
  expect(await relay.redeem(second.code, '198.51.100.20', endpoint)).toMatchObject({ ok: true, value: { pairingId: second.pairingId } });
}));

test('text that cannot be a pairing code is refused without counting against the address or any code', () => fixture(async relay => {
  const started = await relay.start(trust);
  for (let index = 0; index < 12; index++) expect(await relay.redeem('not a code', '192.0.2.30', endpoint)).toMatchObject({ ok: false, status: 400 });
  expect(await relay.redeem(started.code, '192.0.2.30', endpoint)).toMatchObject({ ok: true, value: { pairingId: started.pairingId } });
}));

test('the extension redeems a pairing code through the public route, from an extension origin only', async () => {
  const started = await env.RELAY.getByName(env.RELAY_NAME).browserRelayPair(trust);
  const post = (supplied: string) => SELF.fetch(new URL('/api/browser-relay/pairing-code', env.ACCOUNT_URL), { method: 'POST', headers: { 'content-type': 'application/json', origin: supplied, 'cf-connecting-ip': '192.0.2.40' }, body: JSON.stringify({ code: started.code }) });
  expect((await post('https://evil.test')).status).toBe(403);
  const response = await post(origin);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', value: { pairingId: started.pairingId, endpoint: new URL('/api/browser-relay/extension', env.ACCOUNT_URL).href.replace(/^http/u, 'ws') } });
});

test('the account counts the workspaces whose cloud browser is open: a closed one leaves, and one not heard from for ten minutes is forgotten', async () => {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async relay => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
      for (const session of ['account:project:one', 'account:project:two', 'account:project:three']) await relay.browserRelayCloudOpen(session, true);
      await relay.browserRelayCloudOpen('account:project:two', false);
      expect((await relay.browserRelayStatus()).cloudWorkspaces).toBe(2);
      vi.setSystemTime(new Date('2026-10-25T12:06:00.000Z'));
      // Still in use: its session says so again.
      await relay.browserRelayCloudOpen('account:project:one', true);
      vi.setSystemTime(new Date('2026-10-25T12:11:00.000Z'));
      expect((await relay.browserRelayStatus()).cloudWorkspaces).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});
