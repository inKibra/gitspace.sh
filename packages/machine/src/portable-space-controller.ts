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
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly sessions: MachineSessionCoordinator,
    private readonly lifecycle: PortableSpaceLifecycle,
    private readonly machineId: string,
    private readonly binding: (projectId: string) => WalgitProjectBinding,
    private readonly definition: (spaceId: string) => Promise<PortableSpaceDefinition | null>,
    private readonly managedSpaceRoot: string,
    private readonly portableUntrackedPaths: (space: MaterializedSpace) => string[] | undefined = () => undefined,
  ) {}

  async close(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    const started = this.database.beginSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
    if (started.status === 'error') throw started.error;
    try {
      await this.lifecycle.close(this.descriptor(space, expectedGeneration), new CoordinatorPortableSpaceRuntime(this.sessions, space.id));
      const committed = this.database.commitSpaceClosed({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      if (committed.status === 'error') throw committed.error;
      this.database.setSpaceClosed(space.id, true);
    } catch (error) {
      const current = this.database.getSpacePlacement(space.id);
      if (current?.state === 'closing') this.database.abortSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      throw error;
    }
  }

  async release(space: MaterializedSpace, expectedGeneration: number): Promise<void> {
    const started = this.database.beginSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
    if (started.status === 'error') throw started.error;
    try {
      await this.lifecycle.release(this.descriptor(space, expectedGeneration), new CoordinatorPortableSpaceRuntime(this.sessions, space.id));
      const committed = this.database.commitSpaceClosed({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      if (committed.status === 'error') throw committed.error;
    } catch (error) {
      const current = this.database.getSpacePlacement(space.id);
      if (current?.state === 'closing') this.database.abortSpaceClose({ spaceId: space.id, holderId: this.machineId, expectedGeneration });
      throw error;
    }
    // The agent row goes closed (file kept) so the next start does not try to recover it against a closed placement.
    const session = this.sessions.list(space.id)[0];
    if (session) {
      const closed = await this.sessions.close(session.id);
      if (closed.status === 'error') throw closed.error;
    }
  }

  async open(spaceId: string, expectedGeneration: number): Promise<void> {
    const space = await this.materialize(spaceId);
    const aligned = this.database.alignClosedSpaceProjection(space.id, expectedGeneration);
    if (aligned.status === 'error') throw aligned.error;
    const started = this.database.beginSpaceOpen({
      spaceId: space.id,
      holderId: this.machineId,
      expectedGeneration,
      rootPath: space.rootPath,
    });
    if (started.status === 'error') throw started.error;
    try {
      await this.lifecycle.open(this.descriptor(space, expectedGeneration), new CoordinatorPortableSpaceRuntime(this.sessions, space.id));
      const committed = this.database.commitSpaceOpen({ spaceId: space.id, holderId: this.machineId, generation: expectedGeneration + 1 });
      if (committed.status === 'error') throw committed.error;
      this.database.setSpaceClosed(space.id, false);
    } catch (error) {
      const current = this.database.getSpacePlacement(space.id);
      if (current?.state === 'opening') this.database.failSpaceOpen({ spaceId: space.id, holderId: this.machineId, generation: expectedGeneration + 1 });
      throw error;
    }
  }

  private async materialize(spaceId: string): Promise<MaterializedSpace> {
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
