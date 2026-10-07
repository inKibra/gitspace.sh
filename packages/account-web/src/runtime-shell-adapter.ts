import type { MessageBlock, MessageImage, SideAgentBlock, TurnBlock } from '@gitspace/blocks';
import type { InspectorView } from '@gitspace/protocol';
import type { SpaceViewCodec } from '@gitspace/protocol/rpc-contract';
import type { InputOf } from 'result-rpc';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeSubagentRecordSchema, type RuntimeSubagentRecord } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeExecutionDocumentSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';
import { deriveWorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import type { AgentScopeView, ProjectAgentView, WorkspaceView } from './GitSpaceShell.js';

/** Runtime ownership is cloud-owned, independently of any attached working copy. */
export function runtimeScope(snapshot: RuntimeSnapshot, inspection: Pick<InspectorView, 'project' | 'workspace' | 'workspaces' | 'machines' | 'placement'>, relationWorkspaces: InputOf<typeof SpaceViewCodec>['workspaces'] = []): { workspace: AgentScopeView; baseSpace: ProjectAgentView; workspaces: WorkspaceView[]; relationsReady: boolean } {
  const execution = RuntimeExecutionDocumentSchema.parse(snapshot.documents['gitspace.execution'] ?? { defaultMachineId: null });
  const caches = snapshot.attachments.filter(item => item.role === 'cache' && item.state !== 'detached');
  const cache = caches.find(item => item.machineId === execution.defaultMachineId) ?? caches.find(item => item.state === 'ready') ?? caches[0];
  const document = snapshot.documents['gitspace.workspace'];
  const phaseValue = document && typeof document === 'object' && !Array.isArray(document) ? document.phase : null;
  const phase = phaseValue === 'plan' || phaseValue === 'code' || phaseValue === 'review' || phaseValue === 'ship' ? phaseValue : inspection.workspace.phase ?? 'plan';
  const status = deriveWorkspaceStatusSummary({ agents: snapshot.conversations.map(item => ({ state: item.status === 'running' ? 'running' : item.status === 'waiting' ? 'permission-needed' : 'waiting', ...(item.status === 'failed' ? { failure: { code: 'RUNTIME_FAILED', message: 'Conversation failed' } } : {}) })) });
  const common = { projectId: inspection.project.id, projectName: inspection.project.name, generation: inspection.placement?.generation ?? cache?.ownershipGeneration ?? 0, possessedBy: cache?.machineId ?? '', holder: cache ? { kind: 'held' as const, machineId: cache.machineId, label: inspection.machines.find(item => item.id === cache.machineId)?.label ?? cache.machineId } : { kind: 'unknown' as const }, status };
  const baseSpace: ProjectAgentView = { ...common, kind: 'project', id: inspection.project.id, name: inspection.project.name, branch: inspection.project.baseBranch, phase: null, closedAt: inspection.project.archivedAt ? new Date(inspection.project.archivedAt) : null };
  const definitions = inspection.workspaces.some(item => item.id === inspection.workspace.id) ? inspection.workspaces : [...inspection.workspaces, inspection.workspace];
  const workspaces: WorkspaceView[] = definitions.filter(item => item.kind === 'worktree').map(item => {
    const saved = relationWorkspaces.find(workspace => workspace.id === item.id);
    return { ...common, kind: 'workspace', id: item.id, name: item.name, branch: item.branch, phase: item.id === snapshot.workspaceId ? phase : item.phase ?? 'plan', closedAt: item.archivedAt ? new Date(item.archivedAt) : null, relations: saved?.relations ?? { dependsOn: [], relatedTo: [], stackedOn: null }, stack: saved?.stack ?? { blockedBy: [], blocking: [], findings: [] } };
  });
  const relationsReady = workspaces.every(workspace => relationWorkspaces.some(saved => saved.id === workspace.id));
  return { baseSpace, workspaces, relationsReady, workspace: inspection.workspace.kind === 'base' ? baseSpace : workspaces.find(item => item.id === inspection.workspace.id)! };
}

const runtimeAgentsDocumentSchema = RuntimeSubagentRecordSchema.extend({ conversationId: z.string() }).array();
export type RuntimeSideAgentBlock = SideAgentBlock & { runtime?: RuntimeSubagentRecord; messages?: MessageBlock[] };

export function runtimeSubagentRecords(snapshot: RuntimeSnapshot) {
  const document = snapshot.documents['gitspace.agents'];
  return document === undefined ? [] : runtimeAgentsDocumentSchema.parse(document);
}

function runtimeMessages(conversation: RuntimeSnapshot['conversations'][number]): MessageBlock[] {
  return conversation.messages.flatMap<MessageBlock>(message => message.role === 'user' || message.role === 'assistant' ? [{
    id: message.id, type: 'message', role: message.role,
    text: message.content.flatMap(content => content.type === 'text' ? [content.text] : []).join(''),
    images: message.content.flatMap<MessageImage>(content => content.type === 'image' && (content.mimeType === 'image/png' || content.mimeType === 'image/jpeg' || content.mimeType === 'image/webp') ? [{ data: content.data, mimeType: content.mimeType }] : []),
  }] : []);
}

export function runtimeSubagents(snapshot: RuntimeSnapshot): RuntimeSideAgentBlock[] {
  const records = runtimeSubagentRecords(snapshot);
  return snapshot.conversations.filter(item => item.parentId !== null).map(item => {
    const runtime = records.find(record => record.conversationId === item.id);
    const requestedName = runtime?.requestedName === undefined ? runtime?.name : runtime.requestedName;
    const messages = runtimeMessages(item);
    return {
      id: `agent:${item.id}`, type: 'side-agent', agentId: item.id, label: requestedName?.trim() || runtime?.definition?.name.trim() || runtime?.role || item.title || item.id,
      status: item.status === 'idle' ? 'done' : item.status === 'waiting' ? 'blocked' : item.status,
      summary: messages.findLast(message => message.text.length > 0)?.text,
      messages,
      ...(runtime ? { runtime, agent: runtime.role ?? runtime.definition?.name, model: runtime.model ? `${runtime.model.provider} / ${runtime.model.modelId}` : undefined } : {}),
    };
  });
}

/** A snapshot immediately paints the existing transcript while its bounded history loads. */
export function runtimeTurns(snapshot: RuntimeSnapshot, conversationId: string | undefined): TurnBlock[] {
  const conversation = snapshot.conversations.find(item => item.id === conversationId);
  const turns: TurnBlock[] = [];
  for (const message of conversation?.messages ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const block: MessageBlock = { id: message.id, type: 'message', role: message.role, text: message.content.flatMap(content => content.type === 'text' ? [content.text] : []).join(''), images: message.content.flatMap<MessageImage>(content => content.type === 'image' && (content.mimeType === 'image/png' || content.mimeType === 'image/jpeg' || content.mimeType === 'image/webp') ? [{ data: content.data, mimeType: content.mimeType }] : []) };
    if (message.role === 'user' || !turns.length) turns.push({ id: `turn:${message.id}`, type: 'turn', status: 'done', startedAt: message.createdAt, items: [], sideAgents: [], ...(message.role === 'user' ? { user: block } : {}) });
    if (message.role === 'assistant') turns.at(-1)!.items.push(block);
  }
  if (turns.length) { turns.at(-1)!.sideAgents = runtimeSubagents(snapshot); turns.at(-1)!.status = conversation?.status === 'running' || conversation?.status === 'waiting' ? 'running' : conversation?.status === 'failed' ? 'error' : 'done'; }
  return turns;
}
