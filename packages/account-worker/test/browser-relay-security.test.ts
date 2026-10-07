import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { browserBase64, signRuntimeBrowserAuthorityCertificate, signRuntimeAccountBrowserGrant, signRuntimeAccountBrowserAuthorization } from '@gitspace/protocol-runtime';
import { AccountBrowserRelay } from '../src/browser-relay.js';

const sockets: WebSocket[] = [];
afterEach(() => { vi.restoreAllMocks(); });
const origin = `chrome-extension://${'a'.repeat(32)}`;
const request = (ip = '192.0.2.1', suppliedOrigin = origin) => new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: suppliedOrigin, 'cf-connecting-ip': ip } });
async function keys() { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
async function connect(relay: AccountBrowserRelay, ip?: string) { const response = await relay.fetch(request(ip)); expect(response.status).toBe(101); if (!response.webSocket) throw new Error('Missing Worker WebSocket'); const socket = response.webSocket; const challenge = frame(socket); socket.accept(); sockets.push(socket); return { socket, challenge: z.object({ serverNonce: z.string() }).parse(await challenge) }; }
type Connection = { socket: WebSocket; challenge: { serverNonce: string } };
type Identity = { key: CryptoKeyPair; publicKey: string };
async function prove(connection: Connection, identity: Identity, pairing: { code: string; pairingId: string }, code = pairing.code) { const clientNonce = 'b'.repeat(64); const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${connection.challenge.serverNonce}:${clientNonce}`)))); const reply = frame(connection.socket); connection.socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code })); await reply; const ready = frame(connection.socket); connection.socket.send(JSON.stringify({ hello: true, Browser: 'Security fixture Chrome' })); await ready; }
async function fixture(run: (relay: AccountBrowserRelay) => Promise<void>) { await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (_instance, state) => { const relay = new AccountBrowserRelay(state, { ACCOUNT_ID: 'account' }); try { await run(relay); } finally { for (const socket of sockets.splice(0)) socket.close(); } }); }
const trust = { algorithm: 'Ed25519' as const, accountId: 'account', publicKey: 'AA==' };

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
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
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
    await relay.setProjectSettings('project', settings.revision, { defaultPairingId: settings.defaultPairingId ?? pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(({ pairingId, name, note }) => ({ pairingId, name, note })), { pairingId: pairing.pairingId, name, note: '' }] });
    const placement = await relay.placement('project', pairing.pairingId);
    const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: name, source: 'relay', origins: ['example.com'], expiresAt }, workspace.key.privateKey, authority);
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
test('idle preauthentication candidates expire without blocking later admission', () => fixture(async relay => {
  await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
  const connection = await connect(relay);
  const start = Date.now();
  const closed = new Promise<CloseEvent>(resolve => connection.socket.addEventListener('close', resolve, { once: true }));
  expect((await closed).code).toBe(1008);
  expect(Date.now() - start).toBeLessThan(6500);
  await connect(relay, '192.0.2.50');
}), 10_000);

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

test('expired admission windows are swept without permanent address storage keys', async () => {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (_instance, state) => {
    const relay = new AccountBrowserRelay(state, { ACCOUNT_ID: 'account' });
    try {
    await relay.pair(trust, 'wss://account.test/api/browser-relay/extension');
    for (let index = 1; index <= 12; index++) { const connection = await connect(relay, `192.0.2.${index}`); connection.socket.close(); }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    (await connect(relay, '198.51.100.1')).socket.close();
    const rows = await state.storage.list({ prefix: 'browser.relay.admission' });
    expect(rows.size).toBeLessThanOrEqual(1);
    expect(JSON.stringify([...rows.values()])).not.toContain('192.0.2.');
    } finally { for (const socket of sockets.splice(0)) socket.close(); }
  });
});

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
  expect((await relay.status()).pairings[0]?.browser).toBeNull();
  const pending = (await relay.status()).pairings[0];
  if (!pending || pending.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.confirm(pairing.pairingId, pending.pairedKeyFingerprint);
  expect((await relay.status()).pairings[0]?.browser).toBe('Security fixture Chrome');
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
