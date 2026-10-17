import { expect, test } from 'vitest';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createSessionControls, sessionControlsExtension, SessionControlsDoc } from './session-controls.js';
import { createConversationLifecycle } from './conversation-lifecycle.js';

const context = BACKGROUND_CONTEXT;
const unexpected = async (): Promise<never> => { throw new Error('Unexpected call'); };

test('before its first message a conversation shows the model and effort its role will run with, not harness defaults', async () => {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  registry.install(sessionControlsExtension);
  const harness = await Harness.open(storage, { registry, models: createModels(), settings: { compaction: { enabled: false } } }, context);
  try {
    // A fresh root: no model admitted yet, and the harness's own default effort on its agent.
    const root = await harness.root(context);
    const roles = [
      { id: 'default', label: 'Default', provider: 'test', model: 'astra', thinking: 'medium', current: true },
      { id: 'deep', label: 'Deep', provider: 'test', model: 'astra', thinking: 'high', current: false },
    ];
    const lifecycle = createConversationLifecycle({ harness, storage, admitInference: unexpected, configureModel: unexpected, wake: async () => {} });
    const controls = createSessionControls({
      harness, root, lifecycle, admitInference: unexpected, configureModel: unexpected, reload: async () => {},
      catalog: async () => ({ models: [{ provider: 'test', id: 'astra', name: 'Astra', contextWindow: 100000 }], roles }),
      browser: unexpected,
      history: { conversation: unexpected, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unexpected, resolve: unexpected, transcriptPage: unexpected, transcriptContent: unexpected, usage: unexpected },
    });
    expect(await controls.control(root)).toMatchObject({ role: 'default', roleLabel: 'Default', provider: 'test', model: 'astra', thinking: 'medium' });
    // A role or an effort chosen here before the first message is what shows.
    await root.commit(async tx => { const state = await tx.doc(SessionControlsDoc, root.id); state.selection = { kind: 'role', role: 'deep' }; }, context);
    expect(await controls.control(root)).toMatchObject({ role: 'deep', thinking: 'high' });
    await root.commit(async tx => { (await tx.doc(SessionControlsDoc, root.id)).thinkingSelection = { source: 'conversation', thinking: 'low' }; }, context);
    expect(await controls.control(root)).toMatchObject({ role: 'deep', thinking: 'low' });
  } finally { await harness.close(context); }
});
