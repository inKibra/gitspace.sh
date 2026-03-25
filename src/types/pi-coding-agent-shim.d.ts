declare module '@oh-my-pi/pi-coding-agent' {
  export interface AgentSession {
    sessionId: string;
    model?: unknown;
    prompt(input: string): Promise<void>;
    subscribe(handler: (event: any) => void): () => void;
    setModel(model: unknown): Promise<void>;
    dispose(): void;
  }

  export interface SessionContext {
    models: {
      default?: string;
    };
  }

  export interface SessionManagerInstance {
    buildSessionContext(): SessionContext;
    setSessionName(name: string): Promise<void>;
    rewriteEntries(): Promise<void>;
  }

  export interface SessionManagerStatic {
    getDefaultSessionDir(cwd: string, agentDir: string): string;
    create(cwd: string, sessionDir: string): SessionManagerInstance;
    open(sessionFilePath: string): Promise<SessionManagerInstance>;
  }

  export const SessionManager: SessionManagerStatic;

  export class ModelRegistry {
    constructor(authStorage: unknown);
    refresh(mode?: string): Promise<void>;
    find(provider: string, modelId: string): unknown;
  }

  export function discoverAuthStorage(agentDir: string): Promise<unknown>;

  export function createAgentSession(args: {
    agentDir: string;
    sessionManager: SessionManagerInstance;
    cwd: string;
    authStorage?: unknown;
    modelRegistry?: unknown;
    model?: unknown;
    additionalExtensionPaths?: string[];
  }): Promise<{ session: AgentSession }>;

  export interface ExtensionContext {
    cwd: string;
    sessionManager: {
      getSessionId(): string;
      getCwd(): string | null;
    };
  }

  export interface ExtensionAPI {
    logger: {
      warn(message: string): void;
    };
    on(eventName: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>): void;
    events: {
      on(eventName: string, handler: (payload: unknown) => void): void;
    };
  }
}
