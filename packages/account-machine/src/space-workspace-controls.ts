import { z } from 'zod';
import { phaseCeilingViolation, type GitSpaceDatabase } from '@gitspace/core';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { ProjectLifecycleManager } from './project-lifecycle.js';
import type { SpaceLifecycleController } from './portable-space-controller.js';
import type { MachineSessionCoordinator } from './session-coordinator.js';
import { spaceEnvironmentSchemas, type SpaceWorkspaceControls } from './space-eval-sdk.js';
import type { WorkspaceEnvironmentManager } from './workspace-environment.js';

const revision = z.number().int().nonnegative();
const phase = z.enum(['plan', 'code', 'review', 'ship']);

/** The eval surface shares the machine's existing lifecycle and ownership fences. */
export function createSpaceWorkspaceControls(options: {
  database: GitSpaceDatabase;
  authority: CloudSpaceCheckpointAuthority;
  projects: ProjectLifecycleManager;
  spaces: SpaceLifecycleController;
  sessions: MachineSessionCoordinator;
  machineId: string;
  environments: WorkspaceEnvironmentManager;
}): SpaceWorkspaceControls {
  const { database, authority, projects, spaces, sessions, machineId, environments } = options;
  const publish = async (workspace: CloudWorkspaceDefinition, entity: string, payload: Record<string, unknown>) => {
    await authority.appendProjectEvent({ projectId: workspace.projectId, scope: 'workspace', entity,
      entityId: workspace.id, revision: workspace.revision, operation: 'updated', payload: { ...payload, spaceId: workspace.id } });
  };
  return {
    instructionsChanged: (projectId, spaceId) => sessions.instructionsChanged(projectId, spaceId),
    refreshArtifacts: (projectId, spaceId) => sessions.refreshArtifacts(projectId, spaceId),
    async environment(method, projectId, spaceId, input) {
      if (method === 'runPhase' && input.phase === 'cloud/destroy') throw new Error('Cloud retirement requires explicit approval in the human browser');
      const parsed = spaceEnvironmentSchemas[method].parse(input);
      const local = database.getSpace(spaceId);
      if (local && local.projectId !== projectId) throw new Error('Workspace project membership changed');
      const placement = await authority.getSpace(projectId, spaceId);
      const localAvailable = local && placement?.state === 'open' && placement.machineId === machineId;
      if (method === 'get') return localAvailable ? environments.view(spaceId) : { projectId, spaceId, lifecycle: await authority.getLifecycleState(projectId, spaceId) };
      if (method === 'runLog') {
        const request = spaceEnvironmentSchemas.runLog.parse(parsed);
        return authority.getLifecycleRunLog(projectId, spaceId, request.runId, request.offset);
      }
      if (!localAvailable) throw new Error('Open this workspace on this machine before changing or running its environment');
      switch (method) {
        case 'setProfile': return environments.setProfile(spaceId, spaceEnvironmentSchemas.setProfile.parse(parsed).profile);
        case 'putValue': {
          const value = spaceEnvironmentSchemas.putValue.parse(parsed);
          return environments.putValue(spaceId, value.scope, value.name, value.value);
        }
        case 'deleteValue': {
          const value = spaceEnvironmentSchemas.deleteValue.parse(parsed);
          return environments.deleteValue(spaceId, value.scope, value.name);
        }
        case 'runChecks': return environments.runChecks(spaceId);
        case 'runPhase': {
          const run = spaceEnvironmentSchemas.runPhase.parse(parsed);
          return environments.runPhase(spaceId, run.phase, run.rerun ?? false);
        }
      }
    },
    async create(input) {
      const created = await projects.createWorkspace(input);
      const session = await sessions.openSpace(created.workspace.id);
      if (session.status === 'error') throw session.error;
      await authority.appendProjectEvent({ projectId: input.projectId, scope: 'workspace', entity: 'workspace',
        entityId: created.workspace.id, revision: Date.now(), operation: 'created', payload: { spaceId: created.workspace.id } });
      return created;
    },
    async manage(method, workspace, input) {
      const spaceId = workspace.id;
      const projectId = workspace.projectId;
      const local = database.getSpace(spaceId);
      if (local && local.projectId !== projectId) throw new Error('Workspace project membership changed');
      if (method === 'setPhase' || method === 'setRelations') {
        if (!local || local.kind !== 'worktree' || local.holderId !== machineId || local.placementState !== 'open') {
          throw new Error('Phase and relation changes require a workspace held open on this machine');
        }
        const expectedRevision = revision.parse(input.expectedRevision);
        if (workspace.revision !== expectedRevision) throw new Error(`Workspace revision conflict: expected ${expectedRevision}, actual ${workspace.revision}`);
        if (method === 'setPhase') {
          const next = phase.parse(input.phase);
          const dependencies = database.getSpaceRelations(spaceId).dependsOn.flatMap((id) => database.getWorkspace(id) ?? []);
          const ceiling = phaseCeilingViolation(next, dependencies);
          if (ceiling) throw new Error(`Phase ${next} is ahead of ${ceiling.name} (${ceiling.phase})`);
          const updated = await projects.setWorkspacePhase(projectId, spaceId, next, expectedRevision);
          database.setWorkspacePhase(spaceId, next);
          await publish(updated, 'workspace-phase', { phase: next });
          return { ...updated, relations: database.getSpaceRelations(spaceId) };
        }
        const relations = z.object({ dependsOn: z.array(z.string().min(1)), relatedTo: z.array(z.string().min(1)), stackedOn: z.string().min(1).nullable() }).parse(input);
        const dependencyIds = [...relations.dependsOn, ...(relations.stackedOn ? [relations.stackedOn] : [])];
        const dependencies = dependencyIds.flatMap((id) => database.getWorkspace(id) ?? []);
        const ceiling = phaseCeilingViolation(phase.parse(local.phase), dependencies);
        if (ceiling) throw new Error(`Phase ${local.phase} is ahead of ${ceiling.name} (${ceiling.phase})`);
        // Local relation validation owns same-project membership, normalization, and cycle rejection.
        const previous = database.getSpaceRelations(spaceId);
        const result = database.setSpaceRelations(spaceId, relations);
        if (result.status === 'error') throw result.error;
        let updated: CloudWorkspaceDefinition;
        try {
          updated = await projects.setWorkspacePhase(projectId, spaceId, phase.parse(local.phase), expectedRevision);
        } catch (error) {
          // A concurrent relation edit may have committed while the authority rejected ours.
          if (JSON.stringify(database.getSpaceRelations(spaceId)) === JSON.stringify(result.value)) database.setSpaceRelations(spaceId, previous);
          throw error;
        }
        await publish(updated, 'workspace-relations', { relations: result.value });
        return { ...updated, relations: result.value };
      }
      const expectedGeneration = revision.parse(input.expectedGeneration);
      const placement = await authority.getSpace(projectId, spaceId);
      if (!placement || placement.generation !== expectedGeneration) throw new Error('Workspace placement changed; read its current generation before retrying');
      if (placement.state !== 'closed' && (placement.state !== 'open' || placement.machineId !== machineId)) {
        throw new Error('Workspace is transitioning or held on another machine');
      }
      if (method === 'open' && workspace.lifecycle === 'archived') throw new Error('Archived workspaces must be restored before opening');
      if (method === 'archive' || method === 'restore') {
        if (workspace.kind === 'base') throw new Error('Archive and restore target workspaces, not the project base');
        const expectedRevision = revision.parse(input.expectedRevision);
        if (workspace.revision !== expectedRevision) throw new Error(`Workspace revision conflict: expected ${expectedRevision}, actual ${workspace.revision}`);
      }
      return projects.runLifecycleOperation(projectId, spaceId, `workspace.${method}`, [`${method} workspace`], async () => {
        if (method === 'close' || method === 'archive') {
          if (placement.state !== 'closed') {
            if (!local || local.generation !== expectedGeneration || local.holderId !== machineId) throw new Error('Workspace local ownership changed');
            await spaces.close(local, expectedGeneration);
          }
          if (method === 'archive' && local) database.setSpaceClosed(spaceId, true);
        } else if (placement.state === 'closed') {
          await spaces.open(spaceId, expectedGeneration);
        } else {
          const opened = await sessions.openSpace(spaceId);
          if (opened.status === 'error') throw opened.error;
          if (method === 'restore') database.setSpaceClosed(spaceId, false);
        }
        const updated = method === 'archive' || method === 'restore'
          ? await projects.setWorkspaceLifecycle(projectId, spaceId, method === 'archive' ? 'archived' : 'active', revision.parse(input.expectedRevision))
          : workspace;
        await publish(updated, 'workspace', { lifecycle: updated.lifecycle });
        return { ...updated, placement: await authority.getSpace(projectId, spaceId) };
      });
    },
  };
}
