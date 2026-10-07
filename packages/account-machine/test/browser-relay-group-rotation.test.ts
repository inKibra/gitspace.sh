import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';
import { browserRelayExtension } from '../src/browser-relay-extension.js';

for (const transition of ['revoke', 'replacement', 'replacement after native group loss']) {
  it(`persists ${transition} group retirement across replacement and worker restart`, async () => {
    const oldGrant = { groupId: 'old', projectId: 'project', workspaceId: 'workspace', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const nextGrant = { ...oldGrant, groupId: 'new' };
    const key = 'group:' + JSON.stringify(['account', 'machine', 'project', 'workspace']);
    const identityKey = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const state = new Map<string, unknown>([
      ['identity', { trust: { accountId: 'account' }, pairingId: 'machine', generation: 1, privateKey: identityKey.privateKey }],
      [key, { groupId: 'old', chromeGroupId: 7, browserEpoch: 'epoch' }],
    ]);
    let detached = 0;
    const tabs = new Map([[71, 7], [72, 7], [81, 8], [91, 9]]);
    const database = { transaction() {
      const tx = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, objectStore: () => ({
        get(key: string) { const request = { result: state.get(key), onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
        getAllKeys() { const request = { result: [...state.keys()], onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
        put(value: unknown, key: string) { state.set(key, value); },
      }) };
      queueMicrotask(() => tx.oncomplete()); return tx;
    } };
    const globals = {
      crypto, TextEncoder, URL, atob, btoa, console, setTimeout, clearTimeout, oldGrant, nextGrant, key,
      // No real transport is opened by this persistence-only generated-worker harness.
      WebSocket: class { static OPEN = 1; readyState = 0; close() {} },
      indexedDB: { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } },
      chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: { local: { remove: async () => {} }, session: { get: async () => ({ browserEpoch: 'epoch' }) } },
        debugger: { detach: async () => { detached++; }, onEvent: { addListener() {} }, onDetach: { addListener() {} } },
        tabs: { query: async ({ groupId }: { groupId: number }) => [...tabs].filter(([, group]) => group === groupId).map(([id, groupId]) => ({ id, groupId })), remove: async (ids: number[]) => { for (const id of ids) tabs.delete(id); }, onUpdated: { addListener() {} } },
        tabGroups: { get: async () => ({ id: 7 }), onRemoved: { addListener() {} } },
        alarms: { create() {}, onAlarm: { addListener() {} } },
      },
    };
    const context = createContext(globals);
    runInContext(browserRelayExtension('http://127.0.0.1:9224'), context);
    runInContext("channels.set('target',{grant:oldGrant,source:{targetId:'target'}})", context);
    await runInContext('groupRecord(oldGrant,true)', context);
    if (transition === 'replacement after native group loss') state.set(key, null);
    if (transition === 'revoke') {
      await runInContext("execute({operation:'revoke',groupId:'old'})", context);
      expect([...tabs.keys()]).toEqual([81, 91]);
    }
    expect(await runInContext('groupRecord(nextGrant,true)', context)).toMatchObject({ key, browserEpoch: 'epoch' });
    expect(detached).toBe(1);
    await runInContext("persist(key,{groupId:'new',chromeGroupId:8,browserEpoch:'epoch'})", context);
    await expect(runInContext('groupRecord(oldGrant)', context)).rejects.toThrow('retired');
    const restarted = createContext({ ...globals });
    runInContext(browserRelayExtension('http://127.0.0.1:9224'), restarted);
    await expect(runInContext('groupRecord(oldGrant)', restarted)).rejects.toThrow('retired');
    expect(await runInContext('groupRecord(nextGrant)', restarted)).toMatchObject({ record: { groupId: 'new', chromeGroupId: 8 } });
  });
}

it('group closure retries failures without closing stale-epoch or sibling groups', async () => {
  const state = new Map<string, unknown>([
    ['group:affected', { groupId: 'affected', chromeGroupId: 7, browserEpoch: 'epoch' }],
    ['group:stale', { groupId: 'stale', chromeGroupId: 8, browserEpoch: 'old-epoch' }],
    ['group:sibling', { groupId: 'sibling', chromeGroupId: 9, browserEpoch: 'epoch' }],
  ]);
  const tabs = new Map([[71, 7], [72, 7], [81, 8], [91, 9]]);
  let failRemoval = true;
  const database = { transaction() {
    const tx = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, objectStore: () => ({
      get(key: string) { const request = { result: state.get(key), onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      getAllKeys() { const request = { result: [...state.keys()], onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      put(value: unknown, key: string) { state.set(key, value); },
    }) }; queueMicrotask(() => tx.oncomplete()); return tx;
  } };
  const globals = {
    crypto, TextEncoder, URL, atob, btoa, console, setTimeout, clearTimeout,
    WebSocket: class { static OPEN = 1; readyState = 0; close() {} },
    indexedDB: { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { remove: async () => {} }, session: { get: async () => ({ browserEpoch: 'epoch' }) } },
      debugger: { detach: async () => {}, onEvent: { addListener() {} }, onDetach: { addListener() {} } },
      tabs: { query: async ({ groupId }: { groupId: number }) => [...tabs].filter(([, group]) => group === groupId).map(([id, groupId]) => ({ id, groupId })), remove: async (ids: number[]) => { if (failRemoval) throw new Error('Tab closure failed'); for (const id of ids) tabs.delete(id); }, onUpdated: { addListener() {} } },
      tabGroups: { get: async (id: number) => ({ id }), onRemoved: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
    },
  };
  const context = createContext(globals);
  runInContext(browserRelayExtension('http://127.0.0.1:9224'), context);
  await expect(runInContext("execute({operation:'revoke',groupId:'affected'})", context)).rejects.toThrow('Tab closure failed');
  await expect(runInContext("groupRecord({groupId:'affected'})", context)).rejects.toThrow('retired');
  failRemoval = false;
  state.set('group:affected', { groupId: 'replacement', chromeGroupId: 9, browserEpoch: 'epoch' });
  const restarted = createContext({ ...globals });
  runInContext(browserRelayExtension('http://127.0.0.1:9224'), restarted);
  await runInContext("execute({operation:'revoke',groupId:'affected'})", restarted);
  await runInContext("execute({operation:'revoke',groupId:'stale'})", restarted);
  expect([...tabs.keys()]).toEqual([81, 91]);
});
