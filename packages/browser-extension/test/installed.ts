import { expect } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import { browserBase64, RuntimeAccountBrowserSignedGrantSchema, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserAuthorizationBody } from '@gitspace/protocol-runtime';
import { extensionFiles } from '../src/index.js';
import { browserOverlayFunction } from '../src/overlay.js';

type Tab = { id: number; groupId: number; url: string; index: number; windowId: number; title?: string };
type Reply = Record<string, unknown> & { error?: string };
type DebuggerEvent = (source: { targetId: string }, method: string, params: object) => void;
type Sender = { id: string; url: string };
type Listener = (message: Record<string, unknown>, sender: Sender, respond: (value: unknown) => void) => boolean | undefined;
/** One DevTools command the extension sent to a tab. */
export type DebuggerCommand = { targetId: string; method: string; params: Record<string, unknown> };
type Timer = { id: number; at: number; run: () => void };
type Toolbar = { icon: Record<string, { width: number; colors: string[] }>; badge: string; title: string; badgeColor: string };
/** One request the extension made to its account, as the account received it. */
export type AccountRequest = { method: string; pathname: string; header: string | null; body: Uint8Array<ArrayBuffer> };
/** A Chrome download as `chrome.downloads` reports it. */
export type DownloadItem = { id: number; url: string; finalUrl: string; mime: string; filename: string; state: string; byExtensionId?: string };
/** The offscreen document's fake media: the recorder the extension made, and the stream it recorded. */
export type Recorder = { mimeType: string; slice: number; state: string; emit(bytes: Uint8Array<ArrayBuffer>): void };

const projectId = 'project';
const workspaceId = 'workspace';
/** Commands the extension sends for the in-page overlay, apart from those the agent's commands cause. */
const OVERLAY_METHODS: Record<string, true> = { 'Page.getFrameTree': true, 'Page.createIsolatedWorld': true, 'Runtime.addBinding': true };
/** What the fake debugger answers, by method; anything else answers `{}`. */
const ANSWERS: Record<string, object> = {
  'Page.getFrameTree': { frameTree: { frame: { id: 'main' } } },
  'Page.createIsolatedWorld': { executionContextId: 50 },
  'Page.getLayoutMetrics': { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } },
  'Page.captureScreenshot': { data: 'JPEG' },
};

/** Lets the extension's pending work finish: microtasks, and the host's crypto, which resolves on the event loop. */
export async function settle() {
  for (let turn = 0; turn < 20; turn++) {
    const loop = Promise.withResolvers<void>();
    setImmediate(loop.resolve);
    await loop.promise;
    for (let step = 0; step < 50; step++) await Promise.resolve();
  }
}

/** A 32×16 JPEG header, as a screencast frame (base64): enough for its size to be read. */
export const FRAME = browserBase64(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0xff, 0xd9]));

/** The installed service worker on a Chrome whose workspace group (Chrome group 7) holds an agent tab on each of
 * app.example, a.docs.example and bank.example; bank.example allows single steps only. Timers are fake (`advance`).
 * `local` seeds `chrome.storage.local`; `live` keeps the extension's own relay connection (`relay` completes it)
 * instead of a connected stand-in, which speaks `protocol` (an account that saves captures and downloads from 5).
 * The account answers uploads (`requests`, `uploads`) and serves sealed drive files (`files`); `hold` delays an
 * upload request until the test lets it go. Capture's offscreen document runs as Chrome would load it (`recorders`). */
export async function installed(options: { local?: Record<string, unknown>; live?: boolean; protocol?: number } = {}) {
  const root = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const workspace = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const identity = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const pairingId = crypto.randomUUID();
  const placement = { kind: 'account-relay' as const, accountId: 'account', pairingId, generation: 1 };
  const now = Date.now();
  const issuedAt = new Date(now - 1000).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId, workspaceId, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', workspace.publicKey))), issuedAt, expiresAt }, root.privateKey);
  // As the relay passes it on: parsed, in schema order.
  const grant = RuntimeAccountBrowserSignedGrantSchema.parse(await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Checkout', source: 'relay', origins: ['app.example', '*.docs.example', 'bank.example'], stepsOnly: ['bank.example'], expiresAt }, workspace.privateKey, authority));
  const key = 'group:' + JSON.stringify(['account', pairingId, projectId, workspaceId]);
  const state = new Map<string, unknown>([
    ['identity', { privateKey: identity.privateKey, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', root.publicKey))), trust: { accountId: 'account', publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', root.publicKey))) }, pairingId, generation: 1 }],
    [key, { groupId: grant.body.groupId, chromeGroupId: 7, browserEpoch: 'epoch', members: { 1: { by: 'agent', site: null }, 2: { by: 'agent', site: null }, 3: { by: 'agent', site: null } } }],
  ]);
  const database = { transaction() {
    const tx = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, objectStore: () => ({
      get(key: string) { const request = { result: state.get(key), onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      getAllKeys() { const request = { result: [...state.keys()], onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      put(value: unknown, key: string) { state.set(key, value); },
      delete(key: string) { state.delete(key); },
    }) };
    queueMicrotask(() => tx.oncomplete()); return tx;
  } };
  const tabs = new Map<number, Tab>([1, 2, 3].map(id => [id, { id, groupId: 7, url: ['https://app.example/', 'https://a.docs.example/', 'https://bank.example/'][id - 1] ?? '', index: id, windowId: 1, title: 'Page' }]));
  const group = { id: 7, title: 'Checkout', color: 'blue', collapsed: false };
  const local = new Map<string, unknown>(Object.entries(options.local ?? {}));
  const alarms = new Map<string, { when?: number; periodInMinutes?: number }>();
  const titles: string[] = [];
  const detached: string[] = [];
  const attached: string[] = [];
  const commands: DebuggerCommand[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const listeners: Listener[] = [];
  const toolbar: Toolbar[] = [];
  const current: Toolbar = { icon: {}, badge: '', title: '', badgeColor: '' };
  const focused: Array<{ tabId: number; windowId: number }> = [];
  const ungrouped: number[] = [];
  let clock = 0;
  let timerId = 0;
  const timers: Timer[] = [];
  let debuggerEvent: DebuggerEvent = () => {};
  let alarmListener: (alarm: { name: string }) => void = () => {};
  /** Tests waiting for something the extension sends: checked again whenever a request reaches the account or a
   * message reaches the relay. */
  const waiters: Array<{ check: () => boolean; resolve: () => void }> = [];
  const notify = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); } };
  /** Answers a debugger command instead of `ANSWERS` when it returns something. */
  let answer: (command: DebuggerCommand) => unknown = () => undefined;
  /** The relay connections the extension opened, in order. */
  const sockets: Array<{ readyState: number; sent: string[]; onmessage?: (event: { data: string }) => void; onclose?: () => void; close(): void }> = [];
  class WebSocket {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(value); sent.push(JSON.parse(value)); notify(); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  }
  /** A canvas that keeps the colours drawn on it, as the icon's image. */
  class OffscreenCanvas {
    constructor(readonly width: number, readonly height = width) {}
    getContext() {
      const colors: string[] = [];
      const width = this.width;
      return new Proxy({}, {
        get: (_target, property) => property === 'getImageData' ? () => ({ width, colors }) : () => {},
        set: (_target, property, value) => { if (property === 'fillStyle' || property === 'strokeStyle') colors.push(String(value)); return true; },
      });
    }
    async convertToBlob() { return new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }); }
  }
  const record = () => { toolbar.push({ ...current }); };

  // The account: uploads in parts, and sealed drive files.
  const requests: AccountRequest[] = [];
  const uploads = new Map<string, { begin: Record<string, unknown>; parts: Uint8Array<ArrayBuffer>[]; completed: boolean; aborted: boolean }>();
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const held: Array<{ matches: (request: AccountRequest) => boolean; release: Promise<void> }> = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetch = async (input: URL | string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer>; credentials?: string } = {}) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://account.gitspace.test') throw new Error(`Unexpected fetch of ${url.href}`);
    if (url.pathname.startsWith('/files/')) {
      const bytes = files.get(url.pathname);
      return bytes ? new Response(bytes) : new Response('Not found', { status: 404 });
    }
    const request = { method: init.method ?? 'GET', pathname: url.pathname, header: init.headers?.['x-gitspace-browser-upload'] ?? null, body: init.body ?? new Uint8Array(0) };
    requests.push(request);
    notify();
    for (const hold of held) if (hold.matches(request)) await hold.release;
    if (request.method === 'POST' && url.pathname === '/api/browser-relay/uploads') {
      const begin = JSON.parse(new TextDecoder().decode(request.body));
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, { begin, parts: [], completed: false, aborted: false });
      return json({ status: 'ok', value: { link: `${url.origin}/api/uploads/${id}`, expiresAt: new Date(Date.now() + 900_000).toISOString(), path: `drive://workspace/${begin.file ?? begin.name}` } });
    }
    // The upload's link: parts numbered from 1, each the next one, then complete or abandon.
    const [api, route, uploadId, step, index] = url.pathname.split('/').slice(1);
    const upload = api === 'api' && route === 'uploads' && uploadId ? uploads.get(uploadId) : undefined;
    if (!upload) return new Response(JSON.stringify({ status: 'error', error: { code: 'UPLOAD_LINK_UNKNOWN', message: 'Unknown upload link' } }), { status: 404 });
    if (request.method === 'PUT' && step === 'parts') {
      if (Number(index) !== upload.parts.length + 1) return new Response(JSON.stringify({ status: 'error', error: { code: 'UPLOAD_PART_REFUSED', message: `Expected part ${upload.parts.length + 1}` } }), { status: 409 });
      upload.parts.push(request.body);
      return json({ status: 'ok', value: { received: upload.parts.reduce((sum, part) => sum + part.byteLength, 0) } });
    }
    if (request.method === 'POST' && step === 'complete') { upload.completed = true; const size = upload.parts.reduce((sum, part) => sum + part.byteLength, 0); return json({ status: 'ok', value: { path: `drive://workspace/${upload.begin.file ?? upload.begin.name}`, size, mediaType: upload.begin.mediaType } }); }
    if (request.method === 'DELETE' && step === undefined) { upload.aborted = true; return json({ status: 'ok', value: {} }); }
    throw new Error(`Unexpected account request ${request.method} ${url.pathname}`);
  };
  /** Holds the account's answer to matching upload requests until `release` runs. */
  const hold = (matches: (request: AccountRequest) => boolean) => { const gate = Promise.withResolvers<void>(); held.push({ matches, release: gate.promise }); return gate.resolve; };
  /** The bytes of a completed upload, by what it began as. */
  const uploaded = (matches: (begin: Record<string, unknown>) => boolean) => [...uploads.values()].filter(upload => upload.completed && matches(upload.begin)).map(upload => ({ begin: upload.begin, bytes: Buffer.concat(upload.parts) }));

  // Chrome's downloads.
  let downloadCreated: (item: DownloadItem) => void = () => {};
  const downloadItems = new Map<number, DownloadItem>();
  const downloadCalls: string[] = [];

  // The offscreen document, loaded when the extension creates it.
  const offscreenListeners: Listener[] = [];
  let offscreenOpen = false;
  const offscreenCreated: object[] = [];
  const recorders: Recorder[] = [];
  const streamIds: Array<{ targetTabId: number }> = [];
  const captureGrants = new Set<number>();
  const workerSender = { id: 'extension', url: 'chrome-extension://extension/background.js' };
  const offscreenSender = { id: 'extension', url: 'chrome-extension://extension/offscreen.html' };
  /** Delivers a runtime message as Chrome does: to every listener of the other contexts; the first to answer wins. */
  const deliver = (to: Listener[], message: Record<string, unknown>, sender: Sender) => {
    const reply = Promise.withResolvers<unknown>();
    let waiting = false;
    for (const listener of to) if (listener(message, sender, reply.resolve) === true) waiting = true;
    if (!waiting) { if (!to.length) reply.reject(new Error('Could not establish connection. Receiving end does not exist.')); else reply.resolve(undefined); }
    return reply.promise;
  };
  const loadOffscreen = () => {
    class MediaRecorder {
      static isTypeSupported(type: string) { return type === 'video/webm;codecs=vp9,opus'; }
      state = 'inactive';
      slice = 0;
      ondataavailable: (event: { data: Blob }) => void = () => {};
      onstop: () => void = () => {};
      constructor(readonly stream: object, readonly options: { mimeType: string }) {
        const recorder = this;
        recorders.push({ mimeType: options.mimeType, get slice() { return recorder.slice; }, get state() { return recorder.state; }, emit: bytes => recorder.ondataavailable({ data: new Blob([bytes]) }) });
      }
      start(slice: number) { this.state = 'recording'; this.slice = slice; }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob([Uint8Array.from([9, 9])]) }); queueMicrotask(() => this.onstop()); }
    }
    const track = (kind: string) => ({ kind, readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} });
    const context = createContext({
      chrome: { runtime: { id: 'extension', onMessage: { addListener: (listener: Listener) => { offscreenListeners.push(listener); } }, sendMessage: (message: Record<string, unknown>) => deliver(listeners, message, offscreenSender) } },
      navigator: { mediaDevices: { getUserMedia: async (constraints: { video: { mandatory: { chromeMediaSourceId: string } } }) => {
        if (!constraints.video.mandatory.chromeMediaSourceId.startsWith('stream-')) throw new Error('Invalid stream');
        const tracks = [track('video'), track('audio')];
        return { getTracks: () => tracks, getVideoTracks: () => tracks.slice(0, 1), getAudioTracks: () => tracks.slice(1) };
      } } },
      AudioContext: class { createMediaStreamSource() { return { connect() {} }; } destination = {}; async close() {} },
      ImageCapture: class { async grabFrame() { return { width: 1280, height: 720 }; } },
      MediaRecorder, OffscreenCanvas, fetch, crypto, TextEncoder, URL, atob, btoa, Uint8Array, console, Blob,
      setTimeout: (run: () => void, ms = 0) => { timerId++; timers.push({ id: timerId, at: clock + ms, run }); return timerId; },
      clearTimeout: (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
      setInterval: () => 0, clearInterval: () => {},
    });
    runInContext(extensionFiles('https://account.gitspace.test')['offscreen.js'] ?? '', context);
  };

  const chrome = {
    runtime: {
      id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`, getManifest: () => ({ version: '5.5.0' }), onMessage: { addListener: (listener: Listener) => { listeners.push(listener); } },
      getContexts: async () => offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [],
      sendMessage: (message: Record<string, unknown>) => deliver(offscreenListeners, message, workerSender),
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => local.has(key)).map(key => [key, local.get(key)])),
        set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) local.set(key, value); },
        remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key); },
      },
      session: { get: async () => ({ browserEpoch: 'epoch' }), set: async () => {} },
    },
    debugger: {
      getTargets: async () => [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: 'page', title: 'Page', url: tab.url })),
      attach: async (source: { targetId: string }) => { attached.push(source.targetId); },
      detach: async (source: { targetId: string }) => { detached.push(source.targetId); },
      sendCommand: async (source: { targetId: string }, method: string, params: Record<string, unknown> = {}) => { const command = { targetId: source.targetId, method, params }; commands.push(command); return answer(command) ?? ANSWERS[method] ?? {}; },
      onEvent: { addListener: (listener: DebuggerEvent) => { debuggerEvent = listener; } }, onDetach: { addListener() {} },
    },
    tabs: {
      get: async (id: number) => tabs.get(id),
      query: async (query: { groupId?: number; active?: boolean }) => query.active ? [...tabs.values()].slice(0, 1) : [...tabs.values()].filter(tab => tab.groupId === query.groupId),
      update: async (tabId: number) => { focused.push({ tabId, windowId: tabs.get(tabId)?.windowId ?? -1 }); },
      ungroup: async (tabId: number) => { ungrouped.push(tabId); },
      onUpdated: { addListener() {} }, onCreated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    tabGroups: { get: async () => ({ ...group }), update: async (_id: number, change: { title?: string }) => { if (change.title !== undefined) { group.title = change.title; titles.push(change.title); } }, onRemoved: { addListener() {} } },
    windows: { update: async () => {} },
    alarms: {
      create: async (name: string, info: { when?: number; periodInMinutes?: number }) => { alarms.set(name, info); },
      clear: async (name: string) => alarms.delete(name),
      onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => { alarmListener = listener; } },
    },
    action: {
      setIcon: async ({ imageData }: { imageData: Toolbar['icon'] }) => { current.icon = imageData; record(); },
      setBadgeText: async ({ text }: { text: string }) => { current.badge = text; },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { current.badgeColor = color; },
      setTitle: async ({ title }: { title: string }) => { current.title = title; record(); },
    },
    downloads: {
      onCreated: { addListener: (listener: (item: DownloadItem) => void) => { downloadCreated = listener; } },
      cancel: async (id: number) => { downloadCalls.push(`cancel:${id}`); const item = downloadItems.get(id); if (item && item.state === 'in_progress') item.state = 'interrupted'; },
      search: async ({ id }: { id: number }) => { const item = downloadItems.get(id); return item ? [{ ...item }] : []; },
      removeFile: async (id: number) => { downloadCalls.push(`removeFile:${id}`); },
      erase: async ({ id }: { id: number }) => { downloadCalls.push(`erase:${id}`); downloadItems.delete(id); },
    },
    tabCapture: {
      getMediaStreamId: async (options: { targetTabId: number }) => {
        streamIds.push(options);
        if (!captureGrants.has(options.targetTabId)) throw new Error('Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.');
        return `stream-${options.targetTabId}`;
      },
    },
    offscreen: {
      createDocument: async (parameters: object) => { offscreenCreated.push(parameters); offscreenOpen = true; loadOffscreen(); },
      closeDocument: async () => { offscreenOpen = false; offscreenListeners.length = 0; },
    },
  };
  const context = createContext({
    chrome, crypto, TextEncoder, URL, atob, btoa, console, Uint8Array, WebSocket, OffscreenCanvas, fetch,
    navigator: { userAgent: 'Chrome/140.0.0.0' },
    setTimeout: (run: () => void, ms = 0) => { timerId++; timers.push({ id: timerId, at: clock + ms, run }); return timerId; },
    clearTimeout: (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    indexedDB: { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } },
    sent, notify,
  });
  runInContext(extensionFiles('https://account.gitspace.test')['background.js'] ?? '', context);
  if (!options.live) runInContext(`socket = { readyState: 1, send: value => { sent.push(JSON.parse(value)); notify(); }, close() { this.readyState = 3; } }; connected = true; accountProtocol = ${options.protocol ?? 4};`, context);
  await settle();
  /** Runs the timers due within `ms` of fake time, in order. */
  const advance = async (ms: number) => {
    clock += ms;
    for (let due = timers.filter(timer => timer.at <= clock).sort((a, b) => a.at - b.at); due.length; due = timers.filter(timer => timer.at <= clock).sort((a, b) => a.at - b.at)) {
      for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
      await settle();
    }
  };
  const execute = (message: object): Promise<unknown> => runInContext('execute(message)', Object.assign(context, { message }));
  /** Signs and hands the extension one authorization of the workspace: a script (`browser.run`) by default. */
  const authorize = async (command: RuntimeAccountBrowserAuthorizationBody['command'], tool: 'browser' | 'browser_control') => {
    const attemptId = crypto.randomUUID();
    const authorization = await signRuntimeAccountBrowserAuthorization({
      scope: { projectId, workspaceId, conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId, placement, conversationKind: 'main' },
      issuedAt, expiresAt, dispatch: { version: 1, tool, deadlineAt: expiresAt, replay: 'unsafe' }, command,
    }, workspace.privateKey, authority);
    await execute({ operation: 'authorize', authorization });
    return attemptId;
  };
  const begin = (sites?: string[]) => authorize({ type: 'execute', args: { action: 'run', source: 'relay', script: 'await page.goto("https://app.example/")', ...(sites ? { sites } : {}) }, grant }, 'browser');
  /** The account asks for a preview of one group tab, signed for that tab. */
  const preview = async (targetId: string) => {
    await authorize({ type: 'manage', action: 'preview', groupId: grant.body.groupId, targetId }, 'browser_control');
    return execute({ operation: 'preview', groupId: grant.body.groupId, targetId });
  };
  /** The popup asks the service worker; with `waitFor`, the answer may wait on other work the test does meanwhile. */
  const popup = async (message: object) => {
    const reply = Promise.withResolvers<Reply>();
    expect(listeners.some(listener => listener({ ...message }, { id: 'extension', url: chrome.runtime.getURL('popup.html') }, value => reply.resolve(value as Reply)) === true)).toBe(true);
    const result = await reply.promise;
    await settle();
    return result;
  };
  /** Chrome reports a debugger event of a tab; what follows from it has happened once this resolves. */
  const pageEvent = async (targetId: string, method: string, params: object) => { debuggerEvent({ targetId }, method, params); await settle(); };
  /** Chrome reports a download it began. */
  const download = async (item: DownloadItem) => { downloadItems.set(item.id, item); downloadCreated(item); await settle(); };
  /** Resolves once `check` holds, as requests reach the account and messages the relay (uploads hash and sign on the
   * host's crypto threads, so they finish on no fixed turn), then lets the work that follows finish. */
  const waitFor = async (check: () => boolean) => {
    if (!check()) { const done = Promise.withResolvers<void>(); waiters.push({ check, resolve: done.resolve }); await done.promise; }
    await settle();
  };
  /** Chrome fires an alarm. */
  const alarm = async (name: string) => { alarmListener({ name }); await settle(); };
  /** The account answers the extension's latest connection: the pairing handshake, then ready at `protocol`. */
  const relay = async (protocol = 4) => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('The extension opened no relay connection');
    socket.readyState = 1;
    socket.onmessage?.({ data: JSON.stringify({ pairing: 'challenge', serverNonce: 'a'.repeat(64) }) }); await settle();
    socket.onmessage?.({ data: JSON.stringify({ pairing: 'server' }) }); await settle();
    socket.onmessage?.({ data: JSON.stringify({ ready: true, protocol }) }); await settle();
  };
  /** The methods the extension sent to tabs for the agent, without those that draw the overlay. */
  const sentCommands = () => commands.filter(({ method, params }) => !OVERLAY_METHODS[method] && params.functionDeclaration !== browserOverlayFunction).map(({ method }) => method);
  /** What the extension asked the overlay of each tab to do, in order. */
  const overlays = (targetId: string) => commands.filter(command => command.targetId === targetId && command.params.functionDeclaration === browserOverlayFunction).map(({ params }) => Array.isArray(params.arguments) ? params.arguments[0]?.value : undefined);
  /** Whether an upload request is authorized as the account requires: a begin carries this Chrome's signature over its
   * method, path, body hash, time and nonce; a request to an upload's link carries no signature at all. */
  const authorizedAsRequired = async (request: AccountRequest) => {
    if (request.pathname !== '/api/browser-relay/uploads') return request.pathname.startsWith('/api/uploads/') && request.header === null;
    if (!request.header) return false;
    const proof = JSON.parse(Buffer.from(request.header, 'base64url').toString());
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', request.body)).toString('hex');
    const message = `gitspace-browser-relay-v2:upload:${proof.pairingId}:${proof.generation}:${request.method}:${request.pathname}:${digest}:${proof.issuedAt}:${proof.nonce}`;
    return proof.pairingId === pairingId && proof.generation === 1 && crypto.subtle.verify('Ed25519', identity.publicKey, Buffer.from(proof.signature, 'base64'), new TextEncoder().encode(message));
  };
  return {
    grant, tabs, group, titles, detached, attached, commands, sentCommands, overlays, sent, local, alarms, sockets, toolbar, focused, ungrouped,
    requests, uploads, uploaded, files, hold, authorizedAsRequired, downloadCalls, download, recorders, streamIds, captureGrants, offscreenCreated, isOffscreenOpen: () => offscreenOpen,
    execute, authorize, begin, preview, popup, pageEvent, alarm, relay, advance, waitFor,
    answer: (respond: (command: DebuggerCommand) => unknown) => { answer = respond; },
  };
}

export const command = (attemptId: string, targetId: string, method: string, params: object = {}) => ({ operation: 'command', attemptId, targetId, method, params });
