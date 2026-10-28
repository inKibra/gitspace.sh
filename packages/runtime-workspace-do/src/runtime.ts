import { providerErrorText, WORKSPACE_REPORT_ENTRY, type WorkspaceTurnReport } from '@gitspace/blocks';
import { createWithdrawnNotices } from './withdrawn-notices.js';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { Conversation, ConversationId, ConversationRecord, Cursor, EntryRecord, Harness, TaskId, TaskRecord, EntryId, CommitPublication, SubmissionRecord } from '@earendil-works/pi-durable';
import { defineDoc, GenerationTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { diffRevisions } from '@earendil-works/chord/delta';
import { createRuntimeHarness, createConversationTools, AgentDefinitionContextDoc, SubagentRunQueueDoc, type SubagentMetadata, PlanDoc, ProcessExitsDoc, QuestionsDoc, WorkspaceDoc, recordMachineReconnection, recordProcessExit, type ToolServices, type RuntimeHarnessOptions } from '@gitspace/runtime-core';
import { RuntimeSnapshotSchema, RuntimeWatchEventSchema, RuntimeToolResultSchema, WORKSPACE_TOOL_RESULTS_MAX_BYTES, receiptDigest, type RuntimeToolResult, type RuntimeSnapshot, type RuntimeWatchEvent, type RuntimeSubmitInput, type RuntimeCancelInput, type RuntimeAnswerInput, type RuntimeGitCheckpoint, type RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import { DurableObjectSqliteDatabase } from './sqlite.js';
import { AttachmentStore, isAttachmentOnline, isAttachmentReady, type AttachmentServices } from './attachments.js';
import { applyInferenceThinking, createSessionControls, SessionControlsDoc, type SessionControlServices } from '@gitspace/runtime-core/session-controls';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeQaDocumentSchema, RuntimeSnapshotCommitInputSchema, type RuntimeBrowsersDocument, type RuntimeProcessExitedInput, type RuntimeQaActionInput, type RuntimeSnapshotCommitInput, type RuntimeSnapshotCommitResult } from '@gitspace/protocol-runtime';
import type { z } from 'zod';
import { createAutomationRequests, type RuntimeAutomationInput, type RuntimeRequestStatus } from '@gitspace/runtime-core';
import type { JsonValue } from '@earendil-works/chord';
import { createSessionHistory } from './session-history.js';
import { createReplicaStore, replicaEvents } from './replica-store.js';
import { WorkspaceDraftStore } from './draft.js';
import type { WorkspaceDraftSave, WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';
import { CloudFileStore } from './cloud-files.js';
import { CodeSearchIndex, type CodeSearchSource } from './cloud-search-index.js';
import { artifactsWorkspaceRepository, type ArtifactsCodeStore } from './artifacts.js';
import type { GitLfsConfirmedObject, GitLfsStore, WorkspaceReport, WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import type { RuntimeTranscriptRange } from '@gitspace/runtime-core/history';
import { transcriptResponse, type RuntimeTranscriptFormat, type WithdrawnNotices } from './transcript.js';
import { createRunningMarks, megabytes, messageCharacters, type RunningMarks, type RunningStep } from './running-marks.js';
import { createStoredRetry } from './stored-retry.js';
import { agentActivity, agentCounts, conversationStatus, workspaceStatusSummary } from './workspace-status.js';
import { createToolResultStore, type WorkspaceToolResults } from './tool-results.js';
export type WorkspaceRuntimeOptions = Omit<RuntimeHarnessOptions, 'storage' | 'unfinished' | 'tools'> & { /** The runtime keeps long tool output in its own storage. */ tools: Omit<RuntimeHarnessOptions['tools'], 'results'>; lfs: GitLfsStore; retainLfs(checkpoint: RuntimeSnapshotCommitInput['checkpoint'], publicationId?: string): Promise<void>; code: Pick<ArtifactsCodeStore, 'readFile' | 'writeSnapshot' | 'mergeSnapshot' | 'listSnapshotPaths' | 'changedSnapshotPaths'> & CodeSearchSource; initialCheckpoint?: () => Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>; /** Markdown for a document file (PDF, Office), or null for any other file. */ documentMarkdown?: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<string | null>; browser?: RuntimeBrowserService; storage: DurableObjectStorage; identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>; attachments: AttachmentServices; session: Pick<SessionControlServices, 'catalog' | 'reload'>; qa: { list(): Promise<z.infer<typeof RuntimeQaDocumentSchema>['items']>; act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> }; /** The workspace's Chrome groups, read from stored rows for `gitspace.browsers` (docs/APERTURE-DESIGN.md §4.2). */ browsers?: () => Promise<RuntimeBrowsersDocument>; waitUntil(promise: Promise<unknown>): void; schedule(timestamp: number): Promise<void>; /** Called synchronously with each changed snapshot and its status summary right after the storage write that publishes it. */ published?(snapshot: RuntimeSnapshot, report: WorkspaceReport): void ; /** The canonical snapshot changed; these attached machines do not hold it yet. */ snapshotChanged?(machineIds: string[]): void; /** A main-conversation input submitted with a request id started its turn (called at once, before the publication that shows it) or that turn ended (called once its reply is read). */ turnChanged?(requestId: string, turn: RuntimeTurn): void; /** A person's prompt (a call carrying their device) is about to enter a conversation. */ personPrompted?(): void };
/** The main conversation's turn for an input submitted with a request id. */
export type RuntimeTurn = { state: 'queued' } | { state: 'running' } | { state: 'ended'; outcome: 'finished' | 'failed'; text: string | null };
/** One message of a turn, its text cut short. */
export type RuntimeTurnItem = { role: 'user' | 'assistant' | 'tool'; text: string };
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
  /** Tool outputs longer than the transcript keeps, read as `result://` paths. */
  toolResults: WorkspaceToolResults;
  snapshot(): Promise<RuntimeSnapshot>;
  /** `tools` is a subagent's own tool list; null for the main conversation. */
  browserConversation(conversationId: string): Promise<{ id: ConversationId; root: boolean; tools: readonly string[] | null }>;
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
  cacheReady(attachmentId: string, generation: number): Promise<void>;
  /** A machine's report that one of the workspace's processes exited; its watch delivers the notice. */
  processExited(daemon: RuntimeProcessExitedInput['daemon']): Promise<void>;
  /** A machine of this workspace reconnected: each process watch checks its machine again, as a machine that restarted
   * lost the exit waits it held. */
  machineReconnected(): Promise<void>;
  /** A cloud write's publication outcome is unknown: a later wake finishes it, on a backoff that new uncertainty starts
   * over once retrying stopped. */
  publicationUncertain(error: unknown): Promise<void>;
  /** An agent asked for this attachment: once the machine reports it ready, the conversation is told so it can retry. */
  noticeWhenReady(input: { attachmentId: string; generation: number; conversationId: string; label: string }): void;
  /** A line in the main conversation about the workspace's machines, read by the agent on its next turn; it does not
   * start one. A `key` posts it at most once. */
  /** A line in the main conversation that does not start a turn; `source` labels it (default Machine). */
  notice(text: string, key?: string, source?: string): Promise<void>;
  /** The main-conversation turn of the input submitted with `requestId`; null when there is none. */
  turn(requestId: string): Promise<RuntimeTurn | null>;
  /** The newest `limit` messages of that turn, oldest first, each cut short. */
  turnItems(requestId: string, limit: number): Promise<RuntimeTurnItem[]>;
  /** Project base workspace: a workspace's report of a turn the project agent started. Quiet, a line the agent reads on
   * its next turn; wake, an event that starts one (after the current one when it is busy). */
  workspaceReport(report: WorkspaceTurnReport, onDone: 'quiet' | 'wake'): Promise<void>;
  /** You took a tab the agent was using, or handed one back (docs/APERTURE-DESIGN.md §7.2), or asked for a capture's
   * steps to be replayed (§11); a person commented on a page or replied in a comment thread (§9): an event for the
   * main conversation, which starts a turn when it is idle (after the current one when it is busy). */
  browserEvent(event: { kind: 'browser-taken' | 'browser-handback' | 'capture-replay' | 'page-comment'; requestId: string; sender: { id: string; name: string }; text: string; payload: JsonValue }): Promise<void>;
  invokeConversationTool: ToolServices['invoke'];
  /** A human request run once per request id as a tool call of the main conversation: MCP discovery, a sync action,
   * or an environment run dispatched to the cache machine its arguments name. */
  manage(input: { tool: ManagementTool; requestId: string; args: JsonValue }): Promise<RuntimeToolResult>;
  qa(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<RuntimeAccepted & { shareDraft?: string }>;
  snapshotCommit(input: RuntimeSnapshotCommitInput): Promise<RuntimeSnapshotCommitResult>;
  lfsRoots(): RuntimeSnapshotCommitInput['checkpoint'][];
  reconcileLfsSources(objects: readonly GitLfsConfirmedObject[]): Promise<void>;
  /** An automation run's instruction to the main conversation, submitted once per request id; its turn reports through `turnChanged`. */
  automationSubmit(input: RuntimeAutomationInput): Promise<{ conversationId: string }>;
  /** A person's cancel: withdraws the instruction, or stops the workspace agent once it has started. */
  automationCancel(requestId: string): Promise<RuntimeRequestStatus>;
  transcript(conversationId?: string, format?: RuntimeTranscriptFormat, range?: RuntimeTranscriptRange): Promise<Response>;
  publish(): void;
};
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type InputSubmission = Extract<SubmissionRecord, { type: 'input' }>;
type ModelMessage = NonNullable<EntryRecord['model']>[number];
/** A turn report's reply, failure or question. */
const REPORT_CHARACTERS = 280;
/** Each message `turnItems` returns. */
const TURN_ITEM_CHARACTERS = 400;
const REPORT_VERB: Record<WorkspaceTurnReport['outcome'], string> = { finished: 'finished', failed: 'failed', asked: 'asked', approval: 'needs approval' };
/** Why an unanswered input's turn ended, when pi recorded no detail. */
const UNANSWERED: Record<string, string> = { aborted: 'it was stopped before it finished', reset: 'its context was reset before it answered', no_model: 'no model was available' };
function textParts(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of content) if (part.type === 'text') texts.push(part.text);
  return texts.join('\n');
}
/** A message of a turn as `turnItems` shows it; none for the system prompt a model request recorded. */
function turnItem(message: ModelMessage): RuntimeTurnItem[] {
  const cut = (text: string) => text.length <= TURN_ITEM_CHARACTERS ? text : `${text.slice(0, TURN_ITEM_CHARACTERS)}…`;
  if (message.role === 'toolResult') return [{ role: 'tool', text: cut(`${message.toolName}: ${textParts(message.content)}`) }];
  if (message.role === 'user') return [{ role: 'user', text: cut(textParts(message.content)) }];
  if (message.role !== 'assistant') return [];
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text);
    else if (part.type === 'toolCall') parts.push(`[${part.name} ${JSON.stringify(part.arguments)}]`);
  }
  return [{ role: 'assistant', text: cut(parts.join('\n')) }];
}
// Retain the persisted document kind so acknowledged cache notices are not emitted again.
const CacheNoticesDoc = defineDoc<{ seen: Record<string, boolean> }>({ kind: 'gitspace.replica-notices', version: 1, scope: 'session', initial: () => ({ seen: {} }) });
/** One-time: a sync failure was announced on every retry while each error carried a fresh reference, about 250 notices
 * in a few hours per workspace, all in the agent's context. They are withdrawn from the chat and the model's context. */
async function withdrawSyncFailureNotices(storage: SqliteStorage, harness: Harness, root: Conversation, withdrawn: WithdrawnNotices, sql: SqlStorage): Promise<void> {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_one_time_steps(name TEXT PRIMARY KEY)');
  if (sql.exec("SELECT 1 FROM runtime_one_time_steps WHERE name='withdraw-sync-failure-notices'").toArray().length) return;
  const notices: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId: root.id }, 128, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      const message = entry.kind === 'gitspace.machine-notice' ? entry.model?.[0] : undefined;
      // Stored content is a string or text blocks, depending on the storage.
      const text = message?.role !== 'user' ? '' : typeof message.content === 'string' ? message.content : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      if (/^Sync with .+ failed: /u.test(text)) notices.push(entry);
    }
    cursor = page.next;
  } while (cursor);
  if (notices.length) {
    await harness.commit(tx => tx.appendEntry(root.id, { kind: 'gitspace.notices-withdrawn', edits: notices.map(entry => ({ target: entry.id, action: 'omit' })) }), BACKGROUND_CONTEXT);
    withdrawn.add(notices.map(entry => String(entry.id)));
  }
  sql.exec("INSERT INTO runtime_one_time_steps(name) VALUES('withdraw-sync-failure-notices')");
  console.info(JSON.stringify({ event: 'sync_failure_notices_withdrawn', conversationId: String(root.id), count: notices.length }));
}
/**
 * How long work in progress (a model request, a merge, a machine command) may go without an event to the object. Pending
 * fetches, RPCs and timers keep a Durable Object in memory for up to 15 minutes each; this alarm covers longer ones,
 * and is set only while such work runs, so an idle workspace holds no alarm and is not billed.
 */
const HEARTBEAT_MS = 30_000;
export async function createWorkspaceRuntime(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
  const heartbeat = () => { options.schedule(Date.now() + HEARTBEAT_MS).catch(options.onReport); };
  const marks = createRunningMarks(options.storage.sql, heartbeat);
  if (marks.leftover.length) console.error(JSON.stringify({ event: 'runtime_reset_during', workspaceId: options.identity.workspaceId, running: marks.leftover }));
  // Opening reads every conversation's newest entries, screenshots included: its mark names the stage it reached.
  const opening = marks.stage('runtime open', `opening storage; database ${megabytes(options.storage.sql.databaseSize)}`);
  try { return await openWorkspaceRuntime(options, marks, heartbeat, opening); }
  finally { opening.end(); }
}
async function openWorkspaceRuntime(options: WorkspaceRuntimeOptions, marks: RunningMarks, heartbeat: () => void, opening: RunningStep): Promise<WorkspaceRuntime> {
  const storage = await SqliteStorage.open(new DurableObjectSqliteDatabase(options.storage));
  opening.update('opening the harness');
  const toolResults = createToolResultStore(options.storage.sql, options.identity.workspaceId, WORKSPACE_TOOL_RESULTS_MAX_BYTES);
  const runtime = await createRuntimeHarness({ ...options, tools: { ...options.tools, results: toolResults }, storage, models: marks.models(options.models), unfinished: marks.unfinished });
  const { harness } = runtime;
  const withdrawn = createWithdrawnNotices(options.storage.sql);
  opening.update('withdrawing sync failure notices');
  await withdrawSyncFailureNotices(storage, harness, runtime.root, withdrawn, options.storage.sql);
  const attachments = new AttachmentStore(options.storage, { ...options.attachments, dispatch: input => { heartbeat(); return options.attachments.dispatch(input); } });
  // Sync merges and cloud writes build snapshots in memory: each is marked while it runs.
  const code: Pick<WorkspaceRuntimeOptions['code'], 'readFile' | 'writeSnapshot' | 'mergeSnapshot' | 'listSnapshotPaths' | 'changedSnapshotPaths'> = {
    readFile: (...args) => options.code.readFile(...args),
    writeSnapshot: input => marks.run('cloud write', `${input.mutations.length} files, ${input.mutations.reduce((sum, mutation) => sum + (mutation.content?.byteLength ?? 0), 0)} bytes`, () => options.code.writeSnapshot(input)),
    mergeSnapshot: input => {
      const kind = input.forcePublication ? 'first publication' : input.base.worktreeCommit === input.previous.worktreeCommit && input.base.headCommit === input.previous.headCommit && input.base.branch === input.previous.branch ? 'fast-forward' : 'three-way merge';
      return marks.run('sync merge', `${kind} of machine snapshot ${input.machine.worktreeCommit.slice(0, 12)}`, () => options.code.mergeSnapshot(input));
    },
    listSnapshotPaths: (repository, tree) => marks.run('path list', `tree ${tree.slice(0, 12)}`, () => options.code.listSnapshotPaths(repository, tree)),
    changedSnapshotPaths: (repository, before, after) => marks.run('path diff', `tree ${before.slice(0, 12)} to ${after.slice(0, 12)}`, () => options.code.changedSnapshotPaths(repository, before, after)),
  };
  // A failed LFS retention is tried again from 5 s, doubling to 30 minutes, for at most 10 tries (about 85 minutes); after
  // that only work that flushes the outbox anyway (a snapshot change, a cloud write, an open) tries again. Its outbox row
  // stays an LFS root meanwhile, keeping its objects retained.
  const retention = createStoredRetry(options.storage.sql, {
    table: 'runtime_lfs_retention_failures', event: 'lfs_retention_failed', workspaceId: options.identity.workspaceId, firstMs: 5_000, maxMs: 30 * 60_000, attempts: 10, schedule: options.schedule, report: options.onReport,
    stopped: (failures, message) => { options.onReport(new Error(`LFS retention stopped retrying after ${failures} failures: ${message}. The workspace's LFS objects stay retained; the next snapshot change tries again.`)); },
  });
  // A write whose publication outcome is unknown is finished by a later wake, from 1 s doubling to 5 minutes, for at most
  // 12 tries (about 20 minutes); the main conversation hears how it ended, or that retrying stopped.
  const publications = createStoredRetry(options.storage.sql, {
    table: 'runtime_publication_failures', event: 'cloud_publication_uncertain', workspaceId: options.identity.workspaceId, firstMs: 1_000, maxMs: 5 * 60_000, attempts: 12, schedule: options.schedule, report: options.onReport,
    stopped: (failures, message) => {
      const text = `Cloud writes awaiting recovery were not published after ${failures} tries: ${message}. Their changes may be missing from the working copy: read the files and write them again if so.`;
      options.onReport(new Error(text));
      options.waitUntil(notice(text).catch(options.onReport));
    },
  });
  const cloudFiles = new CloudFileStore(options.storage, attachments, code, options.identity.workspaceId, codeChanged, options.lfs, (checkpoint, publicationId) => retention.run(() => options.retainLfs(checkpoint, publicationId)), options.initialCheckpoint, options.documentMarkdown);
  const codeSearch = new CodeSearchIndex({
    storage: options.storage, source: options.code, repository: artifactsWorkspaceRepository(options.identity.workspaceId),
    snapshots: { current: () => cloudFiles.snapshot(), distance: (ancestor, descendant, limit) => cloudFiles.snapshotDistance(ancestor, descendant, limit) },
    schedule: options.schedule, report: options.onReport, mark: marks.stage,
  });
  /** Every canonical snapshot change republishes the projection, queues indexing for the next alarm and tells every
   * attached machine except the one whose publication made it. */
  function codeChanged(source?: string) {
    publish(); options.waitUntil(codeSearch.changed());
    options.waitUntil(cloudFiles.snapshot().then(async checkpoint => {
      if (!checkpoint?.conflicts?.length) return;
      await notice(`Sync conflict: ${checkpoint.conflicts.join(', ')} changed both here and on a machine. Resolve it with sync_machine (method resolve) before relying on these files.`, `conflicts:${checkpoint.worktreeCommit}`);
    }).catch(options.onReport));
    options.snapshotChanged?.(attachments.list().filter(item => item.state !== 'detached' && item.machineId !== source).map(item => item.machineId));
  }
  async function notice(text: string, key?: string, source = 'Machine') {
    await harness.commit(async tx => {
      if (key) {
        const seen = await tx.doc(CacheNoticesDoc);
        if (seen.seen[key]) return;
        seen.seen[key] = true;
      }
      await tx.appendEntry(runtime.root.id, { kind: 'gitspace.machine-notice', data: { source }, model: [{ role: 'user', content: text, timestamp: Date.now() }] });
    }, BACKGROUND_CONTEXT);
    publish(); await line;
  }
  /** Each failure carries a fresh provider reference, so reporting every retry filled the project's QA list (and with
   * it every workspace's snapshot) at the retry rate. A run of failures is reported once, when it starts. */
  const failureRun = () => {
    let failing = false;
    return { failed(error: unknown) { if (!failing) { failing = true; options.onReport(error); } }, succeeded() { failing = false; } };
  };
  const publishing = failureRun();
  /** Opening and waking flush the outbox. A failed retention has scheduled its own retry and reported itself; any other
   * failure (storage) is reported here. */
  async function flushCloudRetention() {
    try { await cloudFiles.flushRetention(); }
    catch (error) { if (!retention.handled(error)) options.onReport(error); }
  }
  /** Waking finishes writes whose publication outcome was unknown and tells the main conversation how each ended. */
  async function finishPublications() {
    if (!cloudFiles.hasPendingWrites() || publications.stopped()) return;
    try {
      for (const result of await publications.run(() => cloudFiles.finishPendingWrites())) {
        const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
        await notice(result.status === 'completed' ? `A write that was awaiting recovery is published: ${text}` : `A write that was awaiting recovery was not published: ${text}`);
      }
    } catch (error) { if (!publications.handled(error)) options.onReport(error); }
  }
  let definitionFiles: { commit: string; files: Array<{ path: string; content: string }> } | undefined;
  // Definitions live in two fixed directories. Reading just those trees keeps the first message of a large repository
  // from walking every directory of its snapshot (one tree read each) before it is admitted.
  const loadAgentDefinitions: NonNullable<SessionControlServices['loadAgentDefinitions']> = async () => {
    const checkpoint = await cloudFiles.initializeSnapshot();
    if (!checkpoint) return [];
    if (definitionFiles?.commit === checkpoint.worktreeCommit) return definitionFiles.files;
    const reader = options.code.reader(artifactsWorkspaceRepository(options.identity.workspaceId));
    try {
      const root = await reader.readTree(checkpoint.worktreeTree);
      if (!root) throw new Error(`Missing snapshot tree ${checkpoint.worktreeTree}`);
      const directory = async (parent: string, child: string) => {
        const outer = root.find(entry => entry.name === parent && entry.type === 'tree');
        const inner = outer ? (await reader.readTree(outer.hash))?.find(entry => entry.name === child && entry.type === 'tree') : undefined;
        return { path: `${parent}/${child}`, entries: inner ? await reader.readTree(inner.hash) ?? [] : [] };
      };
      const listed = await Promise.all([directory('.agents', 'agents'), directory('.omp', 'agents')]);
      const files = await Promise.all(listed.flatMap(({ path: directoryPath, entries }) => entries
        .filter(entry => (entry.type === 'blob' || entry.type === 'exec') && /^[A-Za-z0-9._-]+\.md$/u.test(entry.name))
        .map(async entry => {
          const path = `${directoryPath}/${entry.name}`;
          const blob = await reader.readBlob(entry.hash);
          if (!blob) throw new Error(`Committed agent definition is missing: ${path}`);
          if (blob.size > 262144) throw new Error(`Agent definition exceeds 256 KiB: ${path}`);
          return { path, content: await blob.text() };
        })));
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      definitionFiles = { commit: checkpoint.worktreeCommit, files };
      return files;
    } finally { await reader.close(); }
  };
  const history = createSessionHistory(options.storage, storage, withdrawn);
  const controls = createSessionControls({ ...runtime, ...options.session, setWorkspacePhase: options.setWorkspacePhase, loadAgentDefinitions, browser: options.browser, history, admitInference: options.admitInference });
  const invokeConversationTool = createConversationTools({ ...options, ...runtime, storage, catalog: options.session.catalog, refreshDefinitions: controls.loadDefinitions });
  const automations = createAutomationRequests({ ...options, harness, storage, configureModel: runtime.configureModel, stop: id => runtime.lifecycle.stop(id), async wake() { harness.resume(); options.waitUntil(harness.waitForIdle(BACKGROUND_CONTEXT)); } });
  const replica = createReplicaStore(options.storage);
  const drafts = new WorkspaceDraftStore({
    read: async () => { const value = replica.draft(); return value === undefined ? undefined : JSON.parse(value); },
    write: async value => { replica.commitDraft(value.revision, JSON.stringify(value)); },
  });
  await drafts.initialize();
  options.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_management(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT)');
  options.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attach_notices(attachment_id TEXT NOT NULL, generation INTEGER NOT NULL, conversation_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(attachment_id, generation, conversation_id))');
  let line = Promise.resolve();
  let publicationPending = false;
  // The snapshot is rebuilt from current state at startup (below), from an empty placeholder at the stored cursor so
  // watchers see a newer revision. The delta from that placeholder is not offered to readers: a reader at the stored
  // cursor holds the real snapshot, not the placeholder, so it receives a reset instead.
  let snapshot: RuntimeSnapshot = RuntimeSnapshotSchema.parse({ version: 1, ...options.identity, cursor: replica.cursor(), conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
  let placeholder = true;
  const conversationIds = new Map<string, ConversationId>();
  // Derived snapshot state is cached per conversation/task and refreshed only for records a commit touched, so a
  // rebuild reads O(changed) rows instead of every conversation's 256-entry window and every task on each commit.
  type ConversationView = Omit<RuntimeSnapshot['conversations'][number], 'status' | 'error'> & { failure: string | null; subagent: (SubagentMetadata & { conversationId: string }) | null };
  type TaskView = RuntimeSnapshot['tasks'][number];
  const conversationViews = new Map<string, ConversationView>();
  const dirtyConversations = new Set<ConversationId>();
  const taskViews = new Map<number, { status: StoredTask['state']['status']; view: TaskView }>();
  const dirtyTasks = new Map<number, StoredTask>();
  // Each conversation's newest generation and its error when it failed. A generation can fail with no assistant reply
  // (a step before or around the model request threw, as after a reset), which read as idle with no reason at all.
  const latestGenerations = new Map<string, { id: number; failure: string | null }>();
  function noteGeneration(task: StoredTask): void {
    if (task.kind !== GenerationTask.definition.name) return;
    const id = Number(task.id), conversationId = String(task.conversationId);
    if ((latestGenerations.get(conversationId)?.id ?? -1) > id) return;
    const outcome = task.state.status === 'terminal' ? task.state.outcome : null;
    // `faulted` is an uncaught throw in a step; `failed` one the generation committed itself (a model error).
    latestGenerations.set(conversationId, { id, failure: outcome?.status === 'failed' || outcome?.status === 'faulted' ? outcome.error.message : outcome?.status === 'orphaned' ? outcome.reason : null });
  }
  let conversationsLoaded = false;
  let tasksLoaded = false;
  // Agent counts of the last rebuild, read live from tasks and questions.
  let agents: WorkspaceStatusSummary['agents'] = { green: 0, blue: 0, orange: 0, red: 0 };
  const TASK_ORDER: Record<StoredTask['state']['status'], number> = { pending: 0, running: 1, waiting: 2, completing: 3, terminal: 4 };
  const TERMINAL_TASK_WINDOW = 128;
  async function conversationView(record: ConversationRecord, read?: { entries: number }): Promise<ConversationView | undefined> {
    const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (!conversation) return undefined;
    // Pi scans fork-aware entries newest-first; one bounded page includes inherited history.
    // Withdrawn notices take no place in the window: it pages back past them to the newest 256 visible entries.
    const newest: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) if (newest.length < 256 && !withdrawn.has(String(entry.id))) newest.push(entry);
      cursor = page.next;
    } while (cursor && newest.length < 256);
    const entries = newest.reverse();
    if (read) { const sizes = messageCharacters(entries.flatMap(entry => entry.model ?? [])); read.entries += sizes.characters + sizes.imageCharacters; }
    const parentId = record.parent?.conversationId ?? record.owner?.conversationId;
    const child = (await harness.snapshot(AgentDefinitionContextDoc, record.id, BACKGROUND_CONTEXT))?.child;
    // A rejected model request leaves an empty assistant message; its error is the user's only explanation.
    const latest = entries.flatMap(entry => entry.model ?? []).findLast(message => message.role === 'assistant');
    return {
      id: String(record.id), parentId: parentId === undefined ? null : String(parentId),
      title: child ? child.name : record.id === runtime.root.id ? 'Workspace' : `Agent ${record.id}`,
      failure: latest?.role === 'assistant' && latest.stopReason === 'error' ? providerErrorText(latest.errorMessage ?? 'The model request failed') : null,
      subagent: child ? { conversationId: String(record.id), ...child } : null,
      // The snapshot paints the conversation until its transcript page loads, which draws tool results from stored rows.
      // Carrying them here made a busy workspace's snapshot pass the 1 MB response limit, failing every watch.
      messages: entries.flatMap(entry => (entry.model ?? []).flatMap<RuntimeSnapshot['conversations'][number]['messages'][number]>((message, index) => message.role === 'toolResult' ? [] : [{ id: `${entry.id}:${index}`, role: message.role, content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }] : []), createdAt: new Date(message.timestamp).toISOString() }])),
    };
  }
  async function refreshConversations(): Promise<void> {
    if (!conversationsLoaded) {
      conversationViews.clear();
      // The first load, while the runtime opens, reads every conversation's newest entries whole: its mark counts them.
      const read = { conversations: 0, entries: 0, views: 0 };
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanConversations({}, 128, cursor, BACKGROUND_CONTEXT);
        for (const record of page.items) {
          conversationIds.set(String(record.id), record.id);
          opening.update(`rebuilding the snapshot: reading conversation ${String(record.id)} after ${read.conversations} (${megabytes(read.entries)} of entries read, ${megabytes(read.views)} of views)`);
          const view = await conversationView(record, read);
          read.conversations++;
          if (!view) continue;
          conversationViews.set(view.id, view);
          for (const message of view.messages) for (const part of message.content) if (part.type === 'text') read.views += part.text.length;
        }
        cursor = page.next;
      } while (cursor);
      conversationsLoaded = true;
      opening.update(`rebuilding the snapshot: reading tasks and building it from ${read.conversations} conversations (${megabytes(read.entries)} of entries read, ${megabytes(read.views)} of views)`);
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
          for (const task of page.items) { taskViews.set(Number(task.id), { status: task.state.status, view: taskView(task) }); noteGeneration(task); }
          taskCursor = status === 'terminal' ? undefined : page.next;
        } while (taskCursor);
      }
      tasksLoaded = true;
    }
    for (const [id, task] of dirtyTasks) { taskViews.set(id, { status: task.state.status, view: taskView(task) }); noteGeneration(task); }
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
    // The newest generation decides; the transcript's failed reply speaks only for a conversation whose generations
    // are past the loaded task window.
    const views = [...conversationViews.values()].map(view => {
      const generation = latestGenerations.get(view.id);
      return generation === undefined ? view : { ...view, failure: generation.failure === null ? null : providerErrorText(generation.failure) };
    });
    const activity = agentActivity({ conversations: views, tasks: inspection.tasks.flatMap(task => task.state.kind === 'blocked' ? [] : [{ conversationId: String(task.record.conversationId), background: task.record.background }]), questions: questions?.items ?? [] });
    agents = agentCounts(views, activity);
    const conversations: RuntimeSnapshot['conversations'] = [];
    const subagents: JsonValue[] = [];
    // A subagent waiting for a run slot is idle; the agents document says it is queued.
    const queued = new Set((await harness.snapshot(SubagentRunQueueDoc, BACKGROUND_CONTEXT))?.queue.map(item => item.conversationId));
    for (const { failure, subagent, ...view } of views) {
      const state = conversationStatus(activity.get(view.id) ?? 'idle');
      conversations.push({ ...view, status: state, ...(state === 'failed' && failure ? { error: failure } : {}) });
      if (subagent) subagents.push(queued.has(view.id) ? { ...subagent, queued: true } : subagent);
    }
    const tasks = [...taskViews].sort(([leftId, left], [rightId, right]) => TASK_ORDER[left.status] - TASK_ORDER[right.status] || leftId - rightId).map(([, task]) => task.view);
    const workspace = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT);
    const qa = RuntimeQaDocumentSchema.parse({ items: await options.qa.list() });
    const committedCode = await cloudFiles.snapshot();
    const status = workspaceStatus(committedCode ?? null);
    const next = RuntimeSnapshotSchema.parse({ version: 1, ...options.identity, cursor: snapshot.cursor + 1, conversations, tasks, attachments: attachments.list(), questions: questions?.items ?? [], documents: { 'gitspace.workspace': workspace ?? null, 'gitspace.agents': subagents, 'gitspace.qa': qa, 'gitspace.code': committedCode ?? null, 'gitspace.status': status, 'gitspace.draft': drafts.snapshot(), 'gitspace.browsers': options.browsers ? await options.browsers() : null } });
    const ops = diffRevisions(snapshot, next);
    // An unchanged projection publishes nothing: no replica rewrite, no cursor advance, no browser notice.
    if (ops.length === 0) return;
    const event = RuntimeWatchEventSchema.parse({ type: 'delta', baseCursor: snapshot.cursor, cursor: next.cursor, ops });
    replica.commit(next.cursor, placeholder ? null : JSON.stringify(event));
    placeholder = false;
    const rootId = String(runtime.root.id);
    const root = conversationViews.get(rootId);
    const [agent, controls] = await Promise.all([runtime.root.agent(BACKGROUND_CONTEXT), harness.snapshot(SessionControlsDoc, runtime.root.id, BACKGROUND_CONTEXT)]);
    // An ask_takeover card left open after its call stopped waiting no longer holds the agent.
    const waiting = (questions?.items ?? []).find(item => item.conversationId === rootId && item.answer === null && (item.kind !== 'takeover' || item.takeover?.waiting === true));
    const reply = root?.messages.findLast(message => message.role === 'assistant' && message.content.length > 0)?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? null;
    options.published?.(next, {
      summary: status.summary, phase: workspace?.phase ?? null,
      waitingOn: waiting ? { kind: waiting.kind === 'approval' ? 'approval' : 'ask', prompt: waiting.prompt.slice(0, 200) } : null,
      failure: root?.failure ?? null,
      lastReply: reply ? reply.slice(0, 280) : null,
      lastActivityAt: views.flatMap(view => view.messages.map(message => message.createdAt)).sort().at(-1) ?? null,
      model: agent.model ? { role: controls?.role ?? null, provider: agent.model.provider, id: agent.model.modelId } : null,
      code: committedCode ? { branch: committedCode.branch ?? null, headCommit: committedCode.headCommit ?? null, uncommitted: committedCode.worktreeCommit !== committedCode.headCommit } : null,
    });
    snapshot = next;
  }
  function publish() {
    // Keep at most one rebuild queued behind the active one. Commits during a rebuild
    // queue its successor; readers await a finite captured publication, not future work.
    if (publicationPending) return;
    publicationPending = true;
    const next = line.catch(error => { publishing.failed(error); }).then(async () => {
      publicationPending = false;
      await rebuild();
      publishing.succeeded();
    });
    line = next;
    options.waitUntil(next);
  }
  async function turnOf(record: InputSubmission): Promise<RuntimeTurn> {
    if (record.status === 'queued') return { state: 'queued' };
    if (record.status === 'placed') return { state: 'running' };
    if (record.status === 'done') {
      const answer = (await storage.entry(runtime.root.id, record.answer, BACKGROUND_CONTEXT))?.entry;
      const reply = (answer?.model ?? []).flatMap(message => message.role === 'assistant' ? [textParts(message.content)] : []).join('\n').trim();
      return { state: 'ended', outcome: 'finished', text: reply ? reply.slice(0, REPORT_CHARACTERS) : null };
    }
    const why = typeof record.detail === 'string' ? providerErrorText(record.detail) : UNANSWERED[record.reason] ?? record.reason;
    return { state: 'ended', outcome: 'failed', text: why.slice(0, REPORT_CHARACTERS) };
  }
  /** pi settles a run's inputs as the run ends, so a submission names exactly the turn it started. */
  function turnChanged(record: SubmissionRecord) {
    const report = options.turnChanged;
    if (!report || record.type !== 'input' || record.requestId === undefined || record.conversationId !== runtime.root.id) return;
    const requestId = record.requestId;
    if (record.status === 'placed') report(requestId, { state: 'running' });
    else if (record.status === 'done' || record.status === 'unanswered') options.waitUntil(turnOf(record).then(turn => report(requestId, turn)).catch(options.onReport));
  }
  harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      if (change.type === 'entry') dirtyConversations.add(change.value.conversationId);
      else if (change.type === 'conversation') dirtyConversations.add(change.value.id);
      else if (change.type === 'task') dirtyTasks.set(Number(change.value.id), change.value);
      else if ((change.type === 'document' || change.type === 'document.copy') && change.conversationId !== undefined) dirtyConversations.add(change.conversationId);
      else if (change.type === 'submission') turnChanged(change.value);
    }
    publish();
  });
  opening.update('flushing cloud retention');
  await flushCloudRetention();
  opening.update('rebuilding the snapshot');
  await rebuild();
  async function conversation(id?: string) {
    if (id === undefined) return runtime.root;
    const canonical = conversationIds.get(id) ?? await history.conversation(id);
    const value = await harness.conversation(canonical, BACKGROUND_CONTEXT);
    if (!value) throw new Error('Runtime conversation no longer exists');
    return value;
  }
  return {
    harness, attachments, cloudFiles, codeSearch, toolResults,
    invokeConversationTool,
    async browserConversation(conversationId) {
      const target = await conversation(conversationId);
      const record = await storage.conversation(target.id, BACKGROUND_CONTEXT);
      if (!record) throw new Error('Browser conversation no longer exists');
      const root = record.id === runtime.root.id && record.owner === undefined;
      return { id: record.id, root, tools: root ? null : (await harness.snapshot(AgentDefinitionContextDoc, record.id, BACKGROUND_CONTEXT))?.child?.tools ?? [] };
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
    automationSubmit: input => runtime.lifecycle.runWhileActive(String(runtime.root.id), () => automations.submit(input)),
    automationCancel: automations.cancel,
    async transcript(conversationId, format, range) {
      return transcriptResponse(storage, await conversation(conversationId), withdrawn, format, range);
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
      await cloudFiles.flushRetention();
      await options.storage.sync();
      publish(); await line;
      return { accepted: true, cursor: snapshot.cursor, checkpoint };
    },
    lfsRoots: () => cloudFiles.lfsRoots(),
    reconcileLfsSources: objects => cloudFiles.reconcileLfsSources(objects),
    async session(conversationId, command, canApprove = false, deviceId) {
      if (deviceId !== undefined && command.type === 'prompt') options.personPrompted?.();
      const clearsDraft = deviceId !== undefined && command.type === 'prompt' && command.draftRevision !== undefined && (conversationId === undefined || conversationId === String(runtime.root.id));
      const wakesTasks = ['prompt', 'answerAsk', 'compact', 'promoteQueuedMessage', 'resume'].includes(command.type);
      const result = await controls.execute(conversationId, command, canApprove, deviceId);
      if (clearsDraft && command.type === 'prompt' && command.draftRevision !== undefined) { await drafts.clear(command.draftRevision, deviceId, command.draftText); publish(); await line; }
      if (wakesTasks) harness.resume();
      return result;
    },
    notice,
    async turn(requestId) {
      const record = await storage.submissionByRequest(runtime.root.id, requestId, BACKGROUND_CONTEXT);
      return record?.type === 'input' ? turnOf(record) : null;
    },
    async turnItems(requestId, limit) {
      const record = await storage.submissionByRequest(runtime.root.id, requestId, BACKGROUND_CONTEXT);
      if (record?.type !== 'input' || record.entry === undefined) return [];
      // The turn runs from its placed input to its answer; entries after the answer belong to later turns.
      // Twice the entries: the system prompts requests recorded show nothing.
      const page = await runtime.root.entries({ minEntryId: record.entry, ...(record.status === 'done' ? { maxEntryId: record.answer } : {}) }, limit * 2, undefined, BACKGROUND_CONTEXT);
      return page.items.filter(entry => !withdrawn.has(String(entry.id))).reverse().flatMap(entry => (entry.model ?? []).flatMap(turnItem)).slice(-limit);
    },
    async workspaceReport(report, onDone) {
      const text = `Workspace ${report.name} ${REPORT_VERB[report.outcome]}${report.excerpt ? `: ${report.excerpt}` : '.'}`;
      const event = { requestId: `workspace:${report.workspaceId}:${report.requestId}`, sender: { id: report.workspaceId, name: report.name }, text, payload: report };
      if (onDone === 'wake') await runtime.lifecycle.deliver({ ...event, conversationId: String(runtime.root.id), kind: 'workspace' });
      else await harness.commit(tx => tx.appendEntry(runtime.root.id, { kind: WORKSPACE_REPORT_ENTRY, data: event, model: [{ role: 'user', content: text, timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
      publish(); await line;
    },
    noticeWhenReady(input) {
      options.storage.sql.exec('INSERT OR IGNORE INTO runtime_attach_notices(attachment_id,generation,conversation_id,label) VALUES(?,?,?,?)', input.attachmentId, input.generation, input.conversationId, input.label);
    },
    async browserEvent(event) {
      await runtime.lifecycle.deliver({ ...event, conversationId: String(runtime.root.id) });
      publish(); await line;
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
    async processExited(daemon) {
      await harness.commit(async tx => { recordProcessExit(await tx.doc(ProcessExitsDoc), daemon, Date.now()); }, BACKGROUND_CONTEXT);
      harness.resume();
    },
    async publicationUncertain(error) {
      if (publications.stopped()) publications.clear();
      await publications.failed(error);
    },
    async machineReconnected() {
      await harness.commit(async tx => { recordMachineReconnection(await tx.doc(ProcessExitsDoc)); }, BACKGROUND_CONTEXT);
      harness.resume();
    },
    async status() { return workspaceStatus(await cloudFiles.snapshot() ?? null); },
    async snapshot() { await line; return snapshot; },
    async saveDraft(input, deviceId) {
      const result = await drafts.save(input, deviceId);
      publish(); await line;
      return result;
    },
    async submit(input: RuntimeSubmitInput, deviceId) {
      if (deviceId !== undefined) options.personPrompted?.();
      const target = await conversation(input.conversationId);
      if ((await harness.snapshot(AgentDefinitionContextDoc, target.id, BACKGROUND_CONTEXT))?.child) throw new Error('User messages must target the workspace main conversation');
      await controls.loadDefinitions(target);
      await runtime.lifecycle.userInput(String(target.id), async () => {
        const selection = (await harness.snapshot(SessionControlsDoc, target.id, BACKGROUND_CONTEXT))?.selection ?? { kind: 'default' as const };
        const admitted = await options.admitInference({ conversationId: String(target.id), requestId: input.requestId, selection });
        await runtime.configureModel(target.id, admitted);
        await applyInferenceThinking(target, admitted);
        await target.submit({ type: 'input', content: input.text, requestId: input.requestId, whenBusy: 'followUp' }, BACKGROUND_CONTEXT);
      });
      if (deviceId !== undefined && input.draftRevision !== undefined && target.id === runtime.root.id) { await drafts.clear(input.draftRevision, deviceId, input.draftText); publish(); }
      await line;
      return { accepted: true as const, cursor: snapshot.cursor, conversationId: String(target.id) };
    },
    async cancel(input: RuntimeCancelInput) { await runtime.lifecycle.stop(String((await conversation(input.conversationId)).id)); await line; return { accepted: true as const, cursor: snapshot.cursor }; },
    async answer(input: RuntimeAnswerInput, actor: { deviceId: string; canApprove: boolean }) {
      await harness.commit(async tx => {
        const questions = await tx.doc(QuestionsDoc);
        const question = questions.items.find(item => item.id === input.questionId);
        if (!question) throw new Error('Question not found');
        if (question.answer !== null) { if (JSON.stringify(question.answer) !== JSON.stringify(input.answer)) throw new Error('Question already answered'); return; }
        if (question.kind === 'takeover') throw new Error('A take-over request is answered on its card: Not now, or Take over and then Resume agent');
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
      await line; return { accepted: true as const, cursor: snapshot.cursor };
    },
    async events(after: number | null): Promise<RuntimeWatchEvent[]> {
      await line;
      return replicaEvents(snapshot, after, replica.events);
    },
    async wake() {
      // Indexing runs beside recovery: a failing recovery step must not keep code_search from being built.
      const indexing = codeSearch.drive();
      // Tasks keep the object in memory only through their own pending I/O and timers; an alarm is re-armed only while
      // marked work or a machine command is still running (a step outliving those 15 minutes).
      try {
        await flushCloudRetention();
        await finishPublications();
        // Recovery reads every conversation's lifecycle document, the events delivered to it included. Pi stores a
        // document's kind JSON-encoded.
        const sizes = options.storage.sql.exec<{ conversations: number; lifecycle: number }>(`SELECT (SELECT COUNT(*) FROM conversations) AS conversations, (SELECT COALESCE(SUM(length(r.content)), 0) FROM documents d JOIN document_revisions r ON r.document_id=d.id WHERE d.kind='"gitspace.conversation-lifecycle"' AND d.retired_at IS NULL) AS lifecycle`).one();
        const recovering = marks.stage('conversation recovery', `${sizes.conversations} conversations, lifecycle documents ${megabytes(sizes.lifecycle)}`);
        try { await runtime.lifecycle.recover(); } finally { recovering.end(); }
        harness.resume();
        if (marks.active() || attachments.dispatching()) heartbeat();
      }
      finally { await indexing; }
    },
    publish,
  };
}
