import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { chatAttachmentTag, type ChatAttachment } from '@gitspace/protocol-runtime/chat-attachments';
import { createRuntimeHarness } from './harness.js';
import type { AttachmentRendition } from './inference/attachments.js';

// A 10,000-token window: attachment text gets a quarter of it, 7,500 characters.
const model: Model<Api> = { id: 'small', name: 'Small', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const attachment = (name: string, hash: string): ChatAttachment => ({ name, url: `drive://workspace/uploads/2026-11-13/${name}`, type: 'application/pdf', size: 1000, hash: `sha256:${hash.repeat(64)}` });
const markdown = (body: string): AttachmentRendition => ({ kind: 'text', form: 'markdown', characters: body.length, read: characters => body.slice(0, characters) });

test('a request carries the newest document whole after its tag, and an older one that no longer fits only as its link', async () => {
  const old = attachment('old.pdf', 'a'), recent = attachment('new.pdf', 'b');
  const renditions = new Map([[old.hash, markdown(`# Old\n${'o'.repeat(20_000)}`)], [recent.hash, markdown(`# New\n${'n'.repeat(6_000)}`)]]);
  const sent: Message[][] = [];
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: Message[] }) {
    sent.push(request.messages);
    const stream = createAssistantMessageEventStream();
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Read.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
    stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply);
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
    attachmentRenditions: async named => new Map(named.flatMap(item => { const rendition = renditions.get(item.hash); return rendition ? [[item.hash, rendition]] : []; })),
  });
  try {
    await runtime.root.submit({ type: 'input', requestId: 'first', content: `Summarize this. ${chatAttachmentTag(old)}` }, context);
    await runtime.root.waitForIdle(context);
    await runtime.root.submit({ type: 'input', requestId: 'second', content: `And this one. ${chatAttachmentTag(recent)}` }, context);
    await runtime.root.waitForIdle(context);
    const users = (sent.at(-1) ?? []).flatMap(message => message.role === 'user' ? [JSON.stringify(message.content)] : []);
    // Each message keeps its tag; the new document is sent whole, the old one only names where to read it.
    expect(users[0]).toContain(JSON.stringify(chatAttachmentTag(old)).slice(1, -1));
    expect(users[0]).toContain(`read it from ${old.url}`);
    expect(users[0]).not.toContain('# Old');
    expect(users[1]).toContain(JSON.stringify(chatAttachmentTag(recent)).slice(1, -1));
    expect(users[1]).toContain(`# New\\n${'n'.repeat(6_000)}`);
    // The first request, with the old document alone, carried it as much as fitted.
    expect(JSON.stringify(sent[0])).toContain('# Old');
    expect(JSON.stringify(sent[0])).toContain(`read the rest from ${old.url}`);
  } finally { await runtime.harness.close(context); }
});
