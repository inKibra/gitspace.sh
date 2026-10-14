import { z } from 'zod';
import { cloudWorkspaceDefinitionSchema, projectLifecycleSchema, workspaceLifecycleSchema, type CloudProjectSummary, type CloudWorkspaceDefinition, type ProjectLifecycle } from '@gitspace/protocol';
import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { WorkspaceStatusSummarySchema, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';

/** What a workspace object knows about itself: its identity, lifecycle, branch and phase, and the project lifecycle its
 * write policy needs. Runtime access is decided from this record alone; the project authority is read once to seed it. */
export const WorkspaceMetadataSchema = z.object({
  projectId: RuntimeIdentitySchema.shape.projectId,
  workspaceId: RuntimeIdentitySchema.shape.workspaceId,
  kind: cloudWorkspaceDefinitionSchema.shape.kind,
  lifecycle: workspaceLifecycleSchema,
  /** The workspace branch; for the project base workspace, the base branch. */
  branch: z.string().min(1),
  phase: cloudWorkspaceDefinitionSchema.shape.phase,
  /** The definition revision the project authority last recorded for this workspace. */
  revision: z.number().int().nonnegative(),
  projectLifecycle: projectLifecycleSchema,
  /** The project revision `projectLifecycle` was decided at. */
  projectRevision: z.number().int().nonnegative(),
});
export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;

export function createWorkspaceMetadataTables(storage: DurableObjectStorage): void {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_metadata(id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_status(id INTEGER PRIMARY KEY CHECK (id = 1), summary TEXT NOT NULL)');
}

export function readWorkspaceMetadata(storage: DurableObjectStorage): WorkspaceMetadata | null {
  const row = storage.sql.exec<{ record: string }>('SELECT record FROM workspace_metadata WHERE id=1').toArray()[0];
  return row ? WorkspaceMetadataSchema.parse(JSON.parse(row.record)) : null;
}

/** Writes only a changed record. */
export function writeWorkspaceMetadata(storage: DurableObjectStorage, metadata: WorkspaceMetadata): WorkspaceMetadata {
  const record = JSON.stringify(WorkspaceMetadataSchema.parse(metadata));
  if (storage.sql.exec<{ record: string }>('SELECT record FROM workspace_metadata WHERE id=1').toArray()[0]?.record !== record) {
    storage.sql.exec('INSERT INTO workspace_metadata(id,record) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', record);
  }
  return metadata;
}

/** Takes the project's definition of this workspace and its project state, each only when newer than what is held:
 * a stale read never undoes a change this workspace already applied to itself. */
export function adoptWorkspaceMetadata(current: WorkspaceMetadata | null, workspace: CloudWorkspaceDefinition, project: Pick<CloudProjectSummary, 'id' | 'lifecycle' | 'revision'>): WorkspaceMetadata {
  if (workspace.projectId !== project.id || (current && (current.projectId !== workspace.projectId || current.workspaceId !== workspace.id))) throw new Error('Workspace metadata identity mismatch');
  const definition = !current || workspace.revision > current.revision
    ? { lifecycle: workspace.lifecycle, branch: workspace.branch, phase: workspace.phase, revision: workspace.revision }
    : { lifecycle: current.lifecycle, branch: current.branch, phase: current.phase, revision: current.revision };
  const projectState = !current || project.revision > current.projectRevision
    ? { projectLifecycle: project.lifecycle, projectRevision: project.revision }
    : { projectLifecycle: current.projectLifecycle, projectRevision: current.projectRevision };
  return WorkspaceMetadataSchema.parse({ projectId: workspace.projectId, workspaceId: workspace.id, kind: workspace.kind, ...definition, ...projectState });
}

/** Opening a cloud-only project or provisioning a new one bootstraps runtime state before the project turns active. */
export function projectAcceptsWrites(lifecycle: ProjectLifecycle): boolean {
  return lifecycle === 'active' || lifecycle === 'cloud-only' || lifecycle === 'provisioning';
}

/** Runtime access rules: a deleting project or workspace is unavailable; an archived or archiving workspace, or a
 * project that is not writable, is read-only. */
export function authorizeWorkspaceRuntime(metadata: WorkspaceMetadata, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, write: boolean): WorkspaceMetadata {
  if (metadata.projectId !== identity.projectId || metadata.workspaceId !== identity.workspaceId) throw new Error('Workspace does not belong to the requested project');
  if (metadata.projectLifecycle === 'deleting') throw new Error('Runtime project is unavailable');
  const worktree = metadata.kind === 'worktree';
  if (worktree && metadata.lifecycle === 'deleting') throw new Error('Runtime workspace is unavailable');
  if (write && (!projectAcceptsWrites(metadata.projectLifecycle) || (worktree && (metadata.lifecycle === 'archiving' || metadata.lifecycle === 'archived')))) throw new Error('Archived runtime state is read-only');
  return metadata;
}

/** Stores the status summary the runtime published; an unchanged summary writes nothing. */
export function storeWorkspaceStatus(storage: DurableObjectStorage, summary: WorkspaceStatusSummary): void {
  const encoded = JSON.stringify(summary);
  if (storage.sql.exec<{ summary: string }>('SELECT summary FROM workspace_status WHERE id=1').toArray()[0]?.summary !== encoded) {
    storage.sql.exec('INSERT INTO workspace_status(id,summary) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary', encoded);
  }
}

/** A summary stored by a release that derived it from conversation flags reads as unreported until the runtime publishes again. */
export function readWorkspaceStatus(storage: DurableObjectStorage): WorkspaceStatusSummary | null {
  const row = storage.sql.exec<{ summary: string }>('SELECT summary FROM workspace_status WHERE id=1').toArray()[0];
  const stored = row ? WorkspaceStatusSummarySchema.safeParse(JSON.parse(row.summary)) : null;
  return stored?.success ? stored.data : null;
}
