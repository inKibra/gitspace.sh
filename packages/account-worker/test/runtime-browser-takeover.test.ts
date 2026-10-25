import { expect, test } from 'vitest';
import { RuntimeAttachmentSchema, RuntimeAskTakeoverArgumentsSchema, type RuntimeBrowserHolder, type RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
import { BROWSER_GROUP_ROWS, createRuntimeBrowserAuthority, type RuntimeBrowserAuthorityOptions } from '../src/runtime-browser.js';

const identity = { projectId: 'project', workspaceId: 'workspace' };
const pairingId = '00000000-0000-4000-8000-0000000000c1', groupId = '00000000-0000-4000-8000-0000000000c2', cloudGroupId = '00000000-0000-4000-8000-0000000000c3';
const unused = async (): Promise<never> => { throw new Error('Unexpected call'); };
const held = (targetId: string): RuntimeBrowserHolder => ({ targetId, holder: 'you', since: '2026-10-25T10:00:00.000Z', by: 'gitspace', device: 'device-a' });

/** The browser authority ask_takeover asks for its tab: one Chrome ("Studio desktop", `chrome`), the workspace's group
 * there with a GitHub sign-in tab and a tab you hold, the cloud browser's tabs, and `machines` attached with a headless
 * browser. */
async function fixture(chrome: Partial<RuntimeProjectBrowserSettings['browsers'][number]> = {}, machines: string[] = []) {
  const data = new Map<string, unknown>();
  const storage: RuntimeBrowserAuthorityOptions['storage'] = {
    async get(key) { return data.get(key); }, async put(key, value) { data.set(key, value); }, async delete(key) { return data.delete(key); },
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); },
    async transaction(change) { return change(storage); },
  };
  await storage.put(`${BROWSER_GROUP_ROWS}${groupId}`, { pairingId, browser: 'Studio desktop', groupId, groupName: 'Workspace', origins: ['github.com'], expiresAt: '2026-10-25T12:00:00.000Z', reportedAt: '2026-10-25T10:00:00.000Z',
    tabs: [{ targetId: 'sign-in', url: 'https://github.com/login', title: 'Sign in to GitHub', addedBy: 'agent', site: null, usable: true }, { targetId: 'yours', url: 'https://github.com/settings', title: 'Settings', addedBy: 'agent', site: null, usable: true }], held: [held('yours')] });
  await storage.put('runtime.browser.account.group:cloud', cloudGroupId);
  const attachments = machines.map(machineId => RuntimeAttachmentSchema.parse({ ...identity, machineId, attachmentId: `${machineId}-attachment`, generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, updatedAt: '2026-10-25T10:00:00.000Z', online: true, capabilities: ['browser.headless'] }));
  const machine: Pick<FleetMachineDefinition, 'kind' | 'desiredState'> = { kind: 'physical', desiredState: 'online' };
  const settings: RuntimeProjectBrowserSettings = { projectId: 'project', revision: 1, defaultPairingId: pairingId, browsers: [{ pairingId, generation: 1, name: 'Studio desktop', note: '', connected: true, approved: true, takeover: true, ...chrome }] };
  const env = {
    ACCOUNT_ID: 'account', RELAY_NAME: 'relay',
    ACCOUNT_STATE: { getByName: () => ({ certifyBrowserAuthority: unused }) },
    FLEET_CATALOG: { getByName: () => ({ getMachine: async () => machine }) },
    RELAY: { getByName: () => ({ browserRelayPlacement: unused, browserRelayExecute: unused, browserRelayProjectSettings: async () => settings }) },
    BROWSER_SESSION: { getByName: () => ({ execute: unused, preview: unused, closeTab: unused, captureStart: unused, captureStop: unused,
      async overview() { return { tabs: [{ targetId: 'checkout', url: 'https://shop.example/pay', title: 'Pay' }, { targetId: 'captcha', url: 'https://example.com/', title: 'Check' }], running: 0, held: [held('captcha')] }; } }) },
  };
  const conversation = { root: true };
  const authority = createRuntimeBrowserAuthority({ storage, env, identity, selectExecution: unused, approvedSites: async () => ({ sites: [], revision: null }), groupName: async () => 'Workspace', drive: () => { throw new Error('No drive'); }, fromMachine: unused,
    runtime: () => ({ harness: { snapshot: unused }, browserConversation: async () => ({ id: 'main', root: conversation.root, tools: null }), attachments: { list: () => attachments, execute: unused } }) });
  const ask = (args: object) => authority.takeoverTab({ conversationId: 'main', args: RuntimeAskTakeoverArgumentsSchema.parse({ reason: 'Sign in', ...args }) });
  return { ask, conversation };
}

test('the card names the Chrome tab of the workspace group, and says when you already hold it', async () => {
  const f = await fixture();
  expect(await f.ask({ source: 'relay', targetId: 'sign-in' })).toEqual({ source: 'chrome', pairingId, browser: 'Studio desktop', groupId, targetId: 'sign-in', url: 'https://github.com/login', title: 'Sign in to GitHub', holder: 'agent' });
  expect(await f.ask({ source: 'relay', pairingId, targetId: 'yours' })).toMatchObject({ targetId: 'yours', holder: 'you' });
  await expect(f.ask({ source: 'relay', targetId: 'elsewhere' })).rejects.toThrow('has no tab elsewhere');
});

test('a Chrome whose extension cannot hand a tab over is never offered: the agent is told to have it updated', async () => {
  await expect((await fixture({ takeover: false })).ask({ source: 'relay', targetId: 'sign-in' })).rejects.toThrow('update the extension (5.10 or later)');
  await expect((await fixture({ connected: false })).ask({ source: 'relay', targetId: 'sign-in' })).rejects.toThrow('is offline');
});

test('the cloud browser\'s tab can be taken over; a machine\'s headless browser cannot', async () => {
  expect(await (await fixture()).ask({ source: 'headless', targetId: 'checkout' })).toEqual({ source: 'cloud', pairingId: null, browser: 'Cloud browser', groupId: cloudGroupId, targetId: 'checkout', url: 'https://shop.example/pay', title: 'Pay', holder: 'agent' });
  expect(await (await fixture()).ask({ source: 'headless', targetId: 'captcha' })).toMatchObject({ holder: 'you' });
  await expect((await fixture({}, ['machine'])).ask({ source: 'headless', targetId: 'machine-tab' })).rejects.toThrow("Tabs of a machine's headless browser cannot be taken over");
});

test('only the main agent asks', async () => {
  const f = await fixture();
  f.conversation.root = false;
  await expect(f.ask({ source: 'relay', targetId: 'sign-in' })).rejects.toThrow('Only the main agent');
});
