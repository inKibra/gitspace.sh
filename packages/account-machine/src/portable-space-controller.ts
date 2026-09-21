import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { agentSessions, spaces as localSpaces } from '@gitspace/core';
import { eq } from 'drizzle-orm';
import { type GitSpaceDatabase, type MaterializedSpace, type SpaceCleanupJob } from '@gitspace/core';
import type { PortableSpaceDefinition } from './cloud-space-authority.js';
import { CoordinatorPortableSpaceRuntime } from './coordinator-portable-runtime.js';
import type { PortableSpaceDescriptor, PortableSpaceLifecycle } from './portable-space-lifecycle.js';
import type { MachineSessionCoordinator } from './session-coordinator.js';
import type { WalgitProjectBinding } from './walgit-supervisor.js';

export interface SpaceLifecycleController {
  close(space: MaterializedSpace, expectedGeneration: number): Promise<void>;
  /** Release with a cloud restart intent; never retain an operational local copy. */
  release(space: MaterializedSpace, expectedGeneration: number): Promise<void>;
  open(spaceId: string, expectedGeneration: number): Promise<void>;
  retryCleanup?(spaceId: string): Promise<void>;
}

export class MachinePortableSpaceController implements SpaceLifecycleController {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly sessions: MachineSessionCoordinator,
    private readonly lifecycle: PortableSpaceLifecycle,
    private readonly machineId: string,
    private readonly binding: (projectId: string) => WalgitProjectBinding,
    private readonly definition: (spaceId: string) => Promise<PortableSpaceDefinition | null>,
    private readonly managedSpaceRoot: string,
    private readonly portableUntrackedPaths: (space: MaterializedSpace) => string[] | undefined = () => undefined,
    private readonly environment?: { prepare(spaceId: string): Promise<void>; dematerialize(spaceId: string): Promise<void>; drain(spaceId: string): Promise<void> },
    private readonly configureRepository?: (repositoryPath: string) => Promise<void>,
    private readonly cleanupProject?: (projectId: string) => Promise<void>,
    private readonly cleanupSpace?: (spaceId: string, projectId: string) => Promise<void>,
    private readonly reconcileCleanup?: (job: SpaceCleanupJob) => Promise<void>,
  ) {}

  close(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    return this.queueClose(space, expectedGeneration, false);
  }

  private queueClose(space: MaterializedSpace, expectedGeneration: number, restart: boolean): Promise<void> {
    const key = `${space.id}:${expectedGeneration}:${restart}`;
    const pending = this.closing.get(key);
    if (pending) return pending;
    const operation = this.serialize(space.projectId, () => this.closeOwned(space, expectedGeneration, restart))
      .finally(() => { this.closing.delete(key); });
    this.closing.set(key, operation);
    return operation;
  }

  private async closeOwned(space: MaterializedSpace, expectedGeneration: number, restart = false): Promise<void> {
    let cleanup = this.database.listSpaceCleanupJobs().find((job) => job.spaceId === space.id);
    if (cleanup?.state === 'prepared') {
      await this.reconcileCleanup?.(cleanup);
      cleanup = this.database.listSpaceCleanupJobs().find((job) => job.spaceId === space.id);
    }
    if (cleanup?.state === 'committed') {
      await this.cleanupCommitted(space.id);
      return;
    }
    if (cleanup) throw new Error(`Space ${space.id} has an unresolved checkpoint; reconcile its cloud outcome before retrying`);
    const started = this.database.beginSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
    if (started.status === 'error') throw started.error;
    const token = this.sessions.beginOperation(space.id, 'workspace-close');
    let cloudCommitted = false;
    try {
      const result = await this.lifecycle.close(this.descriptor(space, expectedGeneration), this.checkpointRuntime(space.id), restart);
      cloudCommitted = true;
      if (result.warnings.length > 0) throw new Error(`Space released; local cleanup pending: ${result.warnings.join('; ')}`);
      await this.cleanupCommitted(space.id);
    } catch (error) {
      const job = this.database.listSpaceCleanupJobs().find((candidate) => candidate.spaceId === space.id);
      if (job?.state === 'committed' || cloudCommitted) this.database.failSpaceCleanup(space.id, String(error));
      else if (!(error instanceof AggregateError)) {
        // Publication failed and rollback was acknowledged. The complete local state remains.
        this.database.finishSpaceCleanup(space.id);
        this.database.abortSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
        this.sessions.recordFailure(space.id, 'close space', error, token);
      } else if (job) this.database.failSpaceCleanup(space.id, String(error));
      throw error;
    }
  }

  async retryCleanup(spaceId: string): Promise<void> {
    const job = this.database.listSpaceCleanupJobs().find((candidate) => candidate.spaceId === spaceId);
    if (job) await this.serialize(job.projectId, async () => {
      let current = this.database.listSpaceCleanupJobs().find((candidate) => candidate.spaceId === spaceId);
      if (current?.state === 'prepared') await this.reconcileCleanup?.(current);
      current = this.database.listSpaceCleanupJobs().find((candidate) => candidate.spaceId === spaceId);
      if (current?.state === 'prepared') throw new Error(`Space ${spaceId} checkpoint outcome is unresolved; local data remains fenced`);
      await this.cleanupCommitted(spaceId);
    });
  }

  private async cleanupCommitted(spaceId: string): Promise<void> {
    const job = this.database.listSpaceCleanupJobs().find((candidate) => candidate.spaceId === spaceId);
    if (!job || job.state !== 'committed') return;
    try {
      await this.sessions.deletePortableSpaceLocal(spaceId);
      await this.cleanupSpace?.(spaceId, job.projectId);
      // createProject creates a base projection even when only a worktree was restored.
      // An untouched, absent base is not an operational sibling or a reason to retain the project.
      const siblings = this.database.listSpaces(job.projectId);
      const base = siblings.length === 1 && siblings[0]?.kind === 'base' ? siblings[0] : null;
      if (base && base.placementState === 'closed' && base.generation === 0
        && !this.database.orm.select().from(agentSessions).where(eq(agentSessions.spaceId, base.id)).get()) {
        const exists = await lstat(base.rootPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        if (!exists) this.database.orm.delete(localSpaces).where(eq(localSpaces.id, base.id)).run();
      }
      await this.cleanupProject?.(job.projectId);
      if (this.database.listSpaces(job.projectId).length === 0) this.database.deleteProject(job.projectId);
      this.database.finishSpaceCleanup(spaceId);
    } catch (error) {
      this.database.failSpaceCleanup(spaceId, String(error));
      throw error;
    }
  }

  release(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    return this.queueClose(space, expectedGeneration, true);
  }

  async open(spaceId: string, expectedGeneration: number, options: { resumeOnMachineRestart?: boolean; deferAgentStart?: boolean; skipPreparation?: boolean } = {}): Promise<void> {
    const projectId = this.database.getSpace(spaceId)?.projectId ?? (await this.definition(spaceId))?.projectId;
    if (!projectId) throw new Error(`Portable space ${spaceId} does not exist`);
    return this.serialize(projectId, () => this.openClosed(spaceId, expectedGeneration, options));
  }

  private async openClosed(spaceId: string, expectedGeneration: number, options: { resumeOnMachineRestart?: boolean; deferAgentStart?: boolean; skipPreparation?: boolean }): Promise<void> {
    const space = await this.materialize(spaceId);
    const placement = this.database.getSpacePlacement(space.id);
    if (!placement || placement.state !== 'closed' || placement.generation > expectedGeneration) {
      throw new Error(`Space ${space.id} is not closed at a recoverable generation`);
    }
    const token = this.sessions.beginOperation(space.id, 'workspace-open');
    try {
      await this.lifecycle.open(
        { ...this.descriptor(space, expectedGeneration), resumeOnMachineRestart: options.resumeOnMachineRestart },
        new CoordinatorPortableSpaceRuntime(this.sessions, space.id, undefined, async () => {
          await this.configureRepository?.(space.rootPath);
        }),
        () => {
          const aligned = this.database.alignClosedSpaceProjection(space.id, expectedGeneration);
          if (aligned.status === 'error') throw aligned.error;
          const started = this.database.beginSpaceOpen({ spaceId: space.id, holderId: this.machineId, expectedGeneration, rootPath: space.rootPath });
          if (started.status === 'error') throw started.error;
        },
      );
      const committed = this.database.commitSpaceOpen({ spaceId: space.id, holderId: this.machineId, generation: expectedGeneration + 1 });
      if (committed.status === 'error') throw committed.error;
      this.database.setSpaceClosed(space.id, false);
      this.sessions.settleOperation(space.id, token, null);
    } catch (error) {
      const current = this.database.getSpacePlacement(space.id);
      if (current?.state === 'opening') this.database.failSpaceOpen({ spaceId: space.id, holderId: this.machineId, generation: expectedGeneration + 1 });
      this.sessions.recordFailure(space.id, 'open space', error, token);
      throw error;
    }
    if (!options.skipPreparation) void this.environment?.prepare(space.id);
    if (!options.deferAgentStart) {
      const opened = await this.sessions.openSpace(space.id, false, expectedGeneration + 1);
      if (opened.status === 'error') throw opened.error;
    }
  }

  async materialize(spaceId: string): Promise<MaterializedSpace> {
    const cleanup = this.database.listSpaceCleanupJobs().find((job) => job.spaceId === spaceId);
    if (cleanup?.state === 'prepared') throw new Error(`Space ${spaceId} has an unresolved checkpoint`);
    if (cleanup) await this.cleanupCommitted(spaceId);
    const current = this.database.getSpace(spaceId);
    if (current) return current;
    const definition = await this.definition(spaceId);
    if (!definition) throw new Error(`Portable space ${spaceId} does not exist`);
    if (!this.database.getProject(definition.projectId)) {
      const baseRoot = definition.kind === 'base'
        ? join(this.managedSpaceRoot, definition.projectId, definition.spaceId)
        : join(this.managedSpaceRoot, definition.projectId, 'base');
      const created = this.database.createProject({
        id: definition.projectId,
        name: definition.projectName,
        repositoryPath: baseRoot,
        baseBranch: definition.baseBranch,
        ...(definition.repositoryReference ? { repositoryReference: definition.repositoryReference } : {}),
      });
      if (created.status === 'error') throw created.error;
    }
    if (definition.kind === 'base') {
      this.database.materializeBaseSpace(definition.projectId, join(this.managedSpaceRoot, definition.projectId, definition.spaceId));
    }
    if (definition.kind === 'worktree' && !this.database.getSpace(definition.spaceId)) {
      const created = this.database.createWorkspace({
        id: definition.spaceId,
        projectId: definition.projectId,
        name: definition.name,
        branch: definition.branch,
        phase: definition.phase ?? 'code',
        rootPath: join(this.managedSpaceRoot, definition.projectId, definition.spaceId),
      });
      if (created.status === 'error') throw created.error;
    }
    const materialized = this.database.getSpace(definition.spaceId);
    if (!materialized) throw new Error(`Portable space ${spaceId} could not be materialized`);
    return materialized;
  }

  private serialize(spaceId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(spaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operations.set(spaceId, next);
    return next.finally(() => {
      if (this.operations.get(spaceId) === next) this.operations.delete(spaceId);
    });
  }

  private checkpointRuntime(spaceId: string): CoordinatorPortableSpaceRuntime {
    return new CoordinatorPortableSpaceRuntime(this.sessions, spaceId, async () => {
      await this.environment?.dematerialize(spaceId);
      await this.environment?.drain(spaceId);
    });
  }

  private descriptor(space: MaterializedSpace, expectedGeneration: number): PortableSpaceDescriptor {
    const portableUntrackedPaths = this.portableUntrackedPaths(space);
    return {
      projectId: space.projectId,
      spaceId: space.id,
      machineId: this.machineId,
      expectedGeneration,
      repositoryPath: space.rootPath,
      ...(portableUntrackedPaths ? { portableUntrackedPaths } : {}),
      binding: this.binding(space.projectId),
    };
  }
}
