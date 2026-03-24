import {
  killSession as killTmuxSession,
  listSessions as listTmuxSessions,
  createSession as createTmuxSession,
} from '../cli.js';
import type { Session as TmuxSession } from '../protocol.js';
import { setupPiEnvironment, ensureOmpInstalled } from './pi-runtime.js';
import { listPiSessions, findPiSessionFile, type PiSessionFileInfo } from './pi-session-files.js';
import { upsertArchivedSession, deleteArchivedSession } from '../../../agents/agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../../agents/session-display.js';

export const PI_AGENT_TMUX_SESSION_KIND = 'agent';

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

function findTmuxSessionForWorkspace(sessions: TmuxSession[], workspaceId: string): TmuxSession | undefined {
  return sessions.find(
    (s) => s.kind === PI_AGENT_TMUX_SESSION_KIND
      && s.metadata?.workspaceId === workspaceId
      && s.exitCode === undefined,
  );
}

export class PiCoordinator {
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();

  /**
   * List Pi agent sessions for a workspace by reading session files on disk.
   * Session IDs come from Pi's JSONL files — these are the canonical IDs.
   */
  async refreshAgentSessions(target: PiWorkspaceTarget): Promise<PiAgentSessionSummary[]> {
    const sessions = listPiSessions(target.workspacePath);
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
   * Spawns omp in a tmux-lite PTY. Pi creates its own session file on startup.
   * We discover Pi's session ID after startup by reading the session directory.
   */
  async createAgentSession(target: PiWorkspaceTarget, title?: string): Promise<PiAgentSessionSummary[]> {
    // Snapshot existing sessions before spawning
    const before = await this.refreshAgentSessions(target);
    const beforeIds = new Set(before.map((s) => s.id));

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
          agentSessionId: placeholderId, // temporary until we discover Pi's ID
        },
      },
    );

    // Give Pi a moment to create its session file, then discover the new ID
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await this.refreshAgentSessions(target);
    const newSession = after.find((s) => !beforeIds.has(s.id));

    if (newSession) {
      // Update the tmux session metadata with Pi's actual session ID
      // (We can't update metadata on an existing tmux session, so we store
      // the mapping for lookups. The tmux session still has the placeholder.)
      this.sessionIdMap.set(`${target.workspaceId}:${newSession.id}`, tmuxSession.id);
    }

    const created: PiAgentSessionSummary = {
      id: newSession?.id ?? placeholderId,
      workspaceId: target.workspaceId,
      title: title ?? newSession?.title ?? `New session`,
      updatedAt: new Date().toISOString(),
    };

    return mergeCreatedSession(after, created);
  }

  async closeAgentSession(target: PiWorkspaceTarget, agentSessionId: string): Promise<void> {
    try {
      const sessions = await listTmuxSessions();
      // Check both direct metadata match and our ID mapping
      const pty = sessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId))
        ?? this.findMappedTmuxSession(sessions, target.workspaceId, agentSessionId);
      if (pty) await killTmuxSession(pty.id);
    } catch {
      // non-fatal
    }
    this.cleanupSessionMapping(target.workspaceId, agentSessionId);
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

    // Find the Pi session file to resume
    const match = findPiSessionFile(target.workspacePath, agentSessionId);
    const ompArgs = match?.path
      ? ['--session', match.path]
      : [];

    const tmuxSession = await createTmuxSession(
      buildAgentTerminalSessionName(target, agentSessionId),
      target.workspacePath,
      {
        command: ompBin,
        args: ompArgs,
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

    return tmuxSession;
  }

  // -------------------------------------------------------------------------
  // Session ID mapping (tmux placeholder ID → Pi's actual session ID)
  // -------------------------------------------------------------------------

  /** Maps "workspaceId:piSessionId" → tmuxSessionId for sessions created with placeholder IDs */
  private readonly sessionIdMap = new Map<string, string>();

  private findMappedTmuxSession(
    tmuxSessions: TmuxSession[],
    workspaceId: string,
    agentSessionId: string,
  ): TmuxSession | undefined {
    const mappedTmuxId = this.sessionIdMap.get(`${workspaceId}:${agentSessionId}`);
    if (!mappedTmuxId) return undefined;
    return tmuxSessions.find((s) => s.id === mappedTmuxId);
  }

  private cleanupSessionMapping(workspaceId: string, agentSessionId: string): void {
    this.sessionIdMap.delete(`${workspaceId}:${agentSessionId}`);
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
