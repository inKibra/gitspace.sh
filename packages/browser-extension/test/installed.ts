import { expect } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import { browserBase64, RuntimeAccountBrowserSignedGrantSchema, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate, type RuntimeAccountBrowserAuthorizationBody } from '@gitspace/protocol-runtime';
import { extensionFiles } from '../src/index.js';
import { browserOverlayFunction } from '../src/overlay.js';

type Tab = { id: number; groupId: number; url: string; index: number; windowId: number };
type Reply = Record<string, unknown> & { error?: string };
type DebuggerEvent = (source: { targetId: string }, method: string, params: object) => void;
type Listener = (message: object, sender: { id: string; url: string }, respond: (value: Reply) => void) => boolean | undefined;
type Command = { targetId: string; method: string; params: Record<string, unknown> };
type Timer = { id: number; at: number; run: () => void };
type Toolbar = { icon: Record<string, { width: number; colors: string[] }>; badge: string; title: string };

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

/** The installed service worker on a Chrome whose workspace group (Chrome group 7) holds an agent tab on each of
 * app.example, a.docs.example and bank.example; bank.example allows single steps only. Timers are fake (`advance`).
 * `local` seeds `chrome.storage.local`; `live` keeps the extension's own relay connection (`relay` completes it)
 * instead of a connected stand-in. */
export async function installed(options: { local?: Record<string, unknown>; live?: boolean } = {}) {
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
  const tabs = new Map<number, Tab>([1, 2, 3].map(id => [id, { id, groupId: 7, url: ['https://app.example/', 'https://a.docs.example/', 'https://bank.example/'][id - 1] ?? '', index: id, windowId: 1 }]));
  const group = { id: 7, title: 'Checkout', color: 'blue', collapsed: false };
  const local = new Map<string, unknown>(Object.entries(options.local ?? {}));
  const alarms = new Map<string, { when?: number; periodInMinutes?: number }>();
  const titles: string[] = [];
  const detached: string[] = [];
  const attached: string[] = [];
  const commands: Command[] = [];
  const sent: object[] = [];
  const listeners: Listener[] = [];
  const toolbar: Toolbar[] = [];
  const current: Toolbar = { icon: {}, badge: '', title: '' };
  const focused: Array<{ tabId: number; windowId: number }> = [];
  const ungrouped: number[] = [];
  let clock = 0;
  let timerId = 0;
  const timers: Timer[] = [];
  let debuggerEvent: DebuggerEvent = () => {};
  let alarmListener: (alarm: { name: string }) => void = () => {};
  /** The relay connections the extension opened, in order. */
  const sockets: Array<{ readyState: number; sent: string[]; onmessage?: (event: { data: string }) => void; onclose?: () => void; close(): void }> = [];
  class WebSocket {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(value); sent.push(JSON.parse(value)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  }
  /** A canvas that keeps the colours drawn on it, as the icon's image. */
  class OffscreenCanvas {
    constructor(readonly width: number) {}
    getContext() {
      const colors: string[] = [];
      const width = this.width;
      return new Proxy({}, {
        get: (_target, property) => property === 'getImageData' ? () => ({ width, colors }) : () => {},
        set: (_target, property, value) => { if (property === 'fillStyle' || property === 'strokeStyle') colors.push(String(value)); return true; },
      });
    }
  }
  const record = () => { toolbar.push({ ...current }); };
  const chrome = {
    runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`, getManifest: () => ({ version: '5.3.0' }), onMessage: { addListener: (listener: Listener) => { listeners.push(listener); } } },
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
      sendCommand: async (source: { targetId: string }, method: string, params: Record<string, unknown> = {}) => { commands.push({ targetId: source.targetId, method, params }); return ANSWERS[method] ?? {}; },
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
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }: { title: string }) => { current.title = title; record(); },
    },
  };
  const context = createContext({
    chrome, crypto, TextEncoder, URL, atob, btoa, console, Uint8Array, WebSocket, OffscreenCanvas,
    navigator: { userAgent: 'Chrome/140.0.0.0' },
    setTimeout: (run: () => void, ms = 0) => { timerId++; timers.push({ id: timerId, at: clock + ms, run }); return timerId; },
    clearTimeout: (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    indexedDB: { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } },
    sent,
  });
  runInContext(extensionFiles('https://account.gitspace.test')['background.js'], context);
  if (!options.live) runInContext('socket = { readyState: 1, send: value => sent.push(JSON.parse(value)), close() { this.readyState = 3; } };', context);
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
  const popup = async (message: object) => {
    const reply = Promise.withResolvers<Reply>();
    expect(listeners.some(listener => listener(message, { id: 'extension', url: chrome.runtime.getURL('popup.html') }, reply.resolve) === true)).toBe(true);
    const result = await reply.promise;
    await settle();
    return result;
  };
  /** Chrome reports a debugger event of a tab; what follows from it has happened once this resolves. */
  const pageEvent = async (targetId: string, method: string, params: object) => { debuggerEvent({ targetId }, method, params); await settle(); };
  /** Chrome fires an alarm. */
  const alarm = async (name: string) => { alarmListener({ name }); await settle(); };
  /** The account answers the extension's latest connection: the pairing handshake, then ready at `protocol`. */
  const relay = async (protocol = 3) => {
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
  return { grant, tabs, group, titles, detached, attached, commands, sentCommands, overlays, sent, local, alarms, sockets, toolbar, focused, ungrouped, execute, authorize, begin, preview, popup, pageEvent, alarm, relay, advance };
}

export const command = (attemptId: string, targetId: string, method: string, params: object = {}) => ({ operation: 'command', attemptId, targetId, method, params });
