import type { OmpAgentSession } from './omp-types.js';
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
  importOmpModule,
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

interface TerminalSessionBinding {
  workspaceId: string;
  agentSessionId: string;
}


export class PiCoordinator {
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();
  private readonly terminalBindings = new Map<string, TerminalSessionBinding>();
  private readonly terminalSessionIdsByAgentKey = new Map<string, Set<string>>();
  private readonly activeSessions = new Map<string, OmpAgentSession>();
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
    const { createAgentSession: createPiAgentSession } = await importOmpModule();
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
    let killed = false;
    let killedTerminalSessionId: string | null = null;
    try {
      const sessions = await listTmuxSessions();
      const pty = sessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId))
        ?? this.findMappedTmuxSession(sessions, target.workspaceId, agentSessionId);
      if (pty) {
        await killTmuxSession(pty.id);
        killed = true;
        killedTerminalSessionId = pty.id;
      }
    } catch {
      // non-fatal
    }
    if (killedTerminalSessionId) {
      this.releaseTerminalSession(killedTerminalSessionId);
    }
    if (!this.hasTerminalOwners(target.workspaceId, agentSessionId)) {
      this.disposeActiveSession(agentSessionId);
    }
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
      this.disposeActiveSession(previous.agentSessionId);
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
      this.disposeActiveSession(binding.agentSessionId);
    }
    return {
      ...binding,
      remainingOwnerCount,
    };
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
    if (existing) {
      if (existing.exitCode === undefined) {
        this.bindTerminalSession(target.workspaceId, existing.id, agentSessionId);
        return existing;
      }
      this.releaseTerminalSession(existing.id);
    }

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
    this.bindTerminalSession(target.workspaceId, tmuxSession.id, agentSessionId);
    return tmuxSession;
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
    session: OmpAgentSession,
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
