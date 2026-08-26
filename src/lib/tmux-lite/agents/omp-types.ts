import type { Skill } from '@oh-my-pi/pi-coding-agent/extensibility/skills';
import type { CredentialHealthResult } from '@oh-my-pi/pi-ai';

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
  /**
   * Run a prompt against the session's context WITHOUT recording it in the
   * transcript (the SDK's `/btw` and `/omfg` share this pipeline). Used for the
   * idle recap, which is a view over the conversation rather than part of it —
   * so nothing about asking for one appears in the history.
   */
  runEphemeralTurn?(args: { promptText: string; signal?: AbortSignal; dedupeReply?: boolean }): Promise<{ replyText: string }>;
  /** Rename the session. Source `user` is final — Pi will not overwrite it with
   *  a generated title. Present on AgentSession as well as the session manager. */
  setSessionName?(name: string, source?: 'auto' | 'user'): Promise<boolean | void>;
  /** Pi's resolved settings. Only the paths we read are declared, so an upstream
   *  schema change cannot silently widen what we depend on. */
  readonly settings?: {
    /** The SDK's `SettingValue<P>` resolves to `unknown` for these paths, so the
     *  caller narrows. Restricted to the paths we read on purpose. */
    get(path: 'recap.enabled' | 'recap.idleSeconds'): unknown;
  };
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
  /**
   * `source` defaults to `auto` in the SDK. A name set with `user` is final —
   * Pi refuses to overwrite it with a generated one. We previously narrowed this
   * signature to `(name)`, which silently dropped the distinction.
   */
  setSessionName(name: string, source?: 'auto' | 'user'): Promise<boolean | void>;
  /** Change notification — carries no value; read it back with getSessionName. */
  onSessionNameChanged?(cb: () => void): () => void;
  getSessionName?(): string | undefined;
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
  /** Local (no-probe) list of stored credentials — the multi-account pool per
   *  provider. Each carries the DB row id used to remove a specific account. */
  listStoredCredentials?(provider?: string): Array<{
    id: number;
    provider: string;
    credential: { type: string; email?: string; accountId?: string; label?: string };
    disabledCause: string | null;
  }>;
  /** Remove ONE stored credential (account) by its row id. */
  removeCredential?(provider: string, credentialId: number): Promise<boolean>;
  /** Probe each credential's provider usage endpoint (network). Returns per-
   *  credential health + the subscription's limit windows (remaining/reset).
   *  Typed straight from the SDK (`CredentialHealthResult`) so our mapping in
   *  pi-coordinator is checked against the real (nested) shape — a hand-rolled
   *  copy is what silently drifted and blanked the usage bars. */
  checkCredentials?(options?: { timeoutMs?: number }): Promise<CredentialHealthResult[]>;
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

// ---------------------------------------------------------------------------
// Rich multi-question ask dialog. OMP 18 exposes this directly on
// ExtensionUIContext; GitSpace maps it onto the existing ask-form wire dialog.
// ---------------------------------------------------------------------------

export interface OmpAskFormOption {
  label: string;
  description?: string;
  preview?: string;
}

/** Existing host wire shape. */
export interface OmpAskFormQuestion {
  id: string;
  question: string;
  options: OmpAskFormOption[];
  multiple: boolean;
  recommended?: number;
}

export interface OmpAskFormAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

/** OMP 18 ExtensionUIContext askDialog input. */
export interface OmpAskDialogQuestion {
  id: string;
  question: string;
  header?: string;
  options: OmpAskFormOption[];
  multi?: boolean;
  recommended?: number;
}

export interface OmpAskDialogResultItem extends OmpAskFormAnswer {
  question: string;
  options: string[];
  multi: boolean;
  note?: string;
  timedOut?: boolean;
}

export type OmpAskDialogResult =
  | { kind: 'submit'; results: OmpAskDialogResultItem[] }
  | { kind: 'chat' };
/**
 * Host-implementable subset of Pi's ExtensionUIContext.
 */
export interface OmpHostUIContext {
  select(title: string, options: string[], dialogOptions?: OmpDialogOptions): Promise<string | undefined>;
  askDialog(
    questions: OmpAskDialogQuestion[],
    dialogOptions?: OmpDialogOptions,
  ): Promise<OmpAskDialogResult | undefined>;
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
    /** local:// root = the artifacts mount (<workspace>/.gitspace/artifacts),
     *  flat — the SDK's '/local' suffix is removed via bun patch. */
    localProtocolOptions?: { getArtifactsDir?: () => string | null; getSessionId?: () => string | null };
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
