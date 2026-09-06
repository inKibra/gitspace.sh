import { DurableObject } from 'cloudflare:workers';
import { GITSPACE_SOURCE_PROJECT_ROLE, GITSPACE_SOURCE_REPOSITORY, isGitSpaceSourceRepository, type GitSpaceSourceProvenance } from '@gitspace/protocol';
import type {
  ArtifactCopyRecord,
  ArtifactShareRecord,
  CanonicalArtifactScope,
  CanonicalArtifactPromotion,
  CanonicalSession,
  CloudProjectOperation,
  CloudProjectSummary,
  CloudWorkspaceDefinition,
  HostedServiceRoute,
  ProjectEvent,
  ProjectMcpGrant,
  ProjectLifecycle,
  ProjectOperationState,
} from '@gitspace/protocol';
import { ProjectEnvironmentStore, type LifecycleActor } from './project-environment.js';
import { LifecycleMutationSchema, type LifecycleMutation, type LifecycleState, type LifecycleRunLog } from '@gitspace/protocol';

interface ProjectIndexRow extends Record<string, SqlStorageValue> {
  project_id: string;
  name: string;
  lifecycle: ProjectLifecycle;
  repository_reference: string | null;
  base_branch: string;
  revision: number;
  archived_at: string | null;
  updated_at: string;
  role: typeof GITSPACE_SOURCE_PROJECT_ROLE | null;
  source_json: string | null;
}

interface WorkspaceRow extends Record<string, SqlStorageValue> {
  workspace_id: string;
  project_id: string;
  kind: CloudWorkspaceDefinition['kind'];
  name: string;
  branch: string;
  phase: CloudWorkspaceDefinition['phase'];
  source_kind: CloudWorkspaceDefinition['sourceKind'];
  source_ref: string;
  lifecycle: CloudWorkspaceDefinition['lifecycle'];
  goal_id: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  project_id: string;
  workspace_id: string | null;
  kind: string;
  state: ProjectOperationState;
  target_machines_json: string;
  steps_json: string;
  claim_token: string | null;
  lease_expires_at: string | null;
  error: string | null;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CanonicalSessionRow extends Record<string, SqlStorageValue> {
  session_id: string;
  workspace_id: string;
  omp_session_id: string;
  machine_id: string | null;
  state: CanonicalSession['state'];
  session_object_key: string | null;
  session_object_hash: CanonicalSession['sessionObjectHash'];
  session_format_version: string | null;
  activity_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ArtifactScopeRow extends Record<string, SqlStorageValue> {
  scope_id: string;
  workspace_id: string;
  generation: number;
  manifest_hash: CanonicalArtifactScope['manifestHash'];
  updated_at: string;
}

interface ArtifactPromotionRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  source_workspace_id: string;
  source_generation: number;
  expected_base_generation: number;
  committed_base_generation: number | null;
  paths_json: string;
  state: CanonicalArtifactPromotion['state'];
  updated_at: string;
}

interface HostedRouteRow extends Record<string, SqlStorageValue> {
  hostname: string;
  workspace_id: string;
  service_name: string;
  machine_id: string;
  ingress: string;
  port_name: string;
  port: number;
  generation: number;
  lease_expires_at: string;
  health: HostedServiceRoute['health'];
  updated_at: string;
}

interface ProjectEventRow extends Record<string, SqlStorageValue> {
  offset: number;
  scope: ProjectEvent['scope'];
  entity: string;
  entity_id: string;
  revision: number;
  operation: ProjectEvent['operation'];
  payload_json: string;
  created_at: string;
}

interface ProjectMcpGrantRow extends Record<string, SqlStorageValue> {
  project_id: string;
  connection_id: string;
  enabled: number;
  project_space_enabled: number;
  workspaces_enabled: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class ProjectMcpGrantNotFoundError extends Error {
  constructor(readonly connectionId: string) {
    super(`Project MCP grant for ${connectionId} does not exist`);
    this.name = 'ProjectMcpGrantNotFoundError';
  }
}

export class ProjectMcpGrantRevisionConflictError extends Error {
  constructor(readonly connectionId: string, readonly expected: number, readonly actual: number) {
    super(`Project MCP grant ${connectionId} revision conflict: expected ${expected}, actual ${actual}`);
    this.name = 'ProjectMcpGrantRevisionConflictError';
  }
}

function projectSummary(row: ProjectIndexRow): CloudProjectSummary {
  return {
    id: row.project_id,
    name: row.name,
    lifecycle: row.lifecycle,
    repositoryReference: row.repository_reference,
    baseBranch: row.base_branch,
    role: row.role ?? null,
    source: row.source_json ? JSON.parse(row.source_json) as GitSpaceSourceProvenance : null,
    revision: row.revision,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

function workspaceDefinition(row: WorkspaceRow): CloudWorkspaceDefinition {
  return {
    id: row.workspace_id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    branch: row.branch,
    phase: row.phase,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    lifecycle: row.lifecycle,
    goalId: row.goal_id,
    revision: row.revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectOperation(row: OperationRow): CloudProjectOperation {
  return {
    id: row.operation_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    state: row.state,
    targetMachines: JSON.parse(row.target_machines_json) as string[],
    steps: JSON.parse(row.steps_json) as CloudProjectOperation['steps'],
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    error: row.error,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactScope(row: ArtifactScopeRow): CanonicalArtifactScope {
  return {
    id: row.scope_id,
    workspaceId: row.workspace_id,
    generation: row.generation,
    manifestHash: row.manifest_hash,
    updatedAt: row.updated_at,
  };
}

function artifactPromotion(row: ArtifactPromotionRow): CanonicalArtifactPromotion {
  return {
    id: row.operation_id,
    sourceWorkspaceId: row.source_workspace_id,
    sourceGeneration: row.source_generation,
    expectedBaseGeneration: row.expected_base_generation,
    committedBaseGeneration: row.committed_base_generation,
    paths: JSON.parse(row.paths_json) as string[],
    state: row.state,
    updatedAt: row.updated_at,
  };
}

function hostedRoute(row: HostedRouteRow): HostedServiceRoute {
  return {
    hostname: row.hostname,
    workspaceId: row.workspace_id,
    serviceName: row.service_name,
    machineId: row.machine_id,
    ingress: row.ingress,
    portName: row.port_name,
    port: row.port,
    generation: row.generation,
    leaseExpiresAt: row.lease_expires_at,
    health: row.health,
    updatedAt: row.updated_at,
  };
}

function canonicalSession(row: CanonicalSessionRow): CanonicalSession {
  return {
    id: row.session_id,
    workspaceId: row.workspace_id,
    ompSessionId: row.omp_session_id,
    machineId: row.machine_id,
    state: row.state,
    sessionObjectKey: row.session_object_key,
    sessionObjectHash: row.session_object_hash,
    sessionFormatVersion: row.session_format_version,
    activity: JSON.parse(row.activity_json) as CanonicalSession['activity'],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectMcpGrant(row: ProjectMcpGrantRow): ProjectMcpGrant {
  return {
    projectId: row.project_id,
    connectionId: row.connection_id,
    enabled: row.enabled === 1,
    projectSpaceEnabled: row.project_space_enabled === 1,
    workspacesEnabled: row.workspaces_enabled === 1,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserProjectIndexDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS user_projects(
          project_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          lifecycle TEXT NOT NULL,
          repository_reference TEXT,
          base_branch TEXT NOT NULL,
          revision INTEGER NOT NULL,
          archived_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_projects(
          workspace_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS environment_values(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      `);
      for (const column of ['role TEXT', 'source_json TEXT']) {
        try { this.ctx.storage.sql.exec(`ALTER TABLE user_projects ADD COLUMN ${column}`); }
        catch (error) { if (!(error instanceof Error) || !/duplicate column name/u.test(error.message)) throw error; }
      }
      this.ctx.storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS user_project_role ON user_projects(role) WHERE role IS NOT NULL');
    });
  }

  list(lifecycle?: 'active' | 'archived'): CloudProjectSummary[] {
    const projects = this.ctx.storage.sql.exec<ProjectIndexRow>(
      'SELECT * FROM user_projects ORDER BY name',
    ).toArray().map(projectSummary);
    if (!lifecycle) return projects;
    return projects.filter((project) => lifecycle === 'archived'
      ? project.lifecycle === 'archived'
      : project.lifecycle !== 'archived' && project.lifecycle !== 'deleting');
  }

  /** Synchronous reservation makes concurrent account repair choose the same project. */
  ensureGitSpaceProject(source: GitSpaceSourceProvenance): CloudProjectSummary {
    const projects = this.list();
    const reserved = projects.find((project) => project.role === GITSPACE_SOURCE_PROJECT_ROLE);
    if (reserved) {
      if (reserved.lifecycle !== 'cloud-only') return reserved;
      const nextSource = {
        release: reserved.source?.release ?? source.release ?? null,
        branch: reserved.source?.branch ?? source.branch ?? null,
        commit: reserved.source?.commit ?? source.commit ?? null,
      };
      if (JSON.stringify(nextSource) === JSON.stringify(reserved.source)) return reserved;
      return this.put({ ...reserved, baseBranch: nextSource.branch ?? 'HEAD', source: nextSource, revision: reserved.revision + 1 });
    }
    const existing = projects.filter((project) => isGitSpaceSourceRepository(project.repositoryReference))
      .sort((left, right) => Number(right.lifecycle === 'active') - Number(left.lifecycle === 'active') || left.id.localeCompare(right.id))[0];
    let name = 'GitSpace';
    for (let suffix = 1; projects.some((project) => project.name === name); suffix++) name = suffix === 1 ? 'GitSpace source' : `GitSpace source ${suffix}`;
    return this.put({
      id: existing?.id ?? `gitspace-source-${crypto.randomUUID()}`,
      name: existing?.name ?? name,
      lifecycle: existing?.lifecycle === 'active' || existing?.lifecycle === 'archived' ? 'active' : 'cloud-only',
      repositoryReference: existing?.repositoryReference ?? GITSPACE_SOURCE_REPOSITORY,
      baseBranch: existing?.baseBranch ?? source.branch ?? 'HEAD',
      role: GITSPACE_SOURCE_PROJECT_ROLE,
      source: existing ? { ...source, branch: existing.baseBranch, commit: null } : source,
      revision: (existing?.revision ?? 0) + 1,
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }

  put(input: CloudProjectSummary): CloudProjectSummary {
    const existing = this.list().find((project) => project.id === input.id);
    if ((existing?.role === GITSPACE_SOURCE_PROJECT_ROLE || input.role === GITSPACE_SOURCE_PROJECT_ROLE)
      && input.lifecycle !== 'active' && input.lifecycle !== 'cloud-only') throw new Error('The built-in GitSpace project cannot be archived or deleted');
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO user_projects(project_id,name,lifecycle,repository_reference,base_branch,revision,archived_at,updated_at,role,source_json) VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET
         name=excluded.name,
         lifecycle=excluded.lifecycle,
         repository_reference=excluded.repository_reference,
         base_branch=excluded.base_branch,
         revision=excluded.revision,
         archived_at=excluded.archived_at,
         updated_at=excluded.updated_at,
         role=COALESCE(user_projects.role,excluded.role),
         source_json=COALESCE(excluded.source_json,user_projects.source_json)
       WHERE excluded.revision >= user_projects.revision`,
      input.id,
      input.name,
      input.lifecycle,
      input.repositoryReference,
      input.baseBranch,
      input.revision,
      input.archivedAt,
      updatedAt,
      input.role ?? null,
      input.source ? JSON.stringify(input.source) : null,
    );
    const row = this.ctx.storage.sql.exec<ProjectIndexRow>(
      'SELECT * FROM user_projects WHERE project_id=?',
      input.id,
    ).one();
    return projectSummary(row);
  }

  remove(projectId: string): boolean {
    const project = this.list().find((candidate) => candidate.id === projectId);
    if (project?.role === GITSPACE_SOURCE_PROJECT_ROLE) throw new Error('The built-in GitSpace project cannot be removed. Close its workspaces instead.');
    return this.ctx.storage.sql.exec(
      'DELETE FROM user_projects WHERE project_id=? RETURNING project_id',
      projectId,
    ).toArray().length > 0;
  }

  putWorkspaceLocation(workspaceId: string, projectId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO workspace_projects VALUES(?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET project_id=excluded.project_id`,
      workspaceId,
      projectId,
    );
  }

  removeWorkspaceLocation(workspaceId: string): boolean {
    return this.ctx.storage.sql.exec(
      'DELETE FROM workspace_projects WHERE workspace_id=? RETURNING workspace_id',
      workspaceId,
    ).toArray().length > 0;
  }

  locateWorkspace(workspaceId: string): string | null {
    const row = this.ctx.storage.sql.exec<{ project_id: string }>(
      'SELECT project_id FROM workspace_projects WHERE workspace_id=?',
      workspaceId,
    ).toArray()[0];
    return row?.project_id ?? null;
  }

  getEnvironmentValues(): Record<string, string> {
    return Object.fromEntries(this.ctx.storage.sql.exec<{ name: string; value: string }>('SELECT name,value FROM environment_values').toArray().map((row) => [row.name, row.value]));
  }

  setEnvironmentValue(name: string, value: string | null): Record<string, string> {
    LifecycleMutationSchema.parse({ op: 'value', scope: 'global', name, value });
    if (value === null) this.ctx.storage.sql.exec('DELETE FROM environment_values WHERE name=?', name);
    else this.ctx.storage.sql.exec('INSERT INTO environment_values(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', name, value);
    return this.getEnvironmentValues();
  }
}

export class ProjectAuthorityDO extends DurableObject<Env> {
  private readonly environment: ProjectEnvironmentStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.environment = new ProjectEnvironmentStore(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.environment.initialize();
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS project(
          project_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repository_reference TEXT,
          base_branch TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          revision INTEGER NOT NULL,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces(
          workspace_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          branch TEXT NOT NULL,
          phase TEXT,
          source_kind TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          goal_id TEXT,
          revision INTEGER NOT NULL,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS operations(
          operation_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          workspace_id TEXT,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          target_machines_json TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          claim_token TEXT,
          lease_expires_at TEXT,
          error TEXT,
          revision INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_events(
          offset INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          entity TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          operation TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS canonical_sessions(
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL UNIQUE,
          omp_session_id TEXT NOT NULL UNIQUE,
          machine_id TEXT,
          state TEXT NOT NULL,
          session_object_key TEXT,
          session_object_hash TEXT,
          session_format_version TEXT,
          activity_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_scopes(
          scope_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          manifest_hash TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_copies(
          copy_id TEXT PRIMARY KEY,
          provenance_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_shares(
          token TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          path TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS artifact_shares_path ON artifact_shares(workspace_id,path);
        CREATE TABLE IF NOT EXISTS artifact_promotions(
          operation_id TEXT PRIMARY KEY,
          source_workspace_id TEXT NOT NULL,
          source_generation INTEGER NOT NULL,
          expected_base_generation INTEGER NOT NULL,
          committed_base_generation INTEGER,
          paths_json TEXT NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hosted_routes(
          hostname TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          service_name TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          ingress TEXT NOT NULL,
          port_name TEXT NOT NULL,
          port INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          lease_expires_at TEXT NOT NULL,
          health TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_mcp_grants(
          project_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          project_space_enabled INTEGER NOT NULL DEFAULT 1,
          workspaces_enabled INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id, connection_id)
        );
      `);
      for (const column of ['role TEXT', 'source_json TEXT']) {
        try { this.ctx.storage.sql.exec(`ALTER TABLE project ADD COLUMN ${column}`); }
        catch (error) { if (!(error instanceof Error) || !/duplicate column name/u.test(error.message)) throw error; }
      }
      try { this.ctx.storage.sql.exec('ALTER TABLE project_mcp_grants ADD COLUMN project_space_enabled INTEGER NOT NULL DEFAULT 1'); } catch {}
      try { this.ctx.storage.sql.exec('ALTER TABLE project_mcp_grants ADD COLUMN workspaces_enabled INTEGER NOT NULL DEFAULT 1'); } catch {}
    });
  }

  bootstrap(input: {
    id: string;
    name: string;
    repositoryReference: string | null;
    baseBranch: string;
    createdBy: string;
  }): CloudProjectSummary {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO project(project_id,name,repository_reference,base_branch,lifecycle,revision,archived_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      input.id,
      input.name,
      input.repositoryReference,
      input.baseBranch,
      'provisioning',
      1,
      null,
      now,
      now,
    );
    return this.requireProject();
  }

  ensureGitSpaceProject(input: CloudProjectSummary): CloudProjectSummary {
    if (input.role !== GITSPACE_SOURCE_PROJECT_ROLE || !isGitSpaceSourceRepository(input.repositoryReference)) throw new Error('Invalid built-in GitSpace project identity');
    const current = this.getProject();
    if (current && current.id !== input.id) throw new Error('Project identity mismatch');
    if (!current) {
      this.bootstrap({ ...input, createdBy: 'account' });
    } else if (current.role === GITSPACE_SOURCE_PROJECT_ROLE && current.revision >= input.revision) {
      return current;
    }
    this.ctx.storage.sql.exec(
      'UPDATE project SET role=?,source_json=?,base_branch=?,lifecycle=?,revision=?,archived_at=NULL,updated_at=?',
      GITSPACE_SOURCE_PROJECT_ROLE, JSON.stringify(input.source), input.baseBranch,
      current?.lifecycle === 'active' ? 'active' : input.lifecycle,
      Math.max(current?.revision ?? 0, input.revision), new Date().toISOString(),
    );
    return this.requireProject();
  }

  activateSourceProject(expectedRevision: number, baseBranch: string): CloudProjectSummary {
    const current = this.requireProject();
    if (current.role !== GITSPACE_SOURCE_PROJECT_ROLE) throw new Error('Project is not the built-in GitSpace source');
    if (current.revision !== expectedRevision) throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
    if (!baseBranch || baseBranch.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(baseBranch)) throw new Error('Invalid source branch');
    this.ctx.storage.sql.exec('UPDATE project SET base_branch=?,source_json=?,lifecycle=?,revision=revision+1,updated_at=?',
      baseBranch, JSON.stringify({ ...current.source, branch: baseBranch }), 'active', new Date().toISOString());
    return this.requireProject();
  }

  getProject(): CloudProjectSummary | null {
    const row = this.ctx.storage.sql.exec<ProjectIndexRow>(
      'SELECT * FROM project LIMIT 1',
    ).toArray()[0];
    return row ? projectSummary(row) : null;
  }


  private requireLifecycleWorkspace(spaceId: string): CloudProjectSummary {
    const project = this.requireProject();
    const workspace = this.ctx.storage.sql.exec<WorkspaceRow>('SELECT * FROM workspaces WHERE workspace_id=?', spaceId).toArray()[0];
    if (!workspace || workspace.project_id !== project.id) throw new Error('Lifecycle workspace does not belong to this project');
    return project;
  }

  getLifecycleState(spaceId: string): LifecycleState {
    return this.environment.get(this.requireLifecycleWorkspace(spaceId).id, spaceId);
  }

  mutateLifecycleState(spaceId: string, input: LifecycleMutation, actor: LifecycleActor): LifecycleState {
    return this.environment.mutate(this.requireLifecycleWorkspace(spaceId).id, spaceId, input, actor);
  }

  getLifecycleRunLog(spaceId: string, runId: string, offset = 0): LifecycleRunLog {
    this.requireLifecycleWorkspace(spaceId);
    return this.environment.runLog(spaceId, runId, offset);
  }
  setProjectLifecycle(expectedRevision: number, lifecycle: ProjectLifecycle): CloudProjectSummary {
    const current = this.requireProject();
    if (current.role === GITSPACE_SOURCE_PROJECT_ROLE && lifecycle !== 'active' && lifecycle !== 'cloud-only') {
      throw new Error('The built-in GitSpace project cannot be archived or deleted. Close its workspaces instead.');
    }
    if (current.revision !== expectedRevision) {
      throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'UPDATE project SET lifecycle=?,revision=revision+1,archived_at=?,updated_at=?',
      lifecycle,
      lifecycle === 'archived' ? now : null,
      now,
    );
    return this.requireProject();
  }

  listWorkspaces(): CloudWorkspaceDefinition[] {
    return this.ctx.storage.sql.exec<WorkspaceRow>(
      'SELECT * FROM workspaces ORDER BY kind,name',
    ).toArray().map(workspaceDefinition);
  }

  putWorkspace(input: Omit<CloudWorkspaceDefinition, 'revision' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
    expectedRevision: number;
  }): CloudWorkspaceDefinition {
    const current = this.ctx.storage.sql.exec<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE workspace_id=?',
      input.id,
    ).toArray()[0];
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new Error(`Workspace revision conflict: expected ${input.expectedRevision}, actual ${current?.revision ?? 0}`);
    }
    const now = new Date().toISOString();
    const revision = (current?.revision ?? 0) + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         name=excluded.name,
         branch=excluded.branch,
         phase=excluded.phase,
         source_kind=excluded.source_kind,
         source_ref=excluded.source_ref,
         lifecycle=excluded.lifecycle,
         goal_id=excluded.goal_id,
         revision=excluded.revision,
         archived_at=excluded.archived_at,
         updated_at=excluded.updated_at`,
      input.id,
      input.projectId,
      input.kind,
      input.name,
      input.branch,
      input.phase,
      input.sourceKind,
      input.sourceRef,
      input.lifecycle,
      input.goalId,
      revision,
      input.lifecycle === 'archived' ? now : null,
      current?.created_at ?? now,
      now,
    );
    return workspaceDefinition(this.ctx.storage.sql.exec<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE workspace_id=?',
      input.id,
    ).one());
  }

  removeWorkspace(workspaceId: string, expectedRevision: number): boolean {
    const current = this.ctx.storage.sql.exec<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE workspace_id=?',
      workspaceId,
    ).toArray()[0];
    if (!current) return false;
    if (current.revision !== expectedRevision) {
      throw new Error(`Workspace revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
    }
    this.environment.assertRetired(current.project_id, workspaceId);
    this.ctx.storage.sql.exec('DELETE FROM canonical_sessions WHERE workspace_id=?', workspaceId);
    this.ctx.storage.sql.exec('DELETE FROM artifact_scopes WHERE workspace_id=?', workspaceId);
    this.ctx.storage.sql.exec('UPDATE artifact_shares SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL', new Date().toISOString(), workspaceId);
    this.ctx.storage.sql.exec('DELETE FROM hosted_routes WHERE workspace_id=?', workspaceId);
    this.ctx.storage.sql.exec('DELETE FROM workspaces WHERE workspace_id=?', workspaceId);
    return true;
  }

  deleteProject(expectedRevision: number): CloudProjectSummary {
    const project = this.requireProject();
    if (project.role === GITSPACE_SOURCE_PROJECT_ROLE) throw new Error('The built-in GitSpace project cannot be deleted. Close its workspaces instead.');
    if (project.revision !== expectedRevision) {
      throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${project.revision}`);
    }
    for (const workspace of this.listWorkspaces()) this.environment.assertRetired(project.id, workspace.id);
    this.ctx.storage.sql.exec('DELETE FROM canonical_sessions');
    this.ctx.storage.sql.exec('DELETE FROM artifact_scopes');
    this.ctx.storage.sql.exec('UPDATE artifact_shares SET revoked_at=? WHERE revoked_at IS NULL', new Date().toISOString());
    this.ctx.storage.sql.exec('DELETE FROM artifact_promotions');
    this.ctx.storage.sql.exec('DELETE FROM hosted_routes');
    this.ctx.storage.sql.exec('DELETE FROM workspaces');
    this.ctx.storage.sql.exec('DELETE FROM project_mcp_grants');
    return this.setProjectLifecycle(expectedRevision, 'deleting');
  }

  createOperation(input: {
    projectId: string;
    workspaceId: string | null;
    kind: string;
    targetMachines: string[];
    steps: Array<{ id: string; label: string }>;
    createdBy: string;
  }): CloudProjectOperation {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const steps: CloudProjectOperation['steps'] = input.steps.map((step) => ({
      ...step,
      state: 'queued',
      message: null,
      updatedAt: now,
    }));
    this.ctx.storage.sql.exec(
      'INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.projectId,
      input.workspaceId,
      input.kind,
      'queued',
      JSON.stringify(input.targetMachines),
      JSON.stringify(steps),
      null,
      null,
      null,
      1,
      input.createdBy,
      now,
      now,
    );
    return this.getOperation(id);
  }

  getOperation(id: string): CloudProjectOperation {
    return projectOperation(this.ctx.storage.sql.exec<OperationRow>(
      'SELECT * FROM operations WHERE operation_id=?',
      id,
    ).one());
  }

  listOperations(): CloudProjectOperation[] {
    return this.ctx.storage.sql.exec<OperationRow>(
      'SELECT * FROM operations ORDER BY created_at DESC',
    ).toArray().map(projectOperation);
  }

  updateOperation(input: {
    id: string;
    expectedRevision: number;
    state: ProjectOperationState;
    steps: CloudProjectOperation['steps'];
    error: string | null;
    claimToken?: string | null;
    leaseExpiresAt?: string | null;
  }): CloudProjectOperation {
    const current = this.getOperation(input.id);
    if (current.revision !== input.expectedRevision) {
      throw new Error(`Operation revision conflict: expected ${input.expectedRevision}, actual ${current.revision}`);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE operations SET
         state=?,steps_json=?,error=?,claim_token=?,lease_expires_at=?,revision=revision+1,updated_at=?
       WHERE operation_id=?`,
      input.state,
      JSON.stringify(input.steps),
      input.error,
      input.claimToken ?? current.claimToken,
      input.leaseExpiresAt ?? current.leaseExpiresAt,
      now,
      input.id,
    );
    return this.getOperation(input.id);
  }

  getCanonicalSession(sessionId: string): CanonicalSession | null {
    const row = this.ctx.storage.sql.exec<CanonicalSessionRow>(
      'SELECT * FROM canonical_sessions WHERE session_id=?',
      sessionId,
    ).toArray()[0];
    return row ? canonicalSession(row) : null;
  }

  listCanonicalSessions(): CanonicalSession[] {
    return this.ctx.storage.sql.exec<CanonicalSessionRow>(
      'SELECT * FROM canonical_sessions ORDER BY created_at,session_id',
    ).toArray().map(canonicalSession);
  }

  putCanonicalSession(input: Omit<CanonicalSession, 'revision' | 'createdAt' | 'updatedAt'> & {
    expectedRevision: number;
  }): CanonicalSession {
    const current = this.getCanonicalSession(input.id);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new Error(`Canonical session revision conflict: expected ${input.expectedRevision}, actual ${current?.revision ?? 0}`);
    }
    const now = new Date().toISOString();
    const revision = (current?.revision ?? 0) + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO canonical_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace_id=excluded.workspace_id,
         omp_session_id=excluded.omp_session_id,
         machine_id=excluded.machine_id,
         state=excluded.state,
         session_object_key=excluded.session_object_key,
         session_object_hash=excluded.session_object_hash,
         session_format_version=excluded.session_format_version,
         activity_json=excluded.activity_json,
         revision=excluded.revision,
         updated_at=excluded.updated_at`,
      input.id,
      input.workspaceId,
      input.ompSessionId,
      input.machineId,
      input.state,
      input.sessionObjectKey,
      input.sessionObjectHash,
      input.sessionFormatVersion,
      JSON.stringify(input.activity),
      revision,
      current?.createdAt ?? now,
      now,
    );
    return this.getCanonicalSession(input.id)!;
  }

  getArtifactScope(scopeId: string): CanonicalArtifactScope | null {
    const row = this.ctx.storage.sql.exec<ArtifactScopeRow>(
      'SELECT * FROM artifact_scopes WHERE scope_id=?',
      scopeId,
    ).toArray()[0];
    return row ? artifactScope(row) : null;
  }

  listArtifactScopes(): CanonicalArtifactScope[] {
    return this.ctx.storage.sql.exec<ArtifactScopeRow>(
      'SELECT * FROM artifact_scopes ORDER BY scope_id',
    ).toArray().map(artifactScope);
  }

  putArtifactScope(input: Omit<CanonicalArtifactScope, 'updatedAt'> & {
    expectedGeneration: number;
  }): CanonicalArtifactScope {
    const current = this.getArtifactScope(input.id);
    if ((current?.generation ?? 0) !== input.expectedGeneration) {
      throw new Error(`Artifact scope generation conflict: expected ${input.expectedGeneration}, actual ${current?.generation ?? 0}`);
    }
    if (input.generation < input.expectedGeneration) {
      throw new Error('Artifact scope generation cannot move backward');
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO artifact_scopes VALUES(?,?,?,?,?)
       ON CONFLICT(scope_id) DO UPDATE SET
         workspace_id=excluded.workspace_id,
         generation=excluded.generation,
         manifest_hash=excluded.manifest_hash,
         updated_at=excluded.updated_at`,
      input.id,
      input.workspaceId,
      input.generation,
      input.manifestHash,
      now,
    );
    return this.getArtifactScope(input.id)!;
  }

  commitArtifactCopies(input: Parameters<ProjectAuthorityDO['putArtifactScope']>[0], copies: ArtifactCopyRecord[]): CanonicalArtifactScope {
    const project = this.requireProject();
    if (input.workspaceId !== project.id || input.generation !== input.expectedGeneration + 1 || copies.length === 0) {
      throw new Error('Copies must advance the project artifact scope once');
    }
    return this.ctx.storage.transactionSync(() => {
      const scope = this.putArtifactScope(input);
      for (const copy of copies) {
        if (copy.destinationScopeId !== scope.id || copy.destinationGeneration !== scope.generation) throw new Error('Copy provenance does not match its committed scope');
        this.ctx.storage.sql.exec('INSERT INTO artifact_copies VALUES(?,?)', copy.id, JSON.stringify(copy));
      }
      this.appendEvent({ scope: 'artifact', entity: 'artifact', entityId: scope.id, revision: scope.generation, operation: 'updated', payload: { spaceId: project.id } });
      return scope;
    });
  }

  listArtifactCopies(): ArtifactCopyRecord[] {
    return this.ctx.storage.sql.exec<{ provenance_json: string }>('SELECT provenance_json FROM artifact_copies ORDER BY copy_id').toArray().map((row) => JSON.parse(row.provenance_json) as ArtifactCopyRecord);
  }

  createArtifactShare(record: ArtifactShareRecord): ArtifactShareRecord {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(record.token) || !/^sha256:[a-f0-9]{64}$/u.test(record.hash) || record.revokedAt !== null
      || (record.expiresAt !== null && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()))) {
      throw new Error('Artifact share token, hash, or expiry is invalid');
    }
    this.ctx.storage.sql.exec('INSERT INTO artifact_shares VALUES(?,?,?,?,?,?)', record.token, record.workspaceId, record.path, record.expiresAt, null, JSON.stringify(record));
    return record;
  }

  getArtifactShare(token: string, now = new Date().toISOString()): ArtifactShareRecord | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>(
      'SELECT record_json FROM artifact_shares WHERE token=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)', token, now,
    ).toArray()[0];
    return row ? JSON.parse(row.record_json) as ArtifactShareRecord : null;
  }

  listArtifactShares(workspaceId: string, path: string): ArtifactShareRecord[] {
    return this.ctx.storage.sql.exec<{ record_json: string }>(
      'SELECT record_json FROM artifact_shares WHERE workspace_id=? AND path=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY token',
      workspaceId, path, new Date().toISOString(),
    ).toArray().map((row) => JSON.parse(row.record_json) as ArtifactShareRecord);
  }

  revokeArtifactShare(token: string, workspaceIds: string[]): boolean {
    const record = this.getArtifactShare(token);
    if (!record || !workspaceIds.includes(record.workspaceId)) return false;
    this.ctx.storage.sql.exec('UPDATE artifact_shares SET revoked_at=? WHERE token=? AND revoked_at IS NULL', new Date().toISOString(), token);
    return true;
  }

  getArtifactPromotion(id: string): CanonicalArtifactPromotion | null {
    const row = this.ctx.storage.sql.exec<ArtifactPromotionRow>(
      'SELECT * FROM artifact_promotions WHERE operation_id=?',
      id,
    ).toArray()[0];
    return row ? artifactPromotion(row) : null;
  }

  listArtifactPromotions(): CanonicalArtifactPromotion[] {
    return this.ctx.storage.sql.exec<ArtifactPromotionRow>(
      'SELECT * FROM artifact_promotions ORDER BY updated_at,operation_id',
    ).toArray().map(artifactPromotion);
  }

  putArtifactPromotion(input: Omit<CanonicalArtifactPromotion, 'updatedAt'>): CanonicalArtifactPromotion {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO artifact_promotions VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(operation_id) DO UPDATE SET
         committed_base_generation=excluded.committed_base_generation,
         state=excluded.state,
         updated_at=excluded.updated_at`,
      input.id,
      input.sourceWorkspaceId,
      input.sourceGeneration,
      input.expectedBaseGeneration,
      input.committedBaseGeneration,
      JSON.stringify(input.paths),
      input.state,
      now,
    );
    return this.getArtifactPromotion(input.id)!;
  }

  listHostedRoutes(now = new Date().toISOString()): HostedServiceRoute[] {
    this.ctx.storage.sql.exec('DELETE FROM hosted_routes WHERE lease_expires_at<=?', now);
    return this.ctx.storage.sql.exec<HostedRouteRow>(
      'SELECT * FROM hosted_routes ORDER BY hostname',
    ).toArray().map(hostedRoute);
  }

  leaseHostedRoute(input: Omit<HostedServiceRoute, 'updatedAt'>): HostedServiceRoute {
    const now = new Date().toISOString();
    if (input.leaseExpiresAt <= now) throw new Error('Hosted route lease must expire in the future');
    this.ctx.storage.sql.exec(
      `INSERT INTO hosted_routes VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(hostname) DO UPDATE SET
         workspace_id=excluded.workspace_id,
         service_name=excluded.service_name,
         machine_id=excluded.machine_id,
         ingress=excluded.ingress,
         port_name=excluded.port_name,
         port=excluded.port,
         generation=excluded.generation,
         lease_expires_at=excluded.lease_expires_at,
         health=excluded.health,
         updated_at=excluded.updated_at`,
      input.hostname,
      input.workspaceId,
      input.serviceName,
      input.machineId,
      input.ingress,
      input.portName,
      input.port,
      input.generation,
      input.leaseExpiresAt,
      input.health,
      now,
    );
    return this.listHostedRoutes(now).find((route) => route.hostname === input.hostname)!;
  }

  releaseHostedRoute(hostname: string, machineId: string): boolean {
    return this.ctx.storage.sql.exec(
      'DELETE FROM hosted_routes WHERE hostname=? AND machine_id=? RETURNING hostname',
      hostname,
      machineId,
    ).toArray().length > 0;
  }

  getMcpGrant(connectionId: string): ProjectMcpGrant | null {
    const project = this.requireProject();
    const row = this.ctx.storage.sql.exec<ProjectMcpGrantRow>(
      'SELECT * FROM project_mcp_grants WHERE project_id=? AND connection_id=?',
      project.id,
      connectionId,
    ).toArray()[0];
    return row ? projectMcpGrant(row) : null;
  }

  listMcpGrants(): ProjectMcpGrant[] {
    const project = this.requireProject();
    return this.ctx.storage.sql.exec<ProjectMcpGrantRow>(
      'SELECT * FROM project_mcp_grants WHERE project_id=? ORDER BY connection_id',
      project.id,
    ).toArray().map(projectMcpGrant);
  }

  putMcpGrant(input: {
    connectionId: string;
    enabled: boolean;
    projectSpaceEnabled: boolean;
    workspacesEnabled: boolean;
    expectedRevision: number;
    createdBy: string;
  }): ProjectMcpGrant {
    const project = this.requireProject();
    const current = this.getMcpGrant(input.connectionId);
    const actual = current?.revision ?? 0;
    if (actual !== input.expectedRevision) {
      throw new ProjectMcpGrantRevisionConflictError(input.connectionId, input.expectedRevision, actual);
    }
    const now = new Date().toISOString();
    const revision = actual + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO project_mcp_grants(project_id,connection_id,enabled,project_space_enabled,workspaces_enabled,revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id,connection_id) DO UPDATE SET
         enabled=excluded.enabled,
         project_space_enabled=excluded.project_space_enabled,
         workspaces_enabled=excluded.workspaces_enabled,
         revision=excluded.revision,
         updated_at=excluded.updated_at`,
      project.id,
      input.connectionId,
      input.enabled ? 1 : 0,
      input.projectSpaceEnabled ? 1 : 0,
      input.workspacesEnabled ? 1 : 0,
      revision,
      current?.createdBy ?? input.createdBy,
      current?.createdAt ?? now,
      now,
    );
    const grant = this.getMcpGrant(input.connectionId)!;
    this.appendEvent({
      scope: 'project',
      entity: 'mcp-grant',
      entityId: input.connectionId,
      revision,
      operation: current ? 'updated' : 'created',
      payload: { enabled: input.enabled, projectSpaceEnabled: input.projectSpaceEnabled, workspacesEnabled: input.workspacesEnabled },
    });
    return grant;
  }

  deleteMcpGrant(connectionId: string, expectedRevision: number): boolean {
    const current = this.getMcpGrant(connectionId);
    if (!current) throw new ProjectMcpGrantNotFoundError(connectionId);
    if (current.revision !== expectedRevision) {
      throw new ProjectMcpGrantRevisionConflictError(connectionId, expectedRevision, current.revision);
    }
    this.ctx.storage.sql.exec(
      'DELETE FROM project_mcp_grants WHERE project_id=? AND connection_id=? AND revision=?',
      current.projectId,
      connectionId,
      expectedRevision,
    );
    this.appendEvent({
      scope: 'project',
      entity: 'mcp-grant',
      entityId: connectionId,
      revision: current.revision + 1,
      operation: 'removed',
      payload: {},
    });
    return true;
  }

  appendEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'>): ProjectEvent {
    const offset = this.ctx.storage.sql.exec<{ offset: number }>(
      `INSERT INTO project_events(scope,entity,entity_id,revision,operation,payload_json,created_at)
       VALUES(?,?,?,?,?,?,?) RETURNING offset`,
      input.scope,
      input.entity,
      input.entityId,
      input.revision,
      input.operation,
      JSON.stringify(input.payload),
      new Date().toISOString(),
    ).one().offset;
    return this.listEvents(offset - 1)[0]!;
  }

  latestEventOffset(): number {
    return this.ctx.storage.sql.exec<{ offset: number }>('SELECT COALESCE(MAX(offset), 0) AS offset FROM project_events').one().offset;
  }

  listEvents(afterOffset: number): ProjectEvent[] {
    return this.ctx.storage.sql.exec<ProjectEventRow>(
      'SELECT * FROM project_events WHERE offset>? ORDER BY offset',
      afterOffset,
    ).toArray().map((row) => ({
      offset: row.offset,
      scope: row.scope,
      entity: row.entity,
      entityId: row.entity_id,
      revision: row.revision,
      operation: row.operation,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  private requireProject(): CloudProjectSummary {
    const project = this.getProject();
    if (!project) throw new Error('Project is not configured');
    return project;
  }
}
