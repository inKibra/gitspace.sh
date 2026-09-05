import {
  createSignedControlRequest,
  type AppendJournalEntryInput,
  type AppendReviewMessageInput,
  type AppendRubricJudgmentInput,
  type AttachRequirementEvidenceInput,
  type ChangeGuideView,
  type CanonicalArtifactPromotion,
  type CanonicalArtifactScope,
  type CanonicalSession,
  type HostedServiceRoute,
  type ComposioMcpMaterialization,
  type ComposioPluginAuthorization,
  type ComposioPluginCatalog,
  type ComposioPluginTool,
  type ComposioSetup,
  type CloudProjectOperation,
  type CloudProjectSummary,
  type CloudWorkspaceDefinition,
  type ControlOperation,
  type DeploymentStatus,
  type ReleaseRecord,
  type ReleaseTarget,
  type StageReleaseInput,
  type TenantDesired,
  type CreateReviewThreadInput,
  type EndJournalPhaseInput,
  type GitIdentityDocument,
  type GitIdentityUpdate,
  type GoalRecordView,
  type InspectorIdentity,
  type InspectorOverview,
  type JournalEntryView,
  type MarkGuideSectionReadInput,
  type OmpConfigDocument,
  type McpAuditEvent,
  type McpConnection,
  type McpConnectionDraft,
  type McpConnectionStatus,
  type OmpConfigUpdate,
  type ProjectCronDraft,
  type ProjectCronRunView,
  type DeviceGrantRecord,
  type ProjectEvent,
  type ProjectCronView,
  type PutChangeGuideInput,
  type PutGoalInput,
  type PutRubricInput,
  type PutWorkflowInput,
  type ResolveReviewThreadInput,
  type ReviewAnchorContext,
  type ReviewThreadView,
  type RubricView,
  type ProjectMcpGrant,
  type SetGuideApprovalInput,
  type SkillUpdate,
  type SkillView,
  type SignedControlRequest,
  type StartJournalPhaseInput,
  type UserSettings,
  type UserSettingsUpdate,
  type WaiveWorkflowGateInput,
  type WorkflowView,
} from '@gitspace/protocol';
import type { CheckpointBlobStore, SpaceCheckpointAuthority } from './portable-space-lifecycle.js';

export class CloudSpaceAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CloudSpaceAuthorityError';
  }
}

export interface ProjectSecretMetadata {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

interface SignedCloudRequestOptions {
  baseUrl: string;
  userId: string;
  machineId: string;
  signingPrivateKey: Uint8Array;
  fetcher?: typeof fetch;
}

function signedRequest(options: SignedCloudRequestOptions, operation: ControlOperation, payload: Record<string, unknown>): SignedControlRequest {
  return createSignedControlRequest({
    userId: options.userId,
    machineId: options.machineId,
    operation,
    payload,
    signingPrivateKey: options.signingPrivateKey,
  });
}

function encodedRequest(request: SignedControlRequest): string {
  return Buffer.from(JSON.stringify(request)).toString('base64url');
}

function objectUrl(baseUrl: string, key: string): URL {
  if (!key || key.startsWith('/') || key.includes('..')) throw new Error(`Invalid application object key ${key}`);
  return new URL(`/v1/data/${key.split('/').map(encodeURIComponent).join('/')}`, baseUrl);
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}
function optionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

function projectCronRunView(value: ProjectCronRunView): ProjectCronRunView {
  return {
    ...value,
    scheduledFor: new Date(String(value.scheduledFor)),
    claimedAt: optionalDate(value.claimedAt),
    startedAt: optionalDate(value.startedAt),
    completedAt: optionalDate(value.completedAt),
    createdAt: new Date(String(value.createdAt)),
  };
}

function projectCronView(value: ProjectCronView): ProjectCronView {
  return {
    ...value,
    nextRunAt: optionalDate(value.nextRunAt),
    lastRunAt: optionalDate(value.lastRunAt),
    createdAt: new Date(String(value.createdAt)),
    updatedAt: new Date(String(value.updatedAt)),
  };
}


export class CloudDataCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly options: SignedCloudRequestOptions) {}

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    const hash = hashBytes(bytes);
    const request = signedRequest(this.options, 'data.put', { key, hash, size: bytes.byteLength });
    const response = await (this.options.fetcher ?? fetch)(objectUrl(this.options.baseUrl, key), {
      method: 'PUT',
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': 'application/octet-stream',
        'x-gitspace-control': encodedRequest(request),
      },
      body: ownedBuffer(bytes),
    });
    if (!response.ok) throw new CloudSpaceAuthorityError('DATA_PUT_FAILED', `Application object upload ${key} failed with ${response.status}`, { key, status: response.status });
    return hash;
  }

  async get(key: string, expectedHash?: string): Promise<Uint8Array | null> {
    const request = signedRequest(this.options, 'data.get', { key, ...(expectedHash ? { hash: expectedHash } : {}) });
    const response = await (this.options.fetcher ?? fetch)(objectUrl(this.options.baseUrl, key), {
      headers: { 'x-gitspace-control': encodedRequest(request) },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new CloudSpaceAuthorityError('DATA_GET_FAILED', `Application object download failed with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (expectedHash && hashBytes(bytes) !== expectedHash) throw new CloudSpaceAuthorityError('DATA_INTEGRITY_FAILED', `Application object ${key} failed integrity verification`);
    return bytes;
  }
}

export interface PortableSpaceDefinition {
  projectId: string;
  projectName: string;
  repositoryReference: string | null;
  baseBranch: string;
  spaceId: string;
  kind: 'base' | 'worktree';
  name: string;
  branch: string;
  phase: 'plan' | 'code' | 'review' | 'ship' | null;
}

export interface FleetMachineDefinition {
  id: string;
  label: string;
  state: 'provisioning' | 'online' | 'sleeping' | 'offline' | 'resuming' | 'deleting' | 'error';
  rpcEndpoint: string | null;
  kind: 'physical' | 'sandbox';
  notes: string;
  provider: 'physical' | 'cloudflare-sandbox';
  desiredState: 'online' | 'offline' | 'removed';
  lifecycleRevision: number;
  operationId: string | null;
  error: string | null;
}

/** Mirror of the auth worker's `SpaceAuthorityRecord`: closed spaces have no machine and carry the manifest of their last checkpoint. */
export interface CloudSpaceRecord {
  projectId: string;
  spaceId: string;
  state: 'open' | 'closing' | 'closed' | 'opening';
  machineId: string | null;
  generation: number;
  checkpointRevision: number;
  manifestKey: string | null;
  manifestHash: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export class CloudSpaceCheckpointAuthority implements SpaceCheckpointAuthority {
  constructor(private readonly options: SignedCloudRequestOptions) {}

  provisionStorage(gitBucketName: string): Promise<unknown> {
    return this.call('storage.provision', { gitBucketName });
  }

  async projectRepositoryCredentials(projectId: string, ttlSeconds = 3_600): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiresAt: Date;
  }> {
    const value = await this.call<{
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
      expiresAt: string;
    }>('storage.credentials', { prefixes: [`projects/${projectId}/repo/`], ttlSeconds });
    return { ...value, expiresAt: new Date(value.expiresAt) };
  }

  gitStorageBinding(): Promise<{ bucket: string; endpoint: string; region: string }> {
    return this.call('storage.binding', {});
  }
  listProjects(lifecycle?: 'active' | 'archived'): Promise<CloudProjectSummary[]> {
    return this.call('projects.list', lifecycle ? { lifecycle } : {});
  }

  bootstrapProject(input: {
    projectId: string;
    name: string;
    repositoryReference: string | null;
    baseBranch: string;
  }): Promise<CloudProjectSummary> {
    return this.call('project.bootstrap', input);
  }

  getProject(projectId: string): Promise<CloudProjectSummary | null> {
    return this.call('project.get', { projectId });
  }

  listProjectWorkspaces(projectId: string): Promise<CloudWorkspaceDefinition[]> {
    return this.call('project.workspaces.list', { projectId });
  }

  setProjectLifecycle(
    projectId: string,
    expectedRevision: number,
    lifecycle: CloudProjectSummary['lifecycle'],
  ): Promise<CloudProjectSummary> {
    return this.call('project.setLifecycle', { projectId, expectedRevision, lifecycle });
  }

  putProjectWorkspace(
    projectId: string,
    workspace: Omit<CloudWorkspaceDefinition, 'revision' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
      expectedRevision: number;
    },
  ): Promise<CloudWorkspaceDefinition> {
    return this.call('project.workspaces.put', { projectId, workspace });
  }

  removeProjectWorkspace(projectId: string, workspaceId: string, expectedRevision: number): Promise<boolean> {
    return this.call('project.workspaces.remove', { projectId, workspaceId, expectedRevision });
  }

  deleteProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
    return this.call('project.delete', { projectId, expectedRevision });
  }

  createProjectOperation(
    projectId: string,
    operation: {
      projectId: string;
      workspaceId: string | null;
      kind: string;
      targetMachines: string[];
      steps: Array<{ id: string; label: string }>;
      createdBy: string;
    },
  ): Promise<CloudProjectOperation> {
    return this.call('project.operations.create', { projectId, operation });
  }

  updateProjectOperation(
    projectId: string,
    operation: {
      id: string;
      expectedRevision: number;
      state: CloudProjectOperation['state'];
      steps: CloudProjectOperation['steps'];
      error: string | null;
      claimToken?: string | null;
      leaseExpiresAt?: string | null;
    },
  ): Promise<CloudProjectOperation> {
    return this.call('project.operations.update', { projectId, operation });
  }

  listProjectOperations(projectId: string): Promise<CloudProjectOperation[]> {
    return this.call('project.operations.list', { projectId });
  }

  appendProjectEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }): Promise<ProjectEvent> {
    const { projectId, ...event } = input;
    return this.call('project.events.append', { projectId, event });
  }

  listProjectEvents(projectId: string, afterOffset: number): Promise<ProjectEvent[]> {
    return this.call('project.events.list', { projectId, afterOffset });
  }

  latestProjectEventOffset(projectId: string): Promise<number> {
    return this.call('project.events.latest', { projectId });
  }

  listDeviceGrants(): Promise<DeviceGrantRecord[]> {
    return this.call('devices.list', {});
  }

  revokeDeviceGrant(deviceId: string): Promise<{ deviceId: string; revokedAt: number }> {
    return this.call('devices.revoke', { deviceId });
  }

  getCanonicalSession(projectId: string, sessionId: string): Promise<CanonicalSession | null> {
    return this.call('project.sessions.get', { projectId, sessionId });
  }

  listCanonicalSessions(projectId: string): Promise<CanonicalSession[]> {
    return this.call('project.sessions.list', { projectId });
  }

  putCanonicalSession(
    projectId: string,
    session: Omit<CanonicalSession, 'revision' | 'createdAt' | 'updatedAt'> & { expectedRevision: number },
  ): Promise<CanonicalSession> {
    return this.call('project.sessions.put', { projectId, session });
  }

  getArtifactScope(projectId: string, scopeId: string): Promise<CanonicalArtifactScope | null> {
    return this.call('project.artifacts.get', { projectId, scopeId });
  }

  listArtifactScopes(projectId: string): Promise<CanonicalArtifactScope[]> {
    return this.call('project.artifacts.list', { projectId });
  }

  putArtifactScope(
    projectId: string,
    scope: Omit<CanonicalArtifactScope, 'updatedAt'> & { expectedGeneration: number },
  ): Promise<CanonicalArtifactScope> {
    return this.call('project.artifacts.put', { projectId, scope });
  }

  async synchronizeArtifactScope(
    projectId: string,
    scope: { id: string; spaceId: string; generation: number; manifestHash: string | null },
  ): Promise<CanonicalArtifactScope> {
    const current = await this.getArtifactScope(projectId, scope.id);
    if (current && current.generation === scope.generation && current.manifestHash === scope.manifestHash) return current;
    if (current && current.generation > scope.generation) return current;
    return this.putArtifactScope(projectId, {
      id: scope.id,
      workspaceId: scope.spaceId,
      generation: scope.generation,
      manifestHash: scope.manifestHash as CanonicalArtifactScope['manifestHash'],
      expectedGeneration: current?.generation ?? 0,
    });
  }

  listArtifactPromotions(projectId: string): Promise<CanonicalArtifactPromotion[]> {
    return this.call('project.promotions.list', { projectId });
  }

  putArtifactPromotion(
    projectId: string,
    promotion: Omit<CanonicalArtifactPromotion, 'updatedAt'>,
  ): Promise<CanonicalArtifactPromotion> {
    return this.call('project.promotions.put', { projectId, promotion });
  }

  listHostedRoutes(projectId: string): Promise<HostedServiceRoute[]> {
    return this.call('project.routes.list', { projectId });
  }

  leaseHostedRoute(
    projectId: string,
    route: Omit<HostedServiceRoute, 'updatedAt'>,
  ): Promise<HostedServiceRoute> {
    return this.call('project.routes.lease', { projectId, route });
  }

  releaseHostedRoute(projectId: string, hostname: string): Promise<boolean> {
    return this.call('project.routes.release', { projectId, hostname });
  }

  async putSpaceDefinition(definition: PortableSpaceDefinition): Promise<PortableSpaceDefinition> {
    await this.bootstrapProject({
      projectId: definition.projectId,
      name: definition.projectName,
      repositoryReference: definition.repositoryReference,
      baseBranch: definition.baseBranch,
    });
    const current = (await this.listProjectWorkspaces(definition.projectId))
      .find((workspace) => workspace.id === definition.spaceId);
    if (
      current
      && current.kind === definition.kind
      && current.name === definition.name
      && current.branch === definition.branch
      && current.phase === definition.phase
      && current.lifecycle === 'active'
    ) {
      return definition;
    }
    await this.putProjectWorkspace(definition.projectId, {
      id: definition.spaceId,
      projectId: definition.projectId,
      kind: definition.kind,
      name: definition.name,
      branch: definition.branch,
      phase: definition.phase,
      sourceKind: definition.kind === 'base' ? 'base' : 'branch',
      sourceRef: definition.branch,
      lifecycle: 'active',
      goalId: null,
      expectedRevision: current?.revision ?? 0,
    });
    return definition;
  }

  async getSpaceDefinition(spaceId: string): Promise<PortableSpaceDefinition | null> {
    const projectId = await this.call<string | null>('projects.workspaces.locate', { workspaceId: spaceId });
    if (!projectId) return null;
    const [project, workspaces] = await Promise.all([
      this.getProject(projectId),
      this.listProjectWorkspaces(projectId),
    ]);
    const workspace = workspaces.find((candidate) => candidate.id === spaceId);
    if (!project || !workspace) return null;
    return {
      projectId,
      projectName: project.name,
      repositoryReference: project.repositoryReference,
      baseBranch: project.baseBranch,
      spaceId: workspace.id,
      kind: workspace.kind,
      name: workspace.name,
      branch: workspace.branch,
      phase: workspace.phase,
    };
  }

  async listSpaceDefinitions(): Promise<PortableSpaceDefinition[]> {
    const projects = await this.listProjects();
    const workspaces = await Promise.all(projects.map(async (project) => ({
      project,
      workspaces: await this.listProjectWorkspaces(project.id),
    })));
    return workspaces.flatMap(({ project, workspaces: projectWorkspaces }) => projectWorkspaces.map((workspace) => ({
      projectId: project.id,
      projectName: project.name,
      repositoryReference: project.repositoryReference,
      baseBranch: project.baseBranch,
      spaceId: workspace.id,
      kind: workspace.kind,
      name: workspace.name,
      branch: workspace.branch,
      phase: workspace.phase,
    })));
  }

  putMachineDefinition(definition: FleetMachineDefinition): Promise<FleetMachineDefinition> {
    return this.call('catalog.machine.put', { ...definition });
  }

  listMachineDefinitions(): Promise<FleetMachineDefinition[]> {
    return this.call('catalog.machine.list', {});
  }

  createSandboxMachine(): Promise<FleetMachineDefinition> {
    return this.call('catalog.sandbox.create', {});
  }
  sleepMachine(machineId: string): Promise<FleetMachineDefinition> {
    return this.call('catalog.machine.sleep', { machineId });
  }

  resumeMachine(machineId: string): Promise<FleetMachineDefinition> {
    return this.call('catalog.machine.resume', { machineId });
  }

  destroyMachine(machineId: string): Promise<{ machineId: string; removed: boolean }> {
    return this.call('catalog.machine.destroy', { machineId });
  }
  getUserSettings(): Promise<UserSettings> {
    return this.call('settings.get', {});
  }

  subscribeMachines(onChange: (event: { type: 'upsert' | 'remove'; machineId: string; machine: FleetMachineDefinition | null }) => void): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 500;
    const connect = (): void => {
      if (stopped) return;
      const request = signedRequest(this.options, 'catalog.machine.subscribe', {});
      const url = new URL('/v1/fleet/events', this.options.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('control', encodedRequest(request));
      socket = new WebSocket(url);
      socket.addEventListener('open', () => { retryMs = 500; });
      socket.addEventListener('message', (message) => {
        try {
          const event = JSON.parse(String(message.data)) as { type?: unknown; machineId?: unknown; machine?: unknown };
          if ((event.type === 'upsert' || event.type === 'remove') && typeof event.machineId === 'string') onChange({ type: event.type, machineId: event.machineId, machine: event.machine as FleetMachineDefinition | null });
        } catch {}
      });
      socket.addEventListener('close', () => {
        socket = null;
        if (stopped) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      });
      socket.addEventListener('error', () => socket?.close());
    };
    connect();
    return () => { stopped = true; if (retryTimer) clearTimeout(retryTimer); socket?.close(1000, 'Fleet subscription stopped'); };
  }
  updateUserSettings(input: UserSettingsUpdate): Promise<UserSettings> {
    return this.call('settings.update', { ...input });
  }

  reserveUserHandle(expectedRevision: number, handle: string): Promise<UserSettings> {
    return this.call('settings.handle.reserve', { expectedRevision, handle });
  }

  getOmpConfig(): Promise<OmpConfigDocument> {
    return this.call('settings.omp.get', {});
  }

  updateOmpConfig(input: OmpConfigUpdate): Promise<OmpConfigDocument> {
    return this.call('settings.omp.update', { ...input });
  }
  getGitIdentity(): Promise<GitIdentityDocument | null> {
    return this.call('settings.git.get', {});
  }

  updateGitIdentity(input: GitIdentityUpdate): Promise<GitIdentityDocument> {
    return this.call('settings.git.update', { ...input });
  }

  listProjectSecrets(projectId: string): Promise<ProjectSecretMetadata[]> {
    return this.call('secrets.list', { projectId });
  }

  putProjectSecret(projectId: string, name: string, value: string): Promise<ProjectSecretMetadata> {
    return this.call('secrets.put', { projectId, name, value });
  }

  deleteProjectSecret(projectId: string, name: string): Promise<{ deleted: boolean }> {
    return this.call('secrets.delete', { projectId, name });
  }

  materializeProjectSecrets(projectId: string, names: string[]): Promise<Record<string, string>> {
    return this.call('secrets.materialize', { projectId, names });
  }

  listMcpConnections(): Promise<McpConnection[]> {
    return this.call('mcp.connections.list', {});
  }

  createMcpConnection(connection: McpConnectionDraft): Promise<McpConnection> {
    return this.call('mcp.connections.create', { connection });
  }

  updateMcpConnection(connectionId: string, expectedRevision: number, connection: McpConnectionDraft): Promise<McpConnection> {
    return this.call('mcp.connections.update', { connectionId, expectedRevision, connection });
  }

  deleteMcpConnection(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    return this.call('mcp.connections.delete', { connectionId, expectedRevision });
  }

  getMcpConnectionStatus(connectionId: string): Promise<McpConnection | null> {
    return this.call('mcp.connections.status', { connectionId });
  }

  recordMcpConnectionStatus(input: {
    connectionId: string;
    observedRevision: number;
    status: McpConnectionStatus;
    message?: string | null;
    serverFingerprint?: string | null;
    serverVersion?: string | null;
  }): Promise<McpConnection> {
    return this.call('mcp.connections.status', input);
  }

  getComposioSetup(): Promise<ComposioSetup> {
    return this.call('mcp.composio.setup.get', {});
  }

  putComposioSetup(apiKey: string): Promise<ComposioSetup> {
    return this.call('mcp.composio.setup.set', { apiKey });
  }

  deleteComposioSetup(): Promise<ComposioSetup> {
    return this.call('mcp.composio.setup.delete', {});
  }

  listComposioPluginCatalog(): Promise<ComposioPluginCatalog> {
    return this.call('mcp.composio.catalog', {});
  }

  authorizeComposioPlugin(toolkit: string, label: string): Promise<ComposioPluginAuthorization> {
    return this.call('mcp.composio.authorize', { toolkit, label });
  }

  refreshComposioPlugin(connectionId: string): Promise<McpConnection> {
    return this.call('mcp.composio.refresh', { connectionId });
  }

  listComposioPluginTools(connectionId: string): Promise<ComposioPluginTool[]> {
    return this.call('mcp.composio.tools', { connectionId });
  }

  updateComposioPluginTools(connectionId: string, expectedRevision: number, allowedTools: string[]): Promise<McpConnection> {
    return this.call('mcp.composio.updateTools', { connectionId, expectedRevision, allowedTools });
  }

  disconnectComposioPlugin(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    return this.call('mcp.composio.disconnect', { connectionId, expectedRevision });
  }

  materializeComposioPlugin(projectId: string, workspaceId: string | null, connectionId: string): Promise<ComposioMcpMaterialization> {
    return this.call('mcp.composio.materialize', { projectId, workspaceId, connectionId });
  }

  listProjectMcpGrants(projectId: string): Promise<ProjectMcpGrant[]> {
    return this.call('project.mcp.grants.list', { projectId });
  }

  putProjectMcpGrant(projectId: string, connectionId: string, enabled: boolean, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<ProjectMcpGrant> {
    return this.call('project.mcp.grants.put', { projectId, connectionId, enabled, projectSpaceEnabled, workspacesEnabled, expectedRevision });
  }

  deleteProjectMcpGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }> {
    return this.call('project.mcp.grants.delete', { projectId, connectionId, expectedRevision });
  }

  appendMcpAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<McpAuditEvent> {
    return this.call('mcp.audit.append', event);
  }

  listMcpAudit(after: string | null, limit = 200): Promise<McpAuditEvent[]> {
    return this.call('mcp.audit.list', { after, limit });
  }

  listSkills(): Promise<SkillView[]> {
    return this.call('skills.list', {});
  }

  updateSkill(input: SkillUpdate): Promise<SkillView> {
    return this.call('skills.update', { ...input });
  }
  subscribeSettings(
    onChange: (event: { userRevision: number; ompGeneration: number }) => void,
    onState: (state: 'connecting' | 'open' | 'offline') => void,
  ): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 500;
    const connect = (): void => {
      if (stopped) return;
      onState('connecting');
      const request = signedRequest(this.options, 'settings.subscribe', {});
      const url = new URL('/v1/settings/events', this.options.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('control', encodedRequest(request));
      socket = new WebSocket(url);
      socket.addEventListener('open', () => { retryMs = 500; onState('open'); });
      socket.addEventListener('message', (message) => {
        try {
          const event = JSON.parse(String(message.data)) as { type?: unknown; userRevision?: unknown; ompGeneration?: unknown };
          if (event.type === 'settings.changed' && typeof event.userRevision === 'number' && typeof event.ompGeneration === 'number') {
            onChange({ userRevision: event.userRevision, ompGeneration: event.ompGeneration });
          }
        } catch {
          // Ignore malformed control-plane events; the next valid event remains usable.
        }
      });
      socket.addEventListener('close', () => {
        socket = null;
        if (stopped) return;
        onState('offline');
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      });
      socket.addEventListener('error', () => socket?.close());
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, 'Settings subscription stopped');
    };
  }

  async listProjectCrons(projectId: string): Promise<ProjectCronView[]> {
    const values = await this.call<ProjectCronView[]>('crons.list', { projectId });
    return values.map(projectCronView);
  }

  async createProjectCron(projectId: string, draft: ProjectCronDraft): Promise<ProjectCronView> {
    return projectCronView(await this.call<ProjectCronView>('crons.create', { projectId, draft }));
  }

  async updateProjectCron(projectId: string, cronId: string, expectedRevision: number, draft: ProjectCronDraft): Promise<ProjectCronView> {
    return projectCronView(await this.call<ProjectCronView>('crons.update', { projectId, cronId, expectedRevision, draft }));
  }

  deleteProjectCron(projectId: string, cronId: string, expectedRevision: number): Promise<{ projectId: string; cronId: string; deleted: boolean }> {
    return this.call('crons.delete', { projectId, cronId, expectedRevision });
  }

  async runProjectCronNow(projectId: string, cronId: string): Promise<ProjectCronRunView> {
    return projectCronRunView(await this.call<ProjectCronRunView>('crons.runNow', { projectId, cronId }));
  }

  async projectCronHistory(projectId: string, cronId: string, limit?: number): Promise<ProjectCronRunView[]> {
    const values = await this.call<ProjectCronRunView[]>('crons.history', { projectId, cronId, ...(limit === undefined ? {} : { limit }) });
    return values.map(projectCronRunView);
  }

  async processDueProjectCrons(projectId: string): Promise<ProjectCronRunView[]> {
    const values = await this.call<ProjectCronRunView[]>('crons.processDue', { projectId });
    return values.map(projectCronRunView);
  }

  async claimNextProjectCron(projectId: string, heldSpaceIds: readonly string[]): Promise<{ run: ProjectCronRunView; claimToken: string; leaseExpiresAt: Date } | null> {
    const value = await this.call<{ run: ProjectCronRunView; claimToken: string; leaseExpiresAt: string } | null>('crons.claimNext', { projectId, heldSpaceIds: [...heldSpaceIds] });
    return value ? { ...value, run: projectCronRunView(value.run), leaseExpiresAt: new Date(value.leaseExpiresAt) } : null;
  }

  async completeProjectCronRun(input: {
    projectId: string;
    runId: string;
    claimToken: string;
    state: 'succeeded' | 'blocked' | 'failed';
    message: string | null;
    resolvedSpaceId: string | null;
    resolvedGeneration: number | null;
  }): Promise<ProjectCronRunView> {
    return projectCronRunView(await this.call<ProjectCronRunView>('crons.completeRun', { ...input }));
  }

  bootstrapInspector(identity: InspectorIdentity): Promise<InspectorIdentity> {
    return this.call('inspector.bootstrap', { ...identity });
  }

  getInspectorOverview(identity: InspectorIdentity, context?: ReviewAnchorContext): Promise<InspectorOverview> {
    return this.call('inspector.getOverview', { ...identity, ...(context ? { context } : {}) });
  }

  getInspectorGoal(identity: InspectorIdentity): Promise<GoalRecordView | null> {
    return this.call('inspector.getGoal', { ...identity });
  }

  putInspectorGoal(input: PutGoalInput): Promise<GoalRecordView> {
    return this.call('inspector.putGoal', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  attachInspectorRequirementEvidence(input: AttachRequirementEvidenceInput): Promise<GoalRecordView> {
    return this.call('inspector.attachRequirementEvidence', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  getInspectorWorkflow(identity: InspectorIdentity): Promise<WorkflowView | null> {
    return this.call('inspector.getWorkflow', { ...identity });
  }

  putInspectorWorkflow(input: PutWorkflowInput): Promise<WorkflowView> {
    return this.call('inspector.putWorkflow', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  waiveInspectorWorkflowGate(input: WaiveWorkflowGateInput): Promise<WorkflowView> {
    return this.call('inspector.waiveWorkflowGate', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  getInspectorRubric(identity: InspectorIdentity): Promise<RubricView | null> {
    return this.call('inspector.getRubric', { ...identity });
  }

  putInspectorRubric(input: PutRubricInput): Promise<RubricView> {
    return this.call('inspector.putRubric', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  appendInspectorRubricJudgment(input: AppendRubricJudgmentInput): Promise<RubricView> {
    return this.call('inspector.appendRubricJudgment', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  listInspectorJournal(identity: InspectorIdentity): Promise<JournalEntryView[]> {
    return this.call('inspector.listJournal', { ...identity });
  }

  startInspectorJournalPhase(input: StartJournalPhaseInput): Promise<JournalEntryView> {
    return this.call('inspector.startJournalPhase', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  endInspectorJournalPhase(input: EndJournalPhaseInput): Promise<JournalEntryView> {
    return this.call('inspector.endJournalPhase', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  appendInspectorJournalEntry(input: AppendJournalEntryInput): Promise<JournalEntryView> {
    return this.call('inspector.appendJournalEntry', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  getInspectorChangeGuide(identity: InspectorIdentity): Promise<ChangeGuideView | null> {
    return this.call('inspector.getChangeGuide', { ...identity });
  }

  putInspectorChangeGuide(input: PutChangeGuideInput): Promise<ChangeGuideView> {
    return this.call('inspector.putChangeGuide', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  markInspectorGuideSectionRead(input: MarkGuideSectionReadInput): Promise<ChangeGuideView> {
    return this.call('inspector.markGuideSectionRead', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  setInspectorGuideApproval(input: SetGuideApprovalInput): Promise<ChangeGuideView> {
    return this.call('inspector.setGuideApproval', { projectId: input.projectId, spaceId: input.spaceId, input });
  }

  listInspectorReviewThreads(identity: InspectorIdentity, context?: ReviewAnchorContext): Promise<ReviewThreadView[]> {
    return this.call('inspector.listReviewThreads', { ...identity, ...(context ? { context } : {}) });
  }

  createInspectorReviewThread(input: CreateReviewThreadInput, context?: ReviewAnchorContext): Promise<ReviewThreadView> {
    return this.call('inspector.createReviewThread', { projectId: input.projectId, spaceId: input.spaceId, input, ...(context ? { context } : {}) });
  }

  appendInspectorReviewMessage(input: AppendReviewMessageInput, context?: ReviewAnchorContext): Promise<ReviewThreadView> {
    return this.call('inspector.appendReviewMessage', { projectId: input.projectId, spaceId: input.spaceId, input, ...(context ? { context } : {}) });
  }

  resolveInspectorReviewThread(input: ResolveReviewThreadInput, context?: ReviewAnchorContext): Promise<ReviewThreadView> {
    return this.call('inspector.resolveReviewThread', { projectId: input.projectId, spaceId: input.spaceId, input, ...(context ? { context } : {}) });
  }

  bootstrap(input: { projectId: string; spaceId: string }): Promise<unknown> {
    return this.call('space.bootstrap', { ...input, machineId: this.options.machineId });
  }

  beginClose(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number }) {
    return this.call<{ revision: number; previousRevision: number | null }>('space.beginClose', input);
  }

  async commitClosed(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; manifestKey: string; manifestHash: `sha256:${string}` }) {
    await this.call('space.commitClosed', input);
  }

  async abortClose(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; message: string }) {
    await this.call('space.abortClose', input);
  }

  beginOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number }) {
    return this.call<{ revision: number; manifestKey: string; manifestHash: `sha256:${string}` }>('space.beginOpen', input);
  }

  async commitOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number }) {
    await this.call('space.commitOpen', input);
  }

  async failOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; message: string }) {
    await this.call('space.failOpen', input);
  }

  /** Cloud placement record without opening: who holds the space, its generation, and the closed checkpoint manifest. */
  getSpace(projectId: string, spaceId: string): Promise<CloudSpaceRecord | null> {
    return this.call<CloudSpaceRecord | null>('space.get', { projectId, spaceId });
  }

  stageRelease(input: StageReleaseInput): Promise<ReleaseRecord> {
    return this.call<ReleaseRecord>('deploy.stage', input);
  }

  launchRelease(sha: string, targets: ReleaseTarget[]): Promise<{ record: ReleaseRecord; desired: TenantDesired }> {
    return this.call('deploy.launch', { sha, targets });
  }

  deploymentStatus(): Promise<DeploymentStatus> {
    return this.call<DeploymentStatus>('deploy.status', {});
  }

  revertRelease(): Promise<DeploymentStatus> {
    return this.call<DeploymentStatus>('deploy.revert', {});
  }

  /** This machine's verdict on a release generation; the machine id comes from the signed request. */
  reportMachineApplied(input: { sha: string; target: 'machine' | 'omp'; generation: string; status: 'applied' | 'failed'; error?: string }): Promise<ReleaseRecord> {
    return this.call<ReleaseRecord>('deploy.machineApplied', input);
  }

  /** Clear only the target that this healthy machine confirmed running from its channel artifact. */
  async reportMachineChannelApplied(input: { target: 'machine' | 'omp'; generation: string }): Promise<void> {
    await this.call('deploy.machineChannelApplied', input);
  }

  private async call<T = unknown>(operation: ControlOperation, payload: Record<string, unknown>): Promise<T> {
    const request = signedRequest(this.options, operation, payload);
    const response = await (this.options.fetcher ?? fetch)(new URL('/v1/control', this.options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body = await response.json() as { status?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown; [key: string]: unknown } };
    if (!response.ok || body.status !== 'ok') {
      throw new CloudSpaceAuthorityError(
        typeof body.error?.code === 'string' ? body.error.code : 'CONTROL_FAILED',
        typeof body.error?.message === 'string' ? body.error.message : `Control operation failed with ${response.status}`,
        body.error ?? {},
      );
    }
    return body.value as T;
  }
}
