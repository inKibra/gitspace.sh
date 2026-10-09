import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '@gitspace/runtime-workspace-do';
import { dispatchIdentity, sealReceipt, RuntimeAttachInputSchema, RuntimeHeartbeatInputSchema, RuntimeReceiptControlSchema, RuntimeReceiptTransportSchema, RuntimeToolDispatchSchema, type RuntimeReceiptTransport } from '@gitspace/protocol-runtime';

async function pausedCache(state: DurableObjectState) {
  const peer: { receipt?: RuntimeReceiptTransport; onObserve?: () => void } = {};
  const store = new AttachmentStore(state.storage, {
    seal: async secret => secret, open: async secret => secret,
    dispatch: async input => {
      const control = RuntimeReceiptControlSchema.parse(JSON.parse(input.body));
      if (control.op === 'observe') peer.onObserve?.();
      if (!peer.receipt) throw new Error('Receipt peer has no evidence');
      return peer.receipt;
    },
  });
  const grant = await store.attach(RuntimeAttachInputSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 0, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'] }));
  const ready = store.ready({ ...grant.attachment, commit: 'a'.repeat(40), prerequisitesComplete: true }, 'a'.repeat(40)).attachment;
  const now = new Date().toISOString();
  const attachment = store.heartbeat(RuntimeHeartbeatInputSchema.parse({ ...ready, cache: { ...ready.cache, state: 'paused', pausedAt: now }, executionObservation: { activeExecutions: 0, observedAt: now, materializedCommit: 'a'.repeat(40) } }));
  const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, conversationKind: 'main', conversationId: 'conversation', taskId: 'task', projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, requestId: 'request', attemptId: 'stopped-attempt', tool: 'bash', args: { command: 'sleep 300' }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
  // The dispatch committed before its foreground caller stopped observing the result.
  state.storage.sql.exec("INSERT INTO runtime_attempts(id,dispatch,status) VALUES(?,?,'dispatched')", dispatch.attemptId, JSON.stringify(dispatch));
  const identity = await dispatchIdentity(dispatch);
  const terminal = await sealReceipt(dispatch, { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'interrupted', content: [{ type: 'text', text: 'Process terminated after cancellation' }] }, grant.executionSecret);
  peer.receipt = RuntimeReceiptTransportSchema.parse({ receipt: { version: 1, receiptId: 'pending', dispatch: identity, observedAt: now, state: 'unknown', reason: 'unreachable' } });
  return { store, attachment, dispatch, identity, terminal, peer, now };
}

describe('paused cache execution receipt recovery', () => {
  it.each(['starting', 'running'] as const)('settles cancellation after the executor initially reports %s', async phase => {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName('cache-recovery'), async (_instance, state) => {
      const f = await pausedCache(state);
      f.peer.receipt = RuntimeReceiptTransportSchema.parse({ receipt: { version: 1, receiptId: 'pending', dispatch: f.identity, observedAt: f.now, state: phase, ...(phase === 'starting' ? { claimedAt: f.now } : { startedAt: f.now }) } });
      f.peer.onObserve = () => { f.peer.receipt = f.terminal; };
      expect((await f.store.cancel(f.dispatch, AbortSignal.timeout(5000))).state).toBe('terminal');
      expect(f.store.getAttempt(f.dispatch.attemptId)?.status).toBe('interrupted');
      expect((await f.store.requestCacheAction({ ...f.attachment, requestId: 'resume', action: { kind: 'setup' } })).attachment.cacheAction?.status).toBe('requested');
    });
  });

  it('refuses unknown and running effects, then resumes only after authentic terminal evidence', async () => {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName('cache-recovery'), async (_instance, state) => {
      const f = await pausedCache(state);
      const input = { ...f.attachment, requestId: 'resume', action: { kind: 'setup' as const } };
      await expect(f.store.requestCacheAction(input)).rejects.toThrow('Unresolved execution prevents cache setup');
      f.peer.receipt = RuntimeReceiptTransportSchema.parse({ receipt: { version: 1, receiptId: 'pending', dispatch: f.identity, observedAt: f.now, state: 'running', startedAt: f.now } });
      await expect(f.store.requestCacheAction(input)).rejects.toThrow('Unresolved execution prevents cache setup');
      expect(f.store.list()[0]?.cache?.state).toBe('paused');
      expect(f.store.getAttempt(f.dispatch.attemptId)?.status).toBe('dispatched');
      f.peer.receipt = f.terminal;
      const resumed = await f.store.requestCacheAction(input);
      expect(resumed.attachment.cache?.state).toBe('setup');
      expect(f.store.getAttempt(f.dispatch.attemptId)?.status).toBe('interrupted');
    });
  });

  it('does not overwrite a cache drain that begins during receipt reconciliation', async () => {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName('cache-recovery'), async (_instance, state) => {
      const f = await pausedCache(state);
      f.peer.receipt = f.terminal;
      f.peer.onObserve = () => { f.store.detach({ ...f.attachment, state: 'draining' }); };
      await expect(f.store.requestCacheAction({ ...f.attachment, requestId: 'resume', action: { kind: 'setup' } })).rejects.toThrow('Cache detach must finish');
      expect(f.store.list()[0]?.state).toBe('draining');
      expect(f.store.getAttempt(f.dispatch.attemptId)?.status).toBe('interrupted');
    });
  });
});
