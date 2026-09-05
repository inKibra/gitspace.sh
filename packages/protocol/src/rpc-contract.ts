import { defineErrors, rpc, type InputOf, wire } from 'result-rpc';
import {
  ProjectCronDraftCodec,
  ProjectCronRunViewCodec,
  ProjectCronViewCodec,
  projectCronErrors,
} from './cron-contract.js';
import {
  AppendJournalEntryInputCodec,
  AppendReviewMessageInputCodec,
  AppendRubricJudgmentInputCodec,
  AttachRequirementEvidenceInputCodec,
  AnalyzeChangeGuideInputCodec,
  ChangeGuideWorksheetCodec,
  ChangeGuideViewCodec,
  CreateReviewThreadInputCodec,
  EndJournalPhaseInputCodec,
  InspectorOverviewCodec,
  InspectorIdentityCodec,
  InspectorProjectCodec,
  InspectorWorkspaceCodec,
  JournalEntryViewCodec,
  MarkGuideSectionReadInputCodec,
  PutChangeGuideInputCodec,
  PutGoalInputCodec,
  PutRubricInputCodec,
  PutWorkflowInputCodec,
  RepositoryDiffViewCodec,
  RepositoryFileViewCodec,
  RepositoryStatusEntryCodec,
  RepositoryTreeEntryCodec,
  ResolveReviewThreadInputCodec,
  ReviewThreadViewCodec,
  RubricViewCodec,
  ServiceViewCodec,
  SetGuideApprovalInputCodec,
  SubmitChangeGuideInputCodec,
  StartJournalPhaseInputCodec,
  WaiveWorkflowGateInputCodec,
  WorkflowViewCodec,
  GoalRecordViewCodec,
} from './inspector-contract.js';
import { SkillUpdateCodec, SkillViewCodec } from './skills-contract.js';
import {
  ComposioPluginAuthorizationViewCodec,
  ComposioPluginCatalogViewCodec,
  ComposioPluginToolViewCodec,
  ComposioSetupViewCodec,
  DiscoveredMcpToolViewCodec,
  McpConnectionDraftCodec,
  McpConnectionViewCodec,
  ProjectMcpGrantViewCodec,
} from './mcp-contract.js';

export const rpcErrors = defineErrors('gitspace', {
  projectNotFound: {
    data: wire.object({ projectId: wire.string }),
    httpStatus: 404,
  },
  workspaceNotFound: {
    data: wire.object({ workspaceId: wire.string }),
    httpStatus: 404,
  },
  workspacePossessed: {
    data: wire.object({ workspaceId: wire.string, holderId: wire.string, generation: wire.number }),
    httpStatus: 409,
  },
  workspaceUnpossessed: {
    data: wire.object({ workspaceId: wire.string }),
    httpStatus: 409,
  },
  sessionNotFound: {
    data: wire.object({ sessionId: wire.string }),
    httpStatus: 404,
  },
  terminalNotFound: {
    data: wire.object({ spaceId: wire.string, name: wire.string }),
    httpStatus: 404,
  },
  sessionBusy: {
    data: wire.object({ sessionId: wire.string }),
    httpStatus: 409,
  },
  operationFailed: {
    data: wire.object({ operation: wire.string, message: wire.string }),
    httpStatus: 500,
  },
  settingsConflict: {
    data: wire.object({ resource: wire.enum(['user-settings', 'omp-config']), expected: wire.number, actual: wire.number }),
    httpStatus: 409,
  },
  spaceGenerationConflict: {
    data: wire.object({ spaceId: wire.string, expected: wire.number, actual: wire.number }),
    httpStatus: 409,
  },
  inspectorConflict: {
    data: wire.object({ resource: wire.string, expected: wire.number, actual: wire.number }),
    httpStatus: 409,
  },
  inspectorState: {
    data: wire.object({ resource: wire.string, message: wire.string }),
    httpStatus: 409,
  },
  skillConflict: {
    data: wire.object({ skillId: wire.string, expected: wire.number, actual: wire.number }),
    httpStatus: 409,
  },
  mcpRevisionConflict: {
    data: wire.object({ resource: wire.string, expected: wire.number, actual: wire.number }),
    httpStatus: 409,
  },
  mcpNotFound: {
    data: wire.object({ resource: wire.enum(['connection', 'grant']), id: wire.string }),
    httpStatus: 404,
  },
  mcpInvalid: {
    data: wire.object({ field: wire.string, message: wire.string }),
    httpStatus: 400,
  },
});

export const ProjectViewCodec = wire.object({
  id: wire.string,
  name: wire.string,
  repositoryPath: wire.string,
  baseBranch: wire.string,
  connected: wire.boolean,
});
export const ProjectLifecycleViewCodec = wire.object({
  id: wire.string,
  name: wire.string,
  lifecycle: wire.enum(['provisioning', 'active', 'archiving', 'archived', 'restoring', 'failed', 'deleting']),
  repositoryReference: wire.nullable(wire.string),
  baseBranch: wire.string,
  revision: wire.number,
  archivedAt: wire.nullable(wire.date),
  updatedAt: wire.date,
});

export const ProjectOperationViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  workspaceId: wire.nullable(wire.string),
  kind: wire.string,
  state: wire.enum(['queued', 'claimed', 'running', 'blocked', 'failed', 'succeeded', 'canceled']),
  error: wire.nullable(wire.string),
  revision: wire.number,
  createdAt: wire.date,
  updatedAt: wire.date,
});


const statusCountsCodec = wire.object({
  green: wire.number,
  blue: wire.number,
  orange: wire.number,
  red: wire.number,
});
export const WorkspaceStatusCodec = wire.object({
  primaryColor: wire.enum(['dim', 'green', 'blue', 'orange', 'red']),
  agents: statusCountsCodec,
  services: wire.object({ green: wire.number, red: wire.number }),
  terminals: wire.object({ green: wire.number, red: wire.number }),
});
export const BaseSpaceViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  kind: wire.literal('base'),
  name: wire.string,
  branch: wire.string,
  closedAt: wire.nullable(wire.date),
  possessedBy: wire.nullable(wire.string),
  spaceGeneration: wire.number,
  status: WorkspaceStatusCodec,
});
const ActivityReasonCodec = wire.union([
  wire.object({ kind: wire.literal('turn') }),
  wire.object({ kind: wire.literal('compacting') }),
  wire.object({ kind: wire.literal('retry'), attempt: wire.number, next: wire.number }),
  wire.object({ kind: wire.literal('human'), questions: wire.number, permissions: wire.number }),
  wire.object({ kind: wire.literal('queued'), steering: wire.number, followUp: wire.number }),
  wire.object({ kind: wire.literal('subagents'), count: wire.number }),
]);
export const SessionActivityCodec = wire.object({
  active: wire.boolean,
  reasons: wire.array(ActivityReasonCodec),
});

export const WorkspaceRelationsCodec = wire.object({
  dependsOn: wire.array(wire.string),
  relatedTo: wire.array(wire.string),
  stackedOn: wire.nullable(wire.string),
});
export const StackFindingCodec = wire.object({
  code: wire.string,
  message: wire.string,
  workspaceId: wire.nullable(wire.string),
});
export const WorkspaceStackCodec = wire.object({
  blockedBy: wire.array(wire.string),
  blocking: wire.array(wire.string),
  findings: wire.array(StackFindingCodec),
});
export const WorkspaceViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  projectName: wire.string,
  name: wire.string,
  branch: wire.string,
  rootPath: wire.string,
  phase: wire.enum(['plan', 'code', 'review', 'ship']),
  closedAt: wire.nullable(wire.date),
  possessedBy: wire.nullable(wire.string),
  spaceGeneration: wire.number,
  possessionGeneration: wire.nullable(wire.number),
  status: WorkspaceStatusCodec,
  relations: WorkspaceRelationsCodec,
  stack: WorkspaceStackCodec,
});

export const SpaceLifecycleViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  kind: wire.enum(['base', 'worktree']),
  state: wire.enum(['active', 'closed', 'archived']),
  machineId: wire.nullable(wire.string),
  generation: wire.number,
});
export const FleetMachineViewCodec = wire.object({
  id: wire.string,
  label: wire.string,
  state: wire.enum(['provisioning', 'online', 'sleeping', 'offline', 'resuming', 'deleting', 'error']),
  rpcEndpoint: wire.nullable(wire.string),
  kind: wire.enum(['physical', 'sandbox']),
  notes: wire.string,
  provider: wire.enum(['physical', 'cloudflare-sandbox']),
  desiredState: wire.enum(['online', 'offline', 'removed']),
  lifecycleRevision: wire.number,
  operationId: wire.nullable(wire.string),
  error: wire.nullable(wire.string),
});
export const FleetMachineEventCodec = wire.object({
  type: wire.enum(['upsert', 'remove']),
  machineId: wire.string,
  machine: wire.nullable(FleetMachineViewCodec),
});
export const UserSettingsViewCodec = wire.object({
  version: wire.literal(1),
  revision: wire.number,
  onboardingComplete: wire.boolean,
  profile: wire.object({ displayName: wire.string, handle: wire.nullable(wire.string) }),
  git: wire.object({ authorName: wire.string, authorEmail: wire.string }),
  defaults: wire.object({ machineId: wire.nullable(wire.string), enterAction: wire.enum(['queue', 'steer']), appearance: wire.enum(['system', 'light', 'dark']) }),
  updatedAt: wire.string,
  updatedBy: wire.string,
});
export const OmpConfigDocumentCodec = wire.object({
  generation: wire.number,
  content: wire.string,
  checksum: wire.string,
  updatedAt: wire.string,
  updatedBy: wire.string,
});
export const OmpSettingSchemaItemCodec = wire.object({
  path: wire.string,
  tab: wire.string,
  label: wire.string,
  description: wire.nullable(wire.string),
  kind: wire.enum(['boolean', 'enum', 'number', 'string', 'array', 'record', 'other']),
  valueJson: wire.string,
  options: wire.array(wire.string),
  credential: wire.boolean,
});
export const SettingsSyncStateCodec = wire.object({
  status: wire.enum(['connecting', 'synced', 'offline', 'conflict', 'error']),
  message: wire.nullable(wire.string),
});
export const GitIdentityViewCodec = wire.object({
  generation: wire.number,
  publicKey: wire.string,
  fingerprint: wire.string,
  updatedAt: wire.string,
  updatedBy: wire.string,
});
export const SettingsChangedEventCodec = wire.object({
  userRevision: wire.number,
  ompGeneration: wire.number,
  sync: SettingsSyncStateCodec,
});
export const ProjectSecretMetadataCodec = wire.object({
  projectId: wire.string,
  name: wire.string,
  revision: wire.number,
  updatedAt: wire.string,
  updatedBy: wire.string,
});

export const EnvironmentExecutionViewCodec = wire.object({
  id: wire.string,
  kind: wire.enum(['check', 'script']),
  label: wire.string,
  command: wire.string,
  hash: wire.string,
  approval: wire.nullable(wire.enum(['project', 'workspace'])),
  phase: wire.nullable(wire.enum(['setup', 'select', 'remove'])),
  fileName: wire.nullable(wire.string),
});
export const EnvironmentRunViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  spaceId: wire.string,
  phase: wire.enum(['checks', 'setup', 'select', 'remove']),
  status: wire.enum(['running', 'succeeded', 'failed']),
  terminalName: wire.nullable(wire.string),
  executionHashes: wire.array(wire.string),
  results: wire.array(wire.object({ id: wire.string, exitCode: wire.number, output: wire.string })),
  output: wire.string,
  exitCode: wire.nullable(wire.number),
  startedAt: wire.string,
  finishedAt: wire.nullable(wire.string),
});
export const WorkspaceEnvironmentViewCodec = wire.object({
  spaceId: wire.string,
  projectId: wire.string,
  bundleJson: wire.string,
  selectedProfile: wire.string,
  effective: wire.object({
    name: wire.string,
    checks: wire.array(wire.string),
    secrets: wire.array(wire.string),
    values: wire.array(wire.string),
    notes: wire.array(wire.string),
  }),
  configuredSecrets: wire.array(wire.string),
  values: wire.object({
    global: wire.record(wire.string),
    project: wire.record(wire.string),
    workspace: wire.record(wire.string),
    effective: wire.record(wire.string),
  }),
  executions: wire.array(EnvironmentExecutionViewCodec),
  runs: wire.array(EnvironmentRunViewCodec),
});
export const EnvironmentExecutionResultCodec = wire.object({
  id: wire.string,
  hash: wire.string,
  exitCode: wire.number,
  stdout: wire.string,
  stderr: wire.string,
});

export const SessionViewCodec = wire.object({
  projectId: wire.string,
  id: wire.string,
  workspaceId: wire.nullable(wire.string),
  scope: wire.enum(['project', 'workspace']),
  ompSessionId: wire.string,
  state: wire.enum(['opening', 'active', 'draining', 'closed', 'failed']),
  lastEventOffset: wire.number,
  resumePending: wire.boolean,
  createdAt: wire.date,
  activity: SessionActivityCodec,
  renderState: wire.enum(['closed', 'dormant', 'waiting', 'running', 'permission-needed', 'retrying', 'archived']),
  errorMessage: wire.nullable(wire.string),
  updatedAt: wire.date,
});

const SessionRoleCodec = wire.object({
  id: wire.string,
  label: wire.string,
  provider: wire.string,
  model: wire.string,
  thinking: wire.nullable(wire.string),
  current: wire.boolean,
});
const SessionTodoTaskCodec = wire.object({
  content: wire.string,
  status: wire.enum(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']),
  blocker: wire.nullable(wire.string),
});
const SessionTodoPhaseCodec = wire.object({ name: wire.string, tasks: wire.array(SessionTodoTaskCodec) });
const PendingAskQuestionCodec = wire.object({
  id: wire.string,
  question: wire.string,
  header: wire.nullable(wire.string),
  options: wire.array(wire.object({
    label: wire.string,
    description: wire.nullable(wire.string),
    preview: wire.nullable(wire.string),
  })),
  multi: wire.boolean,
  recommended: wire.nullable(wire.number),
});
const PendingAskAnswerCodec = wire.object({
  id: wire.string,
  selectedOptions: wire.array(wire.string),
  customInput: wire.nullable(wire.string),
});
export type PendingAskAnswer = InputOf<typeof PendingAskAnswerCodec>;
export const SessionControlViewCodec = wire.object({
  sessionId: wire.string,
  role: wire.nullable(wire.string),
  roleLabel: wire.nullable(wire.string),
  roles: wire.array(SessionRoleCodec),
  provider: wire.nullable(wire.string),
  models: wire.array(wire.object({ provider: wire.string, id: wire.string, name: wire.string, contextWindow: wire.nullable(wire.number) })),
  model: wire.nullable(wire.string),
  thinking: wire.nullable(wire.string),
  fastMode: wire.boolean,
  approvalMode: wire.enum(['always-ask', 'write', 'yolo']),
  context: wire.nullable(wire.object({ tokens: wire.number, contextWindow: wire.number, percent: wire.number })),
  cost: wire.number,
  todos: wire.array(SessionTodoPhaseCodec),
  queue: wire.object({ steering: wire.array(wire.string), followUp: wire.array(wire.string) }),
  pendingAsk: wire.nullable(wire.object({ id: wire.string, questions: wire.array(PendingAskQuestionCodec) })),
  goal: wire.nullable(wire.object({
    id: wire.string,
    status: wire.enum(['active', 'paused', 'budget-limited', 'complete', 'dropped']),
    objective: wire.string,
    tokenBudget: wire.nullable(wire.number),
    tokensUsed: wire.number,
    timeUsedSeconds: wire.number,
  })),
  history: wire.array(wire.object({ entryId: wire.string, text: wire.string })),
  tree: wire.array(wire.object({
    id: wire.string,
    parentId: wire.nullable(wire.string),
    role: wire.enum(['user', 'assistant']),
    preview: wire.string,
    tools: wire.number,
    sequence: wire.number,
    current: wire.boolean,
    onPath: wire.boolean,
  })),
});
export type SessionControlView = InputOf<typeof SessionControlViewCodec>;

export const TranscriptEventCodec = wire.object({
  sessionId: wire.string,
  ordinal: wire.number,
  kind: wire.string,
  payload: wire.serializable(
    (value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value),
    { id: 'gitspace/transcript-payload/v1' },
  ),
  createdAt: wire.date,
});

export const ArtifactViewCodec = wire.object({
  url: wire.string,
  path: wire.string,
  hash: wire.string,
  size: wire.number,
  mediaType: wire.nullable(wire.string),
  scope: wire.enum(['base', 'workspace']),
  workspaceId: wire.nullable(wire.string),
});
export const WorkspaceTerminalViewCodec = wire.object({
  spaceId: wire.string,
  name: wire.string,
  id: wire.string,
  kind: wire.enum(['user', 'agent', 'lifecycle', 'service']),
  state: wire.enum(['starting', 'running', 'ready', 'restarting', 'stopping', 'exited', 'failed']),
  machineId: wire.string,
  owner: wire.nullable(wire.string),
  command: wire.string,
  cwd: wire.string,
  createdAt: wire.date,
  exitCode: wire.nullable(wire.number),
});
export const WorkspaceTerminalOutputCodec = wire.object({
  spaceId: wire.string,
  name: wire.string,
  state: wire.enum(['starting', 'running', 'ready', 'restarting', 'stopping', 'exited', 'failed']),
  cursor: wire.number,
  data: wire.string,
});

/** Read-only source of a closed space's transcript: the cloud checkpoint, served without opening the space. */
export const BootstrapCheckpointViewCodec = wire.object({
  sessionId: wire.string,
  /** Cloud placement generation the checkpoint belongs to; restore/claim must present it. */
  generation: wire.number,
  /** Machine that published the canonical session last, i.e. where the space was released from. */
  lastMachineId: wire.nullable(wire.string),
});
export type BootstrapCheckpointView = InputOf<typeof BootstrapCheckpointViewCodec>;
export const BootstrapViewCodec = wire.object({
  project: ProjectViewCodec,
  workspaces: wire.array(WorkspaceViewCodec),
  baseSpace: BaseSpaceViewCodec,
  mainAgent: wire.nullable(SessionViewCodec),
  transcript: wire.array(TranscriptEventCodec),
  artifacts: wire.array(ArtifactViewCodec),
  eventOffset: wire.number,
  /** Set when `transcript` came from the cloud checkpoint of a closed space (`mainAgent` is null then). */
  checkpoint: wire.nullable(BootstrapCheckpointViewCodec),
});

export const FactEventCodec = wire.object({
  offset: wire.number,
  projectId: wire.string,
  scope: wire.enum(['machine', 'project', 'workspace', 'session', 'artifact', 'code']),
  entity: wire.string,
  entityId: wire.string,
  revision: wire.number,
  operation: wire.enum(['created', 'updated', 'removed', 'append', 'invalidate', 'code-version']),
  payload: wire.serializable(
    (value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value),
    { id: 'gitspace/fact-payload/v1' },
  ),
  createdAt: wire.date,
});

/** Verified caller for the request; absent only inside tests that bypass the signed handler. */
export interface GitSpaceRpcCaller {
  deviceId: string;
  kind: 'browser' | 'client';
  label: string;
  scope: { kind: 'user' } | { kind: 'project'; projectId: string } | { kind: 'workspace'; workspaceId: string };
  capabilities: readonly string[];
}
export interface GitSpaceRpcContext { caller?: GitSpaceRpcCaller }
export const gitspaceRpc = rpc.context<GitSpaceRpcContext>();

export const bootstrapContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, workspaceId: wire.nullable(wire.string) }))
  .output(BootstrapViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const closeSpaceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.number }))
  .output(SpaceLifecycleViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const reopenSpaceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.number }))
  .output(SpaceLifecycleViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const archiveWorkspaceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.number }))
  .output(SpaceLifecycleViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const restoreWorkspaceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.number }))
  .output(SpaceLifecycleViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const listProjectsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ lifecycle: wire.enum(['all', 'active', 'archived']) }))
  .output(wire.array(ProjectLifecycleViewCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const createProjectContract = gitspaceRpc
  .procedure()
  .input(wire.object({
    name: wire.string,
    baseBranch: wire.string,
    repositoryUrl: wire.nullable(wire.string),
  }))
  .output(wire.object({ project: ProjectLifecycleViewCodec, operation: ProjectOperationViewCodec }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const archiveProjectContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, expectedRevision: wire.number }))
  .output(ProjectLifecycleViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const restoreProjectContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, expectedRevision: wire.number }))
  .output(ProjectLifecycleViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteProjectContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, expectedRevision: wire.number }))
  .output(wire.object({ projectId: wire.string, deleted: wire.boolean }))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const createWorkspaceContract = gitspaceRpc
  .procedure()
  .input(wire.object({
    projectId: wire.string,
    name: wire.string,
    branch: wire.string,
    phase: wire.enum(['plan', 'code', 'review', 'ship']),
    sourceKind: wire.enum(['base', 'branch', 'workspace', 'pull-request', 'tag', 'commit']),
    sourceRef: wire.string,
    /** Extra dependencies beyond the implicit one on a `workspace` source. */
    dependsOn: wire.optional(wire.array(wire.string)),
  }))
  .output(wire.object({ workspace: WorkspaceViewCodec, operation: ProjectOperationViewCodec }))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteWorkspaceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ workspaceId: wire.string }))
  .output(wire.object({ workspaceId: wire.string, deleted: wire.boolean }))
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const listMachinesContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.array(FleetMachineViewCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
export const getUserSettingsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(UserSettingsViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const updateUserSettingsContract = gitspaceRpc
  .procedure()
  .input(wire.object({
    expectedRevision: wire.number,
    onboardingComplete: wire.boolean,
    profile: wire.object({ displayName: wire.string, handle: wire.nullable(wire.string) }),
    git: wire.object({ authorName: wire.string, authorEmail: wire.string }),
    defaults: wire.object({ machineId: wire.nullable(wire.string), enterAction: wire.enum(['queue', 'steer']), appearance: wire.enum(['system', 'light', 'dark']) }),
  }))
  .output(UserSettingsViewCodec)
  .errors({ SettingsConflict: rpcErrors.settingsConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const reserveUserHandleContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedRevision: wire.number, handle: wire.string }))
  .output(UserSettingsViewCodec)
  .errors({ SettingsConflict: rpcErrors.settingsConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const getOmpSettingsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.object({ document: OmpConfigDocumentCodec, schema: wire.array(OmpSettingSchemaItemCodec), sync: SettingsSyncStateCodec }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const updateMachineNotesContract = gitspaceRpc
  .procedure()
  .input(wire.object({ machineId: wire.string, notes: wire.string }))
  .output(FleetMachineViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const sleepMachineContract = gitspaceRpc
  .procedure()
  .input(wire.object({ machineId: wire.string }))
  .output(FleetMachineViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const resumeMachineContract = gitspaceRpc
  .procedure()
  .input(wire.object({ machineId: wire.string }))
  .output(FleetMachineViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const destroyMachineContract = gitspaceRpc
  .procedure()
  .input(wire.object({ machineId: wire.string }))
  .output(wire.object({ machineId: wire.string, removed: wire.boolean }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const getGitIdentityContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.nullable(GitIdentityViewCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const listProjectSecretsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string }))
  .output(wire.array(ProjectSecretMetadataCodec))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const putProjectSecretContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, name: wire.string, value: wire.string }))
  .output(ProjectSecretMetadataCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteProjectSecretContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, name: wire.string }))
  .output(wire.object({ deleted: wire.boolean }))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const getWorkspaceEnvironmentContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const putWorkspaceEnvironmentBundleContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, bundleJson: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const setWorkspaceEnvironmentProfileContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, profile: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const putWorkspaceEnvironmentValueContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, scope: wire.enum(['global', 'project', 'workspace']), name: wire.string, value: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteWorkspaceEnvironmentValueContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, scope: wire.enum(['global', 'project', 'workspace']), name: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const approveWorkspaceEnvironmentExecutionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, scope: wire.enum(['project', 'workspace']), executionHash: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const revokeWorkspaceEnvironmentApprovalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, scope: wire.enum(['project', 'workspace']), executionHash: wire.string }))
  .output(WorkspaceEnvironmentViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const runWorkspaceEnvironmentChecksContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string }))
  .output(wire.array(EnvironmentExecutionResultCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const runWorkspaceEnvironmentPhaseContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, phase: wire.enum(['setup', 'select', 'remove']) }))
  .output(wire.array(EnvironmentExecutionResultCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const listMcpConnectionsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.array(McpConnectionViewCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const createMcpConnectionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connection: McpConnectionDraftCodec }))
  .output(McpConnectionViewCodec)
  .errors({ McpInvalid: rpcErrors.mcpInvalid, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const updateMcpConnectionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string, expectedRevision: wire.number, connection: McpConnectionDraftCodec }))
  .output(McpConnectionViewCodec)
  .errors({ McpNotFound: rpcErrors.mcpNotFound, McpRevisionConflict: rpcErrors.mcpRevisionConflict, McpInvalid: rpcErrors.mcpInvalid, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteMcpConnectionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string, expectedRevision: wire.number }))
  .output(wire.object({ connectionId: wire.string, deleted: wire.boolean }))
  .errors({ McpNotFound: rpcErrors.mcpNotFound, McpRevisionConflict: rpcErrors.mcpRevisionConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const getMcpConnectionStatusContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string }))
  .output(McpConnectionViewCodec)
  .errors({ McpNotFound: rpcErrors.mcpNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const getComposioSetupContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(ComposioSetupViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const putComposioSetupContract = gitspaceRpc
  .procedure()
  .input(wire.object({ apiKey: wire.string }))
  .output(ComposioSetupViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteComposioSetupContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(ComposioSetupViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const listComposioPluginCatalogContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(ComposioPluginCatalogViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const authorizeComposioPluginContract = gitspaceRpc
  .procedure()
  .input(wire.object({ toolkit: wire.string, label: wire.string }))
  .output(ComposioPluginAuthorizationViewCodec)
  .errors({ McpInvalid: rpcErrors.mcpInvalid, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const refreshComposioPluginContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string }))
  .output(McpConnectionViewCodec)
  .errors({ McpNotFound: rpcErrors.mcpNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const listComposioPluginToolsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string }))
  .output(wire.array(ComposioPluginToolViewCodec))
  .errors({ McpNotFound: rpcErrors.mcpNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const updateComposioPluginToolsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string, expectedRevision: wire.number, allowedTools: wire.array(wire.string) }))
  .output(McpConnectionViewCodec)
  .errors({ McpNotFound: rpcErrors.mcpNotFound, McpRevisionConflict: rpcErrors.mcpRevisionConflict, McpInvalid: rpcErrors.mcpInvalid, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const disconnectComposioPluginContract = gitspaceRpc
  .procedure()
  .input(wire.object({ connectionId: wire.string, expectedRevision: wire.number }))
  .output(wire.object({ connectionId: wire.string, deleted: wire.boolean }))
  .errors({ McpNotFound: rpcErrors.mcpNotFound, McpRevisionConflict: rpcErrors.mcpRevisionConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const BrowserRelayStatusCodec = wire.object({
  state: wire.enum(['stopped', 'starting', 'waiting', 'connected', 'error']),
  installed: wire.boolean,
  extensionPath: wire.string,
  chromeExtensionPath: wire.string,
  owned: wire.boolean,
  endpoint: wire.string,
  browserName: wire.nullable(wire.string),
  browserVersion: wire.nullable(wire.string),
  message: wire.nullable(wire.string),
});
export type BrowserRelayStatus = InputOf<typeof BrowserRelayStatusCodec>;

export const getBrowserRelayStatusContract = gitspaceRpc
  .procedure().input(wire.object({})).output(BrowserRelayStatusCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed }).query();
export const setupBrowserRelayContract = gitspaceRpc
  .procedure().input(wire.object({})).output(BrowserRelayStatusCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed }).mutation();
export const startBrowserRelayContract = gitspaceRpc
  .procedure().input(wire.object({})).output(BrowserRelayStatusCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed }).mutation();
export const stopBrowserRelayContract = gitspaceRpc
  .procedure().input(wire.object({})).output(BrowserRelayStatusCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed }).mutation();
export const testBrowserRelayContract = gitspaceRpc
  .procedure().input(wire.object({})).output(BrowserRelayStatusCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed }).mutation();

export const listProjectMcpGrantsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string }))
  .output(wire.array(ProjectMcpGrantViewCodec))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const putProjectMcpGrantContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, connectionId: wire.string, enabled: wire.boolean, projectSpaceEnabled: wire.boolean, workspacesEnabled: wire.boolean, expectedRevision: wire.number }))
  .output(ProjectMcpGrantViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, McpNotFound: rpcErrors.mcpNotFound, McpRevisionConflict: rpcErrors.mcpRevisionConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteProjectMcpGrantContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, connectionId: wire.string, expectedRevision: wire.number }))
  .output(wire.object({ projectId: wire.string, connectionId: wire.string, deleted: wire.boolean }))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, McpNotFound: rpcErrors.mcpNotFound, McpRevisionConflict: rpcErrors.mcpRevisionConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const discoverProjectMcpToolsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string }))
  .output(wire.array(DiscoveredMcpToolViewCodec))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const createSandboxMachineContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(FleetMachineViewCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const setOmpSettingContract = gitspaceRpc
  .procedure()
  .input(wire.object({ path: wire.string, valueJson: wire.string }))
  .output(wire.object({ document: OmpConfigDocumentCodec, schema: wire.array(OmpSettingSchemaItemCodec), sync: SettingsSyncStateCodec }))
  .errors({ SettingsConflict: rpcErrors.settingsConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const machineLifecycleEventsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(FleetMachineEventCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .subscription();
export const settingsEventsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(SettingsChangedEventCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .subscription();

// ── Providers ──
export const ProviderAccountCodec = wire.object({
  id: wire.string,
  type: wire.enum(['oauth', 'api_key']),
  label: wire.string,
  email: wire.nullable(wire.string),
  disabled: wire.boolean,
});
export type ProviderAccount = InputOf<typeof ProviderAccountCodec>;
export const ProviderViewCodec = wire.object({
  id: wire.string,
  name: wire.string,
  available: wire.boolean,
  loginable: wire.boolean,
  authKind: wire.enum(['oauth', 'api_key', 'none']),
  hasAuth: wire.boolean,
  source: wire.nullable(wire.string),
  accounts: wire.array(ProviderAccountCodec),
  hasUsage: wire.boolean,
});
export type ProviderView = InputOf<typeof ProviderViewCodec>;
export const ProviderLoginEventCodec = wire.union([
  wire.object({ type: wire.literal('auth'), url: wire.string, launchUrl: wire.nullable(wire.string), instructions: wire.nullable(wire.string) }),
  wire.object({ type: wire.literal('progress'), message: wire.string }),
  wire.object({ type: wire.literal('prompt'), promptId: wire.string, message: wire.string, placeholder: wire.nullable(wire.string) }),
  wire.object({ type: wire.literal('done'), ok: wire.literal(true), provider: ProviderViewCodec }),
  wire.object({ type: wire.literal('done'), ok: wire.literal(false), error: wire.string }),
]);
export type ProviderLoginEvent = InputOf<typeof ProviderLoginEventCodec>;
export const ProviderUsageLimitCodec = wire.object({
  id: wire.string,
  label: wire.string,
  scope: wire.string,
  window: wire.nullable(wire.string),
  unit: wire.string,
  used: wire.nullable(wire.number),
  limit: wire.nullable(wire.number),
  remaining: wire.nullable(wire.number),
  remainingFraction: wire.nullable(wire.number),
  resetsAt: wire.nullable(wire.string),
  status: wire.nullable(wire.string),
});
export type ProviderUsageLimit = InputOf<typeof ProviderUsageLimitCodec>;
export const ProviderUsageReportCodec = wire.object({
  provider: wire.string,
  account: wire.nullable(wire.string),
  fetchedAt: wire.string,
  limits: wire.array(ProviderUsageLimitCodec),
  notes: wire.array(wire.string),
});
export type ProviderUsageReport = InputOf<typeof ProviderUsageReportCodec>;
export const ProviderUsageCodec = wire.object({
  generatedAt: wire.string,
  reports: wire.array(ProviderUsageReportCodec),
  accountsWithoutUsage: wire.array(wire.string),
  errors: wire.array(wire.object({ provider: wire.string, message: wire.string })),
});
export type ProviderUsage = InputOf<typeof ProviderUsageCodec>;

export const listProvidersContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.object({ providers: wire.array(ProviderViewCodec) }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
export const startProviderLoginContract = gitspaceRpc
  .procedure()
  .input(wire.object({ providerId: wire.string }))
  .output(wire.object({ flowId: wire.string }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const providerLoginEventsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ flowId: wire.string }))
  .output(ProviderLoginEventCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .subscription();
export const respondProviderLoginContract = gitspaceRpc
  .procedure()
  .input(wire.object({ flowId: wire.string, promptId: wire.string, value: wire.string }))
  .output(wire.object({}))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const cancelProviderLoginContract = gitspaceRpc
  .procedure()
  .input(wire.object({ flowId: wire.string }))
  .output(wire.object({}))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const logoutProviderContract = gitspaceRpc
  .procedure()
  .input(wire.object({ providerId: wire.string, credentialId: wire.nullable(wire.string) }))
  .output(wire.object({ provider: ProviderViewCodec }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setProviderApiKeyContract = gitspaceRpc
  .procedure()
  .input(wire.object({ providerId: wire.string, key: wire.string }))
  .output(wire.object({ provider: ProviderViewCodec }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const providerUsageContract = gitspaceRpc
  .procedure()
  .input(wire.object({ providerId: wire.nullable(wire.string), refresh: wire.boolean }))
  .output(ProviderUsageCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
export const AvailableModelCodec = wire.object({ provider: wire.string, id: wire.string, name: wire.string, contextWindow: wire.nullable(wire.number) });
export type AvailableModel = InputOf<typeof AvailableModelCodec>;
/** Models the machine can run right now (authenticated providers only). */
export const DeviceViewCodec = wire.object({
  deviceId: wire.string,
  kind: wire.enum(['browser', 'client']),
  label: wire.string,
  scope: wire.string,
  capabilities: wire.array(wire.string),
  boundAt: wire.string,
  expiresAt: wire.nullable(wire.string),
  revokedAt: wire.nullable(wire.string),
  /** Verifies right now: not revoked, not expired, issuer chain intact. */
  active: wire.boolean,
  /** True when this row is the device making the request. */
  current: wire.boolean,
});
export type DeviceView = InputOf<typeof DeviceViewCodec>;
export const listDevicesContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.array(DeviceViewCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
export const revokeDeviceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ deviceId: wire.string }))
  .output(wire.object({ deviceId: wire.string, revokedAt: wire.string }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const listAvailableModelsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.object({ models: wire.array(AvailableModelCodec) }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();



export const createSessionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ workspaceId: wire.string }))
  .output(SessionViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, WorkspacePossessed: rpcErrors.workspacePossessed, WorkspaceUnpossessed: rpcErrors.workspaceUnpossessed, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const createProjectSessionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string }))
  .output(SessionViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const promptSessionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, text: wire.string, streamingBehavior: wire.enum(['steer', 'followUp']), images: wire.array(wire.object({ data: wire.string, mimeType: wire.string })) }))
  .output(wire.object({ accepted: wire.boolean }))
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, SessionBusy: rpcErrors.sessionBusy, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const UsageTotalsCodec = wire.object({
  requests: wire.number,
  input: wire.number,
  output: wire.number,
  cacheRead: wire.number,
  cacheWrite: wire.number,
  totalTokens: wire.number,
  reasoningTokens: wire.number,
  costUsd: wire.number,
});
export type UsageTotals = InputOf<typeof UsageTotalsCodec>;
export const SessionUsageReportCodec = wire.object({
  sessionId: wire.string,
  /** This session only. */
  totals: UsageTotalsCodec,
  /** Including child (subagent) sessions. */
  totalsDeep: UsageTotalsCodec,
  childSessions: wire.number,
  byModel: wire.array(wire.object({ provider: wire.string, model: wire.string, totals: UsageTotalsCodec })),
  byRole: wire.array(wire.object({ role: wire.string, models: wire.array(wire.string), totals: UsageTotalsCodec })),
  byAgent: wire.array(wire.object({
    agentId: wire.string,
    agent: wire.string,
    selection: wire.enum(['role', 'pinned', 'inherited']),
    model: wire.string,
    spawns: wire.number,
    firstAt: wire.nullable(wire.string),
    lastAt: wire.nullable(wire.string),
    totals: UsageTotalsCodec,
  })),
  warnings: wire.array(wire.string),
});
export type SessionUsageReport = InputOf<typeof SessionUsageReportCodec>;
export const getSessionUsageContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string }))
  .output(SessionUsageReportCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const getSessionControlContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();
export const cycleSessionRoleContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, direction: wire.enum(['forward', 'backward']) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setSessionThinkingContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, thinking: wire.nullable(wire.string) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setSessionFastContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, enabled: wire.boolean }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setSessionModelContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, provider: wire.string, model: wire.string }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setSessionApprovalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, approvalMode: wire.enum(['always-ask', 'write', 'yolo']) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setSessionGoalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, enabled: wire.boolean, objective: wire.nullable(wire.string) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const compactSessionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, instructions: wire.nullable(wire.string) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const clearSessionQueueContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const removeSessionQueuedMessageContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, kind: wire.enum(['steering', 'followUp']), index: wire.integer({ min: 0 }) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const promoteSessionQueuedMessageContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, index: wire.integer({ min: 0 }) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const answerSessionAskContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, id: wire.string, answers: wire.array(PendingAskAnswerCodec) }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const stopSessionTurnContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const navigateSessionTreeContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, entryId: wire.string }))
  .output(SessionControlViewCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setWorkspacePhaseContract = gitspaceRpc
  .procedure()
  .input(wire.object({ workspaceId: wire.string, phase: wire.enum(['plan', 'code', 'review', 'ship']) }))
  .output(WorkspaceViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const setWorkspaceRelationsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ workspaceId: wire.string, dependsOn: wire.array(wire.string), relatedTo: wire.array(wire.string), stackedOn: wire.nullable(wire.string) }))
  .output(WorkspaceViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
/** Git position of a stacked workspace relative to its `stackedOn` parent, computed on the child's holder. */
export const StackStatusCodec = wire.object({
  parentId: wire.nullable(wire.string),
  parentBranch: wire.nullable(wire.string),
  baseBranch: wire.string,
  mergeBase: wire.nullable(wire.string),
  parentAhead: wire.number,
  parentMerged: wire.enum(['merged', 'not-merged', 'unknown']),
  /** Agent-facing rebase instruction, or null when nothing needs to happen. */
  instruction: wire.nullable(wire.string),
});
export type StackStatus = InputOf<typeof StackStatusCodec>;
export const stackStatusContract = gitspaceRpc
  .procedure()
  .input(wire.object({ workspaceId: wire.string }))
  .output(StackStatusCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const subagentTranscriptContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, subagentId: wire.string }))
  .output(wire.array(TranscriptEventCodec))
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();
export const subagentTranscriptEventsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string, subagentId: wire.string, afterOrdinal: wire.number }))
  .output(TranscriptEventCodec)
  .errors({ SessionNotFound: rpcErrors.sessionNotFound, OperationFailed: rpcErrors.operationFailed })
  .subscription();
export const listWorkspaceTerminalsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string }))
  .output(wire.array(WorkspaceTerminalViewCodec))
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const createWorkspaceTerminalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string }))
  .output(WorkspaceTerminalViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const readWorkspaceTerminalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, name: wire.string, cursor: wire.nullable(wire.number) }))
  .output(WorkspaceTerminalOutputCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, TerminalNotFound: rpcErrors.terminalNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const sendWorkspaceTerminalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, name: wire.string, data: wire.string }))
  .output(WorkspaceTerminalViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, TerminalNotFound: rpcErrors.terminalNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();


export const stopWorkspaceTerminalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, name: wire.string }))
  .output(WorkspaceTerminalViewCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, TerminalNotFound: rpcErrors.terminalNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();


export const listProjectCronsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string }))
  .output(wire.array(ProjectCronViewCodec))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const createProjectCronContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, draft: ProjectCronDraftCodec }))
  .output(ProjectCronViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, CronInvalid: projectCronErrors.cronInvalid, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const updateProjectCronContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, cronId: wire.string, expectedRevision: wire.integer({ min: 1 }), draft: ProjectCronDraftCodec }))
  .output(ProjectCronViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, CronNotFound: projectCronErrors.cronNotFound, CronRevisionConflict: projectCronErrors.cronRevisionConflict, CronInvalid: projectCronErrors.cronInvalid, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const deleteProjectCronContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, cronId: wire.string, expectedRevision: wire.integer({ min: 1 }) }))
  .output(wire.object({ projectId: wire.string, cronId: wire.string, deleted: wire.boolean }))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, CronNotFound: projectCronErrors.cronNotFound, CronRevisionConflict: projectCronErrors.cronRevisionConflict, CronAlreadyRunning: projectCronErrors.cronAlreadyRunning, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const runProjectCronNowContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, cronId: wire.string }))
  .output(ProjectCronRunViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, CronNotFound: projectCronErrors.cronNotFound, CronAlreadyRunning: projectCronErrors.cronAlreadyRunning, OperationFailed: rpcErrors.operationFailed })
  .mutation();

export const projectCronHistoryContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, cronId: wire.string, limit: wire.optional(wire.integer({ min: 1, max: 200 })) }))
  .output(wire.array(ProjectCronRunViewCodec))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, CronNotFound: projectCronErrors.cronNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

const inspectorSpaceRequestCodec = wire.object({
  spaceId: wire.string,
  expectedGeneration: wire.integer({ min: 0 }),
});
const inspectorRepositoryModeCodec = wire.enum(['current', 'working', 'staged', 'base']);
const inspectorReadErrors = {
  WorkspaceNotFound: rpcErrors.workspaceNotFound,
  SpaceGenerationConflict: rpcErrors.spaceGenerationConflict,
  InspectorState: rpcErrors.inspectorState,
  OperationFailed: rpcErrors.operationFailed,
};
const inspectorMutationErrors = {
  ...inspectorReadErrors,
  InspectorConflict: rpcErrors.inspectorConflict,
};

export const listSkillsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string }))
  .output(wire.array(SkillViewCodec))
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

export const updateSkillContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, update: SkillUpdateCodec }))
  .output(SkillViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, SkillConflict: rpcErrors.skillConflict, OperationFailed: rpcErrors.operationFailed })
  .mutation();

/** Canonical inspection context; never materializes a repository or opens a workspace. */
export const InspectorBootstrapViewCodec = wire.object({
  identity: InspectorIdentityCodec,
  project: InspectorProjectCodec,
  workspace: InspectorWorkspaceCodec,
  workspaces: wire.array(InspectorWorkspaceCodec),
  machines: wire.array(FleetMachineViewCodec),
  placement: wire.nullable(wire.object({
    state: wire.enum(['open', 'closing', 'closed', 'opening']),
    machineId: wire.nullable(wire.string),
    generation: wire.number,
    updatedAt: wire.string,
  })),
  overview: InspectorOverviewCodec,
  artifacts: wire.array(ArtifactViewCodec),
  checkpoint: wire.nullable(wire.object({
    sessionId: wire.string,
    generation: wire.number,
    revision: wire.number,
    lastMachineId: wire.nullable(wire.string),
    createdAt: wire.string,
  })),
  savedTranscript: wire.object({
    status: wire.enum(['available', 'unavailable', 'none']),
    reason: wire.nullable(wire.string),
    events: wire.array(TranscriptEventCodec),
  }),
});
export type InspectorBootstrapView = InputOf<typeof InspectorBootstrapViewCodec>;
export const inspectorBootstrapContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, workspaceId: wire.nullable(wire.string) }))
  .output(InspectorBootstrapViewCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound, WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .query();

/** Read-only live-holder decision; unlike fleet reconciliation, this cannot resume a machine. */
export const inspectorAvailabilityContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, workspaceId: wire.nullable(wire.string) }))
  .output(wire.object({ runtimeAvailable: wire.boolean }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();

export const inspectorOverviewContract = gitspaceRpc
  .procedure()
  .input(inspectorSpaceRequestCodec)
  .output(InspectorOverviewCodec)
  .errors(inspectorReadErrors)
  .query();

export const inspectorJournalContract = gitspaceRpc
  .procedure()
  .input(inspectorSpaceRequestCodec)
  .output(wire.array(JournalEntryViewCodec))
  .errors(inspectorReadErrors)
  .query();

export const inspectorReviewThreadsContract = gitspaceRpc
  .procedure()
  .input(inspectorSpaceRequestCodec)
  .output(wire.array(ReviewThreadViewCodec))
  .errors(inspectorReadErrors)
  .query();

export const inspectorServicesContract = gitspaceRpc
  .procedure()
  .input(inspectorSpaceRequestCodec)
  .output(wire.array(ServiceViewCodec))
  .errors(inspectorReadErrors)
  .query();

export const startWorkspaceServiceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), serviceName: wire.string }))
  .output(ServiceViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const stopWorkspaceServiceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), serviceName: wire.string }))
  .output(ServiceViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const InspectorArtifactContentCodec = wire.object({
  url: wire.string,
  mediaType: wire.nullable(wire.string),
  base64: wire.string,
  text: wire.nullable(wire.string),
});

export const inspectorReadArtifactContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), url: wire.string }))
  .output(InspectorArtifactContentCodec)
  .errors(inspectorReadErrors)
  .query();

export const inspectorWriteArtifactContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), url: wire.string, mediaType: wire.nullable(wire.string), base64: wire.string }))
  .output(ArtifactViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorRepositoryTreeContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), mode: inspectorRepositoryModeCodec, path: wire.nullable(wire.string) }))
  .output(wire.array(RepositoryTreeEntryCodec))
  .errors(inspectorReadErrors)
  .query();

export const inspectorRepositoryStatusContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), mode: inspectorRepositoryModeCodec, path: wire.nullable(wire.string) }))
  .output(wire.array(RepositoryStatusEntryCodec))
  .errors(inspectorReadErrors)
  .query();

export const inspectorRepositoryFileContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), mode: inspectorRepositoryModeCodec, path: wire.string }))
  .output(RepositoryFileViewCodec)
  .errors(inspectorReadErrors)
  .query();

export const inspectorRepositoryDiffContract = gitspaceRpc
  .procedure()
  .input(wire.object({ spaceId: wire.string, expectedGeneration: wire.integer({ min: 0 }), mode: inspectorRepositoryModeCodec, path: wire.nullable(wire.string), baseRef: wire.nullable(wire.string) }))
  .output(RepositoryDiffViewCodec)
  .errors(inspectorReadErrors)
  .query();

export const inspectorPutGoalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: PutGoalInputCodec }))
  .output(GoalRecordViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorAttachRequirementEvidenceContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: AttachRequirementEvidenceInputCodec }))
  .output(GoalRecordViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorPutWorkflowContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: PutWorkflowInputCodec }))
  .output(WorkflowViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorWaiveWorkflowGateContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: WaiveWorkflowGateInputCodec }))
  .output(WorkflowViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorPutRubricContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: PutRubricInputCodec }))
  .output(RubricViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorAppendRubricJudgmentContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: AppendRubricJudgmentInputCodec }))
  .output(RubricViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorStartJournalPhaseContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: StartJournalPhaseInputCodec }))
  .output(JournalEntryViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorEndJournalPhaseContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: EndJournalPhaseInputCodec }))
  .output(JournalEntryViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorAppendJournalEntryContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: AppendJournalEntryInputCodec }))
  .output(JournalEntryViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorPutChangeGuideContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: PutChangeGuideInputCodec }))
  .output(ChangeGuideViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorAnalyzeChangeGuideContract = gitspaceRpc
  .procedure()
  .input(AnalyzeChangeGuideInputCodec)
  .output(ChangeGuideWorksheetCodec)
  .errors(inspectorReadErrors)
  .mutation();

export const inspectorSubmitChangeGuideContract = gitspaceRpc
  .procedure()
  .input(SubmitChangeGuideInputCodec)
  .output(ChangeGuideViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorMarkGuideSectionReadContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: MarkGuideSectionReadInputCodec }))
  .output(ChangeGuideViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorSetGuideApprovalContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: SetGuideApprovalInputCodec }))
  .output(ChangeGuideViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorCreateReviewThreadContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: CreateReviewThreadInputCodec }))
  .output(ReviewThreadViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorAppendReviewMessageContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: AppendReviewMessageInputCodec }))
  .output(ReviewThreadViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

export const inspectorResolveReviewThreadContract = gitspaceRpc
  .procedure()
  .input(wire.object({ expectedGeneration: wire.integer({ min: 0 }), input: ResolveReviewThreadInputCodec }))
  .output(ReviewThreadViewCodec)
  .errors(inspectorMutationErrors)
  .mutation();

/** Where every space of the account lives right now; the routing table for clients that span machines. */
export const SpacePlacementViewCodec = wire.object({
  spaceId: wire.string,
  projectId: wire.string,
  kind: wire.enum(['base', 'worktree']),
  holderId: wire.string,
  state: wire.string,
  /** The holder's RPC endpoint, null when it is unknown or the holder is offline. */
  endpoint: wire.nullable(wire.string),
});
export type SpacePlacementView = InputOf<typeof SpacePlacementViewCodec>;
export const placementsContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(wire.object({
    /** The answering machine, so a client can map it back to the URL it already uses. */
    machineId: wire.string,
    spaces: wire.array(SpacePlacementViewCodec),
  }))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
/** Space and holder of a session id, for routing session calls to the right machine. */
export const locateSessionContract = gitspaceRpc
  .procedure()
  .input(wire.object({ sessionId: wire.string }))
  .output(wire.nullable(SpacePlacementViewCodec))
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
/** Self-development: GitSpace built from a workspace, launched across account-owned targets. */
export const ReleaseStatusWireCodec = wire.enum(['pending', 'applied', 'failed', 'skipped']);
export const ReleaseTargetWireCodec = wire.enum(['worker', 'machine', 'omp', 'frontend']);
export const ReleaseArtifactWireCodec = wire.object({ key: wire.string, hash: wire.string, size: wire.number });
export const OmpReleaseMetadataWireCodec = wire.object({
  upstreamVersion: wire.string,
  bunVersion: wire.string,
  packages: wire.record(wire.string),
  patches: wire.array(wire.object({ path: wire.string, hash: wire.string })),
});
export const ReleaseRecordWireCodec = wire.object({
  sha: wire.string,
  label: wire.string,
  workspaceId: wire.nullable(wire.string),
  builtBy: wire.string,
  createdAt: wire.string,
  artifacts: wire.object({ worker: wire.nullable(ReleaseArtifactWireCodec), machine: wire.nullable(ReleaseArtifactWireCodec), omp: wire.nullable(ReleaseArtifactWireCodec), frontend: wire.nullable(ReleaseArtifactWireCodec) }),
  omp: wire.nullable(OmpReleaseMetadataWireCodec),
  status: wire.object({ worker: ReleaseStatusWireCodec, frontend: ReleaseStatusWireCodec, machines: wire.record(ReleaseStatusWireCodec), omps: wire.record(ReleaseStatusWireCodec) }),
  error: wire.nullable(wire.string),
});
/** A launch in flight (or the last one) on the answering machine; phases arrive as `deployment` fact events too. */
export const LaunchProgressWireCodec = wire.object({
  launchId: wire.string,
  workspaceId: wire.string,
  targets: wire.array(ReleaseTargetWireCodec),
  sha: wire.nullable(wire.string),
  phase: wire.string,
  message: wire.string,
  status: wire.enum(['running', 'succeeded', 'failed']),
  error: wire.nullable(wire.string),
  startedAt: wire.string,
  updatedAt: wire.string,
});
export type LaunchProgressView = InputOf<typeof LaunchProgressWireCodec>;
export const DeploymentStatusWireCodec = wire.object({
  desired: wire.object({ worker: wire.nullable(wire.string), machine: wire.nullable(wire.string), omp: wire.nullable(wire.string), frontend: wire.nullable(wire.string), updatedAt: wire.string }),
  current: wire.object({
    worker: wire.object({ sha: wire.nullable(wire.string), version: wire.nullable(wire.string) }),
    machines: wire.record(wire.object({ sha: wire.nullable(wire.string), ompSha: wire.nullable(wire.string), generation: wire.nullable(wire.string) })),
  }),
  releases: wire.array(ReleaseRecordWireCodec),
  /** This machine's own running generation, so the caller can tell home from the fleet. */
  thisMachine: wire.object({ machineId: wire.string, sha: wire.nullable(wire.string), ompSha: wire.nullable(wire.string), ompDraining: wire.number, generation: wire.nullable(wire.string) }),
  launch: wire.nullable(LaunchProgressWireCodec),
});
export type DeploymentStatusView = InputOf<typeof DeploymentStatusWireCodec>;
export const deploymentStatusContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(DeploymentStatusWireCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .query();
/** Start building the workspace into a release; returns at once, progress streams as `deployment` fact events and `deployment.status.launch`. */
export const deploymentLaunchContract = gitspaceRpc
  .procedure()
  .input(wire.object({ workspaceId: wire.string, targets: wire.array(ReleaseTargetWireCodec) }))
  .output(LaunchProgressWireCodec)
  .errors({ WorkspaceNotFound: rpcErrors.workspaceNotFound, OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const deploymentRevertContract = gitspaceRpc
  .procedure()
  .input(wire.object({}))
  .output(DeploymentStatusWireCodec)
  .errors({ OperationFailed: rpcErrors.operationFailed })
  .mutation();
export const machineEventsContract = gitspaceRpc
  .procedure()
  .input(wire.object({ projectId: wire.string, afterOffset: wire.number }))
  .output(FactEventCodec)
  .errors({ ProjectNotFound: rpcErrors.projectNotFound })
  .subscription();

export const gitspaceContract = gitspaceRpc.contract({
  bootstrap: bootstrapContract,
  machines: listMachinesContract,
  machine: {
    events: machineLifecycleEventsContract,
    updateNotes: updateMachineNotesContract,
    createSandbox: createSandboxMachineContract,
    sleep: sleepMachineContract,
    resume: resumeMachineContract,
    destroy: destroyMachineContract,
  },
  settings: {
    get: getUserSettingsContract,
    git: { get: getGitIdentityContract },
    update: updateUserSettingsContract,
    reserveHandle: reserveUserHandleContract,
    omp: { get: getOmpSettingsContract, set: setOmpSettingContract },
    events: settingsEventsContract,
  },
  providers: {
    list: listProvidersContract,
    login: {
      start: startProviderLoginContract,
      events: providerLoginEventsContract,
      respond: respondProviderLoginContract,
      cancel: cancelProviderLoginContract,
    },
    logout: logoutProviderContract,
    apiKey: { set: setProviderApiKeyContract },
    usage: providerUsageContract,
    models: listAvailableModelsContract,
  },
  devices: { list: listDevicesContract, revoke: revokeDeviceContract },
  deployment: { status: deploymentStatusContract, launch: deploymentLaunchContract, revert: deploymentRevertContract },
  secrets: {
    list: listProjectSecretsContract,
    put: putProjectSecretContract,
    delete: deleteProjectSecretContract,
  },
  environment: {
    get: getWorkspaceEnvironmentContract,
    putBundle: putWorkspaceEnvironmentBundleContract,
    setProfile: setWorkspaceEnvironmentProfileContract,
    putValue: putWorkspaceEnvironmentValueContract,
    deleteValue: deleteWorkspaceEnvironmentValueContract,
    approve: approveWorkspaceEnvironmentExecutionContract,
    revokeApproval: revokeWorkspaceEnvironmentApprovalContract,
    runChecks: runWorkspaceEnvironmentChecksContract,
    runPhase: runWorkspaceEnvironmentPhaseContract,
  },
  mcp: {
    connections: {
      list: listMcpConnectionsContract,
      create: createMcpConnectionContract,
      update: updateMcpConnectionContract,
      delete: deleteMcpConnectionContract,
      status: getMcpConnectionStatusContract,
    },
    composio: {
      setup: {
        get: getComposioSetupContract,
        put: putComposioSetupContract,
        delete: deleteComposioSetupContract,
      },
      catalog: listComposioPluginCatalogContract,
      authorize: authorizeComposioPluginContract,
      refresh: refreshComposioPluginContract,
      tools: listComposioPluginToolsContract,
      updateTools: updateComposioPluginToolsContract,
      disconnect: disconnectComposioPluginContract,
    },
    grants: {
      list: listProjectMcpGrantsContract,
      put: putProjectMcpGrantContract,
      delete: deleteProjectMcpGrantContract,
    },
    discover: discoverProjectMcpToolsContract,
  },
  browserRelay: {
    status: getBrowserRelayStatusContract,
    setup: setupBrowserRelayContract,
    start: startBrowserRelayContract,
    stop: stopBrowserRelayContract,
    test: testBrowserRelayContract,
  },
  crons: {
    list: listProjectCronsContract,
    create: createProjectCronContract,
    update: updateProjectCronContract,
    delete: deleteProjectCronContract,
    runNow: runProjectCronNowContract,
    history: projectCronHistoryContract,
  },
  skills: { list: listSkillsContract, update: updateSkillContract },
  inspector: {
    bootstrap: inspectorBootstrapContract,
    availability: inspectorAvailabilityContract,
    overview: inspectorOverviewContract,
    goal: {
      put: inspectorPutGoalContract,
      attachEvidence: inspectorAttachRequirementEvidenceContract,
    },
    workflow: {
      put: inspectorPutWorkflowContract,
      waiveGate: inspectorWaiveWorkflowGateContract,
    },
    rubric: {
      put: inspectorPutRubricContract,
      appendJudgment: inspectorAppendRubricJudgmentContract,
    },
    journal: {
      list: inspectorJournalContract,
      startPhase: inspectorStartJournalPhaseContract,
      endPhase: inspectorEndJournalPhaseContract,
      append: inspectorAppendJournalEntryContract,
    },
    guide: {
      put: inspectorPutChangeGuideContract,
      analyze: inspectorAnalyzeChangeGuideContract,
      submit: inspectorSubmitChangeGuideContract,
      markSectionRead: inspectorMarkGuideSectionReadContract,
      setApproval: inspectorSetGuideApprovalContract,
    },
    review: {
      list: inspectorReviewThreadsContract,
      create: inspectorCreateReviewThreadContract,
      reply: inspectorAppendReviewMessageContract,
      resolve: inspectorResolveReviewThreadContract,
    },
    repository: {
      tree: inspectorRepositoryTreeContract,
      status: inspectorRepositoryStatusContract,
      file: inspectorRepositoryFileContract,
      diff: inspectorRepositoryDiffContract,
    },
    artifacts: { read: inspectorReadArtifactContract, write: inspectorWriteArtifactContract },
    services: { list: inspectorServicesContract, start: startWorkspaceServiceContract, stop: stopWorkspaceServiceContract },
  },
  project: {
    list: listProjectsContract,
    create: createProjectContract,
    archive: archiveProjectContract,
    restore: restoreProjectContract,
    delete: deleteProjectContract,
  },
  space: {
    close: closeSpaceContract,
    reopen: reopenSpaceContract,
  },
  workspace: {
    create: createWorkspaceContract,
    archive: archiveWorkspaceContract,
    restore: restoreWorkspaceContract,
    delete: deleteWorkspaceContract,
    setPhase: setWorkspacePhaseContract,
    setRelations: setWorkspaceRelationsContract,
    stackStatus: stackStatusContract,
  },
  subagents: { transcript: subagentTranscriptContract, events: subagentTranscriptEventsContract },
  placements: placementsContract,
  session: {
    locate: locateSessionContract,
    create: createSessionContract,
    createProject: createProjectSessionContract,
    prompt: promptSessionContract,
    control: getSessionControlContract,
    usage: getSessionUsageContract,
    cycleRole: cycleSessionRoleContract,
    setThinking: setSessionThinkingContract,
    setApproval: setSessionApprovalContract,
    setFast: setSessionFastContract,
    setModel: setSessionModelContract,
    setGoal: setSessionGoalContract,
    compact: compactSessionContract,
    navigateTree: navigateSessionTreeContract,
    clearQueue: clearSessionQueueContract,
    removeQueuedMessage: removeSessionQueuedMessageContract,
    promoteQueuedMessage: promoteSessionQueuedMessageContract,
    answerAsk: answerSessionAskContract,
    stop: stopSessionTurnContract,
  },
  terminals: {
    list: listWorkspaceTerminalsContract,
    create: createWorkspaceTerminalContract,
    read: readWorkspaceTerminalContract,
    send: sendWorkspaceTerminalContract,
    stop: stopWorkspaceTerminalContract,
  },
  events: machineEventsContract,
});
