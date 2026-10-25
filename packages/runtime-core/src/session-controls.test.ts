import { expect, test } from 'vitest';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import type { RuntimeBrowserConnectedTab, RuntimeBrowserManagement, RuntimeBrowserPageCommentView, RuntimeBrowserShare } from '@gitspace/protocol-runtime';
import { createSessionControls, sessionControlsExtension, SessionControlsDoc, type SessionControlServices } from './session-controls.js';
import { createConversationLifecycle } from './conversation-lifecycle.js';

const context = BACKGROUND_CONTEXT;
const unexpected = async (): Promise<never> => { throw new Error('Unexpected call'); };
const roles = [
  { id: 'default', label: 'Default', provider: 'test', model: 'astra', thinking: 'medium', current: true },
  { id: 'deep', label: 'Deep', provider: 'test', model: 'astra', thinking: 'high', current: false },
];

/** Session controls over a fresh harness whose root has no model admitted yet; `browser` is the workspace's browser
 * management. */
async function open(browser: NonNullable<SessionControlServices['browser']> = unexpected) {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  registry.install(sessionControlsExtension);
  const harness = await Harness.open(storage, { registry, models: createModels(), settings: { compaction: { enabled: false } } }, context);
  const root = await harness.root(context);
  const lifecycle = createConversationLifecycle({ report: error => { throw error; }, harness, storage, admitInference: unexpected, configureModel: unexpected });
  const controls = createSessionControls({
    harness, root, lifecycle, admitInference: unexpected, configureModel: unexpected, reload: async () => {},
    catalog: async () => ({ models: [{ provider: 'test', id: 'astra', name: 'Astra', contextWindow: 100000 }], roles }),
    browser,
    history: { conversation: unexpected, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unexpected, resolve: unexpected, transcriptPage: unexpected, transcriptContent: unexpected, usage: unexpected },
  });
  return { harness, root, controls };
}

test('before its first message a conversation shows the model and effort its role will run with, not harness defaults', async () => {
  const { harness, root, controls } = await open();
  try {
    // A fresh root: no model admitted yet, and the harness's own default effort on its agent.
    expect(await controls.control(root)).toMatchObject({ role: 'default', roleLabel: 'Default', provider: 'test', model: 'astra', thinking: 'medium' });
    // A role or an effort chosen here before the first message is what shows.
    await root.commit(async tx => { const state = await tx.doc(SessionControlsDoc, root.id); state.selection = { kind: 'role', role: 'deep' }; }, context);
    expect(await controls.control(root)).toMatchObject({ role: 'deep', thinking: 'high' });
    await root.commit(async tx => { (await tx.doc(SessionControlsDoc, root.id)).thinkingSelection = { source: 'conversation', thinking: 'low' }; }, context);
    expect(await controls.control(root)).toMatchObject({ role: 'deep', thinking: 'low' });
  } finally { await harness.close(context); }
});

test('share links and page comments are a person’s: each command asks the workspace’s browser management and answers its result', async () => {
  const groupId = '00000000-0000-4000-8000-00000000000a', shareId = '00000000-0000-4000-8000-00000000000b', pairingId = '00000000-0000-4000-8000-00000000000c';
  const share: RuntimeBrowserShare = { shareId, link: `https://account.test/s/${shareId}#${'s'.repeat(43)}`, pairingId, browser: 'Work Chrome', targetId: 'tab', workspace: { projectId: 'project', workspaceId: 'workspace', groupId }, page: { url: 'https://example.com/', title: 'Example' }, comment: true, createdAt: '2026-10-24T09:00:00.000Z', expiresAt: '2026-10-24T10:00:00.000Z', endedAt: null, endReason: null, viewers: [], audit: [] };
  const ended: RuntimeBrowserShare = { ...share, endedAt: '2026-10-24T09:30:00.000Z', endReason: 'revoked' };
  const connected: RuntimeBrowserConnectedTab = { pairingId, browser: 'Work Chrome', groupId, targetId: 'tab', url: 'https://example.com/', title: 'Example' };
  const comments: RuntimeBrowserPageCommentView[] = [{ cropUrl: 'https://account.test/files/crop', comment: { version: 1, commentId: '00000000-0000-4000-8000-00000000000d', shareId, by: { name: 'Dana', guest: true }, text: 'This price is wrong', page: { url: 'https://example.com/', title: 'Example' }, target: null, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, crop: 'browser/comments/crop.jpg', createdAt: '2026-10-24T09:10:00.000Z' } }];
  const asked: RuntimeBrowserManagement[] = [];
  const answers: Partial<Record<RuntimeBrowserManagement['action'], RuntimeBrowserShare | RuntimeBrowserShare[] | RuntimeBrowserConnectedTab | RuntimeBrowserPageCommentView[]>> = { shares: [share], shareCreate: share, shareRevoke: ended, shareConnect: connected, pageComments: comments };
  const { harness, root, controls } = await open(async (_conversationId, _machineId, command) => {
    asked.push(command);
    const answer = answers[command.action];
    if (!answer) throw new Error(`Unexpected ${command.action}`);
    return answer;
  });
  try {
    const id = String(root.id);
    await expect(controls.execute(id, { type: 'browserShareConnect', shareId, secret: 's'.repeat(43) })).rejects.toThrow('Browser management requires human capability');
    expect(asked).toEqual([]);
    expect((await controls.execute(id, { type: 'browserShares' }, true)).browserShares).toEqual([share]);
    expect((await controls.execute(id, { type: 'browserShareCreate', groupId, targetId: 'tab', comment: true, expiresInMinutes: 60 }, true)).browserShare).toEqual(share);
    expect((await controls.execute(id, { type: 'browserShareRevoke', shareId }, true)).browserShare).toEqual(ended);
    expect((await controls.execute(id, { type: 'browserShareConnect', shareId, secret: 's'.repeat(43) }, true)).browserConnectedTab).toEqual(connected);
    expect((await controls.execute(id, { type: 'browserPageComments' }, true)).browserPageComments).toEqual(comments);
    expect(asked).toEqual([
      { action: 'shares' },
      { action: 'shareCreate', groupId, targetId: 'tab', comment: true, expiresInMinutes: 60 },
      { action: 'shareRevoke', shareId },
      { action: 'shareConnect', shareId, secret: 's'.repeat(43) },
      { action: 'pageComments' },
    ]);
  } finally { await harness.close(context); }
});

test('Stop, Close tab and Focus in Chrome are a person’s: each asks the workspace’s browser management for its group and tab', async () => {
  const groupId = '00000000-0000-4000-8000-00000000000a';
  const asked: RuntimeBrowserManagement[] = [];
  const { harness, root, controls } = await open(async (_conversationId, _machineId, command) => { asked.push(command); return null; });
  try {
    const id = String(root.id);
    await expect(controls.execute(id, { type: 'browserStop', groupId })).rejects.toThrow('Browser management requires human capability');
    expect(asked).toEqual([]);
    await controls.execute(id, { type: 'browserStop', groupId }, true);
    await controls.execute(id, { type: 'browserCloseTab', groupId, targetId: 'tab' }, true);
    expect(await controls.execute(id, { type: 'browserFocusTab', groupId, targetId: 'tab' }, true)).toMatchObject({ control: { sessionId: id } });
    expect(asked).toEqual([{ action: 'stop', groupId }, { action: 'closeTab', groupId, targetId: 'tab' }, { action: 'focusTab', groupId, targetId: 'tab' }]);
  } finally { await harness.close(context); }
});
