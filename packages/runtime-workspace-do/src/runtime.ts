import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { ConversationId, Cursor, EntryRecord, Harness, TaskId, EntryId, CommitPublication } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { diffRevisions } from '@earendil-works/chord/delta';
import { createRuntimeHarness, createConversationTools, PlanDoc, QuestionsDoc, PlacementDoc, WorkspaceDoc, type ToolServices, type RuntimeHarnessOptions } from '@gitspace/runtime-core';
import { RuntimeSnapshotSchema, RuntimeWatchEventSchema, RuntimeToolResultSchema, receiptDigest, type RuntimeToolResult, type RuntimeSnapshot, type RuntimeWatchEvent, type RuntimeSubmitInput, type RuntimeCancelInput, type RuntimeAnswerInput, type RuntimeWatchInput } from '@gitspace/protocol-runtime';
import { DurableObjectSqliteDatabase } from './sqlite.js';
import { AttachmentStore, type AttachmentServices } from './attachments.js';
import { createSessionControls, SessionControlsDoc, type SessionControlServices } from '@gitspace/runtime-core/session-controls';
import type { RuntimeSessionCommand, RuntimeSessionResult, TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeQaDocumentSchema, RuntimeSnapshotCommitInputSchema, type RuntimeQaActionInput, type RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { z } from 'zod';
import { createCronRuntime, type RuntimeCronInput, type RuntimeRequestStatus } from '@gitspace/runtime-core';
import type { JsonValue } from '@earendil-works/chord';
import { RuntimeModelInputSchema, RuntimeMcpInputSchema, type RuntimeModelInput, type RuntimeMcpInput } from '@gitspace/protocol-runtime';
import { createHistoryIndex } from './history-index.js';
import { createReplicaStore } from './replica-store.js';
import { CloudFileStore } from './cloud-files.js';
import type { ArtifactsCodeStore } from './artifacts.js';
export type WorkspaceRuntimeOptions = Omit<RuntimeHarnessOptions, 'storage'> & { code: Pick<ArtifactsCodeStore, 'readFile' | 'writeSnapshot'>; initialCheckpoint?: () => Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>; browser?: RuntimeBrowserService; storage: DurableObjectStorage; identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>; attachments: AttachmentServices; session: Pick<SessionControlServices, 'catalog' | 'reload'>; qa: { list(): Promise<z.infer<typeof RuntimeQaDocumentSchema>['items']>; act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> }; modelProxy(input: { conversationId: string; operation: 'completion' | 'judge'; args: JsonValue; signal: AbortSignal }): Promise<JsonValue>; mcpProxy(input: { conversationId: string; attemptId: string; callId: string; method: RuntimeMcpInput['method']; args: JsonValue; signal: AbortSignal }): Promise<JsonValue>; waitUntil(promise: Promise<unknown>): void; schedule(timestamp: number): Promise<void> };
export type RuntimeAccepted = { accepted: true; cursor: number; conversationId?: string };
type RuntimeBrowserService = NonNullable<SessionControlServices['browser']>;
export type WorkspaceRuntime = {
  harness: Harness;
  attachments: AttachmentStore;
  cloudFiles: CloudFileStore;
  snapshot(): Promise<RuntimeSnapshot>;
  browserConversation(conversationId: string): Promise<{ id: ConversationId; root: boolean }>;
  submit(input: RuntimeSubmitInput): Promise<RuntimeAccepted>;
  cancel(input: RuntimeCancelInput): Promise<RuntimeAccepted>;
  answer(input: RuntimeAnswerInput, actor: { deviceId: string; canApprove: boolean }): Promise<RuntimeAccepted>;
  watch(input: RuntimeWatchInput): Promise<Response>;
  wake(): Promise<void>;
  session(conversationId: string | undefined, command: RuntimeSessionCommand, canApprove?: boolean): Promise<RuntimeSessionResult>;
  assignPlacement(conversationId: string, attachmentId: string, generation: number): Promise<void>;
  invokeConversationTool: ToolServices['invoke'];
  discoverMcp(input: { requestId: string; args: JsonValue }): Promise<RuntimeToolResult>;
  qa(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<RuntimeAccepted & { shareDraft?: string }>;
  snapshotCommit(input: RuntimeSnapshotCommitInput): Promise<RuntimeAccepted>;
  cronSubmit(input: RuntimeCronInput): Promise<{ conversationId: string }>;
  requestStatus(requestId: string): Promise<RuntimeRequestStatus>;
  transcript(conversationId?: string): Promise<(TranscriptEvent & { sessionId: string })[]>;
  model(input: RuntimeModelInput, machineId: string): Promise<JsonValue>;
  mcp(input: RuntimeMcpInput, machineId: string): Promise<JsonValue>;
  publish(): void;
};
export async function createWorkspaceRuntime(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
  const storage = await SqliteStorage.open(new DurableObjectSqliteDatabase(options.storage));
  const runtime = await createRuntimeHarness({ ...options, storage });
  const { harness } = runtime;
  const attachments = new AttachmentStore(options.storage, options.attachments);
  const cloudFiles = new CloudFileStore(options.storage, attachments, options.code, options.identity.workspaceId, publish, options.initialCheckpoint);
  async function recoverCloudFiles() {
    try { await cloudFiles.recover(); }
    catch (error) { options.onReport(error); await options.schedule(Date.now() + 5_000); }
  }
  const history = createHistoryIndex(options.storage, storage, (reference, conversationId) => attachments.historyResult(reference, conversationId));
  await history.refresh();
  const controls = createSessionControls({ ...runtime, ...options.session, browser: options.browser, history: history.service, admitInference: options.admitInference });
  const invokeConversationTool = createConversationTools({ ...options, harness, storage });
  const cron = createCronRuntime({ ...options, harness, storage, async wake() { await options.schedule(Date.now() + 1000); harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); } });
  const replica = createReplicaStore(options.storage);
  options.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_management(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT)');
  // Only committed task outcomes and tool/history entries prove materialization.
  // Receipt reads themselves never authorize collection.
  function materializeValue(value: unknown, conversationId: string): void {
    if (!value || typeof value !== 'object') return;
    const parsed = RuntimeToolResultSchema.safeParse(value);
    if (parsed.success) {
      if (attachments.hasMaterialized(parsed.data.attemptId)) return;
      const attempt = attachments.getAttempt(parsed.data.attemptId);
      if (attempt?.result && attempt.dispatch.conversationId === conversationId) attachments.materialized(parsed.data);
      return;
    }
    for (const child of Object.values(value)) materializeValue(child, conversationId);
  }
  function materializeReference(reference: unknown, conversationId: string): void {
    if (reference && typeof reference === 'object' && !Array.isArray(reference) && 'attemptId' in reference && typeof reference.attemptId === 'string' && 'sha256' in reference && typeof reference.sha256 === 'string') {
      attachments.materializedReference({ attemptId: reference.attemptId, sha256: reference.sha256 }, conversationId);
    }
  }
  function materializeEntry(entry: EntryRecord): void {
    if (entry.kind === 'gitspace.executor-results' && entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) && Array.isArray(entry.data.results)) {
      for (const reference of entry.data.results) materializeReference(reference, String(entry.conversationId));
    }
    if (entry.kind === 'gitspace.job-completed') materializeValue(entry.data, String(entry.conversationId));
    if (entry.kind !== 'pi.tool-result') return;
    for (const message of entry.model ?? []) {
      if (message.role !== 'toolResult') continue;
      const details = message.details;
      if (details && typeof details === 'object' && !Array.isArray(details) && 'executorResultReference' in details) {
        materializeReference(details.executorResultReference, String(entry.conversationId));
      }
      materializeValue(message.details, String(entry.conversationId));
      if (message.toolName === 'jobs') for (const block of message.content) {
        if (block.type !== 'text') continue;
        let value: unknown;
        try { value = JSON.parse(block.text); } catch { continue; }
        materializeValue(value, String(entry.conversationId));
      }
    }
  }
  async function materializeFinishedAttempts(): Promise<void> {
    const references = new Map<ConversationId, { attemptId: string; sha256: string }[]>();
    for (const dispatch of attachments.pendingMaterialization()) {
      const id = Number(dispatch.taskId);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const task = await storage.task(id as TaskId, BACKGROUND_CONTEXT);
      if (!task || String(task.conversationId) !== dispatch.conversationId || (task.state.status !== 'terminal' && task.state.status !== 'completing')) continue;
      const result = attachments.getAttempt(dispatch.attemptId)?.result;
      if (!result) continue;
      const values = references.get(task.conversationId) ?? [];
      values.push({ attemptId: dispatch.attemptId, sha256: await receiptDigest(result) });
      references.set(task.conversationId, values);
    }
    // Operational adapters and nested codemode calls may transform their result.
    // Commit exact result references as history evidence rather than mistaking a
    // terminal task flag (or a result retrieval) for durable materialization.
    for (const [conversationId, results] of references) for (let offset = 0; offset < results.length; offset += 32) {
      await harness.commit(async tx => {
        await tx.appendEntry(conversationId, { kind: 'gitspace.executor-results', data: { results: results.slice(offset, offset + 32) } });
      }, BACKGROUND_CONTEXT);
    }
  }
  let collection: Promise<void> | undefined;
  function collectReceipts(): Promise<void> {
    if (collection) return collection;
    collection = (async () => {
      try {
        await materializeFinishedAttempts();
        if (await attachments.collectMaterialized()) await options.schedule(Date.now() + 1000);
      } catch (error) {
        await options.schedule(Date.now() + 1000);
        throw error;
      } finally { collection = undefined; }
    })();
    return collection;
  }
  async function recoverMaterialization(): Promise<void> {
    const conversations = new Set<string>();
    for (const dispatch of attachments.pendingMaterialization()) {
      const id = Number(dispatch.taskId);
      if (Number.isSafeInteger(id) && id > 0) {
        const task = await storage.task(id as TaskId, BACKGROUND_CONTEXT);
        if (task && (task.state.status === 'terminal' || task.state.status === 'completing')) {
          materializeValue(task.state.outcome.result, String(task.conversationId));
          const result = task.state.outcome.result;
          if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.entryId === 'number') {
            const entry = await storage.entry(result.entryId as EntryId, BACKGROUND_CONTEXT);
            if (entry) materializeEntry(entry.entry);
          }
        }
      }
      conversations.add(dispatch.conversationId);
      if (dispatch.attemptId.startsWith('management:')) {
        const saved = options.storage.sql.exec<{ result: string | null }>('SELECT result FROM runtime_management WHERE request_id=?', dispatch.requestId).toArray()[0];
        if (saved?.result) materializeValue(JSON.parse(saved.result), dispatch.conversationId);
      }
    }
    // Auxiliary attempts (for example job log reads) are materialized by their
    // consuming tool's history entry, not by the source job's task.
    for (const conversationId of conversations) {
      const id = Number(conversationId);
      if (!Number.isSafeInteger(id)) continue;
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanEntries({ conversationId: id as ConversationId }, 128, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) materializeEntry(entry);
        cursor = page.next;
      } while (cursor);
    }
    await collectReceipts();
  }
  function committedMaterialization(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type === 'task' && (change.value.state.status === 'terminal' || change.value.state.status === 'completing')) materializeValue(change.value.state.outcome.result, String(change.value.conversationId));
      if (change.type === 'entry') materializeEntry(change.value);
    }
    queueMicrotask(() => { options.waitUntil(collectReceipts().catch(options.onReport)); });
  }
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let line = Promise.resolve();
  let publicationPending = false;
  const current = replica.snapshot();
  let snapshot: RuntimeSnapshot = current ? RuntimeSnapshotSchema.parse(JSON.parse(current)) : RuntimeSnapshotSchema.parse({ version: 1, ...options.identity, cursor: 0, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
  const conversationIds = new Map<string, ConversationId>();
  async function rebuild() {
    const conversations: RuntimeSnapshot['conversations'] = [];
    let cursor: Cursor | undefined;
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    do {
      const page = await storage.scanConversations({}, 128, cursor, BACKGROUND_CONTEXT);
      for (const record of page.items) {
        conversationIds.set(String(record.id), record.id);
        const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
        if (!conversation) continue;
        // Pi scans fork-aware entries newest-first; one bounded page includes inherited history.
        const entries = [...(await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items].reverse();
        const placement = await harness.snapshot(PlacementDoc, record.id, BACKGROUND_CONTEXT);
        conversations.push({ id: String(record.id), parentId: record.parent ? String(record.parent.conversationId) : null, title: record.id === runtime.root.id ? 'Workspace' : `Agent ${record.id}`, status: inspection.tasks.some(task => task.record.conversationId === record.id && task.state.kind === 'running') ? 'running' : 'idle', placement: placement?.attachmentId ? { attachmentId: placement.attachmentId, generation: placement.generation } : null, messages: entries.flatMap(entry => (entry.model ?? []).map((message, index) => ({ id: `${entry.id}:${index}`, role: message.role === 'toolResult' ? 'tool' as const : message.role, content: typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []), createdAt: new Date(message.timestamp).toISOString() }))) });
      }
      cursor = page.next;
    } while (cursor);
    const tasks: RuntimeSnapshot['tasks'] = [];
    // Pi task scans are ascending. Seed the terminal cursor from the indexed newest-128 boundary,
    // then let the portable SDK decode records. Receipt GC follows materialization independently of this display window.
    const terminalFloor = options.storage.sql.exec<{ id: number }>("SELECT id FROM tasks WHERE status='terminal' ORDER BY id DESC LIMIT 1 OFFSET 127").toArray()[0]?.id;
    for (const status of ['pending', 'running', 'waiting', 'completing', 'terminal'] as const) {
      let taskCursor: Cursor | undefined = status === 'terminal' && terminalFloor !== undefined ? { after: terminalFloor - 1 } : undefined;
      do {
        const page = await storage.scanTasks({ status }, 128, taskCursor, BACKGROUND_CONTEXT);
        for (const task of page.items) {
          const attempt = attachments.getAttempt(`task:${task.id}`) ?? attachments.getAttempt(`tool:${task.id}`);
          const terminal = task.state.status === 'terminal' || task.state.status === 'completing' ? task.state.outcome : null;
          const result = terminal?.result ?? null;
          const encodedResult = JSON.stringify(result);
          tasks.push({ id: String(task.id), kind: task.kind, conversationId: String(task.conversationId), parentId: task.owner === undefined ? null : String(task.owner), background: task.background, state: terminal ? terminal.status === 'completed' ? 'completed' : terminal.status === 'aborted' ? 'interrupted' : 'failed' : task.state.status === 'waiting' ? 'waiting' : task.state.status === 'running' ? 'running' : 'pending', machineId: attempt?.dispatch.machineId ?? null, result: encodedResult.length <= 4096 ? result : { truncated: true, taskId: String(task.id), preview: encodedResult.slice(0, 4096) } });
        }
        taskCursor = status === 'terminal' ? undefined : page.next;
      } while (taskCursor);
    }
    const questions = await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT);
    for (const conversation of conversations) if (questions?.items.some(question => question.conversationId === conversation.id && question.answer === null)) conversation.status = 'waiting';
    const workspace = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT);
    const qa = RuntimeQaDocumentSchema.parse({ items: await options.qa.list() });
    const committedCode = await cloudFiles.snapshot();
    const next = RuntimeSnapshotSchema.parse({ version: 1, ...options.identity, cursor: snapshot.cursor + 1, conversations, tasks, attachments: attachments.list(), questions: questions?.items ?? [], documents: { 'gitspace.workspace': workspace ?? null, 'gitspace.qa': qa, 'gitspace.code': committedCode ?? null } });
    const event = RuntimeWatchEventSchema.parse({ type: 'delta', baseCursor: snapshot.cursor, cursor: next.cursor, ops: diffRevisions(snapshot, next) });
    const encodedEvent = JSON.stringify(event);
    replica.commit(next.cursor, JSON.stringify(next), encodedEvent);
    snapshot = next;
    const bytes = encoder.encode(encodedEvent + '\n');
    for (const listener of listeners) {
      if ((listener.desiredSize ?? 0) <= 0) { listener.error(new Error('Runtime subscription exceeded bounded queue; reconnect for reset')); listeners.delete(listener); }
      else listener.enqueue(bytes);
    }
  }
  function publish() {
    // Keep at most one rebuild queued behind the active one. Commits during a rebuild
    // queue its successor; readers await a finite captured publication, not future work.
    if (publicationPending) return;
    publicationPending = true;
    const publication = line.catch(error => { options.onReport(error); }).then(async () => {
      publicationPending = false;
      await rebuild();
    });
    line = publication;
    options.waitUntil(publication);
  }
  harness.subscribeCommits(publication => {
    committedMaterialization(publication);
    if (publication.changes.some(change => change.type === 'entry' || change.type === 'conversation')) {
      const indexed = history.refresh();
      queueMicrotask(() => { options.waitUntil(indexed.catch(options.onReport)); });
    }
    publish();
  });
  await recoverMaterialization();
  await recoverCloudFiles();
  await history.refresh();
  await rebuild();
  async function conversation(id?: string) {
    if (id === undefined) return runtime.root;
    const canonical = conversationIds.get(id);
    if (canonical === undefined) throw new Error('Unknown runtime conversation');
    const value = await harness.conversation(canonical, BACKGROUND_CONTEXT);
    if (!value) throw new Error('Runtime conversation no longer exists');
    return value;
  }
  return {
    harness, attachments, cloudFiles,
    invokeConversationTool,
    async browserConversation(conversationId) {
      const target = await conversation(conversationId);
      const record = await storage.conversation(target.id, BACKGROUND_CONTEXT);
      if (!record) throw new Error('Browser conversation no longer exists');
      return { id: record.id, root: record.id === runtime.root.id && record.owner === undefined };
    },
    async discoverMcp(input) {
      const fingerprint = JSON.stringify(input.args);
      const prior = options.storage.sql.exec<{ input: string; result: string | null }>('SELECT input,result FROM runtime_management WHERE request_id=?', input.requestId).toArray()[0];
      if (prior) {
        if (prior.input !== fingerprint) throw new Error('Management request identity changed');
        if (prior.result !== null) return RuntimeToolResultSchema.parse(JSON.parse(prior.result));
        return { requestId: input.requestId, attemptId: `management:${input.requestId}`, status: 'interrupted', content: [{ type: 'text', text: 'Discovery has an unresolved prior attempt; it was not relaunched.' }] };
      }
      options.storage.sql.exec('INSERT INTO runtime_management(request_id,input) VALUES(?,?)', input.requestId, fingerprint);
      const result = await options.tools.invoke({ tool: 'mcp_discover', args: input.args, conversationId: String(runtime.root.id), taskId: `management:${input.requestId}`, requestId: input.requestId, attemptId: `management:${input.requestId}`, replay: 'unsafe', signal: AbortSignal.timeout(30_000) });
      options.storage.sql.exec('UPDATE runtime_management SET result=? WHERE request_id=?', JSON.stringify(result), input.requestId);
      materializeValue(result, String(runtime.root.id));
      await collectReceipts();
      return result;
    },
    cronSubmit: cron.submit,
    requestStatus: cron.status,
    async model(raw, machineId) {
      const input = RuntimeModelInputSchema.parse(raw);
      const attempt = attachments.getAttempt(input.dispatch.attemptId);
      if (!attempt || attempt.status !== 'dispatched' || attempt.dispatch.machineId !== machineId || JSON.stringify(attempt.dispatch) !== JSON.stringify(input.dispatch) || attempt.dispatch.tool !== 'codemode') throw new Error('Model proxy requires the exact active codemode attempt');
      const attachment = attachments.list().find(item => item.attachmentId === attempt.dispatch.attachmentId);
      if (!attachment || attachment.state !== 'ready' || attachment.generation !== attempt.dispatch.generation) throw new Error('Model proxy attachment is fenced');
      const remaining = Date.parse(attempt.dispatch.deadlineAt) - Date.now();
      if (remaining <= 0) throw new Error('Model proxy attempt deadline expired');
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      const task = inspection.tasks.find(item => `tool:${item.record.id}` === attempt.dispatch.attemptId && item.record.kind === 'pi.tool' && item.record.state.status === 'running');
      if (!task) throw new Error('Model proxy owning tool is not running');
      return options.modelProxy({ conversationId: String(task.record.conversationId), operation: input.operation, args: input.args, signal: AbortSignal.timeout(remaining) });
    },
    async mcp(raw, machineId) {
      const input = RuntimeMcpInputSchema.parse(raw);
      const attempt = attachments.getAttempt(input.dispatch.attemptId);
      if (!attempt || attempt.status !== 'dispatched' || attempt.dispatch.machineId !== machineId || JSON.stringify(attempt.dispatch) !== JSON.stringify(input.dispatch) || attempt.dispatch.tool !== 'codemode') throw new Error('MCP proxy requires the exact active codemode attempt');
      const attachment = attachments.list().find(item => item.attachmentId === attempt.dispatch.attachmentId);
      if (!attachment || attachment.state !== 'ready' || attachment.generation !== attempt.dispatch.generation) throw new Error('MCP proxy attachment is fenced');
      const remaining = Date.parse(attempt.dispatch.deadlineAt) - Date.now();
      if (remaining <= 0) throw new Error('MCP proxy attempt deadline expired');
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      const task = inspection.tasks.find(item => `tool:${item.record.id}` === attempt.dispatch.attemptId && item.record.kind === 'pi.tool' && item.record.state.status === 'running');
      if (!task) throw new Error('MCP proxy owning tool is not running');
      return options.mcpProxy({ conversationId: String(task.record.conversationId), attemptId: attempt.dispatch.attemptId, callId: input.callId, method: input.method, args: input.args, signal: AbortSignal.timeout(remaining) });
    },
    async transcript(conversationId) {
      const target = await conversation(conversationId);
      const events: (TranscriptEvent & { sessionId: string })[] = [];
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await target.entries({}, 128, cursor, BACKGROUND_CONTEXT);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor);
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry) continue;
        for (const message of entry.model ?? []) events.push({ sessionId: String(target.id), ordinal: events.length, kind: 'message_end', payload: { message, entryId: String(entry.id) }, createdAt: new Date(message.timestamp).toISOString() });
      }
      return events;
    },
    async qa(input, actor) {
      if (!actor.canApprove) throw new Error('QA management requires human capability');
      const result = await options.qa.act(input, actor); publish(); await line;
      return { accepted: true, cursor: snapshot.cursor, ...result };
    },
    async snapshotCommit(raw) {
      const input = RuntimeSnapshotCommitInputSchema.parse(raw);
      await cloudFiles.snapshot();
      options.storage.transactionSync(() => {
        const attachment = attachments.list().find(item => item.attachmentId === input.attachmentId && item.generation === input.generation && item.role === 'primary' && (item.state === 'attaching' || item.state === 'ready' || item.state === 'draining'));
        if (!attachment) throw new Error('Snapshot publication requires the current primary');
        if (attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId) throw new Error('Snapshot identity mismatch');
        if (attachment.state === 'attaching' && input.final) throw new Error('Attaching primary cannot publish a final checkpoint');
        cloudFiles.commitMachine(input.checkpoint, input.previousWorktreeCommit, attachment.state === 'attaching');
        if (input.final) attachments.recordPrimaryFlush(input.attachmentId, input.generation);
      });
      publish(); await line;
      return { accepted: true, cursor: snapshot.cursor };
    },
    async session(conversationId, command, canApprove = false) {
      const wakesTasks = !['control', 'agentSetup', 'historyAnchorId', 'messages', 'historyPage', 'persist', 'handoff', 'stop'].includes(command.type);
      if (wakesTasks) await options.schedule(Date.now() + 1000);
      const result = await controls.execute(conversationId, command, canApprove);
      if (wakesTasks) { harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); }
      return result;
    },
    async assignPlacement(conversationId, attachmentId, generation) {
      const attachment = attachments.list().find(value => value.attachmentId === attachmentId && value.generation === generation && value.state === 'ready');
      if (!attachment) throw new Error('Placement requires a ready attachment generation');
      const target = await conversation(conversationId);
      await target.commit(async tx => {
        const placement = await tx.doc(PlacementDoc, target.id);
        if (placement.attachmentId !== null && (placement.attachmentId !== attachmentId || placement.generation !== generation)) {
          const prior = attachments.list().find(value => value.attachmentId === placement.attachmentId && value.generation === placement.generation);
          if (prior?.role !== 'primary' || prior.state !== 'detached' || attachment.role !== 'primary') throw new Error('Conversation placement is stable; fork a conversation to use another checkout');
        }
        placement.attachmentId = attachmentId; placement.generation = generation;
      }, BACKGROUND_CONTEXT);
    },
    async snapshot() { await line; return snapshot; },
    async submit(input: RuntimeSubmitInput) {
      const target = await conversation(input.conversationId);
      await options.schedule(Date.now() + 1000);
      const selection = (await harness.snapshot(SessionControlsDoc, target.id, BACKGROUND_CONTEXT))?.selection ?? { kind: 'default' as const };
      const admitted = await options.admitInference({ conversationId: String(target.id), requestId: input.requestId, selection });
      await runtime.configureModel(target.id, admitted);
      await target.submit({ type: 'input', content: input.text, requestId: input.requestId, whenBusy: 'followUp' }, BACKGROUND_CONTEXT);
      options.waitUntil(target.waitForIdle(BACKGROUND_CONTEXT));
      await line;
      return { accepted: true as const, cursor: snapshot.cursor, conversationId: String(target.id) };
    },
    async cancel(input: RuntimeCancelInput) { await (await conversation(input.conversationId)).abort(BACKGROUND_CONTEXT, { background: true }); await line; return { accepted: true as const, cursor: snapshot.cursor }; },
    async answer(input: RuntimeAnswerInput, actor: { deviceId: string; canApprove: boolean }) {
      await options.schedule(Date.now() + 1000);
      await harness.commit(async tx => {
        const questions = await tx.doc(QuestionsDoc);
        const question = questions.items.find(item => item.id === input.questionId);
        if (!question) throw new Error('Question not found');
        if (question.answer !== null) { if (JSON.stringify(question.answer) !== JSON.stringify(input.answer)) throw new Error('Question already answered'); return; }
        if (question.kind === 'approval' && !actor.canApprove) throw new Error('Human approval capability required');
        if (question.kind === 'approval' && typeof input.answer !== 'boolean') throw new Error('Approval answer must be a boolean');
        if (question.browser && input.answer === true && input.expectedBrowserPreparationId !== question.browser.id) throw new Error('Browser group approval must match the displayed preparation');
        question.answer = input.answer;
        if (question.kind === 'approval') {
          const id = conversationIds.get(question.conversationId); if (id === undefined) throw new Error('Approval conversation missing');
          const plan = await tx.doc(PlanDoc, id);
          if (plan.questionId === input.questionId) {
            plan.status = input.answer === true ? 'approved' : 'rejected';
            if (plan.status === 'approved') { const workspace = await tx.doc(WorkspaceDoc); workspace.phase = 'code'; }
          }
        }
      }, BACKGROUND_CONTEXT);
      harness.resume();
      options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT));
      await line; return { accepted: true as const, cursor: snapshot.cursor };
    },
    async watch(input: RuntimeWatchInput): Promise<Response> {
      await line;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(value) {
        controller = value;
        const rows = input.after === null ? [] : replica.events(input.after);
        const first = rows?.[0] ? RuntimeWatchEventSchema.parse(JSON.parse(rows[0].event)) : undefined;
        let initial: RuntimeWatchEvent | undefined;
        if (input.after === null || input.after === snapshot.cursor) initial = { type: 'snapshot', snapshot };
        else if (input.after > snapshot.cursor) initial = { type: 'reset', reason: 'cursor-ahead', snapshot };
        else if (input.after < snapshot.cursor && (first?.type !== 'delta' || first.baseCursor !== input.after)) initial = { type: 'reset', reason: 'cursor-expired', snapshot };
        if (initial) value.enqueue(encoder.encode(JSON.stringify(initial) + '\n'));
        else for (const row of rows ?? []) value.enqueue(encoder.encode(row.event + '\n'));
        listeners.add(value);
      }, cancel() { listeners.delete(controller); } }, { highWaterMark: 257 });
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
    },
    async wake() { await recoverCloudFiles(); await collectReceipts(); harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); const inspection = await harness.inspect(BACKGROUND_CONTEXT); if (inspection.tasks.length > 0) await options.schedule(Date.now() + 1000); },
    publish,
  };
}
