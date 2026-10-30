import { env, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createCloudCodemode } from '../src/runtime-codemode.js';
import { storedImages } from '../src/runtime-images.js';
import { tenantRootPrivateKey } from './setup.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { createToolResultStore, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { Harness, MemoryStorage, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRuntimeTools, WorkspaceDoc, type ToolServices } from '@gitspace/runtime-core';
import { parseToolResultReference, RuntimeFullOutputDetailsSchema, RuntimeToolResultRequestSchema, WORKSPACE_TOOL_RESULTS_MAX_BYTES, type RuntimeToolResult } from '@gitspace/protocol-runtime';

const noModel = async (): Promise<never> => { throw new Error('No inference in local isolate proof'); };
type Invocation = Parameters<WorkspaceRuntimeOptions['tools']['invoke']>[0];

function invocation(code: string): Invocation {
  return { tool: 'codemode', args: { code, timeoutMs: 1000 }, conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId: 'attempt', replay: 'unsafe' };
}

test('isolate cancellation revokes captured capabilities and a cold owner cannot replay uncertain effects', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-cancel:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const options = { loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) };
    const sandbox = createCloudCodemode(options);
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<null>();
    let effects = 0;
    const input: Invocation = { ...invocation('await tools.write({ path: "effect", content: "effect" }); await tools.write({ path: "second", content: "forbidden" });'), signal: controller.signal, codemodeTools: async () => { effects++; started.resolve(); return { status: 'completed', value: await release.promise }; } };
    const executing = sandbox.execute(input);
    try {
      await Promise.race([started.promise, executing.then(result => { throw new Error(`Isolate finished before its tool call: ${JSON.stringify(result)}`); })]);
      controller.abort(new Error('Fixture cancellation'));
      const cancelled = await executing;
      expect(cancelled.status).toBe('interrupted');
      expect(effects).toBe(1);
      release.resolve(null);
      const recovered = createCloudCodemode(options);
      expect(await recovered.execute(input)).toEqual(cancelled);
      expect(effects).toBe(1);
      expect(recovered.reconcile(input.attemptId)).toEqual(cancelled);
      await expect(recovered.execute({ ...input, args: { code: 'return 2;' } })).rejects.toThrow('identity changed');
    } finally { controller.abort(); release.resolve(null); await executing; }
  });
});

test('unresolved isolate admission never reruns code after owner recovery', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-recovery:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const options = { loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) };
    const first = createCloudCodemode(options);
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<null>();
    let calls = 0;
    const input: Invocation = { ...invocation('return await tools.read({path:"file"});'), codemodeTools: async () => { calls++; ready.resolve(); return { status: 'completed', value: await release.promise }; } };
    const executing = first.execute(input);
    try {
      await Promise.race([ready.promise, executing.then(result => { throw new Error(`Isolate finished before its tool call: ${JSON.stringify(result)}`); })]);
      const recovered = createCloudCodemode(options);
      const blocked = await recovered.execute(input);
      expect(blocked.status).toBe('interrupted');
      expect(calls).toBe(1);
    } finally { release.resolve(null); await executing; }
  });
});

test('completed effects survive a caught definitive denied read without replay', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-denied:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const options = { loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) };
    let effects = 0;
    const input: Invocation = { ...invocation('await tools.write({path:"effect",content:"once"}); let caught = false; try { await tools.read({path:"denied"}); } catch { caught = true; } return {caught};'), codemodeTools: async ({ tool }) => {
      if (tool === 'write') { effects++; return { status: 'completed', value: null }; }
      return { status: 'failed', error: 'Read access denied' };
    } };
    const result = await createCloudCodemode(options).execute(input);
    expect(result).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '{"caught":true}' }] });
    expect(await createCloudCodemode(options).execute(input)).toEqual(result);
    expect(effects).toBe(1);
  });
});

test('caught unknown child outcomes remain fenced across recovery', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-unknown:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const options = { loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) };
    let calls = 0;
    const input: Invocation = { ...invocation('try { await tools.write({path:"effect",content:"unknown"}); } catch {} return "caught";'), codemodeTools: async () => { calls++; return { status: 'interrupted', error: 'Durable outcome unknown' }; } };
    const result = await createCloudCodemode(options).execute(input);
    expect(result.status).toBe('interrupted');
    expect(await createCloudCodemode(options).execute(input)).toEqual(result);
    expect(calls).toBe(1);
  });
});

test('normal capability calls consume one call each and stop at the boundary', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-budget:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const children: string[] = [];
    const result = await createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) }).execute({
      ...invocation('let accepted = 0; for (let i = 0; i < 129; i++) { try { await tools.read({path:"file"}); accepted++; } catch {} } return accepted;'),
      codemodeTools: async ({ callId }) => { children.push(callId); return { status: 'completed', value: null }; },
    });
    expect(result).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '128' }] });
    expect(children).toHaveLength(128);
    expect(new Set(children).size).toBe(128);
  });
});

test('one MCP namespace call cannot fan out past the durable child budget', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-mcp-budget:${crypto.randomUUID()}`), async (_instance, ctx) => {
    let children = 0;
    const result = await createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) }).execute({
      ...invocation('try { await mcp.list({}); return "unbounded"; } catch { return "bounded"; }'),
      codemodeTools: async () => {
        children++;
        const value = children === 1 ? Array.from({ length: 140 }, (_, i) => ({ connectionId: `connection-${i}` })) : [];
        return { status: 'completed', value: [{ type: 'text', text: JSON.stringify(value) }] };
      },
    });
    expect(children).toBe(128);
    expect(result).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '"bounded"' }] });
  });
});

test('actual WorkerLoader usercode has empty imported env and rejects raw sockets', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-isolation:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const result = await createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) }).execute(invocation(`
      // Dynamic imports intentionally exercise the usercode module-loading boundary.
      const { env } = await import('cloudflare:workers');
      const { connect } = await import('cloudflare:sockets');
      let rejected = false;
      let socket;
      try { socket = connect({hostname:'example.com',port:443}); await socket.opened; }
      catch { rejected = true; }
      finally { if (socket) { await socket.close().catch(() => {}); await socket.closed.catch(() => {}); } }
      return {bindings:Object.keys(env),rejected};
    `));
    expect(result).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '{"bindings":[],"rejected":true}' }] });
  });
});

test('real durable authority completes a caught denied read after an effect without replay', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-authority:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const options = { loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) };
    const sandbox = createCloudCodemode(options);
    let effects = 0;
    const results: RuntimeToolResult[] = [];
    const services: ToolServices = {
      images: { store: async image => image, load: async image => image },
      async invoke(input) {
        if (input.tool === 'codemode') {
          const first = await sandbox.execute(input);
          results.push(first, await createCloudCodemode(options).execute(input));
          return first;
        }
        if (input.tool === 'write') effects++;
        return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [] };
      },
      prepareBrowser: noModel, takeoverTab: noModel, question: noModel, instructions: async () => '', preflight: async () => {}, results: createToolResultStore(ctx.storage.sql, 'workspace', WORKSPACE_TOOL_RESULTS_MAX_BYTES),
    };
    const jobs: Parameters<typeof createRuntimeTools>[1] = { execute: noModel, reconcile: noModel, cancel: noModel, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: noModel, wakeAt: noModel, deliverConversationEvent: noModel, observeProcess: noModel, stopProcess: noModel };
    const tools = createRuntimeTools(services, jobs, (id, context) => harness.abortTask(id, context), async call => {
      if (call.name === 'read') throw new Error('Read permission denied before admission');
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'codemode-authority-proof', tools }));
    const model: Model<Api> = { id: 'proof', name: 'Proof', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
    let generated = false;
    const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
      const first = !generated; generated = true;
      const message: AssistantMessage = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: { code: 'await tools.write({path:"effect",content:"once"}); try { await tools.read({path:"denied"}); } catch { return "caught"; } return "not caught";', timeoutMs: 5000 } }] : [{ type: 'text', text: 'Done' }], api: model.api, provider: model.provider, model: model.id, stopReason: first ? 'toolUse' : 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
    } };
    const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
      await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, BACKGROUND_CONTEXT);
      await root.submit({ type: 'input', content: 'Run the composition.' }, BACKGROUND_CONTEXT);
      await root.waitForIdle(BACKGROUND_CONTEXT);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '"caught"' }] });
      expect(results[1]).toEqual(results[0]);
      expect(effects).toBe(1);
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  });
});

test('an MCP result past what the transcript keeps reaches mcp.call whole, the script returns only what it filtered, and grep finds its nested fields by line', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-mcp-whole:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const sandbox = createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) });
    // Every comment of a Figma file in one call: hundreds of KB of one line of JSON, several times what a tool result keeps.
    const comments = Array.from({ length: 3000 }, (_, index) => ({ id: `comment-${index}`, author: index % 1000 === 7 ? { name: 'Ana', handle: 'ana' } : { name: `Person ${index % 13}`, handle: `person-${index % 13}` }, message: `Comment ${index}: ${'detail '.repeat(10)}` }));
    const results: RuntimeToolResult[] = [];
    const kept = createToolResultStore(ctx.storage.sql, 'workspace', WORKSPACE_TOOL_RESULTS_MAX_BYTES);
    const completedWith = (input: { requestId: string; attemptId: string }, value: unknown): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: JSON.stringify(value) }] });
    const services: ToolServices = {
      images: { store: async image => image, load: async image => image },
      async invoke(input) {
        if (input.tool === 'codemode') { const result = await sandbox.execute(input); results.push(result); return result; }
        if (input.tool === 'mcp_discover') return completedWith(input, [{ name: 'list_comments', description: 'Every comment of a file' }]);
        if (input.tool === 'mcp_invoke') return completedWith(input, comments);
        throw new Error(`Unexpected tool ${input.tool}`);
      },
      prepareBrowser: noModel, takeoverTab: noModel, question: noModel, instructions: async () => '', preflight: async () => {}, results: kept,
    };
    const jobs: Parameters<typeof createRuntimeTools>[1] = { execute: noModel, reconcile: noModel, cancel: noModel, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: noModel, wakeAt: noModel, deliverConversationEvent: noModel, observeProcess: noModel, stopProcess: noModel };
    const tools = createRuntimeTools(services, jobs, (id, context) => harness.abortTask(id, context), async () => {});
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'codemode-mcp-proof', tools }));
    const model: Model<Api> = { id: 'proof', name: 'Proof', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
    let generated = false;
    const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
      const first = !generated; generated = true;
      const message: AssistantMessage = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: { code: 'const comments = await mcp.call({ connectionId: "figma", name: "list_comments" }); return comments.filter(comment => comment.author.handle === "ana").map(comment => comment.id);', timeoutMs: 10000 } }] : [{ type: 'text', text: 'Done' }], api: model.api, provider: model.provider, model: model.id, stopReason: first ? 'toolUse' : 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
    } };
    const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
      await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, BACKGROUND_CONTEXT);
      await root.submit({ type: 'input', content: 'Find Ana\'s comments.' }, BACKGROUND_CONTEXT);
      await root.waitForIdle(BACKGROUND_CONTEXT);
      expect(JSON.stringify(comments).length).toBeGreaterThan(5 * 50 * 1024);
      expect(results).toEqual([expect.objectContaining({ status: 'completed', content: [{ type: 'text', text: JSON.stringify(['comment-7', 'comment-1007', 'comment-2007']) }] })]);
      const parent = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === 'parent');
      expect(parent?.role === 'toolResult' ? parent.content : null).toEqual([{ type: 'text', text: JSON.stringify(['comment-7', 'comment-1007', 'comment-2007']) }]);
      // The child's output was kept indented: a grep of its reference finds Ana's nested handle on lines of its own.
      const child = (await root.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult' && message.toolName === 'mcp_invoke');
      const reference = RuntimeFullOutputDetailsSchema.parse(child?.role === 'toolResult' ? child.details : null).fullOutput.reference;
      const location = parseToolResultReference(reference);
      if (!location) throw new Error(`Not a result reference: ${reference}`);
      const found = await kept.answer(location, RuntimeToolResultRequestSchema.parse({ tool: 'grep', args: { pattern: '"handle": "ana"', path: reference } }));
      expect(found.split('\n')).toEqual([expect.stringMatching(/^\d+: {6}"handle": "ana"$/u), expect.stringMatching(/^\d+: {6}"handle": "ana"$/u), expect.stringMatching(/^\d+: {6}"handle": "ana"$/u)]);
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  });
});

test('a script reads its workspace\'s stored images with images.read, and not another workspace\'s', async () => {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  const stored = await storedImages(env, 'codemode-images').store({ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') });
  const foreign = stored.data.replace('codemode-images', 'codemode-other');
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-read:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const result = await createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: noModel, images: exports.ImageReader({ props: { workspaceId: 'codemode-images' } }) }).execute(invocation(`
      const bytes = await images.read({ type: 'image', mimeType: 'image/png', data: ${JSON.stringify(stored.data)} });
      let refused = null;
      try { await images.read(${JSON.stringify(foreign)}); } catch (error) { refused = String(error.message); }
      return { size: bytes.length, signature: [...bytes.slice(0, 4)], refused };
    `));
    expect(result).toMatchObject({ status: 'completed' });
    const content = result.content.at(-1);
    expect(JSON.parse(content?.type === 'text' ? content.text : '')).toEqual({ size: png.byteLength, signature: [0x89, 0x50, 0x4e, 0x47], refused: expect.stringContaining("is not this workspace's") });
  });
});
