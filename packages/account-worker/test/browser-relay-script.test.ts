import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { BROWSER_EXTENSION_PROTOCOL, browserBase64, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserPlacement } from '@gitspace/protocol-runtime';
import type { UserRelayDO } from '../src/index.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Operation = { operation: string; [field: string]: unknown };
const Message = z.object({ id: z.number(), operation: z.string() }).catchall(z.unknown());
const CdpFrame = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional() });

async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }

/** A paired, confirmed and project-approved Chrome whose extension reports `protocol`. Its group holds one tab of yours;
 * `open` with a url adds an agent tab; every operation is recorded. */
async function chrome(relay: UserRelayDO, root: Identity, protocol: number) {
  const pairing = await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
  const response = await relay.browserRelayFetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': '192.0.2.1' } }));
  const socket = response.webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/131.0.0.0', protocol })); await ready;
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  const settings = await relay.browserRelayProjectSettings('project');
  await relay.browserRelaySetProjectSettings('project', settings.revision, { defaultPairingId: pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(({ pairingId, name, note }) => ({ pairingId, name, note })), { pairingId: pairing.pairingId, name: 'Work', note: '' }] });
  const operations: Operation[] = [];
  const tabs = [{ targetId: 'your-tab', title: 'Docs', url: 'https://example.com/docs', addedBy: 'you' }];
  socket.addEventListener('message', event => {
    const { id, ...message } = Message.parse(JSON.parse(String(event.data)));
    operations.push(message);
    let result: unknown = {};
    if (message.operation === 'tabs') result = tabs;
    if (message.operation === 'open' && typeof message.targetId === 'string') result = { targetId: message.targetId, sessionId: `lease-${message.targetId}` };
    if (message.operation === 'open' && typeof message.url === 'string') { tabs.push({ targetId: 'agent-tab', title: '', url: message.url, addedBy: 'agent' }); result = { targetId: 'agent-tab', sessionId: 'lease-agent-tab' }; }
    if (message.operation === 'command') {
      const { expression, source } = z.object({ expression: z.string().optional(), source: z.string().optional() }).parse(message.params ?? {});
      // As the extension's run allowlist: the browser's own commands and scripts for new documents are refused.
      if (typeof message.method === 'string' && message.method.startsWith('Browser.') || message.method === 'Page.addScriptToEvaluateOnNewDocument' && source) { socket.send(JSON.stringify({ id, error: { message: 'Command outside browser grant' } })); return; }
      if (message.method === 'Runtime.evaluate' && expression === '6 * 7') result = { result: { type: 'number', value: 42 } };
      const url = tabs.find(tab => tab.targetId === message.targetId)?.url ?? 'about:blank';
      // Enough of a page for Playwright to adopt it: its main frame, whose id is the tab's, as in Chrome.
      if (message.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: String(message.targetId), loaderId: 'loader', url, domainAndRegistry: '', securityOrigin: new URL(url).origin, mimeType: 'text/html', secureContextType: 'Secure', crossOriginIsolatedContextType: 'NotIsolated', gatedAPIFeatures: [] }, childFrames: [] } };
    }
    socket.send(JSON.stringify({ id, result }));
  });
  return { socket, operations, placement: await relay.browserRelayPlacement('project', pairing.pairingId) };
}

/** A signed `browser.run` authorization for the Chrome's workspace group, as the workspace object signs it. */
async function runAuthorization(root: Identity, placement: RuntimeAccountBrowserPlacement, script = 'return 1;') {
  if (placement.kind !== 'account-relay') throw new Error('Expected a Chrome placement');
  const workspace = await keys(), expiresAt = new Date(Date.now() + 150_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
  const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, workspace.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  return signRuntimeAccountBrowserAuthorization({ scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'run', source: 'relay', pairingId: placement.pairingId, script }, grant } }, workspace.key.privateKey, authority);
}

/** A raw CDP client, as Playwright drives the script endpoint. */
function cdp(socket: WebSocket) {
  let sequence = 0;
  const events: z.infer<typeof CdpFrame>[] = [], replies = new Map<number, (frame: z.infer<typeof CdpFrame>) => void>();
  socket.addEventListener('message', event => {
    const message = CdpFrame.parse(JSON.parse(String(event.data)));
    if (message.id === undefined) events.push(message); else replies.get(message.id)?.(message);
  });
  return {
    events,
    send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      const id = ++sequence, reply = Promise.withResolvers<z.infer<typeof CdpFrame>>();
      replies.set(id, reply.resolve);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return reply.promise;
    },
  };
}
const upgrade = (url: string) => new Request(url, { headers: { upgrade: 'websocket' } });

test('a script on a Chrome whose extension reports protocol 1 is refused with the reload message, before the extension is asked', async () => {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (relay: UserRelayDO) => {
    const root = await keys(), browser = await chrome(relay, root, 1);
    try {
      await expect(relay.browserRelayScriptBegin(await runAuthorization(root, browser.placement))).rejects.toThrow('Reload the GitSpace extension in Chrome to run scripts there (it needs protocol 2)');
      expect(browser.operations).toEqual([]);
    } finally { browser.socket.close(); }
  });
});

test('a script sees the workspace group as one browser over the extension, until its run ends', async () => {
  // The account's own relay object, the one the public handler forwards to.
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys(), browser = await chrome(relay, root, BROWSER_EXTENSION_PROTOCOL);
    try {
      const authorization = await runAuthorization(root, browser.placement), { attemptId } = authorization.body.scope;
      if (authorization.body.command.type !== 'execute') throw new Error('Expected execution');
      const { groupId } = authorization.body.command.grant.body;
      const { token } = await relay.browserRelayScriptBegin(authorization);
      expect(browser.operations).toEqual([{ operation: 'authorize', authorization }]);
      // The path never reaches the relay object from the internet, even with a live token.
      const outside = await exports.default.fetch(upgrade(`https://test.gitspace.sh/browser-relay/script/${token}/Agent`));
      expect(outside.status).not.toBe(101);
      const response = await relay.fetch(upgrade(`https://relay/browser-relay/script/${token}/Agent`));
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      if (!socket) throw new Error('Missing script socket');
      socket.accept();
      const client = cdp(socket);

      expect(await client.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false })).toMatchObject({ result: {} });
      expect(client.events).toContainEqual({ method: 'Target.attachedToTarget', params: { sessionId: 'lease-your-tab', targetInfo: expect.objectContaining({ targetId: 'your-tab', type: 'page', url: 'https://example.com/docs', browserContextId: 'gitspace-group' }), waitingForDebugger: false } });
      expect(browser.operations).toContainEqual({ operation: 'tabs', groupId, attemptId });
      expect(browser.operations).toContainEqual({ operation: 'open', grant: authorization.body.command.grant, attemptId, targetId: 'your-tab' });

      expect(await client.send('Target.createTarget', { url: 'https://example.com/new' })).toMatchObject({ result: { targetId: 'agent-tab' } });
      expect(browser.operations).toContainEqual({ operation: 'open', grant: authorization.body.command.grant, attemptId, url: 'https://example.com/new' });
      expect(client.events).toContainEqual(expect.objectContaining({ method: 'Target.attachedToTarget', params: expect.objectContaining({ sessionId: 'lease-agent-tab', targetInfo: expect.objectContaining({ targetId: 'agent-tab', browserContextId: 'gitspace-group' }) }) }));

      expect(await client.send('Runtime.evaluate', { expression: '6 * 7' }, 'lease-your-tab')).toEqual({ id: expect.any(Number), sessionId: 'lease-your-tab', result: { result: { type: 'number', value: 42 } } });
      expect(browser.operations).toContainEqual({ operation: 'command', targetId: 'your-tab', sessionId: 'lease-your-tab', method: 'Runtime.evaluate', params: { expression: '6 * 7' }, attemptId });

      browser.socket.send(JSON.stringify({ targetId: 'your-tab', sessionId: 'lease-your-tab', method: 'Page.loadEventFired', params: { timestamp: 1 } }));
      await expect.poll(() => client.events.filter(event => event.method === 'Page.loadEventFired')).toEqual([{ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'lease-your-tab' }]);

      const refused = await client.send('Target.createBrowserContext');
      expect(refused.error?.message).toBe('Your Chrome has one context, the workspace group');
      expect(browser.operations.map(item => item.operation === 'command' ? item.method : item.operation)).not.toContain('Target.createBrowserContext');

      const closed = new Promise<CloseEvent>(resolve => socket.addEventListener('close', resolve, { once: true }));
      await relay.browserRelayScriptEnd(token);
      expect(browser.operations.at(-1)).toEqual({ operation: 'release', attemptId });
      await closed;
      expect((await relay.fetch(upgrade(`https://relay/browser-relay/script/${token}/Agent`))).status).toBe(404);
    } finally { browser.socket.close(); }
  });
});

test('the script endpoint admits only a live run’s token, once', async () => {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async (relay: UserRelayDO) => {
    const root = await keys(), browser = await chrome(relay, root, BROWSER_EXTENSION_PROTOCOL);
    try {
      const unknown = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      expect((await relay.fetch(upgrade(`https://relay/browser-relay/script/${unknown}/Agent`))).status).toBe(404);
      const { token } = await relay.browserRelayScriptBegin(await runAuthorization(root, browser.placement));
      const first = await relay.fetch(upgrade(`https://relay/browser-relay/script/${token}/Agent`));
      expect(first.status).toBe(101);
      first.webSocket?.accept();
      expect((await relay.fetch(upgrade(`https://relay/browser-relay/script/${token}/Agent`))).status).toBe(404);
      first.webSocket?.close();
    } finally { browser.socket.close(); }
  });
});

test('a Playwright script runs on the user’s Chrome from the workspace’s browser session, and its run ends with it', async () => {
  // The session object reaches the account's own relay object.
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys(), browser = await chrome(relay, root, BROWSER_EXTENSION_PROTOCOL);
    try {
      const authorization = await runAuthorization(root, browser.placement, `
        const created = await context.newPage();
        const opened = { url: created.url(), pages: context.pages().length };
        await created.close();
        return { adopted: page.url(), opened, pages: context.pages().length, contexts: browser.contexts().length };`);
      const result = await env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:project:workspace`).execute(authorization);
      const text = result.content.find(part => part.type === 'text');
      // The script adopted your tab in the group's one context, opened an agent tab there and closed it again.
      expect(text?.type === 'text' && JSON.parse(text.text)).toEqual({ ok: true, value: { adopted: 'https://example.com/docs', opened: { url: 'about:blank', pages: 2 }, pages: 1, contexts: 1 }, logs: [], truncated: false });
      expect(browser.operations).toContainEqual(expect.objectContaining({ operation: 'command', targetId: 'agent-tab', method: 'Target.closeTarget' }));
      expect(browser.operations.at(-1)).toEqual({ operation: 'release', attemptId: authorization.body.scope.attemptId });
    } finally { browser.socket.close(); }
  });
});
