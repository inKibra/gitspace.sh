import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { computeSessionActivity, type SessionActivity, type SessionStatus, type SkillView } from '@gitspace/protocol';
import {
  AgentRegistry,
  MemorySessionStorage,
  SessionManager,
  createAgentSession,
  discoverSkills,
  type AgentSessionEvent,
  type AuthStorage,
  type CustomTool,
  type SessionTreeNode,
} from '@oh-my-pi/pi-coding-agent';
import type { CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent/sdk';
import manualContinuePrompt from '@oh-my-pi/pi-coding-agent/prompts/system/manual-continue' with { type: 'text' };
import { OmpAskBridge } from './ask-bridge.js';

const ROLE_LABELS: Readonly<Record<string, string>> = {
  default: 'Default',
  task: 'Current model',
  slow: 'Thinking',
  smol: 'Fast',
  plan: 'Architect',
  designer: 'Designer',
  vision: 'Vision',
  commit: 'Commit',
  tiny: 'Tiny',
  advisor: 'Advisor',
};
import type { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp';
import type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpSessionControlView, OmpTranscriptEvent } from './contracts.js';

export interface OmpEvalNamespace {
  declaration: string;
  call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface SessionMcpBridge {
  manager: MCPManager;
  tools(): CustomTool[];
  attach(target: { refresh(tools: CustomTool[]): Promise<void> }): void;
  evalNamespace(options: unknown): OmpEvalNamespace;
  dispose(): Promise<void>;
}

export interface EmbeddedOmpRuntimeOptions {
  agentDir: string;
  sessionRoot: string;
  /** Machine-wide credential store shared with provider sign-in; omitted → one store per session. */
  authStorage?: () => Promise<AuthStorage>;
  mcp?: { createSession(input: {projectId: string; workspaceId: string | null; workspacePath: string}): Promise<SessionMcpBridge> };
  skills?: readonly SkillView[];
  spaceNamespace?: OmpEvalNamespace;
}

interface PermissionEventBus {
  on(name: string, handler: (payload: unknown) => void): void;
  off?(name: string, handler: (payload: unknown) => void): void;
}

function permissionId(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    for (const key of ['id', 'permissionId', 'permission_id', 'callId', 'callID']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return 'permission';
}


export async function projectOmpTranscript(sessionFile: string): Promise<OmpTranscriptEvent[]> {
  const manager = await SessionManager.open(sessionFile, dirname(sessionFile), undefined, { suppressBreadcrumb: true });
  try {
    return transcriptEvents(manager);
  } finally {
    await manager.close();
  }
}

const CHECKPOINT_SESSION_DIR = '/gitspace-checkpoint';
const CHECKPOINT_SESSION_FILE = `${CHECKPOINT_SESSION_DIR}/session.jsonl`;

/** Same projection over the raw bytes of a checkpointed OMP session, without touching the machine's session root. */
export async function projectOmpCheckpointTranscript(ompSession: Uint8Array): Promise<OmpTranscriptEvent[]> {
  const storage = new MemorySessionStorage();
  storage.writeTextSync(CHECKPOINT_SESSION_FILE, new TextDecoder().decode(ompSession));
  const manager = await SessionManager.open(CHECKPOINT_SESSION_FILE, CHECKPOINT_SESSION_DIR, storage, { suppressBreadcrumb: true, initialCwd: CHECKPOINT_SESSION_DIR });
  try {
    return transcriptEvents(manager);
  } finally {
    await manager.close();
  }
}

function transcriptEvents(manager: SessionManager): OmpTranscriptEvent[] {
  const events: OmpTranscriptEvent[] = [];
  for (const entry of manager.getBranch()) {
    const createdAt = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();
    if (entry.type === 'message') {
      events.push({ ordinal: events.length + 1, kind: 'message_end', payload: { message: entry.message }, createdAt });
    } else if (entry.type === 'custom') {
      const payload = entry.data && typeof entry.data === 'object'
        ? entry.data as Record<string, unknown>
        : { value: entry.data };
      events.push({ ordinal: events.length + 1, kind: entry.customType, payload, createdAt });
    }
  }
  return events;
}
function sessionTree(manager: SessionManager): OmpSessionControlView['tree'] {
  const leafId = manager.getLeafId();
  const branchIds = new Set(manager.getBranch().map((entry) => entry.id));
  const sequenceById = new Map(manager.getEntries().map((entry, index) => [entry.id, index + 1]));
  const output: OmpSessionControlView['tree'] = [];
  const text = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap((part) => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('');
  };
  const walk = (node: SessionTreeNode, parentId: string | null): void => {
    let nextParent = parentId;
    if (node.entry.type === 'message' && (node.entry.message.role === 'user' || node.entry.message.role === 'assistant')) {
      const content = 'content' in node.entry.message ? node.entry.message.content : '';
      const tools = Array.isArray(content) ? content.filter((part) => part && typeof part === 'object' && 'type' in part && part.type === 'toolCall').length : 0;
      output.push({
        id: node.entry.id,
        parentId,
        role: node.entry.message.role,
        preview: text(content).slice(0, 160),
        tools,
        sequence: sequenceById.get(node.entry.id) ?? 0,
        current: node.entry.id === leafId,
        onPath: branchIds.has(node.entry.id),
      });
      nextParent = node.entry.id;
    }
    for (const child of node.children) walk(child, nextParent);
  };
  for (const root of manager.getTree()) walk(root, null);
  if (!output.some((node) => node.current)) {
    const current = output.filter((node) => node.onPath).sort((left, right) => right.sequence - left.sequence)[0];
    if (current) current.current = true;
  }
  return output;
}

export class EmbeddedOmpRuntime implements OmpRuntime {
  constructor(private readonly options: EmbeddedOmpRuntimeOptions) {}

  transcript(sessionFile: string): Promise<OmpTranscriptEvent[]> { return projectOmpTranscript(sessionFile); }
  checkpointTranscript(bytes: Uint8Array): Promise<OmpTranscriptEvent[]> { return projectOmpCheckpointTranscript(bytes); }

  async create(input: { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<OmpRuntimeSession> {
    const sessionDir = join(this.options.sessionRoot, input.sessionKey);
    await mkdir(sessionDir, { recursive: true });
    return this.boot(SessionManager.create(input.workingDirectory, sessionDir), input.projectId, input.workspaceId, input.workingDirectory, input.artifactsDir);
  }

  async open(input: { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<OmpRuntimeSession> {
    const sessionDir = join(this.options.sessionRoot, input.sessionKey);
    await mkdir(sessionDir, { recursive: true });
    const manager = await SessionManager.open(input.sessionFile, sessionDir, undefined, { initialCwd: input.workingDirectory });
    return this.boot(manager, input.projectId, input.workspaceId, input.workingDirectory, input.artifactsDir);
  }

  private async boot(
    manager: SessionManager,
    projectId: string,
    workspaceId: string | null,
    workspacePath: string,
    artifactsDir: string,
  ): Promise<OmpRuntimeSession> {
    let sessionId: string | null = manager.getSessionId();
    const compaction = { onStart: null as (() => void) | null, onEnd: null as (() => void) | null };
    const compactionExtension = (pi: { on(name: string, handler: () => void): void }): void => {
      pi.on('session_before_compact', () => compaction.onStart?.());
      pi.on('session_compact', () => compaction.onEnd?.());
    };
    const authStorage = this.options.authStorage ? await this.options.authStorage() : null;
    let projectedMcp: SessionMcpBridge | null = null;
    if (this.options.mcp) {
      projectedMcp = await this.options.mcp.createSession({ projectId, workspaceId, workspacePath });
    }
    const discoveredSkills = await discoverSkills(workspacePath, this.options.agentDir);
    const configuredSkills = new Map((this.options.skills ?? []).map((skill) => [skill.id, skill]));
    const skills = discoveredSkills.skills.filter((skill) => {
      const configured = configuredSkills.get(skill.name);
      if (!configured) return true;
      if (!configured.enabled || configured.exceptions.includes(projectId)) return false;
      const assignment = configured.assignments.find((candidate) => candidate.projectId === projectId);
      if (assignment) return workspaceId === null ? assignment.projectSpaceEnabled : assignment.workspacesEnabled;
      return workspaceId === null
        ? configured.scope === 'project' || configured.scope === 'all'
        : configured.scope === 'workspaces' || configured.scope === 'all';
    });
    const localProtocolOptions = {
      getArtifactsDir: () => artifactsDir,
      getSessionId: () => sessionId,
      getLocalMounts: (): Record<string, 'read' | 'write'> => workspaceId === null
        ? { base: 'write' }
        : { base: 'read', workspace: 'write' },
    };
    let result: CreateAgentSessionResult;
    try {
      result = await createAgentSession({
        agentDir: this.options.agentDir,
        cwd: workspacePath,
        sessionManager: manager,
        hasUI: true,
        interactivePrompts: true,
        extensions: [compactionExtension],
        enableMCP: true,
        skills,
        ...(authStorage ? { authStorage } : {}),
        ...(projectedMcp ? { mcpManager: projectedMcp.manager } : {}),
        localProtocolOptions: {
          ...localProtocolOptions,
          getEvalNamespaces: () => ({
            ...(this.options.spaceNamespace ? { space: this.options.spaceNamespace } : {}),
            ...(projectedMcp ? { mcp: projectedMcp.evalNamespace(localProtocolOptions) } : {}),
          }),
        },
      });
    } catch (error) {
      await projectedMcp?.dispose();
      throw error;
    }
    const { session, eventBus, setToolUIContext } = result;
    if (projectedMcp) {
      projectedMcp.attach({ refresh: (tools) => session.refreshMCPTools(tools) });
      try {
        await session.refreshMCPTools(projectedMcp.tools());
      } catch (error) {
        await session.dispose();
        await projectedMcp.dispose();
        throw error;
      }
    }
    session.settings.override('prewalk.enabled', false);
    session.settings.override('task.prewalk', false);
    if (session.getVibeModeState()?.enabled) {
      await session.removeVibeToolsPreservingActive();
      session.setVibeModeState(undefined);
    }
    const writableArtifactMount = workspaceId === null ? 'base' : 'workspace';
    const qualifyLocalArtifactPath = (value: string): string => {
      if (!value.startsWith('local://')) return value;
      const relative = value.slice('local://'.length);
      const mount = relative.split('/', 1)[0];
      return mount === 'base' || mount === 'workspace' || mount === 'workspaces'
        ? value
        : `local://${writableArtifactMount}/${relative}`;
    };
    const planState = session.getPlanModeState();
    if (planState) {
      const planFilePath = qualifyLocalArtifactPath(planState.planFilePath);
      if (planFilePath !== planState.planFilePath) session.setPlanModeState({ ...planState, planFilePath });
    }
    const planReferencePath = session.getPlanReferencePath();
    session.setPlanReferencePath(qualifyLocalArtifactPath(planReferencePath || 'local://PLAN.md'));
    let goalPreviousTools: string[] | null = null;
    sessionId = session.sessionId;
    await manager.ensureOnDisk();
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      await session.dispose();
      await projectedMcp?.dispose();
      throw new Error('OMP did not persist a session file');
    }

    const eventHandlers = new Set<(event: OmpRuntimeEvent) => void>();
    const activityHandlers = new Set<(activity: SessionActivity, errorMessage?: string) => void>();
    const permissions = new Set<string>();
    const pendingQuestions = new Set<string>();
    let status: SessionStatus = { type: 'idle' };
    let errorMessage: string | undefined;
    let turnActive = false;
    let subagentCount = 0;
    let backgroundActivityTimer: Timer | undefined;
    const hasBackgroundWork = (): boolean => {
      const jobs = session.asyncJobManager;
      return !!jobs && (jobs.getRunningJobs().length > 0 || jobs.hasPendingDeliveries());
    };
    const currentActivity = (backgroundWork = hasBackgroundWork()): SessionActivity => {
      const queued = session.getQueuedMessages?.() ?? { steering: [], followUp: [] };
      return computeSessionActivity({
        statuses: { [session.sessionId]: status.type === 'idle' && backgroundWork ? { type: 'busy' } : status },
        pendingPermissions: permissions.size > 0 ? { [session.sessionId]: [...permissions] } : {},
        pendingQuestions: pendingQuestions.size > 0 ? { [session.sessionId]: [...pendingQuestions] } : {},
        queuedMessages: { [session.sessionId]: { steering: [...queued.steering], followUp: [...queued.followUp] } },
        subagentCounts: subagentCount > 0 ? { [session.sessionId]: subagentCount } : {},
      }, session.sessionId);
    };
    const publishActivity = (): void => {
      const backgroundWork = hasBackgroundWork();
      const activity = currentActivity(backgroundWork);
      // Async eval/bash jobs and pending result delivery outlive a provider turn.
      // Poll only while such work exists, so completion can release a draining child.
      if (backgroundWork && !backgroundActivityTimer) {
        backgroundActivityTimer = setTimeout(() => { backgroundActivityTimer = undefined; publishActivity(); }, 250);
      } else if (!backgroundWork && backgroundActivityTimer) {
        clearTimeout(backgroundActivityTimer);
        backgroundActivityTimer = undefined;
      }
      for (const handler of activityHandlers) handler(activity, errorMessage);
    };
    const updateSubagentCount = (): void => {
      // Finished agents remain idle/parked in the registry; only running turns pin this generation.
      const next = AgentRegistry.global().list().filter((ref) => ref.kind === 'sub' && ref.status === 'running').length;
      if (next === subagentCount) return;
      subagentCount = next;
      publishActivity();
    };
    const askBridge = new OmpAskBridge((pending) => {
      pendingQuestions.clear();
      if (pending) pendingQuestions.add(pending.id);
      publishActivity();
    });
    setToolUIContext(askBridge.context() as never, true);
    const handleEvent = (event: OmpRuntimeEvent): void => {
      switch (event.type) {
        case 'agent_start':
          turnActive = true;
          status = { type: 'busy' };
          errorMessage = undefined;
          publishActivity();
          break;
        case 'agent_end':
          turnActive = false;
          status = { type: 'idle' };
          errorMessage = undefined;
          publishActivity();
          break;
        case 'auto_compaction_start':
          status = { type: 'compacting' };
          publishActivity();
          break;
        case 'auto_compaction_end':
          status = { type: turnActive ? 'busy' : 'idle' };
          publishActivity();
          break;
        case 'auto_retry_start': {
          const message = typeof event.errorMessage === 'string' ? event.errorMessage : 'Retrying…';
          errorMessage = message;
          status = {
            type: 'retry',
            attempt: typeof event.attempt === 'number' ? event.attempt : 1,
            message,
            next: Date.now() + (typeof event.delayMs === 'number' ? event.delayMs : 0),
          };
          publishActivity();
          break;
        }
        case 'auto_retry_end':
          status = { type: event.success === true ? (turnActive ? 'busy' : 'idle') : 'idle' };
          errorMessage = event.success === true ? undefined : typeof event.finalError === 'string' ? event.finalError : errorMessage;
          publishActivity();
          break;
        default:
          if (event.type === 'message_end' || event.type === 'tool_execution_end') publishActivity();
      }
      for (const handler of eventHandlers) handler(event);
    };
    const sessionUnsubscribe = session.subscribe((event: AgentSessionEvent) => handleEvent(event as unknown as OmpRuntimeEvent));
    const registryUnsubscribe = AgentRegistry.global().onChange(updateSubagentCount);
    updateSubagentCount();

    compaction.onStart = () => {
      status = { type: 'compacting' };
      publishActivity();
    };
    compaction.onEnd = () => {
      status = { type: turnActive ? 'busy' : 'idle' };
      publishActivity();
    };

    const bus = eventBus as unknown as PermissionEventBus;
    const permissionWaiting = (payload: unknown): void => {
      permissions.add(permissionId(payload));
      publishActivity();
    };
    const permissionResolved = (payload: unknown): void => {
      permissions.delete(permissionId(payload));
      publishActivity();
    };
    for (const name of ['gitspace:permission.waiting', 'permission-gate:waiting']) bus.on(name, permissionWaiting);
    for (const name of ['gitspace:permission.resolved', 'permission-gate:resolved']) bus.on(name, permissionResolved);
    const control = (): OmpSessionControlView => {
      const roleOrder = session.settings.get('cycleOrder');
      const cycle = session.getRoleModelCycle(roleOrder.length ? roleOrder : ['default', 'smol', 'slow', 'plan']);
      const currentRole = cycle?.models[cycle.currentIndex];
      const model = session.model;
      const usage = session.getContextUsage();
      const stats = session.getSessionStats();
      const queued = session.getQueuedMessages();
      const goal = session.getGoalModeState()?.goal ?? null;
      return {
        sessionId: session.sessionId,
        role: currentRole?.role ?? null,
        roleLabel: currentRole ? ROLE_LABELS[currentRole.role] ?? currentRole.role : null,
        roles: (cycle?.models ?? []).map((entry, index) => ({
          id: entry.role,
          label: ROLE_LABELS[entry.role] ?? entry.role,
          provider: entry.model.provider,
          model: entry.model.id,
          thinking: entry.thinkingLevel ?? null,
          current: index === cycle?.currentIndex,
        })),
        tree: sessionTree(manager),
        models: session.getAvailableModels().map((available) => ({ provider: available.provider, id: available.id, name: available.name, contextWindow: available.contextWindow })),
        provider: model?.provider ?? null,
        model: model?.id ?? null,
        thinking: session.configuredThinkingLevel() ?? null,
        fastMode: session.isFastModeEnabled(),
        approvalMode: session.settings.get('tools.approvalMode'),
        context: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.contextWindow > 0 ? usage.tokens / usage.contextWindow * 100 : 0 } : null,
        cost: stats.cost,
        todos: session.getTodoPhases().map((phase) => ({ name: phase.name, tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status, blocker: task.blocker ?? null })) })),
        queue: { steering: [...queued.steering], followUp: [...queued.followUp] },
        history: session.getUserMessagesForBranching(),
        goal: goal ? { id: goal.id, status: goal.status, objective: goal.objective, tokenBudget: goal.tokenBudget ?? null, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds } : null,
        pendingAsk: askBridge.current(),
      };
    };
    const clearQueuedMessages = (): void => {
      session.clearQueue();
      const remaining = session.getQueuedMessages();
      for (let index = remaining.steering.length - 1; index >= 0; index -= 1) session.removeQueuedMessage('steering', index);
      for (let index = remaining.followUp.length - 1; index >= 0; index -= 1) session.removeQueuedMessage('followUp', index);
    };
    return {
      id: session.sessionId,
      sessionFile,
      prompt: (text, options) => {
        const command = text.trim().toLowerCase();
        if (command === '/prewalk' || command.startsWith('/prewalk ') || command === '/vibe' || command.startsWith('/vibe ')) {
          throw new Error('This OMP mode is disabled for GitSpace-managed sessions');
        }
        return session.prompt(text, options);
      },
      subscribe: (handler) => {
        eventHandlers.add(handler);
        return () => eventHandlers.delete(handler);
      },
      subscribeActivity: (handler) => {
        activityHandlers.add(handler);
        handler(currentActivity(), errorMessage);
        return () => activityHandlers.delete(handler);
      },
      activity: () => ({ activity: currentActivity(), ...(errorMessage ? { errorMessage } : {}) }),
      handoff: async () => {
        const interrupted = turnActive || session.isStreaming;
        if (interrupted) await session.abort({ goalReason: 'internal', reason: 'GitSpace machine handoff' });
        await manager.flush();
        return interrupted;
      },
      resume: async () => {
        await session.prompt(manualContinuePrompt, { synthetic: true, userInitiated: true });
      },
      persist: () => manager.flush(),
      reloadSettings: async () => {
        const activeSettings = (session as unknown as { settings?: { reloadFromDisk?: () => Promise<void> } }).settings;
        await activeSettings?.reloadFromDisk?.();
      },
      dispose: async () => {
        askBridge.cancel();
        sessionUnsubscribe();
        registryUnsubscribe();
        clearTimeout(backgroundActivityTimer);
        for (const name of ['gitspace:permission.waiting', 'permission-gate:waiting']) bus.off?.(name, permissionWaiting);
        for (const name of ['gitspace:permission.resolved', 'permission-gate:resolved']) bus.off?.(name, permissionResolved);
        await manager.flush();
        await session.dispose();
        await projectedMcp?.dispose();
      },
      control: async () => control(),
      cycleRole: async (direction) => {
        const roleOrder = session.settings.get('cycleOrder');
        await session.cycleRoleModels(roleOrder.length ? roleOrder : ['default', 'smol', 'slow', 'plan'], direction);
        return control();
      },
      setThinking: async (thinking) => {
        session.setThinkingLevel(thinking as never, false);
        return control();
      },
      setFast: async (enabled) => {
        session.setFastMode(enabled);
        return control();
      },
      setModel: async (provider, modelId) => {
        const model = session.getAvailableModels().find((candidate) => candidate.provider === provider && candidate.id === modelId);
        if (!model) throw new Error(`Model ${provider}/${modelId} is unavailable`);
        await session.setModel(model);
        return control();
      },
      setApproval: async (approvalMode) => {
        session.settings.override('tools.approvalMode', approvalMode);
        return control();
      },
      setGoal: async ({ enabled, objective }) => {
        const active = session.getGoalModeState();
        if (enabled) {
          if (!objective?.trim()) throw new Error('GitSpace Goal objective is required');
          if (goalPreviousTools === null) goalPreviousTools = session.getActiveToolNames();
          const tools = new Set(session.getActiveToolNames());
          tools.add('goal');
          await session.setActiveToolsByName([...tools]);
          if (active?.goal) await session.goalRuntime.replaceGoal({ objective });
          else await session.goalRuntime.createGoal({ objective });
        } else {
          await session.goalRuntime.dropGoal();
          session.setGoalModeState(undefined);
          if (goalPreviousTools) await session.setActiveToolsByName(goalPreviousTools);
          goalPreviousTools = null;
        }
        return control();
      },
      compact: async (instructions) => {
        await session.compact(instructions);
        return control();
      },
      clearQueue: async () => {
        clearQueuedMessages();
        return control();
      },
      removeQueuedMessage: async (kind, index) => {
        session.removeQueuedMessage(kind, index);
        return control();
      },
      promoteQueuedMessage: async (index) => {
        const removed = session.removeQueuedMessage('followUp', index);
        if (removed !== undefined) await session.steer(removed);
        return control();
      },
      answerAsk: async (id, answers) => {
        if (!askBridge.answer(id, answers)) throw new Error('Ask request is no longer pending');
        return control();
      },
      stop: async () => {
        askBridge.cancel();
        clearQueuedMessages();
        await session.abort({ reason: 'Interrupted by user' });
        clearQueuedMessages();
        return control();
      },
      navigateTree: async (entryId) => {
        const result = await session.navigateTree(entryId, { summarize: false });
        if (result.cancelled || result.aborted) throw new Error('Session tree navigation was cancelled');
        await manager.flush();
        return control();
      },
      messages: async () => [...session.state.messages],
    };
  }
}
