export interface OmpAgentSession {
  sessionId: string;
  model?: unknown;
  prompt(input: string): Promise<void>;
  subscribe(handler: (event: OmpAgentEvent) => void): () => void;
  setModel(model: unknown): Promise<void>;
  dispose(): void;
}

export interface OmpAgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface OmpSessionContext {
  models: {
    default?: string;
  };
}

export interface OmpSessionManagerInstance {
  buildSessionContext(): OmpSessionContext;
  setSessionName(name: string): Promise<void>;
  rewriteEntries(): Promise<void>;
}

export interface OmpSessionManagerStatic {
  getDefaultSessionDir(cwd: string, agentDir: string): string;
  create(cwd: string, sessionDir: string): OmpSessionManagerInstance;
  open(sessionFilePath: string): Promise<OmpSessionManagerInstance>;
}

export interface OmpModelRegistry {
  refresh(mode?: string): Promise<void>;
  find(provider: string, modelId: string): unknown;
}

export interface OmpModelRegistryConstructor {
  new(authStorage: unknown): OmpModelRegistry;
}

export interface OmpModule {
  SessionManager: OmpSessionManagerStatic;
  ModelRegistry: OmpModelRegistryConstructor;
  discoverAuthStorage(agentDir: string): Promise<unknown>;
  createAgentSession(args: {
    agentDir: string;
    sessionManager: OmpSessionManagerInstance;
    cwd: string;
    authStorage?: unknown;
    modelRegistry?: unknown;
    model?: unknown;
    additionalExtensionPaths?: string[];
  }): Promise<{ session: OmpAgentSession }>;
}

export interface PiAiModule {
  getBundledModel(provider: string, modelId: string): unknown;
}

export interface OmpExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getCwd(): string | null;
  };
}

export interface OmpExtensionAPI {
  logger: {
    warn(message: string): void;
  };
  on(eventName: string, handler: (event: any, ctx: OmpExtensionContext) => void | Promise<void>): void;
  events: {
    on(eventName: string, handler: (payload: unknown) => void): void;
  };
}
