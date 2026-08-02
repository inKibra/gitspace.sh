import { parseCommandArgs } from '@oh-my-pi/pi-coding-agent/utils/command-args';

import type { HostUIBridgeEmitter, HostUIDialogRequest, HostUIDialogResponse } from './host-ui-bridge.js';
import {
  createPiAuthStorage,
  createPiModelRegistry,
  getPiSettings,
  openPiSessionManager,
  readCycleOrder,
} from './pi-runtime.js';
import type { AgentControlInfo, AgentDefinitionInfo, AgentGoalModeInfo, AgentHistoryEntry, AgentOAuthEvent, AgentSessionUsageReport, AgentSettingSchemaItem, AgentShakeMode, AgentShakeResult, AgentToolInfo, AgentTreeNode } from '../../../agents/agent-runtime-types.js';
import { getTranscriptRange } from '../../../blocks/agent/transcript-source.js';
import { CLAUDE_MODEL_ALIAS_TO_MODEL_ROLE } from '../../../blocks/model-roles.js';
import type { TranscriptPage, TranscriptSource } from '../../../blocks/agent/transcript-source.js';
import { executeSpaceCommand } from './extensions/space-command.js';
import { listPiSessions, findPiSessionFile, type PiSessionFileInfo } from './pi-session-files.js';
import { upsertArchivedSession, deleteArchivedSession } from '../../../agents/agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../../agents/session-display.js';
import type { AgentEvent } from '../../../agents/backend.js';
import type { AgentSessionHost, SessionHostBoot, SessionHostSinks } from './session-host.js';
import {
  THINKING_LEVELS,
  APPROVAL_MODES,
  DEFAULT_TOOL_TIERS,
} from './local-session-host.js';
import { WorkerSessionHost, type WorkerSessionHostConfig } from './worker/worker-session-host.js';
import { writeTraceLog } from '../../../utils/trace-log.js';
import { resolveWorkspaceGoal } from '../../../core/goal-chain.js';
import { getWorkspaceStatus } from '../../../core/workspace-metadata.js';

/**
 * Boots the per-session host. Production always uses {@link WorkerSessionHost}
 * (one child process per agent session); the seam exists so unit tests can
 * inject an in-process/fake host without spawning a real child. There is no
 * daemon-level in-process fallback — worker hosting is mandatory (each session's
 * own process is what isolates its SDK process-globals, AsyncJobManager, IRC
 * bus and artifact registry from every other session).
 */
export type SessionHostFactory = (
  target: PiWorkspaceTarget,
  boot: SessionHostBoot,
  sinks: SessionHostSinks,
  config: WorkerSessionHostConfig,
) => Promise<AgentSessionHost>;

/** Max concurrent live agent hosts (worker processes are ~400MB RSS each). */
function maxAgentHosts(): number {
  const n = Number.parseInt(process.env.GITSPACE_MAX_AGENT_WORKERS ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 8;
}

// Dynamic imports: oh-my-pi has module-level side effects (postmortem signal
// handlers that can call process.exit, provider registration) that must not
// run just because this module is imported.
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

/** Claude Code frontmatter model aliases → OMP role references ('pi/slow',
 *  'pi/task', …). The alias table itself lives in the shared, bundle-safe
 *  module src/blocks/model-roles.ts (web renderers translate legacy `model`
 *  values with it); 'inherit'/'sonnet' → task are special-cased by the SDK's
 *  resolveAgentModelPatterns to inherit the session model. */
function claudeAliasToOmpRole(alias: string): string | null {
  const role = CLAUDE_MODEL_ALIAS_TO_MODEL_ROLE[alias];
  return role ? `pi/${role}` : null;
}

/**
 * When an agent definition pins Claude-style model aliases that OMP cannot
 * resolve, return the pi/<role> to map it to. Conservative: only exact known
 * aliases (optionally with a `claude-`/bracketed variant prefix collapsed by
 * lowercasing) trigger a mapping, and only when EVERY pattern in the list is
 * such an alias — a mixed list already contains a resolvable pattern, so the
 * file's own fallback chain is left in charge.
 */
function mapClaudeAliasModel(model: string | string[] | undefined): string | null {
  if (!model) return null;
  const patterns = (Array.isArray(model) ? model : model.split(','))
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return null;
  const roles = patterns.map((p) => claudeAliasToOmpRole(p));
  if (roles.some((r) => r === null)) return null;
  return roles[0];
}

export interface PiWorkspaceTarget {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  projectName: string;
}

function isTargetForLiveSession(
  expected: PiWorkspaceTarget | undefined,
  actual: PiWorkspaceTarget,
): boolean {
  return expected?.workspaceId === actual.workspaceId
    && expected.workspaceName === actual.workspaceName
    && expected.workspacePath === actual.workspacePath
    && expected.projectName === actual.projectName;
}

export interface PiAgentSessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closedAt?: string;
  archivedAt?: string;
}


/**
 * PiCoordinator — the daemon-side ROUTER for agent sessions.
 *
 * It does not touch live SDK sessions itself: each live session is owned by an
 * AgentSessionHost — a WorkerSessionHost proxy over a per-session child process
 * (the child runs a LocalSessionHost). The coordinator:
 *   - discovers/boots hosts and tracks them by agent session id,
 *   - forwards commands to the owning host,
 *   - fans host events/dialog requests back out to clients,
 *   - answers "cold" queries (no live host) straight from session files.
 */
export class PiCoordinator {
  private readonly oauthPrompts = new Map<string, (value: string) => void>();
  private readonly inflightHosts = new Map<string, Promise<AgentSessionHost>>();
  // Viewer leases: `${workspaceId}:${agentSessionId}` → lease keys, one per open
  // client pane. This is what "someone is looking at this session" means for a
  // native (non-terminal) client, and it is the successor to counting bound
  // tmux sessions. Both are consulted while the terminal path still exists.
  private readonly agentLeases = new Map<string, Set<string>>();
  private readonly hosts = new Map<string, AgentSessionHost>();
  // Reverse index: agentSessionId → workspaceId, kept in sync with hosts.
  private readonly sessionWorkspaceIds = new Map<string, string>();
  // agentSessionId → its workspace target, kept in sync with hosts. Lets host
  // teardown (eviction / no-owners / crash) emit a lifecycle event for a
  // session whose live worker is gone, so the snapshot returns it to the
  // dormant (not-running) state instead of freezing its last busy/retry/error.
  private readonly sessionTargets = new Map<string, PiWorkspaceTarget>();
  // dialogId → agentSessionId for routing client dialog responses to the host.
  private readonly dialogSessions = new Map<string, string>();
  // dialogId → the full pending request, retained for the lifetime of the
  // pending dialog so it can be RE-EMITTED to a (re)connecting client — a
  // remounted pane / reconnected browser missed the original live broadcast and
  // the agent is still blocked waiting. Same dialogId (never minted anew) so the
  // existing agent-dialog-response path resolves it.
  private readonly pendingDialogRequests = new Map<string, HostUIDialogRequest>();
  // Worker-bound bookkeeping: LRU + busy tracking for the concurrency cap.
  private readonly hostLastUsed = new Map<string, number>();
  private readonly busySessions = new Set<string>();
  private readonly sessionsRoot: string | undefined;
  private eventHandler: ((target: PiWorkspaceTarget, event: AgentEvent) => void) | null = null;
  private hostUIEmitter: HostUIBridgeEmitter | null = null;
  // Production always boots a WorkerSessionHost (one child process per session);
  // tests inject an in-process/fake host. No daemon-level in-process fallback.
  private readonly hostFactory: SessionHostFactory;

  constructor(sessionsRoot?: string, options?: { hostFactory?: SessionHostFactory }) {
    this.sessionsRoot = sessionsRoot;
    this.hostFactory =
      options?.hostFactory ?? ((target, boot, sinks, config) => WorkerSessionHost.boot(target, boot, sinks, config));
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
   * The dialogs currently awaiting a user answer, keyed for status derivation.
   * This is the single source of truth for "this session is blocked on the
   * user" — the machine-snapshot build reads it live (rather than mirroring it
   * into a second store) so a session shows amber exactly while a dialog is open
   * and clears the instant it resolves, on every path, with no chance of drift.
   */
  getPendingDialogs(): Array<{ workspaceId: string; sessionId: string; dialogId: string }> {
    const out: Array<{ workspaceId: string; sessionId: string; dialogId: string }> = [];
    for (const [dialogId, sessionId] of this.dialogSessions) {
      const workspaceId = this.sessionWorkspaceIds.get(sessionId);
      if (workspaceId) out.push({ workspaceId, sessionId, dialogId });
    }
    return out;
  }

  /**
   * Route a dialog response from a client to the owning host's pending Promise.
   * Returns true if the dialog was found and resolved.
   */
  async resolveDialogResponse(response: HostUIDialogResponse): Promise<boolean> {
    const sessionId = this.dialogSessions.get(response.id);
    this.dialogSessions.delete(response.id);
    this.pendingDialogRequests.delete(response.id);
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
    let cycleOrder: string[] | null = null;
    try {
      const { MODEL_ROLE_IDS, MODEL_ROLES } = (await import('@oh-my-pi/pi-coding-agent/config/model-roles')) as unknown as {
        MODEL_ROLE_IDS?: string[];
        MODEL_ROLES?: Record<string, { name?: string; description?: string }>;
      };
      const settings = (await getPiSettings()) as { get(path: string): unknown; getModelRole?: (r: string) => string | undefined } | null;
      cycleOrder = readCycleOrder(settings);
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
      cycleOrder: cycleOrder ?? undefined,
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

  /** Goal Mode belongs only to an already-live host; do not cold-open it. */
  async getGoalMode(target: PiWorkspaceTarget, agentSessionId: string): Promise<AgentGoalModeInfo> {
    const host = this.hosts.get(agentSessionId);
    if (!host) {
      return {
        enabled: false,
        available: false,
        message: 'Goal Mode is available only while this agent session is active.',
      };
    }
    if (!isTargetForLiveSession(this.sessionTargets.get(agentSessionId), target)) {
      return {
        enabled: false,
        available: false,
        message: 'This agent session is not bound to the requested workspace.',
      };
    }
    return host.getGoalMode();
  }

  async setGoalMode(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    input: { enabled: boolean; precursor?: string },
  ): Promise<AgentGoalModeInfo> {
    const host = this.hosts.get(agentSessionId);
    if (!host) {
      return {
        enabled: false,
        available: false,
        message: 'Goal Mode can only be changed while this agent session is active.',
      };
    }
    if (!isTargetForLiveSession(this.sessionTargets.get(agentSessionId), target)) {
      return {
        enabled: false,
        available: false,
        message: 'This agent session is not bound to the requested workspace.',
      };
    }
    if (!input.enabled) return host.setGoalMode({ enabled: false });

    const goal = resolveWorkspaceGoal(target.projectName, target.workspaceName);
    if (!goal || goal.workspaceName !== target.workspaceName || goal.archivedAt) {
      return {
        enabled: false,
        available: true,
        message: 'Goal Mode requires a GoalRecord bound to this workspace.',
      };
    }
    const phase = getWorkspaceStatus(target.projectName, target.workspaceName) ?? goal.phase;
    const precursor = input.precursor?.trim();
    const objective = [
      `GitSpace Goal ${goal.id}: ${goal.title}`,
      `Current phase: ${phase}.`,
      'When uncertain, use `space goal show --goal ' + goal.id + ' --json`, `space journal status --json`, and `space workflow validate`.',
      precursor,
    ].filter((part): part is string => Boolean(part)).join('\n\n');
    return host.setGoalMode({ enabled: true, objective });
  }

  /** Shake rewrites only an already-live, workspace-bound session. */
  async shake(target: PiWorkspaceTarget, agentSessionId: string, mode: AgentShakeMode): Promise<AgentShakeResult> {
    const host = this.hosts.get(agentSessionId);
    if (!host) {
      throw new Error('Shake is available only while this agent session is active.');
    }
    if (!isTargetForLiveSession(this.sessionTargets.get(agentSessionId), target)) {
      throw new Error('This agent session is not bound to the requested workspace.');
    }
    return host.shake(mode);
  }

  /** Set the tool-approval mode (persisted to settings). */
  async setApprovalMode(target: PiWorkspaceTarget, agentSessionId: string, mode: string): Promise<boolean> {
    const host = await this.ensureHost(target, agentSessionId);
    return host.setApprovalMode(mode);
  }

  /** List known providers (from the model registry) with their auth status. */
  async getAuthProviders(): Promise<Array<{ provider: string; hasAuth: boolean; accounts?: Array<{ id: number; type: string; label: string; disabled: boolean }> }>> {
    const [auth, registry] = await Promise.all([createPiAuthStorage(), createPiModelRegistry()]);
    const providers = [...new Set(registry.getAll().map((m) => m.provider))].sort();
    return providers.map((provider) => {
      let hasAuth = false;
      let accounts: Array<{ id: number; type: string; label: string; disabled: boolean }> = [];
      try {
        hasAuth = auth.hasAuth(provider) || auth.has(provider);
        // Multi-account pool: the pi SDK holds a LIST of credentials per
        // provider (sibling accounts) and auto-rotates on rate-limit/401.
        // Surface each so the UI can show + manage them, not just hasAuth.
        const stored = auth.listStoredCredentials?.(provider) ?? [];
        accounts = stored.map((c) => ({
          id: c.id,
          type: c.credential.type,
          label: c.credential.email
            ?? c.credential.label
            ?? c.credential.accountId
            ?? (c.credential.type === 'api_key' ? 'API key' : `account #${c.id}`),
          disabled: c.disabledCause != null,
        }));
      } catch {
        /* ignore */
      }
      return { provider, hasAuth, accounts };
    });
  }

  /** Remove ONE account (credential) from a provider's pool by its row id. */
  async removeProviderAccount(provider: string, credentialId: number): Promise<boolean> {
    const auth = await createPiAuthStorage();
    try {
      return (await auth.removeCredential?.(provider, credentialId)) ?? false;
    } catch {
      return false;
    }
  }

  /** Probe live usage/limits for a provider's accounts (network round-trip via
   *  the SDK's per-provider usage provider — e.g. Codex's rate-limit windows).
   *  On-demand: it hits the upstream usage endpoint, so callers gate it behind
   *  a user action rather than the settings-open path. */
  async checkProviderUsage(provider: string): Promise<Array<{
    id: number;
    email?: string;
    ok: boolean | null;
    reason?: string;
    limits: Array<{ label: string; unit?: string; used?: number; limit?: number; remaining?: number; remainingFraction?: number; resetsAt?: number; status?: string }>;
    resetCredits?: { availableCount: number };
  }>> {
    const auth = await createPiAuthStorage();
    if (!auth.checkCredentials) return [];
    try {
      const results = await auth.checkCredentials({ timeoutMs: 12_000 });
      return results
        .filter((r) => r.provider === provider)
        .map((r) => ({
          id: r.id,
          email: r.email,
          ok: r.ok,
          reason: r.reason,
          // The SDK nests amounts under `amount` and reset time under `window`.
          // Derive remainingFraction from whatever the provider populated:
          // explicit remainingFraction > 1-usedFraction > remaining/limit.
          limits: (r.report?.limits ?? []).map((l) => {
            const a = l.amount ?? {};
            const remainingFraction =
              a.remainingFraction ??
              (a.usedFraction !== undefined ? Math.max(0, 1 - a.usedFraction) : undefined) ??
              (a.remaining !== undefined && a.limit ? a.remaining / a.limit : undefined);
            return {
              label: l.label,
              unit: a.unit,
              used: a.used,
              limit: a.limit,
              remaining: a.remaining,
              remainingFraction,
              resetsAt: l.window?.resetsAt,
              status: l.status,
            };
          }),
          resetCredits: r.report?.resetCredits ? { availableCount: r.report.resetCredits.availableCount } : undefined,
        }));
    } catch {
      return [];
    }
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
   *  (setModelRole) so one role is updated without clobbering the others, and
   *  `task.agentModelOverrides.<agent>` is merged into the record (the SDK's
   *  Settings.set only accepts whole schema paths — dotted record keys are not
   *  schema paths). An empty-string value clears the agent's override.
   *
   *  Persists via the DAEMON's settings singleton (initialized on demand — see
   *  getPiSettings), then fans out to every live host so worker processes'
   *  own Settings singletons see the change immediately (best-effort; a dead
   *  worker must not fail the global write). */
  async setSetting(path: string, value: string | number | boolean | string[]): Promise<boolean> {
    const settings = await getPiSettings();
    if (!settings) return false;
    // The quick cycle must never be emptied — the UI disables removing the
    // last role; reject a bad write outright rather than persist it.
    if (path === 'cycleOrder' && (!Array.isArray(value) || value.length === 0)) return false;
    let wrote = false;
    if (path.startsWith('modelRoles.') && typeof value === 'string') {
      const role = path.slice('modelRoles.'.length);
      const withRole = settings as { setModelRole?: (r: string, m: string) => void };
      if (typeof withRole.setModelRole === 'function') {
        withRole.setModelRole(role, value);
        wrote = true;
      }
    }
    if (path.startsWith('task.agentModelOverrides.') && typeof value === 'string') {
      const agentName = path.slice('task.agentModelOverrides.'.length);
      const record = this.readAgentModelOverrides(settings);
      if (value.trim()) record[agentName] = value.trim();
      else delete record[agentName];
      settings.set('task.agentModelOverrides', record as never);
      wrote = true;
    }
    if (!wrote) settings.set(path, value);
    await Promise.all([...this.hosts.entries()].map(async ([sessionId, host]) => {
      try {
        await host.setSetting(path, value);
      } catch (err) {
        console.warn(`[pi-coordinator] setSetting fan-out to ${sessionId} failed:`, err instanceof Error ? err.message : err);
      }
    }));
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

  /** Discovered subagent definitions (task-tool agents) for a workspace.
   *
   *  Cold by design: discovery is pure file reading (bundled + .omp/agents +
   *  extension/plugin roots) and override/role resolution reads the DAEMON's
   *  settings singleton — no live session needed, and worker sessions see the
   *  same config.yml, so the resolved patterns match what a spawn would use.
   *
   *  Also applies managed CLAUDE-ALIAS defaults: an agent file that pins a
   *  Claude Code model alias (sonnet/opus/haiku/inherit) cannot resolve in
   *  OMP, so map it to a pi/<role> via task.agentModelOverrides — only when
   *  the user hasn't already set an override for that agent name. Definition
   *  files are never rewritten; the mapping lives in settings where the
   *  AGENTS panel shows and edits it. */
  async listAgents(target: PiWorkspaceTarget): Promise<AgentDefinitionInfo[]> {
    const { discoverAgents } = (await import('@oh-my-pi/pi-coding-agent/task/discovery')) as unknown as {
      discoverAgents: (cwd: string) => Promise<{
        agents: Array<{
          name: string;
          description: string;
          source: 'bundled' | 'user' | 'project';
          filePath?: string;
          model?: string | string[];
        }>;
      }>;
    };
    const { resolveAgentModelPatterns } = (await import('@oh-my-pi/pi-coding-agent/config/model-resolver')) as unknown as {
      resolveAgentModelPatterns: (options: {
        settingsOverride?: string | string[];
        agentModel?: string | string[];
        settings?: unknown;
      }) => string[];
    };
    const settings = await getPiSettings();
    const { agents } = await discoverAgents(target.workspacePath);

    // Managed claude-alias mapping (persisted through setSetting so live
    // hosts' settings singletons fan-out too).
    let overrides = this.readAgentModelOverrides(settings);
    for (const agent of agents) {
      if (overrides[agent.name]?.trim()) continue;
      const mapped = mapClaudeAliasModel(agent.model);
      if (!mapped) continue;
      await this.setSetting(`task.agentModelOverrides.${agent.name}`, mapped);
      overrides = { ...overrides, [agent.name]: mapped };
    }

    const sourceOrder: Record<string, number> = { project: 0, user: 1, bundled: 2 };
    return agents
      .slice()
      .sort((a, b) => (sourceOrder[a.source] ?? 3) - (sourceOrder[b.source] ?? 3) || a.name.localeCompare(b.name))
      .map((agent) => {
        const rawModel = Array.isArray(agent.model) ? agent.model.join(', ') : agent.model ?? null;
        const overrideModel = overrides[agent.name]?.trim() || null;
        let resolvedModel: string | null = null;
        try {
          const patterns = resolveAgentModelPatterns({
            settingsOverride: overrideModel ?? undefined,
            agentModel: agent.model,
            settings: settings ?? undefined,
          });
          resolvedModel = patterns.length > 0 ? patterns.join(', ') : null;
        } catch {
          /* leave unresolved */
        }
        return {
          name: agent.name,
          description: (agent.description ?? '').split('\n')[0].trim(),
          source: agent.source,
          filePath: agent.filePath && !agent.filePath.startsWith('embedded:') ? agent.filePath : null,
          model: rawModel,
          overrideModel,
          resolvedModel,
        };
      });
  }

  /** Current task.agentModelOverrides record (defensively typed). */
  private readAgentModelOverrides(settings: { get(path: string): unknown } | null): Record<string, string> {
    try {
      const v = settings?.get('task.agentModelOverrides');
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (typeof val === 'string') out[k] = val;
        }
        return out;
      }
    } catch {
      /* ignore */
    }
    return {};
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

  /**
   * Per-session usage attribution, read straight off the transcript. NOTE: no
   * `ensureHost` — this is pure file I/O, so it works for closed/archived
   * sessions and never spins a worker up just to answer a report.
   */
  async getSessionUsageReport(
    target: PiWorkspaceTarget,
    agentSessionId: string,
  ): Promise<AgentSessionUsageReport | null> {
    const file = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!file) return null;
    const { buildSessionUsageReport, rollupByPath } = await import('../../../core/session-usage-report.js');
    const report = await buildSessionUsageReport(file.path);
    if (!report) return null;
    const countChildren = (node: NonNullable<typeof report>): number =>
      node.children.reduce((sum, child) => sum + 1 + countChildren(child), 0);
    return {
      totals: report.totals,
      totalsDeep: report.totalsDeep,
      byProviderModel: report.byProviderModel,
      byRole: report.byRole,
      byServiceTier: report.byServiceTier,
      segments: report.segments,
      paths: rollupByPath(report),
      childSessions: countChildren(report),
      warnings: report.warnings,
    };
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
    const host = await this.bootHost(target, { mode: 'create', title });

    const sessionId = host.sessionId;
    this.hosts.set(sessionId, host);
    this.sessionWorkspaceIds.set(sessionId, target.workspaceId);
    this.sessionTargets.set(sessionId, target);
    this.hostLastUsed.set(sessionId, Date.now());

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

  /**
   * Close an agent session: nothing is watching it anymore, so drop every
   * lease and tear the host down. Returns whether a live host was disposed.
   */
  async closeAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const key = this.getBindingKey(target.workspaceId, agentSessionId);
    this.agentLeases.delete(key);
    const hadHost = this.hosts.has(agentSessionId);
    await this.disposeHost(agentSessionId);
    return hadHost;
  }

  /**
   * Interrupt the agent's current turn without killing the session.
   * The session stays alive and can accept new prompts afterward.
   *
   * Compare with closeAgentSession() which kills the tmux terminal session.
   */
  async interruptAgentSession(_target: PiWorkspaceTarget, agentSessionId: string): Promise<boolean> {
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
    this.hostLastUsed.set(agentSessionId, Date.now());
    // Prompt acceptance marks the session busy immediately — agent_start can
    // lag (model resolve), and the eviction policy must never pick a session
    // that just took a turn.
    this.busySessions.add(agentSessionId);
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

  /** Everything currently keeping a session's host alive. Native panes are the
   *  only viewers now that agent sessions have no terminal. */
  hasAgentViewers(workspaceId: string, agentSessionId: string): boolean {
    return this.getViewerCount(workspaceId, agentSessionId) > 0;
  }

  /**
   * Open an agent session for a native client pane: boot (or reuse) its host
   * and record a viewer lease. No tmux session, no PTY, no InteractiveMode —
   * the client renders the transcript from events and cold file reads.
   *
   * `leaseKey` identifies one viewer (connection + pane). Re-opening with the
   * same key is idempotent.
   */
  async openAgentSession(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    leaseKey: string,
  ): Promise<number> {
    const match = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!match) {
      throw new Error(
        `Pi session '${agentSessionId}' not found for workspace '${target.workspaceId}'. ` +
        `The session file may have been deleted or the ID is stale.`,
      );
    }
    await this.ensureHost(target, agentSessionId, match);
    const key = this.getBindingKey(target.workspaceId, agentSessionId);
    let leases = this.agentLeases.get(key);
    if (!leases) {
      leases = new Set();
      this.agentLeases.set(key, leases);
    }
    leases.add(leaseKey);
    return leases.size;
  }

  /**
   * Drop one viewer lease. The host is disposed once nothing is viewing it,
   * mirroring what the last terminal detach used to do. Returns the workspace
   * the session belongs to (so callers can emit a scoped update) and the
   * viewers that remain, or null when the lease was already gone.
   */
  releaseAgentLease(agentSessionId: string, leaseKey: string): { workspaceId: string; remaining: number } | null {
    const suffix = `:${agentSessionId}`;
    for (const [key, leases] of this.agentLeases) {
      if (!key.endsWith(suffix) || !leases.delete(leaseKey)) continue;
      if (leases.size === 0) this.agentLeases.delete(key);
      const workspaceId = key.slice(0, -suffix.length);
      const remaining = this.getViewerCount(workspaceId, agentSessionId);
      if (remaining === 0) {
        void this.disposeHost(agentSessionId).catch((err) => {
          console.error(`[pi-coordinator] Failed to dispose agent session ${agentSessionId}:`, err);
        });
      }
      return { workspaceId, remaining };
    }
    return null;
  }

  /** Release every lease whose key starts with `ownerPrefix` — a disconnecting
   *  client takes all of its panes with it. */
  releaseAgentLeasesForOwner(ownerPrefix: string): void {
    for (const [key, leases] of [...this.agentLeases]) {
      let changed = false;
      for (const leaseKey of [...leases]) {
        if (leaseKey.startsWith(ownerPrefix)) {
          leases.delete(leaseKey);
          changed = true;
        }
      }
      if (!changed) continue;
      if (leases.size === 0) this.agentLeases.delete(key);
      const separator = key.lastIndexOf(':');
      const workspaceId = key.slice(0, separator);
      const agentSessionId = key.slice(separator + 1);
      if (this.getViewerCount(workspaceId, agentSessionId) === 0) {
        void this.disposeHost(agentSessionId).catch((err) => {
          console.error(`[pi-coordinator] Failed to dispose agent session ${agentSessionId}:`, err);
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Daemon shutdown: synchronously tear down every live host so agent worker
   *  processes die WITH the daemon (no orphaned SDK sessions). Safe from
   *  signal handlers — no awaits. */
  shutdownHosts(): void {
    for (const [sessionId, host] of this.hosts) {
      try {
        host.kill();
      } catch (err) {
        console.error(`[pi-coordinator] kill failed for ${sessionId}:`, err);
      }
    }
    this.hosts.clear();
    this.sessionWorkspaceIds.clear();
    this.sessionTargets.clear();
    this.dialogSessions.clear();
    this.pendingDialogRequests.clear();
  }

  /** Boot a session host. Always a worker child process in production (via
   *  {@link hostFactory}); tests may inject an in-process/fake host. The child
   *  runs a LocalSessionHost internally (see agent-worker.ts) — the per-session
   *  process boundary is what isolates SDK process-globals, IRC and artifacts. */
  private async bootHost(
    target: PiWorkspaceTarget,
    boot: SessionHostBoot,
  ): Promise<AgentSessionHost> {
    await this.evictForCapacity();
    const sinks = this.createHostSinks(target);
    const enableUI = !!this.hostUIEmitter;
    return this.hostFactory(target, boot, sinks, {
      enableUI,
      onUnexpectedExit: (sessionId, detail) => this.handleWorkerExit(target, sessionId, detail),
    });
  }

  /** Bound live hosts (each worker is a full SDK process, ~400MB RSS). At the
   *  cap, evict the least-recently-used host that is idle (no turn in flight)
   *  and has no attached terminal — lazy restore reopens it from its session
   *  file on next use. If everything is busy/attached, refuse the new boot. */
  private async evictForCapacity(): Promise<void> {
    const max = maxAgentHosts();
    if (this.hosts.size < max) return;
    const candidates = [...this.hosts.keys()]
      .filter((id) => !this.busySessions.has(id))
      .filter((id) => {
        const workspaceId = this.sessionWorkspaceIds.get(id);
        return !workspaceId || this.getViewerCount(workspaceId, id) === 0;
      })
      .sort((a, b) => (this.hostLastUsed.get(a) ?? 0) - (this.hostLastUsed.get(b) ?? 0));
    const evictee = candidates[0];
    if (!evictee) {
      throw new Error(
        `Agent session limit reached (${max} live; all busy or attached). ` +
        `Close a session or raise GITSPACE_MAX_AGENT_WORKERS.`,
      );
    }
    console.log(`[pi-coordinator] evicting idle agent host ${evictee} (limit ${max})`);
    await this.disposeHost(evictee);
  }

  /** A worker died without being asked to — drop its bookkeeping and tell
   *  clients the session is no longer running so it returns to the dormant
   *  (grey) state instead of hanging busy or freezing on its last error. Red is
   *  reserved for a live, currently-erroring session; a worker that is gone is
   *  not running. The next interaction lazily restores it from its file. */
  private handleWorkerExit(target: PiWorkspaceTarget, sessionId: string, detail: string): void {
    this.hosts.delete(sessionId);
    this.sessionWorkspaceIds.delete(sessionId);
    this.sessionTargets.delete(sessionId);
    this.hostLastUsed.delete(sessionId);
    this.busySessions.delete(sessionId);
    for (const [dialogId, dialogSessionId] of this.dialogSessions) {
      if (dialogSessionId === sessionId) {
        this.dialogSessions.delete(dialogId);
        this.pendingDialogRequests.delete(dialogId);
      }
    }
    console.error(`[pi-coordinator] ${detail} (session ${sessionId})`);
    this.eventHandler?.(target, { type: 'status', sessionId, payload: { type: 'dormant', reason: 'worker-exit' } });
  }

  /** Tell clients a session's live worker is gone (evicted / no owners / crash)
   *  so its snapshot record returns to the dormant, not-running state. Emitted
   *  as a synthetic status; the agent-control bridge maps 'dormant' onto
   *  markSessionClosed, clearing the frozen busy/retry/error. */
  private emitSessionDormant(sessionId: string): void {
    const target = this.sessionTargets.get(sessionId);
    if (!target) return;
    this.eventHandler?.(target, { type: 'status', sessionId, payload: { type: 'dormant', reason: 'host-stopped' } });
  }

  private createHostSinks(target: PiWorkspaceTarget): SessionHostSinks {
    return {
      onEvent: (event) => {
        // Busy tracking for the eviction policy: never evict mid-turn. An
        // error clears busy (a failed prompt never reaches agent_end); a
        // retry status that follows re-marks it busy.
        if (event.type === 'status') {
          const p = (event as { payload?: { type?: string } }).payload;
          if (p?.type === 'busy' || p?.type === 'compacting' || p?.type === 'retry') this.busySessions.add(event.sessionId);
          else if (p?.type === 'idle') this.busySessions.delete(event.sessionId);
        } else if (event.type === 'error') {
          this.busySessions.delete(event.sessionId);
        }
        this.eventHandler?.(target, event);
      },
      onDialogRequest: (request) => {
        this.handleDialogRequest(request);
      },
      onUiEvent: (event) => {
        this.hostUIEmitter?.emitEvent(event);
      },
      onAgentReport: (payload) => {
        // Agent invoked the SDK's report_tool_issue tool — file it through the
        // same pipeline as user reports (local write + issue + gist), with
        // origin 'agent'. Worker mode delivers this over IPC; in-process mode
        // calls it directly. Fire-and-forget: filing must never block the turn.
        void (async () => {
          try {
            const { fileAgentReport } = await import('../problem-report.js');
            const filed = await fileAgentReport(payload, Date.now());
            console.log(
              `[pi-coordinator] agent report filed for session ${payload.sessionId} -> ${filed.issueUrl ?? filed.path}`,
            );
          } catch (err) {
            console.error('[pi-coordinator] agent report filing failed:', err);
          }
        })();
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
        this.pendingDialogRequests.set(request.id, request);
        emitter.emitDialogRequest(request);
        return;
      } catch (err) {
        this.dialogSessions.delete(request.id);
        this.pendingDialogRequests.delete(request.id);
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

  /**
   * Every still-pending dialog request across all live sessions. Used for the
   * connect-time catch-up (serve-runtime): a browser that connected/reconnected
   * after a dialog fired missed the live broadcast while the agent stayed blocked
   * on the ask, so these are re-pushed to it. The stored objects carry the
   * ORIGINAL dialogId, so the existing agent-dialog-response path resolves them.
   */
  getPendingDialogRequests(): HostUIDialogRequest[] {
    return [...this.pendingDialogRequests.values()];
  }

  private async ensureHost(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile: PiSessionFileInfo | null = null,
  ): Promise<AgentSessionHost> {
    const existing = this.hosts.get(agentSessionId);
    if (existing) {
      this.hostLastUsed.set(agentSessionId, Date.now());
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

        const host = await this.bootHost(
          target,
          { mode: 'open', sessionFilePath: match.path },
        );
        if (host.sessionId !== agentSessionId) {
          await host.dispose();
          throw new Error(
            `Pi session file '${match.path}' reopened as '${host.sessionId}', expected '${agentSessionId}'.`,
          );
        }
        host.setTitle(match.title ?? match.firstMessage ?? undefined);

        this.hosts.set(agentSessionId, host);
        this.sessionWorkspaceIds.set(agentSessionId, target.workspaceId);
        this.sessionTargets.set(agentSessionId, target);
        this.hostLastUsed.set(agentSessionId, Date.now());
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
      if (dialogSessionId === sessionId) {
        this.dialogSessions.delete(dialogId);
        this.pendingDialogRequests.delete(dialogId);
      }
    }
    const host = this.hosts.get(sessionId);
    this.hostLastUsed.delete(sessionId);
    this.busySessions.delete(sessionId);
    if (host) {
      // Return the session to the dormant (not-running) state before dropping
      // its bookkeeping — its live worker is going away, so the snapshot must
      // not keep reporting its last busy/retry/error as if it were still live.
      this.emitSessionDormant(sessionId);
      this.hosts.delete(sessionId);
      this.sessionWorkspaceIds.delete(sessionId);
      this.sessionTargets.delete(sessionId);
      await host.dispose();
    }
  }

  private getBindingKey(workspaceId: string, agentSessionId: string): string {
    return `${workspaceId}:${agentSessionId}`;
  }

  /** Everything currently keeping a session's host alive: one entry per open
   *  client pane. Disposal and eviction both gate on this. */
  private getViewerCount(workspaceId: string, agentSessionId: string): number {
    return this.agentLeases.get(this.getBindingKey(workspaceId, agentSessionId))?.size ?? 0;
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
