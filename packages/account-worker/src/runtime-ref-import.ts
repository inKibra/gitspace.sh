import type { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeImportRefResultSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { isAttachmentReady, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';

type ImportRuntime = Pick<WorkspaceRuntime, 'snapshot'> & { attachments: Pick<WorkspaceRuntime['attachments'], 'list' | 'execute'> };

const IMPORT_TIMEOUT_MS = 120_000;

/** Imports one origin ref the cloud cannot read (a private repository) through a machine holding the project's base
 * checkout: that machine fetches with its own git credentials and publishes the ref to the project repository. A project
 * without a ready base checkout fails with what to do; this never attaches a machine on its own. */
export async function importRefThroughBaseMachine(runtime: ImportRuntime, identity: z.infer<typeof RuntimeIdentitySchema>, ref: string): Promise<string> {
  if (String(identity.workspaceId) !== String(identity.projectId)) throw new Error('Refs are imported through the project base workspace');
  const attachment = runtime.attachments.list().find(item => item.state !== 'detached' && isAttachmentReady(item) && item.capabilities.includes('import_ref'));
  if (!attachment) throw new Error('The project repository is private and no machine holding the project\'s base workspace is online and up to date. Attach a machine with access to the repository to the project, or open the project on one, then retry.');
  const conversation = (await runtime.snapshot()).conversations.find(item => item.parentId === null);
  if (!conversation) throw new Error('Main project conversation is unavailable');
  const id = `import:${crypto.randomUUID()}`;
  const result = await runtime.attachments.execute(RuntimeToolDispatchSchema.parse({
    version: 1, projectId: identity.projectId, workspaceId: identity.workspaceId, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation,
    conversationId: conversation.id, conversationKind: 'main', taskId: id, requestId: id, attemptId: id, tool: 'import_ref', args: { ref },
    deadlineAt: new Date(Date.now() + IMPORT_TIMEOUT_MS).toISOString(), replay: 'safe',
  }), AbortSignal.timeout(IMPORT_TIMEOUT_MS));
  if (result.status !== 'completed') throw new Error(result.status === 'failed' ? `Importing ${ref} through ${attachment.machineId} failed: ${result.error.message}` : `Importing ${ref} was interrupted`);
  const text = result.content.find(item => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Ref import response is missing');
  const imported = RuntimeImportRefResultSchema.parse(JSON.parse(text.text));
  if (imported.ref !== ref) throw new Error(`Ref import answered for ${imported.ref}, not ${ref}`);
  return imported.commit;
}
