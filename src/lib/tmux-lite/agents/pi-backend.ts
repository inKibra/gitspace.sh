import {
  createAgentSession,
  type AgentSession,
} from '@oh-my-pi/pi-coding-agent';
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
import { listPiSessions, findPiSessionFile } from './pi-session-files.js';

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
    return {
      backendId: this.id,
      installed: true,
      serverRunning: true,
    };
  }

  async ensureInstalled(_target: AgentWorkspaceTarget): Promise<void> {}

  async ensureServer(_target: AgentWorkspaceTarget): Promise<AgentServerHandle> {
    return {
      backendId: this.id,
      baseUrl: 'pi://in-process',
      startedAt: new Date().toISOString(),
    };
  }

  async listSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
    const cwd = target.workspacePath;
    if (!cwd) return [];
    return listPiSessions(cwd).map((s) =>
      toSummary(target, {
        id: s.id,
        title: s.title ?? s.firstMessage ?? undefined,
        createdAt: s.created?.toISOString(),
        updatedAt: s.modified?.toISOString(),
      }),
    );
  }

  async createSession(
    target: AgentWorkspaceTarget,
    input: CreateAgentSessionInput,
  ): Promise<AgentSessionHandle> {
    const cwd = target.workspacePath;
    if (!cwd) throw new Error('workspacePath required for Pi session');

    // Set env before creating session so Pi writes to our managed dir
    process.env.PI_CODING_AGENT_DIR = require('./pi-runtime.js').getPiAgentDir();

    const { SessionManager } = await import('@oh-my-pi/pi-coding-agent');
    const sessionManager = SessionManager.create(cwd);
    const { session } = await createAgentSession({
      sessionManager,
      cwd,
    });

    const sessionId = session.sessionId;
    this.activeSessions.set(sessionId, session);

    return new PiSessionHandle(
      toSummary(target, {
        id: sessionId,
        title: input.title,
        createdAt: new Date().toISOString(),
      }),
      session,
    );
  }

  async resumeSession(
    target: AgentWorkspaceTarget,
    sessionId: string,
  ): Promise<AgentSessionHandle> {
    const cwd = target.workspacePath;
    if (!cwd) throw new Error('workspacePath required for Pi session');

    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      return new PiSessionHandle(
        toSummary(target, { id: sessionId }),
        existing,
      );
    }

    const match = findPiSessionFile(cwd, sessionId);
    if (!match) {
      throw new Error(`Pi session ${sessionId} not found in ${cwd}`);
    }

    process.env.PI_CODING_AGENT_DIR = require('./pi-runtime.js').getPiAgentDir();

    const { SessionManager } = await import('@oh-my-pi/pi-coding-agent');
    const sessionManager = await SessionManager.open(match.path);
    const { session } = await createAgentSession({
      sessionManager,
      cwd,
    });

    this.activeSessions.set(sessionId, session);

    return new PiSessionHandle(
      toSummary(target, {
        id: sessionId,
        title: match.title ?? match.firstMessage ?? undefined,
      }),
      session,
    );
  }

  async destroySession(_target: AgentWorkspaceTarget, sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.dispose();
      this.activeSessions.delete(sessionId);
    }
  }
}
