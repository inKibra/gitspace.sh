import {
  SessionManager,
  createAgentSession,
  type AgentSession,
} from '@oh-my-pi/pi-coding-agent';
import { join } from 'node:path';
import type {
  AgentBackend,
  AgentBackendStatus,
  AgentEvent,
  AgentServerHandle,
  AgentSessionHandle,
  AgentSessionSummary,
  AgentWorkspaceTarget,
  CreateAgentSessionInput,
} from '../../../agents/backend.js';
import { setupPiEnvironment, getPiAgentDir } from './pi-runtime.js';

class PiSessionHandle implements AgentSessionHandle {
  readonly summary: AgentSessionSummary;
  private readonly session: AgentSession;

  constructor(summary: AgentSessionSummary, session: AgentSession) {
    this.summary = summary;
    this.session = session;
  }

  async sendMessage(input: { parts: Array<{ type: 'text'; text: string }> }): Promise<void> {
    const text = input.parts.map((p) => p.text).join('\n');
    await this.session.prompt(text);
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    return this.session.subscribe((piEvent) => {
      switch (piEvent.type) {
        case 'message_update':
          handler({
            type: 'message',
            sessionId: this.summary.id,
            payload: piEvent,
          });
          break;
        case 'tool_execution_start':
        case 'tool_execution_end':
          handler({
            type: 'status',
            sessionId: this.summary.id,
            payload: piEvent,
          });
          break;
        case 'agent_end':
          handler({
            type: 'status',
            sessionId: this.summary.id,
            payload: { type: 'idle' },
          });
          break;
      }
    });
  }
}

function toSummary(
  target: AgentWorkspaceTarget,
  info: { id: string; title?: string; createdAt?: string; updatedAt?: string },
): AgentSessionSummary {
  return {
    id: info.id,
    workspaceId: target.workspaceId,
    backendId: 'pi',
    title: info.title,
    status: 'idle',
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
  };
}

export class PiBackend implements AgentBackend {
  readonly id = 'pi';
  private readonly activeSessions = new Map<string, AgentSession>();

  async detect(_target: AgentWorkspaceTarget): Promise<AgentBackendStatus> {
    // Pi SDK is embedded — always installed, no server needed
    return {
      backendId: this.id,
      installed: true,
      serverRunning: true, // in-process, always "running"
    };
  }

  async ensureInstalled(_target: AgentWorkspaceTarget): Promise<void> {
    // Pi SDK is a dependency — nothing to install at runtime
  }

  async ensureServer(_target: AgentWorkspaceTarget): Promise<AgentServerHandle> {
    // Pi is in-process, no HTTP server. Return a synthetic handle
    // for compatibility with the AgentBackend interface.
    return {
      backendId: this.id,
      baseUrl: 'pi://in-process',
      startedAt: new Date().toISOString(),
    };
  }

  async listSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
    const cwd = target.workspacePath;
    if (!cwd) return [];

    const sessionDir = join(getPiAgentDir(), 'sessions');
    try {
      const sessions = await SessionManager.list(cwd, sessionDir);
      return sessions.map((s) =>
        toSummary(target, {
          id: s.id,
          title: s.title ?? s.firstMessage ?? undefined,
          createdAt: s.created?.toISOString(),
          updatedAt: s.modified?.toISOString(),
        }),
      );
    } catch {
      return [];
    }
  }

  async createSession(
    target: AgentWorkspaceTarget,
    input: CreateAgentSessionInput,
  ): Promise<AgentSessionHandle> {
    const cwd = target.workspacePath;
    if (!cwd) throw new Error('workspacePath required for Pi session');

    const env = setupPiEnvironment(target);
    const prevEnv = applyEnv(env);
    try {
      const sessionManager = SessionManager.create(cwd);
      const { session } = await createAgentSession({
        sessionManager,
        cwd,
      });

      const sessionId = session.sessionId;
      this.activeSessions.set(sessionId, session);

      const summary = toSummary(target, {
        id: sessionId,
        title: input.title,
        createdAt: new Date().toISOString(),
      });

      return new PiSessionHandle(summary, session);
    } finally {
      restoreEnv(prevEnv);
    }
  }

  async resumeSession(
    target: AgentWorkspaceTarget,
    sessionId: string,
  ): Promise<AgentSessionHandle> {
    const cwd = target.workspacePath;
    if (!cwd) throw new Error('workspacePath required for Pi session');

    // Check if we already have this session active
    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      return new PiSessionHandle(
        toSummary(target, { id: sessionId }),
        existing,
      );
    }

    const env = setupPiEnvironment(target);
    const prevEnv = applyEnv(env);
    try {
      // Find the session file and open it
      const sessions = await SessionManager.list(cwd);
      const match = sessions.find((s) => s.id === sessionId);
      if (!match?.path) {
        throw new Error(`Pi session ${sessionId} not found in ${cwd}`);
      }

      const sessionManager = await SessionManager.open(match.path);
      const { session } = await createAgentSession({
        sessionManager,
        cwd,
      });

      this.activeSessions.set(sessionId, session);

      return new PiSessionHandle(
        toSummary(target, {
          id: sessionId,
          title: match.firstMessage ?? undefined,
        }),
        session,
      );
    } finally {
      restoreEnv(prevEnv);
    }
  }

  async destroySession(target: AgentWorkspaceTarget, sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.dispose();
      this.activeSessions.delete(sessionId);
    }
  }
}

/** Temporarily apply env vars, returning previous values for restore. */
function applyEnv(env: Record<string, string>): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    process.env[key] = value;
  }
  return prev;
}

/** Restore env vars to previous values. */
function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
