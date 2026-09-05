import type { SessionActivity } from '@gitspace/protocol';
import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repositoryReference: text('repository_reference'),
  baseBranch: text('base_branch').notNull().default('main'),
  ...timestamps,
}, (table) => [
  uniqueIndex('projects_name_unique').on(table.name),
]);

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['base', 'worktree'] }).notNull(),
  name: text('name').notNull(),
  branch: text('branch').notNull(),
  phase: text('phase', { enum: ['plan', 'code', 'review', 'ship'] }),
  closedAt: text('closed_at'),
  ...timestamps,
}, (table) => [
  uniqueIndex('spaces_project_kind_name_unique').on(table.projectId, table.kind, table.name),
  uniqueIndex('spaces_project_base_unique').on(table.projectId).where(sql`${table.kind} = 'base'`),
  index('spaces_project_idx').on(table.projectId, table.createdAt, table.id),
  check('spaces_kind_check', sql`${table.kind} IN ('base', 'worktree')`),
  check('spaces_phase_check', sql`(${table.kind} = 'base' AND ${table.phase} IS NULL) OR (${table.kind} = 'worktree' AND ${table.phase} IN ('plan', 'code', 'review', 'ship'))`),
]);

export const spacePlacements = sqliteTable('space_placements', {
  spaceId: text('space_id').primaryKey().references(() => spaces.id, { onDelete: 'cascade' }),
  holderId: text('holder_id').notNull(),
  generation: integer('generation').notNull().default(0),
  rootPath: text('root_path').notNull(),
  state: text('state', { enum: ['opening', 'open', 'closing', 'closed'] }).notNull().default('open'),
  acquiredAt: text('acquired_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('space_placements_generation_check', sql`${table.generation} >= 0`),
  check('space_placements_state_check', sql`${table.state} IN ('opening', 'open', 'closing', 'closed')`),
]);

export const spaceRelations = sqliteTable('space_relations', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  relatedId: text('related_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['dependsOn', 'relatedTo', 'stackedOn'] }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.spaceId, table.relatedId, table.kind] }),
  index('space_relations_related_idx').on(table.relatedId),
  check('space_relations_kind_check', sql`${table.kind} IN ('dependsOn', 'relatedTo', 'stackedOn')`),
  check('space_relations_self_check', sql`${table.spaceId} <> ${table.relatedId}`),
]);

/** Machine-local mirror of the vault's device grants; verified against the root key before use. */
export const deviceGrants = sqliteTable('device_grants', {
  deviceId: text('device_id').primaryKey(),
  kind: text('kind').notNull(),
  recordJson: text('record_json').notNull(),
  generation: integer('generation').notNull(),
  revokedAt: integer('revoked_at'),
  updatedAt: text('updated_at').notNull(),
});
export type DeviceGrantRow = typeof deviceGrants.$inferSelect;


export const artifactScopes = sqliteTable('artifact_scopes', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  generation: integer('generation').notNull().default(0),
  dirty: integer('dirty', { mode: 'boolean' }).notNull().default(false),
  manifestHash: text('manifest_hash'),
  ...timestamps,
}, (table) => [
  uniqueIndex('artifact_scopes_space_unique').on(table.spaceId),
  check('artifact_scopes_generation_check', sql`${table.generation} >= 0`),
]);

export const artifactEntries = sqliteTable('artifact_entries', {
  scopeId: text('scope_id').notNull().references(() => artifactScopes.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  blobHash: text('blob_hash').notNull(),
  size: integer('size').notNull(),
  mediaType: text('media_type'),
  generation: integer('generation').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.path] }),
  index('artifact_entries_blob_idx').on(table.blobHash),
  check('artifact_entries_size_check', sql`${table.size} >= 0`),
]);

export const artifactBlobs = sqliteTable('artifact_blobs', {
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
  cachePath: text('cache_path'),
  state: text('state', { enum: ['remote', 'cached', 'dirty', 'uploading'] }).notNull(),
  lastAccessedAt: text('last_accessed_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  check('artifact_blobs_size_check', sql`${table.size} >= 0`),
  check('artifact_blobs_state_check', sql`${table.state} IN ('remote', 'cached', 'dirty', 'uploading')`),
]);

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  ompSessionId: text('omp_session_id').notNull(),
  sessionFile: text('session_file').notNull(),
  state: text('state', { enum: ['opening', 'active', 'draining', 'closed', 'failed'] }).notNull(),
  lastEventOffset: integer('last_event_offset').notNull().default(0),
  resumePending: integer('resume_pending', { mode: 'boolean' }).notNull().default(false),
  activity: text('activity_json', { mode: 'json' }).notNull().$type<SessionActivity>().default({ active: false, reasons: [] }),
  errorMessage: text('error_message'),
  ...timestamps,
}, (table) => [
  uniqueIndex('agent_sessions_omp_session_unique').on(table.ompSessionId),
  uniqueIndex('agent_sessions_space_unique').on(table.spaceId),
  check('agent_sessions_state_check', sql`${table.state} IN ('opening', 'active', 'draining', 'closed', 'failed')`),
]);


export const factEvents = sqliteTable('fact_events', {
  offset: integer('offset').primaryKey({ autoIncrement: true }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  scope: text('scope', { enum: ['machine', 'project', 'workspace', 'session', 'artifact', 'code'] }).notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  revision: integer('revision').notNull(),
  operation: text('operation', { enum: ['created', 'updated', 'removed', 'append', 'invalidate', 'code-version'] }).notNull(),
  payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('fact_events_project_offset_idx').on(table.projectId, table.offset),
  check('fact_events_scope_check', sql`${table.scope} IN ('machine', 'project', 'workspace', 'session', 'artifact', 'code')`),
  check('fact_events_operation_check', sql`${table.operation} IN ('created', 'updated', 'removed', 'append', 'invalidate', 'code-version')`),
]);

export const artifactPromotions = sqliteTable('artifact_promotions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceSpaceId: text('source_space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  sourceGeneration: integer('source_generation').notNull(),
  expectedBaseGeneration: integer('expected_base_generation').notNull(),
  committedBaseGeneration: integer('committed_base_generation'),
  paths: text('paths', { mode: 'json' }).notNull().$type<string[]>(),
  state: text('state', { enum: ['planned', 'committed', 'conflict'] }).notNull(),
  ...timestamps,
}, (table) => [
  index('artifact_promotions_project_idx').on(table.projectId, table.createdAt),
  check('artifact_promotions_state_check', sql`${table.state} IN ('planned', 'committed', 'conflict')`),
]);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
export type SpacePlacement = typeof spacePlacements.$inferSelect;
export type MaterializedSpace = Space & { rootPath: string; holderId: string; generation: number; placementState: SpacePlacement['state'] };
export type Workspace = Omit<MaterializedSpace, 'kind' | 'phase'> & { kind: 'worktree'; phase: 'plan' | 'code' | 'review' | 'ship' };
export type WorkspacePossession = SpacePlacement;
export type SpaceRelation = typeof spaceRelations.$inferSelect;
export type ArtifactScope = typeof artifactScopes.$inferSelect;
export type ArtifactEntry = typeof artifactEntries.$inferSelect;
export type ArtifactBlob = typeof artifactBlobs.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type ArtifactPromotion = typeof artifactPromotions.$inferSelect;
export type FactEvent = typeof factEvents.$inferSelect;
