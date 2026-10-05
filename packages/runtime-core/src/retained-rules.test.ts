import { describe, expect, it, vi } from 'vitest';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, GenerationTask, hook, LiveDoc } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from 'typebox';
import { RuntimeIdentitySchema, RuntimeRuleInterruptionSchema } from '@gitspace/protocol-runtime';
import { createRetainedRulesExtension, parseRetainedRule, interceptRuntimeModelStream, type RetainedRuleServices } from './retained-rules.js';
import { ruleGenerationRegistry, RuleInterruptionsDoc } from './rule-generations.js';
import { createRunModelsRouter } from './inference/run-models.js';
import { createConversationTools } from './conversation-tools.js';

const identity = RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' });
const model: Model<Api> = { id: 'controlled', name: 'Controlled', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
function message(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
// Keep the backing store alive across runtime instances, like the cloud database.
class ReopenableStorage extends MemoryStorage {
  override async close() { return; }
}
async function fixture(mode: 'text' | 'delta' | 'tool' | 'cancel' | 'recover' | 'patch' | 'pathless-ast' | 'write' | 'spawn', overrides: Partial<RetainedRuleServices> = {}, output: { text?: string; path?: string } = {}) {
  const storage = new ReopenableStorage();
  const requests: string[] = [];
  const aborted: boolean[] = [];
  let effects = 0;
  let harness: Harness;
  const entered = Promise.withResolvers<void>();
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, input, options) {
    requests.push(JSON.stringify(input));
    const controller = new AbortController();
    options?.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    controller.signal.addEventListener('abort', () => aborted.push(true), { once: true });
    const stream = createAssistantMessageEventStream();
    if (mode === 'cancel' || (mode === 'recover' && requests.length === 1)) {
      entered.resolve();
      controller.signal.addEventListener('abort', () => { const stopped = { ...message(''), content: [], stopReason: 'aborted' as const }; stream.push({ type: 'error', reason: 'aborted', error: stopped }); stream.end(stopped); }, { once: true });
    } else {
      const reply = requests.length === 1 ? message(output.text ?? 'FORBIDDEN') : message('Corrected');
      if (mode === 'tool' && requests.length === 1) { reply.content = [{ type: 'toolCall', id: 'bad-call', name: 'effect', arguments: { command: 'FORBIDDEN' } }]; reply.stopReason = 'toolUse'; }
      if (mode === 'patch' && requests.length === 1) { reply.content = [{ type: 'toolCall', id: 'bad-patch', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** Update File: original.txt\n*** Move to: moved.ts\n@@\n+FORBIDDEN\n*** End Patch' } }]; reply.stopReason = 'toolUse'; }
      if (mode === 'pathless-ast' && requests.length === 1) { reply.content = [{ type: 'toolCall', id: 'safe-call', name: 'effect', arguments: { command: 'echo safe' } }]; reply.stopReason = 'toolUse'; }
      if (mode === 'write' && requests.length === 1) { reply.content = [{ type: 'toolCall', id: 'write-call', name: 'write', arguments: { path: output.path ?? 'src/lib.rs', content: output.text ?? 'FORBIDDEN' } }]; reply.stopReason = 'toolUse'; }
      if (mode === 'spawn' && requests.length === 1) { reply.content = [{ type: 'toolCall', id: 'spawn-call', name: 'spawn', arguments: {} }]; reply.stopReason = 'toolUse'; }
      // A provider that publishes only its terminal message must also be caught.
      if (mode === 'delta' && requests.length === 1) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'FORBIDDEN', partial: reply });
      stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    }
    return interceptRuntimeModelStream(stream, options?.signal, controller);
  } };
  const effect = defineTool({ name: mode === 'patch' ? 'apply_patch' : mode === 'write' ? 'write' : mode === 'spawn' ? 'spawn' : 'effect', description: 'Record an effect', parameters: Type.Object({ command: Type.Optional(Type.String()), patch: Type.Optional(Type.String()), path: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }), async execute(_args, api) {
    effects++;
    if (mode === 'spawn') return createConversationTools({ harness, storage, admitInference: async () => ({ provider: model.provider, modelId: model.id }) })({ tool: 'agents', args: { op: 'spawn', task: 'Child task' }, conversationId: String(api.conversationId), taskId: String(api.taskId), requestId: 'spawn-request', attemptId: 'spawn-attempt', replay: 'unsafe', signal: AbortSignal.timeout(30_000) }).then(result => ({ content: result.status === 'completed' ? result.content : [{ type: 'text' as const, text: 'Spawn failed' }] }));
    return { content: [{ type: 'text', text: 'executed' }] };
  } });
  const open = async () => {
    const registry = createRegistry();
    registry.install(createRetainedRulesExtension({
      async loadRules() { return [parseRetainedRule('rule.md', `---\n${mode === 'pathless-ast' ? 'astCondition: ["dangerous($A)"]' : 'condition: [FORBIDDEN]'}\n${mode === 'patch' ? 'globs: ["*.ts"]\nscope: ["apply_patch(*.ts)"]\n' : ''}repeatMode: once\n---\nUse the safe alternative.`)]; },
      async judge() { return {}; },
      async matchAst(_conversationId, _content, paths) { if (!paths.length) throw new Error('AST matching requires a file path'); return false; },
      ...overrides,
    }, () => harness, identity));
    registry.install(defineExtension({ name: 'effects', tools: [effect] }));
    harness = await Harness.open(storage, { registry: ruleGenerationRegistry(registry), models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
    return harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools: [effect] } });
  };
  const root = await open();
  return { root, open, entered, requests, aborted, effects: () => effects, harness: () => harness };
}

describe('durable rule generation discard', () => {
  for (const mode of ['text', 'delta', 'tool', 'patch'] as const) it(`discards ${mode}, aborts provider and starts one clean generation`, async () => {
    const f = await fixture(mode);
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.requests).toHaveLength(2);
      expect(f.aborted).toEqual([true]);
      expect(f.requests[1]).not.toContain('FORBIDDEN');
      expect(f.requests[1]?.match(/Use the safe alternative\./g)).toHaveLength(1);
      expect(f.effects()).toBe(0);
      const record = (await f.harness().snapshot(RuleInterruptionsDoc, f.root.id, BACKGROUND_CONTEXT))?.active;
      expect(record?.state).toBe('resolved');
      expect(record && 'generationId' in record.continuation && record.continuation.generationId).not.toBe(record?.generationId);
      const view = await f.root.context(BACKGROUND_CONTEXT);
      expect(JSON.stringify(view.messages)).not.toContain('FORBIDDEN');
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('keeps inline flags and skips only a malformed condition without aborting generation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await fixture('text', { async loadRules() { return [
      parseRetainedRule('bad.md', '---\ncondition: "["\n---\nBroken rule'),
      parseRetainedRule('good.md', '---\ncondition: ["(?x)FORBIDDEN", "FOR(?i)BIDDEN", "(?i)forbidden"]\nrepeatMode: once\n---\nUse the safe alternative.'),
    ]; } });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]).toContain('Use the safe alternative.');
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); await f.harness().close(BACKGROUND_CONTEXT); }
  });
  for (const [condition, interrupted] of [
    ['^FORBIDDEN$', false],
    ['(?m)^FORBIDDEN$', true],
    ['(?i)^forbidden$', false],
    ['(?im)^forbidden$', true],
    ['(?s)^ok.FORBIDDEN.ok$', true],
    ['/\\bFORBIDDEN\\b/', true],
  ] as const) it(`honors only explicit flags for ${condition}`, async () => {
    const f = await fixture('text', { async loadRules() { return [parseRetainedRule('anchors.md', `---\ncondition: ${JSON.stringify(condition)}\nrepeatMode: once\n---\nUse the safe alternative.`)]; } }, { text: 'ok\nFORBIDDEN\nok' });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.requests).toHaveLength(interrupted ? 2 : 1);
      const view = JSON.stringify((await f.root.context(BACKGROUND_CONTEXT)).messages);
      if (interrupted) expect(view).not.toContain('FORBIDDEN');
      else expect(view).toContain('ok\\nFORBIDDEN\\nok');
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  for (const [pattern, path, interrupted] of [
    ['src/*.{ts,tsx}', 'src/main.tsx', true],
    ['src/*.{ts,tsx}', 'src/main.js', false],
    ['src/{lib,{test,spec}}.[jt]s', 'src/spec.ts', true],
    ['src/{lib,{test,spec}}.[jt]s', 'src/main.ts', false],
    ['src/file[0-9].[jt]s', 'src/file7.ts', true],
    ['src/file[0-9].[jt]s', 'src/filea.ts', false],
    ['src/[!a-c]*.ts', 'src/zebra.ts', true],
    ['src/[!a-c]*.ts', 'src/beta.ts', false],
    ['src/[^a-c]*.ts', 'src/beta.ts', false],
    ['*.{ts,tsx}', 'deep/nested/main.ts', true],
    ['file[0-9].ts', 'deep\\nested\\file7.ts', true],
    ['**/file?.ts', 'file7.ts', true],
    ['**/file?.ts', 'deep/nested/file7.ts', true],
    ['src/*.ts', 'src/nested/main.ts', false],
    ['src/\\[draft\\].ts', 'src/[draft].ts', true],
    ['src/*.ts', 'src/.hidden.ts', true],
    ['!!*.ts', 'main.ts', true],
    ['!*.ts', 'main.ts', false],
    ['!*.ts', 'main.js', true],
    ['!*.ts', 'src/main.ts', false],
    ['!src/*.ts', 'src/main.ts', false],
    ['!*.ts', 'src/main.js', true],
    ['src/file?.ts', 'src/file\u{1f600}.ts', true],
    ['src/[]a].ts', 'src/].ts', true],
    ['src/file.ts', 'src/file.ts\n', false],
  ] as const) for (const target of ['globs', 'scope'] as const) it(`uses ${target} ${pattern} to ${interrupted ? 'block' : 'admit'} ${path}`, async () => {
    const selector = target === 'globs' ? `globs: ${JSON.stringify([pattern])}` : `scope: ${JSON.stringify([`write(${pattern})`])}`;
    const f = await fixture('write', { async loadRules() { return [parseRetainedRule('paths.md', `---\ncondition: FORBIDDEN\n${selector}\nrepeatMode: once\n---\nUse the safe alternative.`)]; } }, { path });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.effects()).toBe(interrupted ? 0 : 1);
      const record = (await f.harness().snapshot(RuleInterruptionsDoc, f.root.id, BACKGROUND_CONTEXT))?.active;
      if (interrupted) expect(record?.state).toBe('resolved');
      else expect(record ?? null).toBeNull();
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('targets file-glob condition shorthand and quoted comma-separated agents and scopes', async () => {
    const f = await fixture('write', { async loadRules() { return [parseRetainedRule('rust.md', `---\ncondition: "*.rs"\nagents: '"other", "MAIN"'\nscope: '"thinking", "text"'\nrepeatMode: once\n---\nUse the safe alternative.`)]; } });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.effects()).toBe(0);
      expect(f.requests[1]).toContain('Use the safe alternative.');
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('matches text selected by quoted comma-separated scope and agents', async () => {
    const f = await fixture('text', { async loadRules() { return [parseRetainedRule('scope.md', `---\ncondition: /forbidden/i\nagents: '"other", "main"'\nscope: '"thinking", "text"'\nrepeatMode: once\n---\nUse the safe alternative.`)]; } });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]).toContain('Use the safe alternative.');
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  for (const reason of ['No machine available', 'Unsupported AST language', 'Unsupported AST pattern']) it(`admits a tool when AST matching is unavailable: ${reason}`, async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await fixture('write', { async loadRules() { return [parseRetainedRule('ast.md', '---\nastCondition: ["dangerous($A)"]\n---\nAST instruction')]; }, async matchAst() { throw new Error(reason); } });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
      expect((await f.harness().snapshot(RuleInterruptionsDoc, f.root.id, BACKGROUND_CONTEXT))?.active ?? null).toBeNull();
    } finally { warning.mockRestore(); await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('gives unnamed spawned conversations sub-only instructions rather than main-only instructions', async () => {
    const f = await fixture('spawn', { async loadRules() { return [
      parseRetainedRule('main.md', '---\nagents: main\nalwaysApply: true\n---\nMAIN-ONLY-INSTRUCTION'),
      parseRetainedRule('sub.md', '---\nagents: sub\nalwaysApply: true\n---\nSUB-ONLY-INSTRUCTION'),
    ]; } });
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      const child = f.requests.find(request => request.includes('Child task'));
      expect(child).toContain('SUB-ONLY-INSTRUCTION');
      expect(child).not.toContain('MAIN-ONLY-INSTRUCTION');
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('admits a pathless tool when an AST-only rule has no file context to match', async () => {
    const f = await fixture('pathless-ast');
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
      expect((await f.harness().snapshot(RuleInterruptionsDoc, f.root.id, BACKGROUND_CONTEXT))?.active ?? null).toBeNull();
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('does not turn user cancellation into a continuation', async () => {
    const f = await fixture('cancel');
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.entered.promise;
      await f.root.abort(BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.requests).toHaveLength(1);
      expect((await f.harness().snapshot(RuleInterruptionsDoc, f.root.id, BACKGROUND_CONTEXT))?.active ?? null).toBeNull();
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  it('recovers a pending discard without replaying the offending request', async () => {
    const f = await fixture('recover');
    await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
    await f.entered.promise;
    await f.harness().commit(async tx => {
      const live = await tx.doc(LiveDoc, f.root.id);
      if (!live.run) throw new Error('Expected live generation');
      const id = String(live.run.taskId);
      (await tx.doc(RuleInterruptionsDoc, f.root.id)).active = RuntimeRuleInterruptionSchema.parse({ ...identity, version: 1, kind: 'rule-interruption', conversationId: String(f.root.id), taskId: id, runId: String(live.run.inputs[0]), generationId: id, interruptionId: `${id}:recovered`, ruleId: 'recovered', ruleRevision: 'a'.repeat(64), provenance: { source: 'project-rule', path: 'rule.md', matcher: 'text', output: 'text', outputOrdinal: 0, matchedDigest: 'b'.repeat(64), observedAt: new Date().toISOString() }, instruction: 'Recovered instruction', discard: { state: 'discarded', generationId: id, toolCalls: 'not-dispatched' }, state: 'pending', continuation: { state: 'pending' } });
    }, BACKGROUND_CONTEXT);
    await f.harness().close(BACKGROUND_CONTEXT);
    const recovered = await f.open();
    try {
      await recovered.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.match(/Recovered instruction/g)).toHaveLength(1);
      expect((await f.harness().snapshot(RuleInterruptionsDoc, recovered.id, BACKGROUND_CONTEXT))?.active?.state).toBe('resolved');
    } finally { await f.harness().close(BACKGROUND_CONTEXT); }
  });
  for (const mode of ['cancel', 'cold-cancel', 'discard'] as const) it(`cancels deferred ${mode} under its original durable scope`, async () => {
    const storage = new ReopenableStorage();
    type Scope = { conversationId: string; taskId: string };
    let scopes = new WeakMap<AbortSignal, Scope>();
    const resolutions: { signal: AbortSignal; scope: Scope }[] = [];
    const cancellations: Scope[] = [];
    const reports: unknown[] = [];
    const polling = Promise.withResolvers<void>();
    let requests = 0;
    const stream = (reply: AssistantMessage) => {
      const events = createAssistantMessageEventStream();
      events.push({ type: 'done', reason: reply.stopReason === 'deferred' ? 'deferred' : 'stop', message: reply });
      events.end(reply);
      return events;
    };
    const deferred = { provider: model.provider, modelId: model.id, api: model.api, id: 'admitted-request', pollAfterMs: mode === 'discard' ? 0 : 60000 };
    const provider: Models = {
      ...createModels(), getModel: () => model,
      streamSimple() {
        requests++;
        return stream(requests === 1 ? { ...message(''), stopReason: 'deferred', deferred } : message('Corrected'));
      },
      streamDeferred() { return stream(message('FORBIDDEN')); },
      async cancelDeferred(_model, handle, options) {
        const scope = options?.signal ? scopes.get(options.signal) : undefined;
        if (!scope) throw new Error('Model request has no durable inference admission');
        expect(handle).toEqual(deferred);
        cancellations.push(scope);
      },
    };
    const router = createRunModelsRouter(provider, async signal => {
      const scope = signal ? scopes.get(signal) : undefined;
      if (!signal || !scope) throw new Error('Model request has no durable inference admission');
      resolutions.push({ signal, scope });
      return provider;
    });
    const open = async () => {
      const registry = createRegistry();
      registry.install(createRetainedRulesExtension({
        async loadRules() { return [parseRetainedRule('rule.md', '---\ncondition: [FORBIDDEN]\nrepeatMode: once\n---\nUse the safe alternative.')]; },
        async judge() { return {}; }, async matchAst() { return false; },
      }, () => harness, identity));
      registry.install(defineExtension({ name: 'durable-inference-scope', hooks: [hook(GenerationTask, {
        async beforeRequest(_input, api, context) {
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          if (!context.abortSignal || live?.run?.taskId !== api.taskId) throw new Error('Inference task lost durable ownership');
          scopes.set(context.abortSignal, { conversationId: String(api.conversationId), taskId: String(api.taskId) });
          if (live.generation?.deferred) polling.resolve();
        },
      })] }));
      const harness = await Harness.open(storage, { registry: ruleGenerationRegistry(registry), models: router.models, settings: { compaction: { enabled: false } }, onReport: error => { reports.push(error); } }, BACKGROUND_CONTEXT);
      return { harness, root: await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } }) };
    };
    let { harness, root } = await open();
    try {
      await root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await polling.promise;
      if (mode === 'cold-cancel') {
        await harness.close(BACKGROUND_CONTEXT);
        scopes = new WeakMap();
        ({ harness, root } = await open());
      }
      if (mode !== 'discard') await root.abort(BACKGROUND_CONTEXT);
      await root.waitForIdle(BACKGROUND_CONTEXT);
      expect(cancellations).toEqual([resolutions[0]!.scope]);
      expect(requests).toBe(mode === 'discard' ? 2 : 1);
      expect(reports).toEqual([]);
      const interruption = (await harness.snapshot(RuleInterruptionsDoc, root.id, BACKGROUND_CONTEXT))?.active;
      expect(interruption?.state ?? null).toBe(mode === 'discard' ? 'resolved' : null);
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  });
});
