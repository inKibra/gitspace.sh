import { defineTask } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import type { RuntimeToolResult, RuntimeExecutorReceipt } from '@gitspace/protocol-runtime';
export type OperationalKind = 'CreateWorkspace' | 'Checkpoint' | 'LifecycleRun' | 'Job' | 'Service' | 'Merge' | 'CronSchedule';
export type OperationalInput = { args: JsonValue; deadlineAt: string; replay: 'safe' | 'unsafe'; scheduledAt?: number };
export type OperationalExecution = { kind: OperationalKind; args: JsonValue; attemptId: string; requestId: string; conversationId: string; taskId: string; deadlineAt: string; replay: 'safe' | 'unsafe' };
export type OperationalServices = {
  execute(input: OperationalExecution & { signal: AbortSignal }): Promise<RuntimeToolResult>;
  reconcile(attemptId: string): Promise<RuntimeToolResult | RuntimeExecutorReceipt | null>;
  cancel(attemptId: string): Promise<void>;
  jobScope(args: JsonValue): { projectId: string; workspaceId: string } | Promise<{ projectId: string; workspaceId: string }>;
  controlJob(input: { attemptId: string; op: 'logs' | 'cancel' }): Promise<RuntimeToolResult>;
  wakeAt(timestamp: number): Promise<void>;
};
export function terminalResult(receipt: RuntimeToolResult | RuntimeExecutorReceipt | null): RuntimeToolResult | null {
  if (receipt === null || !('state' in receipt)) return receipt;
  if (receipt.state === 'terminal') return receipt.result;
  if (receipt.state === 'fenced-not-started') return { status: 'interrupted', requestId: receipt.dispatch.requestId, attemptId: receipt.dispatch.attemptId, content: [{ type: 'text', text: 'Executor launch was prevented by a durable launch barrier; no execution occurred.' }] };
  return null;
}
type State = { phase: 'prepare' } | { phase: 'execute'; attemptId: string; poll?: number };
export function createOperationalTasks(services: OperationalServices) {
  return (['CreateWorkspace', 'Checkpoint', 'LifecycleRun', 'Service', 'Merge', 'CronSchedule'] as const).map(kind => defineTask<OperationalInput, State, RuntimeToolResult>({
    name: `gitspace.${kind}`, version: 1, initial: () => ({ phase: 'prepare' }),
    phases: {
      async prepare(task, runtime, context) {
        if (task.input.scheduledAt !== undefined && task.input.scheduledAt > runtime.now()) {
          await services.wakeAt(task.input.scheduledAt);
          await runtime.sleep(task.input.scheduledAt, context);
        }
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'execute', attemptId: `task:${task.id}` } }), context);
      },
      async execute(task, runtime, context) {
        const attemptId = task.state.checkpoint.attemptId;
        const receipt = await services.reconcile(attemptId);
        const result = receipt === null ? await services.execute({ kind, args: task.input.args, attemptId, requestId: `task:${task.id}`, conversationId: String(task.conversationId), taskId: String(task.id), deadlineAt: task.input.deadlineAt, replay: kind === 'LifecycleRun' ? 'unsafe' : task.input.replay, signal: runtime.signal }) : terminalResult(receipt);
        if (!result) { const next = runtime.now() + 1000; await services.wakeAt(next); await runtime.sleep(next, context); await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'execute', attemptId, poll: (task.state.checkpoint.poll ?? 0) + 1 } }), context); return; }
        await runtime.commit(() => ({ status: 'terminal', outcome: result.status === 'completed' ? { status: 'completed', result } : result.status === 'failed' ? { status: 'failed', error: { message: result.error.message }, result } : { status: 'aborted', reason: 'Executor attempt interrupted', result } }), context);
      },
    },
    async abort(task, runtime, context) {
      if (task.state.checkpoint.phase === 'execute') {
        while (true) {
          try {
            await services.cancel(task.state.checkpoint.attemptId);
            const receipt = await services.reconcile(task.state.checkpoint.attemptId);
            if (receipt === null || terminalResult(receipt)) break;
          } catch (error) { if (runtime.signal.aborted) throw error; }
          const next = runtime.now() + 1000; await services.wakeAt(next); await runtime.sleep(next, context);
        }
      }
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Cancelled' } }), context);
    },
  }));
}
