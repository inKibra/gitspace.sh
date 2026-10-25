import { expect, test } from 'vitest';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { RuntimeJobAcceptanceSchema } from '@gitspace/protocol-runtime';
import { DurableJobsDoc, createJobTask, type JobServices } from './jobs.js';

const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
/** The tool call that admitted the job; it has returned. */
const Spawn = defineTask<null, { phase: 'run' }, null>({ name: 'proof.Spawn', version: 1, initial: () => ({ phase: 'run' }), phases: { async run(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx); } }, async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });

/** A background command whose outcome reads fail `failures` times, or for good; the clock moves only when the alarm the
 * job asks for fires. */
async function fixture(failures: number) {
  let now = Date.now();
  let reads = 0;
  const delays: number[] = [];
  const reports: string[] = [];
  const delivered: Parameters<JobServices['deliverConversationEvent']>[0][] = [];
  const task = createJobTask({
    execute: unused, cancel: unused, jobScope: unused, controlJob: unused, observeProcess: unused, stopProcess: unused,
    async reconcile(attemptId) {
      if (++reads <= failures) throw new Error('Machine unreachable');
      return { status: 'completed', requestId: attemptId, attemptId, content: [{ type: 'text', text: 'built' }] };
    },
    async wakeAt(at) { delays.push(at - now); now = at; },
    async deliverConversationEvent(input) { delivered.push(input); },
  });
  const registry = createRegistry(); registry.install(defineExtension({ name: 'jobs', tasks: [task, Spawn] }));
  const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels(), now: () => now, onReport: error => { reports.push(error instanceof Error ? error.message : String(error)); } }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const id = await root.commit(async tx => {
    const spawn = await tx.createTask(Spawn, null, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true });
    const id = await tx.createTask(task, { key: 'job', spawningTask: spawn }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true });
    const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date(now).toISOString(), job: { projectId: 'project', workspaceId: 'workspace', jobId: `job:${id}`, taskId: String(id), conversationId: String(root.id), requestId: `task:${id}` } });
    (await tx.doc(DurableJobsDoc, root.id)).records.job = { acceptance, observation: acceptance, args: { command: 'make build', background: true }, fingerprint: 'job', spawningTask: spawn, deadlineAt: new Date(now + 86_400_000).toISOString(), attemptId: `task:${id}`, cancelRequested: false, delivered: false };
    return id;
  }, BACKGROUND_CONTEXT);
  harness.resume();
  return { harness, id, delays, reports, delivered };
}

test('a background command whose outcome cannot be read is retried on a doubling backoff, then ends interrupted and the conversation is told', async () => {
  const f = await fixture(Infinity);
  try {
    const settled = await f.harness.waitForTask(f.id, withAbortSignal(AbortSignal.timeout(4000), BACKGROUND_CONTEXT));
    expect(settled.state.outcome).toMatchObject({ status: 'aborted', reason: 'Executor attempt interrupted' });
    expect(f.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
    expect(f.delivered.map(event => event.text)).toEqual([expect.stringContaining('interrupted:\nIts outcome could not be read after 12 tries: Machine unreachable')]);
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});

test('a read that succeeds after failures ends the backoff with the command\'s result', async () => {
  const f = await fixture(3);
  try {
    const settled = await f.harness.waitForTask(f.id, withAbortSignal(AbortSignal.timeout(4000), BACKGROUND_CONTEXT));
    expect(settled.state.outcome.status).toBe('completed');
    expect(f.delays).toEqual([1_000, 2_000, 4_000]);
    expect(f.delivered.map(event => event.text)).toEqual([expect.stringContaining('completed:\nbuilt')]);
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});
