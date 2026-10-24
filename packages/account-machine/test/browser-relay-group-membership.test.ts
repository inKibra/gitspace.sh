import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';
import { extensionFiles } from '@gitspace/browser-extension';

type Tab = { id: number; groupId: number; url: string; openerTabId?: number };
type Updated = (tabId: number, change: { groupId?: number }, tab: Tab) => void;

it('a tab dragged into the workspace group is usable on its site; a tab a group page opens is not', async () => {
  const key = 'group:' + JSON.stringify(['account', 'pairing', 'project', 'workspace']);
  const state = new Map<string, unknown>([
    ['identity', { trust: { accountId: 'account' }, pairingId: 'pairing', generation: 1 }],
    [key, { groupId: 'group', chromeGroupId: 7, browserEpoch: 'epoch', members: { 1: { by: 'agent', site: null } } }],
  ]);
  const database = { transaction() {
    const tx = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, objectStore: () => ({
      get(key: string) { const request = { result: state.get(key), onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      getAllKeys() { const request = { result: [...state.keys()], onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; },
      put(value: unknown, key: string) { state.set(key, value); },
    }) };
    queueMicrotask(() => tx.oncomplete()); return tx;
  } };
  const tabs = new Map<number, Tab>([[1, { id: 1, groupId: 7, url: 'https://approved.example/' }], [2, { id: 2, groupId: -1, url: 'https://news.example/story' }]]);
  let updated: Updated = () => {};
  let created: (tab: Tab) => void = () => {};
  const sent: unknown[] = [];
  const timers: Array<() => void> = [];
  const context = createContext({
    crypto, TextEncoder, URL, atob, btoa, console,
    WebSocket: class { static OPEN = 1; readyState = 0; close() {} },
    // Reports coalesce on a timer; the test runs them when it reads the report.
    setTimeout: (callback: () => void) => timers.push(callback), clearTimeout() {},
    indexedDB: { open() { const request = { result: database, onsuccess: () => {}, onerror: () => {} }; queueMicrotask(() => request.onsuccess()); return request; } },
    grant: { groupId: 'group', groupName: 'Workspace', projectId: 'project', workspaceId: 'workspace', origins: ['approved.example'], expiresAt: new Date(Date.now() + 60_000).toISOString() },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { remove: async () => {}, get: async () => ({}) }, session: { get: async () => ({ browserEpoch: 'epoch' }) } },
      debugger: { getTargets: async () => [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: 'page', title: 'Page', url: tab.url })), onEvent: { addListener() {} }, onDetach: { addListener() {} } },
      tabs: {
        get: async (id: number) => tabs.get(id),
        query: async ({ groupId }: { groupId: number }) => [...tabs.values()].filter(tab => tab.groupId === groupId).map(tab => ({ ...tab, title: 'Page' })),
        onUpdated: { addListener: (listener: Updated) => { updated = listener; } },
        onCreated: { addListener: (listener: (tab: Tab) => void) => { created = listener; } },
        onRemoved: { addListener() {} },
      },
      tabGroups: { get: async (id: number) => ({ id }), onRemoved: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
    },
  });
  runInContext(extensionFiles('http://127.0.0.1:9224')['background.js'], context);
  runInContext('socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };', Object.assign(context, { sent }));
  const settled = async () => { for (let round = 0; round < 3; round++) await runInContext('membership', context); };
  const member = (targetId: string) => runInContext(`member(grant, '${targetId}')`, context);

  // You drag a news tab into the group: the drag consents to news.example for that tab.
  tabs.set(2, { id: 2, groupId: 7, url: 'https://news.example/story' });
  updated(2, { groupId: 7 }, { id: 2, groupId: 7, url: 'https://news.example/story' });
  await settled();
  await expect(member('target-2')).resolves.toMatchObject({ id: 'target-2' });

  // The agent's tab opens a popup into the group: it gets the grant's origins only.
  tabs.set(3, { id: 3, groupId: 7, url: 'https://elsewhere.example/', openerTabId: 1 });
  created({ id: 3, groupId: 7, url: 'https://elsewhere.example/', openerTabId: 1 });
  await settled();
  await expect(member('target-3')).rejects.toThrow('outside workspace group or origins');

  for (const run of timers.splice(0)) run();
  for (let turn = 0; turn < 200 && !sent.length; turn++) await Promise.resolve();
  expect(sent.at(-1)).toEqual({ group: { groupId: 'group', tabs: [
    { targetId: 'target-1', url: 'https://approved.example/', title: 'Page', addedBy: 'agent', site: null },
    { targetId: 'target-2', url: 'https://news.example/story', title: 'Page', addedBy: 'you', site: 'news.example' },
    { targetId: 'target-3', url: 'https://elsewhere.example/', title: 'Page', addedBy: 'page', site: null },
  ], running: 0 } });

  // Dragging it out ends the consent: dragged back in later, it consents again to what it shows then.
  tabs.set(2, { id: 2, groupId: -1, url: 'https://news.example/story' });
  updated(2, { groupId: -1 }, { id: 2, groupId: -1, url: 'https://news.example/story' });
  await settled();
  await expect(member('target-2')).rejects.toThrow('outside workspace group or origins');
  expect(state.get(key)).toEqual({ groupId: 'group', chromeGroupId: 7, browserEpoch: 'epoch', members: { 1: { by: 'agent', site: null }, 3: { by: 'page', site: null } } });
});
