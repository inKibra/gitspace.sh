import { z } from 'zod';
import type { SignedControlRequest } from '@gitspace/protocol/credential-vault';
import { RuntimeIdentitySchema, RuntimeAttachInputSchema, RuntimeMachineIdSchema, RuntimeSnapshotSchema, RuntimeJsonSchema } from '@gitspace/protocol-runtime';
import { RuntimeSessionInputSchema, RuntimeSessionResultSchema } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeAssignmentsInputSchema, RuntimeAttachmentReadyInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeModelInputSchema, RuntimeMcpInputSchema, RuntimeRepositoryCredentialsInputSchema } from '@gitspace/protocol-runtime/machine-controls';
import { ArtifactsCodeStore, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import { requireRuntimeIdentity } from './runtime-access.js';
import { ensureRuntimeCodeRepository } from './account-runtime-host.js';

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
      if (attachment.role === 'primary') {
        const placement = await access.authority.get();
        if (!placement || !['open', 'closing'].includes(placement.state) || placement.machineId !== machine || placement.generation !== (attachment.ownershipGeneration ?? attachment.generation)) throw new Error('Primary repository lease requires current canonical checkout ownership');
      }
    } else {
      const placement = await access.authority.get();
      if (!placement || placement.machineId !== machine || !['open', 'opening', 'closing'].includes(placement.state)
        || (input.generation !== undefined && placement.generation !== input.generation)) throw new Error('Repository lease requires current checkout ownership');
    }
    await ensureRuntimeCodeRepository(env, userId, identity);
    return new ArtifactsCodeStore(env.ARTIFACTS).credentials(repository, input.scope);
  }
  const model = operation === 'runtime.model' ? RuntimeModelInputSchema.parse(payload) : null;
  const mcp = operation === 'runtime.mcp' ? RuntimeMcpInputSchema.parse(payload) : null;
  const identity = RuntimeIdentitySchema.parse(model?.dispatch ?? mcp?.dispatch ?? payload);
  const access = await requireRuntimeIdentity(env, userId, identity, operation !== 'runtime.snapshot');
  const placement = await access.authority.get();
  const primary = placement?.machineId === machine && ['open', 'opening', 'closing'].includes(placement.state);
  if (!primary) {
    const attachments = await access.authority.runtimeAttachments(identity);
    if (!attachments.some(item => item.machineId === machine && ['attaching', 'ready', 'draining'].includes(item.state))) throw new Error('Machine has no active assignment in this workspace');
  }
  if (operation === 'runtime.browser.authority') {
    const input = RuntimeIdentitySchema.extend({ machineId: z.string(), attachmentId: z.string(), generation: z.number().int().nonnegative() }).parse(payload);
    if (input.machineId !== machine) throw new Error('Browser authority machine mismatch');
    return access.authority.runtimeBrowserAuthority(input);
  }
  switch (operation) {
    case 'runtime.attach': {
      const input = RuntimeAttachInputSchema.parse(payload);
      if (input.machineId !== machine || input.role !== 'primary') throw new Error('Machine may only enroll its canonical primary checkout');
      return access.authority.runtimeAttach(input);
    }
    case 'runtime.snapshot': return RuntimeSnapshotSchema.parse(await (await access.authority.runtimeSnapshot(identity)).json());
    case 'runtime.submit':
    case 'runtime.cancel':
    case 'runtime.answer':
    case 'runtime.session': {
      if (!primary) throw new Error('Detached executors cannot control workspace conversations');
      if (operation === 'runtime.submit') return access.authority.runtimeSubmit(payload);
      if (operation === 'runtime.cancel') return access.authority.runtimeCancel(payload);
      if (operation === 'runtime.answer') return access.authority.runtimeAnswer(payload, { deviceId: machineId, canApprove: false });
      const input = RuntimeSessionInputSchema.parse(payload);
      if (['setApproval', 'setWorkspacePhase', 'saveAgentDefinition'].includes(input.command.type)) throw new Error('Administrative session changes require the direct device-signed cloud API');
      return RuntimeSessionResultSchema.parse(await (await access.authority.runtimeSession(input, { canApprove: false })).json());
    }
    case 'runtime.attachment.ready': {
      const input = RuntimeAttachmentReadyInputSchema.parse(payload);
      if (input.machineId !== machine) throw new Error('Attachment ready target mismatch');
      return access.authority.runtimeAttachmentReady(input);
    }
    case 'runtime.snapshot.commit': {
      const input = RuntimeSnapshotCommitInputSchema.parse(payload);
      const attachments = await access.authority.runtimeAttachments(identity);
      if (!attachments.some(item => item.attachmentId === input.attachmentId && item.machineId === machine && item.generation === input.generation && (item.role === 'primary' || item.role === 'replica'))) throw new Error('Checkpoint source is not this machine replica');
      return access.authority.runtimeSnapshotCommit(input);
    }
    case 'runtime.model': {
      if (!model || model.dispatch.machineId !== machine) throw new Error('Model request executor mismatch');
      return RuntimeJsonSchema.parse(await (await access.authority.runtimeModel(model, machine)).json());
    }
    case 'runtime.mcp': {
      if (!mcp || mcp.dispatch.machineId !== machine) throw new Error('MCP request executor mismatch');
      return RuntimeJsonSchema.parse(await (await access.authority.runtimeMcp(mcp, machine)).json());
    }
    case 'runtime.heartbeat': return access.authority.runtimeHeartbeat({ ...payload, machineId: machine });
    case 'runtime.detach': return access.authority.runtimeDetach({ ...payload, machineId: machine });
    default: throw new Error(`Unsupported machine runtime operation: ${z.string().parse(operation)}`);
  }
}
