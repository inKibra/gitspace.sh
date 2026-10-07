import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, receiptDigest, verifyReceipt, RuntimeAttachmentSchema, RuntimeToolDispatchSchema, RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { ExecutorJournal } from './journal.js';
import { MachineExecutor, type MachineExecutorOptions } from './executor.js';
import { ExecutorEffectUncertain } from './commands.js';
import { prepareV4APatch } from '@gitspace/protocol-runtime';
import { createHmac } from 'node:crypto';

async function fixture(onRun?: () => Promise<void>, hooks: Pick<MachineExecutorOptions, 'onBeforeExecute' | 'onMutationSettled'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-executor-'));
  const journal = new ExecutorJournal(join(root, 'journal.sqlite'));
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 7, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['write', 'bash'], updatedAt: new Date().toISOString() });
  journal.installAttachment({ attachment, rootPath: root, executionSecret: Buffer.alloc(32, 7).toString('base64url'), prerequisitesComplete: true });
  let launches = 0;
  const executor = new MachineExecutor({ machineId: 'machine', journal, ...hooks, runCommand: async () => { launches++; await onRun?.(); return { exitCode: 0, output: 'effect' }; }, artifacts: () => ({ read: async () => [], write: async () => {} }) });
  const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, conversationKind: 'main', conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 7, requestId: 'request', attemptId: 'attempt', tool: 'bash', args: { command: 'effect' }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
  return { root, journal, executor, dispatch, launches: () => launches, close: async () => { journal.close(); await rm(root, { recursive: true, force: true }); } };
}
describe('executor effect ownership', () => {
  test('subagent dispatch cannot write or execute commands even with attachment capability', async () => {
    const f = await fixture();
    try {
      const write = { ...f.dispatch, conversationKind: 'subagent' as const, tool: 'write', args: { path: 'forged.txt', content: 'unauthorized' } };
      await expect(f.executor.execute(write)).rejects.toThrow('Subagent');
      expect(await Bun.file(join(f.root, 'forged.txt')).exists()).toBe(false);
      await expect(f.executor.execute({ ...f.dispatch, conversationKind: 'subagent' as const })).rejects.toThrow('Subagent');
      expect(f.launches()).toBe(0);
    } finally { await f.close(); }
  }, 5000);
  test('checkpoint executes inside the checkout queue and returns only accepted evidence', async () => {
    const admitted = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/test/1', headCommit: '1'.repeat(40), branch: 'main', indexCommit: '2'.repeat(40), trackedWorktreeCommit: '3'.repeat(40), worktreeCommit: '4'.repeat(40), indexTree: '5'.repeat(40), worktreeTree: '6'.repeat(40) });
    const f = await fixture(undefined, { onMutationSettled: async () => { admitted.resolve(); await accepted.promise; return checkpoint; } });
    try {
      const local = f.journal.attachment('attachment');
      if (!local) throw new Error('Missing fixture attachment');
      f.journal.installAttachment({ ...local, attachment: { ...local.attachment, capabilities: [...local.attachment.capabilities, 'checkpoint'] } });
      const dispatch = { ...f.dispatch, tool: 'checkpoint', args: {} };
      const result = f.executor.execute(dispatch);
      await admitted.promise;
      expect(f.journal.attempt(dispatch.attemptId)?.result).toBeNull();
      accepted.resolve();
      expect((await result).content).toEqual([{ type: 'text', text: JSON.stringify({ checkpoint }) }]);
      expect(f.launches()).toBe(0);
    } finally { accepted.resolve(); await f.close(); }
  });
  test('lost publication reconciles durable output without replaying the command', async () => {
    let offline = true;
    const f = await fixture(undefined, { onMutationSettled: async () => { if (offline) throw new Error('offline'); return null; } });
    try {
      await expect(f.executor.execute(f.dispatch)).rejects.toBeInstanceOf(ExecutorEffectUncertain);
      expect(f.journal.attempt(f.dispatch.attemptId)?.result).toBeNull();
      expect(f.launches()).toBe(1);
      offline = false;
      const receipt = await f.executor.observe(f.dispatch);
      expect(receipt.receipt.state).toBe('terminal');
      expect((await f.executor.execute(f.dispatch)).content).toEqual([{ type: 'text', text: 'Exit code: 0\neffect' }]);
      expect(f.launches()).toBe(1);
    } finally { await f.close(); }
  });
  test('command waits for replica catch-up and accepted publication', async () => {
    const caughtUp = Promise.withResolvers<void>(), accepted = Promise.withResolvers<void>(), published = Promise.withResolvers<void>();
    const f = await fixture(undefined, { onBeforeExecute: async () => caughtUp.promise, onMutationSettled: async () => { published.resolve(); await accepted.promise; return null; } });
    try {
      const result = f.executor.execute(f.dispatch);
      expect(f.launches()).toBe(0);
      caughtUp.resolve();
      await published.promise;
      expect(f.journal.attempt(f.dispatch.attemptId)?.result).toBeNull();
      accepted.resolve();
      expect((await result).status).toBe('completed');
      expect(f.launches()).toBe(1);
    } finally { caughtUp.resolve(); accepted.resolve(); await f.close(); }
  });
  test('duplicate unsafe dispatch shares one effect and result', async () => {
    const f = await fixture();
    try { const [a, b] = await Promise.all([f.executor.execute(f.dispatch), f.executor.execute(f.dispatch)]); expect(a).toEqual(b); expect(f.launches()).toBe(1); await f.executor.execute(f.dispatch); expect(f.launches()).toBe(1); }
    finally { await f.close(); }
  });
  test('unresolved durable claim cannot launch after executor recovery', async () => {
    const f = await fixture();
    try { f.journal.begin(f.dispatch); await expect(f.executor.execute(f.dispatch)).rejects.toThrow('Prior claim'); expect((await f.executor.observe(f.dispatch)).receipt.state).toBe('unknown'); expect(f.launches()).toBe(0); }
    finally { await f.close(); }
  });
  test('stale generation and mutated attempt identity fail before effects', async () => {
    const f = await fixture();
    try { await expect(f.executor.execute({ ...f.dispatch, generation: 6 })).rejects.toThrow(); f.journal.begin(f.dispatch); await expect(f.executor.execute({ ...f.dispatch, args: { command: 'different' } })).rejects.toThrow(); expect(f.launches()).toBe(0); }
    finally { await f.close(); }
  });
  test('terminal receipt survives cold journal reopen and rejects changed scope or forged output', async () => {
    const f = await fixture();
    try {
      await f.executor.execute(f.dispatch);
      const envelope = await f.executor.observe(f.dispatch);
      const secret = f.journal.attachment(f.dispatch.attachmentId)!.executionSecret;
      const reopened = new ExecutorJournal(join(f.root, 'journal.sqlite'));
      try { expect(reopened.attempt(f.dispatch.attemptId)?.receipt).toEqual(envelope); } finally { reopened.close(); }
      expect((await verifyReceipt(f.dispatch, envelope, secret)).state).toBe('terminal');
      await expect(verifyReceipt({ ...f.dispatch, taskId: 'other-task' }, envelope, secret)).rejects.toThrow();
      const forged = structuredClone(envelope);
      if (forged.receipt.state !== 'terminal') throw new Error('Expected terminal');
      forged.receipt.result.content = [{ type: 'text', text: 'forged' }];
      await expect(verifyReceipt(f.dispatch, forged, secret)).rejects.toThrow();
      expect(f.launches()).toBe(1);
    } finally { await f.close(); }
  });
  test('running cancellation retains interrupted status while waiting for snapshot acceptance', async () => {
    const launched = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const publishing = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const f = await fixture(
      async () => { launched.resolve(); await stopped.promise; throw new Error('Command canceled; process tree stopped'); },
      { onMutationSettled: async () => { publishing.resolve(); await accepted.promise; return null; } },
    );
    const running = f.executor.execute(f.dispatch);
    try {
      await launched.promise;
      const raw = JSON.stringify({ op: 'cancel', dispatch: f.dispatch });
      const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(raw).digest('base64url');
      const response = await f.executor.fetch(new Request('http://executor/runtime/receipt', { method: 'POST', body: raw, headers: { 'x-gitspace-execution-signature': signature } }));
      expect(response.status).toBe(200);
      stopped.resolve();
      await publishing.promise;
      expect(f.journal.attempt(f.dispatch.attemptId)?.result).toBeNull();
      accepted.resolve();
      expect((await running).status).toBe('interrupted');
      const receipt = await f.executor.observe(f.dispatch);
      if (receipt.receipt.state !== 'terminal') throw new Error('Canceled command has no terminal receipt');
      expect(receipt.receipt.result.status).toBe('interrupted');
      expect(f.launches()).toBe(1);
    } finally { stopped.resolve(); accepted.resolve(); await running; await f.close(); }
  });
  test('signed cancellation durably fences delayed dispatch and acknowledgements are retryable', async () => {
    const f = await fixture();
    const send = async (body: unknown) => {
      const raw = JSON.stringify(body);
      const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(raw).digest('base64url');
      return f.executor.fetch(new Request('http://executor/runtime/receipt', { method: 'POST', body: raw, headers: { 'x-gitspace-execution-signature': signature } }));
    };
    try {
      expect((await send({ op: 'cancel', dispatch: f.dispatch })).status).toBe(200);
      expect((await f.executor.observe(f.dispatch)).receipt.state).toBe('fenced-not-started');
      await expect(f.executor.execute(f.dispatch)).rejects.toThrow();
      expect(f.launches()).toBe(0);
      const second = { ...f.dispatch, attemptId: 'second', requestId: 'second' };
      await f.executor.execute(second);
      const envelope = await f.executor.observe(second);
      const acknowledgement = { version: 1, receiptId: envelope.receipt.receiptId, dispatch: envelope.receipt.dispatch, receiptDigest: await receiptDigest(envelope.receipt), acknowledgedAt: new Date().toISOString() };
      expect((await send({ op: 'ack', dispatch: second, acknowledgement: { ...acknowledgement, receiptDigest: '0'.repeat(64) } })).status).toBe(409);
      for (let i = 0; i < 2; i++) expect((await send({ op: 'ack', dispatch: second, acknowledgement })).status).toBe(200);
      expect(f.journal.attempt(second.attemptId)?.acknowledged).toBe(true);
      expect(f.launches()).toBe(1);
    } finally { await f.close(); }
  });
  test('queued cancellation remains fenced after predecessor drains and repeated observation', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(async () => { started.resolve(); await release.promise; });
    const first = f.executor.execute(f.dispatch);
    let queued: Promise<unknown> | undefined;
    try {
      await started.promise;
      const second = { ...f.dispatch, requestId: 'queued-request', attemptId: 'queued-attempt' };
      queued = f.executor.execute(second).catch(error => error);
      expect(f.journal.attempt(second.attemptId)?.state).toBe('starting');
      const raw = JSON.stringify({ op: 'cancel', dispatch: second });
      const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(raw).digest('base64url');
      const response = await f.executor.fetch(new Request('http://executor/runtime/receipt', { method: 'POST', body: raw, headers: { 'x-gitspace-execution-signature': signature } }));
      expect(response.status).toBe(200);
      expect((await f.executor.observe(second)).receipt.state).toBe('fenced-not-started');
      release.resolve();
      await first;
      expect(await queued).toBeInstanceOf(Error);
      expect(() => f.journal.settle(second, { requestId: second.requestId, attemptId: second.attemptId, status: 'failed', content: [], error: { code: 'cancelled', message: 'Cancelled before launch' } })).toThrow('launch fence');
      for (let index = 0; index < 3; index++) {
        expect((await f.executor.observe(second)).receipt.state).toBe('fenced-not-started');
        await expect(f.executor.execute(second)).rejects.toThrow('Prior claim');
      }
      expect(f.journal.attempt(second.attemptId)?.state).toBe('fenced');
      expect(f.journal.attempt(second.attemptId)?.result).toBeNull();
      expect(f.launches()).toBe(1);
    } finally {
      release.resolve();
      await first.catch(() => {});
      await queued;
      await f.close();
    }
  });
  test('uncertain supervisor evidence fences queued and cold successor effects', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(async () => {
      started.resolve();
      await release.promise;
      throw new ExecutorEffectUncertain('Supervisor evidence unavailable');
    });
    const first = f.executor.execute(f.dispatch).catch(error => error);
    let queued: Promise<unknown> | undefined;
    try {
      await started.promise;
      const second = { ...f.dispatch, requestId: 'queued-request', attemptId: 'queued-attempt' };
      queued = f.executor.execute(second).catch(error => error);
      release.resolve();
      expect(await first).toBeInstanceOf(ExecutorEffectUncertain);
      expect(await queued).toBeInstanceOf(ExecutorEffectUncertain);
      expect((await f.executor.observe(second)).receipt.state).toBe('fenced-not-started');
      const third = { ...f.dispatch, requestId: 'later-request', attemptId: 'later-attempt' };
      await expect(f.executor.execute(third)).rejects.toThrow('Unresolved checkout execution');
      const recovered = new MachineExecutor({ machineId: 'machine', journal: f.journal, runCommand: async () => { throw new Error('Cold executor must not launch'); }, artifacts: () => ({ read: async () => [], write: async () => {} }) });
      const fourth = { ...f.dispatch, requestId: 'cold-request', attemptId: 'cold-attempt' };
      await expect(recovered.execute(fourth)).rejects.toThrow('Unresolved checkout execution');
      expect((await recovered.observe(fourth)).receipt.state).toBe('fenced-not-started');
      expect(f.journal.attempt(f.dispatch.attemptId)?.state).toBe('running');
      expect(f.journal.attempt(f.dispatch.attemptId)?.result).toBeNull();
      expect(f.launches()).toBe(1);
    } finally {
      release.resolve();
      await first;
      await queued;
      await f.close();
    }
  });
  test('canonical fingerprints use UTF-16 ordering and reject invalid JSON primitives', () => {
    expect(canonicalJson({ '\u20ac': 1, '\r': 2, '\u0080': 3, '1': 4 })).toBe('{\"\\r\":2,\"1\":4,\"\u0080\":3,\"\u20ac\":1}');
    expect(() => canonicalJson('\ud800')).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});
test('V4A validates all hunks and preserves original-relative multi-hunk edits', async () => {
  const files = { read: async () => 'a\nb\nc\nd\n', exists: async () => true };
  const changes = await prepareV4APatch('*** Begin Patch\n*** Update File: x\n@@\n a\n-b\n+B\n@@\n c\n-d\n+D\n*** End of File\n*** End Patch', files);
  expect(changes[0]?.after).toBe('a\nB\nc\nD\n');
  await expect(prepareV4APatch('*** Begin Patch\n*** Update File: x\n@@\n-missing\n+new\n*** End Patch', files)).rejects.toThrow();
});
