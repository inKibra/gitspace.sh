import { defaultPiCoordinator, type PiWorkspaceTarget, type PiAgentSessionSummary } from './agents/pi-coordinator.js';
import type { HostUIBridgeEmitter, HostUIDialogResponse } from './agents/host-ui-bridge.js';
import {
  defaultAgentEventManager,
  type AgentStateUpdateDelta,
  type WorkspaceAgentState,
} from './agent-event-manager.js';
import { getArchivedSessions } from '../../agents/agent-db.js';
import { scanWorkspaces } from '../remote-session/workspace-scanner.js';
import type { WorkspaceInfo } from '../remote-session/protocol.js';
import type { AgentPromptImage } from './protocol.js';
import { toCanonicalWorkspaceId } from '../../utils/workspace-id.js';


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
        switch (event.type) {
          case 'status': {
            const payload = event.payload as { type?: string; [key: string]: unknown } | undefined;
            if (payload?.type === 'busy') {
              defaultAgentEventManager.setExternalStatus(target.workspaceId, event.sessionId, { type: 'busy' });
            } else if (payload?.type === 'retry') {
              defaultAgentEventManager.setExternalStatus(target.workspaceId, event.sessionId, {
                type: 'retry',
                attempt: Number((payload as any).attempt ?? 1),
                message: String((payload as any).message ?? 'Retrying...'),
                next: Number((payload as any).next ?? Date.now()),
              });
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
          case 'error':
            defaultAgentEventManager.setExternalError(target.workspaceId, event.sessionId, event.error);
            break;
          case 'question_added':
            defaultAgentEventManager.addPendingQuestion(target.workspaceId, event.sessionId, event.question);
            break;
          case 'question_removed':
            defaultAgentEventManager.removePendingQuestion(target.workspaceId, event.sessionId, event.questionId);
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
  for (const workspaceId of Object.keys(snapshot)) {
    try {
      const target = buildTargetFromWorkspaceId(workspaceId);
      if (!target) continue;
      const sessions = await defaultPiCoordinator.refreshAgentSessions(target);
      defaultAgentEventManager.syncKnownSessions(workspaceId, sessions);
    } catch {
      // non-fatal — workspace may not have Pi sessions yet
    }
  }
}

function buildTargetFromWorkspaceId(workspaceId: string): PiWorkspaceTarget | null {
  const match = scanWorkspacesCache.find(
    (w) => toCanonicalWorkspaceId(w) === workspaceId,
  );
  if (!match) return null;
  return {
    workspaceId,
    workspaceName: match.name,
    workspacePath: match.path,
    projectName: match.projectName,
  };
}

export function subscribeAgentControl(handler: (delta: AgentStateUpdateDelta) => void): () => void {
  return defaultAgentEventManager.subscribe(handler);
}

export function getAgentControlSnapshot(): Record<string, WorkspaceAgentState> {
  return defaultAgentEventManager.getSnapshot();
}

export function rebindPiTerminalSessionOwnership(
  workspaceId: string,
  terminalSessionId: string,
  agentSessionId: string,
): { previousAgentSessionId?: string; previousOwnerCount: number; nextOwnerCount: number } {
  return defaultPiCoordinator.rebindTerminalSession(workspaceId, terminalSessionId, agentSessionId);
}

export function releasePiTerminalSessionOwnership(terminalSessionId: string): void {
  defaultPiCoordinator.releaseTerminalSession(terminalSessionId);
}

/**
 * Returns sessions for a workspace from two sources:
 * 1. The AgentEventManager snapshot (non-archived, all starting as closed at startup).
 * 2. Archived sessions from the db (with archivedAt set).
 */
export async function getKnownAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);

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

export async function promptAgentSession(target: AgentWorkspaceTarget, agentSessionId: string, text: string, images?: AgentPromptImage[]): Promise<void> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  await defaultPiCoordinator.promptAgentSession(target, agentSessionId, text, images);
}

export async function stageUploadFile(
  target: AgentWorkspaceTarget,
  fileName: string,
  data: string,
  mimeType: string,
): Promise<{ stagedPath: string }> {
  await ensureAgentControlInitialized();
  const { join, basename } = await import('path');
  const { mkdirSync, writeFileSync, existsSync } = await import('fs');

  // Sanitize filename: strip path components, limit length
  let safeName = basename(fileName).replace(/[\/\\:*?"<>|]/g, '_');
  if (safeName.length > 200) safeName = safeName.slice(0, 200);
  if (!safeName) safeName = 'upload';

  const stagingDir = join(target.workspacePath, '.gitspace', 'uploads');
  mkdirSync(stagingDir, { recursive: true });

  // Deduplicate: if file exists, append _N before extension
  let finalName = safeName;
  let finalPath = join(stagingDir, finalName);
  if (existsSync(finalPath)) {
    const dotIdx = safeName.lastIndexOf('.');
    const base = dotIdx > 0 ? safeName.slice(0, dotIdx) : safeName;
    const ext = dotIdx > 0 ? safeName.slice(dotIdx) : '';
    let counter = 1;
    while (existsSync(finalPath)) {
      finalName = `${base}_${counter}${ext}`;
      finalPath = join(stagingDir, finalName);
      counter++;
    }
  }

  // Decode base64 and write
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(finalPath, bytes);

  return { stagedPath: finalPath };
}

export async function abortAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  // Pi doesn't have a separate abort API — closing the session stops the agent.
  return defaultPiCoordinator.closeAgentSession(target, agentSessionId);
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

export async function attachAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<import('./protocol.js').Session> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  defaultAgentEventManager.syncKnownSessions(
    target.workspaceId,
    await defaultPiCoordinator.refreshAgentSessions(target),
  );
  const session = await defaultPiCoordinator.ensureAgentTerminalSession(target, agentSessionId);
  defaultAgentEventManager.markSessionOpen(target.workspaceId, agentSessionId);
  void defaultAgentEventManager.reconcileWorkspace(target.workspaceId);
  return session;
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
 * Route a dialog response from a client to the pending SDK Promise.
 */
export function resolveAgentDialogResponse(response: HostUIDialogResponse): boolean {
  return defaultPiCoordinator.resolveDialogResponse(response);
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
    const { join } = await import('path');
    const { readdirSync } = await import('fs');

    const results: Array<{ path: string; isDirectory: boolean }> = [];
    const workspacePath = target.workspacePath;

    // Normalize prefix: strip leading @ if present
    const cleanPrefix = prefix.startsWith('@') ? prefix.slice(1) : prefix;

    // Determine search directory and name prefix from the cleaned input
    const lastSlash = cleanPrefix.lastIndexOf('/');
    const searchDir = lastSlash >= 0
        ? join(workspacePath, cleanPrefix.slice(0, lastSlash))
        : workspacePath;
    const filePrefix = lastSlash >= 0
        ? cleanPrefix.slice(lastSlash + 1).toLowerCase()
        : cleanPrefix.toLowerCase();
    const relativeBase = lastSlash >= 0 ? cleanPrefix.slice(0, lastSlash + 1) : '';

    try {
        const entries = readdirSync(searchDir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= limit) break;
            // Skip hidden files and noisy directories
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

    // Directories first, then alphabetical within each group
    results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
    });

    return results;
}