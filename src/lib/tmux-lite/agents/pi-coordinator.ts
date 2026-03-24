import {
  killSession as killTmuxSession,
  listSessions as listTmuxSessions,
  createSession as createTmuxSession,
} from '../cli.js';
import type { Session as TmuxSession } from '../protocol.js';
import { setupPiEnvironment, ensureOmpInstalled } from './pi-runtime.js';
import { listPiSessions, findPiSessionFile, getDefaultSessionsRoot } from './pi-session-files.js';
import { upsertArchivedSession, deleteArchivedSession } from '../../../agents/agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../../agents/session-display.js';

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
  /** Maps "workspaceId:piSessionId" → tmuxSessionId for sessions created with placeholder IDs */
  private readonly sessionIdMap = new Map<string, string>();
  private readonly sessionsRoot: string | undefined;

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = sessionsRoot;
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
   * Create a new Pi agent session.
   * Spawns omp in a tmux-lite PTY. Polls for Pi's session file to discover
   * the canonical session ID (replaces the old fixed-timeout approach).
   */
  async createAgentSession(target: PiWorkspaceTarget, title?: string): Promise<PiAgentSessionSummary[]> {
    // Snapshot existing session IDs before spawning
    const beforeIds = new Set(
      listPiSessions(target.workspacePath, this.sessionsRoot).map((s) => s.id),
    );

    // Spawn omp in a tmux-lite PTY (fresh session, no --session flag)
    const ompBin = await ensureOmpInstalled();
    const env = setupPiEnvironment(target);
    const placeholderId = `pending-${Date.now().toString(36)}`;

    const tmuxSession = await createTmuxSession(
      buildAgentTerminalSessionName(target, placeholderId),
      target.workspacePath,
      {
        command: ompBin,
        args: [],
        env,
        kind: PI_AGENT_TMUX_SESSION_KIND,
        hidden: true,
        recordReplay: false,
        metadata: {
          workspaceId: target.workspaceId,
          agentSessionId: placeholderId,
        },
      },
    );

    // Poll for Pi's session file to appear (replaces racy fixed timeout)
    const newSessionId = await this.pollForNewSession(
      target.workspacePath,
      beforeIds,
    );

    if (newSessionId) {
      this.sessionIdMap.set(`${target.workspaceId}:${newSessionId}`, tmuxSession.id);
    }

    const sessions = await this.refreshAgentSessions(target);
    const created: PiAgentSessionSummary = {
      id: newSessionId ?? placeholderId,
      workspaceId: target.workspaceId,
      title: title ?? sessions.find((s) => s.id === newSessionId)?.title ?? 'New session',
      updatedAt: new Date().toISOString(),
    };

    return mergeCreatedSession(sessions, created);
  }

  async closeAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<void> {
    try {
      const sessions = await listTmuxSessions();
      const pty = sessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId))
        ?? this.findMappedTmuxSession(sessions, target.workspaceId, agentSessionId);
      if (pty) await killTmuxSession(pty.id);
    } catch {
      // non-fatal
    }
    this.sessionIdMap.delete(`${target.workspaceId}:${agentSessionId}`);
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
    // Check for existing running tmux session (direct metadata or mapped)
    const tmuxSessions = await listTmuxSessions();
    const existing = tmuxSessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId))
      ?? this.findMappedTmuxSession(tmuxSessions, target.workspaceId, agentSessionId);
    if (existing && existing.exitCode === undefined) return existing;

    const ompBin = await ensureOmpInstalled();
    const env = setupPiEnvironment(target);

    // Find the Pi session file to resume — fail if not found
    const match = findPiSessionFile(target.workspacePath, agentSessionId, this.sessionsRoot);
    if (!match) {
      throw new Error(
        `Pi session '${agentSessionId}' not found for workspace '${target.workspaceId}'. ` +
        `The session file may have been deleted or the ID is stale.`,
      );
    }

    return createTmuxSession(
      buildAgentTerminalSessionName(target, agentSessionId),
      target.workspacePath,
      {
        command: ompBin,
        args: ['--session', match.path],
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
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Poll the session directory until a new session file appears (one that
   * wasn't in beforeIds). Returns the new session ID, or null on timeout.
   */
  private async pollForNewSession(
    workspacePath: string,
    beforeIds: Set<string>,
  ): Promise<string | null> {
    const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const sessions = listPiSessions(workspacePath, this.sessionsRoot);
      const newSession = sessions.find((s) => !beforeIds.has(s.id));
      if (newSession) return newSession.id;
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
