import { defineDoc, type Harness, type Storage, type ConversationId, type Cursor, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { RuntimeAgentsArgumentsSchema, RuntimeCheckpointArgumentsSchema, RuntimeRewindArgumentsSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { ToolServices } from './tools.js';
import { CronScopeDoc } from './documents.js';
import { SessionControlsDoc, parseCloudAgentDefinition } from './session-controls.js';
import { BackgroundAgentsDoc, BackgroundAgentTask } from './background-agents.js';
import type { JobServices } from './jobs.js';
import type { ModelSelectionIntent } from '@gitspace/protocol-runtime/session-controls';
const Anchors = defineDoc<{ entries: Record<string, string>; children: Record<string, string> }>({ kind: 'gitspace.context-anchors', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ entries: {}, children: {} }) });
export const AgentDefinitionContextDoc = defineDoc<{ name: string | null; spawns: string[] | null }>({ kind: 'gitspace.agent-definition', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ name: null, spawns: null }) });
export type ConversationToolOptions = { harness: Harness; storage: Storage } & Pick<JobServices, 'admitInference'>;
export function createConversationTools(options: ConversationToolOptions) {
  const { harness, storage } = options;
  const context = BACKGROUND_CONTEXT;
  async function resolve(id: string) {
    let cursor: Cursor | undefined;
    do { const page = await storage.scanConversations({}, 128, cursor, context); const record = page.items.find(item => String(item.id) === id); if (record) { const conversation = await harness.conversation(record.id, context); if (conversation) return conversation; } cursor = page.next; } while (cursor);
    throw new Error('Conversation not found');
  }
  async function entries(id: ConversationId) {
    const result: EntryRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await storage.scanEntries({ conversationId: id }, 128, cursor, context); result.push(...page.items); cursor = page.next; } while (cursor);
    return result;
  }
  return async (input: Parameters<ToolServices['invoke']>[0]): Promise<RuntimeToolResult> => {
    const target = await resolve(input.conversationId);
    let output: string;
    if (input.tool === 'agents') {
      const args = RuntimeAgentsArgumentsSchema.parse(input.args);
      if (args.op === 'spawn') {
        if (!args.task) throw new Error('Subagent task is required');
        const definitions = await harness.snapshot(SessionControlsDoc, target.id, context);
        const definition = args.agent ? definitions?.definitions.find(value => value.name === args.agent) : undefined;
        if (args.agent && !definition) throw new Error('Requested agent definition not found');
        const parentDefinition = await harness.snapshot(AgentDefinitionContextDoc, target.id, context);
        if (parentDefinition?.spawns && !parentDefinition.spawns.includes('*') && (!args.agent || !parentDefinition.spawns.includes(args.agent))) throw new Error('Parent agent definition does not permit this subagent');
        const parentAgent = await target.agent(context);
        if (definition?.tools.some(name => !parentAgent.tools.some(tool => tool.name === name))) throw new Error('Agent definition requests a tool not granted to its parent');
        const selection: ModelSelectionIntent | undefined = definition?.role ? { kind: 'role', role: definition.role } : definition?.provider && definition.model ? { kind: 'explicit', provider: definition.provider, modelId: definition.model } : undefined;
        const childId = await target.commit(async tx => {
          let cursor: Cursor | undefined;
          let owner;
          do { const page = await tx.scanTasks({ conversationId: target.id }, 128, cursor); owner = page.items.find(task => String(task.id) === input.taskId); cursor = page.next; } while (!owner && cursor);
          if (!owner) throw new Error('Subagent spawning task not found');
          const anchors = await tx.doc(Anchors, target.id);
          const existing = anchors.children[input.attemptId];
          if (existing) return existing;
          const anchorTask = args.background ? await tx.createTask(BackgroundAgentTask, { spawningTask: owner.id, attemptId: input.attemptId }, { ownership: { kind: 'conversation' }, conversationId: target.id, background: true }) : owner.id;
          const created = await tx.createConversation({ ownership: { kind: 'task', taskId: anchorTask } });
          if (args.background) { const background = await tx.doc(BackgroundAgentsDoc, target.id); background.children[input.attemptId] = { conversationId: created.id, owner: anchorTask }; }
          const parentScope = await tx.doc(CronScopeDoc, target.id);
          const childScope = await tx.doc(CronScopeDoc, created.id); childScope.constrained = parentScope.constrained; childScope.readScopes = [...parentScope.readScopes]; childScope.writeScopes = [...parentScope.writeScopes];
          const childControls = await tx.doc(SessionControlsDoc, created.id);
          if (definitions) { childControls.definitions = [...definitions.definitions]; childControls.approvalMode = definitions.approvalMode; childControls.fastMode = definitions.fastMode; childControls.role = definition?.role ?? definitions.role; childControls.selection = selection ?? definitions.selection; }
          const definitionContext = await tx.doc(AgentDefinitionContextDoc, created.id);
          definitionContext.name = definition?.name ?? 'sub';
          definitionContext.spawns = definition?.spawns === null || definition?.spawns === undefined ? null : definition.spawns.split(',').map(name => name.trim()).filter(Boolean);
          anchors.children[input.attemptId] = String(created.id);
          return String(created.id);
        }, context);
        const child = await resolve(childId);
        const model = await options.admitInference({ conversationId: childId, requestId: input.attemptId, parentConversationId: input.conversationId, ...(selection ? { selection } : {}) });
        await child.configure({ model, thinkingLevel: parentAgent.thinkingLevel, instructions: definition ? parseCloudAgentDefinition(definition.path, definition.content).instructions : parentAgent.instructions, tools: definition?.tools.length ? parentAgent.tools.filter(tool => definition.tools.includes(tool.name)) : parentAgent.tools }, context);
        const submission = await child.submit({ type: 'input', content: args.task, requestId: input.attemptId }, context);
        output = JSON.stringify({ conversationId: childId, submissionId: String(submission.id) });
      } else if (args.op === 'send') {
        if (!args.id || !args.message) throw new Error('Agent id and message required');
        const child = await resolve(args.id);
        const selection = (await harness.snapshot(SessionControlsDoc, child.id, context))?.selection;
        const model = await options.admitInference({ conversationId: args.id, requestId: input.attemptId, parentConversationId: input.conversationId, ...(selection ? { selection } : {}) });
        await child.configure({ model }, context);
        const submission = await child.submit({ type: 'input', content: args.message, requestId: input.attemptId, whenBusy: 'steer' }, context);
        output = 'Message admitted';
      } else if (args.op === 'stop') { if (!args.id) throw new Error('Agent id required'); await (await resolve(args.id)).abort(context, { background: true }); output = 'Agent stopped'; }
      else { const inspection = await harness.inspect(context); output = JSON.stringify(inspection.tasks.map(task => ({ id: String(task.record.id), conversationId: String(task.record.conversationId), kind: task.record.kind, state: task.record.state.status }))); }
    } else if (input.tool === 'checkpoint') {
      const args = RuntimeCheckpointArgumentsSchema.parse(input.args);
      const anchor = await target.commit(async tx => { const anchors = await tx.doc(Anchors, target.id); if (anchors.entries[input.attemptId]) return anchors.entries[input.attemptId]; const entry = await tx.appendEntry(target.id, { kind: 'gitspace.checkpoint', data: { goal: args.goal } }); anchors.entries[input.attemptId] = String(entry.id); return String(entry.id); }, context);
      output = JSON.stringify({ checkpoint: anchor });
    } else if (input.tool === 'rewind') {
      const args = RuntimeRewindArgumentsSchema.parse(input.args);
      const all = await entries(target.id); const index = all.findIndex(entry => String(entry.id) === args.checkpoint && entry.kind === 'gitspace.checkpoint');
      if (index < 0) throw new Error('Context checkpoint not found');
      await target.commit(tx => tx.appendEntry(target.id, { kind: 'gitspace.rewind', edits: all.slice(index + 1).map(entry => ({ target: entry.id, action: 'omit' as const })), model: [{ role: 'user', content: args.report, timestamp: Date.now() }] }), context);
      output = 'Context rewound; immutable history retained.';
    } else throw new Error('Not a conversation tool');
    return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: output }] };
  };
}
