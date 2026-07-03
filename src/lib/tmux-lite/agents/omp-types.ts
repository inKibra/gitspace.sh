import type { Skill } from '@oh-my-pi/pi-coding-agent/extensibility/skills';

export interface OmpAgentSession {
  sessionId: string;
  model?: unknown;
  prompt(input: string, options?: { images?: Array<{ type: 'image'; data: string; mimeType: string }>; streamingBehavior?: 'steer' | 'followUp' }): Promise<boolean>;
  compact?(customInstructions?: string): Promise<unknown>;
  subscribe(handler: (event: OmpAgentEvent) => void): () => void;
  setModel(model: unknown): Promise<{ switched: boolean }>;
  /**
   * Interrupt the current agent turn (stop LLM streaming / tool execution).
   * The session stays alive and can accept new prompts afterward.
   *
   * NOTE: This is the Pi SDK's `AgentSession.abort()`. Do not confuse with
   * GitSpace's `abortAgentSession()` which KILLS the tmux session entirely.
   * GitSpace naming: interrupt = stop current turn, abort = terminate session.
   */
  abort(): Promise<void>;
  getQueuedMessages?(): { steering: readonly string[]; followUp: readonly string[] };
  removeQueuedMessage?(kind: 'steering' | 'followUp', index: number): string | undefined;
  extensionRunner?: {
    getRegisteredCommands(reserved?: Set<string>): Array<{ name: string; description?: string }>;
  };
  dispose(): void;
  skills?: readonly Skill[];
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
  getAll(): Array<{ provider: string; id: string; contextWindow?: number }>;
}

export interface OmpModelRegistryConstructor {
  new(authStorage: unknown): OmpModelRegistry;
}

export interface OmpAuthStorage {
  list(): string[];
  has(provider: string): boolean;
  hasAuth(provider: string): boolean;
  set(provider: string, credential: { type: 'api_key'; key: string }): Promise<void>;
  login(
    provider: string,
    ctrl: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
    },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// High-level host UI context — the subset of ExtensionUIContext that GitSpace
// can satisfy natively (select/confirm/input/editor/notify/status/widget).
// Low-level component-factory methods (custom, setHeader, setFooter,
// setEditorComponent, onTerminalInput) are excluded and fall through to the
// Pi TUI / InteractiveMode fallback path.
// ---------------------------------------------------------------------------

/** Dialog options forwarded from the SDK's ExtensionUIDialogOptions. */
export interface OmpDialogOptions {
  onLeft?: () => void;
  onRight?: () => void;
  helpText?: string;
}

/**
 * Host-implementable subset of Pi's ExtensionUIContext.
 *
 * GitSpace installs this via setToolUIContext() so extensions' high-level UI
 * requests (select, confirm, input, editor, notify, status, widget, working
 * message, editor text) are routed to the native host surface instead of the
 * Pi TUI.
 */
export interface OmpHostUIContext {
  select(title: string, options: string[], dialogOptions?: OmpDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, dialogOptions?: OmpDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, dialogOptions?: OmpDialogOptions): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWidget(key: string, content: string[] | undefined): void;
  setEditorText(text: string): void;
  pasteToEditor(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  setTitle(title: string): void;
}

/**
 * The full result of createAgentSession from the Pi SDK.
 * GitSpace previously destructured only { session }, discarding setToolUIContext.
 */
export interface OmpCreateSessionResult {
  session: OmpAgentSession;
  /** Install a host UI context so extension UI requests route to the native surface. */
  setToolUIContext: (uiContext: OmpHostUIContext, hasUI: boolean) => void;
  extensionsResult?: unknown;
  mcpManager?: unknown;
  modelFallbackMessage?: string;
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
    skills?: Skill[];
    hasUI?: boolean;
  }): Promise<OmpCreateSessionResult>;
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
