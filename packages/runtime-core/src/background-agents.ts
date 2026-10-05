import { defineDoc, defineTask, type ConversationId, type TaskId } from '@earendil-works/pi-durable';
export const BackgroundAgentsDoc = defineDoc<{ children: Record<string, { conversationId: ConversationId; owner: TaskId }> }>({ kind: 'gitspace.background-agents', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ children: {} }) });
export const BackgroundAgentTask = defineTask<{ spawningTask: TaskId; attemptId: string }, { phase: 'wait' }, { conversationId: string }>({
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
    await runtime.commit(async tx => {
      await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.background-completed', data: { conversationId: anchor.conversationId, taskId: String(task.id) }, model: [{ role: 'user', content: `Background agent ${anchor.conversationId} settled. Read its durable history to inspect its result.`, timestamp: runtime.now() }] });
      return { status: 'terminal', outcome: { status: 'completed', result: { conversationId: String(anchor.conversationId) } } };
    }, context);
  } },
  async abort(_task, runtime, context) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Background agent cancelled' } }), context); },
});
