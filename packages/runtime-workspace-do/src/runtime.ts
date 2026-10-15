import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { ConversationId, ConversationRecord, Cursor, EntryRecord, Harness, TaskId, TaskRecord, EntryId, CommitPublication } from '@earendil-works/pi-durable';
import { defineDoc } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { diffRevisions } from '@earendil-works/chord/delta';
import { createRuntimeHarness, createConversationTools, AgentDefinitionContextDoc, PlanDoc, QuestionsDoc, WorkspaceDoc, type ToolServices, type RuntimeHarnessOptions } from '@gitspace/runtime-core';
import { RuntimeSnapshotSchema, RuntimeWatchEventSchema, RuntimeToolResultSchema, receiptDigest, type RuntimeToolResult, type RuntimeSnapshot, type RuntimeWatchEvent, type RuntimeSubmitInput, type RuntimeCancelInput, type RuntimeAnswerInput, type RuntimeGitCheckpoint, type RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import { DurableObjectSqliteDatabase } from './sqlite.js';
import { AttachmentStore, isAttachmentOnline, isAttachmentReady, type AttachmentServices } from './attachments.js';
import { createSessionControls, SessionControlsDoc, type SessionControlServices } from '@gitspace/runtime-core/session-controls';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeQaDocumentSchema, RuntimeSnapshotCommitInputSchema, type RuntimeQaActionInput, type RuntimeSnapshotCommitInput, type RuntimeSnapshotCommitResult } from '@gitspace/protocol-runtime';
import type { z } from 'zod';
import { createCronRuntime, type RuntimeCronInput, type RuntimeRequestStatus } from '@gitspace/runtime-core';
import type { JsonValue } from '@earendil-works/chord';
import { createSessionHistory } from './session-history.js';
import { createReplicaStore, replicaEvents } from './replica-store.js';
import { WorkspaceDraftStore } from './draft.js';
import type { WorkspaceDraftSave, WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';
import { CloudFileStore } from './cloud-files.js';
import { CodeSearchIndex, type CodeSearchSource } from './cloud-search-index.js';
import { artifactsWorkspaceRepository, type ArtifactsCodeStore } from './artifacts.js';
import type { GitLfsConfirmedObject, GitLfsStore, WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import type { RuntimeTranscriptRange } from '@gitspace/runtime-core/history';
import { transcriptResponse, type RuntimeTranscriptFormat } from './transcript.js';
import { agentActivity, agentCounts, conversationStatus, workspaceStatusSummary } from './workspace-status.js';
export type WorkspaceRuntimeOptions = Omit<RuntimeHarnessOptions, 'storage'> & { lfs: GitLfsStore; retainLfs(checkpoint: RuntimeSnapshotCommitInput['checkpoint'], publicationId?: string): Promise<void>; code: Pick<ArtifactsCodeStore, 'readFile' | 'writeSnapshot' | 'mergeSnapshot' | 'listSnapshotPaths'> & CodeSearchSource; initialCheckpoint?: () => Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>; /** Markdown for a document file (PDF, Office), or null for any other file. */ documentMarkdown?: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<string | null>; browser?: RuntimeBrowserService; storage: DurableObjectStorage; identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>; attachments: AttachmentServices; session: Pick<SessionControlServices, 'catalog' | 'reload'>; qa: { list(): Promise<z.infer<typeof RuntimeQaDocumentSchema>['items']>; act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> }; waitUntil(promise: Promise<unknown>): void; schedule(timestamp: number): Promise<void>; /** Called synchronously with each changed snapshot and its status summary right after the storage write that publishes it. */ published?(snapshot: RuntimeSnapshot, status: WorkspaceStatusSummary): void ; /** The canonical snapshot changed; these attached machines do not hold it yet. */ snapshotChanged?(machineIds: string[]): void };
export type RuntimeAccepted = { accepted: true; cursor: number; conversationId?: string };
/** Waking a paused cache before its environment run is dispatched can take minutes; discovery cannot. A sync capture
 * uploads the machine's changes. */
const MANAGEMENT_TIMEOUT_MS: Readonly<Record<'mcp_discover' | 'lifecycle' | 'sync', number>> = { mcp_discover: 30_000, lifecycle: 240_000, sync: 120_000 };
type ManagementTool = keyof typeof MANAGEMENT_TIMEOUT_MS;
type RuntimeBrowserService = NonNullable<SessionControlServices['browser']>;
export type WorkspaceRuntime = {
  harness: Harness;
  attachments: AttachmentStore;
  cloudFiles: CloudFileStore;
  /** Indexed search of the canonical snapshot; needs no machine. */
  codeSearch: CodeSearchIndex;
  snapshot(): Promise<RuntimeSnapshot>;
  browserConversation(conversationId: string): Promise<{ id: ConversationId; root: boolean }>;
  submit(input: RuntimeSubmitInput, deviceId?: string): Promise<RuntimeAccepted>;
  saveDraft(input: WorkspaceDraftSave, deviceId: string): Promise<WorkspaceDraftSaveResult>;
  cancel(input: RuntimeCancelInput): Promise<RuntimeAccepted>;
  answer(input: RuntimeAnswerInput, actor: { deviceId: string; canApprove: boolean }): Promise<RuntimeAccepted>;
  /** Runtime events newer than `after`, bounded: a snapshot for null, nothing when current, otherwise the retained
   * deltas after it, or a reset when it is ahead, expired or further behind than one read returns. */
  events(after: number | null): Promise<RuntimeWatchEvent[]>;
  wake(): Promise<void>;
  session(conversationId: string | undefined, command: RuntimeSessionCommand, canApprove?: boolean, deviceId?: string): Promise<RuntimeSessionResult>;
  /** The one status summary of this workspace. */
  status(): Promise<RuntimeWorkspaceStatus>;
  waitForSnapshot(commit: string): Promise<void>;
  cacheReady(attachmentId: string, generation: number): Promise<void>;
  /** An agent asked for this attachment: once the machine reports it ready, the conversation is told so it can retry. */
  noticeWhenReady(input: { attachmentId: string; generation: number; conversationId: string; label: string }): void;
  invokeConversationTool: ToolServices['invoke'];
  /** A human request run once per request id as a tool call of the main conversation: MCP discovery, a sync action,
   * or an environment run dispatched to the cache machine its arguments name. */
  manage(input: { tool: ManagementTool; requestId: string; args: JsonValue }): Promise<RuntimeToolResult>;
  qa(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<RuntimeAccepted & { shareDraft?: string }>;
  snapshotCommit(input: RuntimeSnapshotCommitInput): Promise<RuntimeSnapshotCommitResult>;
  lfsRoots(): RuntimeSnapshotCommitInput['checkpoint'][];
  reconcileLfsSources(objects: readonly GitLfsConfirmedObject[]): Promise<void>;
  cronSubmit(input: RuntimeCronInput): Promise<{ conversationId: string }>;
  requestStatus(requestId: string): Promise<RuntimeRequestStatus>;
  cronWithdraw(requestId: string): Promise<RuntimeRequestStatus>;
  cronCancel(requestId: string): Promise<RuntimeRequestStatus>;
  cronNotifyOverdue(requestId: string): Promise<void>;
  transcript(conversationId?: string, format?: RuntimeTranscriptFormat, range?: RuntimeTranscriptRange): Promise<Response>;
  publish(): void;
};
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
// Retain the persisted document kind so acknowledged cache notices are not emitted again.
const CacheNoticesDoc = defineDoc<{ seen: Record<string, boolean> }>({ kind: 'gitspace.replica-notices', version: 1, scope: 'session', initial: () => ({ seen: {} }) });
export async function createWorkspaceRuntime(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
  const storage = await SqliteStorage.open(new DurableObjectSqliteDatabase(options.storage));
  const runtime = await createRuntimeHarness({ ...options, storage });
  const { harness } = runtime;
  const attachments = new AttachmentStore(options.storage, options.attachments);
  const cloudFiles = new CloudFileStore(options.storage, attachments, options.code, options.identity.workspaceId, codeChanged, options.lfs, async (checkpoint, publicationId) => {
    try { await options.retainLfs(checkpoint, publicationId); }
    catch (error) { await options.schedule(Date.now() + 5_000); throw error; }
  }, options.initialCheckpoint, options.documentMarkdown);
  const codeSearch = new CodeSearchIndex({
    storage: options.storage, source: options.code, repository: artifactsWorkspaceRepository(options.identity.workspaceId),
    snapshots: { current: () => cloudFiles.snapshot(), distance: (ancestor, descendant, limit) => cloudFiles.snapshotDistance(ancestor, descendant, limit) },
    schedule: options.schedule, report: options.onReport,
  });
  /** Every canonical snapshot change republishes the projection, queues indexing for the next alarm and tells every
   * attached machine except the one whose publication made it. */
  function codeChanged(source?: string) {
    publish(); options.waitUntil(codeSearch.changed());
    options.snapshotChanged?.(attachments.list().filter(item => item.state !== 'detached' && item.machineId !== source).map(item => item.machineId));
  }
  async function flushCloudRetention() {
    try { await cloudFiles.flushRetention(); }
    catch (error) { options.onReport(error); await options.schedule(Date.now() + 5_000); }
  }
  let definitionFiles: { commit: string; files: Array<{ path: string; content: string }> } | undefined;
  const loadAgentDefinitions: NonNullable<SessionControlServices['loadAgentDefinitions']> = async () => {
    const checkpoint = await cloudFiles.initializeSnapshot();
    if (!checkpoint) return [];
    if (definitionFiles?.commit === checkpoint.worktreeCommit) return definitionFiles.files;
    const repository = artifactsWorkspaceRepository(options.identity.workspaceId);
    const paths = (await options.code.listSnapshotPaths(repository, checkpoint.worktreeTree)).filter(path => /^(?:\.omp|\.agents)\/agents\/[A-Za-z0-9._-]+\.md$/u.test(path)).sort();
    const files = await Promise.all(paths.map(async path => {
      const blob = await options.code.readFile(repository, checkpoint.worktreeCommit, path);
      if (!blob) throw new Error(`Committed agent definition is missing: ${path}`);
      if (blob.size > 262144) throw new Error(`Agent definition exceeds 256 KiB: ${path}`);
      return { path, content: await blob.text() };
    }));
    definitionFiles = { commit: checkpoint.worktreeCommit, files };
    return files;
  };
  const history = createSessionHistory(options.storage, storage);
  const controls = createSessionControls({ ...runtime, ...options.session, setWorkspacePhase: options.setWorkspacePhase, loadAgentDefinitions, browser: options.browser, history, admitInference: options.admitInference });
  const invokeConversationTool = createConversationTools({ ...options, ...runtime, storage, catalog: options.session.catalog, refreshDefinitions: controls.loadDefinitions });
  const cron = createCronRuntime({ ...options, harness, storage, configureModel: runtime.configureModel, stop: id => runtime.lifecycle.stop(id), async wake() { await options.schedule(Date.now() + 1000); harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); } });
  const replica = createReplicaStore(options.storage);
  const drafts = new WorkspaceDraftStore({
    read: async () => { const value = replica.draft(); return value === undefined ? undefined : JSON.parse(value); },
    write: async value => { replica.commitDraft(value.revision, JSON.stringify(value)); },
  });
  await drafts.initialize();
  options.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_management(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT)');
  options.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attach_notices(attachment_id TEXT NOT NULL, generation INTEGER NOT NULL, conversation_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(attachment_id, generation, conversation_id))');
  const snapshotWaiters = new Set<() => void>();
  let line = Promise.resolve();
  let publicationPending = false;
  const stored: unknown = (() => { const current = replica.snapshot(); return current ? JSON.parse(current) : undefined; })();
  const restored = RuntimeSnapshotSchema.safeParse(stored);
  // A snapshot stored by an older release that no longer parses is rebuilt from current state at startup (below),
  // continuing from its cursor so watchers see a newer revision.
  const storedCursor = typeof stored === 'object' && stored !== null && 'cursor' in stored && typeof stored.cursor === 'number' ? stored.cursor : 0;
  let snapshot: RuntimeSnapshot = restored.success ? restored.data : RuntimeSnapshotSchema.parse({ version: 1, ...options.identity, cursor: storedCursor, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
  const conversationIds = new Map<string, ConversationId>();
  // Derived snapshot state is cached per conversation/task and refreshed only for records a commit touched, so a
  // rebuild reads O(changed) rows instead of every conversation's 256-entry window and every task on each commit.
  type ConversationView = Omit<RuntimeSnapshot['conversations'][number], 'status' | 'error'> & { failure: string | null; subagent: JsonValue | null };
  type TaskView = RuntimeSnapshot['tasks'][number];
  const conversationViews = new Map<string, ConversationView>();
  const dirtyConversations = new Set<ConversationId>();
  const taskViews = new Map<number, { status: StoredTask['state']['status']; view: TaskView }>();
  const dirtyTasks = new Map<number, StoredTask>();
  let conversationsLoaded = false;
  let tasksLoaded = false;
  // Agent counts of the last rebuild, read live from tasks and questions.
  let agents: WorkspaceStatusSummary['agents'] = { green: 0, blue: 0, orange: 0, red: 0 };
  const TASK_ORDER: Record<StoredTask['state']['status'], number> = { pending: 0, running: 1, waiting: 2, completing: 3, terminal: 4 };
  const TERMINAL_TASK_WINDOW = 128;
  async function conversationView(record: ConversationRecord): Promise<ConversationView | undefined> {
    const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (!conversation) return undefined;
    // Pi scans fork-aware entries newest-first; one bounded page includes inherited history.
    const entries = [...(await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items].reverse();
    const parentId = record.parent?.conversationId ?? record.owner?.conversationId;
    const child = (await harness.snapshot(AgentDefinitionContextDoc, record.id, BACKGROUND_CONTEXT))?.child;
    // A rejected model request leaves an empty assistant message; its error is the user's only explanation.
    const latest = entries.flatMap(entry => entry.model ?? []).findLast(message => message.role === 'assistant');
    return {
      id: String(record.id), parentId: parentId === undefined ? null : String(parentId),
      title: child ? child.name : record.id === runtime.root.id ? 'Workspace' : `Agent ${record.id}`,
      failure: latest?.role === 'assistant' && latest.stopReason === 'error' ? latest.errorMessage ?? 'The model request failed' : null,
      subagent: child ? { conversationId: String(record.id), ...child } : null,
      messages: entries.flatMap(entry => (entry.model ?? []).map((message, index) => ({ id: `${entry.id}:${index}`, role: message.role === 'toolResult' ? 'tool' as const : message.role, content: typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []), createdAt: new Date(message.timestamp).toISOString() }))),
    };
  }
  async function refreshConversations(): Promise<void> {
    if (!conversationsLoaded) {
      conversationViews.clear();
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanConversations({}, 128, cursor, BACKGROUND_CONTEXT);
        for (const record of page.items) {
          conversationIds.set(String(record.id), record.id);
          const view = await conversationView(record);
          if (view) conversationViews.set(view.id, view);
        }
        cursor = page.next;
      } while (cursor);
      conversationsLoaded = true;
    }
    // Commits during this refresh mark again and queue the next rebuild.
    const dirty = [...dirtyConversations];
    dirtyConversations.clear();
    for (const id of dirty) {
      const record = await storage.conversation(id, BACKGROUND_CONTEXT);
      if (record) conversationIds.set(String(record.id), record.id);
      const view = record ? await conversationView(record) : undefined;
      if (view) conversationViews.set(view.id, view);
      else conversationViews.delete(String(id));
    }
  }
  function taskView(task: StoredTask): TaskView {
    const terminal = task.state.status === 'terminal' || task.state.status === 'completing' ? task.state.outcome : null;
    const result = terminal?.result ?? null;
    const encodedResult = JSON.stringify(result);
    return { id: String(task.id), kind: task.kind, conversationId: String(task.conversationId), parentId: task.owner === undefined ? null : String(task.owner), background: task.background, state: terminal ? terminal.status === 'completed' ? 'completed' : terminal.status === 'aborted' ? 'interrupted' : 'failed' : task.state.status === 'waiting' ? 'waiting' : task.state.status === 'running' ? 'running' : 'pending', machineId: attachments.runningMachine(`task:${task.id}`) ?? attachments.runningMachine(`tool:${task.id}`), result: encodedResult.length <= 4096 ? result : { truncated: true, taskId: String(task.id), preview: encodedResult.slice(0, 4096) } };
  }
  async function refreshTasks(): Promise<void> {
    if (!tasksLoaded) {
      taskViews.clear();
      // Pi task scans are ascending. Seed the terminal cursor from the indexed newest-128 boundary,
      // then let the portable SDK decode records. Receipt GC follows materialization independently of this display window.
      const terminalFloor = options.storage.sql.exec<{ id: number }>(`SELECT id FROM tasks WHERE status='terminal' ORDER BY id DESC LIMIT 1 OFFSET ${TERMINAL_TASK_WINDOW - 1}`).toArray()[0]?.id;
      for (const status of ['pending', 'running', 'waiting', 'completing', 'terminal'] as const) {
        let taskCursor: Cursor | undefined = status === 'terminal' && terminalFloor !== undefined ? { after: terminalFloor - 1 } : undefined;
        do {
          const page = await storage.scanTasks({ status }, 128, taskCursor, BACKGROUND_CONTEXT);
          for (const task of page.items) taskViews.set(Number(task.id), { status: task.state.status, view: taskView(task) });
          taskCursor = status === 'terminal' ? undefined : page.next;
        } while (taskCursor);
      }
      tasksLoaded = true;
    }
    for (const [id, task] of dirtyTasks) taskViews.set(id, { status: task.state.status, view: taskView(task) });
    dirtyTasks.clear();
    const terminal = [...taskViews].flatMap(([id, task]) => task.status === 'terminal' ? [id] : []).sort((left, right) => left - right);
    for (const id of terminal.slice(0, Math.max(0, terminal.length - TERMINAL_TASK_WINDOW))) taskViews.delete(id);
    // Dispatch is not a task commit: refresh the assigned machine of live tasks by key lookup.
    for (const [id, task] of taskViews) if (task.status !== 'terminal' && task.status !== 'completing' && task.view.machineId === null) {
      const machineId = attachments.runningMachine(`task:${id}`) ?? attachments.runningMachine(`tool:${id}`);
      if (machineId !== null) task.view = { ...task.view, machineId };
    }
  }
  /** The one status summary of the workspace: every surface reads this, nothing else derives status. */
  function workspaceStatus(code: RuntimeGitCheckpoint | null): RuntimeWorkspaceStatus {
    const conflicts = code?.conflicts ?? [];
    const cloud = { version: code?.worktreeCommit ?? null, conflicts };
    const machines = attachments.list().filter(item => item.state !== 'detached').map(item => {
      const materialized = item.executionObservation?.materializedCommit ?? null;
      return {
        machineId: item.machineId, attachmentId: item.attachmentId, generation: item.generation,
        online: isAttachmentOnline(item), ready: isAttachmentReady(item),
        setup: item.cache?.setup ?? [],
        sync: { lastSyncAt: item.cache?.lastSyncAt ?? null, unsent: item.cache?.unsent ?? null, unapplied: code !== null && materialized !== null && materialized !== code.worktreeCommit, problem: item.cache?.syncProblem ?? item.failure?.message ?? null, conflicts },
      };
    });
    return { summary: workspaceStatusSummary(agents, { cloud, machines }), cloud, machines };
  }
  async function rebuild() {
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    await refreshConversations();
    await refreshTasks();
    const questions = await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT);
    // Working means a live task right now, never a flag an earlier rebuild stored; a blocked task cannot run.
    const views = [...conversationViews.values()];
    const activity = agentActivity({ conversations: views, tasks: inspection.tasks.flatMap(task => task.state.kind === 'blocked' ? [] : [{ conversationId: String(task.record.conversationId), background: task.record.background }]), questions: questions?.items ?? [] });
    agents = agentCounts(views, activity);
    const conversations: RuntimeSnapshot['conversations'] = [];
    const subagents: JsonValue[] = [];
    for (const { failure, subagent, ...view } of views) {
      const state = conversationStatus(activity.get(view.id) ?? 'idle');
      conversations.push({ ...view, status: state, ...(state === 'failed' && failure ? { error: failure } : {}) });
      if (subagent) subagents.push(subagent);
    }
    const tasks = [...taskViews].sort(([leftId, left], [rightId, right]) => TASK_ORDER[left.status] - TASK_ORDER[right.status] || leftId - rightId).map(([, task]) => task.view);
    const workspace = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT);
    const qa = RuntimeQaDocumentSchema.parse({ items: await options.qa.list() });
    const committedCode = await cloudFiles.snapshot();
    const status = workspaceStatus(committedCode ?? null);
    const next = RuntimeSnapshotSchema.parse({ version: 1, ...options.identity, cursor: snapshot.cursor + 1, conversations, tasks, attachments: attachments.list(), questions: questions?.items ?? [], documents: { 'gitspace.workspace': workspace ?? null, 'gitspace.agents': subagents, 'gitspace.qa': qa, 'gitspace.code': committedCode ?? null, 'gitspace.status': status, 'gitspace.draft': drafts.snapshot() } });
    const ops = diffRevisions(snapshot, next);
    // An unchanged projection publishes nothing: no replica rewrite, no cursor advance, no browser notice.
    if (ops.length === 0) { for (const notify of snapshotWaiters) notify(); return; }
    const event = RuntimeWatchEventSchema.parse({ type: 'delta', baseCursor: snapshot.cursor, cursor: next.cursor, ops });
    const encodedEvent = JSON.stringify(event);
    replica.commit(next.cursor, JSON.stringify(next), encodedEvent);
    options.published?.(next, status.summary);
    snapshot = next;
    for (const notify of snapshotWaiters) notify();
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
    for (const change of publication.changes) {
      if (change.type === 'entry') dirtyConversations.add(change.value.conversationId);
      else if (change.type === 'conversation') dirtyConversations.add(change.value.id);
      else if (change.type === 'task') dirtyTasks.set(Number(change.value.id), change.value);
      else if ((change.type === 'document' || change.type === 'document.copy') && change.conversationId !== undefined) dirtyConversations.add(change.conversationId);
    }
    publish();
  });
  await flushCloudRetention();
  await rebuild();
  async function conversation(id?: string) {
    if (id === undefined) return runtime.root;
    const canonical = conversationIds.get(id) ?? await history.conversation(id);
    const value = await harness.conversation(canonical, BACKGROUND_CONTEXT);
    if (!value) throw new Error('Runtime conversation no longer exists');
    return value;
  }
  return {
    harness, attachments, cloudFiles, codeSearch,
    invokeConversationTool,
    async browserConversation(conversationId) {
      const target = await conversation(conversationId);
      const record = await storage.conversation(target.id, BACKGROUND_CONTEXT);
      if (!record) throw new Error('Browser conversation no longer exists');
      return { id: record.id, root: record.id === runtime.root.id && record.owner === undefined };
    },
    async manage(input) {
      const fingerprint = JSON.stringify([input.tool, input.args]);
      const prior = options.storage.sql.exec<{ input: string; result: string | null }>('SELECT input,result FROM runtime_management WHERE request_id=?', input.requestId).toArray()[0];
      if (prior) {
        if (prior.input !== fingerprint) throw new Error('Management request identity changed');
        if (prior.result !== null) return RuntimeToolResultSchema.parse(JSON.parse(prior.result));
        return { requestId: input.requestId, attemptId: `management:${input.requestId}`, status: 'interrupted', content: [{ type: 'text', text: 'This request has an unresolved prior attempt; it was not relaunched.' }] };
      }
      options.storage.sql.exec('INSERT INTO runtime_management(request_id,input) VALUES(?,?)', input.requestId, fingerprint);
      const result = await options.tools.invoke({ tool: input.tool, args: input.args, conversationId: String(runtime.root.id), taskId: `management:${input.requestId}`, requestId: input.requestId, attemptId: `management:${input.requestId}`, replay: 'unsafe', signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS[input.tool]) });
      options.storage.sql.exec('UPDATE runtime_management SET result=? WHERE request_id=?', JSON.stringify(result), input.requestId);
      return result;
    },
    cronSubmit: input => runtime.lifecycle.runWhileActive(String(runtime.root.id), () => cron.submit(input)),
    requestStatus: cron.status,
    cronWithdraw: cron.withdraw,
    cronCancel: cron.cancel,
    cronNotifyOverdue: cron.notifyOverdue,
    async transcript(conversationId, format, range) {
      return transcriptResponse(storage, await conversation(conversationId), format, range);
    },
    async qa(input, actor) {
      if (!actor.canApprove) throw new Error('QA management requires human capability');
      const result = await options.qa.act(input, actor); publish(); await line;
      return { accepted: true, cursor: snapshot.cursor, ...result };
    },
    async snapshotCommit(raw) {
      const input = RuntimeSnapshotCommitInputSchema.parse(raw);
      const authorize = () => {
        const attachment = attachments.list().find(item => item.attachmentId === input.attachmentId && item.generation === input.generation && item.state !== 'detached');
        if (!attachment) throw new Error('Snapshot publication requires an authorized cache');
        if (attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId) throw new Error('Snapshot identity mismatch');
        return attachment;
      };
      const attachment = authorize();
      const checkpoint = await cloudFiles.commitMachine(input.checkpoint, input.previousWorktreeCommit, attachment.machineId, authorize);
      try { await cloudFiles.flushRetention(); }
      catch (error) { await options.schedule(Date.now() + 5_000); throw error; }
      await options.storage.sync();
      publish(); await line;
      return { accepted: true, cursor: snapshot.cursor, checkpoint };
    },
    lfsRoots: () => cloudFiles.lfsRoots(),
    reconcileLfsSources: objects => cloudFiles.reconcileLfsSources(objects),
    async session(conversationId, command, canApprove = false, deviceId) {
      const clearsDraft = deviceId !== undefined && command.type === 'prompt' && command.draftRevision !== undefined && (conversationId === undefined || conversationId === String(runtime.root.id));
      const wakesTasks = ['prompt', 'answerAsk', 'compact', 'promoteQueuedMessage', 'resume'].includes(command.type);
      const result = await controls.execute(conversationId, command, canApprove);
      if (wakesTasks) await options.schedule(Date.now() + 1000);
      if (clearsDraft && command.type === 'prompt' && command.draftRevision !== undefined) { await drafts.clear(command.draftRevision, deviceId, command.draftText); publish(); await line; }
      if (wakesTasks) { harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); }
      return result;
    },
    noticeWhenReady(input) {
      options.storage.sql.exec('INSERT OR IGNORE INTO runtime_attach_notices(attachment_id,generation,conversation_id,label) VALUES(?,?,?,?)', input.attachmentId, input.generation, input.conversationId, input.label);
    },
    async cacheReady(attachmentId, generation) {
      const attachment = attachments.list().find(item => item.attachmentId === attachmentId && item.generation === generation && item.state === 'ready');
      if (!attachment) return;
      const waiting = options.storage.sql.exec<{ conversation_id: string; label: string }>('SELECT conversation_id,label FROM runtime_attach_notices WHERE attachment_id=? AND generation=?', attachmentId, generation).toArray();
      options.storage.sql.exec('DELETE FROM runtime_attach_notices WHERE attachment_id=? AND generation=?', attachmentId, generation);
      for (const row of waiting) {
        try { await runtime.lifecycle.deliver({ conversationId: row.conversation_id, requestId: `machine-ready:${attachmentId}:${generation}`, kind: 'machine-ready', text: `Machine ${row.label} is attached and ready. Retry the calls that were waiting for it.` }); }
        catch (error) { options.onReport(error); }
      }
      if (!attachment.lfsRestored?.length) return;
      await harness.commit(async tx => {
        const seen = await tx.doc(CacheNoticesDoc);
        const key = `${attachmentId}:${generation}`;
        if (seen.seen[key]) return;
        const text = `LFS handoff to ${attachment.machineId}:\n${attachment.lfsRestored!.map(item => `${item.path}: ${item.outcome === 'committed' ? 'restored committed content' : 'omitted'}`).join('\n')}\nHeld-back local changes remain on the previous machine.`;
        await tx.appendEntry(runtime.root.id, { kind: 'gitspace.lfs-restored', model: [{ role: 'user', content: text, timestamp: Date.now() }] });
        seen.seen[key] = true;
      }, BACKGROUND_CONTEXT);
      publish(); await line;
    },
    async waitForSnapshot(commit) {
      await line;
      if ((await cloudFiles.snapshot())?.worktreeCommit !== commit) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timeout); snapshotWaiters.delete(changed); resolve(); };
        const changed = () => {
          const code = snapshot.documents['gitspace.code'];
          if (code && typeof code === 'object' && !Array.isArray(code) && code.worktreeCommit !== commit) finish();
        };
        const timeout = setTimeout(finish, 25_000);
        snapshotWaiters.add(changed);
        changed();
      });
    },
    async status() { return workspaceStatus(await cloudFiles.snapshot() ?? null); },
    async snapshot() { await line; return snapshot; },
    async saveDraft(input, deviceId) {
      const result = await drafts.save(input, deviceId);
      publish(); await line;
      return result;
    },
    async submit(input: RuntimeSubmitInput, deviceId) {
      const target = await conversation(input.conversationId);
      if ((await harness.snapshot(AgentDefinitionContextDoc, target.id, BACKGROUND_CONTEXT))?.child) throw new Error('User messages must target the workspace main conversation');
      await controls.loadDefinitions(target);
      await options.schedule(Date.now() + 1000);
      await runtime.lifecycle.userInput(String(target.id), async () => {
        const selection = (await harness.snapshot(SessionControlsDoc, target.id, BACKGROUND_CONTEXT))?.selection ?? { kind: 'default' as const };
        const admitted = await options.admitInference({ conversationId: String(target.id), requestId: input.requestId, selection });
        await runtime.configureModel(target.id, admitted);
        await target.submit({ type: 'input', content: input.text, requestId: input.requestId, whenBusy: 'followUp' }, BACKGROUND_CONTEXT);
      });
      if (deviceId !== undefined && input.draftRevision !== undefined && target.id === runtime.root.id) { await drafts.clear(input.draftRevision, deviceId, input.draftText); publish(); }
      options.waitUntil(target.waitForIdle(BACKGROUND_CONTEXT));
      await line;
      return { accepted: true as const, cursor: snapshot.cursor, conversationId: String(target.id) };
    },
    async cancel(input: RuntimeCancelInput) { await runtime.lifecycle.stop(String((await conversation(input.conversationId)).id)); await line; return { accepted: true as const, cursor: snapshot.cursor }; },
    async answer(input: RuntimeAnswerInput, actor: { deviceId: string; canApprove: boolean }) {
      await options.schedule(Date.now() + 1000);
      await harness.commit(async tx => {
        const questions = await tx.doc(QuestionsDoc);
        const question = questions.items.find(item => item.id === input.questionId);
        if (!question) throw new Error('Question not found');
        if (question.answer !== null) { if (JSON.stringify(question.answer) !== JSON.stringify(input.answer)) throw new Error('Question already answered'); return; }
        if (question.kind === 'approval' && !actor.canApprove) throw new Error('Human approval capability required');
        if (question.kind === 'approval' && typeof input.answer !== 'boolean') throw new Error('Approval answer must be a boolean');
        question.answer = input.answer;
        if (question.kind === 'approval') {
          const id = conversationIds.get(question.conversationId); if (id === undefined) throw new Error('Approval conversation missing');
          const plan = await tx.doc(PlanDoc, id);
          if (plan.questionId === input.questionId) {
            plan.status = input.answer === true ? 'approved' : 'rejected';
            if (plan.status === 'approved') {
              await options.setWorkspacePhase?.('code');
              const workspace = await tx.doc(WorkspaceDoc);
              workspace.phase = 'code';
            }
          }
        }
      }, BACKGROUND_CONTEXT);
      harness.resume();
      options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT));
      await line; return { accepted: true as const, cursor: snapshot.cursor };
    },
    async events(after: number | null): Promise<RuntimeWatchEvent[]> {
      await line;
      return replicaEvents(snapshot, after, replica.events);
    },
    async wake() {
      // Indexing runs beside recovery: a failing recovery step must not keep code_search from being built.
      const indexing = codeSearch.drive();
      try { await flushCloudRetention(); await runtime.lifecycle.recover(); harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); const inspection = await harness.inspect(BACKGROUND_CONTEXT); if (inspection.tasks.length > 0) await options.schedule(Date.now() + 1000); }
      finally { await indexing; }
    },
    publish,
  };
}
