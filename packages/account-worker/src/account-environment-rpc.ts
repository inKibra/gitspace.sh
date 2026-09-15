import {
  executionHash, projectEnvironmentState, EnvironmentError, environmentFailure,
  type LifecycleMutation, type LifecycleState,
} from '@gitspace/protocol-environment';
import type { GitSpaceRpcContext } from '@gitspace/protocol';
import {
  getWorkspaceEnvironmentContract, approveWorkspaceEnvironmentExecutionContract,
  revokeWorkspaceEnvironmentApprovalContract, recoverWorkspaceEnvironmentRunContract,
  getWorkspaceEnvironmentRunLogContract, cancelWorkspaceEnvironmentRunContract, type WorkspaceEnvironmentView,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { ProjectSecretsDO } from './project-secrets.js';
import type { FleetCatalogDO } from './fleet-catalog.js';

/** Cloud reads do not possess, materialize, or start an agent in the workspace. */
export function environmentCloudProcedures(env: Env, userId: string, deviceId: string, requireHuman: () => Promise<void>) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const projects = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId);
  const authorityFor = async (spaceId: string) => {
    const projectId = await projects.locateWorkspace(spaceId);
    if (!projectId) throw new EnvironmentError('NotFound', 'Workspace does not belong to this account', { spaceId });
    const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${projectId}`);
    return { projectId, authority };
  };
  const view = async (spaceId: string, lifecycle: LifecycleState): Promise<WorkspaceEnvironmentView> => {
    lifecycle.values.global = await projects.getEnvironmentValues();
    const projected = projectEnvironmentState(lifecycle);
    const { authority } = await authorityFor(spaceId);
    const workspace = (await authority.listWorkspaces()).find(entry => entry.id === spaceId);
    if (!workspace) throw new EnvironmentError('NotFound', 'Workspace does not belong to this project', { spaceId });
    const metadata = await (env.PROJECT_SECRETS as DurableObjectNamespace<ProjectSecretsDO>).getByName(userId).listEffective(lifecycle.projectId, workspace.kind === 'base' ? null : spaceId);
    return {
      ...projected,
      configuredSecrets: metadata.map((secret) => secret.name),
      secretMetadata: metadata,
    };
  };
  const get = server.implement(getWorkspaceEnvironmentContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await authorityFor(input.spaceId);
      return ok(await view(input.spaceId, await authority.getLifecycleState(input.spaceId)));
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'read cloud environment', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const approve = async (spaceId: string, input: Extract<LifecycleMutation, { op: 'approval' }>) => {
    await requireHuman();
    const { authority } = await authorityFor(spaceId);
    if (input.approved) {
      const state = await authority.getLifecycleState(spaceId);
      const execution = state.executions.find((entry) => entry.hash === input.executionHash);
      if (!execution) throw new EnvironmentError('ContentChanged', 'Refresh the environment and review the execution content before approving');
      if (await executionHash({ kind: execution.kind, command: execution.content }) !== execution.hash) throw new EnvironmentError('ContentChanged', 'Execution preview does not match its content hash');
    }
    const result = await authority.mutateLifecycleState(spaceId, input, { actorId: deviceId, machineId: deviceId, human: true });
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    return view(spaceId, result.state);
  };
  const approveExecution = server.implement(approveWorkspaceEnvironmentExecutionContract).handler(async ({ input, errors }) => {
    try { return ok(await approve(input.spaceId, { op: 'approval', scope: input.scope, executionHash: input.executionHash, approved: true })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'approve lifecycle execution', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const revokeApproval = server.implement(revokeWorkspaceEnvironmentApprovalContract).handler(async ({ input, errors }) => {
    try { return ok(await approve(input.spaceId, { op: 'approval', scope: input.scope, executionHash: input.executionHash, approved: false })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'revoke lifecycle approval', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const recoverRun = server.implement(recoverWorkspaceEnvironmentRunContract).handler(async ({ input, errors }) => {
    try {
      await requireHuman();
      const { authority } = await authorityFor(input.spaceId);
      const state = await authority.getLifecycleState(input.spaceId);
      const run = state.runs.find((entry) => entry.id === input.runId);
      if (!run) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId: input.runId });
      const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
      const destroyed = await catalog.wasMachineDestroyed(run.machineId);
      const result = await authority.mutateLifecycleState(input.spaceId, { op: 'abandon', runId: run.id }, { actorId: deviceId, machineId: deviceId, human: true, ...(destroyed ? { destroyedMachineId: run.machineId } : {}) });
      if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
      return ok(await view(input.spaceId, result.state));
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'recover lifecycle claim', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const runLog = server.implement(getWorkspaceEnvironmentRunLogContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await authorityFor(input.spaceId);
      return ok(await authority.getLifecycleRunLog(input.spaceId, input.runId, input.offset ?? 0));
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'read lifecycle log', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const cancelRun = server.implement(cancelWorkspaceEnvironmentRunContract).handler(async ({ input, errors }) => {
    try {
      await requireHuman();
      const { authority } = await authorityFor(input.spaceId);
      const result = await authority.mutateLifecycleState(input.spaceId, { op: 'cancel', runId: input.runId }, { actorId: deviceId, machineId: deviceId, human: true });
      if (result.status === 'error') return err(errors.EnvironmentFailure(result.failure));
      const run = result.state.runs.find((entry) => entry.id === input.runId);
      if (!run) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId: input.runId });
      return ok(run);
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'cancel lifecycle run', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  return { get, approve: approveExecution, revokeApproval, recoverRun, cancelRun, runLog };
}
