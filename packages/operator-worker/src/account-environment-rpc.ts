import {
  EnvironmentBundleSchema, executionHash, resolveEnvironmentProfile, resolveEnvironmentValues,
  type GitSpaceRpcContext, type LifecycleMutation, type LifecycleState,
} from '@gitspace/protocol';
import {
  getWorkspaceEnvironmentContract, approveWorkspaceEnvironmentExecutionContract,
  revokeWorkspaceEnvironmentApprovalContract, recoverWorkspaceEnvironmentRunContract,
  getWorkspaceEnvironmentRunLogContract, type WorkspaceEnvironmentView,
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
    if (!projectId) throw new Error('Workspace does not belong to this account');
    const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${projectId}`);
    return { projectId, authority };
  };
  const view = async (spaceId: string, lifecycle: LifecycleState): Promise<WorkspaceEnvironmentView> => {
    lifecycle.values.global = await projects.getEnvironmentValues();
    const bundle = EnvironmentBundleSchema.parse(lifecycle.bundleJson ? JSON.parse(lifecycle.bundleJson) : { version: 1, profiles: { base: {} } });
    const selectedProfile = lifecycle.selectedProfile ?? bundle.defaultProfile;
    const metadata = await (env.PROJECT_SECRETS as DurableObjectNamespace<ProjectSecretsDO>).getByName(userId).list(lifecycle.projectId);
    const effective = resolveEnvironmentProfile(bundle, bundle.profiles[selectedProfile] ? selectedProfile : bundle.defaultProfile);
    const defaults = Object.fromEntries(Object.entries(bundle.values).filter(([, definition]) => definition.default !== undefined).map(([name, definition]) => [name, definition.default!]));
    return {
      projectId: lifecycle.projectId, spaceId, bundleJson: lifecycle.bundleJson ?? JSON.stringify(bundle), selectedProfile, effective,
      configuredSecrets: metadata.map((secret) => secret.name),
      values: { ...lifecycle.values, effective: { ...defaults, ...resolveEnvironmentValues(lifecycle.values) } },
      executions: lifecycle.executions.map((execution) => ({ ...execution, approval: lifecycle.approvals.find((approval) => approval.executionHash === execution.hash)?.scope ?? null })),
      runs: lifecycle.runs, lifecycle, migrationRequired: [],
    };
  };
  const get = server.implement(getWorkspaceEnvironmentContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await authorityFor(input.spaceId);
      return ok(await view(input.spaceId, await authority.getLifecycleState(input.spaceId)));
    } catch (error) { return err(errors.OperationFailed({ operation: 'read cloud environment', message: error instanceof Error ? error.message : String(error) })); }
  });
  const approve = async (spaceId: string, input: Extract<LifecycleMutation, { op: 'approval' }>) => {
    await requireHuman();
    const { authority } = await authorityFor(spaceId);
    if (input.approved) {
      const state = await authority.getLifecycleState(spaceId);
      const execution = state.executions.find((entry) => entry.hash === input.executionHash);
      if (!execution) throw new Error('Refresh the environment and review the execution content before approving');
      if (await executionHash({ kind: execution.kind, command: execution.content }) !== execution.hash) throw new Error('Execution preview does not match its content hash');
    }
    return view(spaceId, await authority.mutateLifecycleState(spaceId, input, { actorId: deviceId, machineId: deviceId, human: true }));
  };
  const approveExecution = server.implement(approveWorkspaceEnvironmentExecutionContract).handler(async ({ input, errors }) => {
    try { return ok(await approve(input.spaceId, { op: 'approval', scope: input.scope, executionHash: input.executionHash, approved: true })); }
    catch (error) { return err(errors.OperationFailed({ operation: 'approve lifecycle execution', message: error instanceof Error ? error.message : String(error) })); }
  });
  const revokeApproval = server.implement(revokeWorkspaceEnvironmentApprovalContract).handler(async ({ input, errors }) => {
    try { return ok(await approve(input.spaceId, { op: 'approval', scope: input.scope, executionHash: input.executionHash, approved: false })); }
    catch (error) { return err(errors.OperationFailed({ operation: 'revoke lifecycle approval', message: error instanceof Error ? error.message : String(error) })); }
  });
  const recoverRun = server.implement(recoverWorkspaceEnvironmentRunContract).handler(async ({ input, errors }) => {
    try {
      await requireHuman();
      const { authority } = await authorityFor(input.spaceId);
      const state = await authority.getLifecycleState(input.spaceId);
      const run = state.runs.find((entry) => entry.id === input.runId);
      if (!run) throw new Error('Lifecycle run does not belong to this workspace');
      const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
      if (!await catalog.wasMachineDestroyed(run.machineId)) throw new Error('Recovery is blocked until the owning runner stops or its machine destruction is confirmed; offline is not proof of termination');
      return ok(await view(input.spaceId, await authority.mutateLifecycleState(input.spaceId, { op: 'abandon', runId: run.id }, { actorId: deviceId, machineId: deviceId, human: true, destroyedMachineId: run.machineId })));
    } catch (error) { return err(errors.OperationFailed({ operation: 'recover lifecycle claim', message: error instanceof Error ? error.message : String(error) })); }
  });
  const runLog = server.implement(getWorkspaceEnvironmentRunLogContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await authorityFor(input.spaceId);
      return ok(await authority.getLifecycleRunLog(input.spaceId, input.runId, input.offset ?? 0));
    } catch (error) { return err(errors.OperationFailed({ operation: 'read lifecycle log', message: error instanceof Error ? error.message : String(error) })); }
  });
  return { get, approve: approveExecution, revokeApproval, recoverRun, runLog };
}
