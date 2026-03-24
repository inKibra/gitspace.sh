import { killSession as killTmuxSession, listSessions as listTmuxSessions, createSession as createTmuxSession } from '../lib/tmux-lite/cli.js';
import type { Session as TmuxSession } from '../lib/tmux-lite/protocol.js';
import { OpenCodeClient, type OpenCodeSessionRecord } from './opencode-client.js';
import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager } from './opencode-runtime.js';
import type { OpenCodeRuntimeInfo, OpenCodeRuntimeTarget } from './opencode-types.js';
import { normalizeWorkspacePath } from './opencode-runtime-shared.js';
import { upsertArchivedSession, deleteArchivedSession } from './agent-db.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from './session-display.js';

export const AGENT_TMUX_SESSION_KIND = 'agent';

export interface AgentWorkspaceTarget extends OpenCodeRuntimeTarget {
  workspaceName: string;
}

export interface AgentSessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closedAt?: string;
  archivedAt?: string;
}

function buildAgentTerminalSessionName(target: AgentWorkspaceTarget, agentSessionId: string): string {
  return `agent:${target.workspaceName}:${agentSessionId.slice(-8)}`;
}

function createClient(runtime: OpenCodeRuntimeInfo, directory?: string): OpenCodeClient {
  return new OpenCodeClient({
    baseUrl: runtime.baseUrl,
    directory,
    fetch: (input, init) => fetch(input as RequestInfo, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: createOpenCodeBasicAuthHeader(runtime),
      },
    }),
  });
}

function parseIsoTime(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(normalized).toISOString();
  }
  return undefined;
}

function toAgentSessionSummary(
  target: AgentWorkspaceTarget,
  session: Pick<OpenCodeSessionRecord, 'id' | 'title' | 'time' | 'updatedAt'>,
): AgentSessionSummary {
  return {
    id: String(session.id),
    workspaceId: target.workspaceId,
    title: getAgentSessionDisplayTitle({
      id: String(session.id),
      title: typeof session.title === 'string' ? session.title : undefined,
      rawTitle: typeof session.title === 'string' ? session.title : undefined,
    }),
    updatedAt: parseIsoTime(session.updatedAt ?? session.time?.updated),
  };
}

export function mergeCreatedAgentSession(
  sessions: AgentSessionSummary[],
  created: AgentSessionSummary,
): AgentSessionSummary[] {
  const merged = new Map<string, AgentSessionSummary>();
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
  return Array.from(merged.values()).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

function isAgentTmuxSession(session: TmuxSession, workspaceId: string, agentSessionId: string): boolean {
  return session.kind === AGENT_TMUX_SESSION_KIND
    && session.metadata?.workspaceId === workspaceId
    && session.metadata?.agentSessionId === agentSessionId;
}

function isTopLevelWorkspaceSession(normalizedWorkspacePath: string, session: OpenCodeSessionRecord): boolean {
  return session.directory === normalizedWorkspacePath && !session.parentID;
}

/**
 * Build the argument list for `opencode attach`.
 * Exported as a pure function for unit testing.
 */
export function buildOpenCodeAttachArgs(
  runtime: { hostname: string; port: number },
  agentSessionId: string,
  workspacePath: string,
): string[] {
  return [
    'attach',
    `http://${runtime.hostname}:${runtime.port}`,
    '--session', agentSessionId,
    '--dir', workspacePath,
  ];
}

export class OpenCodeCoordinator {
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();

  async ensureRuntime(target: AgentWorkspaceTarget): Promise<OpenCodeRuntimeInfo> {
    return defaultOpenCodeRuntimeManager.ensureWorkspaceRuntime(target);
  }

  /**
   * Fetch the current session list from OpenCode for a workspace.
   * Returns summaries without closedAt — callers (agent-control.ts) merge
   * closedAt from the AgentEventManager snapshot if needed.
   */
  async refreshAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
    const runtime = await this.ensureRuntime(target);
    const client = createClient(runtime, target.workspacePath);
    const sessions = await client.listSessions();
    const normalizedWorkspacePath = normalizeWorkspacePath(target.workspacePath);
    return sessions
      .filter((s) => isTopLevelWorkspaceSession(normalizedWorkspacePath, s) && shouldDisplayAgentSession(s))
      .map((s) => toAgentSessionSummary(target, s));
  }

  async createAgentSession(target: AgentWorkspaceTarget, title?: string): Promise<AgentSessionSummary[]> {
    const runtime = await this.ensureRuntime(target);
    const client = createClient(runtime, target.workspacePath);
    const created = await client.createSession({ title });
    const sessions = await this.refreshAgentSessions(target);
    return mergeCreatedAgentSession(sessions, toAgentSessionSummary(target, created));
  }

  async abortAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const runtime = await this.ensureRuntime(target);
    const client = createClient(runtime, target.workspacePath);
    return client.abortSession(agentSessionId);
  }

  /**
   * Close a session: abort it in OpenCode, kill any PTY.
   * Marking closedAt in the snapshot is done by agent-control.ts via markSessionClosed().
   */
  async closeAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<void> {
    // Abort first (non-fatal — may already be idle).
    try {
      const runtime = await defaultOpenCodeRuntimeManager.getWorkspaceRuntime(target.workspaceId);
      if (runtime) {
        const client = createClient(runtime, target.workspacePath);
        await client.abortSession(agentSessionId);
      }
    } catch {
      // non-fatal
    }
    // Kill any associated PTY session.
    try {
      const sessions = await listTmuxSessions();
      const pty = sessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId));
      if (pty) await killTmuxSession(pty.id);
    } catch {
      // non-fatal
    }
  }

  /**
   * Archive a session: persist to db. Removing it from the snapshot is done
   * by agent-control.ts via markSessionArchived().
   */
  async archiveAgentSession(target: AgentWorkspaceTarget, agentSessionId: string, title: string): Promise<void> {
    upsertArchivedSession({
      workspaceId: target.workspaceId,
      sessionId: agentSessionId,
      title,
      archivedAt: new Date().toISOString(),
    });
  }

  /**
   * Restore a session: remove from db. Adding it back to the snapshot is done
   * by agent-control.ts via markSessionRestored().
   */
  async restoreAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<void> {
    deleteArchivedSession(target.workspaceId, agentSessionId);
  }

  async ensureAgentTerminalSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<TmuxSession> {
    const key = `${target.workspaceId}:${agentSessionId}`;
    const inFlight = this.inflightTerminalSessions.get(key);
    if (inFlight) return inFlight;

    const ensurePromise = this.ensureAgentTerminalSessionInternal(target, agentSessionId).finally(() => {
      this.inflightTerminalSessions.delete(key);
    });
    this.inflightTerminalSessions.set(key, ensurePromise);
    return ensurePromise;
  }

  private async ensureAgentTerminalSessionInternal(target: AgentWorkspaceTarget, agentSessionId: string): Promise<TmuxSession> {
    const sessions = await listTmuxSessions();
    const existing = sessions.find((s) => isAgentTmuxSession(s, target.workspaceId, agentSessionId));
    if (existing && existing.exitCode === undefined) return existing;

    const runtime = await this.ensureRuntime(target);
    return createTmuxSession(
      buildAgentTerminalSessionName(target, agentSessionId),
      target.workspacePath,
      {
        command: 'opencode',
        args: buildOpenCodeAttachArgs(runtime, agentSessionId, target.workspacePath),
        env: {
          OPENCODE_SERVER_USERNAME: runtime.username,
          OPENCODE_SERVER_PASSWORD: runtime.password,
        },
        kind: AGENT_TMUX_SESSION_KIND,
        hidden: true,
        recordReplay: false,
        metadata: {
          workspaceId: target.workspaceId,
          agentSessionId,
        },
      },
    );
  }
}

export const defaultOpenCodeCoordinator = new OpenCodeCoordinator();
