import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { BROWSER_EXTENSION_PROTOCOL, RuntimeAccountBrowserAuthorizationSchema, browserBase64, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserPlacement, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CloudDownloads, StepDownloads, type BrowserDownload, type DownloadOutcome } from '../src/browser-downloads.js';
import { ScriptRunFiles } from '../src/browser-script-files.js';
import { BrowserSessionDO } from '../src/browser-session.js';
import { CdpBrowserShim } from '../src/browser-shim.js';
import { BROWSER_UPLOAD_HEADER, browserSignedText } from '../src/browser-upload.js';
import { DriveFiles } from '../src/drive-files.js';
import type { UserRelayDO } from '../src/index.js';
import { workspaceDrive, type WorkspaceDrive } from '../src/workspace-drive.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Chrome = { socket: WebSocket; identity: Identity; pairingId: string; generation: number; placement: RuntimeAccountBrowserPlacement };
const Message = z.object({ id: z.number(), operation: z.string() }).catchall(z.unknown());
const Reply = z.object({ status: z.string(), value: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const encoder = new TextEncoder();
const day = () => new Date().toISOString().slice(0, 10);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function hex(bytes: ArrayBuffer | Uint8Array): string { return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
/** Whether a promise has answered yet. */
function answered(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

/** A project with one workspace and its drive. */
async function workspace() {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Downloads', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { projectId, workspaceId, drive: workspaceDrive(env, { projectId, workspaceId }) };
}

/** A paired Chrome, confirmed and approved for the project, whose extension answers every request with `{}`. */
async function chrome(relay: UserRelayDO, root: Identity, projectId: string, ip: string): Promise<Chrome> {
  const redeemed = await relay.browserRelayRedeemPairingCode((await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey })).code, '198.51.100.1', 'wss://account.test/api/browser-relay/extension');
  if (!redeemed.ok) throw new Error(redeemed.message);
  const pairing = redeemed.value;
  const socket = (await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': ip } }))).webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, encoder.encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/131.0.0.0', protocol: BROWSER_EXTENSION_PROTOCOL })); await ready;
  socket.addEventListener('message', event => {
    const { id, operation } = Message.parse(JSON.parse(String(event.data)));
    socket.send(JSON.stringify({ id, result: operation === 'tabs' ? [] : {} }));
  });
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  const settings = await relay.browserRelayProjectSettings(projectId);
  await relay.browserRelaySetProjectSettings(projectId, settings.revision, { defaultPairingId: pairing.pairingId, approvals: [{ pairingId: pairing.pairingId }] });
  return { socket, identity, pairingId: pairing.pairingId, generation: pairing.generation, placement: await relay.browserRelayPlacement(projectId, pairing.pairingId) };
}

/** A command the workspace object signs for the Chrome, in a new group: a single step (`tabs`) or a script run. */
async function authorization(root: Identity, placement: RuntimeAccountBrowserPlacement, projectId: string, workspaceId: string, kind: 'step' | 'run') {
  if (placement.kind !== 'account-relay') throw new Error('Expected a Chrome placement');
  const signer = await keys(), expiresAt = new Date(Date.now() + 150_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: signer.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, signer.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  const signed = await signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: kind === 'run' ? { action: 'run', source: 'relay', pairingId: placement.pairingId, script: 'return 1;' } : { action: 'tabs', source: 'relay', pairingId: placement.pairingId }, grant } }, signer.key.privateKey, authority);
  return { signed, groupId: grant.body.groupId, attemptId };
}

/** The signed request from the extension that begins an upload. */
async function begin(browser: Chrome, body: object) {
  const path = '/api/browser-relay/uploads', bytes = encoder.encode(JSON.stringify(body));
  const issuedAt = Date.now(), nonce = hex(crypto.getRandomValues(new Uint8Array(32))), bodySha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', browser.identity.key.privateKey, encoder.encode(browserSignedText('upload', { pairingId: browser.pairingId, generation: browser.generation, method: 'POST', pathname: path, bodySha256, issuedAt, nonce })))));
  const header = btoa(JSON.stringify({ pairingId: browser.pairingId, generation: browser.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const response = await exports.default.fetch(new Request(`https://test.gitspace.sh${path}`, { method: 'POST', headers: { [BROWSER_UPLOAD_HEADER]: header }, body: bytes }));
  const reply = Reply.parse(await response.json());
  if (response.status !== 200) throw new Error(JSON.stringify(reply));
  return z.object({ link: z.string().url() }).parse(reply.value).link;
}
/** One unsigned request through an upload link. */
async function through(link: string, method: string, body: Uint8Array<ArrayBuffer> | object | null = null) {
  const bytes = body === null ? null : body instanceof Uint8Array ? body : encoder.encode(JSON.stringify(body));
  const response = await exports.default.fetch(new Request(link, bytes === null ? { method } : { method, body: bytes }));
  return { ...Reply.parse(await response.json()), status: response.status };
}
/** Stores `bytes` as the upload's one part and completes it. */
async function finish(link: string, bytes: Uint8Array<ArrayBuffer>) {
  expect((await through(`${link}/parts/1`, 'PUT', bytes)).status).toBe(200);
  expect((await through(`${link}/complete`, 'POST', { parts: 1, size: bytes.byteLength })).status).toBe(200);
}
/** What a step's result lists under `downloads`, or null when it lists none. */
function stepDownloads(result: RuntimeToolResult): unknown {
  const last = result.content.at(-1);
  if (result.content.length < 2 || last?.type !== 'text') return null;
  return z.object({ downloads: z.array(z.unknown()) }).parse(JSON.parse(last.text)).downloads;
}

/** The cloud browser with one page (`tab-1`) through a shim; `respond` pauses a document response on the downloads
 * client's page session. A download's body is one chunk, taken once `body` is resolved. */
async function cloudBrowser(drive: WorkspaceDrive, started: (download: BrowserDownload) => void) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<Parameters<BrowserChannel['subscribe']>[0]>();
  const body = Promise.withResolvers<void>();
  const upstream: BrowserChannel = {
    async send(method, params = {}) {
      sent.push({ method, params });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'tab-1', type: 'page', url: 'https://example.com/', title: 'Example', attached: false }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'downloads-session' };
      if (method === 'Fetch.takeResponseBodyAsStream') { await body.promise; return { stream: 'body-stream' }; }
      if (method === 'IO.read') return { data: browserBase64(encoder.encode('quarter,total\nq3,42\n')), base64Encoded: true, eof: true };
      return {};
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {},
  };
  await CloudDownloads.open(await CdpBrowserShim.open(upstream), drive, started);
  await expect.poll(() => sent.some(command => command.method === 'Fetch.enable')).toBe(true);
  const respond = (requestId: string, url: string, headers: Record<string, string>) => {
    for (const listener of listeners) listener({ method: 'Fetch.requestPaused', sessionId: 'downloads-session', params: { requestId, frameId: 'frame', resourceType: 'Document', request: { url, method: 'GET', headers: {} }, responseStatusCode: 200, responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) } });
  };
  return { sent, respond, body };
}

test('a running script follows the cloud browser’s downloads with their tab and address: downloads() answers at once when the list changed, else at the next start, settle or the run’s end', async () => {
  const { drive } = await workspace();
  const files = new ScriptRunFiles(drive, { source: 'headless', groupId: crypto.randomUUID() });
  const browser = await cloudBrowser(drive, download => files.downloaded(download));
  const first = files.downloads(0), firstAnswered = answered(first);
  // A page is no download: the wait goes on.
  browser.respond('page', 'https://example.com/report', { 'Content-Type': 'text/html' });
  await expect.poll(() => browser.sent.some(command => command.method === 'Fetch.continueRequest')).toBe(true);
  expect(firstAnswered()).toBe(false);
  browser.respond('csv', 'https://example.com/export?id=7', { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="Q3 report.csv"' });
  const started = { id: expect.any(String), targetId: 'tab-1', url: 'https://example.com/export?id=7', name: 'Q3 report.csv' };
  expect(await first).toEqual({ version: 1, ended: false, downloads: [{ ...started, outcome: null }] });
  // Asked about an older version, it answers at once.
  expect(await files.downloads(0)).toEqual({ version: 1, ended: false, downloads: [{ ...started, outcome: null }] });
  const second = files.downloads(1), secondAnswered = answered(second);
  expect(secondAnswered()).toBe(false);
  browser.body.resolve();
  const saved = { file: `drive://workspace/browser/downloads/${day()}/Q3%20report.csv`, size: 20, mediaType: 'text/csv' };
  expect(await second).toEqual({ version: 2, ended: false, downloads: [{ ...started, outcome: saved }] });
  const third = files.downloads(2), thirdAnswered = answered(third);
  await expect(files.downloads(-1)).rejects.toThrow();
  expect(thirdAnswered()).toBe(false);
  files.end();
  expect(await third).toEqual({ version: 2, ended: true, downloads: [{ ...started, outcome: saved }] });
  expect(await files.downloads(2)).toMatchObject({ version: 2, ended: true });
  // The run's result lists it once.
  expect((await files.report([])).downloads).toEqual([saved]);
});

test('saveDownload() copies a run’s download in the drive without reading its bytes, waits for one still being saved, and refuses other addresses, unknown ids and failed downloads', async () => {
  const { drive } = await workspace();
  const bytes = encoder.encode('quarter,total\nq3,42\n');
  const source = await drive.write('browser/downloads/2026-10-27/Q3 report.csv', 'text/csv', bytes);
  const files = new ScriptRunFiles(drive, { source: 'headless', groupId: crypto.randomUUID() });
  const saving = Promise.withResolvers<DownloadOutcome>();
  files.downloaded({ id: 'csv', targetId: 'tab-1', url: 'https://example.com/q3', name: 'Q3 report.csv', outcome: saving.promise });
  files.downloaded({ id: 'broken', targetId: 'tab-1', url: 'https://example.com/q4', name: 'Q4 report.csv', outcome: Promise.resolve({ error: 'The connection reset' }) });
  const reads = vi.spyOn(DriveFiles.prototype, 'get');
  const copied = files.saveDownload('csv', 'drive://workspace/reports/q3%20final.csv'), copiedAnswered = answered(copied);
  await expect(files.saveDownload('csv', 'drive://base/reports/q3.csv')).rejects.toThrow("drive://base/reports/q3.csv is not a file of this workspace's drive: saveAs() takes drive://workspace/<path>");
  await expect(files.saveDownload('csv', 'drive://workspace/reports/q3.csv:1-2')).rejects.toThrow('saveAs() takes drive://workspace/<path>');
  await expect(files.saveDownload('nope', 'drive://workspace/reports/q3.csv')).rejects.toThrow('This run has no download nope');
  await expect(files.saveDownload('broken', 'drive://workspace/reports/q4.csv')).rejects.toThrow('Q4 report.csv was not saved: The connection reset');
  // Still being saved: the copy waits for it.
  expect(copiedAnswered()).toBe(false);
  saving.resolve({ file: 'drive://workspace/browser/downloads/2026-10-27/Q3%20report.csv', size: bytes.byteLength, mediaType: 'text/csv' });
  expect(await copied).toEqual({ file: 'drive://workspace/reports/q3%20final.csv' });
  // The drive reads its manifests; the download's own bytes are never read.
  expect(reads.mock.calls.filter(([, file]) => file.blobHash === source.blobHash)).toEqual([]);
  const copy = (await drive.list('reports/')).find(entry => entry.path === 'reports/q3 final.csv');
  expect(copy).toEqual({ path: 'reports/q3 final.csv', size: bytes.byteLength, mediaType: 'text/csv', blobHash: source.blobHash });
  expect(await drive.read('reports/q3 final.csv')).toEqual(bytes);
  // One still saving when the run ends is refused, and nothing is saved after the end.
  files.downloaded({ id: 'slow', targetId: null, url: '', name: 'big.zip', outcome: new Promise<DownloadOutcome>(() => {}) });
  const slow = files.saveDownload('slow', 'drive://workspace/big.zip');
  files.end();
  await expect(slow).rejects.toThrow('big.zip was still being saved when the run ended');
  await expect(files.saveDownload('csv', 'drive://workspace/again.csv')).rejects.toThrow('The script run ended');
});

test('your Chrome’s download uploads reach the running script: begin with the tab and address (none from an older extension), complete with the drive file, abort with why; its end answers waiters and its result lists each download once', async () => {
  const { projectId, workspaceId, drive } = await workspace();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, '192.0.2.61');
    try {
      const { signed, groupId, attemptId } = await authorization(root, browser.placement, projectId, workspaceId, 'run');
      const { token } = await relay.browserRelayScriptBegin(signed);
      // The browser session's files for the run ask the relay.
      const files = new ScriptRunFiles(drive, { source: 'relay', groupId, chrome: async () => ({ name: 'Chrome' }), downloads: version => relay.browserRelayScriptDownloads(token, version) });
      const first = files.downloads(0);
      const report = await begin(browser, { kind: 'download', groupId, attemptId, name: 'Q3 report.csv', mediaType: 'text/csv', targetId: 'your-tab', url: 'https://example.com/export?id=7' });
      const started = { id: expect.any(String), targetId: 'your-tab', url: 'https://example.com/export?id=7', name: 'Q3 report.csv' };
      const listed = await first;
      expect(listed).toEqual({ version: 1, ended: false, downloads: [{ ...started, outcome: null }] });
      const copied = files.saveDownload(listed.downloads[0]?.id, 'drive://workspace/reports/q3.csv'), copiedAnswered = answered(copied);
      const bytes = encoder.encode('quarter,total\nq3,42\n');
      expect((await through(`${report}/parts/1`, 'PUT', bytes)).status).toBe(200);
      expect(copiedAnswered()).toBe(false);
      expect((await through(`${report}/complete`, 'POST', { parts: 1, size: bytes.byteLength })).status).toBe(200);
      const saved = { file: `drive://workspace/browser/downloads/${day()}/Q3%20report.csv`, size: bytes.byteLength, mediaType: 'text/csv' };
      expect(await copied).toEqual({ file: 'drive://workspace/reports/q3.csv' });
      expect(await drive.read('reports/q3.csv')).toEqual(bytes);
      expect(await relay.browserRelayScriptDownloads(token, 1)).toEqual({ version: 2, ended: false, downloads: [{ ...started, outcome: saved }] });

      // An older extension sends neither the tab nor the address; you cancel that download in Chrome.
      const notes = await begin(browser, { kind: 'download', groupId, attemptId, name: 'notes.txt', mediaType: 'text/plain' });
      const older = { id: expect.any(String), targetId: null, url: '', name: 'notes.txt' };
      expect(await files.downloads(2)).toEqual({ version: 3, ended: false, downloads: [{ ...started, outcome: saved }, { ...older, outcome: null }] });
      const aborted = files.downloads(3);
      expect((await through(notes, 'DELETE')).status).toBe(200);
      expect(await aborted).toEqual({ version: 4, ended: false, downloads: [{ ...started, outcome: saved }, { ...older, outcome: { error: 'Your Chrome stopped saving it' } }] });

      // The run ends: the session's waiter answers at once, the relay's when the session ends the run there.
      const atRelay = relay.browserRelayScriptDownloads(token, 4), atRelayAnswered = answered(atRelay), atSession = files.downloads(4);
      files.end();
      expect(await atSession).toMatchObject({ version: 4, ended: true });
      expect(atRelayAnswered()).toBe(false);
      const ended = await relay.browserRelayScriptEnd(token);
      expect(await atRelay).toMatchObject({ version: 4, ended: true });
      expect((await files.report(ended.downloads)).downloads).toEqual([saved, { name: 'notes.txt', error: 'Your Chrome stopped saving it' }]);
      expect(await relay.browserRelayScriptDownloads(token, 0)).toMatchObject({ ended: true });
    } finally { browser.socket.close(); }
  });
});

test('single steps on your Chrome list the downloads they started once, in that step’s result or the next one’s, waiting for one begun and still saving; a script’s downloads never', async () => {
  const { projectId, workspaceId } = await workspace();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, '192.0.2.62');
    const step = async () => {
      const made = await authorization(root, browser.placement, projectId, workspaceId, 'step');
      return { ...made, result: await relay.browserRelayExecute(made.signed) };
    };
    try {
      const first = await step();
      expect(stepDownloads(first.result)).toBeNull();
      const bytes = encoder.encode('quarter,total\nq3,42\n');
      await finish(await begin(browser, { kind: 'download', groupId: first.groupId, attemptId: first.attemptId, name: 'Q3 report.csv', mediaType: 'text/csv', targetId: 'your-tab', url: 'https://example.com/q3' }), bytes);
      const saved = { file: `drive://workspace/browser/downloads/${day()}/Q3%20report.csv`, size: bytes.byteLength, mediaType: 'text/csv' };
      const second = await step();
      expect(stepDownloads(second.result)).toEqual([saved]);
      expect(stepDownloads((await step()).result)).toBeNull();

      // Begun and still saving: the next step waits for it.
      const link = await begin(browser, { kind: 'download', groupId: second.groupId, attemptId: second.attemptId, name: 'Q4 report.csv', mediaType: 'text/csv' });
      const waiting = step();
      expect((await through(`${link}/parts/1`, 'PUT', bytes)).status).toBe(200);
      expect((await through(`${link}/complete`, 'POST', { parts: 1, size: bytes.byteLength })).status).toBe(200);
      expect(stepDownloads((await waiting).result)).toEqual([{ ...saved, file: `drive://workspace/browser/downloads/${day()}/Q4%20report.csv` }]);

      // A script's download is its run's.
      const run = await authorization(root, browser.placement, projectId, workspaceId, 'run');
      const { token } = await relay.browserRelayScriptBegin(run.signed);
      await finish(await begin(browser, { kind: 'download', groupId: run.groupId, attemptId: run.attemptId, name: 'run.csv', mediaType: 'text/csv' }), bytes);
      expect(stepDownloads((await step()).result)).toBeNull();
      expect((await relay.browserRelayScriptEnd(token)).downloads).toEqual([expect.objectContaining({ name: 'run.csv', outcome: expect.objectContaining({ file: `drive://workspace/browser/downloads/${day()}/run.csv` }) })]);
    } finally { browser.socket.close(); }
  });
});

/** The cloud browser as Browser Run serves it, with one page (`cloud-tab`): `paused` sends a download's document
 * response to the downloads client's page session; `failed` resolves once its response was cancelled (saved). */
function browserRun() {
  const Command = z.object({ id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()), sessionId: z.string().optional() });
  const pair = new WebSocketPair(), upstream = pair[1];
  upstream.accept();
  const info = { targetId: 'cloud-tab', type: 'page', url: 'https://example.com/', title: 'Example', attached: false, canAccessOpener: false };
  const results: Record<string, unknown> = { 'Target.getTargets': { targetInfos: [info] }, 'Target.getTargetInfo': { targetInfo: info }, 'Target.createTarget': { targetId: 'cloud-tab' }, 'Page.getFrameTree': { frameTree: { frame: { id: 'frame', url: info.url } } }, 'Fetch.takeResponseBodyAsStream': { stream: 'body' }, 'IO.read': { data: browserBase64(encoder.encode('a,b\n')), base64Encoded: true, eof: true } };
  let sessions = 0;
  const fetching = Promise.withResolvers<string>(), failed = Promise.withResolvers<void>();
  upstream.addEventListener('message', event => {
    const command = Command.parse(JSON.parse(String(event.data)));
    // The downloads client pauses every document response; the agent's tabs intercept other requests.
    if (command.method === 'Fetch.enable' && command.sessionId && JSON.stringify(command.params).includes('"requestStage":"Response"')) fetching.resolve(command.sessionId);
    if (command.method === 'Fetch.failRequest') failed.resolve();
    upstream.send(JSON.stringify({ id: command.id, result: command.method === 'Target.attachToTarget' ? { sessionId: `session-${++sessions}` } : results[command.method] ?? {} }));
  });
  const BROWSER: Fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (new Request(input, init).method === 'POST') return Response.json({ sessionId: 'browser-run' });
      return new Response(null, { status: 101, webSocket: pair[0] });
    },
    connect() { throw new Error('Browser Run takes no sockets'); },
  };
  const paused = async (requestId: string, name: string) => upstream.send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: await fetching.promise, params: { requestId, frameId: 'frame', resourceType: 'Document', request: { url: `https://example.com/${name}`, method: 'GET', headers: {} }, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/csv' }, { name: 'Content-Disposition', value: `attachment; filename="${name}"` }] } }));
  return { BROWSER, paused, failed: failed.promise };
}
/** An agent's single step on the cloud browser: it opens a tab. */
function cloudStep(projectId: string, workspaceId: string) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString(), placement = { kind: 'cloud', accountId: env.ACCOUNT_ID };
  const authority = { body: { accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: 'AA==', issuedAt: new Date().toISOString(), expiresAt }, signature: 'AA==' };
  return RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: crypto.randomUUID() }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'open', source: 'headless', url: 'https://example.com/' }, grant: { body: { projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'headless', stepsOnly: [], origins: [], expiresAt }, signature: 'AA==', authority } } }, signature: 'AA==', authority });
}

test('single steps on the cloud browser list the downloads no running script claimed, once, in the next step’s result', async () => {
  const { projectId, workspaceId } = await workspace();
  await runInDurableObject(env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${projectId}:${workspaceId}`), async (_instance, state) => {
    const run = browserRun();
    const session = new BrowserSessionDO(state, { ...env, BROWSER: run.BROWSER });
    expect(stepDownloads(await session.execute(cloudStep(projectId, workspaceId)))).toBeNull();
    await run.paused('export', 'Q3 report.csv');
    const saved = { file: `drive://workspace/browser/downloads/${day()}/Q3%20report.csv`, size: 4, mediaType: 'text/csv' };
    await run.failed;
    expect(stepDownloads(await session.execute(cloudStep(projectId, workspaceId)))).toEqual([saved]);
    expect(stepDownloads(await session.execute(cloudStep(projectId, workspaceId)))).toBeNull();
  });
});

test('a step lists a download still saving after its wait as saving, then once it settled, and never twice settled', async () => {
  await runInDurableObject(env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:steps:${crypto.randomUUID()}`), async (_instance, state) => {
    const steps = new StepDownloads(state.storage, 'test.step-download:');
    await steps.begin('owner', { id: 'big', targetId: 'tab-1', url: 'https://example.com/big.zip', name: 'big.zip' });
    await steps.begin('elsewhere', { id: 'other', targetId: null, url: '', name: 'other.zip' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listing = steps.report('owner');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await listing).toEqual([{ name: 'big.zip', saving: true }]);
    vi.useRealTimers();
    // Listed as saving, it is not waited for again.
    expect(await steps.report('owner')).toEqual([]);
    const saved = { file: 'drive://workspace/browser/downloads/2026-10-27/big.zip', size: 9, mediaType: 'application/zip' };
    await steps.settle('owner', 'big', saved);
    await steps.settle('owner', 'big', { error: 'late' });
    expect(await steps.report('owner')).toEqual([saved]);
    expect(await steps.report('owner')).toEqual([]);
  });
});
