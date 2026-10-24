import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { BROWSER_EXTENSION_PROTOCOL, RuntimeBrowserCaptureSchema, browserBase64, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserPlacement } from '@gitspace/protocol-runtime';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CloudDownloads } from '../src/browser-downloads.js';
import { ScriptRunFiles } from '../src/browser-script-files.js';
import { CdpBrowserShim } from '../src/browser-shim.js';
import type { UserRelayDO } from '../src/index.js';
import { workspaceDrive } from '../src/workspace-drive.js';
import { tenantRootPrivateKey } from './setup.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Command = { method: string; params: Record<string, unknown>; targetId: string };
const Message = z.object({ id: z.number(), operation: z.string() }).catchall(z.unknown());
const encoder = new TextEncoder(), decoder = new TextDecoder();

/** A JPEG's first bytes: its start, and a frame header with its size, which is all a reader of its size needs. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

/** A project with one workspace, whose drive the workspace's browser session writes; the account's vault holds the
 * storage keys. */
async function workspace() {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Script files', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { projectId, workspaceId, drive: workspaceDrive(env, { projectId, workspaceId }) };
}

async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }

/** A paired, confirmed Chrome approved for the project, whose extension reports `protocol`. Its group holds one tab of
 * yours, a page Playwright can adopt; `answer` gives a page command's result, and every command is recorded. */
async function chrome(relay: UserRelayDO, root: Identity, projectId: string, protocol: number, answer: (command: Command) => unknown) {
  const pairing = await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
  const response = await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': '192.0.2.1' } }));
  const socket = response.webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, encoder.encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/131.0.0.0', protocol })); await ready;
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  const settings = await relay.browserRelayProjectSettings(projectId);
  await relay.browserRelaySetProjectSettings(projectId, settings.revision, { defaultPairingId: pairing.pairingId, approvals: [{ pairingId: pairing.pairingId, note: '' }] });
  const commands: Command[] = [];
  const url = 'https://example.com/docs';
  socket.addEventListener('message', event => {
    const { id, ...message } = Message.parse(JSON.parse(String(event.data)));
    let result: unknown = {};
    if (message.operation === 'tabs') result = [{ targetId: 'your-tab', title: 'Docs', url, addedBy: 'you' }];
    if (message.operation === 'open' && typeof message.targetId === 'string') result = { targetId: message.targetId, sessionId: `lease-${message.targetId}` };
    if (message.operation === 'command' && typeof message.method === 'string') {
      const command = { method: message.method, params: z.record(z.string(), z.unknown()).parse(message.params ?? {}), targetId: String(message.targetId) };
      commands.push(command);
      if (command.method.startsWith('Browser.')) { socket.send(JSON.stringify({ id, error: { message: 'Command outside browser grant' } })); return; }
      // Enough of a page for Playwright to adopt it: its main frame, whose id is the tab's, as in Chrome.
      if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: command.targetId, loaderId: 'B0C0FFEE22222222', url, domainAndRegistry: '', securityOrigin: new URL(url).origin, mimeType: 'text/html', secureContextType: 'Secure', crossOriginIsolatedContextType: 'NotIsolated', gatedAPIFeatures: [] }, childFrames: [] } };
      else result = answer(command) ?? {};
    }
    socket.send(JSON.stringify({ id, result }));
  });
  return { socket, commands, placement: await relay.browserRelayPlacement(projectId, pairing.pairingId) };
}

/** A signed `browser.run` authorization for the Chrome's workspace group, as the workspace object signs it. */
async function runAuthorization(root: Identity, placement: RuntimeAccountBrowserPlacement, projectId: string, workspaceId: string, script: string) {
  if (placement.kind !== 'account-relay') throw new Error('Expected a Chrome placement');
  const signer = await keys(), expiresAt = new Date(Date.now() + 150_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: signer.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, signer.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  return signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'run', source: 'relay', pairingId: placement.pairingId, script }, grant } }, signer.key.privateKey, authority);
}

test('capture() on your Chrome saves a capture of the tab in the workspace drive, and the run’s result shows its image', async () => {
  const { projectId, workspaceId, drive } = await workspace();
  const image = jpeg(800, 600), thumbnail = jpeg(240, 180);
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, BROWSER_EXTENSION_PROTOCOL, ({ method, params }) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'your-tab', type: 'page', url: 'https://example.com/docs', title: 'Docs', attached: true, canAccessOpener: false } };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 }, visualViewport: { clientWidth: 800 } };
      if (method === 'Page.captureScreenshot') return { data: browserBase64(params.quality === 80 ? image : thumbnail) };
      return undefined;
    });
    try {
      const authorization = await runAuthorization(root, browser.placement, projectId, workspaceId, `return await capture(page, { name: 'Docs page' });`);
      if (authorization.body.command.type !== 'execute') throw new Error('Expected execution');
      const { groupId } = authorization.body.command.grant.body;
      const result = await env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${projectId}:${workspaceId}`).execute(authorization);
      const [reply, ...shown] = result.content;
      const answered: unknown = JSON.parse(reply?.type === 'text' ? reply.text : '');
      expect(answered).toMatchObject({ ok: true });
      const { value } = z.object({ value: z.object({ captureId: z.string().uuid(), url: z.string() }) }).parse(answered);
      const folder = `browser/captures/${value.captureId}/`;
      expect(value.url).toBe(`drive://workspace/${folder}image.jpg`);
      expect(shown).toEqual([{ type: 'text', text: `Capture saved to drive://workspace/${folder}image.jpg` }, { type: 'image', data: browserBase64(image), mimeType: 'image/jpeg' }]);
      expect((await drive.list(folder)).map(entry => entry.path).sort()).toEqual([`${folder}capture.json`, `${folder}image.jpg`, `${folder}thumbnail.jpg`]);
      expect(await drive.read(`${folder}image.jpg`)).toEqual(image);
      expect(await drive.read(`${folder}thumbnail.jpg`)).toEqual(thumbnail);
      const record = RuntimeBrowserCaptureSchema.parse(JSON.parse(decoder.decode(await drive.read(`${folder}capture.json`) ?? new Uint8Array())));
      expect(record).toMatchObject({ captureId: value.captureId, name: 'Docs page', by: 'agent', source: 'relay', page: { url: 'https://example.com/docs', title: 'Docs' }, target: { groupId, targetId: 'your-tab' }, state: 'saved', tracks: { image: { path: 'image.jpg', width: 800, height: 600 } } });
    } finally { browser.socket.close(); }
  });
});

test('upload() on your Chrome sends the extension sealed /files/ links to drive files, and never a file outside the workspace drive', async () => {
  const { projectId, workspaceId, drive } = await workspace();
  await drive.write('reports/q3 numbers.csv', 'text/csv', encoder.encode('quarter,total\nq3,42\n'));
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, BROWSER_EXTENSION_PROTOCOL, () => undefined);
    try {
      const authorization = await runAuthorization(root, browser.placement, projectId, workspaceId, `
        await upload('b0c0ffee:7', 'drive://workspace/reports/q3%20numbers.csv');
        const refused = [];
        for (const url of ['drive://base/reports/q3%20numbers.csv', 'drive://workspace/reports/missing.csv', 'https://example.com/file.csv']) {
          try { await upload('b0c0ffee:7', url); } catch (error) { refused.push(error.message); }
        }
        return refused;`);
      const result = await env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${projectId}:${workspaceId}`).execute(authorization);
      const reply = result.content[0];
      expect(JSON.parse(reply?.type === 'text' ? reply.text : '')).toMatchObject({ ok: true, value: [
        "drive://base/reports/q3%20numbers.csv is not a file of this workspace's drive: upload() takes drive://workspace/<path>",
        'drive://workspace/reports/missing.csv does not exist',
        "https://example.com/file.csv is not a file of this workspace's drive: upload() takes drive://workspace/<path>",
      ] });
      const sent = browser.commands.filter(command => command.method === 'GitSpace.setInputFilesFromUrls');
      expect(sent).toEqual([{ method: 'GitSpace.setInputFilesFromUrls', targetId: 'your-tab', params: { backendNodeId: 7, files: [{ url: expect.stringMatching(/^https:\/\/test\.gitspace\.sh\/files\/[^/]+$/u), name: 'q3 numbers.csv', mediaType: 'text/csv', size: 20 }] } }]);
      // The link serves the drive file itself, to whoever holds it: the extension.
      const link = z.string().parse(z.object({ files: z.array(z.object({ url: z.string() })) }).parse(sent[0]?.params).files[0]?.url);
      expect(await (await exports.default.fetch(new Request(link))).text()).toBe('quarter,total\nq3,42\n');
    } finally { browser.socket.close(); }
  });
});

test('on the cloud browser upload() gets the drive file’s bytes, and a run saves at most five captures', async () => {
  const { drive } = await workspace();
  const bytes = encoder.encode('quarter,total\nq3,42\n');
  await drive.write('reports/q3.csv', 'text/csv', bytes);
  const files = new ScriptRunFiles(drive, { source: 'headless', groupId: crypto.randomUUID() });
  expect(await files.uploadFiles(['drive://workspace/reports/q3.csv'])).toEqual({ kind: 'bytes', files: [{ name: 'q3.csv', mediaType: 'text/csv', bytes }] });
  await expect(files.uploadFiles(['drive://workspace/reports/q3.csv:1-2'])).rejects.toThrow("is not a file of this workspace's drive");
  const shot = { name: null, targetId: 'page', page: { url: 'https://example.com/', title: 'Example' }, image: browserBase64(jpeg(1280, 720)), thumbnail: browserBase64(jpeg(480, 270)) };
  for (let count = 0; count < 5; count++) await files.capture(shot);
  await expect(files.capture(shot)).rejects.toThrow('A script saves at most 5 captures a run');
  const records = (await drive.list('browser/captures/')).filter(entry => entry.path.endsWith('/capture.json'));
  expect(records).toHaveLength(5);
  expect((await files.report([])).content.filter(part => part.type === 'image')).toHaveLength(5);
});

test('a cloud download is saved to the day’s downloads folder in the drive and listed for the run, and the browser’s own download is cancelled', async () => {
  const { drive } = await workspace();
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const listeners = new Set<Parameters<BrowserChannel['subscribe']>[0]>();
  const body = ['quarter,total\n', 'q3,42\n'];
  const upstream: BrowserChannel = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page', type: 'page', url: 'https://example.com/', title: 'Example', attached: false }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'downloads-session' };
      if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'body-stream' };
      if (method === 'IO.read') { const chunk = body.shift(); return { data: browserBase64(encoder.encode(chunk ?? '')), base64Encoded: true, eof: body.length === 0 }; }
      return {};
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {},
  };
  const files = new ScriptRunFiles(drive, { source: 'headless', groupId: crypto.randomUUID() });
  await CloudDownloads.open(await CdpBrowserShim.open(upstream), drive, download => files.downloaded(download));
  await expect.poll(() => sent.find(command => command.method === 'Fetch.enable')).toEqual({ method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sessionId: 'downloads-session' });
  const respond = (requestId: string, url: string, headers: Record<string, string>) => {
    for (const listener of listeners) listener({ method: 'Fetch.requestPaused', sessionId: 'downloads-session', params: { requestId, frameId: 'frame', resourceType: 'Document', request: { url, method: 'GET', headers: {} }, responseStatusCode: 200, responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) } });
  };
  // A page goes on to the browser; an attachment is saved.
  respond('page', 'https://example.com/report', { 'Content-Type': 'text/html; charset=utf-8' });
  await expect.poll(() => sent.find(command => command.params.requestId === 'page')).toEqual({ method: 'Fetch.continueRequest', params: { requestId: 'page' }, sessionId: 'downloads-session' });
  respond('csv', 'https://example.com/export?id=7', { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="Q3 report.csv"' });
  const { downloads } = await files.report([]);
  const day = new Date().toISOString().slice(0, 10);
  expect(downloads).toEqual([{ file: `drive://workspace/browser/downloads/${day}/Q3%20report.csv`, size: 20, mediaType: 'text/csv' }]);
  expect(decoder.decode(await drive.read(`browser/downloads/${day}/Q3 report.csv`) ?? new Uint8Array())).toBe('quarter,total\nq3,42\n');
  expect(sent.filter(command => command.params.requestId === 'csv' || command.params.handle === 'body-stream').map(command => command.method)).toEqual(['Fetch.takeResponseBodyAsStream', 'IO.read', 'IO.read', 'IO.close', 'Fetch.failRequest']);
  expect(sent.find(command => command.method === 'Fetch.failRequest')?.params).toEqual({ requestId: 'csv', errorReason: 'Aborted' });
});
