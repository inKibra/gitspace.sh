import type { CloudProjectOperation, CloudProjectSummary, CloudWorkspaceDefinition, GitSpaceRpcContext } from '@gitspace/protocol';
import {
  archiveProjectContract, restoreProjectContract, setProjectBaseBranchContract, deleteProjectContract,
  createWorkspaceContract, retryCreateWorkspaceContract, archiveWorkspaceContract, restoreWorkspaceContract, deleteWorkspaceContract,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { readCloudSpaceView } from './cloud-project.js';
import {
  archiveCloudProject, archiveCloudWorkspace, CloudLifecycleTargetMissing, createCloudWorkspace, deleteCloudProject, deleteCloudWorkspace,
  restoreCloudProject, restoreCloudWorkspace, retryCloudWorkspaceCreation, setCloudProjectBaseBranch,
} from './cloud-workspace-lifecycle.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Project and workspace lifecycle answered from cloud state; no machine is consulted or required. */
export function workspaceLifecycleCloudProcedures(env: Env, userId: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const projectView = (project: CloudProjectSummary) => ({ ...project, updatedAt: new Date(project.updatedAt), archivedAt: project.archivedAt ? new Date(project.archivedAt) : null });
  const operationView = (operation: CloudProjectOperation) => ({
    id: operation.id, projectId: operation.projectId, workspaceId: operation.workspaceId, kind: operation.kind, state: operation.state,
    targetMachines: operation.targetMachines, error: operation.error, revision: operation.revision,
    createdAt: new Date(operation.createdAt), updatedAt: new Date(operation.updatedAt),
  });
  const workspaceView = async (definition: CloudWorkspaceDefinition) => {
    const workspace = (await readCloudSpaceView(env, userId, definition.projectId)).workspaces.find(candidate => candidate.id === definition.id);
    if (!workspace) throw new Error(`Workspace ${definition.id} is missing from its project view`);
    return workspace;
  };

  const create = server.implement(createWorkspaceContract).handler(async ({ input, errors }) => {
    try {
      const created = await createCloudWorkspace(env, userId, input);
      return ok({ workspace: await workspaceView(created.workspace), operation: operationView(created.operation) });
    } catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.ProjectNotFound({ projectId: error.id }));
      return err(errors.OperationFailed({ operation: 'create workspace', message: message(error) }));
    }
  });
  const retryCreate = server.implement(retryCreateWorkspaceContract).handler(async ({ input, errors }) => {
    try {
      const created = await retryCloudWorkspaceCreation(env, userId, input.workspaceId);
      return ok({ workspace: await workspaceView(created.workspace), operation: operationView(created.operation) });
    } catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.id }));
      return err(errors.OperationFailed({ operation: 'retry workspace creation', message: message(error) }));
    }
  });
  const archiveWorkspace = server.implement(archiveWorkspaceContract).handler(async ({ input, errors }) => {
    try { return ok(await archiveCloudWorkspace(env, userId, input)); }
    catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      return err(errors.OperationFailed({ operation: 'archive workspace', message: message(error) }));
    }
  });
  const restoreWorkspace = server.implement(restoreWorkspaceContract).handler(async ({ input, errors }) => {
    try {
      const { definition, generation } = await restoreCloudWorkspace(env, userId, input);
      return ok({ id: definition.id, projectId: definition.projectId, kind: definition.kind, state: 'active' as const, machineId: null, generation });
    } catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      return err(errors.OperationFailed({ operation: 'restore workspace', message: message(error) }));
    }
  });
  const deleteWorkspace = server.implement(deleteWorkspaceContract).handler(async ({ input, errors }) => {
    try { return ok({ workspaceId: input.workspaceId, deleted: await deleteCloudWorkspace(env, userId, input.workspaceId) }); }
    catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
      return err(errors.OperationFailed({ operation: 'delete workspace', message: message(error) }));
    }
  });
  const archiveProject = server.implement(archiveProjectContract).handler(async ({ input, errors }) => {
    try { return ok(projectView(await archiveCloudProject(env, userId, input.projectId, input.expectedRevision))); }
    catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'archive project', message: message(error) }));
    }
  });
  const restoreProject = server.implement(restoreProjectContract).handler(async ({ input, errors }) => {
    try { return ok(projectView(await restoreCloudProject(env, userId, input.projectId, input.expectedRevision))); }
    catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'restore project', message: message(error) }));
    }
  });
  const setBaseBranch = server.implement(setProjectBaseBranchContract).handler(async ({ input, errors }) => {
    try { return ok(projectView(await setCloudProjectBaseBranch(env, userId, input.projectId, input.expectedRevision, input.baseBranch))); }
    catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'set project base branch', message: message(error) }));
    }
  });
  const deleteProject = server.implement(deleteProjectContract).handler(async ({ input, errors }) => {
    try {
      await deleteCloudProject(env, userId, input.projectId, input.expectedRevision);
      return ok({ projectId: input.projectId, deleted: true });
    } catch (error) {
      if (error instanceof CloudLifecycleTargetMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'delete project', message: message(error) }));
    }
  });
  return {
    project: { archive: archiveProject, restore: restoreProject, setBaseBranch, delete: deleteProject },
    workspace: { create, retryCreate, archive: archiveWorkspace, restore: restoreWorkspace, delete: deleteWorkspace },
  };
}
