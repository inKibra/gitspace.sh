import type { NotificationConfig } from '../notifications/types.js';
import type { WorkspaceEditorId, WorkspaceEditorOption } from '../utils/open-editor.js';
import type { BackendEvent } from './events.js';
import type {
  ReplayFrame,
  ReplayFrameTarget,
  ReplayInfo,
  ReplayTimeline,
  TerminalSnapshot,
} from '../lib/tmux-lite/replay/index.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type { PortConflictInfo } from '../lib/processes/port-conflicts.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type { WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary, WorkspaceSource } from '../types/lifecycle.js';
import type { ConfirmStepResult, SpacesBundle } from '../types/bundle.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../lib/tmux-lite/agent-event-manager.js';
import type { AgentControlInfo, AgentDefinitionInfo, AgentHistoryEntry, AgentSettingItem, AgentSettingSchemaItem, AgentToolInfo, AgentTreeNode } from '../agents/agent-runtime-types.js';

import type { ChainStackStatus, GoalChain, GoalRecord, GoalUpdateInput, WorkspacePhaseChangePreview } from '../types/goals.js';
export type BackendKey = string;
export type BackendKind = 'local' | 'remote';

/** Byte range for a paged artifact read (large media → Blob). Omitted → the
 *  legacy single-shot read (server caps and may truncate). */
export interface ArtifactReadRange {
  offset: number;
  length: number;
}

export interface BackendDescriptor {
  key: BackendKey;
  kind: BackendKind;
  label: string;
  machineId?: string;
  relayUrl?: string;
}

export interface AttachPaneParams extends AttachSessionParams {
  paneId: string;
  agentSessionId?: string;
}


export interface AttachSessionParams {
  sessionId?: string;
  workspaceId?: string;
  sessionName?: string;
  cols?: number;
  rows?: number;
  scriptPolicy?: 'auto' | 'skip';
  /** When true, the client cannot send input to the PTY (view-only mode) */
  viewOnly?: boolean;
  /** Custom command to run (skips workspace scripts when set) */
  command?: string;
  /** Arguments for the custom command */
  args?: string[];
  /** Environment variables for the custom command */
  env?: Record<string, string>;
}

export interface DeleteWorkspaceParams {
  scriptPolicy?: 'auto' | 'skip';
  /**
   * Optional timeout for delete completion when waiting on remote responses.
   * Ignored by local backend.
   */
  timeoutMs?: number;
}

export interface CreateProjectParams {
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
  /** From-scratch project: git init locally, no repo required. */
  scratch?: boolean;
}

export interface PreparedProjectResult {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  confirmStatuses?: Record<string, 'found' | 'missing'>;
}

export interface FinalizeProjectParams {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  inputValues?: Record<string, string>;
  secretValues?: Record<string, string>;
  confirmResults?: Record<string, ConfirmStepResult>;
  setCurrent?: boolean;
}

export interface CreateWorkspaceParams {
  projectName: string;
  workspaceName: string;
  branchName?: string;
  baseBranch?: string;
  workspaceSource?: WorkspaceSource;
  linearIssue?: SessionLinearIssueSummary;
  parentWorkspaceName?: string;
  githubIssueNumber?: number;
}

export interface DeleteProjectParams {
  /**
   * Optional timeout for delete completion when waiting on remote responses.
   * Ignored by local backend.
   */
  timeoutMs?: number;
}

export interface TerminateSessionOptions {
  mode?: 'graceful' | 'force';
  graceMs?: number;
}

/**
 * Canonical backend contract used by shared session engine.
 */
export interface SessionBackend {
  readonly descriptor: BackendDescriptor;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listProjects(): Promise<void>;
  listGithubRepos(org?: string): Promise<string[]>;
  listRemoteBranches(projectName: string): Promise<string[]>;
  listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]>;
  listWorkspaces(): Promise<void>;
  /** Set workspace kanban phase; then listWorkspaces is implied (local) or caller should refresh (remote). */
  setWorkspaceStatus?(projectName: string, workspaceName: string, phase: import('../types/config.js').WorkspacePhase, options?: { cascade?: boolean }): Promise<void>;
  previewWorkspaceStatusChange?(projectName: string, workspaceName: string, phase: import('../types/config.js').WorkspacePhase): Promise<WorkspacePhaseChangePreview>;
  addGoalNearWorkspace?(projectName: string, workspaceName: string, title: string, position: 'before' | 'after'): Promise<GoalRecord>;
  updateGoal?(projectName: string, goalId: string, updates: GoalUpdateInput): Promise<GoalRecord>;
  /** Cold detail fetch (ticket #42): full goal doc + validation for one goal,
   *  pulled lazily when a detail view opens (the connect snapshot is slim). */
  getGoalDetail?(projectName: string, goalId: string): Promise<{ doc: import('../types/goals.js').GoalDoc; validation: import('../types/goals.js').GoalValidation }>;
  moveGoalInChain?(projectName: string, sourceToken: string, targetToken: string, position: 'before' | 'after'): Promise<GoalChain>;
  /** List the project's chains (title + ordered goals with effective phases)
   *  for the workspace-free create-goal flow. */
  listGoalChains?(projectName: string): Promise<import('../types/goals.js').GoalChainSummary[]>;
  /** Chain-centric planned-goal creation (no workspace): seed a new chain or
   *  insert a planned goal at a legal position in an existing chain. */
  addPlannedGoalToChain?(projectName: string, input: import('../core/goal-chain.js').AddPlannedGoalToChainInput): Promise<GoalRecord>;
  getGoalStackStatus?(projectName: string, workspaceName: string): Promise<ChainStackStatus>;
  /** HUMAN-ONLY: waive a computed phase gate (timeline event kind 'gate',
   *  actor 'human/ui'). UI-button seam — the CLI has no waive flag. */
  waiveGoalGate?(projectName: string, goalId: string, phase: string, reason: string): Promise<GoalRecord>;
  addGoalRequirement?(projectName: string, goalId: string, input: import('../core/goal-validation.js').AddRequirementInput): Promise<import('../types/goals.js').Requirement>;
  updateGoalRequirement?(projectName: string, goalId: string, requirementId: string, patch: import('../core/goal-validation.js').UpdateRequirementInput): Promise<import('../types/goals.js').Requirement>;
  removeGoalRequirement?(projectName: string, goalId: string, requirementId: string): Promise<void>;
  reorderGoalRequirement?(projectName: string, goalId: string, requirementId: string, position: number): Promise<void>;
  reopenGoalRequirement?(projectName: string, goalId: string, requirementId: string): Promise<import('../types/goals.js').Requirement>;
  attachGoalEvidence?(projectName: string, goalId: string, requirementId: string, input: import('../core/goal-validation.js').AttachEvidenceInput): Promise<import('../types/goals.js').Evidence>;
  runGoalGeneration?(projectName: string, goalId: string, requirementId: string): Promise<{ requirement: import('../types/goals.js').Requirement; evidence: import('../types/goals.js').Evidence; autoAccepted: boolean }>;
  runGoalJudgment?(projectName: string, goalId: string, requirementId: string): Promise<{ requirement: import('../types/goals.js').Requirement; review: import('../types/goals.js').Review }>;
  recordGoalHumanReview?(projectName: string, goalId: string, requirementId: string, decision: import('../core/goal-validation.js').HumanReviewDecision, note: string, score?: number, createdBy?: string): Promise<import('../types/goals.js').Review>;
  listSessions(workspaceId?: string): Promise<void>;
  listReplays?(workspaceId?: string, includeDismissed?: boolean): Promise<void>;
  createProject(params: CreateProjectParams): Promise<void>;
  prepareProjectCreation?(params: CreateProjectParams): Promise<PreparedProjectResult>;
  finalizeProjectCreation?(params: FinalizeProjectParams): Promise<void>;
  cancelProjectCreation?(projectName: string): Promise<void>;
  createWorkspace(params: CreateWorkspaceParams): Promise<void>;
  deleteProject(projectName: string, params?: DeleteProjectParams): Promise<void>;

  attachPane?(params: AttachPaneParams): Promise<void>;
  detachPane?(paneId: string): Promise<void>;
  detachAllPanes?(): Promise<void>;
  attachSession(params: AttachSessionParams): Promise<void>;
  detachSession(): Promise<void>;
  cancelPendingScripts?(): Promise<void>;

  terminateSession(sessionId: string, options?: TerminateSessionOptions): Promise<void>;
  deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ): Promise<void>;

  listWorkspaceNotes?(projectName: string, workspaceName: string): Promise<import('../types/workspace.js').WorkspaceNote[]>;
  addWorkspaceNote?(projectName: string, workspaceName: string, body: string): Promise<import('../types/workspace.js').WorkspaceNote>;
  updateWorkspaceNote?(projectName: string, workspaceName: string, noteId: string, body: string): Promise<import('../types/workspace.js').WorkspaceNote>;
  removeWorkspaceNote?(projectName: string, workspaceName: string, noteId: string): Promise<void>;
  rerunWorkspaceScripts?(projectName: string, workspaceId: string): Promise<void>;
  runWorkspaceScriptSelection?(projectName: string, workspaceId: string, selection: 'setup' | 'select' | 'setup-select'): Promise<void>;
  runWorkspaceOpenScripts?(projectName: string, workspaceId: string): Promise<void>;

  getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan>;
  applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void>;
  getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState>;
  applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void>;

  requestInbox(): Promise<void>;
  clearInbox(id?: string): Promise<void>;
  markInboxRead(id: string): Promise<void>;

  getNotificationConfig(): Promise<void>;
  updateNotificationConfig(config: NotificationConfig): Promise<void>;

  sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult>;
  startProcess?(workspaceId: string, processName: string, instance?: number): Promise<void>;
  stopProcess?(workspaceId: string, processName: string): Promise<void>;
  resolvePortConflict?(conflict: PortConflictInfo): Promise<void>;
  requestEvents?(workspacePath: string, filter?: WideEventFilter, limit?: number, sinceMs?: number): Promise<void>;

  writePaneData?(paneId: string, data: Uint8Array): Promise<void>;
  resizePane?(paneId: string, cols: number, rows: number): Promise<void>;
  setPaneOutputHandler?(paneId: string, handler: ((data: Uint8Array) => void) | null): void;
  writePtyData?(data: Uint8Array): Promise<void>;
  resizePty?(cols: number, rows: number): Promise<void>;
  createCheckpoint?(sessionId: string): Promise<void>;
  getReplaySnapshot?(replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot>;
  getReplayText?(
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ): Promise<string>;
  getReplayMarkdown?(
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ): Promise<string>;
  getReplayFrame?(replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame>;
  getReplayTimeline?(replayId: string): Promise<ReplayTimeline>;
  cancelPendingReplayRequests?(): void;
  dismissReplay?(replayId: string): Promise<void>;
  undismissReplay?(replayId: string): Promise<void>;
  dismissOperation?(operationId: string): Promise<void>;

  onEvent(handler: (event: BackendEvent) => void): () => void;

  /** Subscribe to agent state deltas. Returns an unsubscribe function. */
  subscribeAgentState(handler: (delta: AgentStateUpdateDelta) => void): () => void;
  /** Get the current full agent state snapshot (all workspaces). */
  getAgentStateSnapshot(): Record<string, WorkspaceAgentState>;
  /**
   * Respond to an agent permission request.
   * workspaceId identifies which workspace owns the agent session.
   */
  respondToAgentPermission(
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ): Promise<boolean>;

  /** Read one page of an agent session's transcript as blocks (range-paginated). */
  getAgentTranscriptRange?(
    workspaceId: string,
    agentSessionId: string,
    before: string | undefined,
    limit: number,
  ): Promise<{ blocks: unknown[]; oldestCursor: string | null; hasMore: boolean }>;

  /** Control-surface snapshot for an agent session (usage + model switcher). */
  getAgentControlInfo?(workspaceId: string, agentSessionId: string): Promise<AgentControlInfo>;
  /** Switch an agent session's model. */
  setAgentModel?(workspaceId: string, agentSessionId: string, provider: string, modelId: string): Promise<boolean>;
  /** Set an agent session's thinking/reasoning level. */
  setAgentThinkingLevel?(workspaceId: string, agentSessionId: string, level: string): Promise<boolean>;
  /** Set an agent session's tool-approval mode. */
  setAgentApprovalMode?(workspaceId: string, agentSessionId: string, mode: string): Promise<boolean>;
  /** List providers + their auth status + per-provider account pool (machine-global). */
  getAgentAuthProviders?(): Promise<Array<{ provider: string; hasAuth: boolean; accounts?: Array<{ id: number; type: string; label: string; disabled: boolean }> }>>;
  /** Remove one account (credential) from a provider's pool by row id. */
  removeAgentProviderAccount?(provider: string, credentialId: number): Promise<boolean>;
  /** Probe live usage/limit windows for a provider's accounts (on-demand). */
  checkAgentProviderUsage?(provider: string): Promise<Array<{ id: number; email?: string; ok: boolean | null; reason?: string; limits: Array<{ label: string; unit?: string; used?: number; limit?: number; remaining?: number; remainingFraction?: number; resetsAt?: number; status?: string }>; resetCredits?: { availableCount: number } }>>;
  /** Store an API key for a provider (machine-global). */
  setAgentProviderApiKey?(provider: string, key: string): Promise<boolean>;
  /** Read the curated agent settings catalog (machine-global). */
  getAgentSettings?(): Promise<AgentSettingItem[]>;
  /** Write a single agent setting (machine-global). */
  setAgentSetting?(path: string, value: string | number | boolean | string[]): Promise<boolean>;
  /** Start an OAuth sign-in flow (events arrive via subscribeAgentState). */
  startAgentOAuthLogin?(provider: string, flowId: string): Promise<boolean>;
  /** Provide the value an in-progress OAuth flow asked for. */
  respondAgentOAuthPrompt?(flowId: string, value: string): Promise<boolean>;
  /** Full settings schema by tab (machine-global). */
  getAgentSettingsSchema?(): Promise<AgentSettingSchemaItem[]>;
  /** Tools available to a session (per-tool approval). */
  getAgentTools?(workspaceId: string, agentSessionId: string): Promise<AgentToolInfo[]>;
  /** Discovered subagent definitions for a workspace (AGENTS settings section). */
  listAgentDefinitions?(workspaceId: string): Promise<AgentDefinitionInfo[]>;
  /** Compact a session's context. */
  compactAgentSession?(workspaceId: string, agentSessionId: string): Promise<boolean>;
  /** Cycle the active model through configured roles. */
  cycleAgentRole?(workspaceId: string, agentSessionId: string, direction: 'forward' | 'backward'): Promise<boolean>;
  /** Apply a specific role's model to the session. */
  applyAgentModelRole?(workspaceId: string, agentSessionId: string, role: string): Promise<boolean>;
  /** User-message checkpoints for conversation rewind. */
  getAgentHistory?(workspaceId: string, agentSessionId: string): Promise<AgentHistoryEntry[]>;
  /** The full conversation tree (message nodes) for the branch explorer. */
  getAgentSessionTree?(workspaceId: string, agentSessionId: string): Promise<AgentTreeNode[]>;
  /** List the workspace's artifacts mount (pointer-aware). */
  listWorkspaceArtifacts?(workspaceId: string): Promise<Array<{ path: string; size: number; pointer: boolean }>>;
  /** Read one artifact (pointer-resolved) as base64, capped server-side. Pass a
   *  byte range to page large media into a Blob (`truncated` ⇒ more remains). */
  readWorkspaceArtifact?(workspaceId: string, path: string, range?: ArtifactReadRange): Promise<{ base64: string; size: number; truncated: boolean }>;
  /** Write an artifact into the workspace mount (commit-on-write). */
  writeWorkspaceArtifact?(workspaceId: string, path: string, contentBase64: string, message?: string): Promise<string>;
  /** List favorited artifacts for a workspace (mount-relative paths). Reads the
   *  committed `.favorites.json` manifest through the daemon — not localStorage. */
  listWorkspaceFavorites?(workspaceId: string): Promise<string[]>;
  /** Toggle one favorite (add/remove) — commits the manifest, returns the full
   *  updated list (mount-relative). Favoriting a report also snapshots its
   *  attachments; refs whose target could not be found come back in
   *  `snapshotSkipped` (the favorite itself still succeeded). */
  toggleWorkspaceFavorite?(workspaceId: string, path: string): Promise<{ favorites: string[]; snapshotSkipped?: string[] }>;
  /** Union-merge favorites into the manifest (localStorage reconciliation);
   *  idempotent, returns the full updated list (mount-relative). */
  mergeWorkspaceFavorites?(workspaceId: string, paths: string[]): Promise<string[]>;
  /** List the PROJECT's artifacts (base clone's main mount). */
  listProjectArtifacts?(projectName: string): Promise<Array<{ path: string; size: number; pointer: boolean }>>;
  /** Read one project artifact (pointer-resolved) as base64. Pass a byte range
   *  to page large media into a Blob (`truncated` ⇒ more remains). */
  readProjectArtifact?(projectName: string, path: string, range?: ArtifactReadRange): Promise<{ base64: string; size: number; truncated: boolean }>;
  /** Write+commit an artifact on the project's MAIN branch (base mount). */
  writeProjectArtifact?(projectName: string, path: string, contentBase64: string, message?: string): Promise<string>;
  /** Artifacts repo status: local bare-repo path, remote url, branches. */
  getProjectArtifactsStatus?(projectName: string): Promise<{ repoPath: string; remote: string | null; branches: string[]; pointerCommitted?: boolean }>;
  /** Connect a BYO remote (writes the committed pointer) and sync. */
  setProjectArtifactsRemote?(projectName: string, url: string): Promise<{ pushed: boolean; fastForwarded: boolean }>;
  /** Fetch + ff main + push --all against the configured remote. */
  syncProjectArtifacts?(projectName: string): Promise<{ pushed: boolean; fastForwarded: boolean }>;
  /** One-click GitHub provisioning: create <owner>/<repo>-artifacts, wire remote+pointer, push, mirror collaborators, upload large files to GitHub LFS. */
  provisionProjectArtifacts?(projectName: string): Promise<{ slug: string; url: string; created: boolean; blobsUploaded: number; collaboratorsCopied: number }>;
  /** Merge a workspace's artifacts branch into main (curation happens at the merge; publish-gated). */
  rollupProjectArtifacts?(projectName: string, workspace: string, opts?: { removeBranch?: boolean }): Promise<{ mergeCommit: string }>;
  /** File a redacted problem report (client bundle + note) — writes locally, returns the path. */
  reportProblem?(note: string, clientBundle: unknown, opts?: { fileIssue?: boolean; projectName?: string }): Promise<{ path: string; issueUrl?: string; issueNumber?: number }>;
  /** Mint a signed public share link for one artifact (requires serve active on the machine). */
  mintArtifactShare?(uri: string, opts?: { ttlMs?: number; maxUses?: number }): Promise<{ url: string; tokenId: string; expiresAt: number }>;
  /** Revoke a share link by tokenId. */
  revokeArtifactShare?(tokenId: string): Promise<boolean>;
  /** Persist a trigger through the registry (validates the schedule — an unfireable cron `when` is rejected). */
  saveWorkspaceTrigger?(workspaceId: string, trigger: import('../core/triggers.js').TriggerRecord): Promise<import('../core/triggers.js').TriggerRecord>;
  /** Run a trigger now: records pending, spawns + prompts the agent session, records ok/fail server-side. */
  runWorkspaceTriggerNow?(workspaceId: string, triggerId: string): Promise<{ sessionId: string }>;
  /** Full workspace file listing (tracked + untracked, status letters). */
  listRepoFiles?(workspaceId: string): Promise<Array<{ path: string; status?: string }>>;
  /** Read a workspace file (path-jailed, capped). Null base64 = missing. */
  readRepoFile?(workspaceId: string, path: string): Promise<{ base64: string | null; size: number; truncated: boolean }>;
  /** Repo-wide content search (git grep: gitignore-aware, binaries skipped). */
  searchRepoContent?(workspaceId: string, query: string, options?: { caseSensitive?: boolean }): Promise<{ hits: Array<{ path: string; line: number; text: string }>; truncated: boolean }>;
  /** Stage all + commit. Returns the sha, or null when nothing to commit. */
  commitWorkspaceChanges?(workspaceId: string, message: string): Promise<string | null>;
  /** Navigate the conversation tree: `redo` rewinds to the message's parent and
   *  returns its text; `jump` makes the node the leaf (return to a fork). */
  navigateAgentHistory?(workspaceId: string, agentSessionId: string, entryId: string, mode?: 'redo' | 'jump'): Promise<{ ok: boolean; editorText?: string }>;

  /** Fast, persisted workspace-scoped agent sessions (history/snapshot-backed). */
  getKnownAgentSessions?(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  /** Live refresh of workspace-scoped agent sessions from the runtime. */
  listAgentSessions?(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  createAgentSession?(workspaceId: string, title?: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  abortAgentSession?(workspaceId: string, agentSessionId: string): Promise<boolean>;
  /**
   * Interrupt the agent's current turn without killing the session.
   * The agent stops its current LLM/tool execution and becomes idle,
   * ready for new prompts. Compare with abortAgentSession() which
   * kills the tmux session entirely.
   */
  interruptAgentSession?(workspaceId: string, agentSessionId: string): Promise<boolean>;
  closeAgentSession?(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  archiveAgentSession?(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  restoreAgentSession?(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  attachAgentSession?(workspaceId: string, agentSessionId: string, options?: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string }): Promise<void>;
  promptAgentSession?(workspaceId: string, agentSessionId: string, text: string, images?: import('../lib/tmux-lite/protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  removeAgentQueuedMessage?(workspaceId: string, agentSessionId: string, kind: 'steering' | 'followUp', index: number): Promise<string | null>;
  listAvailableEditors?(workspaceId: string): Promise<WorkspaceEditorOption[]>;
  openWorkspaceInEditor?(workspaceId: string, editorId: WorkspaceEditorId): Promise<void>;
  stageUpload?(workspaceId: string, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }>;
  /** Send a dialog response back to the server for a pending host UI dialog. */
  sendDialogResponse?(dialogId: string, dialogType: import('../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogResponseType, value: import('../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogResponseValue): Promise<void>;

  /** Retrieve the persisted last-selected agent session ID for a workspace. */
  getAgentSessionPreference(workspaceId: string): Promise<string | null>;
  /** Persist the selected agent session ID for a workspace. */
  setAgentSessionPreference(workspaceId: string, sessionId: string): Promise<void>;
  listAgentCommands?(workspaceId: string): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>>;
  runSpaceCommand?(workspaceId: string, argsText: string): Promise<string>;
  getFileSuggestions?(workspaceId: string, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>>;
}

export type { ReplayFrame, ReplayFrameTarget, ReplayInfo, ReplayTimeline, TerminalSnapshot };