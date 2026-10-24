import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { BROWSER_EXTENSION_PROTOCOL, browserBase64, signRuntimeBrowserAuthorityCertificate, signRuntimeAccountBrowserGrant, signRuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserAuthorizationBody, type RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { AccountBrowserRelay, type BrowserWorkspaces } from '../src/browser-relay.js';
import { browserShareAccount } from '../src/browser-share.js';
import { hostedBrowserRelay, type HostedBrowserRelay } from './fixtures/hosted-browser-relay.js';
import { workspaceDrive } from '../src/workspace-drive.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Chrome = { pairingId: string; generation: number; socket: WebSocket; ready: unknown; operations: string[]; revoked: string[]; failRevoke: boolean; reconnect(): Promise<void>; pauseAuthorization(): { reached: Promise<void>; release(): void } };
async function keys() { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
/** `restart` swaps in a relay object with no memory over the same storage and sockets; the live relay keeps serving
 * the extension sockets, as a relay woken from hibernation would. */
async function fixture(run: (relay: HostedBrowserRelay, chrome: (name: string, hello?: object) => Promise<Chrome>, root: Identity, restart: (workspaces?: BrowserWorkspaces) => AccountBrowserRelay, sockets: () => WebSocket[]) => Promise<void>) {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (instance, state) => {
    let relay: HostedBrowserRelay = hostedBrowserRelay(instance);
    const root = await keys(), sockets: WebSocket[] = [];
    async function chrome(name: string, hello: object = {}) {
      const pairing = await relay.pair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
      const response = await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': `192.0.2.${sockets.length + 1}` } }));
      if (!response.webSocket) throw new Error('Missing socket');
      const socket = response.webSocket, challenge = frame(socket); sockets.push(socket); socket.accept();
      const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
      const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
      const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
      const readyFrame = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: name, protocol: BROWSER_EXTENSION_PROTOCOL, ...hello })); const ready = await readyFrame;
      const status = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
      if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
      await relay.confirm(pairing.pairingId, status.pairedKeyFingerprint);
      const operations: string[] = [], revoked: string[] = [];
      let paused: { reached: () => void; resume: Promise<void> } | undefined;
      const browser: Chrome = { pairingId: pairing.pairingId, generation: pairing.generation, socket, ready, operations, revoked, failRevoke: false, async reconnect() {
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
        const ready = frame(browser.socket); browser.socket.send(JSON.stringify({ hello: true, Browser: name, protocol: BROWSER_EXTENSION_PROTOCOL })); await ready;
        listen(browser.socket);
      }, pauseAuthorization() { const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); paused = { reached: () => reached.resolve(), resume: resume.promise }; return { reached: reached.promise, release: () => resume.resolve() }; } };
      function listen(active: WebSocket) { active.addEventListener('message', async event => {
        const message = z.object({ id: z.number(), operation: z.string(), groupId: z.string().optional() }).parse(JSON.parse(String(event.data)));
        operations.push(message.operation);
        if (message.operation === 'authorize' && paused) { paused.reached(); await paused.resume; }
        if (message.operation === 'revoke' && browser.failRevoke) { active.send(JSON.stringify({ id: message.id, error: { message: 'Chrome temporarily failed closure' } })); return; }
        if (message.operation === 'revoke' && message.groupId) revoked.push(message.groupId);
        active.send(JSON.stringify({ id: message.id, result: message.operation === 'tabs' ? [{ title: name }] : message.operation === 'preview' ? { image: 'jpeg-bytes', reason: null } : {} }));
      }); }
      listen(socket);
      return browser;
    }
    try { await run(relay, chrome, root, workspaces => { const restarted = new AccountBrowserRelay(state, { ACCOUNT_ID: env.ACCOUNT_ID, SPACE_AUTHORITY: workspaces ?? env.SPACE_AUTHORITY }, identity => workspaceDrive(env, identity), browserShareAccount(env)); relay = restarted; return restarted; }, () => state.getWebSockets('browser')); } finally { for (const socket of sockets) socket.close(); }
  });
}
async function authorization(root: Identity, pairing: { pairingId: string; generation: number; approvalId?: string }, workspaceId = 'workspace', projectId = 'project', manage?: Extract<RuntimeAccountBrowserAuthorizationBody['command'], { type: 'manage' }>, args: RuntimeBrowserArguments = { action: 'tabs', source: 'relay', pairingId: pairing.pairingId }) {
  const workspace = await keys(), expiresAt = new Date(Date.now() + 60_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: workspace.publicKey, issuedAt, expiresAt }, root.key.privateKey);
  const placement = { kind: 'account-relay' as const, accountId: env.ACCOUNT_ID, pairingId: pairing.pairingId, generation: pairing.generation, ...(pairing.approvalId ? { approvalId: pairing.approvalId } : {}) };
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt }, workspace.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  return signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: manage ? 'browser_control' : 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: manage ?? { type: 'execute', args, grant } }, workspace.key.privateKey, authority);
}

test('confirmed Chrome rejects signed unapproved project dispatch before any extension operation', () => fixture(async (relay, chrome, root) => {
  const browser = await chrome('Private');
  await expect(relay.execute(await authorization(root, browser))).rejects.toThrow(/project.*approv|approv.*project/i);
  expect(browser.operations).toEqual([]);
}));
test('independent project defaults permit two approved Chromes in one workspace', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  await relay.rename(a.pairingId, 'Work');
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, note: 'Production' }, { pairingId: b.pairingId, note: 'Sandbox' }] });
  await relay.setProjectSettings('other-project', 0, { defaultPairingId: b.pairingId, approvals: [{ pairingId: b.pairingId, note: '' }] });
  expect((await relay.placement('other-project')).pairingId).toBe(b.pairingId);
  expect((await relay.placement('project')).pairingId).toBe(a.pairingId);
  expect((await relay.execute(await authorization(root, await relay.placement('project', a.pairingId)))).browser).toEqual({ pairingId: a.pairingId, name: 'Work' });
  expect(JSON.stringify(await relay.execute(await authorization(root, await relay.placement('project', b.pairingId))))).toContain('B');
  await expect(relay.placement('other-project', a.pairingId)).rejects.toThrow(/approv/i);
}));
test('project revocation rejects saved grants across workspaces while preserving sibling Chrome', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, note: '' }, { pairingId: b.pairingId, note: '' }] });
  const placement = await relay.placement('project', a.pairingId);
  const first = await authorization(root, placement, 'first'), second = await authorization(root, placement, 'second');
  await relay.setProjectSettings('project', 1, { defaultPairingId: b.pairingId, approvals: [{ pairingId: b.pairingId, note: '' }] });
  await expect(relay.execute(first)).rejects.toThrow(/approv/i); await expect(relay.execute(second)).rejects.toThrow(/approv/i);
  expect(JSON.stringify(await relay.execute(await authorization(root, await relay.placement('project', b.pairingId))))).toContain('B'); expect(a.operations).toEqual([]);
}));
test('offline approved Chrome remains discoverable and refuses dispatch without fallback', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  await relay.rename(a.pairingId, 'Work');
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, note: 'Local Chrome' }, { pairingId: b.pairingId, note: '' }] });
  const pending = await authorization(root, await relay.placement('project', a.pairingId));
  const closed = new Promise<void>(resolve => a.socket.addEventListener('close', () => resolve(), { once: true })); a.socket.close(); await closed;
  expect((await relay.projectSettings('project')).browsers).toContainEqual({ pairingId: a.pairingId, generation: a.generation, name: 'Work', note: 'Local Chrome', connected: false, approved: true });
  const other = `"Chrome ${b.pairingId.slice(0, 8)}" (${b.pairingId}, online)`;
  await expect(relay.placement('project')).rejects.toThrow(`"Work" (${a.pairingId}) is approved but offline: its GitSpace extension is not connected. Ask the user to open that Chrome, or pass another approved pairingId: ${other}.`);
  await expect(relay.execute(pending)).rejects.toThrow(`"Work" (${a.pairingId}) is approved but offline: its GitSpace extension is not connected. Ask the user to open that Chrome.`); expect(b.operations).toEqual([]);
}));
test('project settings reject stale concurrent update and unconfirmed identities', () => fixture(async (relay, chrome) => {
  const browser = await chrome('A'); const preferences = { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] };
  const results = await Promise.allSettled([relay.setProjectSettings('project', 0, preferences), relay.setProjectSettings('project', 0, { defaultPairingId: null, approvals: [] })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await relay.projectSettings('other-project')).browsers.every(browser => !browser.approved)).toBe(true);
  await expect(relay.setProjectSettings('other-project', 0, { defaultPairingId: null, approvals: [{ pairingId: crypto.randomUUID(), note: '' }] })).rejects.toThrow(/confirm/i);
}));
test('personal project approvals cannot authorize another relay owner', () => fixture(async (relay, chrome) => {
  const browser = await chrome('Owner A');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: 'Only mine' }] });
  await fixture(async other => {
    expect((await other.projectSettings('project')).browsers).toEqual([]);
    await expect(other.placement('project', browser.pairingId)).rejects.toThrow('No Chrome is paired with this account');
  });
}));
test('project revocation during extension authorization prevents the subsequent tab read', () => fixture(async (relay, chrome, root) => {
  const browser = await chrome('Private');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] });
  const paused = browser.pauseAuthorization(), pending = relay.execute(await authorization(root, await relay.placement('project', browser.pairingId)));
  await paused.reached;
  await relay.setProjectSettings('project', 1, { defaultPairingId: null, approvals: [] });
  const rejection = expect(pending).rejects.toThrow(/approv|revoked/i); paused.release(); await rejection;
  expect(browser.operations).not.toContain('tabs');
}));
test('reapproving Chrome creates fresh authority while preserving sibling authority and rejecting old grants', () => fixture(async (relay, chrome, root) => {
  const a = await chrome('A'), b = await chrome('B');
  const approvalA = { pairingId: a.pairingId, note: '' }, approvalB = { pairingId: b.pairingId, note: '' };
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
  const approvalA = { pairingId: a.pairingId, note: '' }, approvalB = { pairingId: b.pairingId, note: '' };
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
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] });
  const value = await authorization(root, await relay.placement('project'));
  await relay.execute(value);
  await relay.setProjectSettings('project', 1, { defaultPairingId: null, approvals: [] });
  if (value.body.command.type !== 'execute') throw new Error('Expected execution');
  expect(browser.revoked).toEqual([value.body.command.grant.body.groupId]);
}));

test('offline project removal survives relay restart and closes groups on hello', () => fixture(async (relay, chrome, root, restart) => {
  const browser = await chrome('Offline');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] });
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

test('the relay records the extension version and protocol each browser reports, answers with its own, and refuses one too old', () => fixture(async (relay, chrome) => {
  const unversioned = await chrome('Chrome/128', { protocol: undefined });
  const previous = await chrome('Chrome/129', { protocol: BROWSER_EXTENSION_PROTOCOL - 1 });
  const current = await chrome('Chrome/130', { protocol: BROWSER_EXTENSION_PROTOCOL, extension: '5.1.0' });
  expect(unversioned.ready).toEqual({ updateRequired: { protocol: 0, minimum: BROWSER_EXTENSION_PROTOCOL - 1 } });
  expect(previous.ready).toEqual({ ready: true, protocol: BROWSER_EXTENSION_PROTOCOL });
  expect(current.ready).toEqual({ ready: true, protocol: BROWSER_EXTENSION_PROTOCOL });
  const extensions = Object.fromEntries((await relay.status()).pairings.map(pairing => [pairing.pairingId, pairing.extension]));
  expect(extensions[unversioned.pairingId]).toEqual({ version: null, protocol: 0, updateRequired: true });
  expect(extensions[previous.pairingId]).toEqual({ version: null, protocol: BROWSER_EXTENSION_PROTOCOL - 1, updateRequired: false });
  expect(extensions[current.pairingId]).toEqual({ version: '5.1.0', protocol: BROWSER_EXTENSION_PROTOCOL, updateRequired: false });
}));

test('retiring a workspace closes its Chrome groups and leaves other workspaces their own', () => fixture(async (relay, chrome, root) => {
  const browser = await chrome('A');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] });
  const archived = await authorization(root, await relay.placement('project'));
  const kept = await authorization(root, await relay.placement('project'), 'kept');
  for (const value of [archived, kept]) await relay.execute(value);
  if (archived.body.command.type !== 'execute' || kept.body.scope.placement.kind !== 'account-relay') throw new Error('Expected relay execution');
  await relay.retireWorkspace('project', 'workspace');
  expect(browser.revoked).toEqual([archived.body.command.grant.body.groupId]);
  await expect(relay.execute(archived)).rejects.toThrow(/revoked/i);
  expect(JSON.stringify(await relay.execute(await authorization(root, kept.body.scope.placement, 'kept')))).toContain('A');
}));

test('a Chrome group report reaches its workspace with each tab marked usable or not, and its running scripts', () => fixture(async (relay, chrome, root, restart, sockets) => {
  const browser = await chrome('A');
  await relay.rename(browser.pairingId, 'Work Chrome');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] });
  const value = await authorization(root, await relay.placement('project'));
  await relay.execute(value);
  if (value.body.command.type !== 'execute') throw new Error('Expected execution');
  const groupId = value.body.command.grant.body.groupId;
  const reports: unknown[] = [];
  const reader = restart({ getByName: name => ({ browserGroupReported: async (identity, group) => { reports.push({ name, identity, group }); }, pageCommentAdded: async () => {} }) });
  const [socket] = sockets();
  if (!socket) throw new Error('Missing extension socket');
  const tab = (targetId: string, url: string, addedBy: 'agent' | 'page' | 'you', site: string | null) => ({ targetId, url, title: 'Page', addedBy, site });
  await reader.webSocketMessage(socket, JSON.stringify({ group: { groupId: crypto.randomUUID(), tabs: [], running: 0 } }));
  await reader.webSocketMessage(socket, JSON.stringify({ group: { groupId, tabs: [
    tab('agent-tab', 'https://example.com/pricing', 'agent', null),
    tab('your-tab', 'https://news.example/story', 'you', 'news.example'),
    tab('popup', 'https://elsewhere.example/', 'page', null),
  ], running: 2 } }));
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ name: `${env.ACCOUNT_ID}:workspace`, identity: { projectId: 'project', workspaceId: 'workspace' }, group: {
    groupId, pairingId: browser.pairingId, browser: 'Work Chrome', origins: ['example.com'], running: 2,
    tabs: [{ targetId: 'agent-tab', usable: true }, { targetId: 'your-tab', usable: true }, { targetId: 'popup', usable: false }],
  } });
}));

test('a script run on your Chrome records its group, so the Chrome’s reports of that group reach the workspace', () => fixture(async (relay, chrome, root, restart, sockets) => {
  const browser = await chrome('A');
  await relay.setProjectSettings('project', 0, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId, note: '' }] });
  const value = await authorization(root, await relay.placement('project'), 'workspace', 'project', undefined, { action: 'run', source: 'relay', pairingId: browser.pairingId, script: 'return 1;' });
  if (value.body.command.type !== 'execute') throw new Error('Expected execution');
  const groupId = value.body.command.grant.body.groupId;
  await relay.scriptBegin(value);
  const reports: unknown[] = [];
  const reader = restart({ getByName: () => ({ browserGroupReported: async (_identity, group) => { reports.push(group); }, pageCommentAdded: async () => {} }) });
  const [socket] = sockets();
  if (!socket) throw new Error('Missing extension socket');
  await reader.webSocketMessage(socket, JSON.stringify({ group: { groupId, tabs: [{ targetId: 'agent-tab', url: 'https://example.com/', title: 'Example', addedBy: 'agent', site: null }], running: 1 } }));
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ groupId, running: 1, tabs: [{ targetId: 'agent-tab', usable: true }] });
}));

test('a forgotten default Chrome is no default: approving its replacement makes it the default and relay uses it', () => fixture(async (relay, chrome) => {
  const old = await chrome('Old');
  await relay.setProjectSettings('project', 0, { defaultPairingId: old.pairingId, approvals: [{ pairingId: old.pairingId, note: '' }] });
  await relay.unpair(old.pairingId);
  const replacement = await chrome('New');
  const settings = await relay.projectSettings('project');
  expect(settings.defaultPairingId).toBeNull();
  // What Plugins → Browsers sends when you approve the replacement: the project's default, else the replacement.
  await relay.setProjectSettings('project', settings.revision, { defaultPairingId: settings.defaultPairingId ?? replacement.pairingId, approvals: [{ pairingId: replacement.pairingId, note: '' }] });
  expect((await relay.projectSettings('project')).defaultPairingId).toBe(replacement.pairingId);
  expect(await relay.placement('project')).toMatchObject({ pairingId: replacement.pairingId });
}));

test('a relay call that cannot run says why and what to do, naming the Chromes it could use', () => fixture(async (relay, chrome) => {
  const unhelpful = /browser_control|project Settings/;
  await expect(relay.placement('project')).rejects.toThrow(/^No Chrome is paired with this account\. Ask the user to pair one in Plugins → Browsers\.$/);
  const a = await chrome('A'), b = await chrome('B');
  await relay.rename(a.pairingId, 'Work'); await relay.rename(b.pairingId, 'Home');
  const work = `"Work" (${a.pairingId}, online)`, home = `"Home" (${b.pairingId}, online)`;
  await expect(relay.placement('project')).rejects.toThrow(`No Chrome is approved for this project. Paired: ${work}, ${home}. Ask the user to approve one in Plugins → Browsers or in this workspace’s Browser tab.`);
  await relay.setProjectSettings('project', 0, { defaultPairingId: null, approvals: [{ pairingId: a.pairingId, note: '' }] });
  await expect(relay.placement('project', b.pairingId)).rejects.toThrow(`Chrome ${b.pairingId} is not approved for this project. Approved: ${work}. Pass one of their pairingIds, or ask the user to approve that Chrome in Plugins → Browsers or in this workspace’s Browser tab.`);
  await relay.setProjectSettings('project', 1, { defaultPairingId: null, approvals: [{ pairingId: a.pairingId, note: '' }, { pairingId: b.pairingId, note: '' }] });
  await expect(relay.placement('project')).rejects.toThrow(`Several Chromes are approved for this project and none is its default: ${work}, ${home}. Pass the pairingId of the one to use.`);
  const refusals: string[] = [];
  for (const pairingId of [undefined, crypto.randomUUID()]) refusals.push(await relay.placement('project', pairingId).then(() => '', (error: unknown) => String(error)));
  refusals.push(await relay.placement('other').then(() => '', (error: unknown) => String(error)));
  expect(refusals.every(message => message && !unhelpful.test(message))).toBe(true);
}));

test('the only Chrome a project approved is used without a default', () => fixture(async (relay, chrome) => {
  const a = await chrome('A');
  await chrome('B');
  await relay.setProjectSettings('project', 0, { defaultPairingId: null, approvals: [{ pairingId: a.pairingId, note: '' }] });
  expect((await relay.placement('project')).pairingId).toBe(a.pairingId);
}));

test('a Chrome has one name, set on its pairing and shown in every project and in the account status', () => fixture(async (relay, chrome) => {
  const a = await chrome('A');
  expect((await relay.projectSettings('project')).browsers.map(browser => browser.name)).toEqual([`Chrome ${a.pairingId.slice(0, 8)}`]);
  await relay.setProjectSettings('project', 0, { defaultPairingId: a.pairingId, approvals: [{ pairingId: a.pairingId, note: 'Work account' }] });
  expect((await relay.rename(a.pairingId, '  Laptop  ')).pairings.find(pairing => pairing.pairingId === a.pairingId)?.name).toBe('Laptop');
  expect((await relay.projectSettings('project')).browsers).toContainEqual(expect.objectContaining({ pairingId: a.pairingId, name: 'Laptop', note: 'Work account', approved: true }));
  expect((await relay.projectSettings('other')).browsers).toContainEqual(expect.objectContaining({ pairingId: a.pairingId, name: 'Laptop', approved: false }));
  await expect(relay.rename(crypto.randomUUID(), 'Nobody')).rejects.toThrow(/unknown/i);
  await expect(relay.rename(a.pairingId, ' ')).rejects.toThrow();
}));

test('a tab preview goes to the extension under signed authority', () => fixture(async (relay, chrome, root) => {
  const current = await chrome('Current');
  await relay.setProjectSettings('project', 0, { defaultPairingId: current.pairingId, approvals: [{ pairingId: current.pairingId, note: '' }] });
  const placement = await relay.placement('project', current.pairingId), opened = await authorization(root, placement);
  await relay.execute(opened);
  if (opened.body.command.type !== 'execute') throw new Error('Expected execution');
  const result = await relay.execute(await authorization(root, placement, 'workspace', 'project', { type: 'manage', action: 'preview', groupId: opened.body.command.grant.body.groupId, targetId: 'tab' }));
  const text = result.content.find(part => part.type === 'text');
  expect(text?.type === 'text' ? JSON.parse(text.text) : null).toEqual({ image: 'jpeg-bytes', reason: null });
  expect(current.operations.slice(-2)).toEqual(['authorize', 'preview']);
}));

test('LEGACY: a name stored on a project approval names its Chrome until the project is next written, and then stays on the pairing', async () => {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (relay, state) => {
    const pairingId = crypto.randomUUID(), root = await keys();
    await state.storage.put('browser.relay.pairings', { pairings: [{ pairingId, generation: 1, state: 'confirmed', code: null, expiresAt: null, publicKey: root.publicKey, trust: { algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey } }] });
    await state.storage.put('browser.relay.project:project', { revision: 1, defaultPairingId: pairingId, approvals: [{ pairingId, name: 'Work Chrome', note: 'Production', generation: 1, approvalId: crypto.randomUUID() }] });
    expect((await relay.browserRelayProjectSettings('other')).browsers.map(browser => browser.name)).toEqual(['Work Chrome']);
    await relay.browserRelaySetProjectSettings('project', 1, { defaultPairingId: pairingId, approvals: [{ pairingId, note: 'Production' }] });
    expect(JSON.stringify(await state.storage.get('browser.relay.project:project'))).not.toContain('Work Chrome');
    expect((await relay.browserRelayStatus()).pairings.map(pairing => pairing.name)).toEqual(['Work Chrome']);
  });
});
