import {
  listAccountSecretsContract,
  putAccountSecretContract,
  deleteAccountSecretContract,
  grantAccountSecretContract,
  revokeAccountSecretContract,
  getConfigurationValuesContract,
  putConfigurationValueContract,
  deleteConfigurationValueContract,
  bootstrapContract,
  transcriptContract,
  transcriptPageContract,
  transcriptContentContract,
  archiveWorkspaceContract,
  closeSpaceContract,
  archiveProjectContract,
  createProjectSessionContract,
  createProjectContract,
  openProjectContract,
  createWorkspaceContract,
  createSandboxMachineContract,
  createSessionContract,
  getBrowserRelayStatusContract,
  createMcpConnectionContract,
  authorizeComposioPluginContract,
  createWorkspaceTerminalContract,
  deleteProjectSecretContract,
  deleteProjectContract,
  deleteWorkspaceContract,
  deleteMcpConnectionContract,
  disconnectComposioPluginContract,
  deleteComposioSetupContract,
  setupBrowserRelayContract,
  startBrowserRelayContract,
  stopBrowserRelayContract,
  testBrowserRelayContract,
  deleteProjectMcpGrantContract,
  discoverProjectMcpToolsContract,
  destroyMachineContract,
  gitspaceContract,
  getGitIdentityContract,
  getOmpSettingsContract,
  getComposioSetupContract,
  getMcpConnectionStatusContract,
  getWorkspaceEnvironmentContract,
  getUserSettingsContract,
  listMachinesContract,
  listProjectsContract,
  listWorkspaceTerminalsContract,
  listSkillsContract,
  listComposioPluginCatalogContract,
  listComposioPluginToolsContract,
  listProjectSecretsContract,
  listMcpConnectionsContract,
  listProjectMcpGrantsContract,
  machineEventsContract,
  restoreWorkspaceContract,
  refreshComposioPluginContract,
  reopenSpaceContract,
  restoreProjectContract,
  resumeMachineContract,
  sleepMachineContract,
  ompSettingValueSchema,
  cancelProviderLoginContract,
  listProvidersContract,
  logoutProviderContract,
  providerLoginEventsContract,
  providerUsageContract,
  listAvailableModelsContract,
  placementsContract,
  locateSessionContract,
  type SpacePlacementView,
  listDevicesContract,
  deploymentLaunchContract,
  deploymentRevertContract,
  deploymentStatusContract,
  type DeploymentStatus,
  type ReleaseRecord,
  type ReleaseTarget,
  revokeDeviceContract,
  respondProviderLoginContract,
  setProviderApiKeyContract,
  startProviderLoginContract,
  promptSessionContract,
  getSessionControlContract,
  getSessionUsageContract,
  getSessionAgentsContract,
  saveSessionAgentContract,
  sessionHistoryPageContract,
  cycleSessionRoleContract,
  setSessionThinkingContract,
  setSessionFastContract,
  setSessionModelContract,
  setSessionApprovalContract,
  setSessionGoalContract,
  compactSessionContract,
  clearSessionQueueContract,
  removeSessionQueuedMessageContract,
  promoteSessionQueuedMessageContract,
  answerSessionAskContract,
  stopSessionTurnContract,
  navigateSessionTreeContract,
  setWorkspacePhaseContract,
  setWorkspaceRelationsContract,
  stackStatusContract,
  putProjectMcpGrantContract,
  putProjectSecretContract,
  putComposioSetupContract,
  reserveUserHandleContract,
  readWorkspaceTerminalContract,
  sendWorkspaceTerminalContract,
  stopWorkspaceTerminalContract,
  terminalEventsContract,
  setOmpSettingContract,
  subagentTranscriptContract,
  subagentTranscriptEventsContract,
  subagentTranscriptPageContract,
  subagentTranscriptContentContract,
  updateUserSettingsContract,
  updateMcpConnectionContract,
  updateComposioPluginToolsContract,
  putWorkspaceEnvironmentBundleContract,
  setWorkspaceEnvironmentProfileContract,
  putWorkspaceEnvironmentValueContract,
  deleteWorkspaceEnvironmentValueContract,
  approveWorkspaceEnvironmentExecutionContract,
  revokeWorkspaceEnvironmentApprovalContract,
  runWorkspaceEnvironmentChecksContract,
  runWorkspaceEnvironmentPhaseContract,
  cancelWorkspaceEnvironmentRunContract,
  recoverWorkspaceEnvironmentRunContract,
  getWorkspaceEnvironmentRunLogContract,
  updateMachineNotesContract,
  createProjectCronContract,
  deleteProjectCronContract,
  inspectorAppendJournalEntryContract,
  inspectorAnalyzeChangeGuideContract,
  inspectorAppendReviewMessageContract,
  inspectorAppendRubricJudgmentContract,
  inspectorAttachRequirementEvidenceContract,
  inspectorCreateReviewThreadContract,
  inspectorEndJournalPhaseContract,
  inspectorReadArtifactContract,
  inspectorReadResourceContract,
  inspectorJournalContract,
  inspectorMarkGuideSectionReadContract,
  inspectorOverviewContract,
  inspectorPutChangeGuideContract,
  inspectorPutGoalContract,
  inspectorPutRubricContract,
  inspectorPutWorkflowContract,
  inspectorRepositoryDiffContract,
  inspectorRepositoryFileContract,
  inspectorRepositoryStatusContract,
  inspectorRepositoryTreeContract,
  inspectorResolveReviewThreadContract,
  inspectorReviewThreadsContract,
  inspectorServicesContract,
  inspectorSetGuideApprovalContract,
  inspectorSubmitChangeGuideContract,
  inspectorWriteArtifactContract,
  startWorkspaceServiceContract,
  stopWorkspaceServiceContract,
  updateSkillContract,
  inspectorStartJournalPhaseContract,
  inspectorWaiveWorkflowGateContract,
  listProjectCronsContract,
  projectCronHistoryContract,
  runProjectCronNowContract,
  updateProjectCronContract,
  type AppendJournalEntryInput,
  type AppendReviewMessageInput,
  type AppendRubricJudgmentInput,
  type AttachRequirementEvidenceInput,
  type ChangeGuideView,
  type ComposioPluginAuthorization,
  type ComposioPluginCatalog,
  type ComposioPluginTool,
  type ComposioSetup,
  type BrowserRelayStatus,
  type DiscoveredMcpTool,
  type CloudProjectOperation,
  type CloudProjectSummary,
  type CloudWorkspaceDefinition,
  type CreateReviewThreadInput,
  type EndJournalPhaseInput,
  type GoalRecordView,
  type GitSpaceRpcContext,
  type InspectorIdentity,
  type McpConnection,
  type McpConnectionDraft,
  type InspectorOverview,
  type JournalEntryView,
  type MarkGuideSectionReadInput,
  type ProjectCronDraft,
  type ProjectCronRunView,
  type ProjectEvent,
  type ProviderLoginEvent,
  type ProjectCronView,
  type PutChangeGuideInput,
  type PutGoalInput,
  type PutRubricInput,
  type PutWorkflowInput,
  type ResolveReviewThreadInput,
  type ReviewAnchorContext,
  type ReviewThreadView,
  type ServiceView,
  type ProjectMcpGrant,
  type SkillUpdate,
  type SkillView,
  type RubricView,
  type SetGuideApprovalInput,
  type StartJournalPhaseInput,
  type WaiveWorkflowGateInput,
  type WorkflowView,
} from '@gitspace/protocol';
import { encodeTranscriptEventChunks } from '@gitspace/protocol/transcript';
import { createResourcePreview, parseResourceUri } from '@gitspace/protocol/resource-uri';
import { type AgentSession, type ArtifactCapability, type FactEventStore, type GitSpaceDatabase, type GitSpaceHandlers, type LocalArtifactResolver, type MaterializedSpace } from '@gitspace/core';
import { assertWorkspacePhase, WorkspaceDomainError } from '@gitspace/protocol-workspace';
import { contractDigest, err, ok } from 'result-rpc';
import { createFetchHandler, serverRpc } from 'result-rpc/server';
import { DeploymentLaunchError, type LaunchProgress } from './deployment-launcher.js';
import { DeviceRegistry } from './device-registry.js';
import { callerFor } from './signed-rpc.js';
import { computeStackStatus } from './stack-status.js';
import { agentFailure, currentAgentExecutionFailure, determineAgentState, SessionProjectUnavailable, SessionWorkspaceUnavailable } from '@gitspace/protocol-agent';
import { assertLifecycleCommandAuthorized, environmentFailure, EnvironmentError, parseEnvironmentBundleJson } from '@gitspace/protocol-environment';
import type { MachineSessionCoordinator } from './session-coordinator.js';
import type { SpaceLifecycleController } from './portable-space-controller.js';
import type { ArchiveWorkspaceInput } from './project-lifecycle.js';
import type { ClosedSpaceCheckpointMetadata, ClosedSpaceTranscript } from './checkpoint-transcript.js';
import {
  WorkspaceHubSpaceUnavailable,
  WorkspaceHubTerminalUnavailable,
  type WorkspaceHubTerminalCoordinator,
} from './workspace-hub.js';
import { WorkspaceEnvironmentManager, type WorkspaceEnvironmentView } from './workspace-environment.js';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import { CanonicalSettingsConflict, type CanonicalSettingsCoordinator } from './canonical-settings.js';
import { ProviderAuthError, type ProviderAuthCoordinator } from './provider-auth.js';
import type { SharedGitIdentityCoordinator } from './shared-git-identity.js';
import { CloudSpaceAuthorityError } from './cloud-space-authority.js';
import {
  readRepositoryDiff,
  readRepositoryFile,
  readRepositoryIdentity,
  readRepositoryStatus,
  readRepositoryTree,
  type InspectorRepositoryContext,
  type InspectorRepositoryRead,
} from './inspector-git.js';
import { buildChangeGuideWorksheet, validateChangeGuideNarration } from './change-guide-generation.js';
import { emptyTotals } from './session-usage-report.js';
import { readInspectorResource } from './inspector-resources.js';
import type { TranscriptPage, TranscriptPageRequest, TranscriptContentPage, TranscriptContentRequest } from '@gitspace/blocks';
import { boundSessionControl } from '@gitspace/protocol-agent';

export interface FleetMachineRpcView {
  id: string;
  label: string;
  state: 'provisioning' | 'online' | 'sleeping' | 'offline' | 'resuming' | 'deleting' | 'error';
  rpcEndpoint: string | null;
  kind: 'physical' | 'sandbox';
  provider: 'physical' | 'cloudflare-sandbox';
  notes: string;
  desiredState: 'online' | 'offline' | 'removed';
  lifecycleRevision: number;
  operationId: string | null;
  error: string | null;
}

export interface ProjectSecretsRpc {
  listProjectSecrets(projectId: string): Promise<Array<{ projectId: string; name: string; revision: number; updatedAt: string; updatedBy: string }>>;

  putProjectSecret(projectId: string, name: string, value: string): Promise<{ projectId: string; name: string; revision: number; updatedAt: string; updatedBy: string }>;
  deleteProjectSecret(projectId: string, name: string): Promise<{ deleted: boolean }>;
  materializeProjectSecrets(projectId: string, names: string[], workspaceId: string | null): Promise<Record<string, string>>;
}
export interface MachineMcpRpc {
  listConnections(): Promise<McpConnection[]>;
  createConnection(connection: McpConnectionDraft): Promise<McpConnection>;
  updateConnection(connectionId: string, expectedRevision: number, connection: McpConnectionDraft): Promise<McpConnection>;
  deleteConnection(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }>;
  connectionStatus(connectionId: string): Promise<McpConnection | null>;
  getComposioSetup(): Promise<ComposioSetup>;
  putComposioSetup(apiKey: string): Promise<ComposioSetup>;
  deleteComposioSetup(): Promise<ComposioSetup>;
  listComposioCatalog(): Promise<ComposioPluginCatalog>;
  authorizeComposio(toolkit: string, label: string): Promise<ComposioPluginAuthorization>;
  refreshComposio(connectionId: string): Promise<McpConnection>;
  listComposioTools(connectionId: string): Promise<ComposioPluginTool[]>;
  updateComposioTools(connectionId: string, expectedRevision: number, allowedTools: string[]): Promise<McpConnection>;
  disconnectComposio(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }>;
  listGrants(projectId: string): Promise<ProjectMcpGrant[]>;
  putGrant(projectId: string, connectionId: string, enabled: boolean, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<ProjectMcpGrant>;
  deleteGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }>;
  discover(projectId: string, workspaceId: string | null, workspacePath: string): Promise<DiscoveredMcpTool[]>;
}
export interface BrowserRelayRpc {
  status(): Promise<BrowserRelayStatus>;
  setup(): Promise<BrowserRelayStatus>;
  start(): Promise<BrowserRelayStatus>;
  stop(): Promise<BrowserRelayStatus>;
  test(): Promise<BrowserRelayStatus>;
}
export interface ProjectCronsRpc {
  listProjectCrons(projectId: string): Promise<ProjectCronView[]>;
  createProjectCron(projectId: string, draft: ProjectCronDraft): Promise<ProjectCronView>;
  updateProjectCron(projectId: string, cronId: string, expectedRevision: number, draft: ProjectCronDraft): Promise<ProjectCronView>;
  deleteProjectCron(projectId: string, cronId: string, expectedRevision: number): Promise<{ projectId: string; cronId: string; deleted: boolean }>;
  runProjectCronNow(projectId: string, cronId: string): Promise<ProjectCronRunView>;
  projectCronHistory(projectId: string, cronId: string, limit?: number): Promise<ProjectCronRunView[]>;
}

export interface InspectorAuthorityRpc {
  bootstrapInspector(identity: InspectorIdentity): Promise<InspectorIdentity>;
  getInspectorOverview(identity: InspectorIdentity, context?: ReviewAnchorContext): Promise<InspectorOverview>;
  putInspectorGoal(input: PutGoalInput): Promise<GoalRecordView>;
  attachInspectorRequirementEvidence(input: AttachRequirementEvidenceInput): Promise<GoalRecordView>;
  putInspectorWorkflow(input: PutWorkflowInput): Promise<WorkflowView>;
  waiveInspectorWorkflowGate(input: WaiveWorkflowGateInput): Promise<WorkflowView>;
  putInspectorRubric(input: PutRubricInput): Promise<RubricView>;
  appendInspectorRubricJudgment(input: AppendRubricJudgmentInput): Promise<RubricView>;
  listInspectorJournal(identity: InspectorIdentity): Promise<JournalEntryView[]>;
  startInspectorJournalPhase(input: StartJournalPhaseInput): Promise<JournalEntryView>;
  endInspectorJournalPhase(input: EndJournalPhaseInput): Promise<JournalEntryView>;
  appendInspectorJournalEntry(input: AppendJournalEntryInput): Promise<JournalEntryView>;
  putInspectorChangeGuide(input: PutChangeGuideInput): Promise<ChangeGuideView>;
  markInspectorGuideSectionRead(input: MarkGuideSectionReadInput): Promise<ChangeGuideView>;
  setInspectorGuideApproval(input: SetGuideApprovalInput): Promise<ChangeGuideView>;
  listInspectorReviewThreads(identity: InspectorIdentity, context?: ReviewAnchorContext): Promise<ReviewThreadView[]>;
  createInspectorReviewThread(input: CreateReviewThreadInput, context?: ReviewAnchorContext): Promise<ReviewThreadView>;
  appendInspectorReviewMessage(input: AppendReviewMessageInput, context?: ReviewAnchorContext): Promise<ReviewThreadView>;
  resolveInspectorReviewThread(input: ResolveReviewThreadInput, context?: ReviewAnchorContext): Promise<ReviewThreadView>;
}
export interface WorkspaceServicesRpc {
  list(spaceId: string): Promise<ServiceView[]>;
  start(spaceId: string, serviceName: string): Promise<ServiceView>;
  stop(spaceId: string, serviceName: string): Promise<ServiceView>;
}

export interface SkillsRpc {
  listSkills(): Promise<SkillView[]>;
  updateSkill(input: SkillUpdate): Promise<SkillView>;
}

export interface ProjectLifecycleRpc {
  list(lifecycle: 'all' | 'active' | 'archived'): Promise<CloudProjectSummary[]>;
  createProject(input: { name: string; baseBranch: string | null; repositoryUrl: string | null }): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation }>;
  openProject(projectId: string): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation | null }>;
  createWorkspace(input: { projectId: string; name: string; branch: string; phase?: 'plan' | 'code' | 'review' | 'ship'; sourceKind: 'base' | 'branch' | 'workspace' | 'pull-request' | 'tag' | 'commit'; sourceRef: string; dependsOn?: readonly string[] }): Promise<{ workspace: { id: string }; operation: CloudProjectOperation }>;
  archiveWorkspace(input: ArchiveWorkspaceInput, close: (space: MaterializedSpace, expectedGeneration: number) => Promise<unknown>): Promise<CloudWorkspaceDefinition>;
  archiveProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary>;
  restoreProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary>;
  deleteProject(projectId: string, expectedRevision: number): Promise<boolean>;
  deleteWorkspace(projectId: string, workspaceId: string, expectedRevision?: number): Promise<boolean>;
  setWorkspaceLifecycle(projectId: string, workspaceId: string, lifecycle: 'active' | 'archived'): Promise<unknown>;
  setWorkspacePhase(projectId: string, workspaceId: string, phase: 'plan' | 'code' | 'review' | 'ship'): Promise<unknown>;
  runLifecycleOperation<T>(projectId: string, workspaceId: string | null, kind: string, labels: string[], action: () => Promise<T>): Promise<T>;
}
export interface ProjectEventsRpc {
  appendProjectEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }): Promise<ProjectEvent>;
  listProjectEvents(projectId: string, afterOffset: number): Promise<ProjectEvent[]>;
  latestProjectEventOffset(projectId: string): Promise<number>;
}




/** Self-development: the tenant's release state plus what this generation runs; mutations go through the launcher. */
export interface DeploymentRpc {
  status(): Promise<DeploymentStatus>;
  /** Starts the build and returns immediately; progress via `launchProgress()` and `deployment` events. */
  launch(input: { workspaceId: string; targets: ReleaseTarget[] }): LaunchProgress;
  launchProgress(): LaunchProgress | null;
  revert(): Promise<DeploymentStatus>;
  thisMachine: { sha: string | null; ompSha: string | null; ompDraining: number; generation: string | null };
}

export interface GitSpaceRpcRouterOptions {
  database: GitSpaceDatabase;
  factEvents: FactEventStore;
  handlers: GitSpaceHandlers;
  sessions: MachineSessionCoordinator;
  spaces: SpaceLifecycleController;
  terminals: WorkspaceHubTerminalCoordinator;
  environments?: WorkspaceEnvironmentManager;
  artifacts: LocalArtifactResolver;
  secrets: ProjectSecretsRpc;
  configuration?: Pick<CloudSpaceCheckpointAuthority, 'listAccountSecrets' | 'putAccountSecret' | 'deleteAccountSecret' | 'grantAccountSecret' | 'revokeAccountSecret' | 'getConfigurationValues' | 'putConfigurationValue' | 'deleteConfigurationValue'>;
  mcp?: MachineMcpRpc;
  crons?: ProjectCronsRpc;
  browserRelay?: BrowserRelayRpc;
  serviceManager: WorkspaceServicesRpc;
  inspector?: InspectorAuthorityRpc;
  resolveInspectorBaseCommit?(input: { projectId: string; baseSpaceId: string; baseBranch: string; repositoryPath: string }): Promise<string>;
  skills?: SkillsRpc;
  projectEvents: ProjectEventsRpc;
  projects: ProjectLifecycleRpc;
  machines(): Promise<FleetMachineRpcView[]>;
  spacePlacements(): Promise<Array<Omit<SpacePlacementView, 'endpoint'>>>;
  /** Cloud canonical sessions for a project, for locating sessions held elsewhere. */
  canonicalSessions?(projectId: string): Promise<Array<{ id: string; workspaceId: string; machineId: string | null }>>;
  /** Closed checkpoint identity without downloading or projecting its transcript. */
  checkpointMetadata?(projectId: string, spaceId: string): Promise<ClosedSpaceCheckpointMetadata | null>;
  /** Read-only transcript of a space closed in the cloud, from its checkpoint; null when it is not closed or has none. */
  checkpointTranscript?(projectId: string, spaceId: string): Promise<ClosedSpaceTranscript | null>;
  checkpointTranscriptPage?(projectId: string, spaceId: string, request: TranscriptPageRequest): Promise<TranscriptPage | null>;
  checkpointTranscriptContent?(projectId: string, spaceId: string, request: TranscriptContentRequest): Promise<TranscriptContentPage | null>;
  createSandbox?(): Promise<FleetMachineRpcView>;
  updateMachine?(machineId: string, notes: string): Promise<FleetMachineRpcView>;
  controlMachine?(action: 'sleep' | 'resume', machineId: string): Promise<FleetMachineRpcView>;
  destroyMachine?(machineId: string): Promise<{ machineId: string; removed: boolean }>;
  settings?: CanonicalSettingsCoordinator;
  providers?: ProviderAuthCoordinator;
  devices?: DeviceRegistry;
  deployment?: DeploymentRpc;
  gitIdentity?: SharedGitIdentityCoordinator;
  machineId: string;
  onInternalError?: (input: { incidentId: string; phase: string; cause: unknown; procedurePath?: string }) => void;
}

function sessionView(session: AgentSession, database: GitSpaceDatabase, sessions: MachineSessionCoordinator) {
  const space = database.getSpace(session.spaceId);
  if (!space) throw new Error(`Space ${session.spaceId} does not exist`);
  return {
    id: session.id,
    projectId: space.projectId,
    workspaceId: space.kind === 'worktree' ? space.id : null,
    scope: space.kind === 'worktree' ? 'workspace' as const : 'project' as const,
    ompSessionId: session.ompSessionId,
    state: session.state,
    controlsAvailable: sessions.controlsAvailable(session.id),
    lastEventOffset: session.lastEventOffset,
    resumePending: session.resumePending,
    createdAt: new Date(session.createdAt),
    activity: session.activity,
    renderState: determineAgentState(
      session.activity,
      session.state === 'closed' ? { closedAt: session.updatedAt } : {},
      currentAgentExecutionFailure(session.health),
    ),
    health: session.health,
    updatedAt: new Date(session.updatedAt),
  };
}

function lifecycleView(space: NonNullable<ReturnType<GitSpaceDatabase['getSpace']>>) {
  return {
    id: space.id,
    projectId: space.projectId,
    kind: space.kind,
    state: space.closedAt ? 'archived' as const : space.placementState === 'closed' ? 'closed' as const : 'active' as const,
    machineId: space.placementState === 'closed' || space.holderId === 'unassigned' ? null : space.holderId,
    generation: space.generation,
  };
}

function projectLifecycleView(project: CloudProjectSummary) {
  return {
    ...project,
    archivedAt: project.archivedAt ? new Date(project.archivedAt) : null,
    updatedAt: new Date(project.updatedAt),
  };
}

function mcpConnectionView(connection: McpConnection) {
  return {
    ...connection,
    statusCheckedAt: connection.statusCheckedAt ? new Date(connection.statusCheckedAt) : null,
    createdAt: new Date(connection.createdAt),
    updatedAt: new Date(connection.updatedAt),
  };
}

function composioSetupView(setup: ComposioSetup) {
  return { ...setup, updatedAt: setup.updatedAt ? new Date(setup.updatedAt) : null };
}

function projectMcpGrantView(grant: ProjectMcpGrant) {
  return {
    ...grant,
    createdAt: new Date(grant.createdAt),
    updatedAt: new Date(grant.updatedAt),
  };
}

function projectOperationView(operation: CloudProjectOperation) {
  return {
    id: operation.id,
    projectId: operation.projectId,
    workspaceId: operation.workspaceId,
    kind: operation.kind,
    state: operation.state,
    error: operation.error,
    revision: operation.revision,
    createdAt: new Date(operation.createdAt),
    updatedAt: new Date(operation.updatedAt),
  };
}

type InspectorSpaceResolution =
  | { status: 'missing'; spaceId: string }
  | { status: 'generation-conflict'; spaceId: string; expected: number; actual: number }
  | {
      status: 'ready';
      identity: InspectorIdentity;
      repository: InspectorRepositoryContext;
      baseSpaceId: string;
      baseBranch: string;
      usesProjectBase: boolean;
      space: NonNullable<ReturnType<GitSpaceDatabase['getSpace']>>;
    };

function resolveInspectorSpace(database: GitSpaceDatabase, spaceId: string, expectedGeneration: number, baseRef?: string | null): InspectorSpaceResolution {
  const space = database.getSpace(spaceId);
  if (!space) return { status: 'missing', spaceId };
  if (space.generation !== expectedGeneration) {
    return { status: 'generation-conflict', spaceId, expected: expectedGeneration, actual: space.generation };
  }
  const project = database.getProject(space.projectId);
  if (!project) return { status: 'missing', spaceId };
  const baseSpace = database.getBaseSpace(project.id);
  const projectBaseRef = `refs/heads/${project.baseBranch}`;
  const usesProjectBase = baseRef == null || baseRef === project.baseBranch || baseRef === projectBaseRef;
  return {
    status: 'ready',
    identity: { projectId: project.id, spaceId: space.id },
    repository: {
      repositoryPath: space.rootPath,
      baseRef: usesProjectBase ? projectBaseRef : baseRef,
      spaceId: space.id,
      generation: space.generation,
    },
    baseSpaceId: baseSpace?.id ?? project.id,
    baseBranch: project.baseBranch,
    usesProjectBase,
    space,
  };
}

type AuthorityFailure =
  | { kind: 'conflict'; resource: string; expected: number; actual: number }
  | { kind: 'state'; resource: string; message: string }
  | { kind: 'other'; message: string };

function authorityFailure(error: unknown): AuthorityFailure {
  if (error instanceof CloudSpaceAuthorityError && error.code === 'INSPECTOR_CONFLICT') {
    return {
      kind: 'conflict',
      resource: String(error.details.resource ?? 'inspector'),
      expected: Number(error.details.expected ?? -1),
      actual: Number(error.details.actual ?? -1),
    };
  }
  if (error instanceof CloudSpaceAuthorityError && error.code === 'INSPECTOR_STATE') {
    return { kind: 'state', resource: String(error.details.resource ?? 'inspector'), message: error.message };
  }
  return { kind: 'other', message: error instanceof Error ? error.message : 'Inspector authority request failed' };
}

function authorityFailureMessage(failure: AuthorityFailure): string {
  return failure.kind === 'conflict'
    ? `${failure.resource} revision ${failure.expected} conflicts with ${failure.actual}`
    : failure.message;
}

export function createGitSpaceRpcRouter(options: GitSpaceRpcRouterOptions) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const environment = (): WorkspaceEnvironmentManager => {
    if (!options.environments) throw new Error('Shared workspace lifecycle authority is unavailable');
    return options.environments;
  };
  const environmentOutput = (view: WorkspaceEnvironmentView) => ({
    spaceId: view.spaceId,
    projectId: view.projectId,
    bundleJson: JSON.stringify(view.bundle),
    selectedProfile: view.selectedProfile,
    effective: view.effective,
    configuredSecrets: view.configuredSecrets,
    secretMetadata: view.secretMetadata,
    values: view.values,
    executions: view.executions.map((execution) => ({
      ...execution,
      phase: execution.phase ?? null,
      fileName: execution.fileName ?? null,
    })),
    runs: view.runs,
    lifecycle: view.lifecycle,
  });
  const settingsCoordinator = (): CanonicalSettingsCoordinator => {
    if (!options.settings) throw new Error('Canonical settings are unavailable');
    return options.settings;
  };
  const providersCoordinator = (): ProviderAuthCoordinator => {
    if (!options.providers) throw new Error('Provider sign-in is unavailable');
    return options.providers;
  };
  const cronsAuthority = (): ProjectCronsRpc => {
    if (!options.crons) throw new Error('Project cron authority is unavailable');
    return options.crons;
  };
  const inspectorAuthority = (): InspectorAuthorityRpc => {
    if (!options.inspector) throw new Error('Inspector authority is unavailable');
    return options.inspector;
  };
  const inspectorRepository = async (
    resolved: Extract<InspectorSpaceResolution, { status: 'ready' }>,
    mode: InspectorRepositoryRead['mode'],
  ): Promise<InspectorRepositoryRead> => {
    if (mode !== 'base' || !resolved.usesProjectBase) return { ...resolved.repository, mode };
    if (!options.resolveInspectorBaseCommit) throw new Error('Base comparison is unavailable: checkpoint resolution is not configured');
    const baseRef = await options.resolveInspectorBaseCommit({
      projectId: resolved.identity.projectId,
      baseSpaceId: resolved.baseSpaceId,
      baseBranch: resolved.baseBranch,
      repositoryPath: resolved.repository.repositoryPath,
    });
    const current = options.database.getSpace(resolved.space.id);
    if (!current || current.generation !== resolved.space.generation || current.rootPath !== resolved.space.rootPath
      || current.placementState !== 'open' || current.holderId !== options.machineId) {
      throw new Error('Workspace placement changed while resolving the comparison base; reload the Inspector');
    }
    return { ...resolved.repository, mode, baseRef };
  };
  const mcpAuthority = (): MachineMcpRpc => {
    if (!options.mcp) throw new Error('MCP authority is unavailable');
    return options.mcp;
  };

  const bootstrap = server.implement(bootstrapContract).handler(async ({ input, errors }) => {
    const project = options.database.getProject(input.projectId);
    if (!project) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    const selected = input.workspaceId === null
      ? options.database.getBaseSpace(project.id)
      : options.database.getWorkspace(input.workspaceId);
    if (!selected || selected.projectId !== project.id) {
      return input.workspaceId === null
        ? err(errors.OperationFailed({ operation: 'load base space', message: 'Unable to load base space' }))
        : err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    }
    // Capture the local log boundary before projection or asynchronous checkpoint reads.
    const eventOffset = options.factEvents.latestOffset(input.projectId);
    const projection = options.handlers.bootstrap(input);
    if (projection.status === 'error') return projection;
    const space = options.database.getSpace(selected.id);
    let checkpoint: ClosedSpaceCheckpointMetadata | null = null;
    if (space?.placementState === 'closed' && options.checkpointMetadata) {
      try {
        checkpoint = await options.checkpointMetadata(space.projectId, space.id);
      } catch (error) {
        if (error instanceof WorkspaceDomainError) return err(errors.WorkspaceFailure(error.toJSON()));
        return err(errors.OperationFailed({ operation: 'read checkpoint metadata', message: error instanceof Error ? error.message : 'Unable to read the space checkpoint' }));
      }
    }
    const session = space?.placementState === 'closed' ? null : options.sessions.list(selected.id)[0];
    return ok({
      ...projection.value,
      mainAgent: session ? sessionView(session, options.database, options.sessions) : null,
      eventOffset,
      checkpoint,
    });
  });
  const transcript = server.implement(transcriptContract).stream(async function* ({ input, errors, signal }) {
    const project = options.database.getProject(input.projectId);
    if (!project) {
      yield err(errors.ProjectNotFound({ projectId: input.projectId }));
      return;
    }
    const space = input.workspaceId === null
      ? options.database.getBaseSpace(project.id)
      : options.database.getWorkspace(input.workspaceId);
    if (!space || space.projectId !== project.id) {
      yield input.workspaceId === null
        ? err(errors.OperationFailed({ operation: 'load base space', message: 'Unable to load base space' }))
        : err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
      return;
    }
    try {
      // Capture one complete snapshot before yielding. Closed spaces never fall
      // back to a stale local session or open a worker to read their history.
      const checkpoint = space.placementState === 'closed'
        ? await options.checkpointTranscript?.(project.id, space.id)
        : null;
      const session = space.placementState === 'closed' ? null : options.sessions.list(space.id)[0];
      const sessionId = checkpoint?.sessionId ?? session?.id;
      if (!sessionId) return;
      const snapshot = checkpoint ? checkpoint.events : await options.sessions.transcript(sessionId);
      for (const event of snapshot) {
        for (const chunk of encodeTranscriptEventChunks({ ...event, sessionId, createdAt: new Date(event.createdAt) })) {
          if (signal.aborted) return;
          yield ok(chunk);
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceDomainError) {
        yield err(errors.WorkspaceFailure(error.toJSON()));
        return;
      }
      yield err(errors.OperationFailed({ operation: 'read transcript', message: error instanceof Error ? error.message : 'Unable to read transcript' }));
    }
  });
  const transcriptPage = server.implement(transcriptPageContract).handler(async ({ input, errors }) => {
    const project = options.database.getProject(input.projectId);
    if (!project) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    const space = input.workspaceId === null ? options.database.getBaseSpace(project.id) : options.database.getWorkspace(input.workspaceId);
    if (!space || space.projectId !== project.id) {
      return input.workspaceId === null
        ? err(errors.OperationFailed({ operation: 'load base space', message: 'Unable to load base space' }))
        : err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    }
    try {
      if (space.placementState === 'closed') {
        if (!options.checkpointTranscriptPage) throw new Error('Checkpoint transcript paging is unavailable');
        const page = await options.checkpointTranscriptPage(project.id, space.id, input);
        return ok(page ?? { generation: `empty:${space.id}:${space.generation}`, revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 });
      }
      const session = options.sessions.list(space.id)[0];
      return ok(session
        ? await options.sessions.transcriptPage(session.id, input)
        : { generation: `empty:${space.id}:${space.generation}`, revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 });
    } catch (error) {
      if (error instanceof WorkspaceDomainError) return err(errors.WorkspaceFailure(error.toJSON()));
      return err(errors.OperationFailed({ operation: 'read transcript page', message: error instanceof Error ? error.message : 'Unable to read transcript page' }));
    }
  });
  const transcriptContent = server.implement(transcriptContentContract).handler(async ({ input, errors }) => {
    const project = options.database.getProject(input.projectId);
    if (!project) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    const space = input.workspaceId === null ? options.database.getBaseSpace(project.id) : options.database.getWorkspace(input.workspaceId);
    if (!space || space.projectId !== project.id) {
      return input.workspaceId === null
        ? err(errors.OperationFailed({ operation: 'load base space', message: 'Unable to load base space' }))
        : err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    }
    try {
      if (space.placementState === 'closed') {
        const content = await options.checkpointTranscriptContent?.(project.id, space.id, input);
        if (!content) throw new Error('Checkpoint transcript content is unavailable');
        return ok(content);
      }
      const session = options.sessions.list(space.id)[0];
      if (!session) throw new Error('Transcript session is unavailable');
      return ok(await options.sessions.transcriptContent(session.id, input));
    } catch (error) {
      if (error instanceof WorkspaceDomainError) return err(errors.WorkspaceFailure(error.toJSON()));
      return err(errors.OperationFailed({ operation: 'read transcript content', message: error instanceof Error ? error.message : 'Unable to read transcript content' }));
    }
  });
  const listProjects = server.implement(listProjectsContract).handler(async ({ input, errors }) => {
    try {
      return ok((await options.projects.list(input.lifecycle)).map(projectLifecycleView));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list projects', message: error instanceof Error ? error.message : 'Unable to list projects' }));
    }
  });
  const listMcpConnections = server.implement(listMcpConnectionsContract).handler(async ({ errors }) => {
    try {
      return ok((await mcpAuthority().listConnections()).map(mcpConnectionView));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list MCP connections', message: error instanceof Error ? error.message : 'Unable to list MCP connections' }));
    }
  });
  const createMcpConnection = server.implement(createMcpConnectionContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await mcpAuthority().createConnection(input.connection as McpConnectionDraft)));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_INVALID') {
        return err(errors.McpInvalid({ field: String(error.details.field ?? 'connection'), message: error.message }));
      }
      return err(errors.OperationFailed({ operation: 'create MCP connection', message: error instanceof Error ? error.message : 'Unable to create MCP connection' }));
    }
  });
  const updateMcpConnection = server.implement(updateMcpConnectionContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await mcpAuthority().updateConnection(input.connectionId, input.expectedRevision, input.connection as McpConnectionDraft)));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_CONFLICT') {
        return err(errors.McpRevisionConflict({ resource: String(error.details.resource ?? `connection:${input.connectionId}`), expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_INVALID') {
        return err(errors.McpInvalid({ field: String(error.details.field ?? 'connection'), message: error.message }));
      }
      return err(errors.OperationFailed({ operation: 'update MCP connection', message: error instanceof Error ? error.message : 'Unable to update MCP connection' }));
    }
  });
  const deleteMcpConnection = server.implement(deleteMcpConnectionContract).handler(async ({ input, errors }) => {
    try {
      return ok(await mcpAuthority().deleteConnection(input.connectionId, input.expectedRevision));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_CONFLICT') {
        return err(errors.McpRevisionConflict({ resource: String(error.details.resource ?? `connection:${input.connectionId}`), expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      return err(errors.OperationFailed({ operation: 'delete MCP connection', message: error instanceof Error ? error.message : 'Unable to delete MCP connection' }));
    }
  });
  const getMcpConnectionStatus = server.implement(getMcpConnectionStatusContract).handler(async ({ input, errors }) => {
    try {
      const connection = await mcpAuthority().connectionStatus(input.connectionId);
      return connection
        ? ok(mcpConnectionView(connection))
        : err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read MCP connection status', message: error instanceof Error ? error.message : 'Unable to read MCP connection status' }));
    }
  });
  const getComposioSetup = server.implement(getComposioSetupContract).handler(async ({ errors }) => {
    try {
      return ok(composioSetupView(await mcpAuthority().getComposioSetup()));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Composio setup', message: error instanceof Error ? error.message : 'Unable to read Composio setup' }));
    }
  });
  const putComposioSetup = server.implement(putComposioSetupContract).handler(async ({ input, errors }) => {
    try {
      return ok(composioSetupView(await mcpAuthority().putComposioSetup(input.apiKey)));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'configure Composio', message: error instanceof Error ? error.message : 'Unable to configure Composio' }));
    }
  });
  const deleteComposioSetup = server.implement(deleteComposioSetupContract).handler(async ({ errors }) => {
    try {
      return ok(composioSetupView(await mcpAuthority().deleteComposioSetup()));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'remove Composio setup', message: error instanceof Error ? error.message : 'Unable to remove Composio setup' }));
    }
  });
  const listComposioPluginCatalog = server.implement(listComposioPluginCatalogContract).handler(async ({ errors }) => {
    try {
      return ok(await mcpAuthority().listComposioCatalog());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list Composio plugins', message: error instanceof Error ? error.message : 'Unable to list Composio plugins' }));
    }
  });
  const authorizeComposioPlugin = server.implement(authorizeComposioPluginContract).handler(async ({ input, errors }) => {
    try {
      const authorization = await mcpAuthority().authorizeComposio(input.toolkit, input.label);
      return ok({ ...authorization, connection: mcpConnectionView(authorization.connection) });
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_INVALID') {
        return err(errors.McpInvalid({ field: String(error.details.field ?? 'toolkit'), message: error.message }));
      }
      return err(errors.OperationFailed({ operation: 'authorize Composio plugin', message: error instanceof Error ? error.message : 'Unable to authorize Composio plugin' }));
    }
  });
  const refreshComposioPlugin = server.implement(refreshComposioPluginContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await mcpAuthority().refreshComposio(input.connectionId)));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      return err(errors.OperationFailed({ operation: 'refresh Composio plugin', message: error instanceof Error ? error.message : 'Unable to refresh Composio plugin' }));
    }
  });
  const listComposioPluginTools = server.implement(listComposioPluginToolsContract).handler(async ({ input, errors }) => {
    try {
      return ok(await mcpAuthority().listComposioTools(input.connectionId));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      return err(errors.OperationFailed({ operation: 'list Composio plugin tools', message: error instanceof Error ? error.message : 'Unable to list Composio plugin tools' }));
    }
  });
  const updateComposioPluginTools = server.implement(updateComposioPluginToolsContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await mcpAuthority().updateComposioTools(input.connectionId, input.expectedRevision, [...input.allowedTools])));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_CONFLICT') {
        return err(errors.McpRevisionConflict({ resource: String(error.details.resource ?? `connection:${input.connectionId}`), expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_INVALID') {
        return err(errors.McpInvalid({ field: String(error.details.field ?? 'allowedTools'), message: error.message }));
      }
      return err(errors.OperationFailed({ operation: 'update Composio plugin tools', message: error instanceof Error ? error.message : 'Unable to update Composio plugin tools' }));
    }
  });
  const disconnectComposioPlugin = server.implement(disconnectComposioPluginContract).handler(async ({ input, errors }) => {
    try {
      return ok(await mcpAuthority().disconnectComposio(input.connectionId, input.expectedRevision));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_CONFLICT') {
        return err(errors.McpRevisionConflict({ resource: String(error.details.resource ?? `connection:${input.connectionId}`), expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      return err(errors.OperationFailed({ operation: 'disconnect Composio plugin', message: error instanceof Error ? error.message : 'Unable to disconnect Composio plugin' }));
    }
  });
  const getBrowserRelayStatus = server.implement(getBrowserRelayStatusContract).handler(async ({ errors }) => {
    if (!options.browserRelay) return err(errors.OperationFailed({ operation: 'read Browser Relay status', message: 'Browser Relay is unavailable' }));
    try {
      return ok(await options.browserRelay.status());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Browser Relay status', message: error instanceof Error ? error.message : 'Unable to read Browser Relay status' }));
    }
  });
  const setupBrowserRelay = server.implement(setupBrowserRelayContract).handler(async ({ errors }) => {
    if (!options.browserRelay) return err(errors.OperationFailed({ operation: 'set up Browser Relay', message: 'Browser Relay is unavailable' }));
    try {
      return ok(await options.browserRelay.setup());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'set up Browser Relay', message: error instanceof Error ? error.message : 'Unable to set up Browser Relay' }));
    }
  });
  const startBrowserRelay = server.implement(startBrowserRelayContract).handler(async ({ errors }) => {
    if (!options.browserRelay) return err(errors.OperationFailed({ operation: 'start Browser Relay', message: 'Browser Relay is unavailable' }));
    try {
      return ok(await options.browserRelay.start());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'start Browser Relay', message: error instanceof Error ? error.message : 'Unable to start Browser Relay' }));
    }
  });
  const stopBrowserRelay = server.implement(stopBrowserRelayContract).handler(async ({ errors }) => {
    if (!options.browserRelay) return err(errors.OperationFailed({ operation: 'stop Browser Relay', message: 'Browser Relay is unavailable' }));
    try {
      return ok(await options.browserRelay.stop());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'stop Browser Relay', message: error instanceof Error ? error.message : 'Unable to stop Browser Relay' }));
    }
  });
  const testBrowserRelay = server.implement(testBrowserRelayContract).handler(async ({ errors }) => {
    if (!options.browserRelay) return err(errors.OperationFailed({ operation: 'test Browser Relay', message: 'Browser Relay is unavailable' }));
    try {
      return ok(await options.browserRelay.test());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'test Browser Relay', message: error instanceof Error ? error.message : 'Unable to test Browser Relay' }));
    }
  });
  const listProjectMcpGrants = server.implement(listProjectMcpGrantsContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok((await mcpAuthority().listGrants(input.projectId)).map(projectMcpGrantView));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list project MCP grants', message: error instanceof Error ? error.message : 'Unable to list project MCP grants' }));
    }
  });
  const putProjectMcpGrant = server.implement(putProjectMcpGrantContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(projectMcpGrantView(await mcpAuthority().putGrant(input.projectId, input.connectionId, input.enabled, input.projectSpaceEnabled, input.workspacesEnabled, input.expectedRevision)));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_CONNECTION_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'connection', id: input.connectionId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_GRANT_CONFLICT') {
        return err(errors.McpRevisionConflict({ resource: String(error.details.resource ?? `grant:${input.connectionId}`), expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      return err(errors.OperationFailed({ operation: 'put project MCP grant', message: error instanceof Error ? error.message : 'Unable to put project MCP grant' }));
    }
  });
  const deleteProjectMcpGrant = server.implement(deleteProjectMcpGrantContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await mcpAuthority().deleteGrant(input.projectId, input.connectionId, input.expectedRevision));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_GRANT_NOT_FOUND') {
        return err(errors.McpNotFound({ resource: 'grant', id: input.connectionId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'MCP_GRANT_CONFLICT') {
        return err(errors.McpRevisionConflict({ resource: String(error.details.resource ?? `grant:${input.connectionId}`), expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      return err(errors.OperationFailed({ operation: 'delete project MCP grant', message: error instanceof Error ? error.message : 'Unable to delete project MCP grant' }));
    }
  });
  const discoverProjectMcpTools = server.implement(discoverProjectMcpToolsContract).handler(async ({ input, errors }) => {
    const project = options.database.getProject(input.projectId);
    const base = options.database.getSpace(input.projectId);
    if (!project || !base) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await mcpAuthority().discover(input.projectId, null, base.rootPath));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'discover project MCP tools', message: error instanceof Error ? error.message : 'Unable to discover project MCP tools' }));
    }
  });
  const createProject = server.implement(createProjectContract).handler(async ({ input, errors }) => {
    try {
      const created = await options.projects.createProject(input);
      const session = await options.sessions.createProject(created.project.id);
      if (session.status === 'error') throw session.error;
      return ok({ project: projectLifecycleView(created.project), operation: projectOperationView(created.operation) });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'create project', message: error instanceof Error ? error.message : 'Unable to create project' }));
    }
  });
  const openProject = server.implement(openProjectContract).handler(async ({ input, errors }) => {
    try {
      const opened = await options.projects.openProject(input.projectId);
      return ok({ project: projectLifecycleView(opened.project), operation: opened.operation ? projectOperationView(opened.operation) : null });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'open project', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const archiveProject = server.implement(archiveProjectContract).handler(async ({ input, errors }) => {
    try {
      const current = await options.projects.list('all');
      if (!current.some((project) => project.id === input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return ok(projectLifecycleView(await options.projects.archiveProject(input.projectId, input.expectedRevision)));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'archive project', message: error instanceof Error ? error.message : 'Unable to archive project' }));
    }
  });
  const restoreProject = server.implement(restoreProjectContract).handler(async ({ input, errors }) => {
    try {
      const current = await options.projects.list('all');
      if (!current.some((project) => project.id === input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return ok(projectLifecycleView(await options.projects.restoreProject(input.projectId, input.expectedRevision)));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'restore project', message: error instanceof Error ? error.message : 'Unable to restore project' }));
    }
  });
  const deleteProject = server.implement(deleteProjectContract).handler(async ({ input, errors }) => {
    try {
      const session = options.sessions.list(input.projectId)[0];
      if (session && session.state !== 'closed') {
        const closed = await options.sessions.close(session.id);
        if (closed.status === 'error') throw closed.error;
      }
      const deleted = await options.projects.deleteProject(input.projectId, input.expectedRevision);
      if (!deleted) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return ok({ projectId: input.projectId, deleted: true });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'delete project', message: error instanceof Error ? error.message : 'Unable to delete project' }));
    }
  });
  const createWorkspace = server.implement(createWorkspaceContract).handler(async ({ input, errors }) => {
    try {
      if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      const created = await options.projects.createWorkspace(input);
      const session = await options.sessions.create(created.workspace.id);
      if (session.status === 'error') throw session.error;
      const projection = options.handlers.bootstrap({ projectId: input.projectId, workspaceId: created.workspace.id });
      if (projection.status === 'error') return err(errors.OperationFailed({ operation: 'project workspace', message: projection.error.message }));
      const workspace = projection.value.workspaces.find((candidate) => candidate.id === created.workspace.id);
      if (!workspace) return err(errors.OperationFailed({ operation: 'project workspace', message: 'Workspace projection is missing' }));
      return ok({ workspace, operation: projectOperationView(created.operation) });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'create workspace', message: error instanceof Error ? error.message : 'Unable to create workspace' }));
    }
  });
  const deleteWorkspace = server.implement(deleteWorkspaceContract).handler(async ({ input, errors }) => {
    const workspace = options.database.getWorkspace(input.workspaceId);
    if (!workspace) return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    try {
      return ok({ workspaceId: input.workspaceId, deleted: await options.projects.deleteWorkspace(workspace.projectId, input.workspaceId) });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'delete workspace', message: error instanceof Error ? error.message : 'Unable to delete workspace' }));
    }
  });
  const machines = server.implement(listMachinesContract).handler(async ({ errors }) => {
    try {
      return ok(await options.machines());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list machines', message: error instanceof Error ? error.message : 'Unable to list machines' }));
    }
  });
  const closeSpace = server.implement(closeSpaceContract).handler(async ({ input, errors }) => {
    const space = options.database.getSpace(input.spaceId);
    if (!space) return err(errors.OperationFailed({ operation: 'close space', message: `Space ${input.spaceId} does not exist` }));
    if (space.placementState === 'closed') return ok(lifecycleView(space));
    if (space.holderId !== options.machineId || space.generation !== input.expectedGeneration) {
      return err(errors.OperationFailed({ operation: 'close space', message: 'Space placement changed before close' }));
    }
    try {
      await options.spaces.close(space, input.expectedGeneration);
      const closed = options.database.getSpace(space.id);
      if (!closed) throw new Error(`Space ${space.id} disappeared after close`);
      return ok(lifecycleView(closed));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'close space', message: error instanceof Error ? error.message : 'Unable to close space' }));
    }
  });
  const reopenSpace = server.implement(reopenSpaceContract).handler(async ({ input, errors }) => {
    const space = options.database.getSpace(input.spaceId);
    if (space?.closedAt) return err(errors.OperationFailed({ operation: 'reopen space', message: 'Archived spaces must be restored before they can reopen' }));
    if (space && space.placementState !== 'closed') {
      if (space.placementState !== 'open' || space.holderId !== options.machineId || space.generation !== input.expectedGeneration) {
        return err(errors.OperationFailed({ operation: 'reopen space', message: 'Space placement is transitioning or active on another machine' }));
      }
      const resumed = await options.sessions.openSpace(space.id, false, input.expectedGeneration);
      return resumed.status === 'ok'
        ? ok(lifecycleView(space))
        : err(errors.OperationFailed({ operation: 'reopen space', message: resumed.error.message }));
    }
    try {
      await options.spaces.open(input.spaceId, input.expectedGeneration);
      const opened = options.database.getSpace(input.spaceId);
      if (!opened) throw new Error(`Space ${input.spaceId} disappeared after reopen`);
      return ok(lifecycleView(opened));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'reopen space', message: error instanceof Error ? error.message : 'Unable to reopen space' }));
    }
  });

  const archiveWorkspace = server.implement(archiveWorkspaceContract).handler(async ({ input, errors }) => {
    try {
      const value = await options.projects.archiveWorkspace(input, (space, expectedGeneration) => options.spaces.close(space, expectedGeneration));
      return ok(value);
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'archive workspace', message: error instanceof Error ? error.message : 'Unable to archive workspace' }));
    }
  });
  const restoreWorkspace = server.implement(restoreWorkspaceContract).handler(async ({ input, errors }) => {
    const space = options.database.getSpace(input.spaceId);
    if (!space) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
    if (space.placementState !== 'closed' && space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'restore workspace', message: 'Space is active on another machine' }));
    }
    if (space.placementState === 'closed' && space.generation !== input.expectedGeneration) {
      return err(errors.OperationFailed({ operation: 'restore workspace', message: 'Space placement changed before restore' }));
    }
    try {
      const value = await options.projects.runLifecycleOperation(space.projectId, input.spaceId, 'workspace.restore', ['Restore workspace', 'Start canonical agent'], async () => {
        if (space.placementState !== 'closed') {
          const session = await options.sessions.openSpace(space.id);
          if (session.status === 'error') throw session.error;
          options.database.setSpaceClosed(space.id, false);
        } else {
          await options.spaces.open(input.spaceId, input.expectedGeneration);
        }
        const opened = options.database.getSpace(input.spaceId);
        if (!opened) throw new Error(`Workspace ${input.spaceId} is unavailable after restore`);
        await options.projects.setWorkspaceLifecycle(opened.projectId, opened.id, 'active');
        return lifecycleView(opened);
      });
      return ok(value);
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'restore workspace', message: error instanceof Error ? error.message : 'Unable to restore workspace' }));
    }
  });


  const createProjectSession = server.implement(createProjectSessionContract).handler(async ({ input, errors }) => {
    const created = await options.sessions.createProject(input.projectId);
    if (created.status === 'ok') return ok(sessionView(created.value, options.database, options.sessions));
    if (created.error instanceof SessionProjectUnavailable) {
      return err(errors.ProjectNotFound({ projectId: input.projectId }));
    }
    return err(errors.AgentFailure(agentFailure(created.error, 'AGENT_RUNTIME_FAILED', { operation: 'create project session', projectId: input.projectId })));
  });
  const createSession = server.implement(createSessionContract).handler(async ({ input, errors }) => {
    const created = await options.sessions.create(input.workspaceId);
    if (created.status === 'ok') return ok(sessionView(created.value, options.database, options.sessions));
    if (created.error instanceof SessionWorkspaceUnavailable) {
      return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    }
    return err(errors.AgentFailure(agentFailure(created.error, 'AGENT_RUNTIME_FAILED', { operation: 'create session', workspaceId: input.workspaceId })));
  });

  const subagentTranscript = server.implement(subagentTranscriptContract).stream(async function* ({ input, errors, signal }) {
    if (!options.sessions.get(input.sessionId)) {
      yield err(errors.SessionNotFound({ sessionId: input.sessionId }));
      return;
    }
    try {
      const snapshot = await options.sessions.subagentTranscript(input.sessionId, input.subagentId);
      for (const event of snapshot) {
        for (const chunk of encodeTranscriptEventChunks({ ...event, sessionId: input.subagentId, createdAt: new Date(event.createdAt) })) {
          if (signal.aborted) return;
          yield ok(chunk);
        }
      }
    } catch (error) {
      yield err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'read subagent transcript', sessionId: input.sessionId })));
    }
  });
  const subagentPage = server.implement(subagentTranscriptPageContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(await options.sessions.subagentTranscriptPage(input.sessionId, input.subagentId, input)); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'read subagent transcript page', sessionId: input.sessionId }))); }
  });
  const subagentContent = server.implement(subagentTranscriptContentContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(await options.sessions.subagentTranscriptContent(input.sessionId, input.subagentId, input)); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'read subagent transcript content', sessionId: input.sessionId }))); }
  });
  const subagentEvents = server.implement(subagentTranscriptEventsContract).stream(async function* ({ input, errors, signal }) {
    if (!options.sessions.get(input.sessionId)) {
      yield err(errors.SessionNotFound({ sessionId: input.sessionId }));
      return;
    }
    try {
      for await (const event of options.sessions.streamSubagentTranscript(input.sessionId, input.subagentId, input.afterOrdinal, signal)) {
        for (const chunk of encodeTranscriptEventChunks({ ...event, sessionId: input.subagentId, createdAt: new Date(event.createdAt) })) {
          if (signal.aborted) return;
          yield ok(chunk);
        }
      }
    } catch (error) {
      yield err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'stream subagent transcript', sessionId: input.sessionId })));
    }
  });

  const updateMachineNotes = server.implement(updateMachineNotesContract).handler(async ({ input, errors }) => {
    if (!options.updateMachine) return err(errors.OperationFailed({ operation: 'update machine notes', message: 'Machine updates are unavailable' }));
    try {
      return ok(await options.updateMachine(input.machineId, input.notes));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'update machine notes', message: error instanceof Error ? error.message : 'Unable to update machine notes' }));
    }
  });

  const createSandbox = server.implement(createSandboxMachineContract).handler(async ({ errors }) => {
    if (!options.createSandbox) return err(errors.OperationFailed({ operation: 'create sandbox', message: 'Sandbox provisioning is unavailable' }));
    try {
      return ok(await options.createSandbox());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'create sandbox', message: error instanceof Error ? error.message : 'Unable to create sandbox' }));
    }
  });


  const sleepMachine = server.implement(sleepMachineContract).handler(async ({ input, errors }) => {
    if (!options.controlMachine) return err(errors.OperationFailed({ operation: 'sleep machine', message: 'Machine lifecycle is unavailable' }));
    try { return ok(await options.controlMachine('sleep', input.machineId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'sleep machine', message: error instanceof Error ? error.message : 'Unable to sleep machine' })); }
  });
  const resumeMachine = server.implement(resumeMachineContract).handler(async ({ input, errors }) => {
    if (!options.controlMachine) return err(errors.OperationFailed({ operation: 'resume machine', message: 'Machine lifecycle is unavailable' }));
    try { return ok(await options.controlMachine('resume', input.machineId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'resume machine', message: error instanceof Error ? error.message : 'Unable to resume machine' })); }
  });
  const destroyMachine = server.implement(destroyMachineContract).handler(async ({ input, errors }) => {
    if (!options.destroyMachine) return err(errors.OperationFailed({ operation: 'destroy machine', message: 'Machine lifecycle is unavailable' }));
    try { return ok(await options.destroyMachine(input.machineId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'destroy machine', message: error instanceof Error ? error.message : 'Unable to destroy machine' })); }
  });

  const promptSession = server.implement(promptSessionContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) {
      return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    }
    const prompted = await options.sessions.prompt(input.sessionId, input.text, { streamingBehavior: input.streamingBehavior, images: input.images.map((image) => ({ type: 'image' as const, ...image })) });
    if (prompted.status === 'error') {
      return err(errors.AgentFailure(agentFailure(prompted.error, 'AGENT_RUNTIME_FAILED', { operation: 'prompt session', sessionId: input.sessionId })));
    }
    return prompted.value
      ? ok({ accepted: true })
      : err(errors.SessionBusy({ sessionId: input.sessionId }));
  });

  const getSessionControl = server.implement(getSessionControlContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.control(input.sessionId))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'read session controls', sessionId: input.sessionId }))); }
  });
  const sessionHistory = server.implement(sessionHistoryPageContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(await options.sessions.historyPage(input.sessionId, input)); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_HISTORY_UNAVAILABLE', { operation: 'read session history', sessionId: input.sessionId }))); }
  });
  const getSessionUsage = server.implement(getSessionUsageContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try {
      const report = await options.sessions.sessionUsage(input.sessionId);
      // No transcript on disk yet: the session exists but has spent nothing.
      return ok(report ?? { sessionId: input.sessionId, totals: emptyTotals(), totalsDeep: emptyTotals(), childSessions: 0, byModel: [], byRole: [], byAgent: [], byCompletion: [], warnings: [] });
    } catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'read session usage', sessionId: input.sessionId }))); }
  });
  const getSessionAgents = server.implement(getSessionAgentsContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(await options.sessions.agentSetup(input.sessionId)); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'read agent setup', sessionId: input.sessionId }))); }
  });
  const saveSessionAgent = server.implement(saveSessionAgentContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(await options.sessions.saveAgentDefinition(input.sessionId, { path: input.path, expectedRevision: input.expectedRevision, content: input.content })); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'save agent definition', sessionId: input.sessionId }))); }
  });
  const cycleSessionRole = server.implement(cycleSessionRoleContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.cycleRole(input.sessionId, input.direction))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'cycle session role', sessionId: input.sessionId }))); }
  });
  const setSessionThinking = server.implement(setSessionThinkingContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.setThinking(input.sessionId, input.thinking))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'set session thinking', sessionId: input.sessionId }))); }
  });
  const setSessionFast = server.implement(setSessionFastContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.setFast(input.sessionId, input.enabled))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'set Fast mode', sessionId: input.sessionId }))); }
  });
  const setSessionModel = server.implement(setSessionModelContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.setModel(input.sessionId, input.provider, input.model))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'set session model', sessionId: input.sessionId }))); }
  });
  const setSessionApproval = server.implement(setSessionApprovalContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.setApproval(input.sessionId, input.approvalMode))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'set session approval', sessionId: input.sessionId }))); }
  });
  const setSessionGoal = server.implement(setSessionGoalContract).handler(async ({ input, errors }) => {
    const session = options.sessions.get(input.sessionId);
    if (!session) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try {
      if (!input.enabled) return ok(boundSessionControl(await options.sessions.setGoal(input.sessionId, { enabled: false })));
      const space = options.database.getSpace(session.spaceId);
      if (!space) throw new Error('Goal session space does not exist');
      const identity = { projectId: space.projectId, spaceId: space.id };
      await inspectorAuthority().bootstrapInspector(identity);
      const overview = await inspectorAuthority().getInspectorOverview(identity);
      if (!overview.goal) throw new Error('GitSpace Goal is not configured for this workspace');
      const workflow = overview.workflow;
      const objective = [
        `GitSpace Goal ${overview.goal.id}: ${overview.goal.title}`,
        overview.goal.summary,
        `Current phase: ${space.phase ?? overview.goal.phase}.`,
        `Requirements:\n${overview.goal.requirements.map((requirement) => `- ${requirement.title} — ${requirement.status}`).join('\n')}`,
        workflow ? `Workflow ${workflow.title}:\n${workflow.nodes.map((node) => `- ${node.label} — ${node.kind === 'gate' ? node.satisfied ? 'satisfied' : node.passable ? 'passable' : 'blocked' : node.status}`).join('\n')}` : '',
        'Use the GitSpace Goal, Workflow, Journal, Rubric, and evidence tools whenever this typed authority may have changed.',
        input.objective?.trim() ?? '',
      ].filter(Boolean).join('\n\n');
      return ok(boundSessionControl(await options.sessions.setGoal(input.sessionId, { enabled: true, objective })));
    } catch (error) {
      return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'set GitSpace Goal mode', sessionId: input.sessionId })));
    }
  });
  const compactSession = server.implement(compactSessionContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.compact(input.sessionId, input.instructions ?? undefined))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'compact session', sessionId: input.sessionId }))); }
  });
  const clearSessionQueue = server.implement(clearSessionQueueContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.clearQueue(input.sessionId))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'clear session queue', sessionId: input.sessionId }))); }
  });
  const removeSessionQueuedMessage = server.implement(removeSessionQueuedMessageContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.removeQueuedMessage(input.sessionId, input.kind, input.index))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'remove queued message', sessionId: input.sessionId }))); }
  });
  const promoteSessionQueuedMessage = server.implement(promoteSessionQueuedMessageContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.promoteQueuedMessage(input.sessionId, input.index))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'steer queued message', sessionId: input.sessionId }))); }
  });
  const answerSessionAsk = server.implement(answerSessionAskContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.answerAsk(input.sessionId, input.id, input.answers))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'answer ask request', sessionId: input.sessionId }))); }
  });
  const stopSessionTurn = server.implement(stopSessionTurnContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.stop(input.sessionId))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'stop session turn', sessionId: input.sessionId }))); }
  });
  const setWorkspacePhase = server.implement(setWorkspacePhaseContract).handler(async ({ input, errors }) => {
    const current = options.database.getWorkspace(input.workspaceId);
    if (!current) return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    const dependencies = options.database.getSpaceRelations(current.id).dependsOn.flatMap((id) => options.database.getWorkspace(id) ?? []);
    try {
      assertWorkspacePhase(input.phase, dependencies);
      // Commit authority first: a rejected revision must not change local state
      // or the running agent. The coordinator also handles dormant sessions.
      await options.projects.setWorkspacePhase(current.projectId, current.id, input.phase);
      const workspace = options.database.setWorkspacePhase(current.id, input.phase);
      if (!workspace) return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
      options.handlers.events.committed?.();
      await options.sessions.workspacePhaseChanged(workspace.projectId, workspace.id);
      const projected = options.handlers.bootstrap({ projectId: workspace.projectId, workspaceId: workspace.id });
      if (projected.status === 'error') return err(errors.OperationFailed({ operation: 'set workspace phase', message: projected.error.message }));
      return ok(projected.value.workspaces.find((candidate) => candidate.id === workspace.id)!);
    } catch (error) {
      if (error instanceof WorkspaceDomainError) return err(errors.WorkspaceFailure(error.toJSON()));
      return err(errors.OperationFailed({ operation: 'set workspace phase', message: error instanceof Error ? error.message : 'Unable to update workspace phase' }));
    }
  });
  const setWorkspaceRelations = server.implement(setWorkspaceRelationsContract).handler(async ({ input, errors }) => {
    const workspace = options.database.getWorkspace(input.workspaceId);
    if (!workspace) return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    const updated = options.database.setSpaceRelations(workspace.id, { dependsOn: input.dependsOn, relatedTo: input.relatedTo, stackedOn: input.stackedOn });
    if (updated.status === 'error') return err(errors.WorkspaceFailure(updated.error.toJSON()));
    options.handlers.events.committed?.();
    const projected = options.handlers.bootstrap({ projectId: workspace.projectId, workspaceId: workspace.id });
    if (projected.status === 'error') return err(errors.OperationFailed({ operation: 'set workspace relations', message: projected.error.message }));
    return ok(projected.value.workspaces.find((candidate) => candidate.id === workspace.id)!);
  });
  const stackStatus = server.implement(stackStatusContract).handler(async ({ input, errors }) => {
    const workspace = options.database.getWorkspace(input.workspaceId);
    if (!workspace) return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
    const project = options.database.getProject(workspace.projectId);
    if (!project) return err(errors.OperationFailed({ operation: 'read stack status', message: `Project ${workspace.projectId} is not local` }));
    if (workspace.placementState === 'closed' || workspace.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'read stack status', message: 'Workspace repository is not materialized on this machine' }));
    }
    const stackedOn = options.database.getSpaceRelations(workspace.id).stackedOn;
    const parent = stackedOn ? options.database.getWorkspace(stackedOn) : null;
    try {
      return ok(await computeStackStatus({ rootPath: workspace.rootPath, baseBranch: project.baseBranch, parent: parent ? { id: parent.id, branch: parent.branch } : null }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read stack status', message: error instanceof Error ? error.message : 'Unable to read stack status' }));
    }
  });
  const navigateSessionTree = server.implement(navigateSessionTreeContract).handler(async ({ input, errors }) => {
    if (!options.sessions.get(input.sessionId)) return err(errors.SessionNotFound({ sessionId: input.sessionId }));
    try { return ok(boundSessionControl(await options.sessions.navigateTree(input.sessionId, input.entryId))); }
    catch (error) { return err(errors.AgentFailure(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation: 'navigate session tree', sessionId: input.sessionId }))); }
  });

  const getSettings = server.implement(getUserSettingsContract).handler(async ({ errors }) => {
    try {
      return ok(await settingsCoordinator().getUserSettings());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'get user settings', message: error instanceof Error ? error.message : 'Unable to load user settings' }));
    }
  });

  const updateSettings = server.implement(updateUserSettingsContract).handler(async ({ input, errors }) => {
    try {
      return ok(await settingsCoordinator().updateUserSettings({ ...input }));
    } catch (error) {
      if (error instanceof CanonicalSettingsConflict) {
        return err(errors.SettingsConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      }
      return err(errors.OperationFailed({ operation: 'update user settings', message: error instanceof Error ? error.message : 'Unable to update user settings' }));
    }
  });

  const reserveHandle = server.implement(reserveUserHandleContract).handler(async ({ input, errors }) => {
    try {
      return ok(await settingsCoordinator().reserveHandle(input.expectedRevision, input.handle));
    } catch (error) {
      if (error instanceof CanonicalSettingsConflict) {
        return err(errors.SettingsConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      }
      return err(errors.OperationFailed({ operation: 'reserve user handle', message: error instanceof Error ? error.message : 'Unable to reserve user handle' }));
    }
  });

  const getGitIdentity = server.implement(getGitIdentityContract).handler(async ({ errors }) => {
    try {
      return ok(options.gitIdentity?.view() ?? null);
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'get Git identity', message: error instanceof Error ? error.message : 'Unable to load Git identity' }));
    }
  });

  const ompSettingsView = async () => {
    const value = await settingsCoordinator().getOmpSettings();
    return {
      document: value.document,
      sync: value.sync,
      schema: value.schema.map((item) => ({
        path: item.path,
        tab: item.tab,
        label: item.label,
        description: item.description ?? null,
        kind: item.kind,
        valueJson: JSON.stringify(item.value),
        options: item.options ?? [],
        credential: item.credential,
      })),
    };
  };
  const getOmpSettings = server.implement(getOmpSettingsContract).handler(async ({ errors }) => {
    try {
      return ok(await ompSettingsView());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'get OMP settings', message: error instanceof Error ? error.message : 'Unable to load OMP settings' }));
    }
  });
  const setOmpSetting = server.implement(setOmpSettingContract).handler(async ({ input, errors }) => {
    try {
      const value = ompSettingValueSchema.parse(JSON.parse(input.valueJson));
      await settingsCoordinator().setOmpSetting(input.path, value);
      return ok(await ompSettingsView());
    } catch (error) {
      if (error instanceof CanonicalSettingsConflict) {
        return err(errors.SettingsConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      }
      return err(errors.OperationFailed({ operation: 'set OMP setting', message: error instanceof Error ? error.message : 'Unable to update OMP setting' }));
    }
  });
  const providerFailure = (operation: string, fallback: string, error: unknown) =>
    error instanceof ProviderAuthError
      ? { operation: error.operation, message: error.message }
      : { operation, message: error instanceof Error ? error.message : fallback };
  const listProviders = server.implement(listProvidersContract).handler(async ({ errors }) => {
    try {
      return ok({ providers: await providersCoordinator().list() });
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('list providers', 'Unable to list providers', error)));
    }
  });
  const startProviderLogin = server.implement(startProviderLoginContract).handler(async ({ input, errors }) => {
    try {
      return ok({ flowId: await providersCoordinator().startLogin(input.providerId) });
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('start provider login', 'Unable to start provider sign-in', error)));
    }
  });
  const providerLoginEvents = server.implement(providerLoginEventsContract).stream(async function* ({ input, errors, signal }) {
    let stream: AsyncIterable<ProviderLoginEvent>;
    try {
      stream = providersCoordinator().events(input.flowId, signal);
    } catch (error) {
      yield err(errors.OperationFailed(providerFailure('subscribe to provider login', 'Unable to follow provider sign-in', error)));
      return;
    }
    for await (const event of stream) yield ok(event);
  });
  const respondProviderLogin = server.implement(respondProviderLoginContract).handler(async ({ input, errors }) => {
    try {
      await providersCoordinator().respond(input.flowId, input.promptId, input.value);
      return ok({});
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('respond to provider login', 'Unable to answer provider sign-in prompt', error)));
    }
  });
  const cancelProviderLogin = server.implement(cancelProviderLoginContract).handler(async ({ input, errors }) => {
    try {
      await providersCoordinator().cancel(input.flowId);
      return ok({});
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('cancel provider login', 'Unable to cancel provider sign-in', error)));
    }
  });
  const logoutProvider = server.implement(logoutProviderContract).handler(async ({ input, errors }) => {
    try {
      return ok({ provider: await providersCoordinator().logout(input.providerId, input.credentialId) });
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('sign out provider', 'Unable to sign out of provider', error)));
    }
  });
  const setProviderApiKey = server.implement(setProviderApiKeyContract).handler(async ({ input, errors }) => {
    try {
      return ok({ provider: await providersCoordinator().setApiKey(input.providerId, input.key) });
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('set provider API key', 'Unable to store provider API key', error)));
    }
  });
  const providerUsage = server.implement(providerUsageContract).handler(async ({ input, errors }) => {
    try {
      return ok(await providersCoordinator().usage(input.providerId, input.refresh));
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('fetch provider usage', 'Unable to fetch provider usage', error)));
    }
  });
  const listDevices = server.implement(listDevicesContract).handler(async ({ context, errors }) => {
    if (!options.devices) return err(errors.OperationFailed({ operation: 'list devices', message: 'Device registry is unavailable' }));
    await options.devices.refresh();
    return ok(options.devices.list().map(({ record, verified }) => ({
      deviceId: record.binding.deviceId,
      kind: record.invite.invite.kind,
      label: record.binding.label,
      scope: record.invite.invite.scope.kind === 'user' ? 'user' : record.invite.invite.scope.kind === 'project' ? `project:${record.invite.invite.scope.projectId}` : `workspace:${record.invite.invite.scope.workspaceId}`,
      capabilities: [...record.invite.invite.capabilities],
      boundAt: new Date(record.binding.boundAt).toISOString(),
      expiresAt: verified?.expiresAt ? new Date(verified.expiresAt).toISOString() : null,
      revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
      active: verified !== null,
      current: context.caller?.deviceId === record.binding.deviceId,
    })));
  });
  const revokeDevice = server.implement(revokeDeviceContract).handler(async ({ input, errors }) => {
    if (!options.devices) return err(errors.OperationFailed({ operation: 'revoke device', message: 'Device registry is unavailable' }));
    try {
      const revoked = await options.devices.revoke(input.deviceId);
      return ok({ deviceId: revoked.deviceId, revokedAt: new Date(revoked.revokedAt).toISOString() });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'revoke device', message: error instanceof Error ? error.message : 'Unable to revoke device' }));
    }
  });
  // The wire view omits worker upload metadata but includes the OMP reproducibility envelope.
  const releaseView = (record: ReleaseRecord) => ({
    sha: record.sha,
    label: record.label,
    workspaceId: record.workspaceId,
    builtBy: record.builtBy,
    createdAt: record.createdAt,
    artifacts: record.artifacts,
    omp: record.omp,
    status: record.status,
    error: record.error,
  });
  const deploymentView = (status: DeploymentStatus) => ({
    desired: status.desired,
    current: status.current,
    releases: status.releases.map(releaseView),
    thisMachine: { machineId: options.machineId, ...options.deployment!.thisMachine },
    launch: options.deployment!.launchProgress(),
  });
  const deploymentStatus = server.implement(deploymentStatusContract).handler(async ({ errors }) => {
    if (!options.deployment) return err(errors.OperationFailed({ operation: 'read deployment status', message: 'Deployment control is unavailable' }));
    try {
      return ok(deploymentView(await options.deployment.status()));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read deployment status', message: error instanceof Error ? error.message : 'Unable to read deployment status' }));
    }
  });
  const deploymentLaunch = server.implement(deploymentLaunchContract).handler(async ({ input, errors }) => {
    if (!options.deployment) return err(errors.OperationFailed({ operation: 'launch release', message: 'Deployment control is unavailable' }));
    try {
      return ok(options.deployment.launch({ workspaceId: input.workspaceId, targets: [...input.targets] }));
    } catch (error) {
      if (error instanceof DeploymentLaunchError && error.code === 'WORKSPACE_NOT_FOUND') return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
      return err(errors.OperationFailed({ operation: 'launch release', message: error instanceof Error ? error.message : 'Unable to launch release' }));
    }
  });
  const deploymentRevert = server.implement(deploymentRevertContract).handler(async ({ errors }) => {
    if (!options.deployment) return err(errors.OperationFailed({ operation: 'revert release', message: 'Deployment control is unavailable' }));
    try {
      return ok(deploymentView(await options.deployment.revert()));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'revert release', message: error instanceof Error ? error.message : 'Unable to revert release' }));
    }
  });
  const listAvailableModels = server.implement(listAvailableModelsContract).handler(async ({ errors }) => {
    try {
      return ok({ models: await providersCoordinator().models() });
    } catch (error) {
      return err(errors.OperationFailed(providerFailure('list models', 'Unable to list available models', error)));
    }
  });
  // Local checkouts are not the account directory. Placement always comes from cloud authority.
  let fleetCache: { at: number; endpoints: Record<string, string | null> } | null = null;
  const holderEndpoints = async (): Promise<Record<string, string | null>> => {
    if (fleetCache && Date.now() - fleetCache.at < 5_000) return fleetCache.endpoints;
    const endpoints: Record<string, string | null> = {};
    for (const machine of await options.machines()) endpoints[machine.id] = machine.state === 'online' ? machine.rpcEndpoint : null;
    fleetCache = { at: Date.now(), endpoints };
    return endpoints;
  };
  const placementView = (space: Omit<SpacePlacementView, 'endpoint'>, endpoints: Record<string, string | null>): SpacePlacementView => ({
    ...space,
    endpoint: endpoints[space.holderId] ?? null,
  });
  const placements = server.implement(placementsContract).handler(async ({ errors }) => {
    try {
      const [endpoints, directory] = await Promise.all([holderEndpoints(), options.spacePlacements()]);
      const spaces = directory.map((space) => placementView(space, endpoints));
      return ok({ machineId: options.machineId, spaces });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list placements', message: error instanceof Error ? error.message : 'Unable to list placements' }));
    }
  });
  const locateSession = server.implement(locateSessionContract).handler(async ({ input, errors }) => {
    try {
      const [endpoints, directory] = await Promise.all([holderEndpoints(), options.spacePlacements()]);
      const local = options.sessions.get(input.sessionId);
      const localSpace = local ? directory.find((space) => space.spaceId === local.spaceId) : null;
      if (localSpace) return ok(placementView(localSpace, endpoints));
      for (const project of await options.projects.list('all')) {
        const canonical = (await options.canonicalSessions?.(project.id))?.find((session) => session.id === input.sessionId);
        const space = canonical ? directory.find((space) => space.spaceId === canonical.workspaceId) : null;
        if (space) return ok(placementView(space, endpoints));
      }
      return ok(null);
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'locate session', message: error instanceof Error ? error.message : 'Unable to locate session' }));
    }
  });
  const events = server.implement(machineEventsContract).stream(async function* ({ input, errors, signal }) {
    if (!options.database.getProject(input.projectId)) {
      yield err(errors.ProjectNotFound({ projectId: input.projectId }));
      return;
    }
    const resource = `runtime:${input.projectId}`;
    const latest = options.factEvents.latestOffset(input.projectId);
    let cursor = input.after;
    if (cursor !== null && cursor > latest) {
      yield ok({ type: 'resync', resource, cursor: latest, revision: latest, reason: 'cursor-ahead' });
      cursor = null;
    }
    if (cursor === null) {
      cursor = latest;
      yield ok({ type: 'snapshot', resource, cursor, revision: cursor, previous: null, value: null });
    }
    for await (const event of options.factEvents.stream(input.projectId, cursor, signal)) {
      const previous = cursor;
      cursor = event.offset;
      const { cloudSynced: _cloudSynced, ...fact } = event;
      yield ok({ type: 'change', resource, cursor, revision: cursor, previous, value: { ...fact, createdAt: new Date(event.createdAt) } });
    }
  });
  const terminalEvents = server.implement(terminalEventsContract).stream(async function* ({ input, errors, signal }) {
    try {
      for await (const event of options.terminals.events(input.spaceId, input.name, input.after, signal)) yield ok(event);
    } catch (error) {
      if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'follow workspace terminals', message: error instanceof Error ? error.message : 'Unable to follow workspace terminals' }));
    }
  });
  const listAccountSecrets = server.implement(listAccountSecretsContract).handler(async ({ errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.listAccountSecrets());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listAccountSecrets', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putAccountSecret = server.implement(putAccountSecretContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.putAccountSecret(input));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'putAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteAccountSecret = server.implement(deleteAccountSecretContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.deleteAccountSecret(input.name));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'deleteAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const grantAccountSecret = server.implement(grantAccountSecretContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.grantAccountSecret(input));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'grantAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const revokeAccountSecret = server.implement(revokeAccountSecretContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.revokeAccountSecret(input.name, input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'revokeAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const getConfigurationValues = server.implement(getConfigurationValuesContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.getConfigurationValues(input));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'getConfigurationValues', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putConfigurationValue = server.implement(putConfigurationValueContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.putConfigurationValue(input));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'putConfigurationValue', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteConfigurationValue = server.implement(deleteConfigurationValueContract).handler(async ({ input, errors, context }) => {
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account configuration requires an account-scoped device');
      if (!options.configuration) throw new Error('Account configuration authority is unavailable');
      return ok(await options.configuration.deleteConfigurationValue(input));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'deleteConfigurationValue', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listSecrets = server.implement(listProjectSecretsContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await options.secrets.listProjectSecrets(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list project secrets', message: error instanceof Error ? error.message : 'Unable to list project secrets' }));
    }
  });
  const putSecret = server.implement(putProjectSecretContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await options.secrets.putProjectSecret(input.projectId, input.name, input.value));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'put project secret', message: error instanceof Error ? error.message : 'Unable to save project secret' }));
    }
  });
  const deleteSecret = server.implement(deleteProjectSecretContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await options.secrets.deleteProjectSecret(input.projectId, input.name));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'delete project secret', message: error instanceof Error ? error.message : 'Unable to delete project secret' }));
    }
  });
  const getEnvironment = server.implement(getWorkspaceEnvironmentContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().view(input.spaceId)));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'get workspace environment', message: error instanceof Error ? error.message : 'Unable to get workspace environment' }));
    }
  });
  const putEnvironmentBundle = server.implement(putWorkspaceEnvironmentBundleContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().putBundle(input.spaceId, parseEnvironmentBundleJson(input.bundleJson))));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'put workspace environment bundle', message: error instanceof Error ? error.message : 'Unable to save workspace environment bundle' }));
    }
  });
  const setEnvironmentProfile = server.implement(setWorkspaceEnvironmentProfileContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().setProfile(input.spaceId, input.profile)));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'set workspace environment profile', message: error instanceof Error ? error.message : 'Unable to set workspace environment profile' }));
    }
  });
  const putEnvironmentValue = server.implement(putWorkspaceEnvironmentValueContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().putValue(input.spaceId, input.scope, input.name, input.value)));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'put workspace environment value', message: error instanceof Error ? error.message : 'Unable to save workspace environment value' }));
    }
  });
  const deleteEnvironmentValue = server.implement(deleteWorkspaceEnvironmentValueContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().deleteValue(input.spaceId, input.scope, input.name)));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'delete workspace environment value', message: error instanceof Error ? error.message : 'Unable to delete workspace environment value' }));
    }
  });
  const approveEnvironmentExecution = server.implement(approveWorkspaceEnvironmentExecutionContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().approve(input.spaceId, input.scope, input.executionHash)));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'approve workspace environment execution', message: error instanceof Error ? error.message : 'Unable to approve workspace environment execution' }));
    }
  });
  const revokeEnvironmentApproval = server.implement(revokeWorkspaceEnvironmentApprovalContract).handler(async ({ input, errors }) => {
    try {
      return ok(environmentOutput(await environment().revokeApproval(input.spaceId, input.scope, input.executionHash)));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'revoke workspace environment approval', message: error instanceof Error ? error.message : 'Unable to revoke workspace environment approval' }));
    }
  });

  const runEnvironmentChecks = server.implement(runWorkspaceEnvironmentChecksContract).handler(async ({ input, errors }) => {
    try {
      return ok(await environment().acceptRun(input.spaceId, { runId: input.runId, phase: 'checks', deadlineAt: input.deadlineAt }));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'run workspace environment checks', message: error instanceof Error ? error.message : 'Unable to run workspace environment checks' }));
    }
  });
  const runEnvironmentPhase = server.implement(runWorkspaceEnvironmentPhaseContract).handler(async ({ input, errors, context }) => {
    try {
      assertLifecycleCommandAuthorized(input.phase, { human: context.caller?.kind === 'browser' });
      return ok(await environment().acceptRun(input.spaceId, { runId: input.runId, phase: input.phase, rerun: input.rerun ?? false, deadlineAt: input.deadlineAt }));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: `run workspace environment ${input.phase}`, message: error instanceof Error ? error.message : `Unable to run workspace environment ${input.phase}` }));
    }
  });
  const cancelEnvironmentRun = server.implement(cancelWorkspaceEnvironmentRunContract).handler(async ({ input, errors }) => {
    try {
      return ok(await environment().cancelRun(input.spaceId, input.runId));
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'cancel lifecycle run', message: error instanceof Error ? error.message : 'Unable to cancel lifecycle run' }));
    }
  });
  const recoverEnvironmentRun = server.implement(recoverWorkspaceEnvironmentRunContract).handler(async ({ errors }) => {
    return err(errors.EnvironmentFailure(new EnvironmentError('RecoveryRequired', 'Human recovery must use the account gateway, which verifies the previous runner was destroyed').toJSON()));
  });
  const getEnvironmentRunLog = server.implement(getWorkspaceEnvironmentRunLogContract).handler(async ({ input, errors }) => {
    try { return ok(await environment().runLog(input.spaceId, input.runId, input.offset ?? 0)); }
    catch (error) {
      const failure = environmentFailure(error);
      if (failure) return err(errors.EnvironmentFailure(failure));
      return err(errors.OperationFailed({ operation: 'read lifecycle log', message: error instanceof Error ? error.message : 'Unable to read lifecycle log' }));
    }
  });

  const listSkills = server.implement(listSkillsContract).handler(async ({ errors, context }) => {
    if (!options.skills) return err(errors.OperationFailed({ operation: 'list skills', message: 'Skills authority is unavailable' }));
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account skills require an account-scoped device');
      return ok(await options.skills.listSkills());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list skills', message: error instanceof Error ? error.message : 'Unable to list skills' }));
    }
  });
  const updateSkill = server.implement(updateSkillContract).handler(async ({ input, errors, context }) => {
    if (!options.skills) return err(errors.OperationFailed({ operation: 'update skill', message: 'Skills authority is unavailable' }));
    try {
      if (context.caller && context.caller.scope.kind !== 'user') throw new Error('Account skills require an account-scoped device');
      const updated = await options.skills.updateSkill(input.update);
      return ok(updated);
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'SKILL_CONFLICT') {
        return err(errors.SkillConflict({ skillId: input.update.id, expected: Number(error.details.expected ?? input.update.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      return err(errors.OperationFailed({ operation: 'update skill', message: error instanceof Error ? error.message : 'Unable to update skill' }));
    }
  });

  const listTerminals = server.implement(listWorkspaceTerminalsContract).handler(async ({ input, errors }) => {
    try {
      return ok(await options.terminals.list(input.spaceId));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      return err(errors.OperationFailed({ operation: 'list workspace terminals', message: error instanceof Error ? error.message : 'Unable to list terminals' }));
    }
  });
  const createTerminal = server.implement(createWorkspaceTerminalContract).handler(async ({ input, errors }) => {
    try {
      return ok(await options.terminals.createShell(input.spaceId));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      return err(errors.OperationFailed({ operation: 'create workspace terminal', message: error instanceof Error ? error.message : 'Unable to create terminal' }));
    }
  });
  const readTerminal = server.implement(readWorkspaceTerminalContract).handler(async ({ input, errors }) => {
    try {
      return ok(await options.terminals.read(input.spaceId, input.name, input.cursor));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      if (error instanceof WorkspaceHubTerminalUnavailable) return err(errors.TerminalNotFound({ spaceId: input.spaceId, name: input.name }));
      return err(errors.OperationFailed({ operation: 'read workspace terminal', message: error instanceof Error ? error.message : 'Unable to read terminal' }));
    }
  });
  const sendTerminal = server.implement(sendWorkspaceTerminalContract).handler(async ({ input, errors }) => {
    try {
      return ok(await options.terminals.send(input.spaceId, input.name, input.data));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      if (error instanceof WorkspaceHubTerminalUnavailable) return err(errors.TerminalNotFound({ spaceId: input.spaceId, name: input.name }));
      return err(errors.OperationFailed({ operation: 'write workspace terminal', message: error instanceof Error ? error.message : 'Unable to write terminal' }));
    }
  });
  const stopTerminal = server.implement(stopWorkspaceTerminalContract).handler(async ({ input, errors }) => {
    try {
      return ok(await options.terminals.stop(input.spaceId, input.name));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      if (error instanceof WorkspaceHubTerminalUnavailable) return err(errors.TerminalNotFound({ spaceId: input.spaceId, name: input.name }));
      return err(errors.OperationFailed({ operation: 'stop workspace terminal', message: error instanceof Error ? error.message : 'Unable to stop terminal' }));
    }
  });

  const listCrons = server.implement(listProjectCronsContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await cronsAuthority().listProjectCrons(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'list project crons', message: error instanceof Error ? error.message : 'Unable to list project crons' }));
    }
  });
  const createCron = server.implement(createProjectCronContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      const value = await cronsAuthority().createProjectCron(input.projectId, input.draft);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: input.projectId,
      scope: 'project',
      entity: 'project-cron',
      entityId: value.id,
      revision: value.revision,
      operation: 'created',
      payload: { cronId: value.id }, });
      return ok(value);
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_INVALID') {
        return err(errors.CronInvalid({ field: String(error.details.field ?? 'cron'), message: error.message }));
      }
      return err(errors.OperationFailed({ operation: 'create project cron', message: error instanceof Error ? error.message : 'Unable to create project cron' }));
    }
  });
  const updateCron = server.implement(updateProjectCronContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      const value = await cronsAuthority().updateProjectCron(input.projectId, input.cronId, input.expectedRevision, input.draft);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: input.projectId,
      scope: 'project',
      entity: 'project-cron',
      entityId: value.id,
      revision: value.revision,
      operation: 'updated',
      payload: { cronId: value.id }, });
      return ok(value);
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_NOT_FOUND') {
        return err(errors.CronNotFound({ projectId: input.projectId, cronId: input.cronId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_REVISION_CONFLICT') {
        return err(errors.CronRevisionConflict({ cronId: input.cronId, expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_INVALID') {
        return err(errors.CronInvalid({ field: String(error.details.field ?? 'cron'), message: error.message }));
      }
      return err(errors.OperationFailed({ operation: 'update project cron', message: error instanceof Error ? error.message : 'Unable to update project cron' }));
    }
  });
  const deleteCron = server.implement(deleteProjectCronContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      const value = await cronsAuthority().deleteProjectCron(input.projectId, input.cronId, input.expectedRevision);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: input.projectId,
      scope: 'project',
      entity: 'project-cron',
      entityId: input.cronId,
      revision: input.expectedRevision + 1,
      operation: 'removed',
      payload: { cronId: input.cronId }, });
      return ok(value);
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_NOT_FOUND') {
        return err(errors.CronNotFound({ projectId: input.projectId, cronId: input.cronId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_REVISION_CONFLICT') {
        return err(errors.CronRevisionConflict({ cronId: input.cronId, expected: Number(error.details.expected ?? input.expectedRevision), actual: Number(error.details.actual ?? -1) }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_ALREADY_RUNNING') {
        return err(errors.CronAlreadyRunning({ cronId: input.cronId, runId: String(error.details.runId ?? ''), state: error.details.state === 'running' ? 'running' : 'pending' }));
      }
      return err(errors.OperationFailed({ operation: 'delete project cron', message: error instanceof Error ? error.message : 'Unable to delete project cron' }));
    }
  });
  const runCronNow = server.implement(runProjectCronNowContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      const value = await cronsAuthority().runProjectCronNow(input.projectId, input.cronId);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: input.projectId,
      scope: 'project',
      entity: 'project-cron-run',
      entityId: value.id,
      revision: value.cronRevision,
      operation: 'created',
      payload: { cronId: input.cronId, runId: value.id }, });
      return ok(value);
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_NOT_FOUND') {
        return err(errors.CronNotFound({ projectId: input.projectId, cronId: input.cronId }));
      }
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_ALREADY_RUNNING') {
        return err(errors.CronAlreadyRunning({ cronId: input.cronId, runId: String(error.details.runId ?? ''), state: error.details.state === 'running' ? 'running' : 'pending' }));
      }
      return err(errors.OperationFailed({ operation: 'queue project cron', message: error instanceof Error ? error.message : 'Unable to queue project cron' }));
    }
  });
  const cronHistory = server.implement(projectCronHistoryContract).handler(async ({ input, errors }) => {
    if (!options.database.getProject(input.projectId)) return err(errors.ProjectNotFound({ projectId: input.projectId }));
    try {
      return ok(await cronsAuthority().projectCronHistory(input.projectId, input.cronId, input.limit));
    } catch (error) {
      if (error instanceof CloudSpaceAuthorityError && error.code === 'CRON_NOT_FOUND') {
        return err(errors.CronNotFound({ projectId: input.projectId, cronId: input.cronId }));
      }
      return err(errors.OperationFailed({ operation: 'list project cron history', message: error instanceof Error ? error.message : 'Unable to list project cron history' }));
    }
  });

  const inspectorOverview = server.implement(inspectorOverviewContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      await inspectorAuthority().bootstrapInspector(resolved.identity);
      const context = resolved.space.placementState !== 'closed' && resolved.space.holderId === options.machineId
        ? { generation: resolved.space.generation, headCommit: (await readRepositoryIdentity(resolved.repository)).headCommit }
        : undefined;
      return ok(await inspectorAuthority().getInspectorOverview(resolved.identity, context));
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'load Inspector overview', message: authorityFailureMessage(failure) }));
    }
  });
  const inspectorJournal = server.implement(inspectorJournalContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      await inspectorAuthority().bootstrapInspector(resolved.identity);
      return ok(await inspectorAuthority().listInspectorJournal(resolved.identity));
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'load Inspector journal', message: authorityFailureMessage(failure) }));
    }
  });
  const inspectorThreads = server.implement(inspectorReviewThreadsContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      await inspectorAuthority().bootstrapInspector(resolved.identity);
      const context = resolved.space.placementState !== 'closed' && resolved.space.holderId === options.machineId
        ? { generation: resolved.space.generation, headCommit: (await readRepositoryIdentity(resolved.repository)).headCommit }
        : undefined;
      return ok(await inspectorAuthority().listInspectorReviewThreads(resolved.identity, context));
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'load Inspector review threads', message: authorityFailureMessage(failure) }));
    }
  });
  const inspectorServices = server.implement(inspectorServicesContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      return ok(await options.serviceManager.list(resolved.space.id));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'load Inspector services', message: error instanceof Error ? error.message : 'Unable to load Inspector services' }));
    }
  });
  const startInspectorService = server.implement(startWorkspaceServiceContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      return ok(await options.serviceManager.start(resolved.space.id, input.serviceName));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'start workspace service', message: error instanceof Error ? error.message : 'Unable to start workspace service' }));
    }
  });
  const stopInspectorService = server.implement(stopWorkspaceServiceContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      return ok(await options.serviceManager.stop(resolved.space.id, input.serviceName));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'stop workspace service', message: error instanceof Error ? error.message : 'Unable to stop workspace service' }));
    }
  });
  const inspectorRepositoryTree = server.implement(inspectorRepositoryTreeContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    if (resolved.space.placementState === 'closed' || resolved.space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository tree', message: 'Space repository is not materialized on this machine' }));
    }
    try {
      return ok(await readRepositoryTree({ ...await inspectorRepository(resolved, input.mode), ...(input.path === null ? {} : { path: input.path }) }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository tree', message: error instanceof Error ? error.message : 'Unable to read repository tree' }));
    }
  });
  const inspectorRepositoryStatus = server.implement(inspectorRepositoryStatusContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    if (resolved.space.placementState === 'closed' || resolved.space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository status', message: 'Space repository is not materialized on this machine' }));
    }
    try {
      return ok(await readRepositoryStatus({ ...await inspectorRepository(resolved, input.mode), ...(input.path === null ? {} : { path: input.path }) }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository status', message: error instanceof Error ? error.message : 'Unable to read repository status' }));
    }
  });
  const inspectorRepositoryFile = server.implement(inspectorRepositoryFileContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    if (resolved.space.placementState === 'closed' || resolved.space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository file', message: 'Space repository is not materialized on this machine' }));
    }
    try {
      return ok(await readRepositoryFile({ ...await inspectorRepository(resolved, input.mode), path: input.path }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository file', message: error instanceof Error ? error.message : 'Unable to read repository file' }));
    }
  });
  const inspectorRepositoryDiff = server.implement(inspectorRepositoryDiffContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration, input.baseRef);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    if (resolved.space.placementState === 'closed' || resolved.space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository diff', message: 'Space repository is not materialized on this machine' }));
    }
    try {
      return ok(await readRepositoryDiff({ ...await inspectorRepository(resolved, input.mode), ...(input.path === null ? {} : { path: input.path }) }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Inspector repository diff', message: error instanceof Error ? error.message : 'Unable to read repository diff' }));
    }
  });

  const putInspectorGoal = server.implement(inspectorPutGoalContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().putInspectorGoal({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'goal', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId } });
      await options.sessions.instructionsChanged(resolved.identity.projectId, resolved.identity.spaceId);
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'update Inspector goal', message: failure.message }));
    }
  });
  const attachInspectorEvidence = server.implement(inspectorAttachRequirementEvidenceContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().attachInspectorRequirementEvidence({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'goal', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId, requirementId: input.input.requirementId } });
      await options.sessions.instructionsChanged(resolved.identity.projectId, resolved.identity.spaceId);
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'attach Inspector evidence', message: failure.message }));
    }
  });
  const putInspectorWorkflow = server.implement(inspectorPutWorkflowContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().putInspectorWorkflow({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'workflow', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId } });
      await options.sessions.instructionsChanged(resolved.identity.projectId, resolved.identity.spaceId);
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'update Inspector workflow', message: failure.message }));
    }
  });
  const waiveInspectorGate = server.implement(inspectorWaiveWorkflowGateContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().waiveInspectorWorkflowGate({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'workflow', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId, gateId: input.input.gateId } });
      await options.sessions.instructionsChanged(resolved.identity.projectId, resolved.identity.spaceId);
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'waive Inspector workflow gate', message: failure.message }));
    }
  });
  const putInspectorRubric = server.implement(inspectorPutRubricContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().putInspectorRubric({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'rubric', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId } });
      await options.sessions.instructionsChanged(resolved.identity.projectId, resolved.identity.spaceId);
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'update Inspector rubric', message: failure.message }));
    }
  });
  const appendInspectorJudgment = server.implement(inspectorAppendRubricJudgmentContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().appendInspectorRubricJudgment({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'rubric', entityId: value.id, revision: value.revision, operation: 'append', payload: { spaceId: resolved.identity.spaceId, criterionId: input.input.criterionId } });
      await options.sessions.instructionsChanged(resolved.identity.projectId, resolved.identity.spaceId);
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'append Inspector judgment', message: failure.message }));
    }
  });

  const startInspectorJournal = server.implement(inspectorStartJournalPhaseContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().startInspectorJournalPhase({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'journal', entityId: value.id, revision: value.sequence, operation: 'created', payload: { spaceId: resolved.identity.spaceId, phaseRunId: input.input.phaseRunId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'start Inspector journal phase', message: failure.message }));
    }
  });
  const endInspectorJournal = server.implement(inspectorEndJournalPhaseContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().endInspectorJournalPhase({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'journal', entityId: value.id, revision: value.sequence, operation: 'updated', payload: { spaceId: resolved.identity.spaceId, phaseRunId: input.input.phaseRunId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'end Inspector journal phase', message: failure.message }));
    }
  });
  const appendInspectorJournal = server.implement(inspectorAppendJournalEntryContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().appendInspectorJournalEntry({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'journal', entityId: value.id, revision: value.sequence, operation: 'append', payload: { spaceId: resolved.identity.spaceId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'append Inspector journal entry', message: failure.message }));
    }
  });
  const putInspectorGuide = server.implement(inspectorPutChangeGuideContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().putInspectorChangeGuide({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'change-guide', entityId: resolved.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'update Inspector change guide', message: failure.message }));
    }
  });
  const analyzeInspectorGuide = server.implement(inspectorAnalyzeChangeGuideContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    if (resolved.space.placementState === 'closed' || resolved.space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'analyze Change Guide', message: 'Space repository is not materialized on this machine' }));
    }
    try {
      await inspectorAuthority().bootstrapInspector(resolved.identity);
      const [overview, journal] = await Promise.all([
        inspectorAuthority().getInspectorOverview(resolved.identity),
        inspectorAuthority().listInspectorJournal(resolved.identity),
      ]);
      return ok(buildChangeGuideWorksheet({
        ...resolved.identity,
        repositoryPath: resolved.repository.repositoryPath,
        generation: resolved.space.generation,
        baseRef: input.baseRef,
        overview,
        journal,
      }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'analyze Change Guide', message: error instanceof Error ? error.message : 'Unable to analyze Change Guide' }));
    }
  });
  const submitInspectorGuide = server.implement(inspectorSubmitChangeGuideContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    if (resolved.space.placementState === 'closed' || resolved.space.holderId !== options.machineId) {
      return err(errors.OperationFailed({ operation: 'submit Change Guide', message: 'Space repository is not materialized on this machine' }));
    }
    try {
      const [overview, journal] = await Promise.all([
        inspectorAuthority().getInspectorOverview(resolved.identity),
        inspectorAuthority().listInspectorJournal(resolved.identity),
      ]);
      const worksheet = buildChangeGuideWorksheet({
        ...resolved.identity,
        repositoryPath: resolved.repository.repositoryPath,
        generation: resolved.space.generation,
        baseRef: input.baseRef,
        overview,
        journal,
      });
      const guide = validateChangeGuideNarration(worksheet, input);
      const value = await inspectorAuthority().putInspectorChangeGuide({
        ...resolved.identity,
        expectedRevision: input.expectedRevision,
        guide,
      });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'change-guide', entityId: resolved.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'submit Change Guide', message: error instanceof Error ? error.message : authorityFailureMessage(failure) }));
    }
  });
  const readSessionResource = server.implement(inspectorReadResourceContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    const context = input.sessionId === null ? null : options.sessions.getResourceContext(input.sessionId);
    if (input.sessionId !== null && (!context || context.spaceId !== resolved.space.id)) {
      return err(errors.InspectorState({ resource: 'session resource', message: 'The originating session is not available for this workspace.' }));
    }
    const capability: ArtifactCapability = resolved.space.kind === 'base'
      ? { kind: 'project', projectId: resolved.space.projectId }
      : { kind: 'workspace', projectId: resolved.space.projectId, workspaceId: resolved.space.id };
    try {
      return ok(await readInspectorResource({
        url: input.url, sessionFile: context?.sessionFile ?? null, localArtifactsDir: context?.localArtifactsDir ?? null,
        capability, artifacts: options.artifacts,
      }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read session resource', message: error instanceof Error ? error.message : 'Unable to read the linked resource' }));
    }
  });
  const readInspectorArtifact = server.implement(inspectorReadArtifactContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const capability: ArtifactCapability = resolved.space.kind === 'base'
        ? { kind: 'project', projectId: resolved.space.projectId }
        : { kind: 'workspace', projectId: resolved.space.projectId, workspaceId: resolved.space.id };
      const resource = parseResourceUri(input.url);
      if (!resource || resource.kind !== 'local' || !resource.mount) throw new Error('Expected a canonical local artifact URI');
      const value = await options.artifacts.read(capability, resource.url, input.hash);
      if (value.status === 'error') throw value.error;
      return ok(createResourcePreview(input.url, value.value));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Inspector artifact', message: error instanceof Error ? error.message : 'Unable to read Inspector artifact' }));
    }
  });
  const writeInspectorArtifact = server.implement(inspectorWriteArtifactContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Inspector artifact writes are limited to 16 MiB');
      const capability: ArtifactCapability = resolved.space.kind === 'base'
        ? { kind: 'project', projectId: resolved.space.projectId }
        : { kind: 'workspace', projectId: resolved.space.projectId, workspaceId: resolved.space.id };
      const value = await options.artifacts.write(capability, input.url, bytes, input.mediaType ?? undefined);
      if (value.status === 'error') throw value.error;
      await options.sessions.publishArtifacts(resolved.space.id);
      return ok(value.value);
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'write Inspector artifact', message: error instanceof Error ? error.message : 'Unable to write Inspector artifact' }));
    }
  });
  const markInspectorGuideRead = server.implement(inspectorMarkGuideSectionReadContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().markInspectorGuideSectionRead({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'change-guide', entityId: resolved.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId, sectionId: input.input.sectionId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'mark Inspector guide section read', message: failure.message }));
    }
  });
  const setInspectorApproval = server.implement(inspectorSetGuideApprovalContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const value = await inspectorAuthority().setInspectorGuideApproval({ ...input.input, ...resolved.identity });
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'change-guide', entityId: resolved.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId, decision: input.input.decision } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'update Inspector guide approval', message: failure.message }));
    }
  });
  const createInspectorThread = server.implement(inspectorCreateReviewThreadContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const context = resolved.space.placementState !== 'closed' && resolved.space.holderId === options.machineId
        ? { generation: resolved.space.generation, headCommit: (await readRepositoryIdentity(resolved.repository)).headCommit }
        : undefined;
      const value = await inspectorAuthority().createInspectorReviewThread({ ...input.input, ...resolved.identity }, context);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'review-thread', entityId: value.id, revision: value.revision, operation: 'created', payload: { spaceId: resolved.identity.spaceId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'create Inspector review thread', message: failure.message }));
    }
  });
  const replyInspectorThread = server.implement(inspectorAppendReviewMessageContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const context = resolved.space.placementState !== 'closed' && resolved.space.holderId === options.machineId
        ? { generation: resolved.space.generation, headCommit: (await readRepositoryIdentity(resolved.repository)).headCommit }
        : undefined;
      const value = await inspectorAuthority().appendInspectorReviewMessage({ ...input.input, ...resolved.identity }, context);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'review-thread', entityId: value.id, revision: value.revision, operation: 'append', payload: { spaceId: resolved.identity.spaceId } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'reply to Inspector review thread', message: failure.message }));
    }
  });
  const resolveInspectorThread = server.implement(inspectorResolveReviewThreadContract).handler(async ({ input, errors }) => {
    const resolved = resolveInspectorSpace(options.database, input.input.spaceId, input.expectedGeneration);
    if (resolved.status === 'missing') return err(errors.WorkspaceNotFound({ workspaceId: resolved.spaceId }));
    if (resolved.status === 'generation-conflict') return err(errors.SpaceGenerationConflict({ spaceId: resolved.spaceId, expected: resolved.expected, actual: resolved.actual }));
    try {
      const context = resolved.space.placementState !== 'closed' && resolved.space.holderId === options.machineId
        ? { generation: resolved.space.generation, headCommit: (await readRepositoryIdentity(resolved.repository)).headCommit }
        : undefined;
      const value = await inspectorAuthority().resolveInspectorReviewThread({ ...input.input, ...resolved.identity }, context);
      await options.projectEvents.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: resolved.identity.projectId, scope: 'workspace', entity: 'review-thread', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: resolved.identity.spaceId, resolved: value.resolved } });
      return ok(value);
    } catch (error) {
      const failure = authorityFailure(error);
      if (failure.kind === 'conflict') return err(errors.InspectorConflict({ resource: failure.resource, expected: failure.expected, actual: failure.actual }));
      if (failure.kind === 'state') return err(errors.InspectorState({ resource: failure.resource, message: failure.message }));
      return err(errors.OperationFailed({ operation: 'resolve Inspector review thread', message: failure.message }));
    }
  });

  return server.router({
    bootstrap,
    transcript,
    transcriptPage,
    transcriptContent,
    machines,
    machine: { updateNotes: updateMachineNotes, createSandbox, sleep: sleepMachine, resume: resumeMachine, destroy: destroyMachine },
    settings: {
      git: { get: getGitIdentity },
      get: getSettings,
      update: updateSettings,
      reserveHandle,
      omp: { get: getOmpSettings, set: setOmpSetting },
    },
    providers: {
      list: listProviders,
      login: { start: startProviderLogin, events: providerLoginEvents, respond: respondProviderLogin, cancel: cancelProviderLogin },
      logout: logoutProvider,
      apiKey: { set: setProviderApiKey },
      usage: providerUsage,
      models: listAvailableModels,
    },
    space: { close: closeSpace, reopen: reopenSpace },
    devices: { list: listDevices, revoke: revokeDevice },
    deployment: { status: deploymentStatus, launch: deploymentLaunch, revert: deploymentRevert },
    secrets: { list: listSecrets, put: putSecret, delete: deleteSecret, account: { list: listAccountSecrets, put: putAccountSecret, delete: deleteAccountSecret, grant: grantAccountSecret, revoke: revokeAccountSecret } },
    configuration: { values: { get: getConfigurationValues, put: putConfigurationValue, delete: deleteConfigurationValue } },
    environment: {
      get: getEnvironment,
      putBundle: putEnvironmentBundle,
      setProfile: setEnvironmentProfile,
      putValue: putEnvironmentValue,
      deleteValue: deleteEnvironmentValue,
      approve: approveEnvironmentExecution,
      revokeApproval: revokeEnvironmentApproval,
      runChecks: runEnvironmentChecks,
      runPhase: runEnvironmentPhase,
      cancelRun: cancelEnvironmentRun,
      recoverRun: recoverEnvironmentRun,
      runLog: getEnvironmentRunLog,
    },
    mcp: {
      connections: {
        list: listMcpConnections,
        create: createMcpConnection,
        update: updateMcpConnection,
        delete: deleteMcpConnection,
        status: getMcpConnectionStatus,
      },
      composio: {
        setup: {
          get: getComposioSetup,
          put: putComposioSetup,
          delete: deleteComposioSetup,
        },
        catalog: listComposioPluginCatalog,
        authorize: authorizeComposioPlugin,
        refresh: refreshComposioPlugin,
        tools: listComposioPluginTools,
        updateTools: updateComposioPluginTools,
        disconnect: disconnectComposioPlugin,
      },
      grants: {
        list: listProjectMcpGrants,
        put: putProjectMcpGrant,
        delete: deleteProjectMcpGrant,
      },
      discover: discoverProjectMcpTools,
    },
    crons: { list: listCrons, create: createCron, update: updateCron, delete: deleteCron, runNow: runCronNow, history: cronHistory },
    skills: { list: listSkills, update: updateSkill },
    inspector: {
      overview: inspectorOverview,
      goal: { put: putInspectorGoal, attachEvidence: attachInspectorEvidence },
      workflow: { put: putInspectorWorkflow, waiveGate: waiveInspectorGate },
      rubric: { put: putInspectorRubric, appendJudgment: appendInspectorJudgment },
      journal: { list: inspectorJournal, startPhase: startInspectorJournal, endPhase: endInspectorJournal, append: appendInspectorJournal },
      guide: { put: putInspectorGuide, analyze: analyzeInspectorGuide, submit: submitInspectorGuide, markSectionRead: markInspectorGuideRead, setApproval: setInspectorApproval },
      review: { list: inspectorThreads, create: createInspectorThread, reply: replyInspectorThread, resolve: resolveInspectorThread },
      repository: { tree: inspectorRepositoryTree, status: inspectorRepositoryStatus, file: inspectorRepositoryFile, diff: inspectorRepositoryDiff },
      services: { list: inspectorServices, start: startInspectorService, stop: stopInspectorService },
      resources: { read: readSessionResource },
      artifacts: { read: readInspectorArtifact, write: writeInspectorArtifact },
    },
    project: { list: listProjects, create: createProject, open: openProject, archive: archiveProject, restore: restoreProject, delete: deleteProject },
    workspace: { create: createWorkspace, archive: archiveWorkspace, restore: restoreWorkspace, delete: deleteWorkspace, setPhase: setWorkspacePhase, setRelations: setWorkspaceRelations, stackStatus },
    placements,
    browserRelay: {
      status: getBrowserRelayStatus,
      setup: setupBrowserRelay,
      start: startBrowserRelay,
      stop: stopBrowserRelay,
      test: testBrowserRelay,
    },
    session: {
      locate: locateSession,
      create: createSession,
      createProject: createProjectSession,
      prompt: promptSession,
      control: getSessionControl,
      history: sessionHistory,
      usage: getSessionUsage,
      agents: getSessionAgents,
      saveAgent: saveSessionAgent,
      cycleRole: cycleSessionRole,
      setThinking: setSessionThinking,
      setFast: setSessionFast,
      setModel: setSessionModel,
      setApproval: setSessionApproval,
      setGoal: setSessionGoal,
      compact: compactSession,
      navigateTree: navigateSessionTree,
      clearQueue: clearSessionQueue,
      removeQueuedMessage: removeSessionQueuedMessage,
      promoteQueuedMessage: promoteSessionQueuedMessage,
      answerAsk: answerSessionAsk,
      stop: stopSessionTurn,
    },
    subagents: { transcript: subagentTranscript, events: subagentEvents, page: subagentPage, content: subagentContent },
    terminals: { events: terminalEvents, list: listTerminals, create: createTerminal, read: readTerminal, send: sendTerminal, stop: stopTerminal },
    events,
  });
}

/** Procedure kind by dotted path, for the signed handler's capability derivation. */
export function procedureKinds(router: ReturnType<typeof createGitSpaceRpcRouter>): (path: string) => 'query' | 'mutation' | 'subscription' | null {
  return (path) => {
    const procedure = router.procedures.get(path);
    return procedure ? procedure._def.kind : null;
  };
}

const RPC_CONTRACT_VERSION = contractDigest(gitspaceContract);

export function createGitSpaceRpcHandler(options: GitSpaceRpcRouterOptions) {
  const router = createGitSpaceRpcRouter(options);
  const handler = createFetchHandler({
    router,
    // Cloud and machine routers implement different slices of the same public contract.
    contractVersion: RPC_CONTRACT_VERSION,
    endpoint: '/rpc',
    createContext: ({ request }) => {
      const caller = callerFor(request);
      return caller ? { caller } : {};
    },
    onInternalError: options.onInternalError,
  });
  return { handler, procedureKind: procedureKinds(router) };
}
