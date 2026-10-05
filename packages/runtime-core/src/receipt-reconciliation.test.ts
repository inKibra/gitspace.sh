import { expect, test } from 'vitest';
import { dispatchIdentity, RuntimeExecutorReceiptSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { terminalResult } from './tasks.js';

test('positive launch fences terminate reconciliation while missing evidence remains pending', async () => {
  const observedAt = '2026-10-03T12:00:00.000Z';
  const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 3, conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId: 'attempt', tool: 'write', args: { path: 'file', content: 'value' }, deadlineAt: observedAt, replay: 'unsafe' });
  const base = { version: 1, receiptId: 'receipt', dispatch: await dispatchIdentity(dispatch), observedAt };
  const unknown = RuntimeExecutorReceiptSchema.parse({ ...base, state: 'unknown', reason: 'receipt-missing' });
  expect(terminalResult(unknown)).toBeNull();
  const fenced = RuntimeExecutorReceiptSchema.parse({ ...base, state: 'fenced-not-started', evidence: { kind: 'durable-launch-barrier', fenceGeneration: 3, recordedAt: observedAt, launchPrevented: true } });
  expect(terminalResult(fenced)?.status).toBe('interrupted');
});
