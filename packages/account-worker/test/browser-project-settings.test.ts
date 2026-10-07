import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { browserBase64, signRuntimeBrowserAuthorityCertificate, signRuntimeAccountBrowserGrant, signRuntimeAccountBrowserAuthorization } from '@gitspace/protocol-runtime';
import { AccountBrowserRelay } from '../src/browser-relay.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Chrome = { pairingId: string; generation: number; socket: WebSocket; operations: string[]; revoked: string[]; failRevoke: boolean; reconnect(): Promise<void>; pauseAuthorization(): { reached: Promise<void>; release(): void } };
async function keys() { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
async function fixture(run: (relay: AccountBrowserRelay, chrome: (name: string) => Promise<Chrome>, root: Identity, restart: () => AccountBrowserRelay) => Promise<void>) {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (_instance, state) => {
    let relay = new AccountBrowserRelay(state, { ACCOUNT_ID: 'account' });
    const root = await keys(), sockets: WebSocket[] = [];
    async function chrome(name: string) {
      const pairing = await relay.pair({ algorithm: 'Ed25519', accountId: 'account', publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
      const response = await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': `192.0.2.${sockets.length + 1}` } }));
      if (!response.webSocket) throw new Error('Missing socket');
      const socket = response.webSocket, challenge = frame(socket); sockets.push(socket); socket.accept();
      const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
      const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
      const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
      const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: name })); await ready;
      const status = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
      if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
      await relay.confirm(pairing.pairingId, status.pairedKeyFingerprint);
      const operations: string[] = [], revoked: string[] = [];
      let paused: { reached: () => void; resume: Promise<void> } | undefined;
      const browser: Chrome = { pairingId: pairing.pairingId, generation: pairing.generation, socket, operations, revoked, failRevoke: false, async reconnect() {
        if (browser.socket.readyState !== WebSocket.CLOSED) { const closed = new Promise<void>(resolve => browser.socket.addEventListener('close', () => resolve(), { once: true })); browser.socket.close(); await closed; }
        const issuedAt = Date.now(), nonce = crypto.randomUUID().replaceAll('-', '').repeat(2);
        const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${pairing.pairingId}:${pairing.generation}:${issuedAt}:${nonce}`))));
        const token = `gitspace-admission.${btoa(JSON.stringify({ pairingId: pairing.pairingId, generation: pairing.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
        const response = await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': '192.0.2.200', 'sec-websocket-protocol': token } }));
        if (!response.webSocket) throw new Error('Missing reconnect socket');
        browser.socket = response.webSocket; sockets.push(browser.socket);
        const challenge = frame(browser.socket); browser.socket.accept();
        const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge);
        const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
        const paired = frame(browser.socket); browser.socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof })); await paired;
        const ready = frame(browser.socket); browser.socket.send(JSON.stringify({ hello: true, Browser: name })); await ready;
        listen(browser.socket);
      }, pauseAuthorization() { const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); paused = { reached: () => reached.resolve(), resume: resume.promise }; return { reached: reached.promise, release: () => resume.resolve() }; } };
      function listen(active: WebSocket) { active.addEventListener('message', async event => {
        const message = z.object({ id: z.number(), operation: z.string(), groupId: z.string().optional() }).parse(JSON.parse(String(event.data)));
        operations.push(message.operation);
        if (message.operation === 'authorize' && paused) { paused.reached(); await paused.resume; }
        if (message.operation === 'revoke' && browser.failRevoke) { active.send(JSON.stringify({ id: message.id, error: { message: 'Chrome temporarily failed closure' } })); return; }
        if (message.operation === 'revoke' && message.groupId) revoked.push(message.groupId);
        active.send(JSON.stringify({ id: message.id, result: message.operation === 'tabs' ? [{ title: name }] : {} }));
      }); }
      listen(socket);
      return browser;
    }
    try { await run(relay, chrome, root, () => { relay = new AccountBrowserRelay(state, { ACCOUNT_ID: 'account' }); return relay; }); } finally { for (const socket of sockets) socket.close(); }
  });
}
async function authorization(root: Identity, pairing: { pairingId: string; generation: number; approvalId?: string }, workspaceId = 'workspace', projectId = 'project') {
  const workspace = await keys(), expiresAt = new Date(Date.now() + 60_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId, workspaceId, publicKey: workspace.publicKey, issuedAt, expiresAt }, root.key.privateKey);
  const placement = { kind: 'account-relay' as const, accountId: 'account', pairingId: pairing.pairingId, generation: pairing.generation, ...(pairing.approvalId ? { approvalId: pairing.approvalId } : {}) };
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', origins: ['example.com'], expiresAt }, workspace.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  return signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: pairing.pairingId }, grant } }, workspace.key.privateKey, authority);
}

test('confirmed Chrome rejects signed unapproved project dispatch before any extension operation', () => fixture(async (relay, chrome, root) => {
  const browser = await chrome('Private');
  await expect(relay.execute(await authorization(root, browser))).rejects.toThrow(/project.*approv|approv.*project/i);
  expect(browser.operations).toEqual([]);
}));
test('independent project defaults permit two approved Chromes in one workspace', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, name: 'Work', note: 'Production' }, { pairingId: b.pairingId, name: 'Test', note: 'Sandbox' }] });
  await relay.setProjectSettings('other-project', 0, { defaultPairingId: b.pairingId, approvals: [{ pairingId: b.pairingId, name: 'Other project', note: '' }] });
  expect((await relay.placement('other-project')).pairingId).toBe(b.pairingId);
  expect((await relay.placement('project')).pairingId).toBe(a.pairingId);
  expect((await relay.execute(await authorization(root, await relay.placement('project', a.pairingId)))).browser).toEqual({ pairingId: a.pairingId, name: 'Work' });
  expect(JSON.stringify(await relay.execute(await authorization(root, await relay.placement('project', b.pairingId))))).toContain('B');
  await expect(relay.placement('other-project', a.pairingId)).rejects.toThrow(/approv/i);
}));
test('project revocation rejects saved grants across workspaces while preserving sibling Chrome', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, name: 'A', note: '' }, { pairingId: b.pairingId, name: 'B', note: '' }] });
  const placement = await relay.placement('project', a.pairingId);
  const first = await authorization(root, placement, 'first'), second = await authorization(root, placement, 'second');
  await relay.setProjectSettings('project', 1, { defaultPairingId: b.pairingId, approvals: [{ pairingId: b.pairingId, name: 'B', note: '' }] });
  await expect(relay.execute(first)).rejects.toThrow(/approv/i); await expect(relay.execute(second)).rejects.toThrow(/approv/i);
  expect(JSON.stringify(await relay.execute(await authorization(root, await relay.placement('project', b.pairingId))))).toContain('B'); expect(a.operations).toEqual([]);
}));
test('offline approved Chrome remains discoverable and refuses dispatch without fallback', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, name: 'Work', note: 'Local Chrome' }, { pairingId: b.pairingId, name: 'Other', note: '' }] });
  const pending = await authorization(root, await relay.placement('project', a.pairingId));
  const closed = new Promise<void>(resolve => a.socket.addEventListener('close', () => resolve(), { once: true })); a.socket.close(); await closed;
  expect((await relay.projectSettings('project')).browsers).toContainEqual({ pairingId: a.pairingId, generation: a.generation, name: 'Work', note: 'Local Chrome', connected: false, approved: true });
  await expect(relay.placement('project')).rejects.toThrow(/connected|unavailable/i); await expect(relay.execute(pending)).rejects.toThrow(/connected|unavailable/i); expect(b.operations).toEqual([]);
}));
test('project settings reject stale concurrent update and unconfirmed identities', () => fixture(async (relay, chrome) => {
  const browser = await chrome('A'); const preferences = { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, name: 'A', note: '' }] };
  const results = await Promise.allSettled([relay.setProjectSettings('project', 0, preferences), relay.setProjectSettings('project', 0, { defaultPairingId: null, approvals: [] })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await relay.projectSettings('other-project')).browsers.every(browser => !browser.approved)).toBe(true);
  await expect(relay.setProjectSettings('other-project', 0, { defaultPairingId: null, approvals: [{ pairingId: crypto.randomUUID(), name: 'Unknown', note: '' }] })).rejects.toThrow(/confirm/i);
}));
test('personal project approvals cannot authorize another relay owner', () => fixture(async (relay, chrome) => {
  const browser = await chrome('Owner A');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, name: 'Personal', note: 'Only mine' }] });
  await fixture(async other => {
    expect((await other.projectSettings('project')).browsers).toEqual([]);
    await expect(other.placement('project', browser.pairingId)).rejects.toThrow(/confirm|approv/i);
  });
}));
test('project revocation during extension authorization prevents the subsequent tab read', () => fixture(async (relay, chrome, root) => {
  const browser = await chrome('Private');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, name: 'Private', note: '' }] });
  const paused = browser.pauseAuthorization(), pending = relay.execute(await authorization(root, await relay.placement('project', browser.pairingId)));
  await paused.reached;
  await relay.setProjectSettings('project', 1, { defaultPairingId: null, approvals: [] });
  const rejection = expect(pending).rejects.toThrow(/approv|revoked/i); paused.release(); await rejection;
  expect(browser.operations).not.toContain('tabs');
}));
test('reapproving Chrome creates fresh authority while preserving sibling authority and rejecting old grants', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  const approvalA = { pairingId: a.pairingId, name: 'A', note: '' }, approvalB = { pairingId: b.pairingId, name: 'B', note: '' };
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [approvalA, approvalB] });
  const before = await relay.placement('project', a.pairingId), sibling = await relay.placement('project', b.pairingId);
  const old = await authorization(root, before); await relay.execute(old);
  await relay.setProjectSettings('project', 1, { defaultPairingId: b.pairingId, approvals: [approvalB] });
  await relay.setProjectSettings('project', 2, { defaultPairingId: a.pairingId, approvals: [approvalA, approvalB] });
  const after = await relay.placement('project', a.pairingId);
  expect(after).not.toEqual(before);
  expect(await relay.placement('project', b.pairingId)).toEqual(sibling);
  await expect(relay.execute(old)).rejects.toThrow(/revoked|approv/i);
  expect(JSON.stringify(await relay.execute(await authorization(root, after)))).toContain('A');
}));

test('project removal closes only affected Chrome groups and retries failed closure after reconnect', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  const approvalA = { pairingId: a.pairingId, name: 'A', note: '' }, approvalB = { pairingId: b.pairingId, name: 'B', note: '' };
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [approvalA, approvalB] });
  await relay.setProjectSettings('other', 0, { defaultPairingId: a.pairingId, approvals: [approvalA] });
  const first = await authorization(root, await relay.placement('project', a.pairingId));
  const second = await authorization(root, await relay.placement('project', a.pairingId), 'second');
  const other = await authorization(root, await relay.placement('other', a.pairingId), 'other-workspace', 'other');
  const sibling = await authorization(root, await relay.placement('project', b.pairingId));
  for (const value of [first, second, other, sibling]) await relay.execute(value);
  a.failRevoke = true;
  await relay.setProjectSettings('project', 1, { defaultPairingId: b.pairingId, approvals: [approvalB] });
  expect(a.operations.filter(operation => operation === 'revoke')).toHaveLength(2);
  await expect(relay.execute(first)).rejects.toThrow(/approv|revoked/i);
  a.failRevoke = false; await a.reconnect();
  await expect.poll(() => a.revoked.length).toBe(2);
  for (const value of [first, second]) { if (value.body.command.type !== 'execute') throw new Error('Expected execution'); expect(a.revoked).toContain(value.body.command.grant.body.groupId); }
  expect(b.revoked).toEqual([]);
  if (other.body.scope.placement.kind !== 'account-relay' || sibling.body.scope.placement.kind !== 'account-relay') throw new Error('Expected account relay placement');
  expect(JSON.stringify(await relay.execute(await authorization(root, other.body.scope.placement, 'other-workspace', 'other')))).toContain('A');
  expect(JSON.stringify(await relay.execute(await authorization(root, sibling.body.scope.placement)))).toContain('B');
  await expect(relay.execute(second)).rejects.toThrow(/approv|revoked/i);
}));

test('connected project removal acknowledges extension group closure', () => fixture(async (relay, chrome, root) => {
  const browser = await chrome('A');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, name: 'A', note: '' }] });
  const value = await authorization(root, await relay.placement('project'));
  await relay.execute(value);
  await relay.setProjectSettings('project', 1, { defaultPairingId: null, approvals: [] });
  if (value.body.command.type !== 'execute') throw new Error('Expected execution');
  expect(browser.revoked).toEqual([value.body.command.grant.body.groupId]);
}));

test('offline project removal survives relay restart and closes groups on hello', () => fixture(async (relay, chrome, root, restart) => {
  const browser = await chrome('Offline');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, name: 'Offline', note: '' }] });
  const value = await authorization(root, await relay.placement('project'));
  await relay.execute(value);
  const closed = new Promise<void>(resolve => browser.socket.addEventListener('close', () => resolve(), { once: true })); browser.socket.close(); await closed;
  await relay.setProjectSettings('project', 1, { defaultPairingId: null, approvals: [] });
  const recovered = restart();
  await browser.reconnect();
  await expect.poll(() => browser.revoked.length).toBe(1);
  if (value.body.command.type !== 'execute') throw new Error('Expected execution');
  expect(browser.revoked).toEqual([value.body.command.grant.body.groupId]);
  await expect(recovered.execute(value)).rejects.toThrow(/approv|revoked/i);
}));
