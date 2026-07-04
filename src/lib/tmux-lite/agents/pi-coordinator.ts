import { parseCommandArgs } from '@oh-my-pi/pi-coding-agent/utils/command-args';

import type { OmpAgentSession, OmpCreateSessionResult } from './omp-types.js';
import { HostUIBridgeState, type HostUIBridgeEmitter, type HostUIDialogResponse } from './host-ui-bridge.js';
import {
  terminateSession as terminateTmuxSession,
  listSessions as listTmuxSessions,
  createVirtualSession as createTmuxVirtualSession,
  resizeVirtualSession as resizeTmuxVirtualSession,
} from '../cli.js';
import type { Session as TmuxSession } from '../protocol.js';
import {
  createPiAuthStorage,
  createPiModelRegistry,
  createPiSessionManager,
  getManagedPiExtensionPaths,
  getPiSettings,
  openPiSession,
  openPiSessionManager,
  persistInitialPiSessionModel,
} from './pi-runtime.js';
import type { AgentControlInfo, AgentHistoryEntry, AgentOAuthEvent, AgentSettingSchemaItem, AgentToolInfo } from '../../../agents/agent-runtime-types.js';

const THINKING_LEVELS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const APPROVAL_MODES = ['always-ask', 'write', 'yolo'];

/** Standard OMP tools + tiers — used when the live tool registry isn't exposed. */
const DEFAULT_TOOL_TIERS: ReadonlyArray<[string, string]> = [
  ['read', 'read'], ['ls', 'read'], ['glob', 'read'], ['grep', 'read'], ['web_search', 'read'],
  ['edit', 'write'], ['write', 'write'], ['todo_write', 'write'],
  ['bash', 'exec'], ['task', 'exec'], ['web_fetch', 'exec'], ['browser', 'exec'], ['ssh', 'exec'], ['eval', 'exec'],
];

/** Curated, safe-to-edit settings surfaced in the settings panel. */
const SETTINGS_CATALOG: Array<{ path: string; label: string; kind: 'boolean' | 'enum'; options?: string[] }> = [
  { path: 'tools.approvalMode', label: 'Approval mode', kind: 'enum', options: APPROVAL_MODES },
  { path: 'model.thinkingLevel', label: 'Thinking level', kind: 'enum', options: THINKING_LEVELS },
  { path: 'compaction.enabled', label: 'Auto-compaction', kind: 'boolean' },
  { path: 'compaction.autoContinue', label: 'Compaction auto-continue', kind: 'boolean' },
  { path: 'retry.enabled', label: 'Auto-retry on errors', kind: 'boolean' },
  { path: 'tools.intentTracing', label: 'Tool intent tracing', kind: 'boolean' },
];

/** The control-seam accessors on a live session (cast loosely; the strict SDK
 *  signatures aren't worth re-declaring on OmpAgentSession). */
interface ControlSessionAccessors {
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  configuredThinkingLevel?(): string | undefined;
  setThinkingLevel?(level: string, persist?: boolean): void;
  getContextUsage?(options?: { contextWindow?: number }): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  settings?: { get(path: string): unknown; set(path: string, value: unknown): void };
  toolRegistry?: Map<string, { name?: string; tier?: string }>;
  compact?(instructions?: string): Promise<unknown>;
  getRoleModelCycle?(roleOrder: readonly string[]): { models: Array<{ role: string; model?: { provider?: string; id?: string } }>; currentIndex: number } | undefined;
  applyRoleModel?(entry: unknown): Promise<void>;
  cycleRoleModels?(roleOrder: readonly string[], direction?: 'forward' | 'backward'): Promise<unknown>;
  getUserMessagesForBranching?(): Array<{ entryId: string; text: string }>;
  navigateTree?(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled?: boolean }>;
  sessionManager?: {
    branch?(branchFromId: string): void;
    getLeafId?(): string | null;
    getBranch?(fromId?: string): Array<{ id: string }>;
  };
}
import { getTranscriptRange } from '../../../blocks/agent/transcript-source.js';
import type { TranscriptPage, TranscriptSource } from '../../../blocks/agent/transcript-source.js';
import { LiveTurn } from '../../../blocks/agent/live-turn.js';
import type { AgentEvent as SdkAgentEvent } from '@oh-my-pi/pi-agent-core';
import { getManagedSessionBootstrap } from './managed-defaults.js';
import { executeSpaceCommand } from './extensions/space-command.js';
// Dynamic imports: oh-my-pi has module-level side effects (postmortem signal
// handlers, provider registration) that conflict with OpenTUI when loaded eagerly.
const importSdk = () => import('@oh-my-pi/pi-coding-agent/sdk');
const importSlashCommands = () => import('@oh-my-pi/pi-coding-agent/extensibility/slash-commands');
const importExecModule = () => import('@oh-my-pi/pi-coding-agent/exec/exec');
import { listPiSessions, findPiSessionFile, type PiSessionFileInfo } from './pi-session-files.js';
import { upsertArchivedSession, deleteArchivedSession } from '../../../agents/agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../../agents/session-display.js';
import type { AgentEvent } from '../../../agents/backend.js';
import { getVirtualTerminal } from '../virtual-session-registry.js';
import { startVirtualInteractiveMode, type VirtualInteractiveModeHandle } from './virtual-interactive-mode.js';
import type {
  PendingQuestion,
  Permission,
  QuestionInfo,
} from '../../../agents/agent-runtime-types.js';
import { writeTraceLog } from '../../../utils/trace-log.js';

export const PI_AGENT_TMUX_SESSION_KIND = 'agent';

/** Max time to wait for Pi to create its session file after spawning. */
const SESSION_DISCOVERY_TIMEOUT_MS = 10_000;
const SESSION_DISCOVERY_POLL_MS = 200;

export interface PiWorkspaceTarget {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  projectName: string;
}

export interface PiAgentSessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closedAt?: string;
  archivedAt?: string;
}

function buildAgentTerminalSessionName(target: PiWorkspaceTarget, agentSessionId: string): string {
  return `agent:${target.workspaceName}:${agentSessionId.slice(-8)}`;
}

function isAgentTmuxSession(session: TmuxSession, workspaceId: string, agentSessionId: string): boolean {
  return session.kind === PI_AGENT_TMUX_SESSION_KIND
    && session.metadata?.workspaceId === workspaceId
    && session.metadata?.agentSessionId === agentSessionId;
}

function isLikelyAgentTmuxSession(session: TmuxSession, target: PiWorkspaceTarget, agentSessionId: string): boolean {
  return isAgentTmuxSession(session, target.workspaceId, agentSessionId)
    || (
      session.kind === PI_AGENT_TMUX_SESSION_KIND
      && session.name === buildAgentTerminalSessionName(target, agentSessionId)
    );
}

// ---------------------------------------------------------------------------
// Ask-question parsing (moved from the removed gitspace-status extension)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseQuestionOptions(input: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(input)) return [];
  return input.flatMap((option) => {
    if (typeof option === 'string') return [{ label: option }];
    if (isRecord(option) && typeof option.label === 'string') {
      return [{ label: option.label, description: typeof option.description === 'string' ? option.description : undefined }];
    }
    return [];
  });
}

function parseAskQuestions(input: Record<string, unknown>): QuestionInfo[] {
  if (Array.isArray(input.questions)) {
    const parsed = input.questions.flatMap((q: unknown) => {
      if (!isRecord(q) || typeof q.question !== 'string') return [];
      return [{
        question: q.question as string,
        header: typeof q.header === 'string' ? q.header : 'Question',
        options: parseQuestionOptions(q.options),
        multiple: q.multiple === true,
        custom: q.custom === true,
      } satisfies QuestionInfo];
    });
    if (parsed.length > 0) return parsed;
  }
  if (typeof input.question === 'string') {
    return [{
      question: input.question,
      header: typeof input.header === 'string' ? input.header : 'Question',
      options: parseQuestionOptions(input.options),
      multiple: input.multiple === true,
      custom: input.custom === true,
    }];
  }
  if (typeof input.prompt === 'string') {
    return [{
      question: input.prompt,
      header: 'Question',
      options: parseQuestionOptions(input.options),
      multiple: input.multiple === true,
      custom: true,
    }];
  }
  return [{ question: 'Agent requested additional input.', header: 'Question', options: [], custom: true }];
}

function buildPendingQuestion(toolCallId: string, sessionId: string, input: Record<string, unknown>): PendingQuestion {
  return {
    id: toolCallId,
    sessionID: sessionId,
    questions: parseAskQuestions(input),
    tool: { messageID: toolCallId, callID: toolCallId },
  };
}

// ---------------------------------------------------------------------------
// Permission parsing (moved from the removed gitspace-status extension)
// ---------------------------------------------------------------------------

function buildPermission(sessionId: string, payload: unknown): Permission {
  const record = isRecord(payload) ? payload : {};
  const id = typeof record.id === 'string'
    ? record.id
    : typeof record.permissionId === 'string'
      ? record.permissionId
      : typeof record.callID === 'string'
        ? record.callID
        : typeof record.messageID === 'string'
          ? record.messageID
          : `perm-${sessionId}-${Date.now()}`;
  return {
    id,
    type: typeof record.type === 'string' ? record.type : 'permission',
    pattern: Array.isArray(record.pattern) || typeof record.pattern === 'string' ? record.pattern : undefined,
    sessionID: sessionId,
    messageID: typeof record.messageID === 'string' ? record.messageID : id,
    callID: typeof record.callID === 'string' ? record.callID : undefined,
    title: typeof record.title === 'string' ? record.title : 'Permission requested',
    metadata: isRecord(record.metadata) ? record.metadata : record,
    time: { created: typeof record.createdAt === 'number' ? record.createdAt : Date.now() },
  };
}

function permissionIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.id === 'string') return payload.id;
  if (typeof payload.permissionId === 'string') return payload.permissionId;
  if (typeof payload.callID === 'string') return payload.callID;
  if (typeof payload.messageID === 'string') return payload.messageID;
  return null;
}

interface TerminalSessionBinding {
  workspaceId: string;
  agentSessionId: string;
}

export class PiCoordinator {
  private readonly liveTurns = new Map<string, LiveTurn>();
  private readonly oauthPrompts = new Map<string, (value: string) => void>();
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();
  private readonly inflightActiveSessions = new Map<string, Promise<OmpAgentSession>>();
  private readonly terminalBindings = new Map<string, TerminalSessionBinding>();
  private readonly terminalSessionIdsByAgentKey = new Map<string, Set<string>>();
  private readonly activeSessions = new Map<string, OmpAgentSession>();
  // Reverse index: agentSessionId → workspaceId, kept in sync with activeSessions.
  private readonly sessionWorkspaceIds = new Map<string, string>();
  private readonly sessionUnsubscribers = new Map<string, () => void>();
  private readonly sessionsRoot: string | undefined;
  private readonly virtualModeHandles = new Map<string, VirtualInteractiveModeHandle>();
  private eventHandler: ((target: PiWorkspaceTarget, event: AgentEvent) => void) | null = null;

  // Host UI bridge: routes extension dialog requests to the native surface
  // and resolves responses from the client.
  private readonly sessionUIBinders = new Map<string, OmpCreateSessionResult['setToolUIContext']>();
  private readonly hostUIBridge = new HostUIBridgeState();
  private hostUIEmitter: HostUIBridgeEmitter | null = null;

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = sessionsRoot;
  }

  setEventHandler(handler: ((target: PiWorkspaceTarget, event: AgentEvent) => void) | null): void {
    this.eventHandler = handler;
  }

  /**
   * Install the bridge emitter that routes dialog requests and UI events
   * to watching clients. Call once during server setup.
   */
  setHostUIEmitter(emitter: HostUIBridgeEmitter | null): void {
    this.hostUIEmitter = emitter;
    if (emitter) {
      // Install host UI context on all already-active sessions
      for (const [sessionId, binder] of this.sessionUIBinders) {
        binder(this.hostUIBridge.createContextForSession(sessionId, emitter), true);
      }
    }
  }

  /**
   * Route a dialog response from a client to the pending Promise.
   * Returns true if the dialog was found and resolved.
   */
  resolveDialogResponse(response: HostUIDialogResponse): boolean {
    return this.hostUIBridge.resolveDialog(response);
  }

  /**
   * List Pi agent sessions for a workspace by reading session files on disk.
   * Session IDs come from Pi's JSONL files — these are the canonical IDs.
   */
  async refreshAgentSessions(target: PiWorkspaceTarget): Promise<PiAgentSessionSummary[]> {
    const sessions = listPiSessions(target.workspacePath, this.sessionsRoot);
    return sessions
      .filter((s) => shouldDisplayAgentSession({ id: s.id, title: s.title ?? s.firstMessage }))
      .map((s) => ({
        id: s.id,
        workspaceId: target.workspaceId,
        title: getAgentSessionDisplayTitle({
          id: s.id,
          title: s.title ?? s.firstMessage ?? undefined,
          rawTitle: s.title ?? s.firstMessage ?? undefined,
        }),
        updatedAt: s.modified?.toISOString(),
      }));
  }

  /**
   * Read one page of a session's transcript as blocks (storage-free projection
   * over the SDK session's entry tree). Opens the session file read-only; the
   * SDK's manager is the source of truth — we map a window and release it.
   */
  async readTranscriptRange(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    opts: { before?: string; limit: number },
  ): Promise<TranscriptPage> {
    // Prefer the active session's in-memory manager so a live leaf move (a
    // conversation rewind via SessionManager.branch) is reflected immediately.
    // A fresh file open always resets the leaf to the last entry, which would
    // ignore the rewind.
    const active = this.activeSessions.get(agentSessionId) as ControlSessionAccessors | undefined;
    if (active?.sessionManager) {
      return getTranscriptRange(active.sessionManager as unknown as TranscriptSource, opts);
    }
    const file = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!file) return { blocks: [], oldestCursor: null, hasMore: false };
    const manager = await openPiSessionManager(file.path);
    return getTranscriptRange(manager as unknown as TranscriptSource, opts);
  }

  /** Control-surface snapshot: usage, current model, and the model switcher list. */
  async getControlInfo(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentControlInfo> {
    const file = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    let usage: AgentControlInfo['usage'] = null;
    let currentModel: string | null = null;
    if (file) {
      const manager = (await openPiSessionManager(file.path)) as unknown as {
        getUsageStatistics?: () => NonNullable<AgentControlInfo['usage']>;
        buildSessionContext?: () => { models?: { default?: string } };
      };
      usage = manager.getUsageStatistics?.() ?? null;
      currentModel = manager.buildSessionContext?.().models?.default ?? null;
    }
    // Prefer the live model from the active session (reflects a just-applied
    // switch before it's persisted to the session context).
    const active = this.activeSessions.get(agentSessionId) as ControlSessionAccessors | undefined;
    const liveModel = active?.model;
    if (liveModel?.provider && liveModel?.id) {
      currentModel = `${liveModel.provider}/${liveModel.id}`;
    }
    let models: AgentControlInfo['models'] = [];
    try {
      const registry = await createPiModelRegistry();
      models = registry.getAll().map((m) => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow ?? null }));
    } catch (err) {
      console.warn('[pi-coordinator] model list failed:', err);
    }

    // Session-level controls — thinking + context come from the active session;
    // approval mode is a setting (global, or the active session's settings).
    const thinkingLevel = active?.configuredThinkingLevel?.() ?? active?.thinkingLevel ?? null;
    const context = active?.getContextUsage?.() ?? null;
    let approvalMode: string | null = null;
    let serviceTier: string | null = null;
    try {
      const settings = active?.settings ?? (await getPiSettings());
      const m = settings?.get('tools.approvalMode');
      if (typeof m === 'string') approvalMode = m;
      const st = settings?.get('serviceTier');
      if (typeof st === 'string') serviceTier = st;
    } catch {
      /* settings unavailable */
    }

    // Model roles (the role cycle) — resolved from the active session.
    let roles: AgentControlInfo['roles'] = [];
    try {
      if (active?.getRoleModelCycle) {
        const { MODEL_ROLE_IDS, MODEL_ROLES } = (await import('@oh-my-pi/pi-coding-agent/config/model-registry')) as unknown as {
          MODEL_ROLE_IDS: string[];
          MODEL_ROLES: Record<string, { name?: string }>;
        };
        const cycle = active.getRoleModelCycle(MODEL_ROLE_IDS);
        if (cycle?.models) {
          roles = cycle.models.map((m, i) => ({
            role: m.role,
            name: MODEL_ROLES[m.role]?.name ?? m.role,
            model: m.model?.provider && m.model?.id ? `${m.model.provider}/${m.model.id}` : null,
            current: i === cycle.currentIndex,
          }));
        }
      }
    } catch {
      /* roles unavailable */
    }

    return {
      usage,
      currentModel,
      models,
      roles,
      thinkingLevel,
      thinkingLevels: THINKING_LEVELS,
      approvalMode,
      approvalModes: APPROVAL_MODES,
      serviceTier,
      context: context ?? null,
    };
  }

  /** Cycle the active model through the configured roles (the cmd-P role cycle). */
  async cycleRole(target: PiWorkspaceTarget, agentSessionId: string, direction: 'forward' | 'backward'): Promise<boolean> {
    const session = (await this.ensureActiveSession(target, agentSessionId)) as unknown as ControlSessionAccessors;
    if (!session.cycleRoleModels) return false;
    const { MODEL_ROLE_IDS } = (await import('@oh-my-pi/pi-coding-agent/config/model-registry')) as unknown as { MODEL_ROLE_IDS: string[] };
    const result = await session.cycleRoleModels(MODEL_ROLE_IDS, direction);
    return !!result;
  }

  /** Apply a specific role's model to the active session. */
  async applyRole(target: PiWorkspaceTarget, agentSessionId: string, role: string): Promise<boolean> {
    const session = (await this.ensureActiveSession(target, agentSessionId)) as unknown as ControlSessionAccessors;
    if (!session.getRoleModelCycle || !session.applyRoleModel) return false;
    const { MODEL_ROLE_IDS } = (await import('@oh-my-pi/pi-coding-agent/config/model-registry')) as unknown as { MODEL_ROLE_IDS: string[] };
    const cycle = session.getRoleModelCycle(MODEL_ROLE_IDS);
    const entry = cycle?.models.find((m) => m.role === role);
    if (!entry) return false;
    await session.applyRoleModel(entry);
    return true;
  }

  /** Set the session's thinking/reasoning level (spins up the session if needed). */
  async setThinkingLevel(target: PiWorkspaceTarget, agentSessionId: string, level: string): Promise<boolean> {
    const session = (await this.ensureActiveSession(target, agentSessionId)) as unknown as ControlSessionAccessors;
    if (!session.setThinkingLevel) return false;
    session.setThinkingLevel(level, true);
    return true;
  }

  /** Set the tool-approval mode (persisted to settings). */
  async setApprovalMode(target: PiWorkspaceTarget, agentSessionId: string, mode: string): Promise<boolean> {
    const session = (await this.ensureActiveSession(target, agentSessionId)) as unknown as ControlSessionAccessors;
    const settings = session.settings ?? (await getPiSettings());
    if (!settings) return false;
    settings.set('tools.approvalMode', mode);
    return true;
  }

  /** List known providers (from the model registry) with their auth status. */
  async getAuthProviders(): Promise<Array<{ provider: string; hasAuth: boolean }>> {
    const [auth, registry] = await Promise.all([createPiAuthStorage(), createPiModelRegistry()]);
    const providers = [...new Set(registry.getAll().map((m) => m.provider))].sort();
    return providers.map((provider) => {
      let hasAuth = false;
      try {
        hasAuth = auth.hasAuth(provider) || auth.has(provider);
      } catch {
        /* ignore */
      }
      return { provider, hasAuth };
    });
  }

  /** Store an API key for a provider. */
  async setProviderApiKey(provider: string, key: string): Promise<boolean> {
    const auth = await createPiAuthStorage();
    await auth.set(provider, { type: 'api_key', key });
    return true;
  }

  /** Start an OAuth sign-in flow; emits auth/prompt/done events via `emit`. */
  async startOAuthLogin(provider: string, flowId: string, emit: (ev: AgentOAuthEvent) => void): Promise<void> {
    const auth = await createPiAuthStorage();
    try {
      await auth.login(provider, {
        onAuth: (info) => emit({ flowId, kind: 'auth', url: info.url, instructions: info.instructions }),
        onPrompt: (prompt) =>
          new Promise<string>((resolve) => {
            this.oauthPrompts.set(flowId, resolve);
            emit({ flowId, kind: 'prompt', message: prompt.message, placeholder: prompt.placeholder });
          }),
      });
      emit({ flowId, kind: 'done', ok: true });
    } catch (e) {
      emit({ flowId, kind: 'done', ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.oauthPrompts.delete(flowId);
    }
  }

  /** Provide the value an in-progress OAuth flow asked for (onPrompt). */
  respondOAuthPrompt(flowId: string, value: string): boolean {
    const resolve = this.oauthPrompts.get(flowId);
    if (!resolve) return false;
    resolve(value);
    this.oauthPrompts.delete(flowId);
    return true;
  }

  /** Read the curated settings catalog with current values. */
  async getSettings(): Promise<Array<{ path: string; label: string; kind: 'boolean' | 'enum'; value: string | boolean | null; options?: string[] }>> {
    const settings = await getPiSettings();
    return SETTINGS_CATALOG.map((c) => {
      let value: string | boolean | null = null;
      try {
        const v = settings?.get(c.path);
        if (typeof v === 'boolean' || typeof v === 'string') value = v;
      } catch {
        /* ignore */
      }
      return { ...c, value };
    });
  }

  /** Write a single setting. */
  async setSetting(path: string, value: string | number | boolean): Promise<boolean> {
    const settings = await getPiSettings();
    if (!settings) return false;
    settings.set(path, value);
    return true;
  }

  /** The full settings schema (grouped client-side by tab) with current values. */
  async getSettingsSchema(): Promise<AgentSettingSchemaItem[]> {
    const settings = await getPiSettings();
    const mod = (await import('@oh-my-pi/pi-coding-agent/config/settings-schema')) as unknown as {
      SETTINGS_SCHEMA: Record<string, { type?: string; values?: readonly string[]; ui?: { tab?: string; label?: string; description?: string; options?: unknown } }>;
    };
    const schema = mod.SETTINGS_SCHEMA ?? {};
    const items: AgentSettingSchemaItem[] = [];
    for (const [path, def] of Object.entries(schema)) {
      const ui = def.ui ?? {};
      const t = def.type;
      const kind: AgentSettingSchemaItem['kind'] =
        t === 'boolean' || t === 'enum' || t === 'number' || t === 'string' || t === 'record' ? t : 'other';
      const options = def.values
        ? [...def.values]
        : Array.isArray(ui.options)
          ? ui.options.map((o) => (typeof o === 'string' ? o : o?.value)).filter((v): v is string => typeof v === 'string')
          : undefined;
      let value: string | number | boolean | null = null;
      try {
        const v = settings?.get(path);
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') value = v;
      } catch {
        /* ignore */
      }
      items.push({ path, tab: ui.tab ?? 'other', label: ui.label ?? path, description: ui.description, kind, value, options });
    }
    return items;
  }

  /** Tools available to the active session (for per-tool approval). The SDK
   *  doesn't expose the live tool registry on the session instance, so fall
   *  back to the standard tool set; merge in any registry entries + overrides. */
  async getTools(_target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentToolInfo[]> {
    const session = this.activeSessions.get(agentSessionId) as unknown as ControlSessionAccessors | undefined;
    let approvals: Record<string, string> = {};
    try {
      const a = (session?.settings ?? (await getPiSettings()))?.get('tools.approval');
      if (a && typeof a === 'object') approvals = a as Record<string, string>;
    } catch {
      /* ignore */
    }
    const tiers = new Map<string, string>(DEFAULT_TOOL_TIERS);
    const reg = session?.toolRegistry;
    if (reg) for (const t of reg.values()) if (t.name) tiers.set(t.name, t.tier ?? 'exec');
    for (const name of Object.keys(approvals)) if (!tiers.has(name)) tiers.set(name, 'exec');
    return [...tiers.entries()]
      .map(([name, tier]) => ({ name, tier, approval: approvals[name] ?? 'default' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Compact the session context. */
  async compactSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const session = (await this.ensureActiveSession(target, agentSessionId)) as unknown as ControlSessionAccessors;
    if (!session.compact) return false;
    await session.compact();
    return true;
  }

  /** User-message checkpoints in the current branch (for conversation rewind). */
  async getHistory(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentHistoryEntry[]> {
    const session = (this.activeSessions.get(agentSessionId) ?? (await this.ensureActiveSession(target, agentSessionId))) as unknown as ControlSessionAccessors;
    const all = session.getUserMessagesForBranching?.() ?? [];
    // getUserMessagesForBranching returns user messages across the WHOLE tree
    // (creation order), so restrict to the current branch (leaf → root) and mark
    // the branch tip as current — otherwise "current" would always be the
    // last-created turn regardless of where the leaf sits after a rewind.
    const branchIds = new Set((session.sessionManager?.getBranch?.() ?? []).map((e) => e.id));
    const inBranch = branchIds.size > 0 ? all.filter((m) => branchIds.has(m.entryId)) : all;
    return inBranch.map((m, i) => ({ entryId: m.entryId, text: m.text, current: i === inBranch.length - 1 }));
  }

  /** Rewind the conversation to a prior user-message turn. navigateTree moves
   *  the leaf to the message's parent (so complete prior turns remain and the
   *  message returns to the editor) and rebuilds the agent context in-memory;
   *  the transcript then re-reads from this same live manager. Falls back to a
   *  raw leaf move if navigateTree is unavailable. */
  async navigateHistory(target: PiWorkspaceTarget, agentSessionId: string, entryId: string): Promise<boolean> {
    const session = (await this.ensureActiveSession(target, agentSessionId)) as unknown as ControlSessionAccessors;
    if (session.navigateTree) {
      const result = await session.navigateTree(entryId, { summarize: false });
      return !result?.cancelled;
    }
    if (session.sessionManager?.branch) {
      session.sessionManager.branch(entryId);
      return session.sessionManager.getLeafId?.() === entryId;
    }
    return false;
  }

  /** Switch the session's model. Spins up the session if needed. */
  async setModel(target: PiWorkspaceTarget, agentSessionId: string, provider: string, modelId: string): Promise<boolean> {
    const registry = await createPiModelRegistry();
    const model = registry.find(provider, modelId);
    if (!model) return false;
    const session = await this.ensureActiveSession(target, agentSessionId);
    await session.setModel(model);
    return true;
  }

  /**
   * Create a new Pi agent session in-process so we get the canonical session ID
   * immediately and can subscribe to live events. tmux terminals are created later
   * when the user explicitly attaches.
   */
  async createAgentSession(target: PiWorkspaceTarget, title?: string): Promise<PiAgentSessionSummary[]> {
    const { createAgentSession: createPiAgentSessionSdk, discoverSkills } = await importSdk();
    const { agentDir, sessionManager } = await createPiSessionManager(target.workspacePath);
    const managedBootstrap = await getManagedSessionBootstrap(target.workspacePath, agentDir, discoverSkills);
    const result = await createPiAgentSessionSdk({
      agentDir,
      sessionManager,
      cwd: target.workspacePath,
      additionalExtensionPaths: getManagedPiExtensionPaths(),
      skills: managedBootstrap.skills,
      hasUI: true,
    });
    const { session, setToolUIContext } = result as unknown as OmpCreateSessionResult;
    if (!session?.sessionId || typeof setToolUIContext !== 'function') {
      throw new Error('Unexpected createAgentSession result shape — SDK version may be incompatible');
    }
    if (title) {
      await sessionManager.setSessionName(title);
    }
    await persistInitialPiSessionModel(session);
    await sessionManager.rewriteEntries();

    const sessionId = session.sessionId;
    this.activeSessions.set(sessionId, session);
    this.sessionWorkspaceIds.set(sessionId, target.workspaceId);
    this.bindSessionEvents(target, sessionId, title, session);
    this.bindHostUI(sessionId, setToolUIContext);

    const sessionFile = await this.waitForSessionFile(target.workspacePath, sessionId);
    if (!sessionFile) {
      await this.disposeActiveSession(sessionId);
      throw new Error(
        `Timed out waiting for Pi to create a session file for workspace '${target.workspaceId}'.`,
      );
    }

    const sessions = await this.refreshAgentSessions(target);
    const created = sessions.find((existing) => existing.id === sessionId) ?? {
      id: sessionId,
      workspaceId: target.workspaceId,
      title: title ?? sessionFile.title ?? sessionFile.firstMessage ?? 'New session',
      updatedAt: sessionFile.modified.toISOString(),
    };

    return mergeCreatedSession(sessions, created);
  }

  async closeAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    let killed = false;
    let foundTerminalSessionId: string | null = null;
    try {
      const sessions = await listTmuxSessions();
      const pty = sessions.find((s) => isLikelyAgentTmuxSession(s, target, agentSessionId))
        ?? this.findMappedTmuxSession(sessions, target.workspaceId, agentSessionId);
      if (pty) {
        foundTerminalSessionId = pty.id;
        try {
          await terminateTmuxSession(pty.id);
          killed = true;
        } catch {
          // Kill failed (session already dead?) — still release below
        }
      }
    } catch {
      // listTmuxSessions failed — still try to dispose SDK session below
    }
    if (foundTerminalSessionId) {
      this.releaseTerminalSession(foundTerminalSessionId);
    }
    // Always dispose the SDK session if no terminal owners remain
    if (!this.hasTerminalOwners(target.workspaceId, agentSessionId)) {
      await this.disposeActiveSession(agentSessionId);
    }
    return killed;
  }

  /**
   * Interrupt the agent's current turn without killing the session.
   * Calls the Pi SDK's session.abort() which stops LLM streaming and tool
   * execution, then waits for the agent to become idle. The session stays
   * alive and can accept new prompts afterward.
   *
   * Compare with closeAgentSession() which kills the tmux terminal session.
   */
  async interruptAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(agentSessionId);
    if (!session) {
      return false;
    }
    try {
      await Promise.race([
        session.abort(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Interrupt timed out')), 10000),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async promptAgentSession(target: PiWorkspaceTarget, agentSessionId: string, text: string, images?: import('../protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    const traceStartMs = Date.now();
    const session = await this.ensureActiveSession(target, agentSessionId);
    writeTraceLog('agent-prompt-session-ready', {
      workspaceId: target.workspaceId,
      agentSessionId,
      durationMs: Date.now() - traceStartMs,
      textLength: text.length,
      imageCount: images?.length ?? 0,
      streamingBehavior: options?.streamingBehavior,
    });

    const trimmed = text.trim();
    // Intercept /compact — start compaction directly instead of routing through
    // prompt(). Remote prompt_agent_session expects an immediate acceptance ack,
    // so awaiting compaction here can exceed the transport command timeout.
    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      if (typeof session.compact === 'function') {
        const instructions = trimmed.startsWith('/compact ') ? trimmed.slice('/compact '.length).trim() : undefined;
        writeTraceLog('agent-compact-dispatched', {
          workspaceId: target.workspaceId,
          agentSessionId,
          durationMs: Date.now() - traceStartMs,
        });
        session.compact(instructions || undefined)
          .catch((err: unknown) => {
            const error = err instanceof Error ? err.message : String(err);
            console.error(`[pi-coordinator] compact failed for session ${agentSessionId}:`, err);
            if (this.eventHandler) {
              this.eventHandler(target, { type: 'error', sessionId: agentSessionId, error });
            }
          });
        return;
      }
    }

    const piImages = images?.length
      ? { images: images.map(img => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })) }
      : undefined;
    // Turn accepted: ok responds immediately. Turn progress and completion flow through existing agent/machine events.
    writeTraceLog('agent-prompt-dispatch', {
      workspaceId: target.workspaceId,
      agentSessionId,
      durationMs: Date.now() - traceStartMs,
      textLength: text.length,
    });
    session.prompt(text, { ...piImages, streamingBehavior: options?.streamingBehavior })
      .then(() => {
        writeTraceLog('agent-prompt-complete', {
          workspaceId: target.workspaceId,
          agentSessionId,
          durationMs: Date.now() - traceStartMs,
        });
        this.emitQueuedMessages(target, agentSessionId, session);
      })
      .catch((err: unknown) => {
        writeTraceLog('agent-prompt-error', {
          workspaceId: target.workspaceId,
          agentSessionId,
          durationMs: Date.now() - traceStartMs,
          error: err instanceof Error ? err.message : String(err),
        });
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[pi-coordinator] prompt failed for session ${agentSessionId}:`, err);
        if (this.eventHandler) {
          this.eventHandler(target, { type: 'error', sessionId: agentSessionId, error });
        }
      });
  }

  async removeQueuedAgentMessage(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    kind: 'steering' | 'followUp',
    index: number,
  ): Promise<string | null> {
    const session = await this.ensureActiveSession(target, agentSessionId);
    const removed = session.removeQueuedMessage?.(kind, index);
    this.emitQueuedMessages(target, agentSessionId, session);
    return typeof removed === 'string' ? removed : null;
  }

  async archiveAgentSession(target: PiWorkspaceTarget, agentSessionId: string, title: string): Promise<void> {
    upsertArchivedSession({
      workspaceId: target.workspaceId,
      sessionId: agentSessionId,
      title,
      archivedAt: new Date().toISOString(),
    });
  }

  async restoreAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<void> {
    deleteArchivedSession(target.workspaceId, agentSessionId);
  }

  getTerminalBinding(terminalSessionId: string): TerminalSessionBinding | null {
    return this.terminalBindings.get(terminalSessionId) ?? null;
  }

  hasTerminalOwners(workspaceId: string, agentSessionId: string): boolean {
    return this.getTerminalOwnerCount(workspaceId, agentSessionId) > 0;
  }

  rebindTerminalSession(
    workspaceId: string,
    terminalSessionId: string,
    nextAgentSessionId: string,
  ): { previousAgentSessionId?: string; previousOwnerCount: number; nextOwnerCount: number } {
    const existing = this.terminalBindings.get(terminalSessionId);
    if (existing && existing.workspaceId !== workspaceId) {
      throw new Error(
        `Cannot rebind tmux session '${terminalSessionId}' from workspace '${existing.workspaceId}' to '${workspaceId}'.`,
      );
    }
    const previous = this.unbindTerminalSession(terminalSessionId);
    const nextOwnerCount = this.bindTerminalSession(workspaceId, terminalSessionId, nextAgentSessionId);
    const previousOwnerCount = previous ? this.getTerminalOwnerCount(previous.workspaceId, previous.agentSessionId) : 0;
    if (previous && previousOwnerCount === 0 && previous.agentSessionId !== nextAgentSessionId) {
      void this.disposeActiveSession(previous.agentSessionId).catch((err) => {
        console.error(`[pi-coordinator] Failed to dispose agent session ${previous.agentSessionId}:`, err);
      });
    }
    return {
      previousAgentSessionId: previous?.agentSessionId,
      previousOwnerCount,
      nextOwnerCount,
    };
  }

  releaseTerminalSession(
    terminalSessionId: string,
  ): { workspaceId: string; agentSessionId: string; remainingOwnerCount: number } | null {
    const binding = this.unbindTerminalSession(terminalSessionId);
    if (!binding) return null;
    const remainingOwnerCount = this.getTerminalOwnerCount(binding.workspaceId, binding.agentSessionId);
    if (remainingOwnerCount === 0) {
      void this.disposeActiveSession(binding.agentSessionId).catch((err) => {
        console.error(`[pi-coordinator] Failed to dispose agent session ${binding.agentSessionId}:`, err);
      });
    }
    return {
      ...binding,
      remainingOwnerCount,
    };
  }

  /**
   * Ensure a tmux-lite virtual terminal session exists for a Pi agent session.
   * Uses Pi's session ID to find and resume the right JSONL file.
   * Throws if the session file is not found (prevents silent mismatch).
   */
  async ensureAgentTerminalSession(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile?: PiSessionFileInfo,
    options?: { cols?: number; rows?: number },
  ): Promise<TmuxSession> {
    const key = `${target.workspaceId}:${agentSessionId}`;
    const inFlight = this.inflightTerminalSessions.get(key);
    if (inFlight) return inFlight;

    const ensurePromise = this.ensureAgentTerminalSessionInternal(target, agentSessionId, sessionFile, options).finally(() => {
      this.inflightTerminalSessions.delete(key);
    });
    this.inflightTerminalSessions.set(key, ensurePromise);
    return ensurePromise;
  }

  private async ensureAgentTerminalSessionInternal(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile?: PiSessionFileInfo,
    options?: { cols?: number; rows?: number },
  ): Promise<TmuxSession> {
    const match = sessionFile ?? findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!match) {
      throw new Error(
        `Pi session '${agentSessionId}' not found for workspace '${target.workspaceId}'. ` +
        `The session file may have been deleted or the ID is stale.`,
      );
    }

    const tmuxSessions = await listTmuxSessions();
    const existing = tmuxSessions.find((s) => isLikelyAgentTmuxSession(s, target, agentSessionId))
      ?? this.findMappedTmuxSession(tmuxSessions, target.workspaceId, agentSessionId);
    if (existing) {
      if (existing.exitCode === undefined) {
        if (options?.cols && options?.rows) {
          await resizeTmuxVirtualSession(existing.id, options.cols, options.rows);
        }
        this.bindTerminalSession(target.workspaceId, existing.id, agentSessionId);
        return existing;
      }
      this.releaseTerminalSession(existing.id);
    }

    const staleModeHandle = this.virtualModeHandles.get(agentSessionId);
    if (staleModeHandle) {
      await this.stopVirtualMode(agentSessionId);
    }


    return this.createVirtualAgentSession(target, agentSessionId, match, options);
  }

  private async createVirtualAgentSession(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile: PiSessionFileInfo,
    options?: { cols?: number; rows?: number },
  ): Promise<TmuxSession> {
    const sdkSession = await this.ensureActiveSession(target, agentSessionId, sessionFile);
    const tmuxSession = await createTmuxVirtualSession(
      buildAgentTerminalSessionName(target, agentSessionId),
      target.workspacePath,
      {
        cols: options?.cols,
        rows: options?.rows,
        kind: PI_AGENT_TMUX_SESSION_KIND,
        hidden: true,
        metadata: {
          workspaceId: target.workspaceId,
          agentSessionId,
        },
      },
    );

    const virtualTerminal = getVirtualTerminal(tmuxSession.id);
    if (!virtualTerminal) {
      await terminateTmuxSession(tmuxSession.id).catch(() => {});
      throw new Error('VirtualTerminal not found in registry after session creation');
    }

    try {
      const handle = await startVirtualInteractiveMode(sdkSession, virtualTerminal, {
        cwd: target.workspacePath,
        agentDir: process.env.PI_CODING_AGENT_DIR,
      });
      this.virtualModeHandles.set(agentSessionId, handle);
      this.bindTerminalSession(target.workspaceId, tmuxSession.id, agentSessionId);
      return tmuxSession;
    } catch (error) {
      await terminateTmuxSession(tmuxSession.id).catch(() => {});
      throw error;
    }
  }


  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureActiveSession(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile: PiSessionFileInfo | null = null,
  ): Promise<OmpAgentSession> {
    const existing = this.activeSessions.get(agentSessionId);
    if (existing) {
      return existing;
    }

    const existingInFlight = this.inflightActiveSessions.get(agentSessionId);
    if (existingInFlight) {
      return existingInFlight;
    }

    const ensurePromise = (async () => {
      try {
        const match = sessionFile ?? findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
        if (!match) {
          throw new Error(
            `Pi session '${agentSessionId}' not found for workspace '${target.workspaceId}'. ` +
            `The session file may have been deleted or the ID is stale.`,
          );
        }

        const { session, setToolUIContext } = await openPiSession(target.workspacePath, match.path);
        if (session.sessionId !== agentSessionId) {
          session.dispose();
          throw new Error(
            `Pi session file '${match.path}' reopened as '${session.sessionId}', expected '${agentSessionId}'.`,
          );
        }

        this.activeSessions.set(agentSessionId, session);
        this.sessionWorkspaceIds.set(agentSessionId, target.workspaceId);
        this.bindSessionEvents(
          target,
          agentSessionId,
          match.title ?? match.firstMessage ?? undefined,
          session,
        );
        this.bindHostUI(agentSessionId, setToolUIContext);
        return session;
      } finally {
        this.inflightActiveSessions.delete(agentSessionId);
      }
    })();

    this.inflightActiveSessions.set(agentSessionId, ensurePromise);
    return ensurePromise;
  }

  private emitQueuedMessages(target: PiWorkspaceTarget, sessionId: string, session: OmpAgentSession): void {
    if (!this.eventHandler || typeof session.getQueuedMessages !== 'function') return;
    this.eventHandler(target, {
      type: 'queued_messages',
      sessionId,
      queued: session.getQueuedMessages(),
    });
  }

  private shouldEmitQueuedMessagesForEvent(piEvent: { type?: string; [key: string]: unknown }): boolean {
    if (piEvent.type === 'message_start') {
      return isRecord(piEvent.message) && piEvent.message.role === 'user';
    }
    return false;
  }


  private bindSessionEvents(
    target: PiWorkspaceTarget,
    sessionId: string,
    title: string | undefined,
    session: OmpAgentSession,
  ): void {
    const existing = this.sessionUnsubscribers.get(sessionId);
    existing?.();

    const summaryTitle = title ?? sessionId;
    const unsubscribers: Array<() => void> = [];

    // --- SDK session events (subscribe delivers all lifecycle + tool events) ---
    unsubscribers.push(
      session.subscribe((piEvent: { type?: string; [key: string]: unknown }) => {
        if (!this.eventHandler || typeof piEvent.type !== 'string') return;

        // Live transcript suffix: fold the SDK event stream into the in-progress
        // turn's blocks and emit (re-rendered each update, committed on turn end).
        let liveTurn = this.liveTurns.get(sessionId);
        if (!liveTurn) {
          liveTurn = new LiveTurn();
          this.liveTurns.set(sessionId, liveTurn);
        }
        const live = liveTurn.apply(piEvent as unknown as SdkAgentEvent);
        if (live) {
          this.eventHandler(target, { type: 'transcript_live', sessionId, blocks: live.blocks, committed: live.committed });
        }

        if (this.shouldEmitQueuedMessagesForEvent(piEvent)) {
          this.emitQueuedMessages(target, sessionId, session);
        }
        switch (piEvent.type) {
          case 'message_update':
            this.eventHandler(target, {
              type: 'message',
              sessionId,
              payload: { ...piEvent, title: summaryTitle },
            });
            return;

          case 'agent_start':
            this.eventHandler(target, {
              type: 'status',
              sessionId,
              payload: { type: 'busy', event: piEvent },
            });
            return;

          case 'agent_end':
            this.eventHandler(target, {
              type: 'status',
              sessionId,
              payload: { type: 'idle', event: piEvent },
            });
            return;

          case 'auto_retry_start': {
            const errorMessage = typeof piEvent.errorMessage === 'string' ? piEvent.errorMessage : 'Retrying...';
            this.eventHandler(target, {
              type: 'error',
              sessionId,
              error: errorMessage,
            });
            this.eventHandler(target, {
              type: 'status',
              sessionId,
              payload: {
                type: 'retry',
                attempt: typeof piEvent.attempt === 'number' ? piEvent.attempt : 1,
                message: errorMessage,
                next: Date.now() + (typeof piEvent.delayMs === 'number' ? piEvent.delayMs : 0),
              },
            });
            return;
          }

          case 'auto_retry_end': {
            const success = piEvent.success === true;
            // Restore busy/idle first — then set error so it isn't wiped by status clear.
            this.eventHandler(target, {
              type: 'status',
              sessionId,
              payload: { type: success ? 'busy' : 'idle', event: piEvent },
            });
            if (!success && typeof piEvent.finalError === 'string') {
              this.eventHandler(target, { type: 'error', sessionId, error: piEvent.finalError });
            }
            return;
          }

          // Ask tool: track pending questions
          case 'tool_execution_start':
          case 'tool_call': {
            const toolName = piEvent.toolName ?? piEvent.tool_name;
            if (toolName !== 'ask') break;
            const toolCallId = String(piEvent.toolCallId ?? piEvent.tool_call_id ?? '');
            if (!toolCallId) break;
            const input = isRecord(piEvent.input) ? piEvent.input : {};
            this.eventHandler(target, {
              type: 'question_added',
              sessionId,
              question: buildPendingQuestion(toolCallId, sessionId, input),
            });
            return;
          }

          case 'tool_execution_end':
          case 'tool_result': {
            const toolName = piEvent.toolName ?? piEvent.tool_name;
            // Always extract todo phases from tool_execution_end regardless of tool
            const phases = (session as any).getTodoPhases?.();
            if (Array.isArray(phases)) {
              this.eventHandler(target, {
                type: 'status',
                sessionId,
                payload: { type: 'todo_update', phases },
              });
            }
            if (toolName !== 'ask') break;
            const toolCallId = String(piEvent.toolCallId ?? piEvent.tool_call_id ?? '');
            if (!toolCallId) break;
            this.eventHandler(target, {
              type: 'question_removed',
              sessionId,
              questionId: toolCallId,
            });
            return;
          }

          case 'todo_reminder': {
            const phases = (session as any).getTodoPhases?.();
            if (Array.isArray(phases)) {
              this.eventHandler(target, {
                type: 'status',
                sessionId,
                payload: { type: 'todo_update', phases },
              });
            }
            break;
          }

          case 'model_change': {
            const model = (session as any).model;
            if (model) {
              this.eventHandler(target, {
                type: 'status',
                sessionId,
                payload: { type: 'model_update', name: model.name, provider: model.provider },
              });
            }
            break;
          }
        }
      }),
    );

    // --- Permission events via SDK internal event bus ---
    // The SDK emits permission-gate events on its event bus. Since the agent
    // runs in-process, we can subscribe directly instead of loading an extension.
    const eventBus = (session as any).events ?? (session as any)._eventBus ?? (session as any).extensionEvents;
    if (eventBus && typeof eventBus.on === 'function') {
      const waitingHandler = (payload: unknown) => {
        if (!this.eventHandler) return;
        this.eventHandler(target, {
          type: 'permission_added',
          sessionId,
          permission: buildPermission(sessionId, payload),
        });
      };
      const resolvedHandler = (payload: unknown) => {
        if (!this.eventHandler) return;
        this.eventHandler(target, {
          type: 'permission_removed',
          sessionId,
          permissionId: permissionIdFromPayload(payload),
        });
      };
      for (const channel of ['gitspace:permission.waiting', 'permission-gate:waiting']) {
        eventBus.on(channel, waitingHandler);
      }
      for (const channel of ['gitspace:permission.resolved', 'permission-gate:resolved']) {
        eventBus.on(channel, resolvedHandler);
      }
      // Cleanup for event bus listeners if the bus supports off/removeListener
      if (typeof eventBus.off === 'function') {
        unsubscribers.push(() => {
          for (const channel of ['gitspace:permission.waiting', 'permission-gate:waiting']) {
            eventBus.off(channel, waitingHandler);
          }
          for (const channel of ['gitspace:permission.resolved', 'permission-gate:resolved']) {
            eventBus.off(channel, resolvedHandler);
          }
        });
      }
    }

    this.sessionUnsubscribers.set(sessionId, () => {
      for (const unsub of unsubscribers) unsub();
    });
  }

  private async stopVirtualMode(sessionId: string): Promise<void> {
    const modeHandle = this.virtualModeHandles.get(sessionId);
    if (!modeHandle) return;
    this.virtualModeHandles.delete(sessionId);
    try {
      await Promise.race([
        modeHandle.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Shutdown failed or timed out — caller will continue cleanup/recreate.
    }
  }


  private async disposeActiveSession(sessionId: string): Promise<void> {
    const unsubscribe = this.sessionUnsubscribers.get(sessionId);
    unsubscribe?.();
    this.sessionUnsubscribers.delete(sessionId);
    this.sessionUIBinders.delete(sessionId);
    this.hostUIBridge.rejectAllForSession(sessionId, `Agent session disposed: ${sessionId}`);

    await this.stopVirtualMode(sessionId);

    const session = this.activeSessions.get(sessionId);
    if (session) {
      this.activeSessions.delete(sessionId);
      this.sessionWorkspaceIds.delete(sessionId);
      // Pi SDK has module-level postmortem signal handlers that can call
      // process.exit() during dispose, which would kill the entire tmux-lite
      // server and all sessions. Guard against both thrown errors and exit.
      const originalExit = process.exit;
      try {
        process.exit = ((code?: number) => {
          console.error(`[pi-coordinator] Blocked process.exit(${code}) during session dispose for ${sessionId}`);
        }) as never;
        session.dispose();
      } catch (err) {
        console.error(`[pi-coordinator] session.dispose() threw for ${sessionId}:`, err);
      } finally {
        process.exit = originalExit;
      }
    }
  }

  /**
   * Store the SDK's setToolUIContext binder for a session.
   * If a host UI context is already installed, apply it immediately.
   */
  private bindHostUI(
    sessionId: string,
    setToolUIContext: OmpCreateSessionResult['setToolUIContext'],
  ): void {
    this.sessionUIBinders.set(sessionId, setToolUIContext);
    if (this.hostUIEmitter) {
      setToolUIContext(this.hostUIBridge.createContextForSession(sessionId, this.hostUIEmitter), true);
    }
  }

  private getBindingKey(workspaceId: string, agentSessionId: string): string {
    return `${workspaceId}:${agentSessionId}`;
  }

  private getTerminalOwnerCount(workspaceId: string, agentSessionId: string): number {
    return this.terminalSessionIdsByAgentKey.get(this.getBindingKey(workspaceId, agentSessionId))?.size ?? 0;
  }

  private bindTerminalSession(
    workspaceId: string,
    terminalSessionId: string,
    agentSessionId: string,
  ): number {
    const key = this.getBindingKey(workspaceId, agentSessionId);
    let terminalIds = this.terminalSessionIdsByAgentKey.get(key);
    if (!terminalIds) {
      terminalIds = new Set();
      this.terminalSessionIdsByAgentKey.set(key, terminalIds);
    }
    terminalIds.add(terminalSessionId);
    this.terminalBindings.set(terminalSessionId, { workspaceId, agentSessionId });
    return terminalIds.size;
  }

  private unbindTerminalSession(terminalSessionId: string): TerminalSessionBinding | null {
    const binding = this.terminalBindings.get(terminalSessionId);
    if (!binding) return null;
    this.terminalBindings.delete(terminalSessionId);
    const key = this.getBindingKey(binding.workspaceId, binding.agentSessionId);
    const terminalIds = this.terminalSessionIdsByAgentKey.get(key);
    terminalIds?.delete(terminalSessionId);
    if (terminalIds && terminalIds.size === 0) {
      this.terminalSessionIdsByAgentKey.delete(key);
    }
    return binding;
  }

  private async waitForSessionFile(
    workspacePath: string,
    sessionId: string,
  ): Promise<PiSessionFileInfo | null> {
    const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const match = findPiSessionFile(workspacePath, sessionId, this.sessionsRoot);
      if (match) {
        return match;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_DISCOVERY_POLL_MS));
    }
    return null;
  }

  private findMappedTmuxSession(
    tmuxSessions: TmuxSession[],
    workspaceId: string,
    agentSessionId: string,
  ): TmuxSession | undefined {
    const key = this.getBindingKey(workspaceId, agentSessionId);
    const mappedTmuxIds = this.terminalSessionIdsByAgentKey.get(key);
    if (!mappedTmuxIds || mappedTmuxIds.size === 0) return undefined;
    for (const mappedTmuxId of [...mappedTmuxIds]) {
      const match = tmuxSessions.find((s) => s.id === mappedTmuxId);
      if (match) {
        return match;
      }
      this.releaseTerminalSession(mappedTmuxId);
    }
    return undefined;
  }

  async runSpaceCommand(target: PiWorkspaceTarget, argsText: string): Promise<string> {
    const { execCommand } = await importExecModule();
    const args = parseCommandArgs(argsText);
    return executeSpaceCommand(
      {
        exec: async (command, commandArgs, options) => {
          const result = await execCommand(command, commandArgs, options?.cwd ?? target.workspacePath, options);
          return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed ?? false };
        },
      },
      { cwd: target.workspacePath },
      args,
    );
  }
  async listAvailableCommands(target: PiWorkspaceTarget): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>> {
    const commands: Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }> = [];

    // 0. Built-in commands supported through the web surface. `space` is
    // installed as a managed extension for active sessions, but it must be
    // discoverable before the first session has loaded its extension runner.
    commands.push(
      { name: 'compact', description: 'Compact the session context', kind: 'extension' },
      { name: 'space', description: 'Run GitSpace workspace-scoped commands', kind: 'extension' },
    );
    // 1. Collect extension/custom/skill commands from the active session for the requested workspace
    //    (commands are workspace-scoped; skip any session belonging to a different workspace).
    for (const [sessionId, session] of this.activeSessions) {
      if (this.sessionWorkspaceIds.get(sessionId) !== target.workspaceId) continue;
      try {
        const reserved = new Set(commands.map((command) => command.name));
        const skillCommands = session.skills?.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description ?? '',
          kind: 'extension' as const,
        })) ?? [];
        for (const cmd of skillCommands) {
          if (cmd.name && !commands.some((command) => command.name === cmd.name)) {
            commands.push(cmd);
            reserved.add(cmd.name);
          }
        }

        const extensionCommands = session.extensionRunner?.getRegisteredCommands(reserved) ?? [];
        for (const cmd of extensionCommands) {
          if (cmd?.name && !commands.some((command) => command.name === cmd.name)) {
            commands.push({
              name: cmd.name,
              description: cmd.description ?? '',
              kind: 'extension',
            });
          }
        }

        const customCmds = (session as any).customCommands;
        if (Array.isArray(customCmds)) {
          for (const cmd of customCmds) {
            if (cmd?.command?.name && !commands.some(command => command.name === cmd.command.name)) {
              commands.push({
                name: cmd.command.name,
                description: cmd.command.description ?? '',
                kind: 'custom',
              });
            }
          }
        }
      } catch {
        // Non-fatal
      }
      break; // Only need one session's commands since they're workspace-scoped
    }

    // 2. Discover file-based slash commands from the workspace
    try {
      const { loadSlashCommands: discoverSlashCommands } = await importSlashCommands();
      const slashCommands = await discoverSlashCommands({ cwd: target.workspacePath });
      for (const cmd of slashCommands) {
        if (!commands.some(c => c.name === cmd.name)) {
          commands.push({
            name: cmd.name,
            description: cmd.description ?? '',
            kind: 'file',
          });
        }
      }
    } catch {
      // Non-fatal — slash command discovery can fail for workspaces without Pi config
    }
    return commands;
  }

}

function mergeCreatedSession(
  sessions: PiAgentSessionSummary[],
  created: PiAgentSessionSummary,
): PiAgentSessionSummary[] {
  const merged = new Map<string, PiAgentSessionSummary>();
  merged.set(created.id, created);
  for (const session of sessions) {
    const existing = merged.get(session.id);
    merged.set(session.id, existing
      ? {
          ...session,
          title: existing.title || session.title,
          updatedAt: existing.updatedAt ?? session.updatedAt,
        }
      : session);
  }
  return Array.from(merged.values()).sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
}

export const defaultPiCoordinator = new PiCoordinator();
