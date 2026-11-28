import type { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeImportRefResultSchema, RuntimePublishCommitResultSchema, RuntimeToolDispatchSchema, type RuntimeAttachment, type RuntimeJsonSchema } from '@gitspace/protocol-runtime';
import { artifactsWorkspaceRepository, isAttachmentReady, type ArtifactsCodeStore, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';

type MachineRuntime = Pick<WorkspaceRuntime, 'snapshot'> & { attachments: Pick<WorkspaceRuntime['attachments'], 'list' | 'execute'> };

const MACHINE_TIMEOUT_MS = 120_000;

/** Runs one machine operation on `attachment` as a call of the main conversation and returns its text answer. `action`
 * names the operation in its failures. */
async function executeOnMachine(runtime: MachineRuntime, identity: z.infer<typeof RuntimeIdentitySchema>, attachment: RuntimeAttachment, tool: string, args: z.infer<typeof RuntimeJsonSchema>, action: string): Promise<string> {
  const conversation = (await runtime.snapshot()).conversations.find(item => item.parentId === null);
  if (!conversation) throw new Error('Main workspace conversation is unavailable');
  const id = `${tool}:${crypto.randomUUID()}`;
  const result = await runtime.attachments.execute(RuntimeToolDispatchSchema.parse({
    version: 1, projectId: identity.projectId, workspaceId: identity.workspaceId, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation,
    conversationId: conversation.id, conversationKind: 'main', taskId: id, requestId: id, attemptId: id, tool, args,
    deadlineAt: new Date(Date.now() + MACHINE_TIMEOUT_MS).toISOString(), replay: 'safe',
  }), AbortSignal.timeout(MACHINE_TIMEOUT_MS));
  if (result.status !== 'completed') throw new Error(result.status === 'failed' ? `${action} through ${attachment.machineId} failed: ${result.error.message}` : `${action} was interrupted`);
  const text = result.content.find(item => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`${action} answered nothing`);
  return text.text;
}

/** Imports one origin ref the cloud cannot read (a private repository) through a machine holding the project's base
 * checkout: that machine fetches with its own git credentials and publishes the ref to the project repository. A project
 * without a ready base checkout fails with what to do; this never attaches a machine on its own. */
export async function importRefThroughBaseMachine(runtime: MachineRuntime, identity: z.infer<typeof RuntimeIdentitySchema>, ref: string): Promise<string> {
  if (String(identity.workspaceId) !== String(identity.projectId)) throw new Error('Refs are imported through the project base workspace');
  const attachment = runtime.attachments.list().find(item => item.state !== 'detached' && isAttachmentReady(item) && item.capabilities.includes('import_ref'));
  if (!attachment) throw new Error('The project repository is private and no machine holding the project\'s base workspace is online and up to date. Attach a machine with access to the repository to the project, or open the project on one, then retry.');
  const imported = RuntimeImportRefResultSchema.parse(JSON.parse(await executeOnMachine(runtime, identity, attachment, 'import_ref', { ref }, `Importing ${ref}`)));
  if (imported.ref !== ref) throw new Error(`Ref import answered for ${imported.ref}, not ${ref}`);
  return imported.commit;
}

/** Makes a Change Guide's base and head commits readable from the workspace's cloud repository, where its diffs are
 * read. Each commit the repository lacks (a workspace copied in from its tip holds no history) is published by the
 * workspace's own ready machine checkout (`publish_commit`), which holds it or fetches it from its origin, and the
 * repository is read again. Without such a machine this fails, naming the commits and the machines that can publish
 * them; it never attaches a machine on its own. */
export async function ensureGuideCommits(input: {
  runtime: () => Promise<MachineRuntime>; code: Pick<ArtifactsCodeStore, 'readCommit'>; identity: z.infer<typeof RuntimeIdentitySchema>;
  baseCommit: string; headCommit: string; machineLabel: (machineId: string) => Promise<string>;
}): Promise<void> {
  const repository = artifactsWorkspaceRepository(input.identity.workspaceId);
  const commits = [...new Set([input.baseCommit, input.headCommit])];
  const missing = (await Promise.all(commits.map(async commit => await input.code.readCommit(repository, commit) === null ? [commit] : []))).flat();
  if (missing.length === 0) return;
  const named = missing.map(commit => `${commit === input.baseCommit ? 'base' : 'head'} commit ${commit.slice(0, 12)}`).join(' and ');
  const runtime = await input.runtime();
  const holders = runtime.attachments.list().filter(item => item.state !== 'detached' && item.capabilities.includes('publish_commit'));
  const attachment = holders.find(isAttachmentReady);
  if (!attachment) {
    const labels = [...new Set(await Promise.all(holders.map(item => input.machineLabel(item.machineId))))];
    throw new Error(`The guide's ${named} ${missing.length === 1 ? 'is' : 'are'} not in GitSpace's copy of this workspace, so its diffs cannot be shown, and only a machine holding the workspace can publish ${missing.length === 1 ? 'it' : 'them'}. ${labels.length > 0 ? `Bring ${labels.join(' or ')} online` : 'Open the workspace on a machine whose checkout has the commits or can fetch them from the origin'}, then put the guide again. The guide was not stored.`);
  }
  for (const commit of missing) {
    const published = RuntimePublishCommitResultSchema.parse(JSON.parse(await executeOnMachine(runtime, input.identity, attachment, 'publish_commit', { commit }, `Publishing commit ${commit}`)));
    if (published.commit !== commit) throw new Error(`Commit publication answered for ${published.commit}, not ${commit}`);
    if (await input.code.readCommit(repository, commit) === null) throw new Error(`${attachment.machineId} published commit ${commit}, but GitSpace's copy of this workspace still lacks it. The guide was not stored.`);
  }
}
