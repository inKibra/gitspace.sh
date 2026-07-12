/**
 * LocalSessionHost — owns exactly ONE live OMP AgentSession in the current
 * process and implements the full AgentSessionHost surface against it.
 *
 * This is the code that used to live inline in PiCoordinator. It runs:
 *   - in the daemon process (in-process mode), or
 *   - inside a per-session worker child process (worker mode), where the
 *     sinks serialize straight onto the IPC channel.
 *
 * Everything session-scoped lives here: the SDK event subscription →
 * AgentEvent mapping, LiveTurn transcript folding, the host-UI bridge,
 * control-surface accessors, and the pi-tui interactive terminal.
 */

import type { AgentEvent } from '../../../agents/backend.js';
import type {
  AgentControlInfo,
  AgentHistoryEntry,
  AgentToolInfo,
  AgentTreeNode,
  Permission,
} from '../../../agents/agent-runtime-types.js';
import { getTranscriptRange } from '../../../blocks/agent/transcript-source.js';
import type { TranscriptPage, TranscriptSource } from '../../../blocks/agent/transcript-source.js';
import { LiveTurn } from '../../../blocks/agent/live-turn.js';
import type { AgentEvent as SdkAgentEvent } from '@oh-my-pi/pi-agent-core';
import type { AgentPromptImage } from '../protocol.js';
import { recordEditBreadcrumb, flushEditBreadcrumbs } from './edit-breadcrumbs.js';
import { writeTraceLog } from '../../../utils/trace-log.js';
import { HostUIBridgeState, type HostUIDialogResponse } from './host-ui-bridge.js';
import type { OmpAgentSession, OmpCreateSessionResult } from './omp-types.js';
import {
  createPiAuthStorage,
  createPiModelRegistry,
  createPiSessionManager,
  getManagedPiExtensionPaths,
  getPiSettings,
  openPiSession,
  persistInitialPiSessionModel,
  makeLocalProtocolOptions,
  readCycleOrder,
} from './pi-runtime.js';
import { getManagedSessionBootstrap } from './managed-defaults.js';
import { VirtualTerminal } from './virtual-terminal.js';
import { startVirtualInteractiveMode, type VirtualInteractiveModeHandle } from './virtual-interactive-mode.js';
import {
  extractAgentReportInput,
  type AgentSessionHost,
  type SessionCommandInfo,
  type SessionHostBoot,
  type SessionHostSinks,
  type SessionHostTarget,
} from './session-host.js';

// Dynamic import: oh-my-pi has module-level side effects (postmortem signal
// handlers, provider registration) that conflict with OpenTUI when loaded eagerly.
const importSdk = () => import('@oh-my-pi/pi-coding-agent/sdk');

export const THINKING_LEVELS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const APPROVAL_MODES = ['always-ask', 'write', 'yolo'];

/** Standard OMP tools + tiers — used when the live tool registry isn't exposed. */
export const DEFAULT_TOOL_TIERS: ReadonlyArray<[string, string]> = [
  ['read', 'read'], ['ls', 'read'], ['glob', 'read'], ['grep', 'read'], ['web_search', 'read'],
  ['edit', 'write'], ['write', 'write'], ['todo_write', 'write'],
  ['bash', 'exec'], ['task', 'exec'], ['web_fetch', 'exec'], ['browser', 'exec'], ['ssh', 'exec'], ['eval', 'exec'],
];

/** Minimal shape of a SessionManager tree node (entry + children). */
interface SessionTreeNodeLike {
  entry?: { id: string; type?: string; message?: unknown } | null;
  children?: SessionTreeNodeLike[];
}

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
  navigateTree?(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled?: boolean; editorText?: string }>;
  sessionManager?: {
    branch?(branchFromId: string): void;
    getLeafId?(): string | null;
    getBranch?(fromId?: string): Array<{ id: string }>;
    getTree?(): SessionTreeNodeLike[];
    getEntries?(): Array<{ id: string }>;
    getUsageStatistics?(): NonNullable<AgentControlInfo['usage']>;
    buildSessionContext?(): { models?: { default?: string } };
  };
}

/** Best-effort plain text from an AgentMessage content (string or content parts). */
function previewMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((p) => {
        const part = p as { type?: string; text?: string } | undefined;
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
    return text;
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

export interface LocalSessionHostConfig {
  /** Install the host-UI bridge context immediately (dialog routing on). */
  enableUI?: boolean;
}

export class LocalSessionHost implements AgentSessionHost {
  readonly sessionId: string;
  readonly target: SessionHostTarget;

  private readonly session: OmpAgentSession;
  private readonly sinks: SessionHostSinks;
  private readonly setToolUIContext: OmpCreateSessionResult['setToolUIContext'];
  private readonly hostUIBridge = new HostUIBridgeState();
  private readonly liveTurn = new LiveTurn();
  private unsubscribe: (() => void) | null = null;
  private virtualModeHandle: VirtualInteractiveModeHandle | null = null;
  private terminal: VirtualTerminal | null = null;
  /** A turn is in flight (agent_start seen, agent_end not yet), so a
   *  compaction that finishes mid-turn returns to busy rather than idle. */
  private turnActive = false;
  private uiInstalled = false;

  private constructor(args: {
    target: SessionHostTarget;
    session: OmpAgentSession;
    setToolUIContext: OmpCreateSessionResult['setToolUIContext'];
    sinks: SessionHostSinks;
    config: LocalSessionHostConfig;
  }) {
    this.target = args.target;
    this.session = args.session;
    this.setToolUIContext = args.setToolUIContext;
    this.sinks = args.sinks;
    this.sessionId = args.session.sessionId;
    this.bindSessionEvents();
    if (args.config.enableUI) this.enableUI();
  }

  /**
   * Boot a host: create a fresh SDK session or reopen an existing session file.
   * For 'open', throws if the file reopens under a different session id.
   */
  static async boot(
    target: SessionHostTarget,
    boot: SessionHostBoot,
    sinks: SessionHostSinks,
    config: LocalSessionHostConfig = {},
  ): Promise<LocalSessionHost> {
    if (boot.mode === 'open') {
      const { session, setToolUIContext } = await openPiSession(target.workspacePath, boot.sessionFilePath);
      return new LocalSessionHost({ target, session, setToolUIContext, sinks, config });
    }

    const { createAgentSession: createPiAgentSessionSdk, discoverSkills } = await importSdk();
    const { agentDir, sessionManager } = await createPiSessionManager(target.workspacePath);
    const managedBootstrap = await getManagedSessionBootstrap(target.workspacePath, agentDir, discoverSkills);
    const localProtocol = makeLocalProtocolOptions(target.workspacePath);
    const result = await createPiAgentSessionSdk({
      agentDir,
      sessionManager,
      cwd: target.workspacePath,
      additionalExtensionPaths: getManagedPiExtensionPaths(),
      skills: managedBootstrap.skills,
      hasUI: true,
      localProtocolOptions: localProtocol.options,
    });
    const { session, setToolUIContext } = result as unknown as OmpCreateSessionResult;
    if (!session?.sessionId || typeof setToolUIContext !== 'function') {
      throw new Error('Unexpected createAgentSession result shape — SDK version may be incompatible');
    }
    localProtocol.bind(session.sessionId);
    if (boot.title) {
      await sessionManager.setSessionName(boot.title);
    }
    await persistInitialPiSessionModel(session);
    await sessionManager.rewriteEntries();
    return new LocalSessionHost({ target, session, setToolUIContext, sinks, config });
  }

  /** Install the host-UI bridge so extension dialogs route to the native surface. */
  enableUI(): void {
    this.uiInstalled = true;
    this.setToolUIContext(
      this.hostUIBridge.createContextForSession(this.sessionId, {
        emitDialogRequest: (request) => this.sinks.onDialogRequest(request),
        emitEvent: (event) => this.sinks.onUiEvent(event),
      }),
      true,
    );
  }

  get uiEnabled(): boolean {
    return this.uiInstalled;
  }

  // --- conversation ---------------------------------------------------------

  async prompt(text: string, images?: AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    const trimmed = text.trim();
    // Intercept /compact — start compaction directly instead of routing through
    // prompt(). Remote prompt_agent_session expects an immediate acceptance ack,
    // so awaiting compaction here can exceed the transport command timeout.
    if ((trimmed === '/compact' || trimmed.startsWith('/compact ')) && typeof this.session.compact === 'function') {
      const instructions = trimmed.startsWith('/compact ') ? trimmed.slice('/compact '.length).trim() : undefined;
      this.session.compact(instructions || undefined).catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[session-host] compact failed for session ${this.sessionId}:`, err);
        this.sinks.onEvent({ type: 'error', sessionId: this.sessionId, error });
      });
      return;
    }

    const piImages = images?.length
      ? { images: images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })) }
      : undefined;
    // Turn accepted: resolve immediately. Turn progress and completion flow
    // through the event subscription like every other turn.
    this.session.prompt(text, { ...piImages, streamingBehavior: options?.streamingBehavior })
      .then(() => {
        this.emitQueuedMessages();
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        // Fire-and-forget rejection: the prompt RPC already acked, so this is
        // the ONLY server-side record that the SDK swallowed the turn
        // (hypothesis-1 detector for "message never appears").
        writeTraceLog('agent-prompt-sdk-error', { sessionId: this.sessionId, error });
        console.error(`[session-host] prompt failed for session ${this.sessionId}:`, err);
        this.sinks.onEvent({ type: 'error', sessionId: this.sessionId, error });
      });
  }

  /**
   * Interrupt the agent's current turn without killing the session.
   * Calls the Pi SDK's session.abort() which stops LLM streaming and tool
   * execution, then waits for the agent to become idle.
   */
  async interrupt(): Promise<boolean> {
    try {
      await Promise.race([
        this.session.abort(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Interrupt timed out')), 10000),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async compact(instructions?: string): Promise<boolean> {
    const session = this.session as unknown as ControlSessionAccessors;
    if (!session.compact) return false;
    await session.compact(instructions);
    return true;
  }

  async removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<string | null> {
    const removed = this.session.removeQueuedMessage?.(kind, index);
    this.emitQueuedMessages();
    return typeof removed === 'string' ? removed : null;
  }

  // --- control surface --------------------------------------------------------

  async setModel(provider: string, modelId: string): Promise<boolean> {
    const registry = await createPiModelRegistry();
    const model = registry.find(provider, modelId);
    if (!model) return false;
    await this.session.setModel(model);
    return true;
  }

  /** Control-surface snapshot: usage, current model, and the model switcher list. */
  async getControlInfo(): Promise<AgentControlInfo> {
    const active = this.session as unknown as ControlSessionAccessors;
    let usage: AgentControlInfo['usage'] = null;
    try {
      usage = active.sessionManager?.getUsageStatistics?.() ?? null;
    } catch {
      /* usage unavailable */
    }
    let currentModel: string | null = active.sessionManager?.buildSessionContext?.()?.models?.default ?? null;
    // Prefer the live model (reflects a just-applied switch before persist).
    const liveModel = active.model;
    if (liveModel?.provider && liveModel?.id) {
      currentModel = `${liveModel.provider}/${liveModel.id}`;
    }
    let models: AgentControlInfo['models'] = [];
    let rawModels: Array<{ provider: string; id: string; api?: string; contextWindow?: number }> = [];
    try {
      const [registry, auth] = await Promise.all([createPiModelRegistry(), createPiAuthStorage()]);
      const isAuthed = (provider: string): boolean => {
        try {
          return auth.hasAuth(provider) || auth.has(provider);
        } catch {
          return false;
        }
      };
      rawModels = registry.getAll();
      // Limit the switcher to providers the user is signed in to — an unauthed
      // model can't be selected. Always keep the current model so it stays shown.
      models = rawModels
        .filter((m) => isAuthed(m.provider) || `${m.provider}/${m.id}` === currentModel)
        .map((m) => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow ?? null }));
    } catch (err) {
      console.warn('[session-host] model list failed:', err);
    }

    // Session-level controls — thinking + context come from the live session;
    // approval mode is a setting (session settings, or the global singleton).
    const thinkingLevel = active.configuredThinkingLevel?.() ?? active.thinkingLevel ?? null;
    const context = active.getContextUsage?.() ?? null;
    let approvalMode: string | null = null;
    // Fast mode / service tier is PER MODEL FAMILY in 16.x (tier.openai /
    // tier.anthropic / tier.google). Only models whose family exposes a
    // serving-priority knob are "fast-capable"; others have no toggle. We read +
    // write the family-specific setting key so the toggle reflects and realizes.
    let serviceTier: string | null = null;
    let serviceTierKey: string | null = null;
    let fastCapable = false;
    try {
      const settings = active.settings ?? (await getPiSettings());
      const m = settings?.get('tools.approvalMode');
      if (typeof m === 'string') approvalMode = m;

      const { serviceTierFamily } = (await import('@oh-my-pi/pi-ai')) as {
        serviceTierFamily: (model: { provider: string; api?: string; id: string }) => string | undefined;
      };
      const modelObj = liveModel?.provider && liveModel?.id
        ? liveModel
        : rawModels.find((x) => `${x.provider}/${x.id}` === currentModel);
      const family = modelObj ? serviceTierFamily(modelObj as { provider: string; api?: string; id: string }) : undefined;
      fastCapable = !!family;
      if (family) {
        serviceTierKey = `tier.${family}`;
        const st = settings?.get(serviceTierKey);
        if (typeof st === 'string') serviceTier = st;
      }
    } catch {
      /* settings unavailable */
    }

    // Model roles (the quick role cycle) — resolved from the live session,
    // following the user's `cycleOrder` setting (the same order the SDK's own
    // interactive mode passes to getRoleModelCycle), so the cycle shown in the
    // UI matches cycle-membership toggles in settings.
    let roles: AgentControlInfo['roles'] = [];
    let cycleOrder: string[] | null = null;
    try {
      cycleOrder = readCycleOrder(active.settings ?? (await getPiSettings()));
    } catch {
      /* settings unavailable */
    }
    try {
      if (active.getRoleModelCycle) {
        const { MODEL_ROLE_IDS, MODEL_ROLES } = (await import('@oh-my-pi/pi-coding-agent/config/model-roles')) as unknown as {
          MODEL_ROLE_IDS: string[];
          MODEL_ROLES: Record<string, { name?: string }>;
        };
        const cycle = active.getRoleModelCycle(cycleOrder ?? MODEL_ROLE_IDS);
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

    // Full role CATALOG (every MODEL_ROLE + its explicitly-assigned model) for the
    // config UI. Unlike `roles` (the cycle, only configured), this always lists
    // all roles so each can be assigned. `model` is the raw configured selector
    // (null → falls back to the default role).
    let roleCatalog: AgentControlInfo['roleCatalog'] = [];
    try {
      const { MODEL_ROLE_IDS, MODEL_ROLES } = (await import('@oh-my-pi/pi-coding-agent/config/model-roles')) as unknown as {
        MODEL_ROLE_IDS?: string[];
        MODEL_ROLES?: Record<string, { name?: string; description?: string }>;
      };
      const settings = (active.settings ?? (await getPiSettings())) as { getModelRole?: (r: string) => string | undefined } | null;
      roleCatalog = (MODEL_ROLE_IDS ?? []).map((id) => ({
        role: id,
        name: MODEL_ROLES?.[id]?.name ?? id,
        description: MODEL_ROLES?.[id]?.description,
        model: (settings?.getModelRole ? settings.getModelRole(id) : undefined) ?? null,
      }));
    } catch {
      /* role catalog unavailable */
    }

    return {
      usage,
      currentModel,
      models,
      roles,
      roleCatalog,
      cycleOrder: cycleOrder ?? undefined,
      thinkingLevel,
      thinkingLevels: THINKING_LEVELS,
      approvalMode,
      approvalModes: APPROVAL_MODES,
      serviceTier,
      serviceTierKey,
      fastCapable,
      context: context ?? null,
    };
  }

  /** Cycle the active model through the quick-cycle roles (the cmd-P role
   *  cycle). Follows the user's `cycleOrder` setting — the SDK does NOT apply
   *  it internally; its own interactive mode passes settings.get('cycleOrder')
   *  as the roleOrder the same way. */
  async cycleRole(direction: 'forward' | 'backward'): Promise<boolean> {
    const session = this.session as unknown as ControlSessionAccessors;
    if (!session.cycleRoleModels) return false;
    const { MODEL_ROLE_IDS } = (await import('@oh-my-pi/pi-coding-agent/config/model-roles')) as unknown as { MODEL_ROLE_IDS: string[] };
    const order = readCycleOrder(session.settings ?? (await getPiSettings())) ?? MODEL_ROLE_IDS;
    const result = await session.cycleRoleModels(order, direction);
    return !!result;
  }

  /** Apply a specific role's model to the live session. */
  async applyRole(role: string): Promise<boolean> {
    const session = this.session as unknown as ControlSessionAccessors;
    if (!session.getRoleModelCycle || !session.applyRoleModel) return false;
    const { MODEL_ROLE_IDS } = (await import('@oh-my-pi/pi-coding-agent/config/model-roles')) as unknown as { MODEL_ROLE_IDS: string[] };
    const cycle = session.getRoleModelCycle(MODEL_ROLE_IDS);
    const entry = cycle?.models.find((m) => m.role === role);
    if (!entry) return false;
    await session.applyRoleModel(entry);
    return true;
  }

  async setThinkingLevel(level: string): Promise<boolean> {
    const session = this.session as unknown as ControlSessionAccessors;
    if (!session.setThinkingLevel) return false;
    session.setThinkingLevel(level, true);
    return true;
  }

  /** Set the tool-approval mode (persisted to settings). */
  async setApprovalMode(mode: string): Promise<boolean> {
    const session = this.session as unknown as ControlSessionAccessors;
    const settings = session.settings ?? (await getPiSettings());
    if (!settings) return false;
    settings.set('tools.approvalMode', mode);
    return true;
  }

  /** Write a single setting on this session's Settings instance so the live
   *  session sees the change immediately (its singleton is process-local in
   *  worker mode). `modelRoles.<role>` routes through setModelRole so one role
   *  updates without clobbering the record; `task.agentModelOverrides.<agent>`
   *  is merged into that record the same way (dotted record keys are not
   *  schema paths — empty string clears the entry). */
  async setSetting(path: string, value: string | number | boolean | string[]): Promise<boolean> {
    const session = this.session as unknown as ControlSessionAccessors;
    const settings = session.settings ?? (await getPiSettings());
    if (!settings) return false;
    if (path.startsWith('modelRoles.') && typeof value === 'string') {
      const withRole = settings as { setModelRole?: (r: string, m: string) => void };
      if (typeof withRole.setModelRole === 'function') {
        withRole.setModelRole(path.slice('modelRoles.'.length), value);
        return true;
      }
    }
    if (path.startsWith('task.agentModelOverrides.') && typeof value === 'string') {
      const agentName = path.slice('task.agentModelOverrides.'.length);
      let record: Record<string, string> = {};
      try {
        const v = settings.get('task.agentModelOverrides');
        if (v && typeof v === 'object' && !Array.isArray(v)) record = { ...(v as Record<string, string>) };
      } catch {
        /* start from empty */
      }
      if (value.trim()) record[agentName] = value.trim();
      else delete record[agentName];
      settings.set('task.agentModelOverrides', record as never);
      return true;
    }
    settings.set(path, value);
    return true;
  }

  /** Tools available to the live session (for per-tool approval). The SDK
   *  doesn't expose the live tool registry on the session instance, so fall
   *  back to the standard tool set; merge in any registry entries + overrides. */
  async getTools(): Promise<AgentToolInfo[]> {
    const session = this.session as unknown as ControlSessionAccessors;
    let approvals: Record<string, string> = {};
    try {
      const a = (session.settings ?? (await getPiSettings()))?.get('tools.approval');
      if (a && typeof a === 'object') approvals = a as Record<string, string>;
    } catch {
      /* ignore */
    }
    const tiers = new Map<string, string>(DEFAULT_TOOL_TIERS);
    const reg = session.toolRegistry;
    if (reg) for (const t of reg.values()) if (t.name) tiers.set(t.name, t.tier ?? 'exec');
    for (const name of Object.keys(approvals)) if (!tiers.has(name)) tiers.set(name, 'exec');
    return [...tiers.entries()]
      .map(([name, tier]) => ({ name, tier, approval: approvals[name] ?? 'default' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** User-message checkpoints in the current branch (for conversation rewind). */
  async getHistory(): Promise<AgentHistoryEntry[]> {
    const session = this.session as unknown as ControlSessionAccessors;
    const all = session.getUserMessagesForBranching?.() ?? [];
    // getUserMessagesForBranching returns user messages across the WHOLE tree
    // (creation order), so restrict to the current branch (leaf → root) and mark
    // the branch tip as current — otherwise "current" would always be the
    // last-created turn regardless of where the leaf sits after a rewind.
    const branchIds = new Set((session.sessionManager?.getBranch?.() ?? []).map((e) => e.id));
    const inBranch = branchIds.size > 0 ? all.filter((m) => branchIds.has(m.entryId)) : all;
    return inBranch.map((m, i) => ({ entryId: m.entryId, text: m.text, current: i === inBranch.length - 1 }));
  }

  /** Navigate the conversation tree.
   *  - `redo` (default): rewind to the message's parent via navigateTree — the
   *    message leaves the branch and its text is returned as `editorText` so the
   *    client can drop it back into the composer (edit + re-send). The prior path
   *    is preserved as a branch (non-destructive).
   *  - `jump`: make `entryId` itself the leaf (branch), i.e. return to an
   *    arbitrary node/fork without dropping it. */
  async navigateHistory(entryId: string, mode: 'redo' | 'jump' = 'redo'): Promise<{ ok: boolean; editorText?: string }> {
    const session = this.session as unknown as ControlSessionAccessors;
    if (mode === 'jump') {
      if (session.sessionManager?.branch) {
        session.sessionManager.branch(entryId);
        return { ok: session.sessionManager.getLeafId?.() === entryId };
      }
      return { ok: false };
    }
    if (session.navigateTree) {
      const result = await session.navigateTree(entryId, { summarize: false });
      return { ok: !result?.cancelled, editorText: result?.editorText };
    }
    if (session.sessionManager?.branch) {
      session.sessionManager.branch(entryId);
      return { ok: session.sessionManager.getLeafId?.() === entryId };
    }
    return { ok: false };
  }

  /** The conversation tree as a flat list of user/assistant message nodes
   *  (tool results and non-message entries are skipped, their children
   *  re-parented to the nearest kept ancestor). Includes real creation order
   *  (`seq`) and per-turn tool-call counts so text-less turns can be labeled.
   *  Marks the current leaf and the current branch for the explorer view. */
  async getSessionTree(): Promise<AgentTreeNode[]> {
    const session = this.session as unknown as ControlSessionAccessors;
    const sm = session.sessionManager;
    if (!sm?.getTree) return [];
    const leafId = sm.getLeafId?.() ?? null;
    const branchIds = new Set((sm.getBranch?.() ?? []).map((e) => e.id));
    const order = new Map((sm.getEntries?.() ?? []).map((e, i) => [e.id, i]));
    const out: AgentTreeNode[] = [];
    const walk = (node: SessionTreeNodeLike, msgParentId: string | null): void => {
      const entry = node.entry;
      let nextParent = msgParentId;
      if (entry?.type === 'message') {
        const msg = entry.message as { role?: string; content?: unknown } | undefined;
        if (msg?.role === 'user' || msg?.role === 'assistant') {
          const tools = Array.isArray(msg.content)
            ? (msg.content as Array<{ type?: string }>).filter((p) => p?.type === 'toolCall').length
            : 0;
          out.push({
            id: entry.id,
            parentId: msgParentId,
            role: msg.role === 'user' ? 'user' : 'assistant',
            preview: previewMessageText(msg.content).slice(0, 120),
            tools,
            seq: order.get(entry.id),
            current: entry.id === leafId,
            onPath: branchIds.has(entry.id),
          });
          nextParent = entry.id;
        }
      }
      (node.children ?? []).forEach((c) => walk(c, nextParent));
    };
    (sm.getTree() ?? []).forEach((r: SessionTreeNodeLike) => walk(r, null));
    // The leaf may be a skipped entry type (tool result, compaction, …) — mark
    // the deepest emitted on-path node as current so the UI always has an anchor.
    if (!out.some((n) => n.current)) {
      const onPath = out.filter((n) => n.onPath);
      const anchor = onPath.length ? onPath.reduce((a, b) => ((a.seq ?? 0) >= (b.seq ?? 0) ? a : b)) : null;
      if (anchor) anchor.current = true;
    }
    return out;
  }

  /** One page of the transcript from the LIVE in-memory manager, so a leaf
   *  move (conversation rewind via SessionManager.branch) reflects immediately. */
  async readTranscriptRange(opts: { before?: string; limit: number }): Promise<TranscriptPage> {
    const session = this.session as unknown as ControlSessionAccessors;
    if (!session.sessionManager) return { blocks: [], oldestCursor: null, hasMore: false };
    return getTranscriptRange(session.sessionManager as unknown as TranscriptSource, opts);
  }

  /** Commands contributed by the live session: skills, extension, custom. */
  async listSessionCommands(reservedNames: string[]): Promise<SessionCommandInfo[]> {
    const commands: SessionCommandInfo[] = [];
    const reserved = new Set(reservedNames);
    try {
      const skillCommands = this.session.skills?.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description ?? '',
        kind: 'extension' as const,
      })) ?? [];
      for (const cmd of skillCommands) {
        if (cmd.name && !reserved.has(cmd.name)) {
          commands.push(cmd);
          reserved.add(cmd.name);
        }
      }

      const extensionCommands = this.session.extensionRunner?.getRegisteredCommands(reserved) ?? [];
      for (const cmd of extensionCommands) {
        if (cmd?.name && !reserved.has(cmd.name)) {
          commands.push({ name: cmd.name, description: cmd.description ?? '', kind: 'extension' });
          reserved.add(cmd.name);
        }
      }

      const customCmds = (this.session as any).customCommands;
      if (Array.isArray(customCmds)) {
        for (const cmd of customCmds) {
          if (cmd?.command?.name && !reserved.has(cmd.command.name)) {
            commands.push({ name: cmd.command.name, description: cmd.command.description ?? '', kind: 'custom' });
            reserved.add(cmd.command.name);
          }
        }
      }
    } catch {
      // Non-fatal
    }
    return commands;
  }

  // --- host-UI bridge -----------------------------------------------------

  async resolveDialog(response: HostUIDialogResponse): Promise<boolean> {
    return this.hostUIBridge.resolveDialog(response);
  }

  setEditorTextFromClient(text: string): void {
    this.hostUIBridge.setEditorTextFromClient(this.sessionId, text);
  }

  setTitle(title: string | undefined): void {
    this.title = title;
  }

  // --- interactive terminal --------------------------------------------------

  async startTerminal(cols: number, rows: number): Promise<void> {
    if (this.virtualModeHandle) {
      await this.stopTerminal();
    }
    const terminal = new VirtualTerminal(cols, rows, (data) => this.sinks.onTerminalOutput(data));
    const handle = await startVirtualInteractiveMode(this.session, terminal, {
      cwd: this.target.workspacePath,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    });
    this.terminal = terminal;
    this.virtualModeHandle = handle;
  }

  async stopTerminal(): Promise<void> {
    const handle = this.virtualModeHandle;
    if (!handle) return;
    this.virtualModeHandle = null;
    this.terminal = null;
    try {
      await Promise.race([
        handle.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Shutdown failed or timed out — caller will continue cleanup/recreate.
    }
  }

  injectTerminalInput(data: string): void {
    this.terminal?.injectInput(data);
  }

  resizeTerminal(cols: number, rows: number): void {
    this.terminal?.resize(cols, rows);
  }

  // --- lifecycle -----------------------------------------------------------

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.hostUIBridge.rejectAllForSession(this.sessionId, `Agent session disposed: ${this.sessionId}`);
    await this.stopTerminal();
    // Pi SDK has module-level postmortem signal handlers that can call
    // process.exit() during dispose, which (in-process mode) would kill the
    // entire tmux-lite server and all sessions. Guard against both thrown
    // errors and exit.
    const originalExit = process.exit;
    try {
      process.exit = ((code?: number) => {
        console.error(`[session-host] Blocked process.exit(${code}) during session dispose for ${this.sessionId}`);
      }) as never;
      this.session.dispose();
    } catch (err) {
      console.error(`[session-host] session.dispose() threw for ${this.sessionId}:`, err);
    } finally {
      process.exit = originalExit;
    }
  }

  kill(): void {
    void this.dispose().catch(() => undefined);
  }

  // --- internals -----------------------------------------------------------

  private emitQueuedMessages(): void {
    if (typeof this.session.getQueuedMessages !== 'function') return;
    this.sinks.onEvent({
      type: 'queued_messages',
      sessionId: this.sessionId,
      queued: this.session.getQueuedMessages(),
    });
  }

  private shouldEmitQueuedMessagesForEvent(piEvent: { type?: string; [key: string]: unknown }): boolean {
    if (piEvent.type === 'message_start') {
      return isRecord(piEvent.message) && piEvent.message.role === 'user';
    }
    return false;
  }

  private bindSessionEvents(): void {
    const sessionId = this.sessionId;
    const emit = (event: AgentEvent): void => this.sinks.onEvent(event);
    const unsubscribers: Array<() => void> = [];

    // --- SDK session events (subscribe delivers all lifecycle + tool events) ---
    unsubscribers.push(
      this.session.subscribe((piEvent: { type?: string; [key: string]: unknown }) => {
        if (typeof piEvent.type !== 'string') return;

        // Live transcript suffix: fold the SDK event stream into the in-progress
        // turn's blocks and emit (re-rendered each update, committed on turn end).
        const live = this.liveTurn.apply(piEvent as unknown as SdkAgentEvent);
        if (live) {
          emit({ type: 'transcript_live', sessionId, blocks: live.blocks, committed: live.committed });
        }

        if (this.shouldEmitQueuedMessagesForEvent(piEvent)) {
          this.emitQueuedMessages();
        }
        switch (piEvent.type) {
          case 'message_update':
            emit({
              type: 'message',
              sessionId,
              payload: { ...piEvent, title: this.title ?? sessionId },
            });
            return;

          case 'agent_start':
            this.turnActive = true;
            emit({ type: 'status', sessionId, payload: { type: 'busy', event: piEvent } });
            return;

          case 'agent_end': {
            this.turnActive = false;
            // Turn boundary: flush buffered edit breadcrumbs to blame/edits.jsonl.
            void import('../../../core/config.js')
              .then(({ getProjectDir }) => flushEditBreadcrumbs(this.target.workspacePath, getProjectDir(this.target.projectName)))
              .catch(() => undefined);
            emit({ type: 'status', sessionId, payload: { type: 'idle', event: piEvent } });
            return;
          }

          case 'auto_compaction_start':
            emit({ type: 'status', sessionId, payload: { type: 'compacting', event: piEvent } });
            return;

          case 'auto_compaction_end':
            // Return to busy if a turn is still running (auto-compaction happens
            // mid-turn); otherwise idle (a manual /compact while idle).
            emit({
              type: 'status',
              sessionId,
              payload: { type: this.turnActive ? 'busy' : 'idle', event: piEvent },
            });
            return;

          case 'auto_retry_start': {
            const errorMessage = typeof piEvent.errorMessage === 'string' ? piEvent.errorMessage : 'Retrying...';
            emit({ type: 'error', sessionId, error: errorMessage });
            emit({
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
            emit({ type: 'status', sessionId, payload: { type: success ? 'busy' : 'idle', event: piEvent } });
            if (!success && typeof piEvent.finalError === 'string') {
              emit({ type: 'error', sessionId, error: piEvent.finalError });
            }
            return;
          }

          case 'tool_execution_end':
          case 'tool_result': {
            const toolName = piEvent.toolName ?? piEvent.tool_name;
            // Review-guide grounding tier 1: breadcrumb every mutating tool call.
            recordEditBreadcrumb(
              this.target.workspacePath,
              sessionId,
              typeof toolName === 'string' ? toolName : undefined,
              piEvent.input,
            );
            // SDK report_tool_issue → GitSpace report pipeline (origin 'agent').
            // Observed here (sanctioned event stream) rather than patching the SDK.
            const agentReport = extractAgentReportInput(piEvent);
            if (agentReport) this.emitAgentReport(agentReport);
            // Always extract todo phases from tool_execution_end regardless of tool
            const phases = (this.session as any).getTodoPhases?.();
            if (Array.isArray(phases)) {
              emit({ type: 'status', sessionId, payload: { type: 'todo_update', phases } });
            }
            break;
          }

          case 'todo_reminder': {
            const phases = (this.session as any).getTodoPhases?.();
            if (Array.isArray(phases)) {
              emit({ type: 'status', sessionId, payload: { type: 'todo_update', phases } });
            }
            break;
          }

          case 'model_change': {
            const model = (this.session as any).model;
            if (model) {
              emit({
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
    // runs in this process, we can subscribe directly instead of loading an
    // extension.
    const eventBus = (this.session as any).events ?? (this.session as any)._eventBus ?? (this.session as any).extensionEvents;
    if (eventBus && typeof eventBus.on === 'function') {
      const waitingHandler = (payload: unknown) => {
        emit({ type: 'permission_added', sessionId, permission: buildPermission(sessionId, payload) });
      };
      const resolvedHandler = (payload: unknown) => {
        emit({ type: 'permission_removed', sessionId, permissionId: permissionIdFromPayload(payload) });
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

    this.unsubscribe = () => {
      for (const unsub of unsubscribers) unsub();
    };
  }

  /** Tool-call ids already routed as agent reports — the SDK can emit both
   *  'tool_execution_end' and 'tool_result' for one call; report each once. */
  private readonly agentReportedCallIds = new Set<string>();

  /** Route a report_tool_issue invocation to the daemon's report pipeline. */
  private emitAgentReport(extracted: { toolCallId: string; tool: string; report: string }): void {
    if (extracted.toolCallId) {
      if (this.agentReportedCallIds.has(extracted.toolCallId)) return;
      this.agentReportedCallIds.add(extracted.toolCallId);
      // Bounded: drop the oldest id — dedupe only matters for adjacent events.
      if (this.agentReportedCallIds.size > 200) {
        const oldest = this.agentReportedCallIds.values().next().value;
        if (oldest !== undefined) this.agentReportedCallIds.delete(oldest);
      }
    }
    const model = (this.session as { model?: { id?: string; name?: string; provider?: string } }).model;
    const modelStr = model
      ? [model.provider, model.id ?? model.name].filter((p): p is string => typeof p === 'string' && p.length > 0).join('/')
      : undefined;
    this.sinks.onAgentReport({
      sessionId: this.sessionId,
      workspaceId: this.target.workspaceId,
      workspaceName: this.target.workspaceName,
      projectName: this.target.projectName,
      sessionTitle: this.title,
      model: modelStr || undefined,
      tool: extracted.tool,
      report: extracted.report,
    });
  }

  /** Display title used in message-event payloads; set via setTitle. */
  private title: string | undefined;
}
