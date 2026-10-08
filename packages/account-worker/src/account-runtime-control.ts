import { z } from 'zod';
import type { SignedControlRequest } from '@gitspace/protocol/credential-vault';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeSessionInputSchema, RuntimeSessionResultSchema } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeAssignmentsInputSchema, RuntimeAttachmentReadyInputSchema, RuntimeCacheAttachmentRequestInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeRepositoryCredentialsInputSchema, type RuntimeRepositoryCredentialsInput } from '@gitspace/protocol-runtime/machine-controls';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import { requireRuntimeIdentity } from './runtime-access.js';
import { ensureRuntimeCodeRepository } from './account-runtime-host.js';

/** Only the open holder of the project's base space may seed `project-<projectId>`. The repository
 * is created empty (no import, no initial commit): the machine publishes the base branch's history. */
async function projectRepositoryCredentials(env: Env, userId: string, machine: string, input: RuntimeRepositoryCredentialsInput) {
  if (userId !== env.ACCOUNT_ID) throw new Error('Repository lease belongs to a different account');
  const base = RuntimeIdentitySchema.parse({ projectId: input.projectId, workspaceId: input.projectId });
  const access = await requireRuntimeIdentity(env, userId, base, input.scope === 'write');
  if (access.project.repositoryReference === null) throw new Error('Only imported projects are seeded from a machine');
  const placement = await access.authority.get();
  if (!placement || placement.machineId !== machine || placement.state !== 'open'
    || (input.generation !== undefined && placement.generation !== input.generation)) throw new Error('Project repository lease requires the open base space holder');
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  await code.ensureMachineSeedTarget(access.project.id, access.project.baseBranch);
  return code.credentials(artifactsProjectRepository(access.project.id), input.scope);
}

/** Called after authorizeControl verifies the signed envelope and operation-specific capability. */
export async function runtimeMachineControl(env: Env, request: SignedControlRequest): Promise<unknown> {
  const { operation, payload, userId, machineId } = request;
  const machine = RuntimeMachineIdSchema.parse(machineId);
  if ('machineId' in payload && payload.machineId !== machineId) throw new Error('Machine control identity mismatch');
  if (operation === 'runtime.assignments') {
    const input = RuntimeAssignmentsInputSchema.parse(payload);
    if (input.machineId !== machine) throw new Error('Assignment target does not match the authenticated machine');
    if (input.workspace) {
      const access = await requireRuntimeIdentity(env, userId, input.workspace, false);
      return access.authority.runtimeAssignments({ ...input.workspace, ...input });
    }
    const spaces = await env.FLEET_CATALOG.getByName(userId).listSpaces();
    const assignments = [];
    for (const space of spaces) {
      const result = await env.SPACE_AUTHORITY.getByName(`${userId}:${space.spaceId}`).runtimeAssignments({ projectId: space.projectId, workspaceId: space.spaceId, machineId: machine });
      assignments.push(...result.assignments);
    }
    return { assignments };
  }
  if (operation === 'runtime.repository.credentials') {
    const input = RuntimeRepositoryCredentialsInputSchema.parse(payload);
    if (input.repository?.startsWith('project-')) return projectRepositoryCredentials(env, userId, machine, input);
    const workspaceId = input.workspaceId ?? (input.repository?.startsWith('workspace-') ? input.repository.slice('workspace-'.length) : undefined);
    const identity = RuntimeIdentitySchema.parse({ projectId: input.projectId, workspaceId });
    const repository = artifactsWorkspaceRepository(identity.workspaceId);
    if (input.repository !== undefined && input.repository !== repository) throw new Error('Repository does not belong to the requested workspace');
    const access = await requireRuntimeIdentity(env, userId, identity, input.scope === 'write');
    if (input.attachmentId !== undefined) {
      const attachments = await access.authority.runtimeAttachments(identity);
      const attachment = attachments.find(item => item.attachmentId === input.attachmentId && item.machineId === machine && item.generation === input.generation);
      if (!attachment || !['attaching', 'ready', 'draining'].includes(attachment.state)) throw new Error('Repository lease requires a current assigned checkout');
      if (input.scope === 'write' && (attachment.role === 'runner' || !['ready', 'draining'].includes(attachment.state))) throw new Error('This attachment cannot publish repository changes');
    } else {
      const placement = await access.authority.get();
      if (!placement || placement.machineId !== machine || !['open', 'opening', 'closing'].includes(placement.state)
        || (input.generation !== undefined && placement.generation !== input.generation)) throw new Error('Repository lease requires current checkout ownership');
    }
    await ensureRuntimeCodeRepository(env, userId, identity);
    return new ArtifactsCodeStore(env.ARTIFACTS).credentials(repository, input.scope);
  }
  const identity = RuntimeIdentitySchema.parse(payload);
  const access = await requireRuntimeIdentity(env, userId, identity, operation !== 'runtime.snapshot');
  const placement = await access.authority.get();
  const workspaceAssigned = placement?.machineId === machine && ['open', 'opening', 'closing'].includes(placement.state);
  if (!workspaceAssigned) {
    const attachments = await access.authority.runtimeAttachments(identity);
    if (!attachments.some(item => item.machineId === machine && ['attaching', 'ready', 'draining'].includes(item.state))) throw new Error('Machine has no active assignment in this workspace');
  }
  if (operation === 'runtime.browser.authority') {
    const input = RuntimeIdentitySchema.extend({ machineId: z.string(), attachmentId: z.string(), generation: z.number().int().nonnegative() }).parse(payload);
    if (input.machineId !== machine) throw new Error('Browser authority machine mismatch');
    return access.authority.runtimeBrowserAuthority(input);
  }
  switch (operation) {
    case 'runtime.snapshot': return RuntimeSnapshotSchema.parse(await (await access.authority.runtimeSnapshot(identity)).json());
    case 'runtime.submit':
    case 'runtime.cancel':
    case 'runtime.answer':
    case 'runtime.session': {
      if (!workspaceAssigned) throw new Error('Detached executors cannot control workspace conversations');
      if (operation === 'runtime.submit') return access.authority.runtimeSubmit(payload);
      if (operation === 'runtime.cancel') return access.authority.runtimeCancel(payload);
      if (operation === 'runtime.answer') return access.authority.runtimeAnswer(payload, { deviceId: machineId, canApprove: false });
      const input = RuntimeSessionInputSchema.parse(payload);
      if (['setApproval', 'setWorkspacePhase', 'saveAgentDefinition'].includes(input.command.type)) throw new Error('Administrative session changes require the direct device-signed cloud API');
      return RuntimeSessionResultSchema.parse(await (await access.authority.runtimeSession(input, { canApprove: false })).json());
    }
    case 'runtime.attachment.cache.request': {
      const input = RuntimeCacheAttachmentRequestInputSchema.parse(payload);
      if (input.machineId !== machine) throw new Error('Cache request target mismatch');
      return access.authority.runtimeCacheAttachmentRequest(input);
    }
    case 'runtime.attachment.ready': {
      const input = RuntimeAttachmentReadyInputSchema.parse(payload);
      if (input.machineId !== machine) throw new Error('Attachment ready target mismatch');
      return access.authority.runtimeAttachmentReady(input);
    }
    case 'runtime.snapshot.commit': {
      const input = RuntimeSnapshotCommitInputSchema.parse(payload);
      const attachments = await access.authority.runtimeAttachments(identity);
      if (!attachments.some(item => item.attachmentId === input.attachmentId && item.machineId === machine && item.generation === input.generation && (item.role === 'cache'))) throw new Error('Checkpoint source is not this machine cache');
      return access.authority.runtimeSnapshotCommit(input);
    }
    case 'runtime.heartbeat': return access.authority.runtimeHeartbeat({ ...payload, machineId: machine });
    case 'runtime.detach': return access.authority.runtimeDetach({ ...payload, machineId: machine });
    default: throw new Error(`Unsupported machine runtime operation: ${z.string().parse(operation)}`);
  }
}
