import { join } from 'node:path';
import { type GitSpaceDatabase, type MaterializedSpace } from '@gitspace/core';
import type { PortableSpaceDefinition } from './cloud-space-authority.js';
import { CoordinatorPortableSpaceRuntime } from './coordinator-portable-runtime.js';
import type { PortableSpaceDescriptor, PortableSpaceLifecycle } from './portable-space-lifecycle.js';
import type { MachineSessionCoordinator } from './session-coordinator.js';
import type { WalgitProjectBinding } from './walgit-supervisor.js';

export interface SpaceLifecycleController {
  close(space: MaterializedSpace, expectedGeneration: number): Promise<void>;
  /** Hand the space back to the cloud, retaining local files and its dormant agent record. */
  release(space: MaterializedSpace, expectedGeneration: number): Promise<void>;
  open(spaceId: string, expectedGeneration: number): Promise<void>;
}

export class MachinePortableSpaceController implements SpaceLifecycleController {
  private readonly operations = new Map<string, Promise<void>>();

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
  ) {}

  close(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    return this.serialize(space.id, () => this.closeOwned(space, expectedGeneration));
  }

  private async closeOwned(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    const placement = this.database.getSpacePlacement(space.id);
    if (placement?.state === 'closed' && placement.generation === expectedGeneration + 1) return;
    const started = this.database.beginSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
    if (started.status === 'error') throw started.error;
    const token = this.sessions.beginOperation(space.id, 'workspace-close');
    try {
      const result = await this.lifecycle.close(this.descriptor(space, expectedGeneration), this.checkpointRuntime(space.id));
      const committed = this.database.commitSpaceClosed({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      if (committed.status === 'error') throw committed.error;
      if (result.warnings.length > 0) throw new Error(`Space checkpoint committed but local cleanup failed: ${result.warnings.join('; ')}`);
      this.sessions.settleOperation(space.id, token, null);
    } catch (error) {
      const current = this.database.getSpacePlacement(space.id);
      if (current?.state === 'closing' && current.holderId === this.machineId && current.generation === expectedGeneration) this.database.abortSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      this.sessions.recordFailure(space.id, 'close space', error, token);
      throw error;
    }
  }

  release(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    return this.serialize(space.id, () => this.releaseOwned(space, expectedGeneration));
  }

  private async releaseOwned(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    const placement = this.database.getSpacePlacement(space.id);
    if (placement?.state === 'closed' && placement.generation === expectedGeneration + 1) return;
    const started = this.database.beginSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
    if (started.status === 'error') throw started.error;
    const token = this.sessions.beginOperation(space.id, 'workspace-close');
    try {
      await this.lifecycle.release(this.descriptor(space, expectedGeneration), this.checkpointRuntime(space.id));
      const committed = this.database.commitSpaceClosed({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      if (committed.status === 'error') throw committed.error;
      this.sessions.settleOperation(space.id, token, null);
    } catch (error) {
      const current = this.database.getSpacePlacement(space.id);
      if (current?.state === 'closing' && current.holderId === this.machineId && current.generation === expectedGeneration) this.database.abortSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      this.sessions.recordFailure(space.id, 'release space', error, token);
      throw error;
    }
    // The agent row goes closed (file kept) so the next start does not try to recover it against a closed placement.
    const session = this.sessions.list(space.id)[0];
    if (session) {
      const closed = await this.sessions.close(session.id);
      if (closed.status === 'error') throw closed.error;
    }
  }

  open(spaceId: string, expectedGeneration: number, options: { resumeOnMachineRestart?: boolean; deferAgentStart?: boolean; skipPreparation?: boolean } = {}): Promise<void> {
    return this.serialize(spaceId, () => this.openClosed(spaceId, expectedGeneration, options));
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
