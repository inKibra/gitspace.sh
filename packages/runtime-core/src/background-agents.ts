import { defineDoc, defineExtension, defineTask, hook, GenerationTask, type ConversationId, type TaskId, type Task } from '@earendil-works/pi-durable';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { ConversationLifecycleDoc, type ConversationLifecycle } from './conversation-lifecycle.js';
export const BackgroundAgentsDoc = defineDoc<{ children: Record<string, { conversationId: ConversationId; owner: TaskId }> }>({ kind: 'gitspace.background-agents', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ children: {} }) });
export type BackgroundAgentTask = Task<{ spawningTask: TaskId; attemptId: string }, { phase: 'wait' }, { conversationId: string }, object>;
export function createBackgroundAgentTask(deliver: ConversationLifecycle['deliver']): BackgroundAgentTask {
  return defineTask<{ spawningTask: TaskId; attemptId: string }, { phase: 'wait' }, { conversationId: string }>({
    name: 'gitspace.BackgroundAgent', version: 1, initial: () => ({ phase: 'wait' }),
    phases: { async wait(task, runtime, context) {
      const spawn = await runtime.waitForTask(task.input.spawningTask, context);
      if (spawn.state.outcome.status !== 'completed') {
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message: 'Background agent admission failed' } } }), context);
        return;
      }
      const anchors = await runtime.snapshot(BackgroundAgentsDoc, runtime.conversationId, context);
      const anchor = anchors?.children[task.input.attemptId];
      if (!anchor || anchor.owner !== task.id) throw new Error('Background agent ownership anchor missing');
      const child = await runtime.conversation(anchor.conversationId, context);
      if (!child) throw new Error('Background conversation missing');
      await child.waitForIdle(context);
      const metadata = (await runtime.snapshot(AgentDefinitionContextDoc, anchor.conversationId, context))?.child;
      if (!metadata) throw new Error('Background child metadata missing');
      // A child that answered already told its parent (the generation onYield hook); only a stop needs telling here.
      const stopped = (await runtime.snapshot(ConversationLifecycleDoc, anchor.conversationId, context))?.stopped === true;
      if (stopped) await deliver({ conversationId: String(runtime.conversationId), requestId: `background-agent:${task.id}`, kind: 'agent-message', sender: { id: String(anchor.conversationId), name: metadata.name }, text: `Background agent ${metadata.name} stopped. Read its durable history to inspect its result.`, payload: { conversationId: String(anchor.conversationId), taskId: String(task.id) } });
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { conversationId: String(anchor.conversationId) } } }), context);
    } },
    async abort(_task, runtime, context) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Background agent cancelled' } }), context); },
  });
}

/** A subagent's final answer goes to its parent as an agent message, which agents wait returns; once per run. */
export function createSubagentReplyExtension(deliver: ConversationLifecycle['deliver']) {
  return defineExtension({ name: 'gitspace.subagent-replies', hooks: [hook(GenerationTask, { async onYield(answer, api, context) {
    const child = (await api.snapshot(AgentDefinitionContextDoc, api.conversationId, context))?.child;
    if (!child) return undefined;
    const text = answer.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
    const limit = 20_000;
    await deliver({ conversationId: child.parentId, requestId: `agent-reply:${String(api.taskId)}`, kind: 'agent-message', sender: { id: String(api.conversationId), name: child.name },
      // The event's source names the child, so its text is the reply alone.
      text: text.length > limit ? `${text.slice(0, limit)}\n(truncated; read its history for the rest)` : text || '(no text)' });
    return undefined;
  } })] });
}
