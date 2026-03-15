import { OpenCodeClient, type OpenCodeFetch } from '../opencode-client.js';
import type {
  AgentBackend,
  AgentBackendStatus,
  AgentEvent,
  AgentServerHandle,
  AgentSessionHandle,
  AgentSessionSummary,
  AgentWorkspaceTarget,
  CreateAgentSessionInput,
} from '../backend.js';

export interface OpenCodeBackendDependencies {
  ensureInstalledForTarget: (target: AgentWorkspaceTarget) => Promise<void>;
  ensureServerForTarget: (target: AgentWorkspaceTarget) => Promise<{ baseUrl: string }>;
  detectTarget: (target: AgentWorkspaceTarget) => Promise<{
    installed: boolean;
    serverRunning: boolean;
    credentialsAvailable?: boolean;
    baseUrl?: string;
  }>;
  fetch?: OpenCodeFetch;
}

class OpenCodeSessionHandle implements AgentSessionHandle {
  readonly summary: AgentSessionSummary;
  private readonly client: OpenCodeClient;

  constructor(summary: AgentSessionSummary, client: OpenCodeClient) {
    this.summary = summary;
    this.client = client;
  }

  async sendMessage(input: { parts: Array<{ type: 'text'; text: string }> }): Promise<void> {
    await this.client.sendMessage(this.summary.id, input);
  }

  onEvent(_handler: (event: AgentEvent) => void): () => void {
    return () => {};
  }
}

function toSummary(target: AgentWorkspaceTarget, record: { id: string; title?: string; createdAt?: string; updatedAt?: string }): AgentSessionSummary {
  return {
    id: record.id,
    workspaceId: target.workspaceId,
    backendId: 'opencode',
    title: record.title,
    status: 'idle',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class OpenCodeBackend implements AgentBackend {
  readonly id = 'opencode';
  private readonly deps: OpenCodeBackendDependencies;

  constructor(deps: OpenCodeBackendDependencies) {
    this.deps = deps;
  }

  async detect(target: AgentWorkspaceTarget): Promise<AgentBackendStatus> {
    const result = await this.deps.detectTarget(target);
    return {
      backendId: this.id,
      installed: result.installed,
      serverRunning: result.serverRunning,
      credentialsAvailable: result.credentialsAvailable,
      baseUrl: result.baseUrl,
    };
  }

  async ensureInstalled(target: AgentWorkspaceTarget): Promise<void> {
    await this.deps.ensureInstalledForTarget(target);
  }

  async ensureServer(target: AgentWorkspaceTarget): Promise<AgentServerHandle> {
    const ensured = await this.deps.ensureServerForTarget(target);
    return {
      backendId: this.id,
      baseUrl: ensured.baseUrl,
      startedAt: new Date().toISOString(),
    };
  }

  async listSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
    const client = await this.getClient(target);
    const sessions = await client.listSessions();
    return sessions.map((session) => toSummary(target, session));
  }

  async createSession(target: AgentWorkspaceTarget, input: CreateAgentSessionInput): Promise<AgentSessionHandle> {
    const client = await this.getClient(target);
    const session = await client.createSession({ title: input.title });
    return new OpenCodeSessionHandle(toSummary(target, session), client);
  }

  async resumeSession(target: AgentWorkspaceTarget, sessionId: string): Promise<AgentSessionHandle> {
    const client = await this.getClient(target);
    const session = await client.getSession(sessionId);
    return new OpenCodeSessionHandle(toSummary(target, session), client);
  }

  async destroySession(target: AgentWorkspaceTarget, sessionId: string): Promise<void> {
    const client = await this.getClient(target);
    await client.destroySession(sessionId);
  }

  private async getClient(target: AgentWorkspaceTarget): Promise<OpenCodeClient> {
    const { baseUrl } = await this.deps.ensureServerForTarget(target);
    return new OpenCodeClient({
      baseUrl,
      fetch: this.deps.fetch,
    });
  }
}
