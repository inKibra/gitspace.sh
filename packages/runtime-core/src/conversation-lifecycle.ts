import { defineDoc, type Harness, type Storage, type Cursor, type ConversationId, type ModelRef } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RuntimeHarnessOptions } from './harness.js';
import { SessionControlsDoc } from './session-controls.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { z } from 'zod';
import { RuntimeJsonSchema } from '@gitspace/protocol-runtime';

export const ConversationEventSchema = z.object({ conversationId: z.string(), requestId: z.string(), kind: z.enum(['agent-message', 'command-completed', 'process-exited']), sender: z.object({ id: z.string(), name: z.string() }).optional(), text: z.string(), payload: RuntimeJsonSchema.optional() });
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
type StoredEvent = { event: ConversationEvent; delivered: boolean; consumed: boolean };
export const ConversationLifecycleDoc = defineDoc<{ stopped: boolean; events: StoredEvent[] }>({ kind: 'gitspace.conversation-lifecycle', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ stopped: false, events: [] }) });
export type ConversationLifecycle = {
  deliver(event: ConversationEvent): Promise<void>;
  wait(conversationId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ConversationEvent | { kind: 'timeout' | 'stopped' }>;
  stop(conversationId: string): Promise<void>;
  resume(conversationId: string): Promise<void>;
  recover(): Promise<void>;
  runWhileActive<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
  userInput<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
};
export type ConversationLifecycleOptions = {
  harness: Harness; storage: Storage; admitInference: RuntimeHarnessOptions['admitInference'];
  configureModel(id: ConversationId, model: ModelRef): Promise<void>;
  wake(): Promise<void>;
};
export function createConversationLifecycle(options: ConversationLifecycleOptions): ConversationLifecycle {
  const { harness, storage } = options;
  const context = BACKGROUND_CONTEXT;
  // Delivery and Stop share a line so no admitted wake can cross a completed Stop.
  let line: Promise<void> = Promise.resolve();
  const pendingStops = new Set<Promise<void>>();
  async function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = line;
    const released = Promise.withResolvers<void>();
    line = released.promise;
    await previous;
    try { return await operation(); } finally { released.resolve(); }
  }
  async function conversations() {
    const records = []; let cursor: Cursor | undefined;
    do { const page = await storage.scanConversations({}, 128, cursor, context); records.push(...page.items); cursor = page.next; } while (cursor);
    return records;
  }
  async function resolve(id: string) {
    const record = (await conversations()).find(value => String(value.id) === id);
    const conversation = record && await harness.conversation(record.id, context);
    if (!conversation) throw new Error('Conversation not found');
    return conversation;
  }
  async function flush(id: string) {
    const conversation = await resolve(id);
    const state = await harness.snapshot(ConversationLifecycleDoc, conversation.id, context);
    if (state?.stopped) return;
    for (const pending of state?.events ?? []) {
      if (pending.delivered) continue;
      const event = pending.event;
      const child = (await harness.snapshot(AgentDefinitionContextDoc, conversation.id, context))?.child;
      const selection = child?.model ? { kind: 'explicit' as const, ...child.model } : (await harness.snapshot(SessionControlsDoc, conversation.id, context))?.selection ?? { kind: 'default' as const };
      const model = await options.admitInference({ conversationId: id, requestId: event.requestId, selection });
      await options.configureModel(conversation.id, model);
      const content = event.sender ? `Message from ${event.sender.name} (${event.sender.id}):\n${event.text}` : `${event.kind}:\n${event.text}`;
      await conversation.submit({ type: 'input', requestId: event.requestId, content, whenBusy: 'followUp' }, context);
      await conversation.commit(async tx => { const draft = await tx.doc(ConversationLifecycleDoc, conversation.id); const stored = draft.events.find(item => item.event.requestId === event.requestId); if (stored) stored.delivered = true; }, context);
      await options.wake();
    }
  }
  async function setStopped(id: string, stopped: boolean) {
    return harness.commit(async tx => {
      const all = []; let cursor: Cursor | undefined;
      do { const page = await tx.scanConversations({}, 128, cursor); all.push(...page.items); cursor = page.next; } while (cursor);
      const ids = new Set([id]);
      const metadata = [];
      for (const record of all) metadata.push({ record, child: (await tx.doc(AgentDefinitionContextDoc, record.id)).child });
      for (let changed = true; changed;) { changed = false; for (const item of metadata) if (item.child && ids.has(item.child.parentId) && !ids.has(String(item.record.id))) { ids.add(String(item.record.id)); changed = true; } }
      const targets = all.filter(record => ids.has(String(record.id)));
      if (!targets.some(record => String(record.id) === id)) throw new Error('Conversation not found');
      for (const target of targets) (await tx.doc(ConversationLifecycleDoc, target.id)).stopped = stopped;
      return targets;
    }, context);
  }
  async function userInput<T>(id: string, operation: () => Promise<T>): Promise<T> {
    for (;;) {
      const result = await serialized(async () => {
        if (pendingStops.size) return { kind: 'stopping' as const, waits: [...pendingStops] };
        const targets = await setStopped(id, false);
        for (const target of targets) await flush(String(target.id));
        return { kind: 'submitted' as const, value: await operation() };
      });
      if (result.kind === 'submitted') return result.value;
      await Promise.all(result.waits);
    }
  }
  return {
    userInput,
    async runWhileActive(id, operation) {
      return serialized(async () => {
        const conversation = await resolve(id);
        if (pendingStops.size || (await harness.snapshot(ConversationLifecycleDoc, conversation.id, context))?.stopped) throw new Error('Conversation is stopped; only an explicit user message may resume it');
        return operation();
      });
    },
    async recover() { await serialized(async () => { for (const record of await conversations()) await flush(String(record.id)); }); },
    async deliver(event) {
      await serialized(async () => {
        const conversation = await resolve(event.conversationId);
        await conversation.commit(async tx => {
          const state = await tx.doc(ConversationLifecycleDoc, conversation.id);
          if (state.events.some(item => item.event.requestId === event.requestId)) return;
          state.events.push({ event, delivered: false, consumed: false });
          await tx.appendEntry(conversation.id, { kind: `gitspace.${event.kind}`, data: { requestId: event.requestId, text: event.text, ...(event.sender ? { sender: event.sender } : {}), ...(event.payload === undefined ? {} : { payload: event.payload }) } });
        }, context);
        await flush(event.conversationId);
      });
    },
    async wait(id, { timeoutMs, signal }) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Wait timeout must be between 1 and 300000 milliseconds');
      signal?.throwIfAborted();
      const conversation = await resolve(id);
      await conversation.commit(async tx => { await tx.doc(ConversationLifecycleDoc, conversation.id); }, context);
      const watch = await harness.watchDoc(ConversationLifecycleDoc, conversation.id, context);
      if (!watch) throw new Error('Conversation lifecycle missing');
      const result = Promise.withResolvers<ConversationEvent | { kind: 'timeout' | 'stopped' }>();
      let checking = false;
      const check = async () => {
        if (checking) return;
        checking = true;
        try {
          const next = await conversation.commit(async tx => {
            const state = await tx.doc(ConversationLifecycleDoc, conversation.id);
            if (state.stopped) return { kind: 'stopped' as const };
            const pending = state.events.find(item => !item.consumed);
            if (!pending) return null;
            pending.consumed = true;
            return ConversationEventSchema.parse(pending.event);
          }, context);
          if (next) result.resolve(next);
        } catch (error) { result.reject(error); } finally { checking = false; }
      };
      const timer = setTimeout(() => result.resolve({ kind: 'timeout' }), timeoutMs);
      const abort = () => result.reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      watch.start(check);
      void watch.closed.then(value => { if (value.reason !== 'stopped') result.reject(new Error(`Conversation wait ended: ${value.reason}`)); });
      try { signal?.throwIfAborted(); await check(); return await result.promise; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await watch.stop(); }
    },
    async stop(id) {
      const settled = Promise.withResolvers<void>();
      pendingStops.add(settled.promise);
      try {
        const records = await serialized(() => setStopped(id, true));
        const targets = await Promise.all(records.map(record => resolve(String(record.id))));
        await Promise.all(targets.map(target => target.abort(context, { background: true })));
      } finally { pendingStops.delete(settled.promise); settled.resolve(); }
    },
    async resume(id) { await userInput(id, async () => {}); },
  };
}
