import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { TENANT_OBJECT_PART_BYTES, credentialProtocolBase64 } from '@gitspace/protocol';
import { BROWSER_EXTENSION_PROTOCOL, RuntimeBrowserCaptureSchema, RuntimeBrowserFramesIndexSchema, browserBase64, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserAuthorizationBody, type RuntimeAccountBrowserPlacement } from '@gitspace/protocol-runtime';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CloudCaptures, captureViews } from '../src/browser-capture.js';
import { CdpBrowserShim } from '../src/browser-shim.js';
import { BROWSER_UPLOAD_HEADER, browserSignedText } from '../src/browser-upload.js';
import type { UserRelayDO } from '../src/index.js';
import { workspaceDrive } from '../src/workspace-drive.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
type Chrome = { socket: WebSocket; identity: Identity; pairingId: string; generation: number; operations: Record<string, unknown>[]; placement: RuntimeAccountBrowserPlacement | null };
const Message = z.object({ id: z.number(), operation: z.string() }).catchall(z.unknown());
const Reply = z.object({ status: z.string(), value: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const encoder = new TextEncoder(), decoder = new TextDecoder();
afterEach(() => { vi.useRealTimers(); });

/** A JPEG's first bytes: its start and a frame header with its size, then a byte telling frames apart. */
function jpeg(width: number, height: number, mark: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, mark]);
}
function joined(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> { return Uint8Array.from(parts.flatMap(part => [...part])); }
function hex(bytes: ArrayBuffer | Uint8Array): string { return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }

/** A project with one workspace and its drive. */
async function workspace() {
  // The account's vault holds the drive's scope keys.
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Captures', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { projectId, workspaceId, drive: workspaceDrive(env, { projectId, workspaceId }) };
}

/** A paired Chrome whose extension reports `protocol`: confirmed and approved for the project unless `confirmed` is
 * false. Every relay request is recorded; `answer` gives its result (default `{}`). */
async function chrome(relay: UserRelayDO, root: Identity, projectId: string, options: { protocol?: number; confirmed?: boolean; ip: string }, answer: (message: Record<string, unknown>) => unknown = () => ({})): Promise<Chrome> {
  const pairing = await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
  const socket = (await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': options.ip } }))).webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, encoder.encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const ready = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/131.0.0.0', protocol: options.protocol ?? BROWSER_EXTENSION_PROTOCOL })); await ready;
  const operations: Record<string, unknown>[] = [];
  socket.addEventListener('message', event => {
    const { id, ...message } = Message.parse(JSON.parse(String(event.data)));
    operations.push(message);
    socket.send(JSON.stringify({ id, result: message.operation === 'tabs' ? [] : answer(message) }));
  });
  if (options.confirmed === false) return { socket, identity, pairingId: pairing.pairingId, generation: pairing.generation, operations, placement: null };
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  const settings = await relay.browserRelayProjectSettings(projectId);
  await relay.browserRelaySetProjectSettings(projectId, settings.revision, { defaultPairingId: pairing.pairingId, approvals: [{ pairingId: pairing.pairingId, note: '' }] });
  return { socket, identity, pairingId: pairing.pairingId, generation: pairing.generation, operations, placement: await relay.browserRelayPlacement(projectId, pairing.pairingId) };
}

/** A command signed by the workspace object for the Chrome: a step (`tabs`) in a new group, or a management command. */
async function authorization(root: Identity, placement: RuntimeAccountBrowserPlacement, projectId: string, workspaceId: string, manage?: Extract<RuntimeAccountBrowserAuthorizationBody['command'], { type: 'manage' }>) {
  if (placement.kind !== 'account-relay') throw new Error('Expected a Chrome placement');
  const signer = await keys(), expiresAt = new Date(Date.now() + 60_000).toISOString(), issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: signer.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
  const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, signer.key.privateKey, authority);
  const attemptId = crypto.randomUUID();
  return signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: manage ? 'browser_control' : 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: manage ?? { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId: placement.pairingId }, grant } }, signer.key.privateKey, authority);
}

/** A step on the Chrome: its workspace group now exists, and the step's attempt is live for a minute. */
async function step(relay: UserRelayDO, root: Identity, browser: Chrome, projectId: string, workspaceId: string) {
  if (!browser.placement) throw new Error('Expected an approved Chrome');
  const signed = await authorization(root, browser.placement, projectId, workspaceId);
  if (signed.body.command.type !== 'execute') throw new Error('Expected a step');
  expect((await relay.browserRelayExecute(signed)).status).toBe('completed');
  return { groupId: signed.body.command.grant.body.groupId, attemptId: signed.body.scope.attemptId };
}

/** The signed request from the extension that begins an upload, signed with its pairing key over `signed` (default:
 * the body sent). */
async function send(browser: Pick<Chrome, 'identity' | 'pairingId' | 'generation'>, body: object, options: { signed?: Uint8Array<ArrayBuffer>; header?: null } = {}) {
  const path = '/api/browser-relay/uploads', bytes = encoder.encode(JSON.stringify(body));
  const issuedAt = Date.now(), nonce = hex(crypto.getRandomValues(new Uint8Array(32))), bodySha256 = hex(await crypto.subtle.digest('SHA-256', options.signed ?? bytes));
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', browser.identity.key.privateKey, encoder.encode(browserSignedText('upload', { pairingId: browser.pairingId, generation: browser.generation, method: 'POST', pathname: path, bodySha256, issuedAt, nonce })))));
  const header = btoa(JSON.stringify({ pairingId: browser.pairingId, generation: browser.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const request = async () => {
    const headers: Record<string, string> = options.header === null ? {} : { [BROWSER_UPLOAD_HEADER]: header };
    const response = await exports.default.fetch(new Request(`https://test.gitspace.sh${path}`, { method: 'POST', headers, body: bytes }));
    return { ...Reply.parse(await response.json()), status: response.status };
  };
  return { ...await request(), again: request };
}
/** One unsigned request through an upload link. */
async function through(link: string, method: string, body: Uint8Array<ArrayBuffer> | object | null = null) {
  const bytes = body === null ? null : body instanceof Uint8Array ? body : encoder.encode(JSON.stringify(body));
  const response = await exports.default.fetch(new Request(link, bytes === null ? { method } : { method, body: bytes }));
  return { ...Reply.parse(await response.json()), status: response.status };
}
const linkOf = (begun: { value?: unknown }) => z.object({ link: z.string().url() }).parse(begun.value).link;
/** Uploads `parts` as one file and completes it. */
async function upload(browser: Chrome, begin: object, parts: Uint8Array<ArrayBuffer>[]) {
  const link = linkOf(await send(browser, begin));
  for (const [index, part] of parts.entries()) expect((await through(`${link}/parts/${index + 1}`, 'PUT', part)).status).toBe(200);
  return through(`${link}/complete`, 'POST', { parts: parts.length, size: parts.reduce((total, part) => total + part.byteLength, 0) });
}

test('an upload from your Chrome begins only signed by a confirmed Chrome for its own live group, once; its link takes its parts in order and lands them in the drive as one file until the session lapses', async () => {
  const { projectId, workspaceId, drive } = await workspace();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { ip: '192.0.2.21' });
    const stranger = await chrome(relay, root, projectId, { ip: '192.0.2.22', confirmed: false });
    try {
      const { groupId, attemptId } = await step(relay, root, browser, projectId, workspaceId);
      const begin = { kind: 'download', groupId, attemptId, name: 'Q3 report.csv', mediaType: 'text/csv' };
      expect(await send(browser, begin, { header: null })).toMatchObject({ status: 401, error: { code: 'UPLOAD_SIGNATURE_REQUIRED' } });
      expect(await send(browser, begin, { signed: encoder.encode('{"kind":"download"}') })).toMatchObject({ status: 401, error: { code: 'UPLOAD_SIGNATURE_INVALID' } });
      expect(await send(stranger, begin)).toMatchObject({ status: 401, error: { code: 'BROWSER_PAIRING_UNCONFIRMED' } });
      expect(await send(browser, { ...begin, groupId: crypto.randomUUID() })).toMatchObject({ status: 403, error: { code: 'UPLOAD_GROUP_UNKNOWN' } });
      expect(await send(browser, { ...begin, attemptId: crypto.randomUUID() })).toMatchObject({ status: 403, error: { code: 'UPLOAD_ATTEMPT_ENDED' } });

      const begun = await send(browser, begin);
      expect(await begun.again()).toMatchObject({ status: 401, error: { code: 'UPLOAD_NONCE_REUSED' } });
      const link = linkOf(begun);
      const part = (number: number, bytes: Uint8Array<ArrayBuffer>) => through(`${link}/parts/${number}`, 'PUT', bytes);
      // Every part but the last is exactly the drive's part size.
      const full = new Uint8Array(TENANT_OBJECT_PART_BYTES), tail = encoder.encode('q3,42\n'), size = full.byteLength + tail.byteLength;
      for (let offset = 0; offset < full.byteLength; offset += 4096) full[offset] = (offset / 4096) % 251;
      expect(await part(2, tail)).toMatchObject({ status: 409, error: { code: 'UPLOAD_PART_OUT_OF_ORDER' } });
      expect(await part(1, full)).toMatchObject({ status: 200, value: { received: full.byteLength } });
      expect(await part(2, tail)).toMatchObject({ status: 200, value: { received: size } });
      // After a short part only completing is left.
      expect(await part(3, tail)).toMatchObject({ status: 409, error: { code: 'UPLOAD_PART_SHORT' } });
      expect(await through(`${link}/complete`, 'POST', { parts: 3, size: size + tail.byteLength })).toMatchObject({ status: 409, error: { code: 'UPLOAD_INCOMPLETE' } });
      const day = new Date().toISOString().slice(0, 10), path = `browser/downloads/${day}/Q3 report.csv`;
      expect(await through(`${link}/complete`, 'POST', { parts: 2, size })).toMatchObject({ status: 200, value: { path: `drive://workspace/browser/downloads/${day}/Q3%20report.csv`, size, mediaType: 'text/csv' } });
      expect((await drive.list(`browser/downloads/${day}/`)).find(entry => entry.path === path)?.size).toBe(size);
      expect(await drive.read(path, { offset: 0, length: 1024 })).toEqual(full.slice(0, 1024));
      expect(await drive.read(path, { offset: full.byteLength - 2, length: tail.byteLength + 2 })).toEqual(Uint8Array.from([...full.slice(-2), ...tail]));
      // Completed, its link stores nothing more.
      expect(await part(3, tail)).toMatchObject({ status: 404, error: { code: 'UPLOAD_UNKNOWN' } });
      // A second download of the same name keeps the first.
      expect((await upload(browser, begin, [encoder.encode('q4,7\n')])).value).toMatchObject({ path: `drive://workspace/browser/downloads/${day}/Q3%20report%20(2).csv` });

      const idle = linkOf(await send(browser, begin));
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 46 * 60_000);
      expect(await through(`${idle}/parts/1`, 'PUT', encoder.encode('late'))).toMatchObject({ status: 410, error: { code: 'UPLOAD_EXPIRED' } });
      expect(await through(`${idle}/parts/1`, 'PUT', encoder.encode('late'))).toMatchObject({ status: 404, error: { code: 'UPLOAD_UNKNOWN' } });
    } finally { vi.useRealTimers(); browser.socket.close(); stranger.socket.close(); }
  });
});

test('you capture a tab on your Chrome from the Browser tab: the extension uploads its frames and the stop saves the capture; a capture you start in the extension lands the same way', async () => {
  const { projectId, workspaceId, drive } = await workspace();
  const first = jpeg(800, 600, 1), second = jpeg(800, 600, 2), index = { version: 1, frames: [{ t: 0, offset: 0, length: first.byteLength }, { t: 400, offset: first.byteLength, length: second.byteLength }] };
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, projectId, { ip: '192.0.2.31' }, message => message.operation === 'captureStart' ? { captureId: message.captureId, width: 800, height: 600, url: 'https://example.com/docs', title: 'Docs' } : message.operation === 'captureStop' ? { count: 2, width: 800, height: 600, durationMs: 400 } : {});
    try {
      const { groupId } = await step(relay, root, browser, projectId, workspaceId);
      const captureId = crypto.randomUUID(), folder = `browser/captures/${captureId}/`;
      const placement = browser.placement;
      if (!placement) throw new Error('Expected an approved Chrome');
      const manage = async (command: Extract<RuntimeAccountBrowserAuthorizationBody['command'], { type: 'manage' }>) => {
        const reply = (await relay.browserRelayExecute(await authorization(root, placement, projectId, workspaceId, command))).content[0];
        return RuntimeBrowserCaptureSchema.parse(JSON.parse(reply?.type === 'text' ? reply.text : ''));
      };
      // Files for a capture nobody started are refused.
      expect(await send(browser, { kind: 'capture', groupId, captureId, file: 'frames.bin', mediaType: 'application/octet-stream' })).toMatchObject({ status: 403, error: { code: 'UPLOAD_CAPTURE_UNKNOWN' } });

      const started = await manage({ type: 'manage', action: 'captureStart', groupId, targetId: 'your-tab', captureId });
      expect(browser.operations.filter(message => message.operation === 'captureStart')).toEqual([{ operation: 'captureStart', captureId, groupId, targetId: 'your-tab' }]);
      expect(started).toMatchObject({ captureId, name: expect.stringMatching(/^Docs · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u), by: 'you', source: 'relay', target: { groupId, targetId: 'your-tab' }, page: { url: 'https://example.com/docs', title: 'Docs' }, state: 'recording', endedAt: null, tracks: {} });
      expect(RuntimeBrowserCaptureSchema.parse(JSON.parse(decoder.decode(await drive.read(`${folder}capture.json`) ?? new Uint8Array())))).toEqual(started);

      expect((await upload(browser, { kind: 'capture', groupId, captureId, file: 'frames.bin', mediaType: 'application/octet-stream' }, [joined(first, second)])).status).toBe(200);
      expect((await upload(browser, { kind: 'capture', groupId, captureId, file: 'frames.json', mediaType: 'application/json' }, [encoder.encode(JSON.stringify(index))])).status).toBe(200);
      const saved = await manage({ type: 'manage', action: 'captureStop', groupId, captureId });
      expect(saved).toMatchObject({ captureId, state: 'saved', reason: null, endedAt: expect.any(String), tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 2, width: 800, height: 600 } } });
      expect(await drive.read(`${folder}frames.bin`)).toEqual(joined(first, second));
      expect(RuntimeBrowserFramesIndexSchema.parse(JSON.parse(decoder.decode(await drive.read(`${folder}frames.json`) ?? new Uint8Array())))).toEqual(index);
      // Saved, it takes no more files.
      expect(await send(browser, { kind: 'capture', groupId, captureId, file: 'thumbnail.jpg', mediaType: 'image/jpeg' })).toMatchObject({ status: 403, error: { code: 'UPLOAD_CAPTURE_UNKNOWN' } });

      // Your click on Capture in the extension: announced, its video uploaded, then ended.
      const video = crypto.randomUUID(), clip = encoder.encode('webm-bytes');
      browser.socket.send(JSON.stringify({ capture: { event: 'start', captureId: video, groupId, targetId: 'your-tab', track: 'video', sound: true, page: { url: 'https://example.com/talk', title: 'Talk' }, startedAt: new Date().toISOString() } }));
      await expect.poll(async () => (await drive.read(`browser/captures/${video}/capture.json`)) !== null).toBe(true);
      expect((await upload(browser, { kind: 'capture', groupId, captureId: video, file: 'video.webm', mediaType: 'video/webm' }, [clip])).status).toBe(200);
      browser.socket.send(JSON.stringify({ capture: { event: 'end', captureId: video, state: 'saved', reason: null, endedAt: new Date().toISOString(), tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 4000 } } } }));
      const announced = async () => RuntimeBrowserCaptureSchema.parse(JSON.parse(decoder.decode(await drive.read(`browser/captures/${video}/capture.json`) ?? new Uint8Array())));
      await expect.poll(async () => (await announced()).state).toBe('saved');
      expect(await announced()).toMatchObject({ name: expect.stringMatching(/^Talk · /u), by: 'you', source: 'relay', target: { groupId, targetId: 'your-tab' }, tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 4000 } } });

      const views = await captureViews(drive);
      expect(views.map(view => view.capture.captureId).sort()).toEqual([captureId, video].sort());
      const frames = views.find(view => view.capture.captureId === captureId);
      expect(Object.keys(frames?.files ?? {}).sort()).toEqual(['frames.bin', 'frames.json']);
      const binary = await exports.default.fetch(new Request(z.string().parse(frames?.files['frames.bin'])));
      expect(new Uint8Array(await binary.arrayBuffer())).toEqual(joined(first, second));
    } finally { browser.socket.close(); }
  });
});

test('you capture a cloud tab: its screencast frames stream into the drive, and the stop saves the index, a thumbnail and the capture; the list shows newest first with links', async () => {
  const { drive } = await workspace();
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const listeners = new Set<Parameters<BrowserChannel['subscribe']>[0]>();
  const page = { targetId: 'page', type: 'page', url: 'https://example.com/report', title: 'Report', attached: false };
  const upstream: BrowserChannel = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.getTargets') return { targetInfos: [page] };
      if (method === 'Target.attachToTarget') return { sessionId: 'capture-session' };
      if (method === 'Target.getTargetInfo') return { targetInfo: page };
      return {};
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {},
  };
  const shim = await CdpBrowserShim.open(upstream), captures = new CloudCaptures(), groupId = crypto.randomUUID();
  const paint = (image: Uint8Array, sessionId: number) => { for (const listener of listeners) listener({ method: 'Page.screencastFrame', sessionId: 'capture-session', params: { data: browserBase64(image), sessionId, metadata: { deviceWidth: 1280, deviceHeight: 720 } } }); };
  vi.useFakeTimers({ toFake: ['Date'] });
  const record = async (captureId: string, at: string, images: Uint8Array[]) => {
    vi.setSystemTime(Date.parse(at));
    await captures.start(shim, drive, { captureId, groupId, targetId: 'page' });
    for (const [position, image] of images.entries()) { paint(image, position + 1); vi.setSystemTime(Date.now() + 250); }
    return captures.stop(captureId);
  };
  // The earlier capture's folder sorts first by name, so only the start times put the later one first.
  const older = '00000000-0000-4000-8000-000000000000', newer = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const images = [jpeg(1280, 720, 1), jpeg(1280, 720, 2), jpeg(1024, 768, 3)];
  const saved = await record(older, '2026-10-24T10:00:00.000Z', images);
  expect(saved).toMatchObject({ captureId: older, name: 'Report · 2026-10-24 10:00 UTC', by: 'you', source: 'headless', browser: 'Cloud browser', target: { groupId, targetId: 'page' }, page: { url: 'https://example.com/report', title: 'Report' }, startedAt: '2026-10-24T10:00:00.000Z', endedAt: '2026-10-24T10:00:00.750Z', state: 'saved', tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 3, width: 1280, height: 768 } } });
  expect(sent.filter(command => command.sessionId === 'capture-session').map(({ method, params }) => method === 'Page.screencastFrameAck' ? `${method} ${String(params.sessionId)}` : method)).toEqual(['Page.startScreencast', 'Page.screencastFrameAck 1', 'Page.screencastFrameAck 2', 'Page.screencastFrameAck 3', 'Page.stopScreencast']);
  expect(sent.find(command => command.method === 'Page.startScreencast')?.params).toEqual({ format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
  const folder = `browser/captures/${older}/`;
  expect(await drive.read(`${folder}frames.bin`)).toEqual(joined(...images));
  expect(RuntimeBrowserFramesIndexSchema.parse(JSON.parse(decoder.decode(await drive.read(`${folder}frames.json`) ?? new Uint8Array())))).toEqual({ version: 1, frames: [{ t: 0, offset: 0, length: 24 }, { t: 250, offset: 24, length: 24 }, { t: 500, offset: 48, length: 24 }] });
  expect(await drive.read(`${folder}thumbnail.jpg`)).toEqual(images[0]);
  expect(RuntimeBrowserCaptureSchema.parse(JSON.parse(decoder.decode(await drive.read(`${folder}capture.json`) ?? new Uint8Array())))).toEqual(saved);

  await record(newer, '2026-10-24T11:00:00.000Z', [jpeg(800, 600, 4)]);
  await drive.write(`browser/captures/${crypto.randomUUID()}/capture.json`, 'application/json', encoder.encode('{"not":"a capture"}'));
  vi.useRealTimers();
  const views = await captureViews(drive);
  expect(views.map(view => view.capture.captureId)).toEqual([newer, older]);
  expect(Object.keys(views[1]?.files ?? {}).sort()).toEqual(['frames.bin', 'frames.json', 'thumbnail.jpg']);
  const link = z.string().parse(views[1]?.files['frames.json']);
  expect(link).toMatch(/^https:\/\/test\.gitspace\.sh\/files\/[^/]+$/u);
  expect(RuntimeBrowserFramesIndexSchema.parse(await (await exports.default.fetch(new Request(link))).json()).frames).toHaveLength(3);
  // A capture whose recording was lost (the browser closed) is saved as failed when you stop it.
  const lost = crypto.randomUUID();
  await captures.start(shim, drive, { captureId: lost, groupId, targetId: 'page' });
  expect(await new CloudCaptures().stop(lost, undefined, drive)).toMatchObject({ captureId: lost, state: 'failed', reason: 'The cloud browser closed while recording' });
  await captures.stop(lost);
});
