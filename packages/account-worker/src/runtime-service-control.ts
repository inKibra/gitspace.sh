import { RuntimeToolDispatchSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { RuntimeServiceLogSchema, RuntimeServiceSchema, type RuntimeServiceInput, type RuntimeServiceResult } from '@gitspace/protocol-runtime/services';
import type { WorkspaceRuntime } from '@gitspace/runtime-workspace-do';

type ServiceRuntime = Pick<WorkspaceRuntime, 'snapshot'> & { cloudFiles: Pick<WorkspaceRuntime['cloudFiles'], 'initializeSnapshot'>; attachments: Pick<WorkspaceRuntime['attachments'], 'list' | 'execute'> };
/** Exact attachment identities fence every service action; listing never selects a default machine. */
export async function runtimeServiceControl(runtime: ServiceRuntime, input: RuntimeServiceInput): Promise<RuntimeServiceResult> {
  const caches = runtime.attachments.list().filter(item => item.role === 'cache' && item.state !== 'detached' && item.state !== 'lost');
  const available = (item: RuntimeAttachment) => item.state === 'ready' && item.heartbeatAt !== null && Date.now() - Date.parse(item.heartbeatAt) < 30_000 && item.capabilities.includes('service');
  const target = (item: RuntimeAttachment) => ({ machineId: item.machineId, attachmentId: item.attachmentId, generation: item.generation });
  async function execute(attachment: RuntimeAttachment, command: RuntimeServiceInput['command']) {
    if (!available(attachment)) throw new Error('Service machine is offline or unavailable');
    const snapshot = await runtime.snapshot();
    const conversation = snapshot.conversations.find(item => item.parentId === null);
    if (!conversation) throw new Error('Main workspace conversation is unavailable');
    const checkpoint = await runtime.cloudFiles.initializeSnapshot();
    const id = crypto.randomUUID();
    const args = command.op === 'list' ? { op: command.op } : { op: command.op, name: command.name, source: command.source };
    const result = await runtime.attachments.execute(RuntimeToolDispatchSchema.parse({ version: 1, projectId: input.projectId, workspaceId: input.workspaceId, ...target(attachment), conversationId: conversation.id, conversationKind: 'main', taskId: `services:${id}`, requestId: id, attemptId: id, tool: 'service', args, snapshot: checkpoint, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: command.op === 'list' || command.op === 'logs' ? 'safe' : 'unsafe' }), AbortSignal.timeout(60_000));
    if (result.status !== 'completed') throw new Error(result.status === 'failed' ? result.error.message : 'Service operation interrupted');
    const text = result.content.find(item => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Service response is missing');
    const value: unknown = JSON.parse(text.text);
    return value;
  }
  if (input.command.op === 'list') {
    const machines = await Promise.all(caches.map(async attachment => {
      if (!available(attachment)) return { ...target(attachment), available: false, error: 'Machine offline or cache unavailable', services: [] };
      try { return { ...target(attachment), available: true, error: null, services: RuntimeServiceSchema.array().parse(await execute(attachment, { op: 'list' })) }; }
      catch (error) { return { ...target(attachment), available: false, error: error instanceof Error ? error.message : String(error), services: [] }; }
    }));
    return { op: 'list', machines };
  }
  const command = input.command;
  const attachment = caches.find(item => item.machineId === command.machineId && item.attachmentId === command.attachmentId && item.generation === command.generation);
  if (!attachment) throw new Error('Service attachment changed or is unavailable');
  const value = await execute(attachment, command);
  return command.op === 'logs' ? { op: 'logs', target: target(attachment), log: RuntimeServiceLogSchema.parse(value) } : { op: command.op, target: target(attachment), service: RuntimeServiceSchema.parse(value) };
}
