import { defineDoc, InboxDoc, LiveDoc, type Harness, type Storage, type Cursor, type Conversation, type ConversationId, type ModelRef } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RuntimeHarnessOptions } from './harness.js';
import { applyInferenceThinking, SessionControlsDoc } from './session-controls.js';
import { AgentDefinitionContextDoc, MAX_RUNNING_SUBAGENTS, SubagentRunQueueDoc, type QueuedSubagentRun } from './subagent-state.js';
import { z } from 'zod';
import { RuntimeJsonSchema } from '@gitspace/protocol-runtime';
import { QuestionsDoc } from './documents.js';
import { formatConversationEvents } from '@gitspace/blocks';
import { noteTakeoverEvent } from './takeover.js';

/** `browser-taken` and `browser-handback`: you took a tab the agent was using, or handed one back (docs/APERTURE-DESIGN.md §7.2). */
export const ConversationEventSchema = z.object({ conversationId: z.string(), requestId: z.string(), kind: z.enum(['agent-message', 'command-completed', 'process-exited', 'machine-ready', 'workspace', 'browser-taken', 'browser-handback']), sender: z.object({ id: z.string(), name: z.string() }).optional(), text: z.string(), payload: RuntimeJsonSchema.optional() });
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
/** How the transcript labels each delivered event. */
const EVENT_SOURCE: Record<ConversationEvent['kind'], (event: ConversationEvent) => string> = {
  'agent-message': event => event.sender ? `${event.sender.name} (${event.sender.id})` : 'Agent',
  'command-completed': event => `Background command ${event.requestId.replace(/^job-completion:/u, '')}`,
  'process-exited': () => 'Process',
  'machine-ready': () => 'Machine',
  workspace: event => event.sender?.name ?? 'Workspace',
  'browser-taken': event => event.sender?.name ?? 'Browser',
  'browser-handback': event => event.sender?.name ?? 'Browser',
};
/** An event the conversation has not had yet: neither placed as its input nor returned by a wait. */
type StoredEvent = {
  event: ConversationEvent;
  /** LEGACY: older releases kept handled events, marked by these flags. `handleEvents` drops them on the document's
   * next write and `flush` writes every such document on recovery; remove once deployed workspaces have recovered. */
  delivered?: boolean;
  consumed?: boolean;
};
/**
 * Request ids of handled events a conversation remembers, so a repeat delivery is dropped. Repeats come from a
 * producer that replays after the object reset between delivering and recording it delivered: the job and process-exit
 * tasks, the background agent task, the subagent reply hook, an `agents` send tool attempt. Each redelivers on its next
 * run, while at most the events of its concurrent producers reach the conversation, far fewer than this. Workspace
 * reports and machine-ready notices are sent once.
 */
const HANDLED_REQUEST_IDS = 256;
type ConversationLifecycleState = {
  stopped: boolean;
  events: StoredEvent[];
  /** Oldest first; absent in documents written before handled events were dropped. */
  handled?: string[];
};
export const ConversationLifecycleDoc = defineDoc<ConversationLifecycleState>({ kind: 'gitspace.conversation-lifecycle', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ stopped: false, events: [], handled: [] }) });
const isHandled = (item: StoredEvent) => item.delivered === true || item.consumed === true;
/** Drops the events with these request ids, and any an older release kept as handled, remembering their request ids. */
export function handleEvents(state: ConversationLifecycleState, requestIds: ReadonlySet<string>): void {
  const kept: StoredEvent[] = [];
  const handled: string[] = [];
  for (const item of state.events) {
    if (isHandled(item) || requestIds.has(item.event.requestId)) handled.push(item.event.requestId);
    else kept.push(item);
  }
  if (handled.length === 0) return;
  state.events = kept;
  state.handled = [...state.handled ?? [], ...handled].slice(-HANDLED_REQUEST_IDS);
}
export type ConversationLifecycle = {
  deliver(event: ConversationEvent): Promise<void>;
  wait(conversationId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ConversationEvent | { kind: 'timeout' | 'stopped' }>;
  stop(conversationId: string): Promise<void>;
  resume(conversationId: string): Promise<void>;
  recover(): Promise<void>;
  runWhileActive<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
  /**
   * Runs `prepare` while the subagent is not stopped, then submits `input` as its first run, or queues it while
   * MAX_RUNNING_SUBAGENTS subagents run or others wait; a retry of the same request finds what the first attempt did.
   */
  startSubagent(conversationId: string, input: NonNullable<QueuedSubagentRun['input']>, prepare: () => Promise<void>): Promise<{ kind: 'submitted'; submissionId: string } | { kind: 'queued' }>;
  userInput<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
};
export type ConversationLifecycleOptions = {
  harness: Harness; storage: Storage; admitInference: RuntimeHarnessOptions['admitInference'];
  configureModel(id: ConversationId, model: ModelRef): Promise<void>;
  report(error: unknown): void;
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
  async function busy(id: ConversationId) { return (await harness.snapshot(LiveDoc, id, context))?.run !== undefined; }
  /** Subagents running now: pi's `pi.live` holds `run` exactly while a conversation is busy. */
  async function runningSubagents() {
    const running: ConversationId[] = [];
    for (const record of await conversations()) if ((await harness.snapshot(AgentDefinitionContextDoc, record.id, context))?.child && await busy(record.id)) running.push(record.id);
    return running;
  }
  /** Admits inference for a run the lifecycle starts and applies its model and effort. */
  async function admit(conversation: Conversation, requestId: string) {
    const child = (await harness.snapshot(AgentDefinitionContextDoc, conversation.id, context))?.child;
    const selection = child?.model ? { kind: 'explicit' as const, ...child.model } : (await harness.snapshot(SessionControlsDoc, conversation.id, context))?.selection ?? { kind: 'default' as const };
    const model = await options.admitInference({ conversationId: String(conversation.id), requestId, selection });
    await options.configureModel(conversation.id, model);
    await applyInferenceThinking(conversation, model);
  }
  // A conversation whose run holds back its events or queued input, or whose slot a waiting subagent needs, is watched
  // in memory until that run ends (answered, failed, aborted or stopped): then what it held back goes in and waiting
  // subagents start. A reset loses the watch; recovery finds the conversation busy and watches it again.
  const watched = new Set<string>();
  let closing = false;
  harness.subscribeClose(() => { closing = true; });
  function watch(id: ConversationId) {
    if (watched.has(String(id))) return;
    watched.add(String(id));
    void (async () => {
      try {
        await (await harness.conversation(id, context))?.waitForIdle(context);
        watched.delete(String(id));
        await serialized(async () => { await deliverPending(String(id)); await drain(); });
      } catch (error) {
        watched.delete(String(id));
        if (!closing) options.report(error);
      }
    })();
  }
  /**
   * Starts waiting subagents, oldest first, while fewer than MAX_RUNNING_SUBAGENTS run, and watches the running ones while
   * any still wait. One that cannot start (its admission fails) is reported and leaves the queue, so it holds no other
   * back. Runs on the line.
   */
  async function drain() {
    const queue = (await harness.snapshot(SubagentRunQueueDoc, context))?.queue ?? [];
    if (queue.length === 0) return;
    const running = await runningSubagents();
    let started = 0;
    for (const item of queue) {
      if (running.length >= MAX_RUNNING_SUBAGENTS) break;
      started++;
      try {
        const conversation = await resolve(item.conversationId);
        // Pi admits a request id once, so a start a reset cut off before the item left the queue submits nothing twice.
        if (item.input) {
          await admit(conversation, item.input.requestId);
          await conversation.submit({ type: 'input', ...item.input }, context);
        }
        await flush(item.conversationId, true);
        if (await busy(conversation.id)) running.push(conversation.id);
      } catch (error) {
        options.report(new Error(`Subagent ${item.conversationId} could not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      } finally {
        await harness.commit(async tx => { const state = await tx.doc(SubagentRunQueueDoc); state.queue = state.queue.filter(value => value.conversationId !== item.conversationId); }, context);
      }
    }
    if (started < queue.length) for (const id of running) watch(id);
  }
  /** Queues a subagent's run unless a slot is free and none waits; true when queued. Runs on the line. */
  async function held(id: ConversationId, input?: QueuedSubagentRun['input']) {
    if (((await harness.snapshot(SubagentRunQueueDoc, context))?.queue.length ?? 0) === 0 && (await runningSubagents()).length < MAX_RUNNING_SUBAGENTS) return false;
    await harness.commit(async tx => {
      const state = await tx.doc(SubagentRunQueueDoc);
      if (!state.queue.some(item => item.conversationId === String(id))) state.queue.push({ conversationId: String(id), ...(input ? { input } : {}) });
    }, context);
    await drain();
    return true;
  }
  // Events wait here, not in the harness follow-up queue: a run that ends without a final boundary (abort, model
  // error, deploy) leaves that queue unread. What a busy conversation holds back goes in when its run ends (`watch`);
  // input such a run left queued resumes the same way: a queued write places the items queued before it, which starts
  // the next run. A subagent's run waits for a slot unless the queue starts it (`slotted`).
  async function flush(id: string, slotted = false) {
    const conversation = await resolve(id);
    const state = await harness.snapshot(ConversationLifecycleDoc, conversation.id, context);
    if (state?.events.some(isHandled)) await conversation.commit(async tx => handleEvents(await tx.doc(ConversationLifecycleDoc, conversation.id), new Set()), context);
    if (state?.stopped) return;
    const subagent = !slotted && (await harness.snapshot(AgentDefinitionContextDoc, conversation.id, context))?.child;
    const queued = (await harness.snapshot(InboxDoc, conversation.id, context))?.items.find(item => item.mode !== 'write');
    if (queued && await busy(conversation.id)) watch(conversation.id);
    else if (queued) {
      if (subagent && await held(conversation.id)) return;
      await admit(conversation, `queue-resume:${queued.id}`);
      // `edits` (even empty) makes this a queued write; a write of only kind and data is display-only and places nothing.
      await conversation.submit({ type: 'write', entry: { kind: 'gitspace.queue-resumed', data: { submission: String(queued.id) }, edits: [] } }, context);
    }
    // An event reaches the conversation once: as input here, or through a wait that returned it, never both; either way
    // it leaves the document, and only its request id stays.
    // Whatever is pending when the conversation is idle goes in as one message, so events that piled up cost one turn.
    const pending = (state?.events ?? []).filter(item => !isHandled(item)).map(item => item.event);
    if (pending.length === 0) return;
    if (await busy(conversation.id)) { watch(conversation.id); return; }
    if (subagent && await held(conversation.id)) return;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.map(event => event.requestId).join('\n'))));
    const requestId = pending.length === 1 ? pending[0]!.requestId : `events:${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    await admit(conversation, requestId);
    const content = formatConversationEvents(pending.map(event => ({ kind: event.kind, source: EVENT_SOURCE[event.kind](event), text: event.text })));
    await conversation.submit({ type: 'input', requestId, content, whenBusy: 'followUp' }, context);
    await conversation.commit(async tx => handleEvents(await tx.doc(ConversationLifecycleDoc, conversation.id), new Set(pending.map(event => event.requestId))), context);
  }
  /** Flushes one conversation; its failure (its admission) is reported, so it keeps no other conversation waiting. */
  async function deliverPending(id: string) {
    try { await flush(id); }
    catch (error) { options.report(new Error(`Conversation ${id} could not resume: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
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
      // A stopped subagent leaves the run queue; resuming it queues it again when it would start a run.
      if (stopped) {
        const runs = await tx.doc(SubagentRunQueueDoc);
        if (runs.queue.some(item => ids.has(item.conversationId))) runs.queue = runs.queue.filter(item => !ids.has(item.conversationId));
      }
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
        if ((await harness.snapshot(ConversationLifecycleDoc, conversation.id, context))?.stopped) throw new Error('Conversation is stopped; only an explicit user message may resume it');
        return operation();
      });
    },
    async startSubagent(id, input, prepare) {
      return serialized(async () => {
        const conversation = await resolve(id);
        if ((await harness.snapshot(ConversationLifecycleDoc, conversation.id, context))?.stopped) throw new Error('Conversation is stopped; only an explicit user message may resume it');
        await prepare();
        const earlier = await storage.submissionByRequest(conversation.id, input.requestId, context);
        if (earlier) return { kind: 'submitted', submissionId: String(earlier.id) };
        if (!(await held(conversation.id, input))) return { kind: 'submitted', submissionId: String((await conversation.submit({ type: 'input', ...input }, context)).id) };
        // Draining may have started it at once.
        const started = await storage.submissionByRequest(conversation.id, input.requestId, context);
        return started ? { kind: 'submitted', submissionId: String(started.id) } : { kind: 'queued' };
      });
    },
    // One conversation that cannot resume (its admission fails) must not keep the others, and the runs after recovery,
    // from resuming: its failure is reported and recovery moves on.
    async recover() {
      await serialized(async () => {
        for (const record of await conversations()) await deliverPending(String(record.id));
        try { await drain(); }
        catch (error) { options.report(new Error(`Waiting subagents could not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
      });
    },
    async deliver(event) {
      await serialized(async () => {
        const conversation = await resolve(event.conversationId);
        await conversation.commit(async tx => {
          const state = await tx.doc(ConversationLifecycleDoc, conversation.id);
          handleEvents(state, new Set());
          if (state.events.some(item => item.event.requestId === event.requestId) || state.handled?.includes(event.requestId)) return;
          state.events.push({ event });
          await noteTakeoverEvent(tx, event);
          await tx.appendEntry(conversation.id, { kind: `gitspace.${event.kind}`, data: { requestId: event.requestId, text: event.text, ...(event.sender ? { sender: event.sender } : {}), ...(event.payload === undefined ? {} : { payload: event.payload }) } });
        }, context);
        await flush(event.conversationId);
      });
    },
    async wait(id, { timeoutMs, signal }) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Wait timeout must be between 1 and 300000 milliseconds');
      signal?.throwIfAborted();
      const conversation = await resolve(id);
      await conversation.commit(async tx => handleEvents(await tx.doc(ConversationLifecycleDoc, conversation.id), new Set()), context);
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
            const pending = state.events.find(item => !isHandled(item));
            handleEvents(state, new Set(pending ? [pending.event.requestId] : []));
            return pending ? ConversationEventSchema.parse(pending.event) : null;
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
        const stopped = new Set(records.map(record => String(record.id)));
        await harness.commit(async tx => {
          const questions = await tx.doc(QuestionsDoc);
          questions.items = questions.items.filter(question => question.answer !== null || !stopped.has(question.conversationId));
        }, context);
      } finally { pendingStops.delete(settled.promise); settled.resolve(); }
    },
    async resume(id) { await userInput(id, async () => {}); },
  };
}
