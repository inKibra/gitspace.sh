import type { AgentSession } from '@oh-my-pi/pi-coding-agent';
import {
  killSession as killTmuxSession,
  listSessions as listTmuxSessions,
  createSession as createTmuxSession,
} from '../cli.js';
import { getRouterSocket, type Session as TmuxSession } from '../protocol.js';
import {
  setupPiEnvironment,
  ensureOmpInstalled,
  createPiSessionManager,
  getGitspacePiExtensionPaths,
  openPiSession,
  persistInitialPiSessionModel,
} from './pi-runtime.js';
import { buildPiRuntimeChildEnvironment } from './pi-runtime-status.js';
import { listPiSessions, findPiSessionFile, type PiSessionFileInfo } from './pi-session-files.js';
import { upsertArchivedSession, deleteArchivedSession } from '../../../agents/agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../../agents/session-display.js';
import type { AgentEvent } from '../../../agents/backend.js';

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


export class PiCoordinator {
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();
  private readonly sessionIdMap = new Map<string, string>();
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly sessionUnsubscribers = new Map<string, () => void>();
  private readonly sessionsRoot: string | undefined;
  private eventHandler: ((target: PiWorkspaceTarget, event: AgentEvent) => void) | null = null;

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = sessionsRoot;
  }

  setEventHandler(handler: ((target: PiWorkspaceTarget, event: AgentEvent) => void) | null): void {
    this.eventHandler = handler;
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
   * Create a new Pi agent session in-process so we get the canonical session ID
   * immediately and can subscribe to live events. tmux terminals are created later
   * when the user explicitly attaches.
   */
  async createAgentSession(target: PiWorkspaceTarget, title?: string): Promise<PiAgentSessionSummary[]> {
    const { createAgentSession: createPiAgentSession } = await import('@oh-my-pi/pi-coding-agent');
    const { agentDir, sessionManager } = await createPiSessionManager(target.workspacePath);
    const { session } = await createPiAgentSession({
      agentDir,
      sessionManager,
      cwd: target.workspacePath,
      additionalExtensionPaths: getGitspacePiExtensionPaths(),
    });
    if (title) {
      await sessionManager.setSessionName(title);
    }
    await persistInitialPiSessionModel(session);
    await sessionManager.rewriteEntries();

    const sessionId = session.sessionId;
    this.activeSessions.set(sessionId, session);
    this.bindSessionEvents(target, sessionId, title, session);

    const sessionFile = await this.waitForSessionFile(target.workspacePath, sessionId);
    if (!sessionFile) {
      this.disposeActiveSession(sessionId);
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
    this.disposeActiveSession(agentSessionId);

    let killed = false;
    try {
      const sessions = await listTmuxSessions();
      const pty = sessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId))
        ?? this.findMappedTmuxSession(sessions, target.workspaceId, agentSessionId);
      if (pty) {
        await killTmuxSession(pty.id);
        killed = true;
      }
    } catch {
      // non-fatal
    }
    this.sessionIdMap.delete(`${target.workspaceId}:${agentSessionId}`);
    return killed;
  }

  async promptAgentSession(target: PiWorkspaceTarget, agentSessionId: string, text: string): Promise<void> {
    const session = await this.ensureActiveSession(target, agentSessionId);
    await session.prompt(text);
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

  /**
   * Ensure a tmux-lite PTY session exists for a Pi agent session.
   * Uses Pi's session ID to find and resume the right JSONL file.
   * Throws if the session file is not found (prevents silent mismatch).
   */
  async ensureAgentTerminalSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<TmuxSession> {
    const key = `${target.workspaceId}:${agentSessionId}`;
    const inFlight = this.inflightTerminalSessions.get(key);
    if (inFlight) return inFlight;

    const ensurePromise = this.ensureAgentTerminalSessionInternal(target, agentSessionId).finally(() => {
      this.inflightTerminalSessions.delete(key);
    });
    this.inflightTerminalSessions.set(key, ensurePromise);
    return ensurePromise;
  }

  private async ensureAgentTerminalSessionInternal(
    target: PiWorkspaceTarget,
    agentSessionId: string,
  ): Promise<TmuxSession> {
    const tmuxSessions = await listTmuxSessions();
    const existing = tmuxSessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId))
      ?? this.findMappedTmuxSession(tmuxSessions, target.workspaceId, agentSessionId);
    if (existing && existing.exitCode === undefined) return existing;

    const ompBin = await ensureOmpInstalled();
    const env = {
      ...setupPiEnvironment(target),
      ...buildPiRuntimeChildEnvironment(getRouterSocket()),
    };

    const match = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!match) {
      throw new Error(
        `Pi session '${agentSessionId}' not found for workspace '${target.workspaceId}'. ` +
        `The session file may have been deleted or the ID is stale.`,
      );
    }

    void this.ensureActiveSession(target, agentSessionId, match).catch(() => {
      // Non-fatal for attach: the terminal should still open even if SDK rehydration fails.
      // promptAgentSession() performs the same rehydration synchronously and will surface errors there.
    });

    const extensionArgs = getGitspacePiExtensionPaths().flatMap((extensionPath) => [
      '--extension',
      extensionPath,
    ]);

    const tmuxSession = await createTmuxSession(
      buildAgentTerminalSessionName(target, agentSessionId),
      target.workspacePath,
      {
        command: ompBin,
        args: ['--session', match.path, ...extensionArgs],
        env,
        kind: PI_AGENT_TMUX_SESSION_KIND,
        hidden: true,
        recordReplay: false,
        metadata: {
          workspaceId: target.workspaceId,
          agentSessionId,
        },
      },
    );
    this.sessionIdMap.set(`${target.workspaceId}:${agentSessionId}`, tmuxSession.id);
    return tmuxSession;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureActiveSession(
    target: PiWorkspaceTarget,
    agentSessionId: string,
    sessionFile: PiSessionFileInfo | null = null,
  ): Promise<AgentSession> {
    const existing = this.activeSessions.get(agentSessionId);
    if (existing) {
      return existing;
    }

    const match = sessionFile ?? findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!match) {
      throw new Error(
        `Pi session '${agentSessionId}' not found for workspace '${target.workspaceId}'. ` +
        `The session file may have been deleted or the ID is stale.`,
      );
    }

    const { session } = await openPiSession(target.workspacePath, match.path);
    if (session.sessionId !== agentSessionId) {
      session.dispose();
      throw new Error(
        `Pi session file '${match.path}' reopened as '${session.sessionId}', expected '${agentSessionId}'.`,
      );
    }

    this.activeSessions.set(agentSessionId, session);
    this.bindSessionEvents(
      target,
      agentSessionId,
      match.title ?? match.firstMessage ?? undefined,
      session,
    );
    return session;
  }


  private bindSessionEvents(
    target: PiWorkspaceTarget,
    sessionId: string,
    title: string | undefined,
    session: AgentSession,
  ): void {
    const existing = this.sessionUnsubscribers.get(sessionId);
    existing?.();

    const summaryTitle = title ?? sessionId;
    const unsubscribe = session.subscribe((piEvent: { type?: string; [key: string]: unknown }) => {
      if (!this.eventHandler || typeof piEvent.type !== 'string') {
        return;
      }

      if (piEvent.type === 'message_update') {
        this.eventHandler(target, {
          type: 'message',
          sessionId,
          payload: { ...piEvent, title: summaryTitle },
        });
        return;
      }

      if (piEvent.type === 'agent_start') {
        this.eventHandler(target, {
          type: 'status',
          sessionId,
          payload: { type: 'busy', event: piEvent },
        });
        return;
      }

      if (piEvent.type === 'agent_end') {
        this.eventHandler(target, {
          type: 'status',
          sessionId,
          payload: { type: 'idle', event: piEvent },
        });
      }
    });

    this.sessionUnsubscribers.set(sessionId, unsubscribe);
  }

  private disposeActiveSession(sessionId: string): void {
    const unsubscribe = this.sessionUnsubscribers.get(sessionId);
    unsubscribe?.();
    this.sessionUnsubscribers.delete(sessionId);

    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.dispose();
      this.activeSessions.delete(sessionId);
    }
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
    const mappedTmuxId = this.sessionIdMap.get(`${workspaceId}:${agentSessionId}`);
    if (!mappedTmuxId) return undefined;
    return tmuxSessions.find((s) => s.id === mappedTmuxId);
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
