import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { computeSessionActivity, transitionAgentExecution, type AgentExecutionState, type AgentFailure, type SessionActivity } from '@gitspace/protocol-agent';
import type { SkillView } from '@gitspace/protocol';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { isImageGenerationApi } from '@oh-my-pi/pi-ai';
import {
  AgentRegistry,
  MemorySessionStorage,
  SessionManager,
  createAgentSession,
  discoverSkills,
  type AgentSessionEvent,
  type AuthStorage,
  type CustomTool,
} from '@oh-my-pi/pi-coding-agent';
import type { CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent/sdk';
import manualContinuePrompt from '@oh-my-pi/pi-coding-agent/prompts/system/manual-continue' with { type: 'text' };
import { OmpAskBridge } from './ask-bridge.js';
import { WorkspaceAgentSetup } from './agent-setup.js';
import { INSTRUCTION_CONTEXT_TYPE, INSTRUCTION_NOTICE, WorkspaceInstructionContext, workspaceInstructionText, type WorkspaceInstructions } from './workspace-instructions.js';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { ManagedInference } from './inference.js';
import { parseModelString } from '@oh-my-pi/pi-tui/overlays/model-selector';
import { getRestorableSessionModels } from '@oh-my-pi/pi-coding-agent/session/session-context';
import { roleCandidatePool } from '@oh-my-pi/pi-coding-agent/config/model-roles';

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
import type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpSessionControlView, OmpTranscriptEvent, WorkspacePhase } from './contracts.js';

const WORKSPACE_PHASE_CONTEXT_TYPE = 'gitspace-workspace-phase';
const PLAN_APPROVE_LABEL = 'Approve and move to Code';
const PLAN_REVISE_LABEL = 'Keep planning';

export interface OmpEvalNamespace {
  declaration: string;
  call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Typed machine controls for GitSpace's own host code. */
export interface OmpWorkspaceControls {
  instructions(signal?: AbortSignal): Promise<WorkspaceInstructions>;
  /** Moves this session's workspace to `phase`; the machine supplies the current definition revision. */
  setPhase(phase: WorkspacePhase): Promise<void>;
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
  /** Constructed before any SDK/model restore/helper setup; same-scope revisions apply in place. */
  inference?: ManagedInference;
  /** Test-only SDK injection for embedded non-managed fixtures. Production children require inference. */
  authStorage?: () => Promise<AuthStorage>;
  mcp?: { createSession(input: {projectId: string; workspaceId: string | null; workspacePath: string}): Promise<SessionMcpBridge> };
  skills?: { initial: readonly SkillView[]; refresh?: (signal?: AbortSignal) => Promise<readonly SkillView[]> };
  /** Forwarded unchanged to OMP's eval runtime for agent-written code. Its methods and results are dynamic,
   *  so GitSpace host code never calls it; use `workspaceControls`. */
  spaceNamespace?: OmpEvalNamespace;
  workspaceControls?: OmpWorkspaceControls;
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
/** Small prompt recall on the current branch; never build the session tree for controls. */
function recentPrompts(manager: SessionManager): OmpSessionControlView['history'] {
  const history: OmpSessionControlView['history'] = [];
  let id = manager.getLeafId();
  let characters = 0;
  for (let visited = 0; id !== null && visited < 4096 && history.length < 64; visited++) {
    const entry = manager.getEntry(id);
    if (!entry) break;
    id = entry.parentId;
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const content = entry.message.content;
    let text = '';
    if (typeof content === 'string') {
      if (content.length > 4096) continue;
      text = content;
    } else {
      // Omit oversized prompts, rather than silently recall only part of one.
      if (content.length > 4096) continue;
      for (const part of content) {
        if (part.type !== 'text') continue;
        if (text.length + part.text.length > 4096) { text = ''; break; }
        text += part.text;
      }
    }
    if (!text || characters + text.length > 32 * 1024) continue;
    characters += text.length;
    history.push({ entryId: entry.id, text });
  }
  return history.reverse();
}

export class EmbeddedOmpRuntime implements OmpRuntime {
  constructor(private readonly options: EmbeddedOmpRuntimeOptions) {}

  transcript(sessionFile: string): Promise<OmpTranscriptEvent[]> { return projectOmpTranscript(sessionFile); }
  checkpointTranscript(bytes: Uint8Array): Promise<OmpTranscriptEvent[]> { return projectOmpCheckpointTranscript(bytes); }

  async create(input: { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string; executionFailure?: AgentFailure | null }): Promise<OmpRuntimeSession> {
    const sessionDir = join(this.options.sessionRoot, input.sessionKey);
    await mkdir(sessionDir, { recursive: true });
    return this.boot(SessionManager.create(input.workingDirectory, sessionDir), input.projectId, input.workspaceId, input.workingDirectory, input.artifactsDir, input.executionFailure ?? null);
  }

  async open(input: { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string; executionFailure?: AgentFailure | null; sessionFile: string }): Promise<OmpRuntimeSession> {
    const sessionDir = join(this.options.sessionRoot, input.sessionKey);
    await mkdir(sessionDir, { recursive: true });
    const manager = await SessionManager.open(input.sessionFile, sessionDir, undefined, { initialCwd: input.workingDirectory });
    return this.boot(manager, input.projectId, input.workspaceId, input.workingDirectory, input.artifactsDir, input.executionFailure ?? null);
  }

  private async boot(
    manager: SessionManager,
    projectId: string,
    workspaceId: string | null,
    workspacePath: string,
    artifactsDir: string,
    executionFailure: AgentFailure | null,
  ): Promise<OmpRuntimeSession> {
    let sessionId: string | null = manager.getSessionId();
    let instructions: WorkspaceInstructionContext | undefined;
    let workspacePhase: WorkspacePhase | undefined;
    const restoredPhase = manager.getEntries().findLast((entry) => entry.type === 'custom' && entry.customType === WORKSPACE_PHASE_CONTEXT_TYPE);
    if (restoredPhase?.type === 'custom') {
      const phase = restoredPhase.data;
      if (phase !== 'plan' && phase !== 'code' && phase !== 'review' && phase !== 'ship') throw new Error('Invalid persisted workspace phase');
      workspacePhase = phase;
    }
    const phaseExtension = (pi: ExtensionAPI): void => {
      pi.on('context', (event) => {
        if (!workspacePhase) return;
        const planning = workspacePhase === 'plan';
        return { messages: [
          ...event.messages.filter((message) => message.role !== 'custom'
            || (message.customType !== WORKSPACE_PHASE_CONTEXT_TYPE
              && (planning || !message.customType.startsWith('plan-mode-') || message.customType === 'plan-mode-reference'))),
          { role: 'custom' as const, customType: WORKSPACE_PHASE_CONTEXT_TYPE,
            content: `Current workspace phase: ${workspacePhase}. This is authoritative over phase labels in earlier messages or Goal records. ${planning
              ? 'Plan mode is active: the working tree is read-only; draft plans in local://workspace/.'
              : 'Plan mode is off. Earlier planning-only restrictions no longer apply; use the tools needed for this phase and follow the current workspace instructions.'}`,
            display: false, timestamp: Date.now() },
        ] };
      });
    };
    const instructionExtension = (pi: ExtensionAPI): void => {
      pi.on('context', async (event, context) => {
        if (!instructions) return;
        let snapshot: WorkspaceInstructions;
        try { snapshot = await instructions.nextTurn(); }
        catch (error) {
          // The extension runner reports errors but otherwise continues with stale context.
          // Fail this provider boundary, after tools settle, instead of running old instructions.
          context.abort();
          throw error;
        }
        const content = workspaceInstructionText(snapshot);
        const goalState = result.session.getGoalModeState();
        if (goalState?.enabled && goalState.goal) {
          result.session.setGoalModeState({ ...goalState, goal: { ...goalState.goal, objective: content } });
        }
        return { messages: [
          ...event.messages.filter((message) => message.role !== 'custom' || message.customType !== INSTRUCTION_CONTEXT_TYPE),
          { role: 'custom' as const, customType: INSTRUCTION_CONTEXT_TYPE, content, display: false, timestamp: Date.now() },
        ] };
      });
    };
    const inference = this.options.inference;
    if (inference && inference.context.projectId !== projectId) throw new Error('Inference admission belongs to another project');
    const authStorage = inference?.authStorage ?? (this.options.authStorage ? await this.options.authStorage() : null);
    // A project moved to another inference profile may resume a session whose saved model that profile lacks.
    // OMP then falls back to the profile's default model; record which saved model was replaced so we can say so.
    let unavailableModel: string | null = null;
    if (inference) {
      await inference.modelRegistry.hydrateCredentialScopedModelCaches();
      const restored = getRestorableSessionModels(manager.buildSessionContext().models, manager.getLastModelChangeRole())[0];
      if (restored) {
        const selection = parseModelString(restored, { allowMaxSuffix: true, allowAutoAlias: true, isLiteralModelId: (provider, id) => inference.modelRegistry.find(provider, id) !== undefined });
        const model = selection && inference.modelRegistry.find(selection.provider, selection.id);
        if (!model || !inference.modelRegistry.hasConfiguredAuth(model)) unavailableModel = restored;
      }
      // OMP offers generate_image whenever it is enabled; only offer it when this profile can reach an image model.
      // The pool holds models whose provider has profile credentials, the same candidates the tool itself tries.
      if (inference.settings.get('generate_image.enabled')
        && !roleCandidatePool('image', inference.settings, inference.modelRegistry).some((model) => isImageGenerationApi(model.api))) {
        inference.settings.override('generate_image.enabled', false);
      }
    }
    let configuredSkills = new Map((this.options.skills?.initial ?? []).map((skill) => [skill.id, skill]));
    const discoverEffectiveSkills = async (configuration: ReadonlyMap<string, SkillView>) => {
      const discovered = await discoverSkills(workspacePath, this.options.agentDir, { customDirectories: [join(this.options.agentDir, 'skills')] });
      return discovered.skills.filter((skill) => {
        const configured = configuration.get(skill.name);
        if (!configured) return true;
        if (!configured.enabled || configured.exceptions.includes(projectId)) return false;
        const assignment = configured.assignments.find((candidate) => candidate.projectId === projectId);
        if (assignment) return workspaceId === null ? assignment.projectSpaceEnabled : assignment.workspacesEnabled;
        return workspaceId === null
          ? configured.scope === 'project' || configured.scope === 'all'
          : configured.scope === 'workspaces' || configured.scope === 'all';
      });
    };
    const skills = await discoverEffectiveSkills(configuredSkills);
    let projectedMcp: SessionMcpBridge | null = null;
    if (this.options.mcp) {
      projectedMcp = await this.options.mcp.createSession({ projectId, workspaceId, workspacePath });
    }
    const writableArtifactMount = workspaceId === null ? 'base' : 'workspace';
    const localProtocolOptions = {
      getArtifactsDir: () => artifactsDir,
      getSessionId: () => sessionId,
      getDefaultPlanReferencePath: () => `local://${writableArtifactMount}/PLAN.md`,
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
        extensions: [instructionExtension, phaseExtension],
        enableMCP: true,
        skills,
        ...(authStorage ? { authStorage } : {}),
        ...(inference ? { settings: inference.settings, modelRegistry: inference.modelRegistry } : {}),
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
    if (inference && unavailableModel) {
      const fallback = session.model;
      // Persist the replacement so later resumes restore it directly instead of repeating the fallback.
      if (fallback) manager.appendModelChange(`${fallback.provider}/${fallback.id}`, 'default');
      const content = fallback
        ? `Saved model ${unavailableModel} isn't available in inference profile ${inference.context.profile.name}; switched to ${fallback.provider}/${fallback.id}.`
        : `Saved model ${unavailableModel} isn't available in inference profile ${inference.context.profile.name}, and the profile has no default model; choose a model to continue.`;
      manager.appendCustomMessageEntry('gitspace-model-fallback', content, true);
    }
    const agentSetup = new WorkspaceAgentSetup(session, workspacePath);
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
    let skillRefresh: Promise<void> | null = null;
    const refreshSkillConfiguration = async (signal?: AbortSignal): Promise<void> => {
      const loadSkills = this.options.skills?.refresh;
      if (!loadSkills) return;
      if (skillRefresh) return skillRefresh;
      skillRefresh = (async () => {
        const latest = await loadSkills(signal);
        if (latest.length === configuredSkills.size && latest.every((skill) => configuredSkills.get(skill.id)?.revision === skill.revision)) return;
        const configuration = new Map(latest.map((skill) => [skill.id, skill]));
        const nextSkills = await discoverEffectiveSkills(configuration);
        // Explicit SDK skills are not rediscovered by refreshSkills. Keep the shared
        // array used by the session, tool contexts and skill:// registry up to date.
        skills.splice(0, skills.length, ...nextSkills);
        await session.refreshSkills();
        configuredSkills = configuration;
      })();
      try { await skillRefresh; }
      finally { skillRefresh = null; }
    };
    // This awaited hook runs after tools settle and before the provider prompt is
    // captured, including queued continuations. A cloud failure stops the boundary.
    const unsubscribeSkills = session.agent.addBeforeModelCallHook(refreshSkillConfiguration);
    session.settings.override('prewalk.enabled', false);
    session.settings.override('task.prewalk', false);
    if (session.getVibeModeState()?.enabled) {
      await session.removeVibeToolsPreservingActive();
      session.setVibeModeState(undefined);
    }
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
    /** `xd://propose` in the Plan phase: the reviewer approves through the workspace's question UI,
     * and approval moves the workspace to Code, which ends plan mode for the agent. */
    const proposePlan = async (title: string) => {
      const review = await session.preparePlanForReview(title);
      if (!review.details) throw new Error('Plan review did not identify a plan file');
      const planTitle = review.details.title;
      const planFilePath = qualifyLocalArtifactPath(review.details.planFilePath);
      const answer = await askBridge.ask([{
        id: 'plan-approval',
        header: 'Plan',
        question: `Approve “${planTitle}” and move this workspace to Code?`,
        options: [
          { label: PLAN_APPROVE_LABEL, description: `The agent implements ${planFilePath} with full tools.` },
          { label: PLAN_REVISE_LABEL, description: 'The workspace stays in Plan; the agent revises the plan and proposes it again.' },
        ],
        recommended: 0,
      }], 'gitspace', [{ label: 'Open plan', uri: planFilePath }]);
      // Stop or a machine handoff cancels the question; that is not a review decision.
      if (!answer) throw new Error(`Plan approval was interrupted before an answer. Write ${planTitle} to xd://propose again to resubmit.`);
      const decision = answer.results[0];
      if (decision?.selectedOptions.includes(PLAN_APPROVE_LABEL) !== true) {
        // Revision targets the plan just reviewed, not a stale state path.
        const state = session.getPlanModeState();
        if (state && state.planFilePath !== planFilePath) session.setPlanModeState({ ...state, planFilePath });
        const feedback = decision?.customInput ? ` Reviewer feedback: ${decision.customInput}` : '';
        return {
          content: [{ type: 'text' as const, text: `Plan refinement requested.${feedback} Update the plan file, then write ${planTitle} to xd://propose again when ready.` }],
          details: { ...review.details, planFilePath },
        };
      }
      const controls = this.options.workspaceControls;
      if (!controls) throw new Error('Plan approval requires this workspace\'s controls');
      session.setPlanReferencePath(planFilePath);
      await controls.setPhase('code');
      return {
        content: [{ type: 'text' as const, text: `Plan approved: ${planTitle}. The workspace is now in Code; implement the plan.` }],
        details: { ...review.details, planFilePath },
      };
    };
    const applyWorkspacePhase = (phase: WorkspacePhase): void => {
      const previous = session.getPlanModeState();
      if (phase === 'plan') {
        if (!previous?.enabled) session.setPlanModeState({
          enabled: true, planFilePath: qualifyLocalArtifactPath(session.getPlanReferencePath()),
          workflow: previous?.workflow ?? 'parallel', reentry: previous !== undefined,
        });
        session.setPlanProposalHandler(proposePlan);
      } else {
        session.setPlanProposalHandler(null);
        session.setPlanModeState(undefined);
      }
    };
    if (workspacePhase) applyWorkspacePhase(workspacePhase);
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
    const activityHandlers = new Set<(activity: SessionActivity, failure: AgentFailure | null) => void>();
    const permissions = new Set<string>();
    const pendingQuestions = new Set<string>();
    let executionState: AgentExecutionState = { status: { type: 'idle' }, turnActive: false, failure: executionFailure };
    let subagentCount = 0;
    let backgroundCompletion: Promise<void> | null = null;
    let disposed = false;
    const hasBackgroundWork = (): boolean => {
      const jobs = session.asyncJobManager;
      return session.hasPostPromptWork || session.hasPendingAsyncWork?.() === true
        || (!!jobs && (jobs.getRunningJobs().length > 0 || jobs.hasPendingDeliveries()));
    };
    const currentActivity = (backgroundWork = hasBackgroundWork()): SessionActivity => {
      const queued = session.getQueuedMessages?.() ?? { steering: [], followUp: [] };
      return computeSessionActivity({
        statuses: { [session.sessionId]: executionState.status },
        pendingPermissions: permissions.size > 0 ? { [session.sessionId]: [...permissions] } : {},
        pendingQuestions: pendingQuestions.size > 0 ? { [session.sessionId]: [...pendingQuestions] } : {},
        queuedMessages: { [session.sessionId]: { steering: [...queued.steering], followUp: [...queued.followUp] } },
        subagentCounts: subagentCount > 0 || backgroundWork ? { [session.sessionId]: subagentCount + (backgroundWork ? 1 : 0) } : {},
      }, session.sessionId);
    };
    const publishActivity = (): void => {
      const backgroundWork = hasBackgroundWork();
      const activity = currentActivity(backgroundWork);
      // Await real job and delivery completion; do not poll the runtime for activity.
      const jobs = session.asyncJobManager;
      if (backgroundWork && !backgroundCompletion) {
        backgroundCompletion = Promise.allSettled((jobs?.getRunningJobs() ?? []).map((job) => job.promise))
          .then(async () => { await jobs?.drainDeliveries(); await session.waitForIdle(); })
          .finally(() => { backgroundCompletion = null; if (!disposed) publishActivity(); });
      }
      for (const handler of activityHandlers) handler(activity, executionState.failure);
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
      const message = event.message && typeof event.message === 'object' ? event.message : null;
      const assistant = message && 'role' in message && message.role === 'assistant';
      const stopReason = message && 'stopReason' in message ? message.stopReason : undefined;
      // OMP's own silent aborts and a user's Stop end a turn deliberately; neither is an execution failure.
      const deliberateAbort = stopReason === 'aborted' && message !== null && 'errorId' in message && typeof message.errorId === 'number'
        && (AIError.is(message.errorId, AIError.Flag.SilentAbort) || AIError.is(message.errorId, AIError.Flag.UserInterrupt));
      executionState = transitionAgentExecution(executionState, {
        type: event.type, sessionId: session.sessionId,
        ...(typeof event.errorMessage === 'string' ? { message: event.errorMessage } : typeof event.finalError === 'string' ? { message: event.finalError } : message && 'errorMessage' in message && typeof message.errorMessage === 'string' ? { message: message.errorMessage } : {}),
        ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
        ...(typeof event.delayMs === 'number' ? { delayMs: event.delayMs } : {}),
        ...(event.type === 'compaction_state' && typeof event.active === 'boolean' ? { active: event.active } : {}),
        ...(event.type === 'compaction_state' && typeof event.turnActive === 'boolean' ? { turnActive: event.turnActive } : {}),
        ...(typeof event.detail === 'string' ? { detail: event.detail } : {}),
        ...(event.type === 'auto_retry_end' ? { succeeded: event.success === true } : assistant && typeof stopReason === 'string' && !deliberateAbort ? { succeeded: stopReason !== 'error' && stopReason !== 'aborted' } : {}),
      }, Date.now());
      publishActivity();
      for (const handler of eventHandlers) handler(event);
    };
    if (this.options.workspaceControls) {
      const controls = this.options.workspaceControls;
      instructions = new WorkspaceInstructionContext(
        () => controls.instructions(AbortSignal.timeout(15_000)),
        () => {
          const message = { role: 'custom' as const, customType: 'gitspace-instructions-changed', content: INSTRUCTION_NOTICE, display: true, timestamp: Date.now() };
          // Persist a transcript notice without steering, cancelling tools, or waking an idle agent.
          manager.appendCustomMessageEntry(message.customType, message.content, message.display);
          handleEvent({ type: 'message_end', message });
        },
      );
    }
    const sessionUnsubscribe = session.subscribe((event: AgentSessionEvent) => handleEvent(event as unknown as OmpRuntimeEvent));
    const registryUnsubscribe = AgentRegistry.global().onChange(updateSubagentCount);
    updateSubagentCount();


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
    let recallLeaf: string | null | undefined;
    let recallHistory: OmpSessionControlView['history'] = [];
    const control = (): OmpSessionControlView => {
      const leafId = manager.getLeafId();
      if (recallLeaf !== leafId) {
        recallHistory = recentPrompts(manager);
        recallLeaf = leafId;
      }
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
        ...(inference && inference.context.assignmentRevision !== null ? { inference: {
          profileId: inference.context.profile.id, profileName: inference.context.profile.name,
          profileRevision: inference.context.profile.revision, assignmentRevision: inference.context.assignmentRevision,
        } } : {}),
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
        historyAnchorId: leafId,
        models: session.getAvailableModels().map((available) => ({ provider: available.provider, id: available.id, name: available.name, contextWindow: available.contextWindow })),
        provider: model?.provider ?? null,
        model: model?.id ?? null,
        thinking: session.configuredThinkingLevel() ?? null,
        fastMode: session.isFastModeEnabled(),
        planMode: session.getPlanModeState()?.enabled === true,
        approvalMode: session.settings.get('tools.approvalMode'),
        context: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.contextWindow > 0 ? usage.tokens / usage.contextWindow * 100 : 0 } : null,
        cost: stats.cost,
        todos: session.getTodoPhases().map((phase) => ({ name: phase.name, tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status, blocker: task.blocker ?? null })) })),
        queue: { steering: [...queued.steering], followUp: [...queued.followUp] },
        history: recallHistory,
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
      isAvailable: () => !disposed,
      historyAnchorId: async () => manager.getLeafId(),
      prompt: async (text, options) => {
        const command = text.trim().toLowerCase();
        if (command === '/prewalk' || command.startsWith('/prewalk ') || command === '/vibe' || command.startsWith('/vibe ')) {
          throw new Error('This OMP mode is disabled for GitSpace-managed sessions');
        }
        await refreshSkillConfiguration();
        return session.prompt(text, options);
      },
      subscribe: (handler) => {
        eventHandlers.add(handler);
        return () => eventHandlers.delete(handler);
      },
      subscribeActivity: (handler) => {
        activityHandlers.add(handler);
        handler(currentActivity(), executionState.failure);
        return () => activityHandlers.delete(handler);
      },
      activity: () => ({ activity: currentActivity(), failure: executionState.failure }),
      instructionsChanged: async () => { instructions?.changed(); },
      setWorkspacePhase: async (phase) => {
        if (workspaceId === null) throw new Error('Project base sessions do not have a workspace phase');
        if (workspacePhase === phase && (session.getPlanModeState()?.enabled === true) === (phase === 'plan')) return;
        // Guard changes are synchronous; do not abort a provider/tool call or
        // await the run that may itself be invoking space.setPhase through IPC.
        applyWorkspacePhase(phase);
        workspacePhase = phase;
        manager.appendCustomEntry(WORKSPACE_PHASE_CONTEXT_TYPE, phase);
        const goal = session.getGoalModeState();
        manager.appendModeChange(phase === 'plan' ? 'plan' : goal?.enabled ? 'goal' : 'none',
          phase === 'plan' ? { ...session.getPlanModeState() } : goal?.enabled ? { goal: goal.goal } : undefined);
        await manager.flush();
      },
      handoff: async () => {
        const interrupted = executionState.turnActive || session.isStreaming;
        // Abort settles the interrupted tool, but a question without an abort signal (plan approval)
        // would stay pending for the successor's UI until disposal; only this turn could answer it.
        askBridge.cancel();
        if (interrupted) {
          session.markPlanInternalAbortPending();
          try { await session.abort({ goalReason: 'internal', reason: 'GitSpace machine handoff' }); }
          finally { session.clearPlanInternalAbortPending(); }
        }
        await manager.flush();
        return interrupted;
      },
      resume: async () => {
        await refreshSkillConfiguration();
        await session.prompt(manualContinuePrompt, { synthetic: true, userInitiated: true });
      },
      persist: () => manager.flush(),
      reloadSettings: async () => {
        // A child retains its admission, including Advanced, until all descendants
        // settle. The machine re-resolves authority and reopens before new work.
        if (!inference) await session.settings.reloadFromDisk();
      },
      inferenceChanged: async () => {
        const current = session.model;
        if (!inference || !current || session.getAvailableModels().some((model) => model.provider === current.provider && model.id === current.id)) return;
        // The new revision dropped the selected model: continue on the default role instead of failing the next turn.
        const fallback = session.getRoleModelCycle(['default'])?.models[0];
        if (!fallback) throw new Error(`Model ${current.provider}/${current.id} left inference profile ${inference.context.profile.name}, and its default role has no available model`);
        await session.applyRoleModel(fallback);
        const content = `${current.provider}/${current.id} is no longer available in inference profile ${inference.context.profile.name}; switched to the default role model ${fallback.model.provider}/${fallback.model.id}.`;
        manager.appendCustomMessageEntry('gitspace-model-fallback', content, true);
        handleEvent({ type: 'message_end', message: { role: 'custom', customType: 'gitspace-model-fallback', content, display: true, timestamp: Date.now() } });
      },
      dispose: async () => {
        disposed = true;
        askBridge.cancel();
        sessionUnsubscribe();
        registryUnsubscribe();
        unsubscribeSkills();
        for (const name of ['gitspace:permission.waiting', 'permission-gate:waiting']) bus.off?.(name, permissionWaiting);
        for (const name of ['gitspace:permission.resolved', 'permission-gate:resolved']) bus.off?.(name, permissionResolved);
        await manager.flush();
        await session.dispose();
        await projectedMcp?.dispose();
      },
      control: async () => control(),
      agentSetup: () => agentSetup.view(),
      saveAgentDefinition: (input) => agentSetup.save(input),
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
        await session.setModelTemporary(model);
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
