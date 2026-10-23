import {
  executionHash, browserOriginHash, projectEnvironmentState, EnvironmentError, environmentFailure, parseEnvironmentBundleJson, LifecycleMutationSchema,
  assertLifecycleCommandAuthorized, isLifecycleRunActive, parseLifecycleRunRequest, type LifecycleMutation, type LifecycleRunRequest, type LifecycleState,
} from '@gitspace/protocol-environment';
import { deviceCanAdminister, type GitSpaceRpcContext, type VerifiedDevice } from '@gitspace/protocol';
import {
  getWorkspaceEnvironmentContract, approveWorkspaceEnvironmentExecutionContract,
  revokeWorkspaceEnvironmentApprovalContract,
  getWorkspaceEnvironmentRunLogContract, cancelWorkspaceEnvironmentRunContract, type WorkspaceEnvironmentView,
  putWorkspaceEnvironmentBundleContract, setWorkspaceEnvironmentProfileContract,
  putWorkspaceEnvironmentValueContract, deleteWorkspaceEnvironmentValueContract,
  runWorkspaceEnvironmentChecksContract, runWorkspaceEnvironmentPhaseContract,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { ProjectSecretsDO } from './project-secrets.js';

/** Cloud reads do not possess, materialize, or start an agent in the workspace; edits land in cloud state alone. */
export function environmentCloudProcedures(env: Env, userId: string, deviceId: string, currentDevice: () => Promise<VerifiedDevice>, requireLifecycleControl: () => Promise<VerifiedDevice>) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const projects = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId);
  const authorityFor = async (spaceId: string) => {
    const projectId = await projects.locateWorkspace(spaceId);
    if (!projectId) throw new EnvironmentError('NotFound', 'Workspace does not belong to this account', { spaceId });
    const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${projectId}`);
    // The workspace object owns the workspace's environment.
    return { projectId, authority, space: env.SPACE_AUTHORITY.getByName(`${userId}:${spaceId}`), identity: { projectId, workspaceId: spaceId } };
  };
  /** The workspace object's stored environment; it derives the configuration again only when the workspace's files
   * changed since. */
  const currentState = async (spaceId: string) => {
    const { space, identity } = await authorityFor(spaceId);
    return space.currentLifecycleState(identity);
  };
  /** Account values and the workspace's secret names join the state; a project's base workspace has the project's id. */
  const view = async (spaceId: string, lifecycle: LifecycleState): Promise<WorkspaceEnvironmentView> => {
    const [global, metadata] = await Promise.all([
      projects.getEnvironmentValues(),
      (env.PROJECT_SECRETS as DurableObjectNamespace<ProjectSecretsDO>).getByName(userId).listEffective(lifecycle.projectId, spaceId === lifecycle.projectId ? null : spaceId),
    ]);
    lifecycle.values.global = global;
    return {
      ...projectEnvironmentState(lifecycle),
      configuredSecrets: metadata.map((secret) => secret.name),
      secretMetadata: metadata,
    };
  };
  const get = server.implement(getWorkspaceEnvironmentContract).handler(async ({ input, errors }) => {
    try {
      return ok(await view(input.spaceId, await currentState(input.spaceId)));
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'read cloud environment', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  /** Saved into the cloud working copy, the commit history every environment read derives the definition from. */
  const putBundle = server.implement(putWorkspaceEnvironmentBundleContract).handler(async ({ input, errors }) => {
    try {
      const bundle = parseEnvironmentBundleJson(input.bundleJson);
      const { projectId } = await authorityFor(input.spaceId);
      await env.SPACE_AUTHORITY.getByName(`${userId}:${input.spaceId}`).runtimeWriteEnvironmentBundle({ projectId, workspaceId: input.spaceId }, `${JSON.stringify(bundle, null, 2)}\n`);
      return ok(await view(input.spaceId, await currentState(input.spaceId)));
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'save workspace environment bundle', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  /** Validated as the lifecycle transition validates; global values belong to the account, not the project. */
  const edit = async (spaceId: string, candidate: Extract<LifecycleMutation, { op: 'profile' | 'value' }>) => {
    const parsed = LifecycleMutationSchema.safeParse(candidate);
    if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'Invalid lifecycle mutation', { detail: parsed.error.message });
    const { space, identity } = await authorityFor(spaceId);
    // The checkpoint's bundle decides which profiles exist, as a machine's checkout did.
    const state = await currentState(spaceId);
    const mutation = parsed.data;
    if (mutation.op === 'value' && mutation.scope === 'global') {
      await projects.setEnvironmentValue(mutation.name, mutation.value);
      return view(spaceId, state);
    }
    const device = await currentDevice();
    const result = await space.mutateLifecycleState(identity, mutation, { actorId: deviceId, machineId: deviceId, kind: device.kind, lifecycleControl: false });
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    return view(spaceId, result.state);
  };
  const setProfile = server.implement(setWorkspaceEnvironmentProfileContract).handler(async ({ input, errors }) => {
    try { return ok(await edit(input.spaceId, { op: 'profile', profile: input.profile })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'set workspace environment profile', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putValue = server.implement(putWorkspaceEnvironmentValueContract).handler(async ({ input, errors }) => {
    try { return ok(await edit(input.spaceId, { op: 'value', scope: input.scope, name: input.name, value: input.value })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'save workspace environment value', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteValue = server.implement(deleteWorkspaceEnvironmentValueContract).handler(async ({ input, errors }) => {
    try { return ok(await edit(input.spaceId, { op: 'value', scope: input.scope, name: input.name, value: null })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'delete workspace environment value', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const approve = async (spaceId: string, input: Extract<LifecycleMutation, { op: 'approval' }>) => {
    const device = await requireLifecycleControl();
    const { authority, space, identity } = await authorityFor(spaceId);
    if (input.approved) {
      const state = await currentState(spaceId);
      const origin = state.browserOrigins.find((entry) => entry.hash === input.executionHash);
      if (origin) {
        if (await browserOriginHash(origin.pattern) !== origin.hash) throw new EnvironmentError('ContentChanged', 'Browser origin does not match its content hash');
        const workspace = (await authority.listWorkspaces()).find((entry) => entry.id === spaceId);
        if (input.scope === 'project' && workspace?.kind !== 'base') throw new EnvironmentError('PermissionDenied', 'Approve browser origins on the base workspace for project-wide access');
      } else {
        const execution = state.executions.find((entry) => entry.hash === input.executionHash);
        if (!execution) throw new EnvironmentError('ContentChanged', 'Refresh the environment and review current content before approving');
        if (await executionHash({ kind: execution.kind, command: execution.content }) !== execution.hash) throw new EnvironmentError('ContentChanged', 'Execution preview does not match its content hash');
      }
    }
    const result = await space.mutateLifecycleState(identity, input, { actorId: deviceId, machineId: deviceId, kind: device.kind, lifecycleControl: true });
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    return view(spaceId, result.state);
  };
  const approveExecution = server.implement(approveWorkspaceEnvironmentExecutionContract).handler(async ({ input, errors }) => {
    try { return ok(await approve(input.spaceId, { op: 'approval', scope: input.scope, executionHash: input.executionHash, approved: true, ...(input.level ? { level: input.level } : {}) })); }
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
  const runLog = server.implement(getWorkspaceEnvironmentRunLogContract).handler(async ({ input, errors }) => {
    try {
      const { space, identity } = await authorityFor(input.spaceId);
      return ok(await space.getLifecycleRunLog(identity, input.runId, input.offset ?? 0));
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'read lifecycle log', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const cancelRun = server.implement(cancelWorkspaceEnvironmentRunContract).handler(async ({ input, errors }) => {
    try {
      const device = await requireLifecycleControl();
      const { space, identity } = await authorityFor(input.spaceId);
      const actor = { actorId: deviceId, machineId: deviceId, kind: device.kind, lifecycleControl: true };
      let result = await space.mutateLifecycleState(identity, { op: 'cancel', runId: input.runId }, actor);
      if (result.status === 'error') return err(errors.EnvironmentFailure(result.failure));
      let run = result.state.runs.find((entry) => entry.id === input.runId);
      if (!run) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId: input.runId });
      // Cancel always ends a run: one whose machine is not connected cannot be stopped there, so it ends now.
      if (isLifecycleRunActive(run) && !await env.FLEET_CATALOG.getByName(userId).machineConnected(run.machineId)) {
        result = await space.mutateLifecycleState(identity, { op: 'interrupt', runId: run.id, reason: 'Cancelled while its machine was offline' }, actor);
        if (result.status === 'error') return err(errors.EnvironmentFailure(result.failure));
        run = result.state.runs.find((entry) => entry.id === input.runId) ?? run;
      }
      return ok(run);
    } catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'cancel lifecycle run', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  /** Accepted here, then dispatched by the workspace runtime to the cache machine the caller named; the run's
   * state, log, cancellation and recovery stay in the cloud ledger. No other machine is ever chosen. */
  const run = async (spaceId: string, machineId: string, candidate: LifecycleRunRequest) => {
    const request = parseLifecycleRunRequest(candidate);
    assertLifecycleCommandAuthorized(request.phase, { lifecycleControl: deviceCanAdminister(await currentDevice(), 'lifecycle.control') });
    const { projectId } = await authorityFor(spaceId);
    const result = await env.SPACE_AUTHORITY.getByName(`${userId}:${spaceId}`).runtimeEnvironmentRun({ projectId, workspaceId: spaceId, machineId, request });
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    return result.run;
  };
  const runChecks = server.implement(runWorkspaceEnvironmentChecksContract).handler(async ({ input, errors }) => {
    try { return ok(await run(input.spaceId, input.machineId, { runId: input.runId, phase: 'checks', deadlineAt: input.deadlineAt })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: 'run workspace environment checks', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const runPhase = server.implement(runWorkspaceEnvironmentPhaseContract).handler(async ({ input, errors }) => {
    try { return ok(await run(input.spaceId, input.machineId, { runId: input.runId, phase: input.phase, rerun: input.rerun ?? false, interactive: input.interactive, deadlineAt: input.deadlineAt })); }
    catch (error) {
      const failure = environmentFailure(error);
      return err(failure ? errors.EnvironmentFailure(failure) : errors.OperationFailed({ operation: `run workspace environment ${input.phase}`, message: error instanceof Error ? error.message : String(error) }));
    }
  });
  return { get, putBundle, setProfile, putValue, deleteValue, approve: approveExecution, revokeApproval, cancelRun, runLog, runChecks, runPhase };
}
