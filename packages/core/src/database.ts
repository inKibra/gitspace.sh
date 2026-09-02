import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { z } from 'zod';
import { dependencyCycle } from '@gitspace/protocol';
import { emptyRelations, normalizeRelations, type WorkspaceRelations, type WorkspaceRelationsInput } from './relations.js';
import {
  artifactScopes,
  projects,
  spacePlacements,
  spaceRelations,
  spaces,
  type MaterializedSpace,
  type Project,
  type Space,
  type SpacePlacement,
  type Workspace,
  type WorkspacePossession,
} from './schema.js';
import * as schema from './schema.js';

const idSchema = z.string().min(1).max(160);
const nameSchema = z.string().trim().min(1).max(160);
const pathSchema = z.string().min(1);
const branchSchema = z.string().min(1).max(512);
const phaseSchema = z.enum(['plan', 'code', 'review', 'ship']);

export class CoreInputError extends TaggedError('CoreInputError')<{ message: string }> {}
export class CoreConflict extends TaggedError('CoreConflict')<{
  resource: 'project' | 'space' | 'workspace' | 'possession';
  id: string;
  message: string;
}> {}
export class CoreNotFound extends TaggedError('CoreNotFound')<{
  resource: 'project' | 'space' | 'workspace' | 'possession';
  id: string;
  message: string;
}> {}

function inputError(error: unknown): CoreInputError {
  return new CoreInputError({ message: error instanceof Error ? error.message : String(error) });
}

function conflict(resource: CoreConflict['resource'], id: string, error: unknown): CoreConflict {
  return new CoreConflict({
    resource,
    id,
    message: error instanceof Error ? error.message : String(error),
  });
}

export interface GitSpaceDatabaseOptions {
  migrationsFolder?: string;
}

export class GitSpaceDatabase {
  readonly orm: BunSQLiteDatabase<typeof schema>;
  private readonly sqlite: Database;

  constructor(databasePath: string, options: GitSpaceDatabaseOptions = {}) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.sqlite = new Database(databasePath, { create: true, strict: true });
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.orm = drizzle(this.sqlite, { schema });
    migrate(this.orm, {
      migrationsFolder: options.migrationsFolder ?? fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  }

  close(): void {
    this.sqlite.close();
  }

  checkpoint(): void {
    this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  migrationCount(): number {
    const row = this.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM __drizzle_migrations',
    ).get();
    return row?.count ?? 0;
  }

  createProject(input: {
    id?: string;
    name: string;
    repositoryPath: string;
    repositoryReference?: string;
    baseBranch?: string;
  }): ResultType<Project, CoreInputError | CoreConflict> {
    let parsed: { id: string; name: string; repositoryPath: string; repositoryReference?: string; baseBranch: string };
    try {
      parsed = z.object({
        id: idSchema.default(() => crypto.randomUUID()),
        name: nameSchema,
        repositoryPath: pathSchema,
        repositoryReference: z.string().min(1).optional(),
        baseBranch: branchSchema.default('main'),
      }).parse(input);
    } catch (error) {
      return Result.err(inputError(error));
    }
    const now = new Date().toISOString();
    try {
      const project = this.orm.transaction((tx) => {
        const created = tx.insert(projects).values({
          id: parsed.id,
          name: parsed.name,
          repositoryReference: parsed.repositoryReference ?? null,
          baseBranch: parsed.baseBranch,
          createdAt: now,
          updatedAt: now,
        }).returning().get();
        tx.insert(spaces).values({
          id: created.id,
          projectId: created.id,
          kind: 'base',
          name: created.name,
          branch: created.baseBranch,
          phase: null,
          createdAt: now,
          updatedAt: now,
        }).run();
        tx.insert(spacePlacements).values({
          spaceId: created.id,
          holderId: 'unassigned',
          generation: 0,
          rootPath: parsed.repositoryPath,
          state: 'closed',
          acquiredAt: now,
          updatedAt: now,
        }).run();
        tx.insert(artifactScopes).values({
          id: `space:${created.id}`,
          spaceId: created.id,
          generation: 0,
          createdAt: now,
          updatedAt: now,
        }).run();
        return created;
      });
      return Result.ok(project);
    } catch (error) {
      return Result.err(conflict('project', parsed.id, error));
    }
  }

  getProject(id: string): Project | null {
    return this.orm.select().from(projects).where(eq(projects.id, id)).get() ?? null;
  }

  listProjects(): Project[] {
    return this.orm.select().from(projects).orderBy(projects.createdAt, projects.id).all();
  }

  createWorkspace(input: {
    id?: string;
    projectId: string;
    name: string;
    branch: string;
    rootPath: string;
    phase?: Workspace['phase'];
  }): ResultType<Workspace, CoreInputError | CoreConflict | CoreNotFound> {
    let parsed: { id: string; projectId: string; name: string; branch: string; rootPath: string; phase: Workspace['phase'] };
    try {
      parsed = z.object({
        id: idSchema.default(() => crypto.randomUUID()),
        projectId: idSchema,
        name: nameSchema,
        branch: branchSchema,
        rootPath: pathSchema,
        phase: phaseSchema.default('code'),
      }).parse(input);
    } catch (error) {
      return Result.err(inputError(error));
    }
    if (!this.getProject(parsed.projectId)) {
      return Result.err(new CoreNotFound({ resource: 'project', id: parsed.projectId, message: `Project ${parsed.projectId} does not exist` }));
    }
    const now = new Date().toISOString();
    try {
      this.orm.transaction((tx) => {
        tx.insert(spaces).values({
          id: parsed.id,
          projectId: parsed.projectId,
          kind: 'worktree',
          name: parsed.name,
          branch: parsed.branch,
          phase: parsed.phase,
          createdAt: now,
          updatedAt: now,
        }).run();
        tx.insert(spacePlacements).values({
          spaceId: parsed.id,
          holderId: 'unassigned',
          generation: 0,
          rootPath: parsed.rootPath,
          state: 'closed',
          acquiredAt: now,
          updatedAt: now,
        }).run();
        tx.insert(artifactScopes).values({
          id: `space:${parsed.id}`,
          spaceId: parsed.id,
          generation: 0,
          createdAt: now,
          updatedAt: now,
        }).run();
      });
      return Result.ok(this.getWorkspace(parsed.id)!);
    } catch (error) {
      return Result.err(conflict('workspace', parsed.id, error));
    }
  }

  getSpace(id: string): MaterializedSpace | null {
    const row = this.orm.select({ space: spaces, placement: spacePlacements })
      .from(spaces)
      .innerJoin(spacePlacements, eq(spacePlacements.spaceId, spaces.id))
      .where(eq(spaces.id, id)).get();
    return row ? materialized(row.space, row.placement) : null;
  }

  getBaseSpace(projectId: string): MaterializedSpace | null {
    const row = this.orm.select({ space: spaces, placement: spacePlacements })
      .from(spaces)
      .innerJoin(spacePlacements, eq(spacePlacements.spaceId, spaces.id))
      .where(and(eq(spaces.projectId, projectId), eq(spaces.kind, 'base'))).get();
    return row ? materialized(row.space, row.placement) : null;
  }

  listSpaces(projectId: string): MaterializedSpace[] {
    return this.orm.select({ space: spaces, placement: spacePlacements })
      .from(spaces)
      .innerJoin(spacePlacements, eq(spacePlacements.spaceId, spaces.id))
      .where(eq(spaces.projectId, projectId))
      .orderBy(spaces.createdAt, spaces.id).all()
      .map((row) => materialized(row.space, row.placement));
  }

  getWorkspace(id: string): Workspace | null {
    const space = this.getSpace(id);
    return space?.kind === 'worktree' && space.phase ? space as Workspace : null;
  }

  listWorkspaces(projectId: string): Workspace[] {
    return this.listSpaces(projectId).filter((space): space is Workspace => space.kind === 'worktree' && space.phase !== null);
  }

  setWorkspacePhase(workspaceId: string, phase: Workspace['phase']): Workspace | null {
    const parsed = phaseSchema.parse(phase);
    const current = this.getWorkspace(workspaceId);
    if (!current) return null;
    this.orm.update(spaces).set({ phase: parsed, updatedAt: new Date().toISOString() }).where(eq(spaces.id, workspaceId)).run();
    return this.getWorkspace(workspaceId);
  }

  getSpaceRelations(spaceId: string): WorkspaceRelations {
    const relations = emptyRelations();
    const rows = this.orm.select({ relatedId: spaceRelations.relatedId, kind: spaceRelations.kind })
      .from(spaceRelations).where(eq(spaceRelations.spaceId, spaceId)).orderBy(spaceRelations.relatedId).all();
    for (const row of rows) {
      if (row.kind === 'stackedOn') relations.stackedOn = row.relatedId;
      else relations[row.kind].push(row.relatedId);
    }
    return relations;
  }

  listSpaceRelations(projectId: string): Map<string, WorkspaceRelations> {
    const relations = new Map<string, WorkspaceRelations>();
    const rows = this.orm.select({ spaceId: spaceRelations.spaceId, relatedId: spaceRelations.relatedId, kind: spaceRelations.kind })
      .from(spaceRelations)
      .innerJoin(spaces, eq(spaces.id, spaceRelations.spaceId))
      .where(eq(spaces.projectId, projectId))
      .orderBy(spaceRelations.spaceId, spaceRelations.relatedId).all();
    for (const row of rows) {
      let entry = relations.get(row.spaceId);
      if (!entry) relations.set(row.spaceId, entry = emptyRelations());
      if (row.kind === 'stackedOn') entry.stackedOn = row.relatedId;
      else entry[row.kind].push(row.relatedId);
    }
    return relations;
  }

  setSpaceRelations(workspaceId: string, input: WorkspaceRelationsInput): ResultType<WorkspaceRelations, CoreInputError | CoreNotFound> {
    let parsed: WorkspaceRelations;
    try {
      parsed = z.object({ dependsOn: z.array(idSchema), relatedTo: z.array(idSchema), stackedOn: idSchema.nullable() }).parse(input);
    } catch (error) {
      return Result.err(inputError(error));
    }
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) return Result.err(new CoreNotFound({ resource: 'workspace', id: workspaceId, message: `Workspace ${workspaceId} does not exist` }));
    if (parsed.dependsOn.includes(workspaceId) || parsed.relatedTo.includes(workspaceId) || parsed.stackedOn === workspaceId) {
      return Result.err(new CoreInputError({ message: `Workspace ${workspaceId} cannot relate to itself` }));
    }
    const relations = normalizeRelations(workspaceId, parsed);
    const requested = [...relations.dependsOn, ...relations.relatedTo];
    if (requested.length > 0) {
      const known = new Set(this.orm.select({ id: spaces.id }).from(spaces)
        .where(and(eq(spaces.projectId, workspace.projectId), eq(spaces.kind, 'worktree'), inArray(spaces.id, requested)))
        .all().map((row) => row.id));
      const missing = requested.find((id) => !known.has(id));
      if (missing) return Result.err(new CoreNotFound({ resource: 'workspace', id: missing, message: `Workspace ${missing} does not exist in project ${workspace.projectId}` }));
    }
    if (relations.dependsOn.length > 0) {
      const edges = new Map<string, readonly string[]>();
      for (const [id, entry] of this.listSpaceRelations(workspace.projectId)) edges.set(id, entry.dependsOn);
      const loop = dependencyCycle(workspaceId, relations.dependsOn, edges);
      if (loop) {
        const names = loop.map((id) => this.getWorkspace(id)?.name ?? id);
        return Result.err(new CoreInputError({ message: `Dependency cycle: ${names.join(' → ')}` }));
      }
    }
    this.orm.transaction((tx) => {
      tx.delete(spaceRelations).where(eq(spaceRelations.spaceId, workspaceId)).run();
      const rows = [
        ...relations.dependsOn.map((relatedId) => ({ spaceId: workspaceId, relatedId, kind: 'dependsOn' as const })),
        ...relations.relatedTo.map((relatedId) => ({ spaceId: workspaceId, relatedId, kind: 'relatedTo' as const })),
        ...(relations.stackedOn ? [{ spaceId: workspaceId, relatedId: relations.stackedOn, kind: 'stackedOn' as const }] : []),
      ];
      if (rows.length > 0) tx.insert(spaceRelations).values(rows).run();
      tx.update(spaces).set({ updatedAt: new Date().toISOString() }).where(eq(spaces.id, workspaceId)).run();
    });
    return Result.ok(relations);
  }

  getSpacePlacement(spaceId: string): SpacePlacement | null {
    return this.orm.select().from(spacePlacements).where(eq(spacePlacements.spaceId, spaceId)).get() ?? null;
  }

  getWorkspacePossession(workspaceId: string): WorkspacePossession | null {
    const placement = this.getSpacePlacement(workspaceId);
    return placement && placement.state !== 'closed' && placement.holderId !== 'unassigned' ? placement : null;
  }

  setSpaceClosed(spaceId: string, closed: boolean): MaterializedSpace | null {
    const now = new Date().toISOString();
    this.orm.update(spaces).set({ closedAt: closed ? now : null, updatedAt: now }).where(eq(spaces.id, spaceId)).run();
    return this.getSpace(spaceId);
  }

  possessSpace(spaceId: string, holderId: string, rootPath?: string): ResultType<SpacePlacement, CoreInputError | CoreConflict | CoreNotFound> {
    try {
      idSchema.parse(spaceId);
      idSchema.parse(holderId);
      if (rootPath !== undefined) pathSchema.parse(rootPath);
    } catch (error) {
      return Result.err(inputError(error));
    }
    if (!this.getSpace(spaceId)) return Result.err(new CoreNotFound({ resource: 'space', id: spaceId, message: `Space ${spaceId} does not exist` }));
    const existing = this.getSpacePlacement(spaceId)!;
    if (existing.state !== 'closed') {
      return existing.holderId === holderId
        ? Result.ok(existing)
        : Result.err(conflict('possession', spaceId, `Space ${spaceId} is possessed by ${existing.holderId}`));
    }
    const now = new Date().toISOString();
    const changed = this.orm.update(spacePlacements).set({
      holderId,
      generation: existing.generation + 1,
      rootPath: rootPath ?? existing.rootPath,
      state: 'open',
      acquiredAt: now,
      updatedAt: now,
    }).where(and(eq(spacePlacements.spaceId, spaceId), eq(spacePlacements.generation, existing.generation), eq(spacePlacements.state, 'closed')))
      .returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', spaceId, 'Space possession changed before acquisition'));
  }

  possessWorkspace(workspaceId: string, holderId: string): ResultType<WorkspacePossession, CoreInputError | CoreConflict | CoreNotFound> {
    if (!this.getWorkspace(workspaceId)) return Result.err(new CoreNotFound({ resource: 'workspace', id: workspaceId, message: `Workspace ${workspaceId} does not exist` }));
    return this.possessSpace(workspaceId, holderId);
  }

  transferSpacePossession(input: { spaceId: string; fromHolderId: string; toHolderId: string; expectedGeneration: number }): ResultType<SpacePlacement, CoreInputError | CoreConflict | CoreNotFound> {
    try {
      idSchema.parse(input.spaceId);
      idSchema.parse(input.fromHolderId);
      idSchema.parse(input.toHolderId);
      z.number().int().positive().parse(input.expectedGeneration);
    } catch (error) {
      return Result.err(inputError(error));
    }
    const changed = this.orm.update(spacePlacements).set({
      holderId: input.toHolderId,
      generation: input.expectedGeneration + 1,
      acquiredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.fromHolderId),
      eq(spacePlacements.generation, input.expectedGeneration),
      eq(spacePlacements.state, 'open'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space possession changed before transfer'));
  }

  transferWorkspacePossession(input: { workspaceId: string; fromHolderId: string; toHolderId: string; expectedGeneration: number }): ResultType<WorkspacePossession, CoreInputError | CoreConflict | CoreNotFound> {
    return this.transferSpacePossession({ spaceId: input.workspaceId, fromHolderId: input.fromHolderId, toHolderId: input.toHolderId, expectedGeneration: input.expectedGeneration });
  }
  alignClosedSpaceProjection(spaceId: string, generation: number): ResultType<SpacePlacement, CoreConflict> {
    const current = this.getSpacePlacement(spaceId);
    if (current?.state === 'closed' && current.holderId === 'unassigned' && current.generation === generation) return Result.ok(current);
    const changed = this.orm.update(spacePlacements).set({
      generation,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, spaceId),
      eq(spacePlacements.holderId, 'unassigned'),
      eq(spacePlacements.generation, 0),
      eq(spacePlacements.state, 'closed'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', spaceId, 'Closed space projection cannot align to the authority generation'));
  }

  beginSpaceClose(input: { spaceId: string; holderId: string; expectedGeneration: number }): ResultType<SpacePlacement, CoreConflict> {
    const changed = this.orm.update(spacePlacements).set({
      state: 'closing',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.holderId),
      eq(spacePlacements.generation, input.expectedGeneration),
      eq(spacePlacements.state, 'open'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space placement changed before close'));
  }

  commitSpaceClosed(input: { spaceId: string; holderId: string; expectedGeneration: number }): ResultType<SpacePlacement, CoreConflict> {
    const changed = this.orm.update(spacePlacements).set({
      holderId: 'unassigned',
      generation: input.expectedGeneration + 1,
      state: 'closed',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.holderId),
      eq(spacePlacements.generation, input.expectedGeneration),
      eq(spacePlacements.state, 'closing'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space placement changed while committing close'));
  }

  abortSpaceClose(input: { spaceId: string; holderId: string; expectedGeneration: number }): ResultType<SpacePlacement, CoreConflict> {
    const changed = this.orm.update(spacePlacements).set({
      state: 'open',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.holderId),
      eq(spacePlacements.generation, input.expectedGeneration),
      eq(spacePlacements.state, 'closing'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space placement changed while aborting close'));
  }

  beginSpaceOpen(input: { spaceId: string; holderId: string; expectedGeneration: number; rootPath?: string }): ResultType<SpacePlacement, CoreConflict> {
    const now = new Date().toISOString();
    const changed = this.orm.update(spacePlacements).set({
      holderId: input.holderId,
      generation: input.expectedGeneration + 1,
      state: 'opening',
      ...(input.rootPath ? { rootPath: input.rootPath } : {}),
      acquiredAt: now,
      updatedAt: now,
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.generation, input.expectedGeneration),
      eq(spacePlacements.state, 'closed'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space placement changed before open'));
  }

  commitSpaceOpen(input: { spaceId: string; holderId: string; generation: number }): ResultType<SpacePlacement, CoreConflict> {
    const changed = this.orm.update(spacePlacements).set({
      state: 'open',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.holderId),
      eq(spacePlacements.generation, input.generation),
      eq(spacePlacements.state, 'opening'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space placement changed while committing open'));
  }

  failSpaceOpen(input: { spaceId: string; holderId: string; generation: number }): ResultType<SpacePlacement, CoreConflict> {
    const changed = this.orm.update(spacePlacements).set({
      holderId: 'unassigned',
      state: 'closed',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.holderId),
      eq(spacePlacements.generation, input.generation),
      eq(spacePlacements.state, 'opening'),
    )).returning().get();
    return changed ? Result.ok(changed) : Result.err(conflict('possession', input.spaceId, 'Space placement changed while failing open'));
  }


  deleteWorkspace(workspaceId: string): boolean {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) return false;
    return this.orm.delete(spaces)
      .where(and(eq(spaces.id, workspaceId), eq(spaces.kind, 'worktree')))
      .returning({ id: spaces.id }).get() !== undefined;
  }

  deleteProject(projectId: string): boolean {
    return this.orm.delete(projects)
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id }).get() !== undefined;
  }

  releaseSpacePossession(input: { spaceId: string; holderId: string; expectedGeneration: number }): ResultType<void, CoreInputError | CoreConflict | CoreNotFound> {
    const changed = this.orm.update(spacePlacements).set({
      holderId: 'unassigned',
      generation: input.expectedGeneration + 1,
      state: 'closed',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(spacePlacements.spaceId, input.spaceId),
      eq(spacePlacements.holderId, input.holderId),
      eq(spacePlacements.generation, input.expectedGeneration),
      eq(spacePlacements.state, 'open'),
    )).returning().get();
    return changed ? Result.ok(undefined) : Result.err(conflict('possession', input.spaceId, 'Space possession changed before release'));
  }

  releaseWorkspacePossession(input: { workspaceId: string; holderId: string; expectedGeneration: number }): ResultType<void, CoreInputError | CoreConflict | CoreNotFound> {
    return this.releaseSpacePossession({ spaceId: input.workspaceId, holderId: input.holderId, expectedGeneration: input.expectedGeneration });
  }
}

function materialized(space: Space, placement: SpacePlacement): MaterializedSpace {
  return {
    ...space,
    rootPath: placement.rootPath,
    holderId: placement.holderId,
    generation: placement.generation,
    placementState: placement.state,
  };
}
