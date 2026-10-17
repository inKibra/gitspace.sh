import { z } from 'zod';
import type { SignedControlRequest } from '@gitspace/protocol/credential-vault';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeSessionInputSchema, RuntimeSessionResultSchema } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeAssignmentsInputSchema, RuntimeAttachmentReadyInputSchema, RuntimeCacheAttachmentRequestInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeAttachmentLeaseSchema, RuntimeGitHubTokenInputSchema, RuntimeRepositoryCredentialsInputSchema, type RuntimeRepositoryCredentialsInput } from '@gitspace/protocol-runtime/machine-controls';
import type { GitHubRepositoryToken, MachineOriginAccess } from '@gitspace/protocol/github';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import { requireWorkspaceAccess } from './runtime-access.js';
import { ensureRuntimeCodeRepository } from './account-runtime-host.js';
import { originAccess } from './origin-access.js';

/** Only a machine attached to the project's base workspace may seed `project-<projectId>`. The repository
 * is created empty (no import, no initial commit): the machine publishes the base branch's history. */
async function projectRepositoryCredentials(env: Env, userId: string, machine: string, input: RuntimeRepositoryCredentialsInput) {
  if (userId !== env.ACCOUNT_ID) throw new Error('Repository lease belongs to a different account');
  const base = RuntimeIdentitySchema.parse({ projectId: input.projectId, workspaceId: input.projectId });
  const access = await requireWorkspaceAccess(env, userId, base, input.scope === 'write');
  // Seeding the project repository reads the project itself; workspace leases need only the workspace.
  const project = await env.PROJECT_AUTHORITY.getByName(`${userId}:${input.projectId}`).getProject();
  if (!project) throw new Error('Runtime project is unavailable');
  if (project.repositoryReference === null) throw new Error('Only imported projects are seeded from a machine');
  const attachments = await access.authority.runtimeAttachments(base);
  if (!attachments.some(item => item.machineId === machine && item.state !== 'detached'
    && (input.generation === undefined || item.generation === input.generation))) throw new Error('Project repository lease requires a checkout of the base workspace on this machine');
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  await code.ensureMachineSeedTarget(project.id, project.baseBranch);
  return code.credentials(artifactsProjectRepository(project.id), input.scope);
}

/** How this machine's checkout reaches its project's origin, and the installation tokens it uses there. Authorized like
 * a checkout's repository lease: this machine's current attachment at its generation, never a detached one; pushing
 * (`write`) needs a ready one. An origin no installation covers is the account SSH key's, and gets no token. */
async function checkoutOrigin(env: Env, userId: string, machine: string, operation: 'runtime.repository.originAccess' | 'runtime.repository.githubToken', payload: Record<string, unknown>): Promise<MachineOriginAccess | GitHubRepositoryToken> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Origin access belongs to a different account');
  const token = operation === 'runtime.repository.githubToken' ? RuntimeGitHubTokenInputSchema.parse(payload) : null;
  const input = token ?? RuntimeAttachmentLeaseSchema.parse(payload);
  if (input.machineId !== machine) throw new Error('Origin access target does not match the authenticated machine');
  const write = token?.access === 'write';
  const access = await requireWorkspaceAccess(env, userId, input, write);
  const attachment = (await access.authority.runtimeAttachments(input))
    .find(item => item.attachmentId === input.attachmentId && item.machineId === machine && item.generation === input.generation);
  if (!attachment || attachment.state === 'detached') throw new Error('Origin access requires a current assigned checkout');
  if (write && attachment.state !== 'ready') throw new Error('This attachment cannot push to its origin');
  const project = await env.PROJECT_AUTHORITY.getByName(`${userId}:${input.projectId}`).getProject();
  if (!project) throw new Error('Runtime project is unavailable');
  const origin = project.repositoryReference === null ? null : await originAccess(env, project.repositoryReference);
  if (!token) return origin?.kind === 'github-app' ? { kind: 'github-app', repository: origin.repository } : { kind: 'ssh' };
  if (origin?.kind !== 'github-app') throw new Error('No GitHub App installation covers this project origin');
  return env.GITHUB_APP.getByName(env.ACCOUNT_ID).repositoryToken(origin.repository, token.access);
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
      const access = await requireWorkspaceAccess(env, userId, input.workspace, false);
      return access.authority.runtimeAssignments({ ...input.workspace, ...input });
    }
    // Only the workspaces the fleet index holds for this machine, read in parallel. One that fails is reported
    // unavailable, so the machine keeps its attachments there instead of releasing them as omitted.
    const workspaces = await env.FLEET_CATALOG.getByName(userId).machineWorkspaces(machine);
    const results = await Promise.all(workspaces.map(async workspace => {
      try {
        return { workspace, assignments: (await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.workspaceId}`).runtimeAssignments({ ...workspace, machineId: machine })).assignments };
      } catch (error) {
        console.error(JSON.stringify({ event: 'runtime_assignments_space_failed', projectId: workspace.projectId, workspaceId: workspace.workspaceId, message: error instanceof Error ? error.message : String(error) }));
        return { workspace, assignments: null };
      }
    }));
    return {
      assignments: results.flatMap(result => result.assignments ?? []),
      unavailable: results.flatMap(result => result.assignments ? [] : [result.workspace.workspaceId]),
    };
  }
  if (operation === 'runtime.repository.credentials') {
    const input = RuntimeRepositoryCredentialsInputSchema.parse(payload);
    if (input.repository?.startsWith('project-')) return projectRepositoryCredentials(env, userId, machine, input);
    const workspaceId = input.workspaceId ?? (input.repository?.startsWith('workspace-') ? input.repository.slice('workspace-'.length) : undefined);
    const identity = RuntimeIdentitySchema.parse({ projectId: input.projectId, workspaceId });
    const repository = artifactsWorkspaceRepository(identity.workspaceId);
    if (input.repository !== undefined && input.repository !== repository) throw new Error('Repository does not belong to the requested workspace');
    const access = await requireWorkspaceAccess(env, userId, identity, input.scope === 'write');
    if (input.attachmentId !== undefined) {
      const attachments = await access.authority.runtimeAttachments(identity);
      const attachment = attachments.find(item => item.attachmentId === input.attachmentId && item.machineId === machine && item.generation === input.generation);
      if (!attachment || attachment.state === 'detached') throw new Error('Repository lease requires a current assigned checkout');
      if (input.scope === 'write' && attachment.state !== 'ready') throw new Error('This attachment cannot publish repository changes');
    } else {
      // Machine git remotes bind only the repository: any machine with a live checkout qualifies, and checkouts
      // publish their baseline before ready.
      const attachments = await access.authority.runtimeAttachments(identity);
      if (!attachments.some(item => item.machineId === machine && item.state !== 'detached'
        && (input.generation === undefined || item.generation === input.generation))) throw new Error('Repository lease requires current checkout ownership');
    }
    await ensureRuntimeCodeRepository(env, userId, identity);
    return new ArtifactsCodeStore(env.ARTIFACTS).credentials(repository, input.scope);
  }
  if (operation === 'runtime.repository.originAccess' || operation === 'runtime.repository.githubToken') return checkoutOrigin(env, userId, machine, operation, payload);
  const identity = RuntimeIdentitySchema.parse(payload);
  const access = await requireWorkspaceAccess(env, userId, identity, operation !== 'runtime.snapshot');
  if (operation === 'runtime.attachment.cache.request') {
    const input = RuntimeCacheAttachmentRequestInputSchema.parse(payload);
    if (input.machineId !== machine) throw new Error('Cache request target mismatch');
    return access.authority.runtimeCacheAttachmentRequest(input);
  }
  const attachments = await access.authority.runtimeAttachments(identity);
  if (!attachments.some(item => item.machineId === machine && item.state !== 'detached')) throw new Error('Machine has no active assignment in this workspace');
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
      if (operation === 'runtime.submit') return access.authority.runtimeSubmit(payload);
      if (operation === 'runtime.cancel') return access.authority.runtimeCancel(payload);
      if (operation === 'runtime.answer') return access.authority.runtimeAnswer(payload, { deviceId: machineId, canApprove: false });
      const input = RuntimeSessionInputSchema.parse(payload);
      if (['setWorkspacePhase', 'saveAgentDefinition'].includes(input.command.type)) throw new Error('Administrative session changes require the direct device-signed cloud API');
      return RuntimeSessionResultSchema.parse(await (await access.authority.runtimeSession(input, { canApprove: false })).json());
    }
    case 'runtime.attachment.ready': {
      const input = RuntimeAttachmentReadyInputSchema.parse(payload);
      if (input.machineId !== machine) throw new Error('Attachment ready target mismatch');
      return access.authority.runtimeAttachmentReady(input);
    }
    case 'runtime.snapshot.commit': {
      const input = RuntimeSnapshotCommitInputSchema.parse(payload);
      if (!attachments.some(item => item.attachmentId === input.attachmentId && item.machineId === machine && item.generation === input.generation)) throw new Error('Checkpoint source is not this machine cache');
      return access.authority.runtimeSnapshotCommit(input);
    }
    case 'runtime.heartbeat': return access.authority.runtimeHeartbeat({ ...payload, machineId: machine });
    case 'runtime.detach': return access.authority.runtimeDetach({ ...payload, machineId: machine });
    default: throw new Error(`Unsupported machine runtime operation: ${z.string().parse(operation)}`);
  }
}
