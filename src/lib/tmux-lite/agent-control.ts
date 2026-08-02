import { defaultPiCoordinator, type PiWorkspaceTarget, type PiAgentSessionSummary } from './agents/pi-coordinator.js';
import type { TranscriptPage } from '../../blocks/agent/transcript-source.js';
import type { AgentControlInfo, AgentGoalModeInfo, AgentShakeMode, AgentShakeResult } from '../../agents/agent-runtime-types.js';
import type { HostUIBridgeEmitter, HostUIDialogResponse } from './agents/host-ui-bridge.js';
import {
  defaultAgentEventManager,
  type AgentStateUpdateDelta,
  type WorkspaceAgentState,
} from './agent-event-manager.js';
import { existsSync } from 'fs';
import { getArchivedSessions } from '../../agents/agent-db.js';
import { getProjectBaseDir } from '../../core/config.js';
import { scanWorkspaces } from '../remote-session/workspace-scanner.js';
import type { WorkspaceInfo } from '../remote-session/protocol.js';
import type { AgentPromptImage } from './protocol.js';
import { SpacesError } from '../../types/errors.js';
import { logger } from '../../utils/logger.js';
import { toCanonicalWorkspaceId } from '../../utils/workspace-id.js';
import { writeTraceLog } from '../../utils/trace-log.js';
import type { AgentEvent } from '../../agents/backend.js';

export type AgentWorkspaceTarget = PiWorkspaceTarget;
export type AgentSessionSummary = PiAgentSessionSummary;

let initializePromise: Promise<void> | null = null;
let scanWorkspacesCache: WorkspaceInfo[] = [];


function extractPiMessagePreview(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as {
    assistantMessageEvent?: { type?: string; delta?: string };
    message?: { content?: unknown };
  };
  if (candidate.assistantMessageEvent?.type === 'text_delta' && typeof candidate.assistantMessageEvent.delta === 'string') {
    return candidate.assistantMessageEvent.delta;
  }
  const content = candidate.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textPart = content.find((part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text');
    if (textPart && typeof (textPart as { text?: unknown }).text === 'string') {
      return (textPart as { text: string }).text;
    }
  }
  return null;
}


function traceAgentControlEvent(target: PiWorkspaceTarget, event: AgentEvent): void {
  // Streaming message, queued-message, and todo reminder events can arrive
  // frequently. Logging each one made dev traces grow by hundreds of MB and
  // starved tmux-lite. State updates below still process them.
  if (event.type === 'message' || event.type === 'queued_messages') {
    return;
  }
  if (
    event.type === 'status'
    && event.payload
    && typeof event.payload === 'object'
    && (event.payload as { type?: unknown }).type === 'todo_update'
  ) {
    return;
  }
  writeTraceLog('agent-control-event', {
    workspaceId: target.workspaceId,
    sessionId: 'sessionId' in event ? event.sessionId : undefined,
    eventType: event.type,
    payloadType: event.type === 'status' && event.payload && typeof event.payload === 'object'
      ? (event.payload as { type?: unknown }).type
      : undefined,
  });
}
export async function syncKnownWorkspaces(): Promise<void> {
  const workspaces = await scanWorkspaces();
  scanWorkspacesCache = workspaces;
  for (const workspace of workspaces) {
    defaultAgentEventManager.registerWorkspace(
      toCanonicalWorkspaceId(workspace),
      workspace.path,
    );
  }
}

export function ensureAgentControlInitialized(): Promise<void> {
  if (!initializePromise) {
    initializePromise = (async () => {
      // Pi is in-process — there is no separate runtime service to subscribe to.
      // Seed sessions from Pi's session files on disk and mirror live Pi
      // events into the shared snapshot model.
      defaultPiCoordinator.setEventHandler((target, event) => {
        traceAgentControlEvent(target, event);
        switch (event.type) {
          case 'status': {
            const payload = event.payload as { type?: string; [key: string]: unknown } | undefined;
            if (payload?.type === 'busy') {
              defaultAgentEventManager.setExternalStatus(target.workspaceId, event.sessionId, { type: 'busy' });
            } else if (payload?.type === 'compacting') {
              defaultAgentEventManager.setExternalStatus(target.workspaceId, event.sessionId, { type: 'compacting' });
            } else if (payload?.type === 'retry') {
              defaultAgentEventManager.setExternalStatus(target.workspaceId, event.sessionId, {
                type: 'retry',
                attempt: Number((payload as any).attempt ?? 1),
                message: String((payload as any).message ?? 'Retrying...'),
                next: Number((payload as any).next ?? Date.now()),
              });
            } else if (payload?.type === 'dormant') {
              // The session's live worker is gone (evicted / no owners / crash):
              // return it to the dormant, not-running state (same representation
              // it has at daemon startup) so a card shows grey, not a frozen
              // busy/retry/error. Red is reserved for a live, currently-erroring
              // session. The next interaction lazily reboots it via ensureHost.
              defaultAgentEventManager.markSessionClosed(target.workspaceId, event.sessionId);
            } else if (payload?.type === 'todo_update' && Array.isArray((payload as any).phases)) {
              defaultAgentEventManager.setExternalTodoPhases(target.workspaceId, event.sessionId, (payload as any).phases);
            } else if (payload?.type === 'model_update') {
              defaultAgentEventManager.setExternalModelInfo(target.workspaceId, event.sessionId, {
                name: String((payload as any).name ?? 'Unknown'),
                provider: String((payload as any).provider ?? 'Unknown'),
              });
            } else {
              defaultAgentEventManager.setExternalStatus(target.workspaceId, event.sessionId, { type: 'idle' });
            }
            break;
          }
          case 'message': {
            const preview = extractPiMessagePreview(event.payload);
            if (preview) {
              defaultAgentEventManager.setExternalLastMessage(target.workspaceId, event.sessionId, preview);
            }
            break;
          }
          case 'transcript_live':
            defaultAgentEventManager.emitTranscriptLive(target.workspaceId, event.sessionId, event.blocks, event.committed);
            break;
          case 'queued_messages':
            defaultAgentEventManager.setExternalQueuedMessages(target.workspaceId, event.sessionId, event.queued);
            break;
          case 'error':
            defaultAgentEventManager.setExternalError(target.workspaceId, event.sessionId, event.error);
            break;
          case 'permission_added':
            defaultAgentEventManager.addPendingPermission(target.workspaceId, event.sessionId, event.permission);
            break;
          case 'permission_removed': {
            const permId = event.permissionId;
            if (permId) {
              defaultAgentEventManager.removePendingPermission(target.workspaceId, event.sessionId, permId);
            } else {
              defaultAgentEventManager.clearPendingPermissions(target.workspaceId, event.sessionId);
            }
            break;
          }
        }
      });
      await syncKnownWorkspaces();
      await seedPiSessions();
    })().catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

/**
 * Seed the AgentEventManager with sessions from Pi's session files.
 * Called at init and can be called again to refresh.
 */
async function seedPiSessions(): Promise<void> {
  const snapshot = defaultAgentEventManager.getSnapshot();
  const workspaceIds = Object.keys(snapshot);
  const startedAt = Date.now();
  let sessionCount = 0;
  for (const workspaceId of workspaceIds) {
    try {
      const target = buildTargetFromWorkspaceId(workspaceId);
      if (!target) continue;
      const wsStart = Date.now();
      const sessions = await defaultPiCoordinator.refreshAgentSessions(target);
      sessionCount += sessions.length;
      defaultAgentEventManager.syncKnownSessions(workspaceId, sessions);
      const wsElapsed = Date.now() - wsStart;
      // A slow workspace here (many/large transcripts) blocks daemon startup and
      // is the classic serve-activate wedge — surface it rather than hide it.
      if (wsElapsed > 1000) {
        console.error(`[seed-pi] slow workspace ${workspaceId}: ${sessions.length} session(s) in ${wsElapsed}ms`);
      }
    } catch {
      // non-fatal — workspace may not have Pi sessions yet
    }
  }
  console.error(`[seed-pi] seeded ${sessionCount} session(s) across ${workspaceIds.length} workspace(s) in ${Date.now() - startedAt}ms`);
}

function buildTargetFromWorkspaceId(workspaceId: string): PiWorkspaceTarget | null {
  const match = scanWorkspacesCache.find(
    (w) => toCanonicalWorkspaceId(w) === workspaceId,
  );
  if (match) {
    return {
      workspaceId,
      workspaceName: match.name,
      workspacePath: match.path,
      projectName: match.projectName,
    };
  }
  // `<project>:@base` pseudo-workspaces (project agents) never appear in the
  // scan — synthesize the target from the project's base checkout.
  if (workspaceId.endsWith(':@base')) {
    const projectName = workspaceId.slice(0, -':@base'.length);
    try {
      const baseDir = getProjectBaseDir(projectName);
      if (existsSync(baseDir)) {
        return { workspaceId, workspaceName: '@base', workspacePath: baseDir, projectName };
      }
    } catch { /* project gone */ }
  }
  return null;
}

export function subscribeAgentControl(handler: (delta: AgentStateUpdateDelta) => void): () => void {
  return defaultAgentEventManager.subscribe(handler);
}

export function getAgentControlSnapshot(): Record<string, WorkspaceAgentState> {
  return defaultAgentEventManager.getSnapshot();
}

/** Dialogs (agent "ask") currently awaiting a user answer — the live source the
 *  machine-snapshot build folds into a session's pending-question count so the
 *  session shows amber while blocked on the user. */
export function getPendingAgentDialogs(): Array<{ workspaceId: string; sessionId: string; dialogId: string }> {
  return defaultPiCoordinator.getPendingDialogs();
}

/**
 * Returns sessions for a workspace from two sources:
 * 1. The AgentEventManager snapshot (non-archived, all starting as closed at startup).
 * 2. Archived sessions from the db (with archivedAt set).
 */
export async function getKnownAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);

  // Workspaces that init-time seeding never saw (registered lazily — e.g.
  // `<project>:@base` pseudo-workspaces after a daemon restart) have an empty
  // snapshot even when Pi session files exist on disk. Seed them on first ask.
  if ((defaultAgentEventManager.getSnapshot()[target.workspaceId]?.sessions ?? []).length === 0 && target.workspacePath) {
    try {
      const sessions = await defaultPiCoordinator.refreshAgentSessions(target);
      if (sessions.length > 0) defaultAgentEventManager.syncKnownSessions(target.workspaceId, sessions);
    } catch { /* no Pi sessions yet */ }
  }

  const snapshot = defaultAgentEventManager.getSnapshot();
  const snapshotSessions: AgentSessionSummary[] = (snapshot[target.workspaceId]?.sessions ?? []).map((s) => ({
    id: s.id,
    workspaceId: target.workspaceId,
    title: s.title,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt,
  }));

  const archived: AgentSessionSummary[] = getArchivedSessions(target.workspaceId).map((a) => ({
    id: a.sessionId,
    workspaceId: target.workspaceId,
    title: a.title,
    archivedAt: a.archivedAt,
  }));

  // Merge: snapshot wins over archived for the same id (snapshot has live/closed status).
  const merged = new Map<string, AgentSessionSummary>();
  for (const s of archived) merged.set(s.id, s);
  for (const s of snapshotSessions) merged.set(s.id, s);
  return Array.from(merged.values());
}

/**
 * Fetches live sessions from Pi session files and merges closedAt from the
 * current snapshot so sessions that haven't been un-closed stay closed.
 */
export async function listLiveAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);

  const liveSessions = await defaultPiCoordinator.refreshAgentSessions(target);

  // Sync into event manager so the snapshot stays current
  defaultAgentEventManager.syncKnownSessions(target.workspaceId, liveSessions);

  // Preserve closedAt from snapshot for sessions not yet activated.
  const snapshot = defaultAgentEventManager.getSnapshot();
  const snapshotMap = new Map(
    (snapshot[target.workspaceId]?.sessions ?? []).map((s) => [s.id, s]),
  );

  return liveSessions
    .filter((s) => snapshotMap.has(s.id))
    .map((s) => ({
      ...s,
      closedAt: snapshotMap.get(s.id)?.closedAt,
    }));
}

export async function createAgentSession(target: AgentWorkspaceTarget, title?: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  const previousIds = new Set(
    (defaultAgentEventManager.getSnapshot()[target.workspaceId]?.sessions ?? []).map((session) => session.id),
  );
  const sessions = await defaultPiCoordinator.createAgentSession(target, title);
  defaultAgentEventManager.syncKnownSessions(target.workspaceId, sessions);
  for (const session of sessions) {
    if (!previousIds.has(session.id)) {
      defaultAgentEventManager.markSessionOpen(target.workspaceId, session.id);
    }
  }
  return getKnownAgentSessions(target);
}

export async function promptAgentSession(target: AgentWorkspaceTarget, agentSessionId: string, text: string, images?: AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  await defaultPiCoordinator.promptAgentSession(target, agentSessionId, text, images, options);
}

export async function removeQueuedAgentMessage(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  kind: 'steering' | 'followUp',
  index: number,
): Promise<string | null> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  return defaultPiCoordinator.removeQueuedAgentMessage(target, agentSessionId, kind, index);
}

export async function stageUploadFile(
  target: AgentWorkspaceTarget,
  fileName: string,
  data: string,
  _mimeType: string,
): Promise<{ stagedPath: string }> {
  await ensureAgentControlInitialized();
  const { join, basename } = await import('path');
  const { mkdirSync, writeFileSync } = await import('fs');

  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  const rejectUpload = (message: string): never => {
    logger.error(`[agent-control] ${message} (file=${fileName}, workspace=${target.workspacePath})`);
    throw new SpacesError(message, 'USER_ERROR', 1);
  };

  if (data.length > MAX_UPLOAD_BYTES * 2) {
    rejectUpload(`Upload rejected: base64 input length ${data.length} exceeds maximum`);
  }

  let safeName = basename(fileName).replace(/[\/\\:*?"<>|]/g, '_');
  if (safeName.length > 200) safeName = safeName.slice(0, 200);
  if (!safeName || safeName === '.' || safeName === '..') safeName = 'upload';

  const stagingDir = join(target.workspacePath, '.gitspace', 'uploads');
  let bytes: Buffer;
  try {
    mkdirSync(stagingDir, { recursive: true });

    const dotIdx = safeName.lastIndexOf('.');
    const base = dotIdx > 0 ? safeName.slice(0, dotIdx) : safeName;
    const ext = dotIdx > 0 ? safeName.slice(dotIdx) : '';

    bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      rejectUpload(`Upload rejected: decoded file size ${bytes.length} bytes exceeds limit of ${MAX_UPLOAD_BYTES} bytes`);
    }

    let counter = 0;
    let finalName = safeName;
    let finalPath = join(stagingDir, finalName);
    for (;;) {
      try {
        writeFileSync(finalPath, bytes, { flag: 'wx' });
        return { stagedPath: finalPath };
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'EEXIST') throw error;
        counter += 1;
        finalName = `${base}_${counter}${ext}`;
        finalPath = join(stagingDir, finalName);
      }
    }
  } catch (error) {
    if (error instanceof SpacesError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[agent-control] Failed staging upload ${fileName} in ${stagingDir}: ${message}`);
    throw new SpacesError(`Failed to stage upload ${fileName}`, 'SYSTEM_ERROR', 2);
  }
}

/**
 * Kill the agent's tmux terminal session entirely.
 *
 * WARNING — naming confusion: in the Pi SDK, "abort" means "interrupt the
 * current turn." In GitSpace, abortAgentSession means "kill the session."
 * For interrupting the current turn without killing the session, use
 * interruptAgentSession() instead.
 */
export async function abortAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  const result = await defaultPiCoordinator.closeAgentSession(target, agentSessionId);
  defaultAgentEventManager.markSessionClosed(target.workspaceId, agentSessionId);
  return result;
}

/**
 * Interrupt the agent's current turn (stop LLM streaming / tool execution)
 * without killing the session. The session stays alive for new prompts.
 *
 * This calls the Pi SDK's session.abort() — which, despite its name, is an
 * interrupt, not a kill. See the naming note on abortAgentSession().
 */
export async function interruptAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  return defaultPiCoordinator.interruptAgentSession(target, agentSessionId);
}

export async function closeAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  await defaultPiCoordinator.closeAgentSession(target, agentSessionId);
  defaultAgentEventManager.markSessionClosed(target.workspaceId, agentSessionId);
  return getKnownAgentSessions(target);
}

export async function archiveAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  const snapshot = defaultAgentEventManager.getSnapshot();
  const sess = snapshot[target.workspaceId]?.sessions.find((s) => s.id === agentSessionId);
  const title = sess?.title ?? agentSessionId;
  await defaultPiCoordinator.archiveAgentSession(target, agentSessionId, title);
  defaultAgentEventManager.markSessionArchived(target.workspaceId, agentSessionId);
  return getKnownAgentSessions(target);
}

export async function restoreAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  const archived = getArchivedSessions(target.workspaceId).find((a) => a.sessionId === agentSessionId);
  const title = archived?.title ?? agentSessionId;
  await defaultPiCoordinator.restoreAgentSession(target, agentSessionId);
  defaultAgentEventManager.markSessionRestored(target.workspaceId, agentSessionId, title);
  return getKnownAgentSessions(target);
}

/**
 * Open an agent session for a client pane: mark it open, reconcile the
 * workspace, and take a viewer LEASE that keeps its host alive while at least
 * one pane is watching.
 */
export async function openAgentSession(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  leaseKey: string,
): Promise<number> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  defaultAgentEventManager.syncKnownSessions(
    target.workspaceId,
    await defaultPiCoordinator.refreshAgentSessions(target),
  );
  const leaseCount = await defaultPiCoordinator.openAgentSession(target, agentSessionId, leaseKey);
  defaultAgentEventManager.markSessionOpen(target.workspaceId, agentSessionId);
  void defaultAgentEventManager.reconcileWorkspace(target.workspaceId);
  return leaseCount;
}

/** Drop one pane's lease. Returns the owning workspace plus the viewers still
 *  holding the session open, or null when that lease was already gone. */
export function releaseAgentSessionLease(
  agentSessionId: string,
  leaseKey: string,
): { workspaceId: string; remaining: number } | null {
  return defaultPiCoordinator.releaseAgentLease(agentSessionId, leaseKey);
}

/** A client went away: drop every lease it held. */
export function releaseAgentSessionLeasesForOwner(ownerPrefix: string): void {
  defaultPiCoordinator.releaseAgentLeasesForOwner(ownerPrefix);
}

export async function respondToAgentPermission(
  _target: AgentWorkspaceTarget,
  _agentSessionId: string,
  _permissionId: string,
  _response: 'allow' | 'deny',
): Promise<boolean> {
  // Pi handles permissions through its own TUI — the user responds directly
  // in the attached terminal session. This is a no-op for now.
  // TODO: implement Pi permission handling via RPC or extension when needed.
  return false;
}

export function markAgentSessionIdle(workspaceId: string, sessionId: string): void {
  defaultAgentEventManager.markSessionIdle(workspaceId, sessionId);
}

/** Read one page of a session's transcript as blocks (range-paginated). */
export async function readAgentTranscriptRange(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  opts: { before?: string; limit: number },
): Promise<TranscriptPage> {
  return defaultPiCoordinator.readTranscriptRange(target, agentSessionId, opts);
}

/** Control-surface snapshot for a session (usage + model switcher). */
export async function getAgentControlInfo(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
): Promise<AgentControlInfo> {
  return defaultPiCoordinator.getControlInfo(target, agentSessionId);
}

/** Per-session usage attribution from the transcript (no host spin-up). */
export async function getAgentSessionUsageReport(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
): Promise<import('../../agents/agent-runtime-types.js').AgentSessionUsageReport | null> {
  return defaultPiCoordinator.getSessionUsageReport(target, agentSessionId);
}

/** Switch the session's model. */
export async function setAgentModel(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  provider: string,
  modelId: string,
): Promise<boolean> {
  return defaultPiCoordinator.setModel(target, agentSessionId, provider, modelId);
}

/** Set the session's thinking/reasoning level. */
export async function setAgentThinkingLevel(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  level: string,
): Promise<boolean> {
  return defaultPiCoordinator.setThinkingLevel(target, agentSessionId, level);
}

/** Read session-local Goal Mode without reopening a cold session. */
export async function getAgentGoalMode(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
): Promise<AgentGoalModeInfo> {
  return defaultPiCoordinator.getGoalMode(target, agentSessionId);
}

/** Enable or disable session-local Goal Mode for a workspace-bound goal. */
export async function setAgentGoalMode(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  input: { enabled: boolean; precursor?: string },
): Promise<AgentGoalModeInfo> {
  return defaultPiCoordinator.setGoalMode(target, agentSessionId, input);
}

/** Reduce heavy output or images in one live agent session's active context. */
export async function shakeAgentSession(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  mode: AgentShakeMode,
): Promise<AgentShakeResult> {
  return defaultPiCoordinator.shake(target, agentSessionId, mode);
}

/** Set the tool-approval mode. */
export async function setAgentApprovalMode(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  mode: string,
): Promise<boolean> {
  return defaultPiCoordinator.setApprovalMode(target, agentSessionId, mode);
}

/** List providers + their auth status, incl. the per-provider account pool. */
export async function getAgentAuthProviders(): Promise<Array<{ provider: string; hasAuth: boolean; accounts?: Array<{ id: number; type: string; label: string; disabled: boolean }> }>> {
  return defaultPiCoordinator.getAuthProviders();
}

/** Remove one account (credential) from a provider's pool by row id. */
export async function removeAgentProviderAccount(provider: string, credentialId: number): Promise<boolean> {
  return defaultPiCoordinator.removeProviderAccount(provider, credentialId);
}

/** Probe live usage/limit windows for a provider's accounts (on-demand). */
export async function checkAgentProviderUsage(provider: string): Promise<Array<{ id: number; email?: string; ok: boolean | null; reason?: string; limits: Array<{ label: string; unit?: string; used?: number; limit?: number; remaining?: number; remainingFraction?: number; resetsAt?: number; status?: string }>; resetCredits?: { availableCount: number } }>> {
  return defaultPiCoordinator.checkProviderUsage(provider);
}

/** Store an API key for a provider. */
export async function setAgentProviderApiKey(provider: string, key: string): Promise<boolean> {
  return defaultPiCoordinator.setProviderApiKey(provider, key);
}

/** Start an OAuth sign-in flow; emits events via the agent-event-manager. */
export async function startAgentOAuthLogin(provider: string, flowId: string): Promise<void> {
  return defaultPiCoordinator.startOAuthLogin(provider, flowId, (event) => {
    defaultAgentEventManager.emitOAuthEvent(event);
  });
}

/** Provide the value an in-progress OAuth flow asked for. */
export function respondAgentOAuthPrompt(flowId: string, value: string): boolean {
  return defaultPiCoordinator.respondOAuthPrompt(flowId, value);
}

/** Read the curated settings catalog. */
export async function getAgentSettings(): Promise<Array<{ path: string; label: string; kind: 'boolean' | 'enum'; value: string | boolean | null; options?: string[] }>> {
  return defaultPiCoordinator.getSettings();
}

/** Write a single setting. */
export async function setAgentSetting(path: string, value: string | number | boolean | string[]): Promise<boolean> {
  return defaultPiCoordinator.setSetting(path, value);
}

/** Full settings schema (by tab) with current values. */
export async function getAgentSettingsSchema(): Promise<import('../../agents/agent-runtime-types.js').AgentSettingSchemaItem[]> {
  return defaultPiCoordinator.getSettingsSchema();
}

/** Tools available to a session (per-tool approval). */
export async function getAgentTools(target: AgentWorkspaceTarget, agentSessionId: string): Promise<import('../../agents/agent-runtime-types.js').AgentToolInfo[]> {
  return defaultPiCoordinator.getTools(target, agentSessionId);
}

/** Discovered subagent definitions for a workspace (AGENTS settings section). */
export async function listAgentDefinitions(target: AgentWorkspaceTarget): Promise<import('../../agents/agent-runtime-types.js').AgentDefinitionInfo[]> {
  return defaultPiCoordinator.listAgents(target);
}

/** Compact a session's context. */
export async function compactAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
  return defaultPiCoordinator.compactSession(target, agentSessionId);
}

/** Cycle the active model through configured roles. */
export async function cycleAgentRole(target: AgentWorkspaceTarget, agentSessionId: string, direction: 'forward' | 'backward'): Promise<boolean> {
  return defaultPiCoordinator.cycleRole(target, agentSessionId, direction);
}

/** Apply a specific role's model to the session. */
export async function applyAgentModelRole(target: AgentWorkspaceTarget, agentSessionId: string, role: string): Promise<boolean> {
  return defaultPiCoordinator.applyRole(target, agentSessionId, role);
}

/** User-message checkpoints for conversation rewind. */
export async function getAgentHistory(target: AgentWorkspaceTarget, agentSessionId: string): Promise<import('../../agents/agent-runtime-types.js').AgentHistoryEntry[]> {
  return defaultPiCoordinator.getHistory(target, agentSessionId);
}

/** Navigate the conversation tree (redo = rewind to parent + editorText; jump =
 *  make the node the leaf). */
export async function navigateAgentHistory(target: AgentWorkspaceTarget, agentSessionId: string, entryId: string, mode: 'redo' | 'jump' = 'redo'): Promise<{ ok: boolean; editorText?: string }> {
  return defaultPiCoordinator.navigateHistory(target, agentSessionId, entryId, mode);
}

/** The full conversation tree (message nodes) for the branch explorer. */
export async function getAgentSessionTree(target: AgentWorkspaceTarget, agentSessionId: string): Promise<import('../../agents/agent-runtime-types.js').AgentTreeNode[]> {
  return defaultPiCoordinator.getSessionTree(target, agentSessionId);
}

// ---------------------------------------------------------------------------
// Host UI bridge wiring
// ---------------------------------------------------------------------------

/**
 * Install the bridge emitter so extension dialog requests and UI events
 * are broadcast to watching clients. Call once during tmux-lite server setup.
 */
export function setAgentHostUIEmitter(emitter: HostUIBridgeEmitter | null): void {
  defaultPiCoordinator.setHostUIEmitter(emitter);
}

/**
 * Daemon shutdown: kill every live agent session host (worker child
 * processes die with the daemon). Signal-handler safe.
 */
export function shutdownAgentHosts(): void {
  defaultPiCoordinator.shutdownHosts();
}

/**
 * Route a dialog response from a client to the pending SDK Promise.
 */
export function resolveAgentDialogResponse(response: HostUIDialogResponse): Promise<boolean> {
  return defaultPiCoordinator.resolveDialogResponse(response);
}

/**
 * Every still-pending host-UI dialog request across live sessions. Used by the
 * serve-runtime connect-time catch-up to re-push dialogs to a (re)connecting
 * client that missed the original broadcast while the agent stayed blocked.
 */
export function getPendingAgentDialogRequests(): import('./agents/host-ui-bridge.js').HostUIDialogRequest[] {
  return defaultPiCoordinator.getPendingDialogRequests();
}

export async function listAgentCommands(
    target: AgentWorkspaceTarget,
): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>> {
    await ensureAgentControlInitialized();
    return defaultPiCoordinator.listAvailableCommands(target);
}

export async function getFileSuggestions(
    target: AgentWorkspaceTarget,
    prefix: string,
    limit: number = 50,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
    await ensureAgentControlInitialized();
    const { join, relative } = await import('path');
    const { readdirSync, realpathSync } = await import('fs');

    const results: Array<{ path: string; isDirectory: boolean }> = [];
    const workspacePath = target.workspacePath;

    const cleanPrefix = prefix.startsWith('@') ? prefix.slice(1) : prefix;
    const segments = cleanPrefix.split('/').filter(Boolean);
    if (cleanPrefix.startsWith('/') || segments.some((seg) => seg === '..' || seg.startsWith('.') || ['node_modules', '__pycache__', '.git'].includes(seg))) {
      return [];
    }

    const lastSlash = cleanPrefix.lastIndexOf('/');
    const searchDir = lastSlash >= 0
      ? join(workspacePath, cleanPrefix.slice(0, lastSlash))
      : workspacePath;
    const filePrefix = lastSlash >= 0
      ? cleanPrefix.slice(lastSlash + 1).toLowerCase()
      : cleanPrefix.toLowerCase();
    const relativeBase = lastSlash >= 0 ? cleanPrefix.slice(0, lastSlash + 1) : '';

    try {
      const resolvedWorkspace = realpathSync(workspacePath);
      const resolvedSearch = realpathSync(searchDir);
      const relativeSearch = relative(resolvedWorkspace, resolvedSearch);
      if (relativeSearch === '..' || relativeSearch.startsWith('../') || relativeSearch.startsWith('..\\')) {
        return [];
      }

      const entries = readdirSync(resolvedSearch, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory() && ['node_modules', '__pycache__', '.git'].includes(entry.name)) continue;

        if (entry.name.toLowerCase().startsWith(filePrefix)) {
          results.push({
            path: relativeBase + entry.name,
            isDirectory: entry.isDirectory(),
          });
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — return empty
    }

    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return results.slice(0, limit);
}