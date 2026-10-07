import { defineDoc, type Harness, type Storage, type Conversation, type ConversationId, type Cursor, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { RuntimeAgentsArgumentsSchema, RuntimeCheckpointArgumentsSchema, RuntimeRewindArgumentsSchema, SUBAGENT_READONLY_TOOLS, type RuntimeToolResult, type ModelSelectionIntent } from '@gitspace/protocol-runtime';
import type { ToolServices } from './tools.js';
import { CronScopeDoc } from './documents.js';
import { cronTaskScopes } from './cron.js';
import { SessionControlsDoc, parseCloudAgentDefinition, type SessionControlServices } from './session-controls.js';
import { BackgroundAgentsDoc, type BackgroundAgentTask } from './background-agents.js';
import { AgentDefinitionContextDoc, type SubagentMetadata } from './subagent-state.js';
import { ConversationLifecycleDoc, type ConversationLifecycle } from './conversation-lifecycle.js';
const Anchors = defineDoc<{ entries: Record<string, string>; children: Record<string, string> }>({ kind: 'gitspace.context-anchors', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ entries: {}, children: {} }) });
const ThinkingSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable();
export type ConversationToolOptions = { harness: Harness; storage: Storage; lifecycle: ConversationLifecycle; backgroundAgentTask: BackgroundAgentTask; refreshDefinitions?(target: Conversation): Promise<void> } & Pick<SessionControlServices, 'admitInference' | 'configureModel' | 'catalog'>;
export function createConversationTools(options: ConversationToolOptions) {
  const { harness, storage } = options;
  const context = BACKGROUND_CONTEXT;
  async function records() {
    const result = []; let cursor: Cursor | undefined;
    do { const page = await storage.scanConversations({}, 128, cursor, context); result.push(...page.items); cursor = page.next; } while (cursor);
    return result;
  }
  async function resolve(id: string) {
    const record = (await records()).find(item => String(item.id) === id);
    const conversation = record && await harness.conversation(record.id, context);
    if (!conversation) throw new Error('Conversation not found');
    return conversation;
  }
  async function family(id: ConversationId) {
    const self = (await harness.snapshot(AgentDefinitionContextDoc, id, context))?.child;
    const parentId = self?.parentId ?? String(id);
    const members = [{ id: parentId, name: 'parent', child: null as SubagentMetadata | null }];
    for (const record of await records()) {
      const child = (await harness.snapshot(AgentDefinitionContextDoc, record.id, context))?.child;
      if (child?.parentId === parentId) members.push({ id: String(record.id), name: child.name, child });
    }
    return { self, members };
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
      const group = await family(target.id);
      if (args.op === 'spawn') {
        if (group.self) throw new Error('Subagents cannot spawn nested agents');
        await options.refreshDefinitions?.(target);
        const previousId = (await harness.snapshot(Anchors, target.id, context))?.children[input.attemptId];
        const previous = previousId ? (await harness.snapshot(AgentDefinitionContextDoc, (await resolve(previousId)).id, context))?.child : null;
        const definitions = await harness.snapshot(SessionControlsDoc, target.id, context);
        const agentSelector = 'agent' in args ? args.agent : undefined;
        const definition = previous ? previous.definition : agentSelector ? definitions?.definitions.find(value => value.name === agentSelector || value.path === agentSelector) : undefined;
        if (!previous && agentSelector && !definition) throw new Error('Requested agent definition not found');
        const parsed = definition ? parseCloudAgentDefinition(definition.path, definition.content) : null;
        const catalog = await options.catalog();
        const roleId = 'role' in args ? args.role : definition?.role;
        const role = roleId ? catalog.roles.find(value => value.id === roleId) : undefined;
        if (!previous && roleId && !role) throw new Error('Requested inference role not found');
        const selection: ModelSelectionIntent = previous?.selection ?? (role ? { kind: 'role', role: role.id } : definition?.provider && definition.model ? { kind: 'explicit', provider: definition.provider, modelId: definition.model } : { kind: 'default' });
        const thinking = previous ? previous.thinking : ThinkingSchema.parse(parsed?.thinking ?? definition?.thinking ?? role?.thinking ?? null);
        const narrowedTools = parsed?.toolsSpecified ? parsed.tools : [...SUBAGENT_READONLY_TOOLS];
        const tools = previous?.tools ?? (narrowedTools.includes('agents') ? narrowedTools : [...narrowedTools, 'agents']);
        const name = previous?.name ?? args.name ?? `${definition?.name ?? role?.id}-${input.attemptId}`;
        if (name === 'parent') throw new Error('The parent address is reserved');
        const childId = await target.commit(async tx => {
          if ((await tx.doc(ConversationLifecycleDoc, target.id)).stopped) throw new Error('Conversation is stopped; only an explicit user message may resume it');
          const anchors = await tx.doc(Anchors, target.id);
          const existing = anchors.children[input.attemptId];
          if (existing) return existing;
          let siblingsCursor: Cursor | undefined;
          do {
            const page = await tx.scanConversations({}, 128, siblingsCursor);
            for (const sibling of page.items) {
              const metadata = (await tx.doc(AgentDefinitionContextDoc, sibling.id)).child;
              if (metadata?.parentId === input.conversationId && metadata.name === name) throw new Error('Agent name is already in use by a sibling');
            }
            siblingsCursor = page.next;
          } while (siblingsCursor);
          let cursor: Cursor | undefined;
          let owner;
          do { const page = await tx.scanTasks({ conversationId: target.id }, 128, cursor); owner = page.items.find(task => String(task.id) === input.taskId); cursor = page.next; } while (!owner && cursor);
          if (!owner) throw new Error('Subagent spawning task not found');
          const inheritedScopes = await cronTaskScopes(tx, target.id, owner.id);
          const anchorTask = args.background ? await tx.createTask(options.backgroundAgentTask, { spawningTask: owner.id, attemptId: input.attemptId }, { ownership: { kind: 'conversation' }, conversationId: target.id, background: true }) : owner.id;
          const created = await tx.createConversation({ ownership: { kind: 'task', taskId: anchorTask } });
          if (args.background) (await tx.doc(BackgroundAgentsDoc, target.id)).children[input.attemptId] = { conversationId: created.id, owner: anchorTask };
          (await tx.doc(CronScopeDoc, created.id)).inherited = inheritedScopes;
          const childControls = await tx.doc(SessionControlsDoc, created.id);
          childControls.role = role?.id ?? null;
          childControls.selection = selection;
          const definitionContext = await tx.doc(AgentDefinitionContextDoc, created.id);
          definitionContext.child = { parentId: input.conversationId, name, attemptId: input.attemptId, definition: definition ?? null, selection, role: role?.id ?? null, thinking, tools, model: null };
          anchors.children[input.attemptId] = String(created.id);
          return String(created.id);
        }, context);
        const child = await resolve(childId);
        const metadata = (await harness.snapshot(AgentDefinitionContextDoc, child.id, context))?.child;
        if (!metadata) throw new Error('Child metadata missing');
        const submission = await options.lifecycle.runWhileActive(childId, async () => {
          input.signal?.throwIfAborted();
          const model = await options.admitInference({ conversationId: childId, requestId: input.attemptId, parentConversationId: input.conversationId, selection: metadata.model ? { kind: 'explicit', ...metadata.model } : metadata.selection });
          await child.commit(async tx => { const childState = await tx.doc(AgentDefinitionContextDoc, child.id); if (childState.child && !childState.child.model) childState.child.model = model; }, context);
          await options.configureModel(child.id, model);
          const instructions = metadata.definition ? parseCloudAgentDefinition(metadata.definition.path, metadata.definition.content).instructions : '';
          await child.configure({ thinkingLevel: metadata.thinking, instructions: `${instructions}\n\nYou are ${metadata.name} (${childId}), a read-only subagent. Your parent is available at parent (${metadata.parentId}). Use agents list to discover sibling names and ids, agents send to message parent or siblings, and agents wait for events. You cannot spawn or stop agents.` }, context);
          input.signal?.throwIfAborted();
          return child.submit({ type: 'input', content: args.task, requestId: input.attemptId }, context);
        });
        output = JSON.stringify({ conversationId: childId, name: metadata.name, submissionId: String(submission.id) });
      } else if (args.op === 'send') {
        const recipient = group.members.find(member => member.id === args.to || member.name === args.to);
        if (!recipient) throw new Error('Agent address is not a parent or sibling in this conversation family');
        await options.lifecycle.deliver({ conversationId: recipient.id, requestId: input.attemptId, kind: 'agent-message', sender: { id: input.conversationId, name: group.self?.name ?? 'parent' }, text: args.message });
        output = 'Message durably admitted';
      } else if (args.op === 'wait') {
        output = JSON.stringify(await options.lifecycle.wait(input.conversationId, { timeoutMs: args.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) }));
      } else if (args.op === 'stop') {
        if (group.self) throw new Error('Subagents cannot stop agents');
        const child = group.members.find(member => member.id === args.id && member.child);
        if (!child) throw new Error('Child agent not found');
        await options.lifecycle.stop(child.id); output = 'Agent stopped';
      } else {
        const inspection = await harness.inspect(context);
        output = JSON.stringify(group.members.map(member => ({ id: member.id, name: member.name, parentId: member.child?.parentId ?? null, tasks: inspection.tasks.filter(task => String(task.record.conversationId) === member.id).map(task => ({ id: String(task.record.id), kind: task.record.kind, state: task.record.state.status })) })));
      }
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
