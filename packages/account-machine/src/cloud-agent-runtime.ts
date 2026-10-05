import { RuntimeSessionResultSchema, type AgentRuntime, type RuntimeSession, type RuntimeSessionCommand, type RuntimeOpenInput, type RuntimeEvent, type SessionControlView, type PendingAskAnswer, type WorkspacePhase } from '@gitspace/protocol-runtime/session-controls';
import type { AgentFailure, SessionActivity } from '@gitspace/protocol-agent';
import type { SaveAgentDefinitionInput } from '@gitspace/protocol-runtime/session-controls';
import { CloudRuntimeClient } from './cloud-runtime-client.js';
import { readLegacyTranscriptBytes, readLegacyTranscriptFile } from './legacy-transcript.js';
import { z } from 'zod';
const MessageTimestampSchema = z.object({ timestamp: z.number() });

/** A disposable machine projection. The cloud owns conversation admission and persistence. */
class CloudAgentSession implements RuntimeSession {
  get sessionFile() { return `cloud-session://${encodeURIComponent(this.input.projectId)}/${encodeURIComponent(this.input.workspaceId ?? this.input.projectId)}/${encodeURIComponent(this.id)}`; }
  private available = true;
  private timer: Timer | undefined;
  private readonly events = new Set<(event: RuntimeEvent) => void>();
  private readonly activities = new Set<(activity: SessionActivity, failure: AgentFailure | null) => void>();
  private current: { activity: SessionActivity; failure: AgentFailure | null } = { activity: { active: false, reasons: [] }, failure: null };
  constructor(private readonly client: CloudRuntimeClient, private readonly input: RuntimeOpenInput, public id: string) {}
  private identity() { return { projectId: this.input.projectId, workspaceId: this.input.workspaceId ?? this.input.projectId }; }
  private async request(command: RuntimeSessionCommand) {
    if (!this.available) throw new Error('Cloud session projection is disposed');
    const result = await this.client.call('runtime.session', { ...this.identity(), conversationId: this.id, command }, RuntimeSessionResultSchema);
    this.id = result.control.sessionId;
    for (const handler of this.events) handler({ type: 'session_control', control: result.control });
    return result;
  }
  private schedule() {
    if (this.timer || !this.available || (!this.events.size && !this.activities.size)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().finally(() => this.schedule()); }, 1000);
  }
  private async refresh() {
    try {
      const snapshot = await this.client.snapshot(this.identity());
      const conversation = snapshot.conversations.find(value => value.id === this.id);
      if (!conversation) throw new Error('Cloud conversation no longer exists');
      this.current = { activity: { active: conversation.status === 'running' || conversation.status === 'waiting', reasons: conversation.status === 'running' ? [{ kind: 'turn' }] : [] }, failure: null };
      for (const handler of this.events) handler({ type: 'cloud_snapshot', snapshot });
    } catch (error) {
      this.current = { activity: { active: false, reasons: [] }, failure: { domain: 'agent', code: 'AGENT_RUNTIME_FAILED', message: error instanceof Error ? error.message : String(error), context: { sessionId: this.id } } };
    }
    for (const handler of this.activities) handler(this.current.activity, this.current.failure);
  }
  isAvailable() { return this.available; }
  activity() { return this.current; }
  subscribe(handler: (event: RuntimeEvent) => void) { this.events.add(handler); this.schedule(); return () => { this.events.delete(handler); }; }
  subscribeActivity(handler: (activity: SessionActivity, failure: AgentFailure | null) => void) { this.activities.add(handler); this.schedule(); return () => { this.activities.delete(handler); }; }
  async prompt(text: string, options?: Parameters<RuntimeSession['prompt']>[1]) { await this.request({ type: 'prompt', text, ...options }); await this.refresh(); return true; }
  async persist() { await this.request({ type: 'persist' }); }
  async handoff() { await this.request({ type: 'handoff' }); return false; }
  async reloadSettings() { await this.request({ type: 'reloadSettings' }); }
  async instructionsChanged() { await this.request({ type: 'instructionsChanged' }); }
  async inferenceChanged() { await this.request({ type: 'inferenceChanged' }); }
  async setWorkspacePhase(phase: WorkspacePhase) { await this.request({ type: 'setWorkspacePhase', phase }); }
  async resume() { await this.request({ type: 'resume' }); await this.refresh(); }
  async dispose() { this.available = false; clearTimeout(this.timer); this.timer = undefined; this.events.clear(); this.activities.clear(); }
  async control() { return (await this.request({ type: 'control' })).control; }
  async agentSetup() { const result = await this.request({ type: 'agentSetup' }); if (!result.setup) throw new Error('Cloud response omitted agent setup'); return result.setup; }
  async saveAgentDefinition(input: SaveAgentDefinitionInput) { const result = await this.request({ type: 'saveAgentDefinition', ...input }); if (!result.setup) throw new Error('Cloud response omitted agent setup'); return result.setup; }
  async historyAnchorId() { return (await this.request({ type: 'historyAnchorId' })).control.historyAnchorId; }
  async cycleRole(direction: 'forward' | 'backward') { return (await this.request({ type: 'cycleRole', direction })).control; }
  async setModel(provider: string, model: string) { return (await this.request({ type: 'setModel', provider, model })).control; }
  async setThinking(thinking: string | null) { return (await this.request({ type: 'setThinking', thinking })).control; }
  async setFast(enabled: boolean) { return (await this.request({ type: 'setFast', enabled })).control; }
  async setApproval(approvalMode: SessionControlView['approvalMode']) { return (await this.request({ type: 'setApproval', approvalMode })).control; }
  async setGoal(input: { enabled: boolean; objective?: string }) { return (await this.request({ type: 'setGoal', ...input })).control; }
  async compact(instructions?: string) { return (await this.request({ type: 'compact', instructions })).control; }
  async clearQueue() { return (await this.request({ type: 'clearQueue' })).control; }
  async removeQueuedMessage(kind: 'steering' | 'followUp', index: number) { return (await this.request({ type: 'removeQueuedMessage', kind, index })).control; }
  async promoteQueuedMessage(index: number) { return (await this.request({ type: 'promoteQueuedMessage', index })).control; }
  async answerAsk(id: string, answers: readonly PendingAskAnswer[]) { return (await this.request({ type: 'answerAsk', id, answers })).control; }
  async stop() { return (await this.request({ type: 'stop' })).control; }
  async navigateTree(entryId: string) { return (await this.request({ type: 'navigateTree', entryId })).control; }
  async messages() { const result = await this.request({ type: 'messages' }); if (!result.messages) throw new Error('Cloud response omitted messages'); return result.messages; }
}
export class CloudAgentRuntime implements AgentRuntime {
  constructor(private readonly client: CloudRuntimeClient) {}
  async create(input: RuntimeOpenInput, signal?: AbortSignal): Promise<RuntimeSession> { const result = await this.client.call('runtime.session', { projectId: input.projectId, workspaceId: input.workspaceId ?? input.projectId, command: { type: 'control' } }, RuntimeSessionResultSchema, signal); return new CloudAgentSession(this.client, input, result.control.sessionId); }
  async open(input: RuntimeOpenInput & { sessionFile: string }, signal?: AbortSignal): Promise<RuntimeSession> {
    if (!input.sessionFile.startsWith('cloud-session://')) return this.create(input, signal);
    const url = new URL(input.sessionFile); const conversationId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    const result = await this.client.call('runtime.session', { projectId: input.projectId, workspaceId: input.workspaceId ?? input.projectId, conversationId, command: { type: 'control' } }, RuntimeSessionResultSchema, signal);
    return new CloudAgentSession(this.client, input, result.control.sessionId);
  }
  async transcript(sessionFile: string) {
    if (!sessionFile.startsWith('cloud-session://')) return readLegacyTranscriptFile(sessionFile);
    const url = new URL(sessionFile);
    const [workspaceId, conversationId] = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (!workspaceId || !conversationId) throw new Error('Invalid cloud session reference');
    const result = await this.client.call('runtime.session', { projectId: decodeURIComponent(url.hostname), workspaceId, conversationId, command: { type: 'messages' } }, RuntimeSessionResultSchema);
    if (!result.messages) throw new Error('Cloud response omitted transcript messages');
    return result.messages.map((message, ordinal) => ({ ordinal: ordinal + 1, kind: 'message_end', payload: { message }, createdAt: new Date(MessageTimestampSchema.parse(message).timestamp).toISOString() }));
  }
  async checkpointTranscript(bytes: Uint8Array) { return readLegacyTranscriptBytes(bytes); }
  async checkpointReference(sessionFile: string) {
    const url = new URL(sessionFile);
    if (url.protocol !== 'cloud-session:') throw new Error('Cloud checkpoint requires a cloud session reference');
    const [workspaceId, conversationId] = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (!workspaceId || !conversationId) throw new Error('Invalid cloud session reference');
    const snapshot = await this.client.snapshot({ projectId: decodeURIComponent(url.hostname), workspaceId });
    if (!snapshot.conversations.some(value => value.id === conversationId)) throw new Error('Cloud checkpoint conversation missing');
    return { conversationId, cursor: snapshot.cursor };
  }
}
