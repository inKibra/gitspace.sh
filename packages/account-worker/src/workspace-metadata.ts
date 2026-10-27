import { z } from 'zod';
import { cloudWorkspaceDefinitionSchema, projectLifecycleSchema, workspaceLifecycleSchema, type CloudProjectSummary, type CloudWorkspaceDefinition, type ProjectLifecycle } from '@gitspace/protocol';
import { RuntimeGitCheckpointSchema, RuntimeIdentitySchema, type RuntimeGitCheckpoint, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { WorkspaceReportSchema, WorkspaceStatusSummarySchema, type WorkspaceReport, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';

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
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_source_checkpoint(id INTEGER PRIMARY KEY CHECK (id = 1), checkpoint TEXT NOT NULL)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_report(id INTEGER PRIMARY KEY CHECK (id = 1), report TEXT NOT NULL)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_project_watch(id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
  // Automation runs submitted here whose turn's end has not reached the project's automations (automation-turns.ts).
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_automation_turns(request_id TEXT PRIMARY KEY, started INTEGER NOT NULL DEFAULT 0)');
}

/** A workspace created from another workspace starts from that workspace's whole checkpoint, uncommitted edits included. */
export function writeSourceCheckpoint(storage: DurableObjectStorage, checkpoint: RuntimeGitCheckpoint): void {
  storage.sql.exec('INSERT INTO workspace_source_checkpoint(id,checkpoint) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checkpoint=excluded.checkpoint', JSON.stringify(RuntimeGitCheckpointSchema.parse(checkpoint)));
}

export function readSourceCheckpoint(storage: DurableObjectStorage): RuntimeGitCheckpoint | null {
  const row = storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM workspace_source_checkpoint WHERE id=1').toArray()[0];
  return row ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint)) : null;
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

/** Only an archived project is read-only; a project that is provisioning, archiving, restoring or failed keeps
 * accepting writes, so a stuck or failed project operation never locks its workspaces. */
export function projectAcceptsWrites(lifecycle: ProjectLifecycle): boolean {
  return lifecycle !== 'archived';
}

/** Runtime access rules: a deleting project or workspace is unavailable; an archived or archiving workspace, or an
 * archived project, is read-only. */
export function authorizeWorkspaceRuntime(metadata: WorkspaceMetadata, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, write: boolean): WorkspaceMetadata {
  if (metadata.projectId !== identity.projectId || metadata.workspaceId !== identity.workspaceId) throw new Error('Workspace does not belong to the requested project');
  if (metadata.projectLifecycle === 'deleting') throw new Error('Runtime project is unavailable');
  const worktree = metadata.kind === 'worktree';
  if (worktree && metadata.lifecycle === 'deleting') throw new Error('Runtime workspace is unavailable');
  if (write && (!projectAcceptsWrites(metadata.projectLifecycle) || (worktree && (metadata.lifecycle === 'archiving' || metadata.lifecycle === 'archived')))) throw new Error('Archived runtime state is read-only');
  return metadata;
}

/** Stores the status summary the runtime published; an unchanged summary writes nothing. */
/** Returns whether the stored summary changed. */
export function storeWorkspaceStatus(storage: DurableObjectStorage, summary: WorkspaceStatusSummary): boolean {
  const encoded = JSON.stringify(summary);
  if (storage.sql.exec<{ summary: string }>('SELECT summary FROM workspace_status WHERE id=1').toArray()[0]?.summary === encoded) return false;
  storage.sql.exec('INSERT INTO workspace_status(id,summary) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary', encoded);
  return true;
}

/** A summary stored by a release that derived it from conversation flags reads as unreported until the runtime publishes again. */
export function readWorkspaceStatus(storage: DurableObjectStorage): WorkspaceStatusSummary | null {
  const row = storage.sql.exec<{ summary: string }>('SELECT summary FROM workspace_status WHERE id=1').toArray()[0];
  const stored = row ? WorkspaceStatusSummarySchema.safeParse(JSON.parse(row.summary)) : null;
  return stored?.success ? stored.data : null;
}

/** The report the runtime published last, for project agents reading this workspace without opening it. */
export function storeWorkspaceReport(storage: DurableObjectStorage, report: WorkspaceReport): void {
  storage.sql.exec('INSERT INTO workspace_report(id,report) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET report=excluded.report', JSON.stringify(report));
}

export function readWorkspaceReport(storage: DurableObjectStorage): WorkspaceReport | null {
  const row = storage.sql.exec<{ report: string }>('SELECT report FROM workspace_report WHERE id=1').toArray()[0];
  const stored = row ? WorkspaceReportSchema.safeParse(JSON.parse(row.report)) : null;
  return stored?.success ? stored.data : null;
}

const ProjectWatchSchema = z.object({
  /** The workspace name the report shows. */
  name: z.string(),
  /** The project agent's submission: only the turn it starts reports. */
  requestId: z.string().min(1),
  onDone: z.enum(['quiet', 'wake']),
  armedAt: z.number().int(),
  /** When that turn started; null while the submission waits behind another turn. */
  startedAt: z.number().int().nullable(),
});
/** The one turn of this workspace the project agent started and has not heard back from: it reports once, when it
 * ends or stops for a person, and a person writing here ends it silently. */
export type ProjectWatch = z.infer<typeof ProjectWatchSchema>;

export function writeProjectWatch(storage: DurableObjectStorage, watch: ProjectWatch): void {
  storage.sql.exec('INSERT INTO workspace_project_watch(id,record) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', JSON.stringify(ProjectWatchSchema.parse(watch)));
}

/** A watch an older release stored (a status color, not a turn) reads as none: it never reports again. */
export function readProjectWatch(storage: DurableObjectStorage): ProjectWatch | null {
  const row = storage.sql.exec<{ record: string }>('SELECT record FROM workspace_project_watch WHERE id=1').toArray()[0];
  const stored = row ? ProjectWatchSchema.safeParse(JSON.parse(row.record)) : null;
  return stored?.success ? stored.data : null;
}

export function deleteProjectWatch(storage: DurableObjectStorage): void {
  storage.sql.exec('DELETE FROM workspace_project_watch WHERE id=1');
}
