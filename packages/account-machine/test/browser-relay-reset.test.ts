import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { browserRelayExtension, browserRelayPopup } from '../src/browser-relay-extension.js';

type Reply = { ok?: boolean; error?: string; fingerprint?: string | null };
type Listener = (message: object, sender: { id: string; url: string }, reply: (value: Reply) => void) => boolean | undefined;

it('resets the generated extension identity, detaches sessions, and preserves replay fences while pairing a new key', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
  const trust = { algorithm: 'Ed25519', accountId: 'account', publicKey };
  const state = new Map<string, unknown>([
    ['identity', { privateKey: keys.privateKey, publicKey, trust, machineId: 'machine' }],
    ['replays', [['consumed-attempt', Date.now() + 60_000]]],
    ['generation:attachment', 7],
  ]);
  // Minimal asynchronous IndexedDB adapter exercises the installed program, not a second reset implementation.
  const database = { transaction() {
    const transaction = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, objectStore: () => ({
      get(key: string) { const request = { result: state.get(key), onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      put(value: unknown, key: string) { state.set(key, value); },
      delete(key: string) { state.delete(key); },
    }) };
    queueMicrotask(() => transaction.oncomplete()); return transaction;
  } };
  const indexedDB = { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {}, onupgradeneeded: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } };
  const connections: Array<{ readyState: number; close: () => void }> = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { connections.push(this); }
    close() { this.readyState = 3; }
  }
  let listener: Listener | undefined;
  const detach = vi.fn(async () => {});
  const chrome = {
    runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`, onMessage: { addListener: (value: Listener) => { listener = value; } } },
    storage: { local: { remove: vi.fn(async () => {}) } },
    debugger: { detach, onEvent: { addListener() {} }, onDetach: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} } },
    tabGroups: { onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const context = createContext({ chrome, indexedDB, WebSocket: Socket, crypto, TextEncoder, TextDecoder, URL, atob, btoa, setTimeout: () => 0, clearTimeout() {}, console });
  runInContext(browserRelayExtension('http://127.0.0.1:9224'), context);
  const invoke = async (message: object) => {
    const reply = Promise.withResolvers<Reply>();
    expect(listener?.(message, { id: 'extension', url: chrome.runtime.getURL('popup.html') }, reply.resolve)).toBe(true);
    const result = await reply.promise;
    await (runInContext('identityOperations', context) as Promise<void>);
    return result;
  };
  await (runInContext('connect()', context) as Promise<void>);
  const previous = connections[0];
  const originalFingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: originalFingerprint });
  expect(previous?.readyState).toBe(1);
  expect(listener?.({ identityStatus: true }, { id: 'extension', url: 'https://untrusted.example/' }, () => { throw new Error('Untrusted identity read'); })).toBeUndefined();
  runInContext("channels.set('active', { source: { targetId: 'target' } }); authorizations.set('active', {});", context);
  expect(listener?.({ resetIdentity: true }, { id: 'extension', url: 'https://untrusted.example/' }, () => { throw new Error('Untrusted sender received a reset response'); })).toBeUndefined();
  expect(state.has('identity')).toBe(true);
  const command = Promise.withResolvers<void>();
  Object.assign(context, { commandGate: command.promise });
  runInContext("queues.set('commands', commandGate.then(() => channels.set('late', { source: { targetId: 'late-target' } })));", context);
  const reset = invoke({ resetIdentity: true });
  await Promise.resolve();
  expect(state.has('identity')).toBe(true);
  command.resolve();
  expect(await reset).toEqual({ ok: true });
  expect(state.has('identity')).toBe(false);
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: null });
  expect(previous?.readyState).toBe(3);
  expect(detach).toHaveBeenCalledWith({ targetId: 'target' });
  expect(detach).toHaveBeenCalledWith({ targetId: 'late-target' });
  expect(runInContext('channels.size + authorizations.size', context)).toBe(0);
  expect(state.get('generation:attachment')).toBe(7);
  expect(state.get('replays')).toEqual([['consumed-attempt', expect.any(Number)]]);
  expect(await invoke({ pair: { code: 'fresh-code', machineId: 'machine', trust } })).toEqual({ ok: true });
  const replacement = state.get('identity') as { privateKey: CryptoKey; publicKey: string; trust: unknown };
  expect(replacement.publicKey).not.toBe(publicKey);
  expect(replacement.privateKey.extractable).toBe(false);
  expect(replacement.trust).toEqual(trust);
  const replacementFingerprint = createHash('sha256').update(Buffer.from(replacement.publicKey, 'base64')).digest('hex');
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: replacementFingerprint });
  expect(replacementFingerprint).not.toBe(originalFingerprint);
  expect(await invoke({ pair: { code: 'another-code', machineId: 'machine', trust } })).toEqual({ ok: true });
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: replacementFingerprint });
  expect(state.get('generation:attachment')).toBe(7);
});

it('loads the actual worker fingerprint on popup startup and refreshes after pair and reset', async () => {
  let fingerprint: string | null = null;
  const elements = Object.fromEntries(['fingerprint', 'status', 'code', 'pair', 'reset'].map(id => [id, { textContent: '', value: '', addEventListener() {} }]));
  let rendered = Promise.withResolvers<string>();
  let displayedFingerprint = '';
  Object.defineProperty(elements.fingerprint, 'textContent', {
    get: () => displayedFingerprint,
    set: (value: string) => { displayedFingerprint = value; rendered.resolve(value); },
  });
  const context = createContext({
    document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
    chrome: { runtime: { sendMessage: async (message: { identityStatus?: boolean; pair?: boolean; resetIdentity?: boolean }) => {
      if (message.identityStatus) return { fingerprint };
      fingerprint = message.resetIdentity ? null : 'a'.repeat(64); return { ok: true };
    } } },
  });
  runInContext(browserRelayPopup(), context);
  await rendered.promise;
  expect(elements.fingerprint?.textContent).toBe('No identity. Pair to generate a key.');
  await runInContext("action(() => ({ pair: true }), 'Paired')", context);
  expect(elements.fingerprint?.textContent).toBe('a'.repeat(64));
  await runInContext("action(() => ({ resetIdentity: true }), 'Reset')", context);
  expect(elements.fingerprint?.textContent).toBe('No identity. Pair to generate a key.');
  fingerprint = 'b'.repeat(64);
  rendered = Promise.withResolvers<string>();
  runInContext(browserRelayPopup(), context);
  await rendered.promise;
  expect(elements.fingerprint?.textContent).toBe('b'.repeat(64));
});

it('discovers dragged-in members and immediately denies dragged-out or disallowed targets', async () => {
  const expiresAt = new Date(Date.now()+60_000).toISOString();
  const grant = {groupId:'group',groupName:'Workspace',source:'relay',origins:['approved.example'],expiresAt};
  const tabs = new Map([[1,{groupId:7,url:'https://approved.example/'}],[2,{groupId:-1,url:'https://approved.example/'}]]);
  const context = createContext({
    crypto,TextEncoder,URL,atob,btoa,console,WebSocket,setTimeout,clearTimeout,
    indexedDB:{open:()=>({})},
    chrome:{
      runtime:{onMessage:{addListener(){}}},
      storage:{local:{remove:async()=>{}}},
      debugger:{getTargets:async()=>[...tabs].map(([id,tab])=>({id:String(id),tabId:id,type:'page',title:'Page',url:tab.url})),onEvent:{addListener(){}},onDetach:{addListener(){}}},
      tabs:{get:async(id:number)=>tabs.get(id),onUpdated:{addListener(){}}},
      tabGroups:{onRemoved:{addListener(){}}},
      alarms:{create(){},onAlarm:{addListener(){}}},
    },grant,expiresAt,
  });
  runInContext(browserRelayExtension('http://127.0.0.1:9224'),context);
  runInContext("groupRecord = async () => ({record:{groupId:'group',chromeGroupId:7}});",context);
  const list = () => {
    runInContext("authorizations.set('group',{body:{expiresAt,dispatch:{deadlineAt:expiresAt},command:{type:'execute',args:{action:'tabs',source:'relay'},grant:{body:grant}}},used:new Set()});",context);
    return runInContext("execute({operation:'tabs',groupId:'group'})",context);
  };
  expect(await list()).toEqual([{targetId:'1',title:'Page',url:'https://approved.example/'}]);
  tabs.set(2,{groupId:7,url:'https://approved.example/'});
  expect(await list()).toEqual([{targetId:'1',title:'Page',url:'https://approved.example/'},{targetId:'2',title:'Page',url:'https://approved.example/'}]);
  tabs.set(1,{groupId:-1,url:'https://approved.example/'});
  await expect(runInContext("member(grant,'1')",context)).rejects.toThrow('outside workspace group');
  tabs.set(2,{groupId:7,url:'https://attacker.example/'});
  expect(await list()).toEqual([]);
  tabs.set(2,{groupId:7,url:'https://approved.example/returned'});
  expect(await list()).toEqual([{targetId:'2',title:'Page',url:'https://approved.example/returned'}]);
});

it('invalidates persisted Chrome IDs after group deletion or a browser session change', async () => {
  const group = {groupId:'logical',projectId:'project',workspaceId:'workspace'};
  const key = 'group:' + JSON.stringify(['account','machine','project','workspace']);
  const state = new Map<string, unknown>([['identity',{trust:{accountId:'account'},machineId:'machine'}],[key,{groupId:'logical',chromeGroupId:7,browserEpoch:'old'}]]);
  let epoch = 'new';
  let exists = true;
  const database = {transaction() {
    const tx = {oncomplete:()=>{},onerror:()=>{},onabort:()=>{},objectStore:()=>({
      get(key:string) {const request = {result:state.get(key),onsuccess:()=>{},onerror:()=>{}}; queueMicrotask(()=>request.onsuccess()); return request;},
      put(value:unknown,key:string) {state.set(key,value);},
    })};
    queueMicrotask(()=>tx.oncomplete()); return tx;
  }};
  const context = createContext({
    crypto,TextEncoder,URL,atob,btoa,console,WebSocket:class {static OPEN=1;readyState=0;close(){}},setTimeout:()=>0,clearTimeout(){},group,
    indexedDB:{open(){const request={result:database,onsuccess:()=>{},onerror:()=>{}};queueMicrotask(()=>request.onsuccess());return request;}},
    chrome:{
      runtime:{onMessage:{addListener(){}}},
      storage:{local:{remove:async()=>{}},session:{get:async()=>({browserEpoch:epoch}),set:async()=>{}}},
      debugger:{onEvent:{addListener(){}},onDetach:{addListener(){}}},
      tabs:{onUpdated:{addListener(){}}},
      tabGroups:{get:async()=>{if(!exists) throw new Error('Deleted');return {id:7};},onRemoved:{addListener(){}}},
      alarms:{create(){},onAlarm:{addListener(){}}},
    },
  });
  runInContext(browserRelayExtension('http://127.0.0.1:9224'),context);
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,browserEpoch:'new'});
  expect(state.get(key)).toBeNull();
  epoch = 'old'; exists = false;
  state.set(key,{groupId:'logical',chromeGroupId:7,browserEpoch:'old'});
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,browserEpoch:'old'});
  expect(state.get(key)).toBeNull();
});
