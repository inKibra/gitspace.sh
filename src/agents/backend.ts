export type AgentBackendId = string;

export interface AgentWorkspaceTarget {
  workspaceId: string;
  workspacePath?: string;
  projectName?: string;
  machineId?: string;
  backendKey?: string;
}

export interface AgentServerHandle {
  backendId: AgentBackendId;
  baseUrl: string;
  startedAt: string;
}

export interface AgentBackendStatus {
  backendId: AgentBackendId;
  installed: boolean;
  serverRunning: boolean;
  credentialsAvailable?: boolean;
  baseUrl?: string;
}

export interface CreateAgentSessionInput {
  title?: string;
  prompt?: string;
  providerId?: string;
  model?: string;
  cwd?: string;
}

export interface AgentSessionSummary {
  id: string;
  workspaceId: string;
  backendId: AgentBackendId;
  title?: string;
  status: 'running' | 'idle' | 'error' | 'closed';
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentMessagePart {
  type: 'text';
  text: string;
}

export interface AgentMessageInput {
  parts: AgentMessagePart[];
}

export type AgentEvent =
  | {
      type: 'message';
      sessionId: string;
      payload: unknown;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      payload: unknown;
    }
  | {
      type: 'question';
      sessionId: string;
      payload: unknown;
    }
  | {
      type: 'status';
      sessionId: string;
      payload: unknown;
    }
  | {
      type: 'error';
      sessionId: string;
      error: string;
    };

export interface AgentSessionHandle {
  readonly summary: AgentSessionSummary;
  sendMessage(input: AgentMessageInput): Promise<void>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
}

export interface AgentBackend {
  readonly id: AgentBackendId;
  detect(target: AgentWorkspaceTarget): Promise<AgentBackendStatus>;
  ensureInstalled(target: AgentWorkspaceTarget): Promise<void>;
  ensureServer(target: AgentWorkspaceTarget): Promise<AgentServerHandle>;
  listSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]>;
  createSession(target: AgentWorkspaceTarget, input: CreateAgentSessionInput): Promise<AgentSessionHandle>;
  resumeSession(target: AgentWorkspaceTarget, sessionId: string): Promise<AgentSessionHandle>;
  destroySession(target: AgentWorkspaceTarget, sessionId: string): Promise<void>;
}
