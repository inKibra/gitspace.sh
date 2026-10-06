import { InboxDoc, UsageDoc, defineDoc, defineExtension, type ToolExecutionApi, type Harness, type Conversation, type ConversationId, type ModelRef, type EntryRecord, type EntryId, type Cursor } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context, JsonValue } from '@earendil-works/chord';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AgentDefinitionSchema, SessionControlSchema, ModelSelectionIntentSchema, type RuntimeSessionCommand, type RuntimeSessionResult, type SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { QuestionsDoc, TodosDoc, WorkspaceDoc } from './documents.js';
import { boundSessionControl, type SessionHistoryPage, type SessionHistoryPageRequest } from '@gitspace/protocol-agent';
import type { RuntimeHarnessOptions } from './harness.js';
import type { TranscriptPageRequest, TranscriptPage, TranscriptContentRequest, TranscriptContentPage } from '@gitspace/blocks';
import type { SessionUsageReport } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeBrowserStatusSchema, RuntimeBrowserArtifactPageSchema, type RuntimeBrowserApprovalCard, type RuntimeBrowserManagement, type RuntimeBrowserStatus, type RuntimeBrowserArtifactPage } from '@gitspace/protocol-runtime';
import { isSubagentReadonlyTool, isSubagentToolCallAllowed, runtimeOperationIsReadOnly } from '@gitspace/protocol-runtime';
import type { ConversationLifecycle } from './conversation-lifecycle.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { cronHasOutstanding } from './cron.js';

const ThinkingSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ControlsSchema = z.object({ revision: z.number(), settingsRevision: z.number(), instructionsRevision: z.number(), inferenceRevision: z.number(), selection: ModelSelectionIntentSchema, role: z.string().nullable(), fastMode: z.boolean(), approvalMode: SessionControlSchema.shape.approvalMode, goal: SessionControlSchema.shape.goal, definitions: z.array(AgentDefinitionSchema) });
export const SessionControlsDoc = defineDoc<z.infer<typeof ControlsSchema>>({ kind: 'gitspace.session-controls', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ revision: 0, settingsRevision: 0, instructionsRevision: 0, inferenceRevision: 0, selection: { kind: 'default' }, role: null, fastMode: false, approvalMode: 'write', goal: null, definitions: [] }) });
export const SessionSelectionDoc = defineDoc<{ conversationId: string | null }>({ kind: 'gitspace.session-selection', version: 1, scope: 'session', initial: () => ({ conversationId: null }) });
const GoalClockDoc = defineDoc<{ startedAt: number | null; elapsedSeconds: number; tokensAtStart: number }>({ kind: 'gitspace.goal-clock', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ startedAt: null, elapsedSeconds: 0, tokensAtStart: 0 }) });
const DefinitionMetadataSchema = z.object({ name: z.string().min(1).optional(), description: z.string().default(''), model: z.union([z.string(), z.array(z.string())]).optional(), thinking: ThinkingSchema.nullable().optional(), tools: z.union([z.string(), z.array(z.string())]).optional(), spawns: z.union([z.string(), z.array(z.string())]).optional() });
export function parseCloudAgentDefinition(path: string, content: string) {
  if (!/^(?:\.omp|\.agents)\/agents\/[A-Za-z0-9._-]+\.md$/u.test(path)) throw new Error('Agent definitions must be workspace .agents/agents/*.md files');
  if (new TextEncoder().encode(content).byteLength > 262144) throw new Error('Agent definition exceeds 256 KiB');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const metadata = DefinitionMetadataSchema.parse(match ? parseYaml(match[1]!) : {});
  const list = (value: string | string[] | undefined) => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : value ?? [];
  const tools = list(metadata.tools);
  const disallowed = tools.filter(tool => !isSubagentReadonlyTool(tool));
  if (disallowed.length) throw new Error(`Agent definition requests disallowed non-read-only tools: ${disallowed.join(', ')}`);
  return { name: metadata.name ?? path.split('/').at(-1)!.replace(/\.md$/u, ''), description: metadata.description, modelSelectors: list(metadata.model), thinking: metadata.thinking ?? null, tools, toolsSpecified: metadata.tools !== undefined, spawns: metadata.spawns === undefined ? null : list(metadata.spawns).join(','), instructions: content.slice(match?.[0].length ?? 0).trim() };
}
export const sessionControlsExtension = defineExtension({ name: 'gitspace.session-controls', sections: [{ key: 'session-controls', async render(input, context) {
  const controls = await input.read.snapshot(SessionControlsDoc, input.conversationId, context);
  if (!controls) return '';
  return [controls.goal?.status === 'active' ? `Active goal: ${controls.goal.objective}` : '', ...controls.definitions.map(definition => `Available agent ${definition.name}: ${definition.description}; model ${definition.modelSelectors.join(', ') || 'workspace default (independent of parent)'}; tools ${definition.tools.join(', ') || 'fixed read-only defaults'}. Invoke agents spawn with agent: "${definition.name}" and task; name is a separate optional address. This child uses only its saved instructions and retained repository rules.`)].filter(Boolean).join('\n\n');
} }] });
export async function committedSessionApproval(harness: Harness, conversationId: string, taskId: string) {
  const questions = await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT);
  return questions?.items.find(item => item.id === `approval:${taskId}` && item.conversationId === conversationId);
}
export async function enforceSessionApproval(api: ToolExecutionApi, context: Context, tool: string, args: JsonValue, browser?: RuntimeBrowserApprovalCard): Promise<boolean> {
  const controls = await api.snapshot(SessionControlsDoc, api.conversationId, context);
  if (tool === 'browser' && !browser) throw new Error('Browser preflight required');
  if ((await api.snapshot(AgentDefinitionContextDoc, api.conversationId, context))?.child) return isSubagentToolCallAllowed(tool, args);
  if (browser && !browser.requiresApproval) return true;
  const autoApprove = controls?.approvalMode === 'yolo';
  if (autoApprove) return true;
  const readOnly = runtimeOperationIsReadOnly(tool, args);
  if (readOnly && (tool === 'bash' || tool === 'proc' || (controls?.approvalMode ?? 'write') === 'write')) return true;
  const id = `approval:${api.taskId}`;
  await api.commit(async tx => { const questions = await tx.doc(QuestionsDoc); if (!questions.items.some(item => item.id === id)) questions.items.push({ id, conversationId: String(api.conversationId), kind: 'approval', prompt: browser ? `Create browser group "${browser.groupName}" with access to ${browser.origins.join(', ')}?` : `Allow ${tool}?\n${JSON.stringify(args)}`, choices: ['Approve', 'Reject'], answer: null, ...(browser ? { browser } : {}) }); }, context);
  const watch = await api.watchDoc(QuestionsDoc, context);
  if (!watch) throw new Error('Approval document missing');
  const answer = watch.value?.items.find(item => item.id === id)?.answer;
  if (answer !== null && answer !== undefined) { await watch.stop(); return answer === true; }
  try {
    return await new Promise<boolean>((resolve, reject) => {
      watch.start(async value => { const answer = value?.items.find(item => item.id === id)?.answer; if (answer !== null && answer !== undefined) resolve(answer === true); });
      void watch.closed.then(result => { if (result.reason !== 'stopped') reject(new Error(`Approval wait ended: ${result.reason}`)); });
    });
  } finally { await watch.stop(); }
}

export interface SessionHistoryService {
  conversation(id: string): Promise<ConversationId>;
  recent(target: ConversationId): Promise<{ anchorId: string | null; prompts: { entryId: string; text: string }[]; tokens: number | null }>;
  page(target: ConversationId, request: SessionHistoryPageRequest): Promise<SessionHistoryPage>;
  resolve(target: ConversationId, entryId: string): Promise<{ conversationId: ConversationId; entryId: EntryId }>;
  transcriptPage(target: ConversationId, request: TranscriptPageRequest): Promise<TranscriptPage>;
  transcriptContent(target: ConversationId, request: TranscriptContentRequest): Promise<TranscriptContentPage>;
  usage(target: ConversationId, harness: Harness): Promise<SessionUsageReport>;
}
export type SessionControlServices = Pick<RuntimeHarnessOptions, 'admitInference'> & {
  harness: Harness;
  root: Conversation;
  history: SessionHistoryService;
  lifecycle: ConversationLifecycle;
  configureModel(id: ConversationId, model: ModelRef): Promise<void>;
  catalog(): Promise<{ models: SessionControlView['models']; roles: SessionControlView['roles']; inference?: SessionControlView['inference'] }>;
  reload(kind: 'settings' | 'instructions' | 'inference'): Promise<void>;
  browser?(conversationId: string, machineId: string | undefined, command: RuntimeBrowserManagement): Promise<RuntimeBrowserStatus | RuntimeBrowserArtifactPage>;
};
export function createSessionControls(services: SessionControlServices) {
  const { harness } = services;
  const ctx = BACKGROUND_CONTEXT;
  async function conversation(id?: string) {
    if (!id) id = (await harness.snapshot(SessionSelectionDoc, ctx))?.conversationId ?? String(services.root.id);
    if (id === String(services.root.id)) return services.root;
    const value = await harness.conversation(await services.history.conversation(id), ctx);
    if (!value) throw new Error('Conversation not found');
    return value;
  }
  async function entries(target: Conversation) { const values: EntryRecord[] = []; let cursor: Cursor | undefined; do { const page = await target.entries({}, 100, cursor, ctx); values.push(...page.items); cursor = page.next; } while (cursor); return values; }
  async function control(target: Conversation): Promise<SessionControlView> {
    await target.commit(async tx => { await tx.doc(SessionControlsDoc, target.id); }, ctx);
    const [state, agent, inbox, usage, todos, questions, history, catalog, workspace] = await Promise.all([harness.snapshot(SessionControlsDoc, target.id, ctx), target.agent(ctx), harness.snapshot(InboxDoc, target.id, ctx), harness.snapshot(UsageDoc, target.id, ctx), harness.snapshot(TodosDoc, target.id, ctx), harness.snapshot(QuestionsDoc, ctx), services.history.recent(target.id), services.catalog(), harness.snapshot(WorkspaceDoc, ctx)]);
    if (!state) throw new Error('Session controls missing');
    const child = (await harness.snapshot(AgentDefinitionContextDoc, target.id, ctx))?.child;
    const buckets = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
    const cost = buckets.reduce((sum, value) => sum + value.cost.total, 0);
    const pending = questions?.items.find(item => item.kind === 'ask' && item.conversationId === String(target.id) && item.answer === null);
    const queueText = (mode: 'steer' | 'followUp') => (inbox?.items ?? []).flatMap(item => item.mode === mode ? [typeof item.content === 'string' ? item.content : item.content.filter(part => part.type === 'text').map(part => part.text).join('\n')] : []);
    const currentModel = catalog.models.find(model => model.provider === agent.model?.provider && model.id === agent.model?.modelId);
    const tokens = history.tokens;
    const context = tokens !== null && currentModel?.contextWindow ? { tokens, contextWindow: currentModel.contextWindow, percent: tokens / currentModel.contextWindow * 100 } : null;
    const clock = await harness.snapshot(GoalClockDoc, target.id, ctx);
    const goal = state.goal ? { ...state.goal, tokensUsed: Math.max(0, buckets.reduce((sum, value) => sum + value.totalTokens, 0) - (clock?.tokensAtStart ?? 0)), timeUsedSeconds: (clock?.elapsedSeconds ?? 0) + (clock?.startedAt === null || clock?.startedAt === undefined ? 0 : Math.max(0, (Date.now() - clock.startedAt) / 1000)) } : null;
    return { sessionId: String(target.id), ...(catalog.inference ? { inference: catalog.inference } : {}), role: child?.role ?? state.role, roleLabel: child ? child.role : catalog.roles.find(role => role.id === state.role)?.label ?? null, roles: catalog.roles.map(role => ({ ...role, current: role.id === state.role })), provider: child?.model?.provider ?? agent.model?.provider ?? null, models: catalog.models, model: child?.model?.modelId ?? agent.model?.modelId ?? null, thinking: child ? child.thinking : agent.thinkingLevel, fastMode: state.fastMode, planMode: !child && workspace?.phase === 'plan', approvalMode: state.approvalMode, context, cost, todos: todos ? [{ name: 'Workspace', tasks: todos.items.map(item => ({ content: item.text, status: item.status === 'active' ? 'in_progress' : item.status, blocker: null })) }] : [], queue: { steering: queueText('steer'), followUp: queueText('followUp') }, historyAnchorId: history.anchorId, history: boundSessionControl({ history: history.prompts }).history, goal, pendingAsk: pending ? { id: pending.id, source: 'ask-tool', links: [], questions: [{ id: pending.id, question: pending.prompt, header: null, options: pending.choices.map(label => ({ label, description: null, preview: null })), multi: false, recommended: null }] } : null };
  }
  async function execute(id: string | undefined, command: RuntimeSessionCommand, canApprove = false): Promise<RuntimeSessionResult> {
    let target = await conversation(id);
    const child = (await harness.snapshot(AgentDefinitionContextDoc, target.id, ctx))?.child;
    if (child && !['control', 'agentSetup', 'historyAnchorId', 'messages', 'historyPage', 'transcriptPage', 'transcriptContent', 'usage'].includes(command.type)) {
      throw new Error('Subagent session controls are read-only; target the workspace root for mutations');
    }
    await target.commit(async tx => { await tx.doc(SessionControlsDoc, target.id); }, ctx);
    const mutate = (apply: (draft: z.infer<typeof ControlsSchema>) => void) => target.commit(async tx => { const draft = await tx.doc(SessionControlsDoc, target.id); apply(draft); draft.revision++; }, ctx);
    switch (command.type) {
      case 'browserStatus': case 'browserRevoke': case 'browserReconcile': case 'browserDiscard': case 'browserArtifact': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        const action = { browserStatus: 'status', browserRevoke: 'revoke', browserReconcile: 'reconcile', browserDiscard: 'discard', browserArtifact: 'artifact' }[command.type] as RuntimeBrowserManagement['action'];
        const { type: _type, machineId, ...fields } = command;
        const result = await services.browser(String(target.id), machineId, { action, ...fields });
        return { control: await control(target), ...(command.type === 'browserArtifact' ? { browserArtifact: RuntimeBrowserArtifactPageSchema.parse(result) } : { browserStatus: RuntimeBrowserStatusSchema.parse(result) }) };
      }
      case 'prompt': {
        await services.lifecycle.userInput(String(target.id), async () => {
          const requestId = crypto.randomUUID();
          const selection = child?.model ? { kind: 'explicit' as const, ...child.model } : (await harness.snapshot(SessionControlsDoc, target.id, ctx))?.selection ?? { kind: 'default' as const };
          const model = await services.admitInference({ conversationId: String(target.id), requestId, selection });
          await services.configureModel(target.id, model);
          const cronOutstanding = await target.commit(tx => cronHasOutstanding(tx, target.id), ctx);
          await target.submit({ type: 'input', requestId, content: command.images?.length ? [{ type: 'text', text: command.text }, ...command.images] : command.text, whenBusy: cronOutstanding ? 'followUp' : command.streamingBehavior ?? 'followUp' }, ctx);
        });
        break;
      }
      case 'setModel': { const catalog = await services.catalog(); if (!catalog.models.some(model => model.provider === command.provider && model.id === command.model)) throw new Error('Model is not admitted by the inference profile'); await services.configureModel(target.id, { provider: command.provider, modelId: command.model }); await mutate(draft => { draft.role = null; draft.selection = { kind: 'explicit', provider: command.provider, modelId: command.model }; }); break; }
      case 'setThinking': await target.configure({ thinkingLevel: command.thinking === null ? null : ThinkingSchema.parse(command.thinking) }, ctx); break;
      case 'cycleRole': { const catalog = await services.catalog(); if (!catalog.roles.length) throw new Error('No configured inference roles'); const state = await harness.snapshot(SessionControlsDoc, target.id, ctx); const index = catalog.roles.findIndex(role => role.id === state?.role); const next = index < 0 ? command.direction === 'forward' ? 0 : catalog.roles.length - 1 : (index + (command.direction === 'forward' ? 1 : catalog.roles.length - 1)) % catalog.roles.length; const role = catalog.roles[next]!; await services.configureModel(target.id, { provider: role.provider, modelId: role.model }); await target.configure({ thinkingLevel: role.thinking === null ? null : ThinkingSchema.parse(role.thinking) }, ctx); await mutate(draft => { draft.role = role.id; draft.selection = role.id === 'default' ? { kind: 'default' } : { kind: 'role', role: role.id }; }); break; }
      case 'setFast': await mutate(draft => { draft.fastMode = command.enabled; }); break;
      case 'setApproval': {
        if (!canApprove) throw new Error('Human approval authority required');
        await mutate(draft => { draft.approvalMode = command.approvalMode; }); break;
      }
      case 'setWorkspacePhase': await harness.commit(async tx => { const workspace = await tx.doc(WorkspaceDoc); workspace.phase = command.phase; }, ctx); break;
      case 'setGoal': await target.commit(async tx => {
        const draft = await tx.doc(SessionControlsDoc, target.id);
        const clock = await tx.doc(GoalClockDoc, target.id);
        const usage = await tx.doc(UsageDoc, target.id);
        const now = Date.now();
        if (command.enabled) {
          const objective = command.objective?.trim() || draft.goal?.objective;
          if (!objective) throw new Error('A goal objective is required');
          if (!draft.goal || objective !== draft.goal.objective) {
            clock.elapsedSeconds = 0;
            clock.tokensAtStart = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, value) => sum + value.totalTokens, 0);
            draft.goal = { id: crypto.randomUUID(), status: 'active', objective, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
          } else draft.goal.status = 'active';
          clock.startedAt ??= now;
        } else if (draft.goal) {
          draft.goal.status = 'paused';
          if (clock.startedAt !== null) clock.elapsedSeconds += Math.max(0, (now - clock.startedAt) / 1000);
          clock.startedAt = null;
        }
        draft.revision++;
      }, ctx); break;
      case 'compact': await target.compact(command.instructions, ctx); break;
      case 'clearQueue': await target.commit(async tx => {
        const inbox = await tx.doc(InboxDoc, target.id);
        for (const item of inbox.items) if (item.mode !== 'write') tx.settleSubmission(item.id, { status: 'unanswered', reason: 'withdrawn' });
        inbox.items = inbox.items.filter(item => item.mode === 'write');
      }, ctx); break;
      case 'removeQueuedMessage': {
        const { kind, index } = command;
        await target.commit(async tx => {
          const inbox = await tx.doc(InboxDoc, target.id);
          const selected = inbox.items.filter(item => item.mode === (kind === 'steering' ? 'steer' : 'followUp'))[index];
          if (!selected) throw new Error('Queued message not found');
          tx.settleSubmission(selected.id, { status: 'unanswered', reason: 'withdrawn' });
          inbox.items.splice(inbox.items.findIndex(item => item.id === selected.id), 1);
        }, ctx);
        break;
      }
      case 'promoteQueuedMessage': {
        const { index } = command;
        await services.lifecycle.runWhileActive(String(target.id), () => target.commit(async tx => {
          if (await cronHasOutstanding(tx, target.id)) throw new Error('Cannot steer a queued user message into an isolated cron generation');
          const inbox = await tx.doc(InboxDoc, target.id);
          const selected = inbox.items.filter(item => item.mode === 'followUp')[index];
          if (!selected || selected.mode !== 'followUp') throw new Error('Queued message not found');
          selected.mode = 'steer';
        }, ctx));
        break;
      }
      case 'answerAsk': await harness.commit(async tx => {
        const questions = await tx.doc(QuestionsDoc);
        const question = questions.items.find(item => item.id === command.id && item.conversationId === String(target.id));
        if (!question || question.answer !== null) throw new Error('Pending question not found');
        if (question.kind !== 'ask') throw new Error('Approval requests require an explicit runtime approval answer');
        if (!command.answers.length) throw new Error('Question answer is required');
        question.answer = command.answers.map(answer => ({ id: answer.id, selectedOptions: [...answer.selectedOptions], customInput: answer.customInput }));
      }, ctx); break;
      case 'stop': await services.lifecycle.stop(String(target.id)); break;
      case 'navigateTree': {
        await target.abort(ctx);
        const resolved = await services.history.resolve(target.id, command.entryId);
        const source = await harness.conversation(resolved.conversationId, ctx);
        if (!source) throw new Error('History conversation not found');
        target = await source.fork(resolved.entryId, { ownership: { kind: 'ownerless' } }, ctx);
        await harness.commit(async tx => { const selection = await tx.doc(SessionSelectionDoc); selection.conversationId = String(target.id); }, ctx);
        break;
      }
      case 'saveAgentDefinition': {
        const parsed = parseCloudAgentDefinition(command.path, command.content);
        const catalog = await services.catalog();
        const selector = parsed.modelSelectors[0];
        const role = selector?.startsWith('pi/') ? catalog.roles.find(value => value.id === selector.slice(3)) : undefined;
        const model = role ? catalog.models.find(value => value.provider === role.provider && value.id === role.model) : selector ? catalog.models.find(value => `${value.provider}/${value.id}` === selector || value.id === selector) : undefined;
        if (selector && !model) throw new Error('Agent model selector is not admitted by the inference profile');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(command.content));
        const revision = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
        await mutate(draft => {
          const previous = draft.definitions.find(definition => definition.path === command.path);
          if ((previous?.revision ?? null) !== command.expectedRevision) throw new Error('Agent definition revision conflict');
          const definition = { name: parsed.name, description: parsed.description, source: 'cloud', path: command.path, editable: true, content: command.content, revision, modelSelectors: parsed.modelSelectors, role: role?.id ?? null, provider: model?.provider ?? null, model: model?.id ?? null, thinking: parsed.thinking ?? role?.thinking ?? null, selection: selector ? 'definition' as const : 'settings' as const, tools: parsed.tools, spawns: parsed.spawns };
          if (previous) draft.definitions.splice(draft.definitions.indexOf(previous), 1, definition); else draft.definitions.push(definition);
        });
        break;
      }
      case 'reloadSettings': case 'instructionsChanged': case 'inferenceChanged': { const kind = command.type === 'reloadSettings' ? 'settings' : command.type === 'instructionsChanged' ? 'instructions' : 'inference'; await services.reload(kind); await mutate(draft => { if (kind === 'settings') draft.settingsRevision++; else if (kind === 'instructions') draft.instructionsRevision++; else draft.inferenceRevision++; }); break; }
      case 'resume': harness.resume(); break;
      case 'persist': case 'handoff': await mutate(draft => { draft.revision++; }); break;
      case 'control': case 'agentSetup': case 'historyAnchorId': case 'messages': case 'historyPage': case 'transcriptPage': case 'transcriptContent': case 'usage': break;
    }
    const result: RuntimeSessionResult = { control: await control(target) };
    if (command.type === 'agentSetup' || command.type === 'saveAgentDefinition') result.setup = { sessionId: String(target.id), agents: child ? child.definition ? [{ ...child.definition, editable: false }] : [] : (await harness.snapshot(SessionControlsDoc, target.id, ctx))?.definitions ?? [] };
    if (command.type === 'messages') result.messages = (await entries(target)).reverse().flatMap(entry => entry.model ?? []);
    if (command.type === 'historyPage') result.historyPage = await services.history.page(target.id, command.request);
    if (command.type === 'transcriptPage') result.transcriptPage = await services.history.transcriptPage(target.id, command.request);
    if (command.type === 'transcriptContent') result.transcriptContent = await services.history.transcriptContent(target.id, command.request);
    if (command.type === 'usage') result.usage = await services.history.usage(target.id, harness);
    return result;
  }
  return { execute, control, conversation };
}
