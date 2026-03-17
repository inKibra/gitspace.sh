import { createSession as createTmuxSession, killSession as killTmuxSession, listSessions as listTmuxSessions } from '../lib/tmux-lite/cli.js';
import type { Session as TmuxSession } from '../lib/tmux-lite/protocol.js';
import { OpenCodeClient, type OpenCodeSessionRecord } from './opencode-client.js';
import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager } from './opencode-runtime.js';
import type { OpenCodeRuntimeInfo, OpenCodeRuntimeTarget } from './opencode-types.js';
import { normalizeWorkspacePath } from './opencode-runtime-shared.js';
import {
  deleteStoredSession,
  markStoredSessionClosed,
  readStoredSessionHistory,
  replaceStoredSessions,
  upsertStoredSession,
  type StoredWorkspaceAgentSession,
} from './opencode-store.js';

export const AGENT_TMUX_SESSION_KIND = 'agent';

export interface AgentWorkspaceTarget extends OpenCodeRuntimeTarget {
  workspaceName: string;
}

export interface AgentSessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closed?: boolean;
}

export class AgentSessionTakeoverRequiredError extends Error {
  readonly sessionName?: string;

  constructor(message: string, options: { sessionName?: string } = {}) {
    super(message);
    this.name = 'AgentSessionTakeoverRequiredError';
    this.sessionName = options.sessionName;
  }
}

function buildAgentTerminalSessionName(target: AgentWorkspaceTarget, agentSessionId: string): string {
  return `agent:${target.workspaceName}:${agentSessionId.slice(-8)}`;
}

function createClient(runtime: OpenCodeRuntimeInfo): OpenCodeClient {
  return new OpenCodeClient({
    baseUrl: runtime.baseUrl,
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
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(normalized).toISOString();
  }
  return undefined;
}

function normalizeOpenCodeSession(target: AgentWorkspaceTarget, session: OpenCodeSessionRecord): StoredWorkspaceAgentSession {
  const updatedAt = parseIsoTime(session.updatedAt ?? session.time?.updated);
  const createdAt = parseIsoTime(session.createdAt ?? session.time?.created);
  return {
    id: String(session.id),
    title: typeof session.title === 'string' && session.title.trim().length > 0 ? session.title : String(session.id),
    rawTitle: typeof session.title === 'string' ? session.title : undefined,
    parentID: session.parentID,
    createdAt,
    updatedAt,
    lastSeenAt: new Date().toISOString(),
    lastKnownStatus: undefined,
  };
}

function isLikelySubagentTitle(title: string | undefined): boolean {
  return Boolean(title && /\(@[^)]+subagent\)/i.test(title));
}

function toSummaries(workspaceId: string, sessions: Record<string, StoredWorkspaceAgentSession>): AgentSessionSummary[] {
  return Object.values(sessions)
    .filter((session) => !session.parentID)
    .filter((session) => !isLikelySubagentTitle(session.rawTitle ?? session.title))
    .sort((a, b) => (b.updatedAt ?? b.lastSeenAt ?? '').localeCompare(a.updatedAt ?? a.lastSeenAt ?? ''))
    .map((session) => ({
      id: session.id,
      workspaceId,
      title: session.title,
      updatedAt: session.updatedAt ?? session.lastSeenAt,
      closed: session.lastKnownStatus === 'closed',
    }));
}

function isAgentTmuxSession(session: TmuxSession, workspaceId: string, agentSessionId: string): boolean {
  return session.kind === AGENT_TMUX_SESSION_KIND
    && session.metadata?.workspaceId === workspaceId
    && session.metadata?.agentSessionId === agentSessionId;
}

function isTopLevelWorkspaceSession(normalizedWorkspacePath: string, session: OpenCodeSessionRecord): boolean {
  return session.directory === normalizedWorkspacePath && !session.parentID;
}

export class OpenCodeCoordinator {
  private readonly inflightTerminalSessions = new Map<string, Promise<TmuxSession>>();

  async ensureRuntime(target: AgentWorkspaceTarget): Promise<OpenCodeRuntimeInfo> {
    return defaultOpenCodeRuntimeManager.ensureWorkspaceRuntime(target);
  }

  async getKnownAgentSessions(workspaceId: string): Promise<AgentSessionSummary[]> {
    const history = await readStoredSessionHistory(workspaceId);
    return toSummaries(workspaceId, history.sessions);
  }

  async refreshAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
    const runtime = await this.ensureRuntime(target);
    const client = createClient(runtime);
    const sessions = await client.listSessions();
    const history = await readStoredSessionHistory(target.workspaceId);
    const normalizedWorkspacePath = normalizeWorkspacePath(target.workspacePath);
    const filtered = sessions.filter((session) => isTopLevelWorkspaceSession(normalizedWorkspacePath, session));
    await replaceStoredSessions(
      target.workspaceId,
      filtered.map((session) => ({
        ...normalizeOpenCodeSession(target, session),
        terminalSessionId: history.sessions[String(session.id)]?.terminalSessionId,
        terminalSessionName: history.sessions[String(session.id)]?.terminalSessionName,
      })),
    );
    const refreshedHistory = await readStoredSessionHistory(target.workspaceId);
    return toSummaries(target.workspaceId, refreshedHistory.sessions);
  }

  async createAgentSession(target: AgentWorkspaceTarget, title?: string): Promise<AgentSessionSummary[]> {
    const runtime = await this.ensureRuntime(target);
    const client = createClient(runtime);
    const created = await client.createSession({ title });
    await upsertStoredSession(target.workspaceId, {
      ...normalizeOpenCodeSession(target, created),
    });
    const refreshed = await this.refreshAgentSessions(target);
    return refreshed.length > 0 ? refreshed : this.getKnownAgentSessions(target.workspaceId);
  }

  async abortAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const runtime = await this.ensureRuntime(target);
    const client = createClient(runtime);
    const aborted = await client.abortSession(agentSessionId);
    const existing = await this.findExistingAgentTerminalSession(target, agentSessionId);
    if (existing) {
      try {
        await killTmuxSession(existing.id);
      } catch {
        // best effort
      }
    }
    try {
      await this.refreshAgentSessions(target);
    } finally {
      await markStoredSessionClosed(target.workspaceId, agentSessionId);
    }
    return aborted;
  }

  async clearAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
    const existing = await this.findExistingAgentTerminalSession(target, agentSessionId);
    if (existing) {
      try {
        await killTmuxSession(existing.id);
      } catch {
        // best effort
      }
    }
    await deleteStoredSession(target.workspaceId, agentSessionId);
    return true;
  }

  async checkAgentSessionTakeover(
    target: AgentWorkspaceTarget,
    agentSessionId: string,
  ): Promise<{ requiresTakeover: boolean; sessionName?: string }> {
    const existing = await this.findExistingAgentTerminalSession(target, agentSessionId);
    if (!existing?.attached) {
      return { requiresTakeover: false };
    }
    return {
      requiresTakeover: true,
      sessionName: existing.name,
    };
  }

  async ensureAgentTerminalSession(
    target: AgentWorkspaceTarget,
    agentSessionId: string,
    options: { force?: boolean } = {},
  ): Promise<TmuxSession> {
    const existing = await this.findExistingAgentTerminalSession(target, agentSessionId);
    if (existing) {
      if (existing.attached && options.force !== true) {
        throw new AgentSessionTakeoverRequiredError(
          `Agent session is already open in ${existing.name}. Taking over will disconnect the current viewer.`,
          { sessionName: existing.name },
        );
      }
      return existing;
    }

    const key = `${target.workspaceId}:${agentSessionId}`;
    const inFlight = this.inflightTerminalSessions.get(key);
    if (inFlight) {
      return inFlight;
    }

    const ensurePromise = this.ensureAgentTerminalSessionInternal(target, agentSessionId, options).finally(() => {
      this.inflightTerminalSessions.delete(key);
    });
    this.inflightTerminalSessions.set(key, ensurePromise);
    return ensurePromise;
  }

  private async findExistingAgentTerminalSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<TmuxSession | null> {
    const history = await readStoredSessionHistory(target.workspaceId);
    const record = history.sessions[agentSessionId];
    const sessions = await listTmuxSessions();

    if (record?.terminalSessionId) {
      const existingById = sessions.find((session) => session.id === record.terminalSessionId);
      if (existingById && isAgentTmuxSession(existingById, target.workspaceId, agentSessionId)) {
        await upsertStoredSession(target.workspaceId, {
          id: agentSessionId,
          title: record?.title ?? agentSessionId,
          terminalSessionId: existingById.id,
          terminalSessionName: existingById.name,
          lastKnownStatus: existingById.exitCode === undefined ? undefined : 'closed',
        });
        if (existingById.exitCode === undefined) {
          return existingById;
        }
      }
    }

    const existing = sessions.find((session) => isAgentTmuxSession(session, target.workspaceId, agentSessionId));
    if (existing) {
      await upsertStoredSession(target.workspaceId, {
        id: agentSessionId,
        title: record?.title ?? agentSessionId,
        terminalSessionId: existing.id,
        terminalSessionName: existing.name,
        lastKnownStatus: existing.exitCode === undefined ? undefined : 'closed',
      });
      if (existing.exitCode === undefined) {
        return existing;
      }
    }

    return null;
  }

  private async ensureAgentTerminalSessionInternal(
    target: AgentWorkspaceTarget,
    agentSessionId: string,
    options: { force?: boolean },
  ): Promise<TmuxSession> {
    const history = await readStoredSessionHistory(target.workspaceId);
    const record = history.sessions[agentSessionId];
    const existing = await this.findExistingAgentTerminalSession(target, agentSessionId);
    if (existing) {
      if (existing.attached && options.force !== true) {
        throw new AgentSessionTakeoverRequiredError(
          `Agent session is already open in ${existing.name}. Taking over will disconnect the current viewer.`,
          { sessionName: existing.name },
        );
      }
      return existing;
    }

    const runtime = await this.ensureRuntime(target);
    const session = await createTmuxSession(
      buildAgentTerminalSessionName(target, agentSessionId),
      target.workspacePath,
      {
        command: 'opencode',
        args: ['attach', `http://${runtime.hostname}:${runtime.port}`, '--session', agentSessionId],
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

    await upsertStoredSession(target.workspaceId, {
      id: agentSessionId,
      title: record?.title ?? agentSessionId,
      terminalSessionId: session.id,
      terminalSessionName: session.name,
      lastKnownStatus: undefined,
    });
    return session;
  }
}

export const defaultOpenCodeCoordinator = new OpenCodeCoordinator();
