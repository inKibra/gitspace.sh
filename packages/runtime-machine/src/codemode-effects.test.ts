import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { ExecutorJournal } from './journal.js';
import { MachineExecutor } from './executor.js';
import { ExecutorEffectUncertain, type RunExecutorCommand } from './commands.js';

async function fixture(runCommand: RunExecutorCommand) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-codemode-effects-'));
  const journal = new ExecutorJournal(join(root, 'executor.sqlite'));
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['codemode', 'bash'], updatedAt: new Date().toISOString() });
  journal.installAttachment({ attachment, rootPath: root, executionSecret: Buffer.alloc(32, 1).toString('base64url'), prerequisitesComplete: true });
  const unexpected = (): never => { throw new Error('Unexpected external operation'); };
  const executor = new MachineExecutor({ machineId: 'machine', journal, runCommand, artifacts: unexpected, cloudModel: unexpected, cloudMcp: unexpected });
  const { attachmentId, projectId, workspaceId, machineId, generation } = attachment;
  const dispatch = (code: string) => RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, attachmentId, projectId, workspaceId, machineId, generation, conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId: 'attempt', tool: 'codemode', args: { code }, deadlineAt: new Date(Date.now() + 10_000).toISOString(), replay: 'unsafe' });
  return { journal, executor, dispatch, close: async () => { journal.close(); await rm(root, { recursive: true, force: true }); } };
}

test('script-caught child uncertainty cannot become a terminal parent receipt', async () => {
  let effects = 0;
  const f = await fixture(async () => { effects++; throw new ExecutorEffectUncertain('Lost command reply after launch'); });
  try {
    const dispatch = f.dispatch('try { await tools.bash({ command: "effect" }); } catch {}');
    await expect(f.executor.execute(dispatch)).rejects.toBeInstanceOf(ExecutorEffectUncertain);
    expect((await f.executor.observe(dispatch)).receipt.state).toBe('unknown');
    await expect(f.executor.execute(dispatch)).rejects.toBeInstanceOf(ExecutorEffectUncertain);
    expect(effects).toBe(1);
  } finally { await f.close(); }
});
