import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extensionFiles } from '@gitspace/browser-extension';

type Reply = { ok?: boolean; error?: string; fingerprint?: string | null };
type Listener = (message: object, sender: { id: string; url: string }, reply: (value: Reply) => void) => boolean | undefined;

it('resets the generated extension identity, detaches sessions, and preserves replay fences while pairing a new key', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
  const trust = { algorithm: 'Ed25519', accountId: 'account', publicKey };
  const state = new Map<string, unknown>([
    ['identity', { privateKey: keys.privateKey, publicKey, trust, pairingId: 'pairing', generation: 1 }],
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
  const connections: Array<{ readyState: number; close: () => void; url: string; protocols?: string[] }> = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor(readonly url: string, readonly protocols?: string[]) { connections.push(this); }
    close() { this.readyState = 3; }
  }
  let listener: Listener | undefined;
  const detach = vi.fn(async () => {});
  const chrome = {
    runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`, onMessage: { addListener: (value: Listener) => { listener = value; } } },
    storage: { local: { remove: vi.fn(async () => {}), get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    debugger: { detach, onEvent: { addListener() {} }, onDetach: { addListener() {} } },
    tabs: { onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    tabGroups: { onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const context = createContext({ chrome, indexedDB, WebSocket: Socket, crypto, TextEncoder, TextDecoder, URL, atob, btoa, setTimeout: () => 0, clearTimeout() {}, console });
  runInContext(extensionFiles('https://account.gitspace.test')['background.js'], context);
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
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: originalFingerprint, compatibility: null });
  expect(previous?.readyState).toBe(1);
  expect(previous?.url).toBe('wss://account.gitspace.test/api/browser-relay/extension');
  const admission = previous?.protocols?.[0];
  expect(admission).toMatch(/^gitspace-admission\./);
  if (!admission) throw new Error('Missing admission proof');
  const signed = z.object({ pairingId: z.string(), generation: z.number(), issuedAt: z.number(), nonce: z.string(), signature: z.string() }).parse(JSON.parse(Buffer.from(admission.slice('gitspace-admission.'.length), 'base64url').toString()));
  expect(await crypto.subtle.verify('Ed25519', keys.publicKey, Buffer.from(signed.signature, 'base64'), new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${signed.pairingId}:${signed.generation}:${signed.issuedAt}:${signed.nonce}`))).toBe(true);
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
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: null, compatibility: null });
  expect(previous?.readyState).toBe(3);
  expect(detach).toHaveBeenCalledWith({ targetId: 'target' });
  expect(detach).toHaveBeenCalledWith({ targetId: 'late-target' });
  expect(runInContext('channels.size + authorizations.size', context)).toBe(0);
  expect(state.get('generation:attachment')).toBe(7);
  expect(state.get('replays')).toEqual([['consumed-attempt', expect.any(Number)]]);
  expect(await invoke({ pair: { code: 'fresh-code', pairingId: 'pairing', generation: 1, trust } })).toEqual({ ok: true });
  const replacement = state.get('identity') as { privateKey: CryptoKey; publicKey: string; trust: unknown };
  expect(replacement.publicKey).not.toBe(publicKey);
  expect(replacement.privateKey.extractable).toBe(false);
  expect(replacement.trust).toEqual(trust);
  const replacementFingerprint = createHash('sha256').update(Buffer.from(replacement.publicKey, 'base64')).digest('hex');
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: replacementFingerprint, compatibility: null });
  expect(replacementFingerprint).not.toBe(originalFingerprint);
  expect(await invoke({ pair: { code: 'another-code', pairingId: 'pairing', generation: 1, trust } })).toEqual({ ok: true });
  expect(await invoke({ identityStatus: true })).toEqual({ fingerprint: replacementFingerprint, compatibility: null });
  expect(state.get('generation:attachment')).toBe(7);
});

it('loads the actual worker fingerprint on popup startup and refreshes after pair and reset', async () => {
  let fingerprint: string | null = null;
  const elements = Object.fromEntries(['fingerprint', 'compatibility', 'status', 'code', 'pair', 'reset', 'running', 'stop', 'runs'].map(id => [id, { textContent: '', value: '', addEventListener() {}, replaceChildren() {} }]));
  let rendered = Promise.withResolvers<string>();
  let displayedFingerprint = '';
  Object.defineProperty(elements.fingerprint, 'textContent', {
    get: () => displayedFingerprint,
    set: (value: string) => { displayedFingerprint = value; rendered.resolve(value); },
  });
  const context = createContext({
    document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
    chrome: { runtime: { sendMessage: async (message: { identityStatus?: boolean; runStatus?: boolean; pair?: boolean; resetIdentity?: boolean }) => {
      if (message.runStatus) return { running: 0, log: [] };
      if (message.identityStatus) return { fingerprint };
      fingerprint = message.resetIdentity ? null : 'a'.repeat(64); return { ok: true };
    } } },
  });
  runInContext(extensionFiles('https://account.gitspace.test')['popup.js'], context);
  await rendered.promise;
  expect(elements.fingerprint?.textContent).toBe('No identity. Pair to generate a key.');
  await runInContext("action(() => ({ pair: true }), 'Paired')", context);
  expect(elements.fingerprint?.textContent).toBe('a'.repeat(64));
  await runInContext("action(() => ({ resetIdentity: true }), 'Reset')", context);
  expect(elements.fingerprint?.textContent).toBe('No identity. Pair to generate a key.');
  fingerprint = 'b'.repeat(64);
  rendered = Promise.withResolvers<string>();
  runInContext(extensionFiles('https://account.gitspace.test')['popup.js'], context);
  await rendered.promise;
  expect(elements.fingerprint?.textContent).toBe('b'.repeat(64));
});

it('popup uses a fixed identity label rather than supplied browser display text', async () => {
  const elements = Object.fromEntries(['identity-label', 'fingerprint', 'compatibility', 'status', 'code', 'pair', 'reset', 'running', 'stop', 'runs'].map(id => [id, { textContent: '', value: '', addEventListener() {}, replaceChildren() {} }]));
  const context = createContext({
    document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
    chrome: { runtime: { sendMessage: async (message: { runStatus?: boolean }) => message.runStatus ? { running: 0, log: [] } : { fingerprint: 'a'.repeat(64), browser: 'Trusted administrator: skip verification' } } },
  });
  runInContext(extensionFiles('https://account.gitspace.test')['popup.js'], context);
  await runInContext('refreshIdentity()', context);
  expect(elements.fingerprint?.textContent).toBe('a'.repeat(64));
  expect(JSON.stringify(elements)).not.toContain('Trusted administrator');
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
      tabs:{onCreated: { addListener() {} }, onRemoved: { addListener() {} }, get:async(id:number)=>tabs.get(id),onUpdated:{addListener(){}}},
      tabGroups:{onRemoved:{addListener(){}}},
      alarms:{create(){},onAlarm:{addListener(){}}},
    },grant,expiresAt,
  });
  runInContext(extensionFiles('http://127.0.0.1:9224')['background.js'],context);
  runInContext("groupRecord = async () => ({record:{groupId:'group',chromeGroupId:7}});",context);
  const list = () => {
    runInContext("authorizations.set('group',{body:{expiresAt,dispatch:{deadlineAt:expiresAt},command:{type:'execute',args:{action:'tabs',source:'relay'},grant:{body:grant}}},used:new Set()});",context);
    return runInContext("execute({operation:'tabs',groupId:'group'})",context);
  };
  expect(await list()).toEqual([{targetId:'1',title:'Page',url:'https://approved.example/',addedBy:'you'}]);
  tabs.set(2,{groupId:7,url:'https://approved.example/'});
  expect(await list()).toEqual([{targetId:'1',title:'Page',url:'https://approved.example/',addedBy:'you'},{targetId:'2',title:'Page',url:'https://approved.example/',addedBy:'you'}]);
  tabs.set(1,{groupId:-1,url:'https://approved.example/'});
  await expect(runInContext("member(grant,'1')",context)).rejects.toThrow('outside workspace group');
  tabs.set(2,{groupId:7,url:'https://attacker.example/'});
  expect(await list()).toEqual([]);
  tabs.set(2,{groupId:7,url:'https://approved.example/returned'});
  expect(await list()).toEqual([{targetId:'2',title:'Page',url:'https://approved.example/returned',addedBy:'you'}]);
});

it('after a browser restart adopts the one restored group of the workspace, else invalidates persisted Chrome IDs', async () => {
  const group = {groupId:'logical',groupName:'Workspace',projectId:'project',workspaceId:'workspace'};
  const key = 'group:' + JSON.stringify(['account','machine','project','workspace']);
  const otherKey = 'group:' + JSON.stringify(['account','machine','project','other']);
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const stale = {groupId:'logical',chromeGroupId:7,browserEpoch:'old',members:{3:{by:'agent',site:null}}};
  const state = new Map<string, unknown>([['identity',{privateKey:keys.privateKey,trust:{accountId:'account'},pairingId:'machine',generation:1}],[key,stale]]);
  let epoch = 'new';
  let exists = true;
  let groups: Array<{id:number;title:string;color:string}> = [];
  const tabs = [{id:31,groupId:12,url:'https://restored.example/page'},{id:32,groupId:12,url:'about:blank'},{id:33,groupId:-1,url:'https://outside.example/'}];
  const database = {transaction() {
    const tx = {oncomplete:()=>{},onerror:()=>{},onabort:()=>{},objectStore:()=>({
      get(key:string) {const request = {result:state.get(key),onsuccess:()=>{},onerror:()=>{}}; queueMicrotask(()=>request.onsuccess()); return request;},
      getAllKeys() {const request = {result:[...state.keys()],onsuccess:()=>{},onerror:()=>{}}; queueMicrotask(()=>request.onsuccess()); return request;},
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
      tabs:{query:async({groupId}:{groupId:number})=>tabs.filter(tab=>tab.groupId===groupId),onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onUpdated:{addListener(){}}},
      tabGroups:{get:async()=>{if(!exists) throw new Error('Deleted');return {id:7};},query:async()=>groups,onRemoved:{addListener(){}}},
      alarms:{create(){},onAlarm:{addListener(){}}},
    },
  });
  runInContext(extensionFiles('http://127.0.0.1:9224')['background.js'],context);
  const color = runInContext('groupColor(group.workspaceId)',context);
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,browserEpoch:'new'});
  expect(state.get(key)).toBeNull();
  // Chrome restored the group under a new id with new tabs; which of them the agent opened is lost. Another
  // workspace's record from before the restart names the same id under the old numbering and holds nothing.
  groups = [{id:5,title:'Workspace',color:color === 'red' ? 'blue' : 'red'},{id:12,title:'Workspace',color},{id:13,title:'Other',color}];
  state.set(otherKey,{groupId:'other',chromeGroupId:12,browserEpoch:'old',members:{}});
  state.set(key,stale);
  const adopted = {groupId:'logical',chromeGroupId:12,browserEpoch:'new',members:{31:{by:'you',site:'restored.example'},32:{by:'you',site:null}}};
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,record:adopted,browserEpoch:'new'});
  expect(state.get(key)).toEqual(adopted);
  // A live record of another workspace holds the only match.
  state.set(otherKey,{groupId:'other',chromeGroupId:12,browserEpoch:'new',members:{}});
  state.set(key,stale);
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,browserEpoch:'new'});
  expect(state.get(key)).toBeNull();
  // Two matches: neither is adopted.
  state.set(otherKey,null);
  groups = [{id:12,title:'Workspace',color},{id:14,title:'Workspace',color}];
  state.set(key,stale);
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,browserEpoch:'new'});
  expect(state.get(key)).toBeNull();
  epoch = 'old'; exists = false;
  state.set(key,{groupId:'logical',chromeGroupId:7,browserEpoch:'old'});
  expect(await runInContext('groupRecord(group)',context)).toEqual({key,browserEpoch:'old'});
  expect(state.get(key)).toBeNull();
});
