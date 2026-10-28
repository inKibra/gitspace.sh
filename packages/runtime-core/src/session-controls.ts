import { AgentDoc, InboxDoc, UsageDoc, defineDoc, defineExtension, type Harness, type Conversation, type ConversationId, type ModelRef, type EntryId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AgentDefinitionSchema, SessionControlSchema, ModelSelectionIntentSchema, type AgentSetupView, type RuntimeSessionCommand, type RuntimeSessionResult, type SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { QuestionsDoc, TodosDoc, WorkspaceDoc } from './documents.js';
import { boundSessionControl, type SessionHistoryPage, type SessionHistoryPageRequest } from '@gitspace/protocol-agent';
import type { InferenceModelAdmission, RuntimeHarnessOptions } from './harness.js';
import type { TranscriptPageRequest, TranscriptPage, TranscriptContentRequest, TranscriptContentPage } from '@gitspace/blocks';
import type { SessionUsageReport } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeBrowserStatusSchema, RuntimeBrowserArtifactPageSchema, RuntimeBrowserOverviewSchema, RuntimeBrowserPreviewSchema, RuntimeBrowserCaptureViewSchema, RuntimeBrowserShareSchema, RuntimeBrowserConnectedTabSchema, type RuntimeBrowserManagement, type RuntimeBrowserStatus, type RuntimeBrowserArtifactPage, type RuntimeBrowserOverview, type RuntimeBrowserPreview, type RuntimeBrowserCaptureView, type RuntimeBrowserShare, type RuntimeBrowserConnectedTab } from '@gitspace/protocol-runtime';
import { RuntimeBrowserCommentThreadSchema, RuntimeBrowserCommentThreadViewSchema, type RuntimeBrowserCommentThread, type RuntimeBrowserCommentThreadView, type RuntimeBrowserCommentWrite } from '@gitspace/protocol-runtime';
import { isSubagentTool, TAKEOVER_ANSWERS, TAKEOVER_CHOICES } from '@gitspace/protocol-runtime';
import { RuntimeBrowserCaptureShareSchema, type RuntimeBrowserCaptureShare } from '@gitspace/protocol-runtime';
import { BUILT_IN_AGENT_DEFINITIONS } from './builtin-agents.js';
import type { ConversationLifecycle } from './conversation-lifecycle.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { modelRoleThinkingSchema, parseModelRoleSelector } from '@gitspace/protocol/inference';

const ThinkingSchema = modelRoleThinkingSchema.unwrap();
const ThinkingSelectionSchema = z.discriminatedUnion('source', [z.object({ source: z.literal('profile') }), z.object({ source: z.literal('conversation'), thinking: modelRoleThinkingSchema })]);
const ControlsSchema = z.object({ revision: z.number(), settingsRevision: z.number(), instructionsRevision: z.number(), inferenceRevision: z.number(), selection: ModelSelectionIntentSchema, role: z.string().nullable(), thinkingSelection: ThinkingSelectionSchema.optional(), fastMode: z.boolean(), goal: SessionControlSchema.shape.goal, definitions: z.array(AgentDefinitionSchema), definitionErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional() });
export const SessionControlsDoc = defineDoc<z.infer<typeof ControlsSchema>>({ kind: 'gitspace.session-controls', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ revision: 0, settingsRevision: 0, instructionsRevision: 0, inferenceRevision: 0, selection: { kind: 'default' }, role: null, thinkingSelection: { source: 'profile' }, fastMode: false, goal: null, definitions: [] }) });
/** An explicit session effort (including auto/null) wins until the user selects another role. */
export async function applyInferenceThinking(target: Conversation, admission: InferenceModelAdmission): Promise<void> {
  const thinking = await target.commit(async tx => {
    const controls = await tx.doc(SessionControlsDoc, target.id);
    if (!controls.thinkingSelection) {
      // Older conversations stored explicit effort only on AgentDoc.
      const thinking = (await tx.doc(AgentDoc, target.id)).thinkingLevel;
      controls.thinkingSelection = thinking === undefined ? { source: 'profile' } : { source: 'conversation', thinking };
    }
    return controls.thinkingSelection.source === 'conversation' ? controls.thinkingSelection.thinking : admission.thinking;
  }, BACKGROUND_CONTEXT);
  await target.configure({ thinkingLevel: thinking ?? null }, BACKGROUND_CONTEXT);
}
/** The conversation's role, as cycling roles or an automation starting its workspace chooses it: the profile's role
 * gives the model and effort of every admission after it. */
export function selectRole(controls: z.infer<typeof ControlsSchema>, role: string): void {
  controls.role = role;
  controls.selection = role === 'default' ? { kind: 'default' } : { kind: 'role', role };
  controls.thinkingSelection = { source: 'profile' };
}
export const SessionSelectionDoc = defineDoc<{ conversationId: string | null }>({ kind: 'gitspace.session-selection', version: 1, scope: 'session', initial: () => ({ conversationId: null }) });
const GoalClockDoc = defineDoc<{ startedAt: number | null; elapsedSeconds: number; tokensAtStart: number }>({ kind: 'gitspace.goal-clock', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ startedAt: null, elapsedSeconds: 0, tokensAtStart: 0 }) });
const DefinitionMetadataSchema = z.object({ name: z.string().min(1).optional(), description: z.string().default(''), model: z.union([z.string(), z.array(z.string())]).optional(), thinking: ThinkingSchema.nullable().optional(), tools: z.union([z.string(), z.array(z.string())]).optional(), spawns: z.union([z.string(), z.array(z.string())]).optional() });
export function parseCloudAgentDefinition(path: string, content: string) {
  if (!/^(?:\.omp|\.agents|gitspace)\/agents\/[A-Za-z0-9._-]+\.md$/u.test(path)) throw new Error('Agent definitions must be workspace .agents/agents/*.md or .omp/agents/*.md files');
  if (new TextEncoder().encode(content).byteLength > 262144) throw new Error('Agent definition exceeds 256 KiB');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const metadata = DefinitionMetadataSchema.parse(match ? parseYaml(match[1]!) : {});
  const list = (value: string | string[] | undefined) => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : value ?? [];
  const tools = list(metadata.tools);
  const disallowed = tools.filter(tool => !isSubagentTool(tool));
  if (disallowed.length) throw new Error(`Agent definition requests tools subagents cannot use: ${disallowed.join(', ')}`);
  return { name: metadata.name ?? path.split('/').at(-1)!.replace(/\.md$/u, ''), description: metadata.description, modelSelectors: list(metadata.model), thinking: metadata.thinking ?? null, tools, toolsSpecified: metadata.tools !== undefined, spawns: metadata.spawns === undefined ? null : list(metadata.spawns).join(','), instructions: content.slice(match?.[0].length ?? 0).trim() };
}

/** Role names when every model selector is a `pi/role` or `@role` alias; undefined for explicit models or none. */
export function definitionRoleChain(selectors: readonly string[]): string[] | undefined {
  const roles = selectors.map(value => { const { selector } = parseModelRoleSelector(value); return selector.startsWith('pi/') ? selector.slice(3) : selector.startsWith('@') ? selector.slice(1) : undefined; });
  return roles.length && roles.every((role): role is string => role !== undefined) ? roles : undefined;
}

export function resolveAgentDefinitions(definitions: readonly z.infer<typeof AgentDefinitionSchema>[]) {
  // Workspace and cloud definitions replace a shipped one of the same name.
  const ordered = [...definitions].sort((left, right) =>
    Number(left.source === 'builtin') - Number(right.source === 'builtin')
    || Number(right.path.startsWith('.agents/agents/')) - Number(left.path.startsWith('.agents/agents/'))
    || Number(right.source === 'cloud') - Number(left.source === 'cloud')
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const winners = new Map<string, z.infer<typeof AgentDefinitionSchema>>();
  const diagnostics: NonNullable<AgentSetupView['diagnostics']> = [];
  for (const definition of ordered) {
    const winner = winners.get(definition.name);
    if (winner) diagnostics.push({ name: definition.name, winnerPath: winner.path, ignoredPath: definition.path });
    else winners.set(definition.name, definition);
  }
  return { agents: [...winners.values()], diagnostics };
}
export const sessionControlsExtension = defineExtension({ name: 'gitspace.session-controls', sections: [{ key: 'session-controls', async render(input, context) {
  const controls = await input.read.snapshot(SessionControlsDoc, input.conversationId, context);
  if (!controls) return '';
  return [controls.goal?.status === 'active' ? `Active goal: ${controls.goal.objective}` : '', ...(controls.definitionErrors ?? []).map(error => `Unavailable agent definition ${error.path}: ${error.message}`), ...resolveAgentDefinitions(controls.definitions).agents.map(definition => `Available agent ${definition.name}: ${definition.description}; model ${definition.modelSelectors.join(', ') || 'role default'}; tools ${definition.tools.join(', ') || 'read-only defaults'}. Invoke agents spawn with agent: "${definition.name}" and task, plus role (a model role id such as default, deep or fast) to choose its model role; name is a separate optional address. This child uses only its saved instructions and retained repository rules.`)].filter(Boolean).join('\n\n');
} }] });
export interface SessionHistoryService {
  conversation(id: string): Promise<ConversationId>;
  recent(target: ConversationId): Promise<{ anchorId: string | null; prompts: { entryId: string; text: string }[]; tokens: number | null }>;
  page(target: ConversationId, request: SessionHistoryPageRequest): Promise<SessionHistoryPage>;
  resolve(target: ConversationId, entryId: string): Promise<{ conversationId: ConversationId; entryId: EntryId }>;
  transcriptPage(target: ConversationId, request: TranscriptPageRequest): Promise<TranscriptPage>;
  transcriptContent(target: ConversationId, request: TranscriptContentRequest): Promise<TranscriptContentPage>;
  usage(target: ConversationId, harness: Harness): Promise<SessionUsageReport>;
}
/** A passive snapshot; an unavailable profile has no displayed default to adopt. */
export type SessionCatalog = { models: SessionControlView['models']; roles: SessionControlView['roles']; inference?: SessionControlView['inference'] };
export type SessionControlServices = Pick<RuntimeHarnessOptions, 'admitInference' | 'setWorkspacePhase'> & {
  harness: Harness;
  root: Conversation;
  history: SessionHistoryService;
  lifecycle: ConversationLifecycle;
  configureModel(id: ConversationId, model: ModelRef): Promise<void>;
  catalog(): Promise<SessionCatalog>;
  reload(kind: 'settings' | 'instructions' | 'inference'): Promise<void>;
  loadAgentDefinitions?(): Promise<Array<{ path: string; content: string }>>;
  /** Answers each management command with what it returns; `stop`, `closeTab` and `focusTab` return nothing (null);
   * `tabGroup` the group's id. */
  browser?(conversationId: string, machineId: string | undefined, command: RuntimeBrowserManagement): Promise<RuntimeBrowserStatus | RuntimeBrowserArtifactPage | RuntimeBrowserOverview | RuntimeBrowserPreview | RuntimeBrowserCaptureView | RuntimeBrowserCaptureView[] | RuntimeBrowserShare | RuntimeBrowserShare[] | RuntimeBrowserConnectedTab | RuntimeBrowserCommentThreadView[] | RuntimeBrowserCommentThread | RuntimeBrowserCaptureShare | RuntimeBrowserCaptureShare[] | string | null>;
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
  async function definition(path: string, content: string, source: 'workspace' | 'cloud' | 'builtin', catalog: SessionCatalog, previous?: z.infer<typeof AgentDefinitionSchema>): Promise<z.infer<typeof AgentDefinitionSchema>> {
    const parsed = parseCloudAgentDefinition(path, content);
    const revision = previous?.content === content ? previous.revision : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), value => value.toString(16).padStart(2, '0')).join('');
    const chain = definitionRoleChain(parsed.modelSelectors);
    // A role chain resolves at spawn against the profile, so an unset role is not an error; show the first one set here.
    if (chain) {
      const shown = chain.map(role => catalog.roles.find(value => value.id === role)).find(value => value !== undefined);
      return { name: parsed.name, description: parsed.description, source, path, editable: source !== 'builtin', content, revision, modelSelectors: parsed.modelSelectors, role: chain[0]!, provider: shown?.provider ?? null, model: shown?.model ?? null, thinking: parsed.thinking ?? null, selection: 'definition', tools: parsed.tools, spawns: parsed.spawns };
    }
    const selections = parsed.modelSelectors.map(value => {
      const { selector, thinking } = parseModelRoleSelector(value);
      const alias = selector.startsWith('pi/') ? selector.slice(3) : selector.startsWith('@') ? selector.slice(1) : undefined;
      const role = alias === undefined ? undefined : catalog.roles.find(value => value.id === alias);
      const model = role ? catalog.models.find(value => value.provider === role.provider && value.id === role.model) : alias === undefined ? catalog.models.find(value => `${value.provider}/${value.id}` === selector || value.id === selector) : undefined;
      return { role, model, thinking };
    });
    const selected = selections.find(value => value.model !== undefined);
    if (parsed.modelSelectors.length && !selected) throw new Error(`Agent model selector for ${path} is not admitted by the inference profile`);
    return { name: parsed.name, description: parsed.description, source, path, editable: source !== 'builtin', content, revision, modelSelectors: parsed.modelSelectors, role: selected?.role?.id ?? null, provider: selected?.model?.provider ?? null, model: selected?.model?.id ?? null, thinking: parsed.thinking ?? selected?.thinking ?? selected?.role?.thinking ?? null, selection: parsed.modelSelectors.length ? 'definition' : 'settings', tools: parsed.tools, spawns: parsed.spawns };
  }
  async function loadDefinitions(target: Conversation) {
    if ((await harness.snapshot(AgentDefinitionContextDoc, target.id, ctx))?.child) return;
    const [workspaceFiles, catalog, state] = await Promise.all([services.loadAgentDefinitions?.() ?? [], services.catalog(), harness.snapshot(SessionControlsDoc, target.id, ctx)]);
    const files = [...BUILT_IN_AGENT_DEFINITIONS.map(file => ({ ...file, source: 'builtin' as const })), ...workspaceFiles.map(file => ({ ...file, source: 'workspace' as const }))];
    const previous = state?.definitions ?? [];
    const results = await Promise.allSettled(files.map(file => definition(file.path, file.content, file.source, catalog, previous.find(item => item.path === file.path))));
    await target.commit(async tx => {
      const draft = await tx.doc(SessionControlsDoc, target.id);
      const overrides = draft.definitions.filter(item => item.source === 'cloud');
      const paths = new Set(overrides.map(item => item.path));
      const loaded: z.infer<typeof AgentDefinitionSchema>[] = [];
      const definitionErrors: NonNullable<AgentSetupView['definitionErrors']> = [];
      for (let index = 0; index < results.length; index++) {
        const path = files[index]!.path;
        if (paths.has(path)) continue;
        const result = results[index]!;
        if (result.status === 'fulfilled') loaded.push(result.value);
        else definitionErrors.push({ path, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
      const merged = [...loaded, ...overrides];
      if (JSON.stringify(draft.definitions) !== JSON.stringify(merged) || JSON.stringify(draft.definitionErrors ?? []) !== JSON.stringify(definitionErrors)) {
        draft.definitions = merged;
        draft.definitionErrors = definitionErrors;
        draft.revision++;
      }
    }, ctx);
  }
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
    // A main conversation has no model before its first message is admitted, and its agent still carries the harness's
    // default effort: show the role its selection resolves to, with that role's effort or the one chosen here.
    const intendedRole = state.selection.kind === 'role' ? state.selection.role : state.selection.kind === 'default' ? 'default' : null;
    const intended = child || agent.model ? undefined : catalog.roles.find(role => role.id === (state.role ?? intendedRole));
    const tokens = history.tokens;
    const context = tokens !== null && currentModel?.contextWindow ? { tokens, contextWindow: currentModel.contextWindow, percent: tokens / currentModel.contextWindow * 100 } : null;
    const clock = await harness.snapshot(GoalClockDoc, target.id, ctx);
    const goal = state.goal ? { ...state.goal, tokensUsed: Math.max(0, buckets.reduce((sum, value) => sum + value.totalTokens, 0) - (clock?.tokensAtStart ?? 0)), timeUsedSeconds: (clock?.elapsedSeconds ?? 0) + (clock?.startedAt === null || clock?.startedAt === undefined ? 0 : Math.max(0, (Date.now() - clock.startedAt) / 1000)) } : null;
    return { sessionId: String(target.id), ...(catalog.inference ? { inference: catalog.inference } : {}), role: child?.role ?? state.role ?? intended?.id ?? null, roleLabel: child ? child.role : catalog.roles.find(role => role.id === (state.role ?? intended?.id))?.label ?? null, roles: catalog.roles.map(role => ({ ...role, current: role.id === state.role })), provider: child?.model?.provider ?? agent.model?.provider ?? intended?.provider ?? null, models: catalog.models, model: child?.model?.modelId ?? agent.model?.modelId ?? intended?.model ?? null, thinking: child ? child.thinking : intended ? (state.thinkingSelection?.source === 'conversation' ? state.thinkingSelection.thinking : intended.thinking) ?? null : agent.thinkingLevel, fastMode: state.fastMode, planMode: !child && workspace?.phase === 'plan', context, cost, todos: todos ? [{ name: 'Workspace', tasks: todos.items.map(item => ({ content: item.text, status: item.status === 'active' ? 'in_progress' : item.status, blocker: null })) }] : [], queue: { steering: queueText('steer'), followUp: queueText('followUp') }, historyAnchorId: history.anchorId, history: boundSessionControl({ history: history.prompts }).history, goal, pendingAsk: pending ? { id: pending.id, source: 'ask-tool', links: [], questions: [{ id: pending.id, question: pending.prompt, header: null, options: pending.choices.map(label => ({ label, description: null, preview: null })), multi: false, recommended: null }] } : null };
  }
  /** `deviceId`: the signed-in device that sent the command, when a person sent it; Take over records it as the tab's holder. */
  async function execute(id: string | undefined, command: RuntimeSessionCommand, canApprove = false, deviceId?: string): Promise<RuntimeSessionResult> {
    let target = await conversation(id);
    const child = (await harness.snapshot(AgentDefinitionContextDoc, target.id, ctx))?.child;
    if (child && !['control', 'agentSetup', 'historyAnchorId', 'historyPage', 'transcriptPage', 'transcriptContent', 'usage', 'stop'].includes(command.type)) {
      throw new Error('Subagents accept inspection and scoped Stop only; target the workspace main conversation for user messages and mutations');
    }
    if (!child && ['agentSetup', 'saveAgentDefinition', 'prompt', 'reloadSettings', 'instructionsChanged', 'inferenceChanged'].includes(command.type)) await loadDefinitions(target);
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
      case 'browserOverview': case 'browserPreview': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        if (command.type === 'browserOverview') return { control: await control(target), browserOverview: RuntimeBrowserOverviewSchema.parse(await services.browser(String(target.id), undefined, { action: 'overview' })) };
        return { control: await control(target), browserPreview: RuntimeBrowserPreviewSchema.parse(await services.browser(String(target.id), undefined, { action: 'preview', groupId: command.groupId, targetId: command.targetId })) };
      }
      // Captures (docs/APERTURE-DESIGN.md §11): the workspace's list, and recording a tab's screencast, which you start
      // and stop from the Browser tab.
      case 'browserCaptures': case 'browserCaptureStart': case 'browserCaptureStop': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        if (command.type === 'browserCaptures') return { control: await control(target), browserCaptures: RuntimeBrowserCaptureViewSchema.array().parse(await services.browser(String(target.id), undefined, { action: 'captures' })) };
        const management: RuntimeBrowserManagement = command.type === 'browserCaptureStart' ? { action: 'captureStart', groupId: command.groupId, targetId: command.targetId } : { action: 'captureStop', captureId: command.captureId };
        return { control: await control(target), browserCapture: RuntimeBrowserCaptureViewSchema.parse(await services.browser(String(target.id), undefined, management)) };
      }
      // Capture share links (docs/APERTURE-DESIGN.md §11): the workspace's capture shares, sharing a saved capture, ending one.
      case 'browserCaptureShares': case 'browserCaptureShareCreate': case 'browserCaptureShareRevoke': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        if (command.type === 'browserCaptureShares') return { control: await control(target), browserCaptureShares: RuntimeBrowserCaptureShareSchema.array().parse(await services.browser(String(target.id), undefined, { action: 'captureShares' })) };
        const management: RuntimeBrowserManagement = command.type === 'browserCaptureShareCreate' ? { action: 'captureShareCreate', captureId: command.captureId, comment: command.comment, expiresInMinutes: command.expiresInMinutes } : { action: 'captureShareRevoke', captureShareId: command.captureShareId };
        return { control: await control(target), browserCaptureShare: RuntimeBrowserCaptureShareSchema.parse(await services.browser(String(target.id), undefined, management)) };
      }
      // Share links (docs/APERTURE-DESIGN.md §8): the workspace's shares, sharing a tab of its Chrome group, ending a
      // share, connecting the tab of a share link you pasted.
      case 'browserShares': case 'browserShareCreate': case 'browserShareRevoke': case 'browserShareConnect': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        const id = String(target.id);
        if (command.type === 'browserShares') return { control: await control(target), browserShares: RuntimeBrowserShareSchema.array().parse(await services.browser(id, undefined, { action: 'shares' })) };
        if (command.type === 'browserShareConnect') return { control: await control(target), browserConnectedTab: RuntimeBrowserConnectedTabSchema.parse(await services.browser(id, undefined, { action: 'shareConnect', shareId: command.shareId, secret: command.secret })) };
        const management: RuntimeBrowserManagement = command.type === 'browserShareCreate' ? { action: 'shareCreate', groupId: command.groupId, targetId: command.targetId, comment: command.comment, expiresInMinutes: command.expiresInMinutes } : { action: 'shareRevoke', shareId: command.shareId };
        return { control: await control(target), browserShare: RuntimeBrowserShareSchema.parse(await services.browser(id, undefined, management)) };
      }
      // Comments (docs/APERTURE-DESIGN.md §9), as you: the workspace's threads, a reply, resolving or reopening one, and
      // a new thread from the capture player.
      case 'browserComments': case 'browserCommentReply': case 'browserCommentResolve': case 'browserCommentAdd': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        const id = String(target.id);
        if (command.type === 'browserComments') return { control: await control(target), browserComments: RuntimeBrowserCommentThreadViewSchema.array().parse(await services.browser(id, undefined, { action: 'comments', ...(command.status ? { status: command.status } : {}), ...(command.captureId ? { captureId: command.captureId } : {}), ...(command.limit ? { limit: command.limit } : {}) })) };
        const write: RuntimeBrowserCommentWrite = command.type === 'browserCommentReply' ? { op: 'reply', threadId: command.threadId, text: command.text }
          : command.type === 'browserCommentResolve' ? { op: 'resolve', threadId: command.threadId, ...(command.reopen === undefined ? {} : { reopen: command.reopen }) }
            : { op: 'comment', source: command.source, page: command.page, anchor: command.anchor, text: command.text };
        return { control: await control(target), browserComment: RuntimeBrowserCommentThreadSchema.parse(await services.browser(id, undefined, { action: 'commentWrite', write })) };
      }
      // Your Chrome's workspace group from the Browser tab: Stop, Close tab (a cloud tab too) and Focus in Chrome.
      case 'browserStop': case 'browserCloseTab': case 'browserFocusTab': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        await services.browser(String(target.id), undefined, command.type === 'browserStop' ? { action: 'stop', groupId: command.groupId } : { action: command.type === 'browserCloseTab' ? 'closeTab' : 'focusTab', groupId: command.groupId, targetId: command.targetId });
        return { control: await control(target) };
      }
      // Show on page: your Chrome's tab to the front, comment mode on, the thread open.
      case 'browserCommentShow': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        await services.browser(String(target.id), undefined, { action: 'commentShow', groupId: command.groupId, targetId: command.targetId, threadId: command.threadId });
        return { control: await control(target) };
      }
      // Take over (docs/APERTURE-DESIGN.md §7.2) on your Chrome's or the cloud browser's tab, from this device; Resume agent hands it back.
      case 'browserTakeOver': case 'browserResume': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        await services.browser(String(target.id), undefined, command.type === 'browserTakeOver' ? { action: 'takeOver', groupId: command.groupId, targetId: command.targetId, device: deviceId ?? null } : { action: 'resume', groupId: command.groupId, targetId: command.targetId });
        return { control: await control(target) };
      }
      // Everything (browser-powers.ts) on the workspace's group on your Chrome, from the Browser tab: allowed for an hour, or ended now.
      case 'browserEverything': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        await services.browser(String(target.id), undefined, { action: 'everything', pairingId: command.pairingId, on: command.on });
        return { control: await control(target) };
      }
      // Adding a tab from your Chrome's popup: the workspace's group on that Chrome, made or renewed.
      case 'browserTabGroup': {
        if (!canApprove) throw new Error('Browser management requires human capability');
        if (!services.browser) throw new Error('Browser management unavailable');
        return { control: await control(target), browserGroupId: z.string().uuid().parse(await services.browser(String(target.id), undefined, { action: 'tabGroup', pairingId: command.pairingId })) };
      }
      case 'prompt': {
        await services.lifecycle.userInput(String(target.id), async () => {
          const requestId = crypto.randomUUID();
          const selection = child?.model ? { kind: 'explicit' as const, ...child.model } : (await harness.snapshot(SessionControlsDoc, target.id, ctx))?.selection ?? { kind: 'default' as const };
          const model = await services.admitInference({ conversationId: String(target.id), requestId, selection });
          await services.configureModel(target.id, model);
          await applyInferenceThinking(target, model);
          await target.submit({ type: 'input', requestId, content: command.images?.length ? [{ type: 'text', text: command.text }, ...command.images] : command.text, whenBusy: command.streamingBehavior ?? 'followUp' }, ctx);
        });
        break;
      }
      case 'setModel': { const catalog = await services.catalog(); if (!catalog.models.some(model => model.provider === command.provider && model.id === command.model)) throw new Error('Model is not admitted by the inference profile'); await services.configureModel(target.id, { provider: command.provider, modelId: command.model }); await mutate(draft => { draft.role = null; draft.selection = { kind: 'explicit', provider: command.provider, modelId: command.model }; }); break; }
      case 'setThinking': { const thinking = modelRoleThinkingSchema.parse(command.thinking); await target.configure({ thinkingLevel: thinking }, ctx); await mutate(draft => { draft.thinkingSelection = { source: 'conversation', thinking }; }); break; }
      case 'cycleRole': { const catalog = await services.catalog(); if (!catalog.roles.length) throw new Error('No configured inference roles'); const state = await harness.snapshot(SessionControlsDoc, target.id, ctx); const index = catalog.roles.findIndex(role => role.id === state?.role); const next = index < 0 ? command.direction === 'forward' ? 0 : catalog.roles.length - 1 : (index + (command.direction === 'forward' ? 1 : catalog.roles.length - 1)) % catalog.roles.length; const role = catalog.roles[next]!; await services.configureModel(target.id, { provider: role.provider, modelId: role.model }); await target.configure({ thinkingLevel: modelRoleThinkingSchema.parse(role.thinking) }, ctx); await mutate(draft => selectRole(draft, role.id)); break; }
      case 'setFast': await mutate(draft => { draft.fastMode = command.enabled; }); break;
      case 'setWorkspacePhase':
        await services.setWorkspacePhase?.(command.phase);
        await harness.commit(async tx => { const workspace = await tx.doc(WorkspaceDoc); workspace.phase = command.phase; }, ctx);
        break;
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
        // An ask_takeover card is answered only by Not now: Take over is browserTakeOver, and a held tab's card ends at its handback.
        if (question.kind === 'takeover') {
          if (command.answers[0]?.selectedOptions[0] !== TAKEOVER_CHOICES.notNow) throw new Error('A take-over request is answered only by Not now');
          if (question.takeover?.holder === 'you') throw new Error('You hold this tab: hand it back with Resume agent');
          question.answer = TAKEOVER_ANSWERS.declined;
          return;
        }
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
        const saved = await definition(command.path, command.content, 'cloud', await services.catalog());
        await mutate(draft => {
          const previous = draft.definitions.find(definition => definition.path === command.path);
          if ((previous?.revision ?? null) !== command.expectedRevision) throw new Error('Agent definition revision conflict');
          if (previous) draft.definitions.splice(draft.definitions.indexOf(previous), 1, saved); else draft.definitions.push(saved);
          draft.definitionErrors = (draft.definitionErrors ?? []).filter(error => error.path !== command.path);
        });
        break;
      }
      case 'reloadSettings': case 'instructionsChanged': case 'inferenceChanged': { const kind = command.type === 'reloadSettings' ? 'settings' : command.type === 'instructionsChanged' ? 'instructions' : 'inference'; await services.reload(kind); await mutate(draft => { if (kind === 'settings') draft.settingsRevision++; else if (kind === 'instructions') draft.instructionsRevision++; else draft.inferenceRevision++; }); break; }
      case 'resume': harness.resume(); break;
      case 'persist': case 'handoff': await mutate(draft => { draft.revision++; }); break;
      case 'control': case 'agentSetup': case 'historyAnchorId': case 'historyPage': case 'transcriptPage': case 'transcriptContent': case 'usage': break;
    }
    const result: RuntimeSessionResult = { control: await control(target) };
    if (command.type === 'agentSetup' || command.type === 'saveAgentDefinition') {
      const state = await harness.snapshot(SessionControlsDoc, target.id, ctx);
      result.setup = { sessionId: String(target.id), ...(child ? { agents: child.definition ? [{ ...child.definition, editable: false }] : [], diagnostics: [], definitionErrors: [] } : { ...resolveAgentDefinitions(state?.definitions ?? []), definitionErrors: state?.definitionErrors ?? [] }) };
    }
    if (command.type === 'historyPage') result.historyPage = await services.history.page(target.id, command.request);
    if (command.type === 'transcriptPage') result.transcriptPage = await services.history.transcriptPage(target.id, command.request);
    if (command.type === 'transcriptContent') result.transcriptContent = await services.history.transcriptContent(target.id, command.request);
    if (command.type === 'usage') result.usage = await services.history.usage(target.id, harness);
    return result;
  }
  return { execute, control, conversation, loadDefinitions };
}
