import { parseCommandArgs } from '@oh-my-pi/pi-coding-agent/utils/command-args';

import type { HostUIBridgeEmitter, HostUIDialogRequest, HostUIDialogResponse } from './host-ui-bridge.js';
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
  getPiSettings,
  openPiSessionManager,
} from './pi-runtime.js';
import type { AgentControlInfo, AgentHistoryEntry, AgentOAuthEvent, AgentSettingSchemaItem, AgentToolInfo, AgentTreeNode } from '../../../agents/agent-runtime-types.js';
import { getTranscriptRange } from '../../../blocks/agent/transcript-source.js';
import type { TranscriptPage, TranscriptSource } from '../../../blocks/agent/transcript-source.js';
import { executeSpaceCommand } from './extensions/space-command.js';
import { listPiSessions, findPiSessionFile, type PiSessionFileInfo } from './pi-session-files.js';
import { upsertArchivedSession, deleteArchivedSession } from '../../../agents/agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../../agents/session-display.js';
import type { AgentEvent } from '../../../agents/backend.js';
import { getVirtualTerminal } from '../virtual-session-registry.js';
import type { VirtualTerminal } from './virtual-terminal.js';
import type { AgentSessionHost, SessionHostSinks } from './session-host.js';
import {
  LocalSessionHost,
  THINKING_LEVELS,
  APPROVAL_MODES,
  DEFAULT_TOOL_TIERS,
} from './local-session-host.js';
import { writeTraceLog } from '../../../utils/trace-log.js';

// Dynamic imports: oh-my-pi has module-level side effects (postmortem signal
// handlers, provider registration) that conflict with OpenTUI when loaded eagerly.
const importSlashCommands = () => import('@oh-my-pi/pi-coding-agent/extensibility/slash-commands');
const importExecModule = () => import('@oh-my-pi/pi-coding-agent/exec/exec');

export const PI_AGENT_TMUX_SESSION_KIND = 'agent';

/** Max time to wait for Pi to create its session file after spawning. */
const SESSION_DISCOVERY_TIMEOUT_MS = 10_000;
const SESSION_DISCOVERY_POLL_MS = 200;

/** Curated, safe-to-edit settings surfaced in the settings panel. */
const SETTINGS_CATALOG: Array<{ path: string; label: string; kind: 'boolean' | 'enum'; options?: string[] }> = [
  { path: 'tools.approvalMode', label: 'Approval mode', kind: 'enum', options: APPROVAL_MODES },
  { path: 'model.thinkingLevel', label: 'Thinking level', kind: 'enum', options: THINKING_LEVELS },
  { path: 'compaction.enabled', label: 'Auto-compaction', kind: 'boolean' },
  { path: 'compaction.autoContinue', label: 'Compaction auto-continue', kind: 'boolean' },
  { path: 'retry.enabled', label: 'Auto-retry on errors', kind: 'boolean' },
  { path: 'tools.intentTracing', label: 'Tool intent tracing', kind: 'boolean' },
];

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

interface TerminalSessionBinding {
  workspaceId: string;
  agentSessionId: string;
}

/**
 * PiCoordinator — the daemon-side ROUTER for agent sessions.
 *
 * It does not touch live SDK sessions itself: each live session is owned by an
 * AgentSessionHost (LocalSessionHost in-process today; WorkerSessionHost proxy
 * over a per-session child process in worker mode). The coordinator:
 *   - discovers/boots hosts and tracks them by agent session id,
 *   - forwards commands to the owning host,
 *   - fans host events/dialog requests back out to clients,
 *   - manages tmux terminal-session bindings + the daemon-side VirtualTerminal
 *     relay (client input → host, host output → xterm + clients),
 *   - answers "cold" queries (no live host) straight from session files.
 */
export class PiCoordinator {
  private readonly oauthPrompts = new Map<string, (value: string) => void>();
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();
  private readonly inflightHosts = new Map<string, Promise<AgentSessionHost>>();
  private readonly terminalBindings = new Map<string, TerminalSessionBinding>();
  private readonly terminalSessionIdsByAgentKey = new Map<string, Set<string>>();
  private readonly hosts = new Map<string, AgentSessionHost>();
  // Reverse index: agentSessionId → workspaceId, kept in sync with hosts.
  private readonly sessionWorkspaceIds = new Map<string, string>();
  // Daemon-side VirtualTerminal relays (registry VT per agent session): client
  // keystrokes route host-ward, host render bytes route xterm/client-ward.
  private readonly terminalRelays = new Map<string, VirtualTerminal>();
  // dialogId → agentSessionId for routing client dialog responses to the host.
  private readonly dialogSessions = new Map<string, string>();
  private readonly sessionsRoot: string | undefined;
  private eventHandler: ((target: PiWorkspaceTarget, event: AgentEvent) => void) | null = null;
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
      // Install the host UI context on all already-active hosts. Host sinks
      // read this.hostUIEmitter dynamically, so replacing the emitter needs no
      // per-host rewiring beyond first-time enablement.
      for (const host of this.hosts.values()) {
        if (!host.uiEnabled) host.enableUI();
      }
    }
  }

  /**
   * Route a dialog response from a client to the owning host's pending Promise.
   * Returns true if the dialog was found and resolved.
   */
  async resolveDialogResponse(response: HostUIDialogResponse): Promise<boolean> {
    const sessionId = this.dialogSessions.get(response.id);
    this.dialogSessions.delete(response.id);
    if (sessionId) {
      const host = this.hosts.get(sessionId);
      if (host) return host.resolveDialog(response);
    }
    // Mapping lost (shouldn't happen) — try every host.
    for (const host of this.hosts.values()) {
      if (await host.resolveDialog(response)) return true;
    }
    return false;
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
   * over the SDK session's entry tree). Prefers the live host so a leaf move
   * (conversation rewind) is reflected immediately; falls back to a read-only
   * file open, which always resets the leaf to the last entry.
   */
  async readTranscriptRange(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    opts: { before?: string; limit: number },
  ): Promise<TranscriptPage> {
    const host = this.hosts.get(agentSessionId);
    if (host) {
      return host.readTranscriptRange(opts);
    }
    const file = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!file) return { blocks: [], oldestCursor: null, hasMore: false };
    const manager = await openPiSessionManager(file.path);
    return getTranscriptRange(manager as unknown as TranscriptSource, opts);
  }

  /** Control-surface snapshot: usage, current model, and the model switcher list.
   *  Live host computes the full snapshot; otherwise a cold, file-based subset. */
  async getControlInfo(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentControlInfo> {
    const host = this.hosts.get(agentSessionId);
    if (host) {
      return host.getControlInfo();
    }
    return this.getColdControlInfo(target, agentSessionId);
  }

  /** Cold control info: no live session — usage/model from the session file,
   *  switcher list from the registry, settings from the global singleton. */
  private async getColdControlInfo(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentControlInfo> {
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
      console.warn('[pi-coordinator] model list failed:', err);
    }

    let approvalMode: string | null = null;
    // Fast mode / service tier is PER MODEL FAMILY in 16.x (tier.openai /
    // tier.anthropic / tier.google). Only models whose family exposes a
    // serving-priority knob are "fast-capable"; others have no toggle.
    let serviceTier: string | null = null;
    let serviceTierKey: string | null = null;
    let fastCapable = false;
    try {
      const settings = await getPiSettings();
      const m = settings?.get('tools.approvalMode');
      if (typeof m === 'string') approvalMode = m;

      const { serviceTierFamily } = (await import('@oh-my-pi/pi-ai')) as {
        serviceTierFamily: (model: { provider: string; api?: string; id: string }) => string | undefined;
      };
      const modelObj = rawModels.find((x) => `${x.provider}/${x.id}` === currentModel);
      const family = modelObj ? serviceTierFamily(modelObj) : undefined;
      fastCapable = !!family;
      if (family) {
        serviceTierKey = `tier.${family}`;
        const st = settings?.get(serviceTierKey);
        if (typeof st === 'string') serviceTier = st;
      }
    } catch {
      /* settings unavailable */
    }

    // Full role CATALOG for the config UI (roles CYCLE needs a live session).
    let roleCatalog: AgentControlInfo['roleCatalog'] = [];
    try {
      const { MODEL_ROLE_IDS, MODEL_ROLES } = (await import('@oh-my-pi/pi-coding-agent/config/model-roles')) as unknown as {
        MODEL_ROLE_IDS?: string[];
        MODEL_ROLES?: Record<string, { name?: string; description?: string }>;
      };
      const settings = (await getPiSettings()) as { getModelRole?: (r: string) => string | undefined } | null;
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
      roles: [],
      roleCatalog,
      thinkingLevel: null,
      thinkingLevels: THINKING_LEVELS,
      approvalMode,
      approvalModes: APPROVAL_MODES,
      serviceTier,
      serviceTierKey,
      fastCapable,
      context: null,
    };
  }

  /** Cycle the active model through the configured roles (the cmd-P role cycle). */
  async cycleRole(target: PiWorkspaceTarget, agentSessionId: string, direction: 'forward' | 'backward'): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.cycleRole(direction);
  }

  /** Apply a specific role's model to the active session. */
  async applyRole(target: PiWorkspaceTarget, agentSessionId: string, role: string): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.applyRole(role);
  }

  /** Set the session's thinking/reasoning level (spins up the session if needed). */
  async setThinkingLevel(target: PiWorkspaceTarget, agentSessionId: string, level: string): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.setThinkingLevel(level);
  }

  /** Set the tool-approval mode (persisted to settings). */
  async setApprovalMode(target: PiWorkspaceTarget, agentSessionId: string, mode: string): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.setApprovalMode(mode);
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

  /** Write a single setting. `modelRoles.<role>` is routed to the record helper
   *  (setModelRole) so one role is updated without clobbering the others. */
  async setSetting(path: string, value: string | number | boolean): Promise<boolean> {
    const settings = await getPiSettings();
    if (!settings) return false;
    if (path.startsWith('modelRoles.') && typeof value === 'string') {
      const role = path.slice('modelRoles.'.length);
      const withRole = settings as { setModelRole?: (r: string, m: string) => void };
      if (typeof withRole.setModelRole === 'function') {
        withRole.setModelRole(role, value);
        return true;
      }
    }
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

  /** Tools available to the session (for per-tool approval). Live host merges
   *  the session's tool registry; cold path serves the standard set + overrides. */
  async getTools(_target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentToolInfo[]> {
    const host = this.hosts.get(agentSessionId);
    if (host) return host.getTools();
    let approvals: Record<string, string> = {};
    try {
      const a = (await getPiSettings())?.get('tools.approval');
      if (a && typeof a === 'object') approvals = a as Record<string, string>;
    } catch {
      /* ignore */
    }
    const tiers = new Map<string, string>(DEFAULT_TOOL_TIERS);
    for (const name of Object.keys(approvals)) if (!tiers.has(name)) tiers.set(name, 'exec');
    return [...tiers.entries()]
      .map(([name, tier]) => ({ name, tier, approval: approvals[name] ?? 'default' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Compact the session context. */
  async compactSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.compact();
  }

  /** User-message checkpoints in the current branch (for conversation rewind). */
  async getHistory(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentHistoryEntry[]> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.getHistory();
  }

  /** Navigate the conversation tree (see AgentSessionHost.navigateHistory). */
  async navigateHistory(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    entryId: string,
    mode: 'redo' | 'jump' = 'redo',
  ): Promise<{ ok: boolean; editorText?: string }> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.navigateHistory(entryId, mode);
  }

  /** The conversation tree for the explorer view (see AgentSessionHost). */
  async getSessionTree(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentTreeNode[]> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.getSessionTree();
  }

  /** Switch the session's model. Spins up the session if needed. */
  async setModel(target: PiWorkspaceTarget, agentSessionId: string, provider: string, modelId: string): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.setModel(provider, modelId);
  }

  /**
   * Create a new Pi agent session so we get the canonical session ID
   * immediately and can subscribe to live events. tmux terminals are created
   * later when the user explicitly attaches.
   */
  async createAgentSession(target: PiWorkspaceTarget, title?: string): Promise<PiAgentSessionSummary[]> {
    let bootedSessionId: string | null = null;
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'create', title },
      this.createHostSinks(target, () => bootedSessionId),
      { enableUI: !!this.hostUIEmitter },
    );
    bootedSessionId = host.sessionId;
    host.title = title;

    const sessionId = host.sessionId;
    this.hosts.set(sessionId, host);
    this.sessionWorkspaceIds.set(sessionId, target.workspaceId);

    const sessionFile = await this.waitForSessionFile(target.workspacePath, sessionId);
    if (!sessionFile) {
      await this.disposeHost(sessionId);
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
      // listTmuxSessions failed — still try to dispose the host below
    }
    if (foundTerminalSessionId) {
      this.releaseTerminalSession(foundTerminalSessionId);
    }
    // Always dispose the host if no terminal owners remain
    if (!this.hasTerminalOwners(target.workspaceId, agentSessionId)) {
      await this.disposeHost(agentSessionId);
    }
    return killed;
  }

  /**
   * Interrupt the agent's current turn without killing the session.
   * The session stays alive and can accept new prompts afterward.
   *
   * Compare with closeAgentSession() which kills the tmux terminal session.
   */
  async interruptAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const host = this.hosts.get(agentSessionId);
    if (!host) {
      return false;
    }
    return host.interrupt();
  }

  async promptAgentSession(target: PiWorkspaceTarget, agentSessionId: string, text: string, images?: import('../protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    const traceStartMs = Date.now();
    const host = await this.ensureHost(target, agentSessionId);
    writeTraceLog('agent-prompt-session-ready', {
      workspaceId: target.workspaceId,
      agentSessionId,
      durationMs: Date.now() - traceStartMs,
      textLength: text.length,
      imageCount: images?.length ?? 0,
      streamingBehavior: options?.streamingBehavior,
    });

    // Turn accepted: ok responds immediately. Turn progress and completion flow
    // through agent/machine events. The host intercepts /compact internally.
    const trimmed = text.trim();
    writeTraceLog(trimmed === '/compact' || trimmed.startsWith('/compact ') ? 'agent-compact-dispatched' : 'agent-prompt-dispatch', {
      workspaceId: target.workspaceId,
      agentSessionId,
      durationMs: Date.now() - traceStartMs,
      textLength: text.length,
    });
    await host.prompt(text, images, options);
  }

  async removeQueuedAgentMessage(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    kind: 'steering' | 'followUp',
    index: number,
  ): Promise<string | null> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.removeQueuedMessage(kind, index);
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
      void this.disposeHost(previous.agentSessionId).catch((err) => {
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
      void this.disposeHost(binding.agentSessionId).catch((err) => {
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

    // A stale interactive mode from a dead terminal — stop it before recreating.
    await this.hosts.get(agentSessionId)?.stopTerminal();

    return this.createVirtualAgentSession(target, agentSessionId, match, options);
  }

  private async createVirtualAgentSession(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile: PiSessionFileInfo,
    options?: { cols?: number; rows?: number },
  ): Promise<TmuxSession> {
    const host = await this.ensureHost(target, agentSessionId, sessionFile);
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
      // Relay wiring: host render bytes → registry VT.write → xterm + client
      // fan-out; client keystrokes/resizes → registry VT.start handlers → host.
      this.terminalRelays.set(agentSessionId, virtualTerminal);
      await host.startTerminal(virtualTerminal.columns, virtualTerminal.rows);
      virtualTerminal.start(
        (data) => host.injectTerminalInput(data),
        () => host.resizeTerminal(virtualTerminal.columns, virtualTerminal.rows),
      );
      this.bindTerminalSession(target.workspaceId, tmuxSession.id, agentSessionId);
      return tmuxSession;
    } catch (error) {
      this.terminalRelays.delete(agentSessionId);
      await terminateTmuxSession(tmuxSession.id).catch(() => {});
      throw error;
    }
  }


  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private createHostSinks(target: PiWorkspaceTarget, getSessionId: () => string | null): SessionHostSinks {
    return {
      onEvent: (event) => {
        this.eventHandler?.(target, event);
      },
      onDialogRequest: (request) => {
        this.handleDialogRequest(request);
      },
      onUiEvent: (event) => {
        this.hostUIEmitter?.emitEvent(event);
      },
      onTerminalOutput: (data) => {
        const sessionId = getSessionId();
        if (!sessionId) return;
        this.terminalRelays.get(sessionId)?.write(data);
      },
    };
  }

  /** Forward an extension dialog request to a watching client; if no client
   *  can answer, resolve it as cancelled so the extension unblocks. */
  private handleDialogRequest(request: HostUIDialogRequest): void {
    const emitter = this.hostUIEmitter;
    if (emitter) {
      try {
        this.dialogSessions.set(request.id, request.sessionId);
        emitter.emitDialogRequest(request);
        return;
      } catch (err) {
        this.dialogSessions.delete(request.id);
        console.warn(
          `[pi-coordinator] No client to answer dialog ${request.id} (${request.type}); cancelling:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    const host = this.hosts.get(request.sessionId);
    if (!host) return;
    const cancel: HostUIDialogResponse = request.type === 'confirm'
      ? { type: 'confirm', id: request.id, value: false }
      : { type: request.type, id: request.id, value: undefined };
    void host.resolveDialog(cancel).catch(() => undefined);
  }

  private async ensureHost(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile: PiSessionFileInfo | null = null,
  ): Promise<AgentSessionHost> {
    const existing = this.hosts.get(agentSessionId);
    if (existing) {
      return existing;
    }

    const existingInFlight = this.inflightHosts.get(agentSessionId);
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

        const host = await LocalSessionHost.boot(
          target,
          { mode: 'open', sessionFilePath: match.path },
          this.createHostSinks(target, () => agentSessionId),
          { enableUI: !!this.hostUIEmitter },
        );
        if (host.sessionId !== agentSessionId) {
          await host.dispose();
          throw new Error(
            `Pi session file '${match.path}' reopened as '${host.sessionId}', expected '${agentSessionId}'.`,
          );
        }
        host.title = match.title ?? match.firstMessage ?? undefined;

        this.hosts.set(agentSessionId, host);
        this.sessionWorkspaceIds.set(agentSessionId, target.workspaceId);
        return host;
      } finally {
        this.inflightHosts.delete(agentSessionId);
      }
    })();

    this.inflightHosts.set(agentSessionId, ensurePromise);
    return ensurePromise;
  }

  private async disposeHost(sessionId: string): Promise<void> {
    for (const [dialogId, dialogSessionId] of this.dialogSessions) {
      if (dialogSessionId === sessionId) this.dialogSessions.delete(dialogId);
    }
    const relay = this.terminalRelays.get(sessionId);
    if (relay) {
      relay.stop();
      this.terminalRelays.delete(sessionId);
    }
    const host = this.hosts.get(sessionId);
    if (host) {
      this.hosts.delete(sessionId);
      this.sessionWorkspaceIds.delete(sessionId);
      await host.dispose();
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
    // 1. Collect extension/custom/skill commands from a live host for the
    //    requested workspace (commands are workspace-scoped; one host suffices).
    for (const [sessionId, host] of this.hosts) {
      if (this.sessionWorkspaceIds.get(sessionId) !== target.workspaceId) continue;
      try {
        const sessionCommands = await host.listSessionCommands(commands.map((c) => c.name));
        for (const cmd of sessionCommands) {
          if (cmd.name && !commands.some((command) => command.name === cmd.name)) {
            commands.push(cmd);
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
