import { expect, test } from 'bun:test';
import { Harness, MemoryStorage, createRegistry, type Conversation, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage } from '@earendil-works/pi-ai';
import { noticeInvalidBlocks } from '../src/notices.js';

const context = BACKGROUND_CONTEXT;
const fence = '```';
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function reply(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-responses', provider: 'openai', model: 'fixture', usage, stopReason: 'stop', timestamp: 1 };
}
async function fixture(run: (harness: Harness, root: Conversation) => Promise<void>) {
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, context);
  try { await run(harness, await harness.root(context)); } finally { await harness.close(context); }
}
/** The conversation's notices, oldest first, with their labels. */
async function notices(root: Conversation) {
  const page = await root.entries({}, 256, undefined, context);
  return page.items.filter(entry => entry.kind === 'gitspace.machine-notice').reverse().map(entry => ({ data: entry.data, text: entry.model?.[0]?.content }));
}
const posted = (root: Conversation, kind: string, message: EntryRecord['model']) => root.commit(tx => tx.appendEntry(root.id, { kind, model: message }), context);

test('an invalid block in a message gets its agent one Blocks notice, also when the message is seen again, and starts no turn', async () => {
  await fixture(async (harness, root) => {
    const message = await posted(root, 'pi.assistant', [reply(`Status:\n${fence}mermaid\n\n${fence}`)]);
    await noticeInvalidBlocks(harness, message);
    await noticeInvalidBlocks(harness, message);
    expect(await notices(root)).toEqual([{
      data: { source: 'Blocks' },
      text: 'Block 1 in your last message is invalid: the Mermaid source is empty\nThe chat shows an error in place of that block; send a corrected block in a new message.',
    }]);
    // A second message with the same invalid block is its own message.
    await noticeInvalidBlocks(harness, await posted(root, 'pi.assistant', [reply(`Again:\n${fence}mermaid\n\n${fence}`)]));
    expect(await notices(root)).toHaveLength(2);
    // Nothing was submitted to the agent: no input reached the conversation and nothing runs or waits to.
    const { tasks, submissions } = await harness.inspect(context);
    expect({ tasks, submissions }).toEqual({ tasks: [], submissions: [] });
    expect((await root.entries({}, 256, undefined, context)).items.map(entry => entry.kind).reverse()).toEqual(['pi.assistant', 'gitspace.machine-notice', 'pi.assistant', 'gitspace.machine-notice']);
  });
});

test('a message with valid blocks or none, and a user message with an invalid block, get no notice', async () => {
  await fixture(async (harness, root) => {
    const valid = `${fence}gitspace-ui\n{"root":"t","elements":{"t":{"type":"Text","props":{"text":"hi"},"children":[]}}}\n${fence}`;
    for (const entry of [
      await posted(root, 'pi.assistant', [reply(valid)]),
      await posted(root, 'pi.assistant', [reply('No blocks here.')]),
      await posted(root, 'pi.user', [{ role: 'user', content: [{ type: 'text', text: `${fence}mermaid\n\n${fence}` }], timestamp: 1 }]),
    ]) await noticeInvalidBlocks(harness, entry);
    expect(await notices(root)).toEqual([]);
  });
});
