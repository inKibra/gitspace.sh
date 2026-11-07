import { z } from 'zod';
import type { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { EnvironmentError, executionHash, type LifecycleActor, type LifecycleState } from '@gitspace/protocol-environment';
import type { WorkspaceEnvironment } from './space-environment.js';
/**
 * A person's approval of execution content in one workspace, as the Environment tab's approve records it: each hash
 * must be an execution the workspace currently derives, with content that still hashes to it. `project` scope shares
 * the approval with every workspace of the project.
 */
export async function approveExecutionsAsPerson(
  environment: Pick<WorkspaceEnvironment, 'currentLifecycleState' | 'mutateLifecycleState'>,
  identity: z.infer<typeof RuntimeIdentitySchema>,
  input: { executionHashes: readonly string[]; scope: 'project' | 'workspace'; person: { deviceId: string; kind: LifecycleActor['kind']; lifecycleControl: boolean } },
): Promise<LifecycleState> {
  if (!input.person.lifecycleControl) throw new EnvironmentError('PermissionDenied', 'Execution approval requires lifecycle control authorization');
  let state = await environment.currentLifecycleState(identity);
  for (const hash of input.executionHashes) {
    const execution = state.executions.find((entry) => entry.hash === hash);
    if (!execution || await executionHash({ kind: execution.kind, command: execution.content }) !== hash) {
      throw new EnvironmentError('ContentChanged', 'Refresh the environment and review current content before approving', { executionHash: hash });
    }
  }
  const actor: LifecycleActor = { actorId: input.person.deviceId, machineId: input.person.deviceId, kind: input.person.kind, lifecycleControl: true };
  for (const hash of input.executionHashes) {
    const result = await environment.mutateLifecycleState(identity, { op: 'approval', scope: input.scope, executionHash: hash, approved: true }, actor);
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    state = result.state;
  }
  return state;
}
