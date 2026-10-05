import { defineDoc, defineTask, GenerationTask, LiveDoc, UserEntry, type RegistryReader, type RegistrySnapshot, type TaskRuntime, type GenerationInput, type GenerationCheckpoint, type GenerationResult, type GenerationHooks } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { RuntimeRuleInterruptionSchema, type RuntimeRuleInterruption } from '@gitspace/protocol-runtime';
import { releaseRuntimeRuleBinding } from './retained-rules.js';

export const RuleInterruptionsDoc = defineDoc<{ active: RuntimeRuleInterruption | null }>({ kind: 'gitspace.rule-interruptions', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ active: null }) });
export class RuleGenerationDiscard extends Error {
  constructor() { super('Generation discarded by project rule'); }
}

// Pi's public hooks cannot replace a terminal response. Adapt the instance registry,
// not the process-global built-in: the original task still handles every normal path.
const definition = GenerationTask.definition;
type GenerationRuntime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
async function bindInvocation(runtime: GenerationRuntime, context: Context) {
  const view = await runtime.context(runtime.conversationId, context);
  let failure: unknown;
  await runtime.hooks.each('beforeRequest', async handler => {
    try { await handler({ messages: view.messages }, runtime, context); }
    catch (error) { failure = error; }
  });
  if (failure !== undefined) throw failure;
}
async function discardBoundary(run: (guarded: GenerationRuntime) => Promise<void>, runtime: GenerationRuntime, context: Context, cancelDeferred?: () => Promise<void>) {
    const resume = async () => {
      const state = await runtime.snapshot(RuleInterruptionsDoc, runtime.conversationId, context);
      if (state?.active?.state !== 'pending' || state.active.taskId !== String(runtime.taskId)) return false;
      await cancelDeferred?.();
      await runtime.commit(async tx => {
        const doc = await tx.doc(RuleInterruptionsDoc, runtime.conversationId);
        const live = await tx.doc(LiveDoc, runtime.conversationId);
        const record = doc.active;
        if (!record || record.state !== 'pending' || record.taskId !== String(runtime.taskId)) throw new Error('Rule interruption ownership changed');
        if (live.run?.taskId !== runtime.taskId) throw new Error('Rule interruption lost its run');
        const next = await tx.createTask(GenerationTask, {}, { conversationId: runtime.conversationId, ownership: { kind: 'conversation' } });
        await tx.appendEntry(UserEntry, runtime.conversationId, { model: [{ role: 'user', content: record.instruction, timestamp: runtime.now() }] });
        doc.active = RuntimeRuleInterruptionSchema.parse({ ...record, state: 'continuing', continuation: { state: 'scheduled', generationId: String(next), taskId: String(next), scheduledAt: new Date(runtime.now()).toISOString() } });
        await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.rule-interruption', data: doc.active });
        live.run.taskId = next;
        delete live.generation;
        delete live.tools;
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context);
      return true;
    };
    if (await resume()) return;
    const guarded: GenerationRuntime = { ...runtime, hooks: { async each(name, invoke) {
      let failure: unknown;
      await runtime.hooks.each(name, async handler => {
        try { await invoke(handler); }
        catch (error) { failure = error; }
      });
      if (failure !== undefined) throw failure;
      // Pi reports and swallows hook exceptions. Check outside its hook runner,
      // before classification can append an assistant or admit any tool task.
      if (name === 'afterResponse') {
        const state = await runtime.snapshot(RuleInterruptionsDoc, runtime.conversationId, context);
        if (state?.active?.state === 'pending' && state.active.taskId === String(runtime.taskId)) throw new RuleGenerationDiscard();
      }
    } } };
    try { await run(guarded); }
    catch (error) {
      if (!(error instanceof RuleGenerationDiscard)) throw error;
      runtime.signal.throwIfAborted();
      if (!await resume()) throw error;
    }
}
const discardedGeneration = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({ ...definition, phases: {
  ...definition.phases,
  request: async (task, runtime, context) => {
    try { await discardBoundary(guarded => definition.phases.request(task, guarded, context), runtime, context); }
    finally { releaseRuntimeRuleBinding(context.abortSignal); }
  },
  poll: async (task, runtime, context) => {
    try {
      await bindInvocation(runtime, context);
      await discardBoundary(guarded => definition.phases.poll(task, guarded, context), runtime, context, async () => {
        const checkpoint = task.state.checkpoint;
        const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
        if (!model) throw new Error('Deferred generation model is unavailable');
        await runtime.models.cancelDeferred(model, checkpoint.handle, { signal: runtime.signal });
      });
    } finally { releaseRuntimeRuleBinding(context.abortSignal); }
  },
}, async abort(task, runtime, context) {
  try {
  if (task.state.checkpoint.phase === 'poll') await bindInvocation(runtime, context);
  await runtime.commit(async tx => {
    const doc = await tx.doc(RuleInterruptionsDoc, runtime.conversationId);
    const record = doc.active;
    if (record && (record.taskId === String(runtime.taskId) || ('taskId' in record.continuation && record.continuation.taskId === String(runtime.taskId)))) {
      doc.active = RuntimeRuleInterruptionSchema.parse({ ...record, state: 'cancelled', continuation: { state: 'cancelled', cancelledAt: new Date(runtime.now()).toISOString(), reason: 'Generation cancelled' } });
      await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.rule-interruption', data: doc.active });
      delete (await tx.doc(LiveDoc, runtime.conversationId)).generation;
    }
    return undefined;
  }, context);
  await definition.abort(task, runtime, context);
  } finally { releaseRuntimeRuleBinding(context.abortSignal); }
} });

export function ruleGenerationRegistry(registry: RegistryReader): RegistryReader {
  const snapshots = new WeakMap<RegistrySnapshot, RegistrySnapshot>();
  return { subscribe: listener => registry.subscribe(listener), snapshot() {
    const base = registry.snapshot();
    let snapshot = snapshots.get(base);
    if (!snapshot) {
      snapshot = { installed: () => base.installed(), extension: name => base.extension(name), tools: () => base.tools(), sections: () => base.sections(), tasks: () => base.tasks().map(task => task.definition.name === definition.name ? discardedGeneration : task), task: name => name === definition.name ? discardedGeneration : base.task(name) };
      snapshots.set(base, snapshot);
    }
    return snapshot;
  } };
}
