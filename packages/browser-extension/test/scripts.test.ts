import { describe, expect, it } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import { browserBase64, RuntimeAccountBrowserSignedGrantSchema, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate } from '@gitspace/protocol-runtime';
import { extensionFiles } from '../src/index.js';

type Tab = { id: number; groupId: number; url: string };
type Reply = { running?: number; log?: Array<{ endReason: string; commands: number; refused: number }>; error?: string };
type DebuggerEvent = (source: { targetId: string }, method: string, params: object) => void;
type Listener = (message: object, sender: { id: string; url: string }, respond: (value: Reply) => void) => boolean | undefined;

const projectId = 'project';
const workspaceId = 'workspace';
const pairingId = crypto.randomUUID();
const placement = { kind: 'account-relay' as const, accountId: 'account', pairingId, generation: 1 };

/** The installed service worker on a Chrome whose workspace group (Chrome group 7) holds an agent tab on each of
 * app.example, a.docs.example and bank.example; bank.example allows single steps only. */
async function installed() {
  const root = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const workspace = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const identity = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair;
  const now = Date.now();
  const issuedAt = new Date(now - 1000).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId, workspaceId, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', workspace.publicKey))), issuedAt, expiresAt }, root.privateKey);
  // As the relay passes it on: parsed, in schema order.
  const grant = RuntimeAccountBrowserSignedGrantSchema.parse(await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId: crypto.randomUUID(), groupName: 'Checkout', source: 'relay', origins: ['app.example', '*.docs.example', 'bank.example'], stepsOnly: ['bank.example'], expiresAt }, workspace.privateKey, authority));
  const key = 'group:' + JSON.stringify(['account', pairingId, projectId, workspaceId]);
  const state = new Map<string, unknown>([
    ['identity', { privateKey: identity.privateKey, trust: { accountId: 'account', publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', root.publicKey))) }, pairingId, generation: 1 }],
    [key, { groupId: grant.body.groupId, chromeGroupId: 7, browserEpoch: 'epoch', members: { 1: { by: 'agent', site: null }, 2: { by: 'agent', site: null }, 3: { by: 'agent', site: null } } }],
  ]);
  const database = { transaction() {
    const tx = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, objectStore: () => ({
      get(key: string) { const request = { result: state.get(key), onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      getAllKeys() { const request = { result: [...state.keys()], onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      put(value: unknown, key: string) { state.set(key, value); },
    }) };
    queueMicrotask(() => tx.oncomplete()); return tx;
  } };
  const tabs = new Map<number, Tab>([[1, { id: 1, groupId: 7, url: 'https://app.example/' }], [2, { id: 2, groupId: 7, url: 'https://a.docs.example/' }], [3, { id: 3, groupId: 7, url: 'https://bank.example/' }]]);
  const group = { id: 7, title: 'Checkout' };
  const titles: string[] = [];
  const detached: string[] = [];
  const sentCommands: string[] = [];
  const sent: object[] = [];
  const listeners: Listener[] = [];
  let debuggerEvent: DebuggerEvent = () => {};
  const chrome = {
    runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`, onMessage: { addListener: (listener: Listener) => { listeners.push(listener); } } },
    storage: { local: { remove: async () => {} }, session: { get: async () => ({ browserEpoch: 'epoch' }), set: async () => {} } },
    debugger: {
      getTargets: async () => [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: 'page', title: 'Page', url: tab.url })),
      attach: async () => {}, detach: async (source: { targetId: string }) => { detached.push(source.targetId); },
      sendCommand: async (_source: object, method: string) => { sentCommands.push(method); return {}; },
      onEvent: { addListener: (listener: DebuggerEvent) => { debuggerEvent = listener; } }, onDetach: { addListener() {} },
    },
    tabs: { get: async (id: number) => tabs.get(id), onUpdated: { addListener() {} }, onCreated: { addListener() {} }, onRemoved: { addListener() {} } },
    tabGroups: { get: async () => ({ ...group }), update: async (_id: number, change: { title: string }) => { group.title = change.title; titles.push(change.title); }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const context = createContext({
    chrome, crypto, TextEncoder, URL, atob, btoa, console, Uint8Array,
    WebSocket: class { static OPEN = 1; readyState = 0; close() {} },
    setTimeout: () => 0, clearTimeout() {},
    indexedDB: { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } },
    sent,
  });
  runInContext(extensionFiles('https://account.gitspace.test')['background.js'], context);
  runInContext('socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };', context);
  const execute = (message: object): Promise<unknown> => runInContext('execute(message)', Object.assign(context, { message }));
  /** Signs and hands the extension one script (`browser.run`) of the workspace. */
  const begin = async (sites?: string[]) => {
    const attemptId = crypto.randomUUID();
    const authorization = await signRuntimeAccountBrowserAuthorization({
      scope: { projectId, workspaceId, conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId, placement, conversationKind: 'main' },
      issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' },
      command: { type: 'execute', args: { action: 'run', source: 'relay', script: 'await page.goto("https://app.example/")', ...(sites ? { sites } : {}) }, grant },
    }, workspace.privateKey, authority);
    await execute({ operation: 'authorize', authorization });
    return attemptId;
  };
  const popup = (message: object) => {
    const reply = Promise.withResolvers<Reply>();
    expect(listeners.some(listener => listener(message, { id: 'extension', url: chrome.runtime.getURL('popup.html') }, reply.resolve) === true)).toBe(true);
    return reply.promise;
  };
  /** Chrome reports a page event of a tab; what the session hears of it has gone out once this resolves. */
  const pageEvent = async (targetId: string, method: string, params: object) => {
    debuggerEvent({ targetId }, method, params);
    for (let turn = 0; turn < 200; turn++) await Promise.resolve();
  };
  return { grant, tabs, group, titles, detached, sentCommands, sent, execute, begin, popup, pageEvent };
}

const command = (attemptId: string, targetId: string, method: string, params: object = {}) => ({ operation: 'command', attemptId, targetId, method, params });

describe('a script on your Chrome', () => {
  it('cannot open, list or drive a tab on a site that allows single steps only', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, url: 'https://bank.example/transfer' })).rejects.toThrow('bank.example allows single steps only, not scripts');
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-3' })).rejects.toThrow('bank.example allows single steps only, not scripts');
    expect(await chrome.execute({ operation: 'tabs', attemptId, groupId: chrome.grant.body.groupId })).toEqual([
      { targetId: 'target-1', title: 'Page', url: 'https://app.example/', addedBy: 'agent' },
      { targetId: 'target-2', title: 'Page', url: 'https://a.docs.example/', addedBy: 'agent' },
    ]);
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    // Opening it starts the screencast that keeps a background tab painting.
    expect(chrome.sentCommands).toEqual(['Page.startScreencast']);
    await chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }));
    expect(chrome.sentCommands).toEqual(['Page.startScreencast', 'Runtime.evaluate']);
    await chrome.pageEvent('target-1', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'cart' }] });
    expect(chrome.sent).toContainEqual(expect.objectContaining({ targetId: 'target-1', method: 'Runtime.consoleAPICalled' }));
    // You take the tab to the bank: the script's next command there is refused, and it hears nothing from the page.
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://bank.example/' });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: 'document.body.innerText' }))).rejects.toThrow('bank.example allows single steps only, not scripts');
    expect(chrome.sentCommands).toEqual(['Page.startScreencast', 'Runtime.evaluate']);
    chrome.sent.length = 0;
    await chrome.pageEvent('target-1', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'balance' }] });
    expect(chrome.sent).toEqual([]);
  });

  it('sees and reaches only the sites it names', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin(['app.example']);
    expect(await chrome.execute({ operation: 'tabs', attemptId, groupId: chrome.grant.body.groupId })).toEqual([{ targetId: 'target-1', title: 'Page', url: 'https://app.example/', addedBy: 'agent' }]);
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-2' })).rejects.toThrow('outside the sites of this script');
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, url: 'https://a.docs.example/' })).rejects.toThrow('outside the sites of this script');
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'https://a.docs.example/' }))).rejects.toThrow('outside the sites of this script');
    expect(chrome.sentCommands).toEqual(['Page.startScreencast']);
  });

  it('is refused a site its grant does not hold or one that allows single steps only', async () => {
    const chrome = await installed();
    await expect(chrome.begin(['elsewhere.example'])).rejects.toThrow('elsewhere.example is not a site of this workspace group');
    await expect(chrome.begin(['bank.example'])).rejects.toThrow('bank.example allows single steps only, not scripts');
  });

  it('marks its group while it runs and stops with Stop scripts: commands refused, tabs let go, run logged', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    expect(chrome.group.title).toBe('▶ Checkout');
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }));
    await expect(chrome.execute(command(attemptId, 'target-1', 'Storage.getCookies'))).rejects.toThrow();
    expect(await chrome.popup({ runStatus: true })).toEqual({ running: 1, log: [] });

    const stopped = await chrome.popup({ stopRuns: true });
    expect(stopped.running).toBe(0);
    expect(stopped.log).toEqual([expect.objectContaining({ attemptId, endReason: 'stopped', commands: 3, refused: 1 })]);
    expect(chrome.group.title).toBe('Checkout');
    expect(chrome.detached).toEqual(['target-1']);
    expect(chrome.sent).toContainEqual({ targetId: 'target-1', fenced: true });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '2' }))).rejects.toThrow('You stopped this script in Chrome');
    await expect(chrome.execute({ operation: 'tabs', attemptId, groupId: chrome.grant.body.groupId })).rejects.toThrow('You stopped this script in Chrome');
  });

  it('keeps its group marked until the last script on it ends', async () => {
    const chrome = await installed();
    const first = await chrome.begin();
    const second = await chrome.begin();
    await chrome.execute({ operation: 'release', attemptId: first });
    expect(chrome.group.title).toBe('▶ Checkout');
    await chrome.execute({ operation: 'release', attemptId: second });
    expect(chrome.titles).toEqual(['▶ Checkout', 'Checkout']);
    expect((await chrome.popup({ runStatus: true })).log?.map(entry => entry.endReason)).toEqual(['released', 'released']);
  });
});
