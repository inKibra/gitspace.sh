import { defineDoc, defineTask, GenerationTask, InboxDoc, LiveDoc, type ModelRef, type TaskId, type TaskRuntime, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import { RuntimeDispatchSelectionSchema, RuntimeJobAcceptanceSchema, RuntimeJobHandleSchema, RuntimeJobObservationSchema, type RuntimeJobAcceptance, type RuntimeJobObservation, type RuntimeExecutorReceipt } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import type { OperationalServices } from './tasks.js';
import type { ModelSelectionIntent } from '@gitspace/protocol-runtime/session-controls';

export type JobServices = OperationalServices & {
  admitInference(input: { conversationId: string; requestId: string; parentConversationId?: string; selection?: ModelSelectionIntent }): Promise<ModelRef>;
};

type JobRecord = { acceptance: RuntimeJobAcceptance; observation: RuntimeJobObservation; args: JsonValue; fingerprint: string; spawningTask: TaskId; deadlineAt: string; attemptId: string; cancelRequested: boolean; delivered: boolean };
type JobInput = { key: string; spawningTask: TaskId };
type JobState = { phase: 'execute'; poll: number };
export const DurableJobsDoc = defineDoc<{ records: Record<string, JobRecord> }>({ kind: 'gitspace.durable-jobs', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ records: {} }) });
const runSchema = RuntimeDispatchSelectionSchema.extend({ op: z.literal('run'), application: z.string().min(1), args: z.array(z.string()), cwd: z.string().optional(), deadlineAt: z.iso.datetime().optional() }).strict();
const controlSchema = z.discriminatedUnion('op', [z.object({ op: z.literal('list') }).strict(), z.object({ op: z.enum(['status', 'wait', 'logs', 'cancel']), job: RuntimeJobHandleSchema }).strict()]);
export function createJobTask(services: JobServices) {
  async function drive(key: string, runtime: TaskRuntime<JobInput, JobState, RuntimeJobObservation, {}>, context: Context, aborting: boolean) {
    for (;;) {
      const document = await runtime.snapshot(DurableJobsDoc, runtime.conversationId, context);
      const record = document?.records[key];
      if (!record || record.acceptance.job.taskId !== String(runtime.taskId) || record.acceptance.job.conversationId !== String(runtime.conversationId)) throw new Error('Durable job ownership mismatch');
      const job = record.acceptance.job;
      const now = new Date(runtime.now()).toISOString();
      const alreadySettled = record.observation.status === 'terminal' || record.observation.status === 'not-started';
      let observation: RuntimeJobObservation = alreadySettled ? record.observation : { status: 'waiting', job, reason: 'reconciliation', observedAt: now };
      if (!alreadySettled) try {
        const spawn = aborting ? null : await runtime.waitForTask(record.spawningTask, context);
        let receipt = await services.reconcile(record.attemptId);
        const cancel = aborting || record.cancelRequested;
        if (receipt === null && (cancel || spawn?.state.outcome.status !== 'completed' || Date.parse(record.deadlineAt) <= runtime.now())) {
          // The service contract reserves null for positive evidence of no admitted dispatch.
          observation = { status: 'not-started', job, reason: cancel ? 'cancelled' : spawn?.state.outcome.status !== 'completed' ? 'admission-failed' : 'deadline', completedAt: now };
        } else {
          if (cancel && receipt !== null) { await services.cancel(record.attemptId); receipt = await services.reconcile(record.attemptId); }
          if (receipt === null && !cancel) {
            const result = await services.execute({ kind: 'Job', args: record.args, requestId: job.requestId, attemptId: record.attemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), deadlineAt: record.deadlineAt, replay: 'unsafe', signal: runtime.signal });
            receipt = await services.reconcile(record.attemptId);
            if (receipt === null && result.status !== 'completed') observation = { status: 'not-started', job, reason: result.status === 'failed' ? 'admission-failed' : 'deadline', completedAt: new Date(runtime.now()).toISOString(), ...(result.status === 'failed' ? { message: result.error.message } : {}) };
          }
          if (receipt && 'state' in receipt) {
            const scoped: RuntimeExecutorReceipt = receipt;
            if (scoped.state === 'terminal') observation = { status: 'terminal', job, receipt: scoped, completedAt: scoped.completedAt };
            else if (scoped.state === 'fenced-not-started') observation = { status: 'not-started', job, reason: cancel ? 'cancelled' : 'fenced', completedAt: scoped.evidence.recordedAt };
            else if (scoped.state === 'running' || scoped.state === 'starting') observation = cancel ? { status: 'waiting', job, reason: 'reconciliation', observedAt: now } : { status: 'executing', job, dispatch: scoped.dispatch, observedAt: scoped.observedAt };
          }
        }
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        // Unauthenticated or missing transport evidence is never a terminal job result.
      }
      observation = RuntimeJobObservationSchema.parse(observation);
      const settled = observation.status === 'terminal' || observation.status === 'not-started';
      const completionRequestId = `job-completion:${job.jobId}`;
      let continuationReady = true;
      if (settled && !record.delivered && !aborting) {
        try {
          await services.admitInference({ conversationId: String(runtime.conversationId), parentConversationId: String(runtime.conversationId), requestId: completionRequestId });
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          runtime.report(error);
          continuationReady = false;
        }
      }
      await runtime.commit(async tx => {
        const doc = await tx.doc(DurableJobsDoc, runtime.conversationId);
        const current = doc.records[key];
        current.observation = observation;
        if (aborting) current.cancelRequested = true;
        if (settled && continuationReady && !current.delivered) {
          const live = await tx.doc(LiveDoc, runtime.conversationId);
          const content = `Background job completion:\n${JSON.stringify(observation)}`;
          if (aborting) {
            // Stopping a conversation must not start another foreground run.
            await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.job-completed', data: observation, model: [{ role: 'user', content, timestamp: runtime.now() }] });
          } else if (live.run) {
            // Follow-ups are placed at the foreground run's final boundary, never mid-tool round.
            const inbox = await tx.doc(InboxDoc, runtime.conversationId);
            const write = await tx.createSubmission({ conversationId: runtime.conversationId, type: 'write', status: 'queued' });
            inbox.items.push({ id: write.id, mode: 'write', entry: { kind: 'gitspace.job-completed', data: observation } });
            const input = await tx.createSubmission({ conversationId: runtime.conversationId, requestId: completionRequestId, type: 'input', status: 'queued' });
            inbox.items.push({ id: input.id, mode: 'followUp', content });
          } else {
            const entry = await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.job-completed', data: observation, model: [{ role: 'user', content, timestamp: runtime.now() }] });
            const input = await tx.createSubmission({ conversationId: runtime.conversationId, requestId: completionRequestId, type: 'input', status: 'placed', entry: entry.id });
            const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: 'conversation' }, conversationId: runtime.conversationId });
            live.run = { taskId, inputs: [input.id] };
          }
          current.delivered = true;
        }
        if (!current.delivered) return { status: 'running', checkpoint: { phase: 'execute', poll: runtime.now() } };
        if (observation.status === 'not-started') return { status: 'terminal', outcome: observation.reason === 'cancelled'
          ? { status: 'aborted', reason: 'Cancelled before execution', result: observation }
          : { status: 'failed', error: { message: observation.message ?? `Job did not start: ${observation.reason}` }, result: observation } };
        if (observation.status === 'terminal') return { status: 'terminal', outcome: observation.receipt.result.status === 'completed'
          ? { status: 'completed', result: observation }
          : observation.receipt.result.status === 'failed'
            ? { status: 'failed', error: { message: observation.receipt.result.error.message }, result: observation }
            : { status: 'aborted', reason: 'Executor attempt interrupted', result: observation } };
        return { status: 'running', checkpoint: { phase: 'execute', poll: runtime.now() } };
      }, context);
      if (settled && continuationReady) return;
      const next = runtime.now() + 1000; await services.wakeAt(next); await runtime.sleep(next, context);
    }
  }
  return defineTask<JobInput, JobState, RuntimeJobObservation>({
    name: 'gitspace.Job', version: 1, initial: () => ({ phase: 'execute', poll: 0 }),
    phases: { async execute(task, runtime, context) { await drive(task.input.key, runtime, context, false); } },
    async abort(task, runtime, context) { await drive(task.input.key, runtime, context, true); },
  });
}
export function createJobTool(services: JobServices) {
  const task = createJobTask(services);
  return async (input: JsonValue, api: ToolExecutionApi, context: Context): Promise<JsonValue> => {
    if (input && typeof input === 'object' && !Array.isArray(input) && input.op === 'run') {
      const args = runSchema.parse(input);
      const fingerprint = JSON.stringify(args);
      const scope = services.jobScope();
      const admissionId = String(api.taskId);
      const acceptance = await api.commit(async tx => {
        const doc = await tx.doc(DurableJobsDoc, api.conversationId);
        const existing = doc.records[admissionId];
        if (existing) { if (existing.acceptance.job.conversationId !== String(api.conversationId) || existing.fingerprint !== fingerprint) throw new Error('Job admission request changed'); return existing.acceptance; }
        const id = await tx.createTask(task, { key: admissionId, spawningTask: api.taskId }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
        const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date().toISOString(), job: { ...scope, jobId: `job:${id}`, taskId: String(id), conversationId: String(api.conversationId), requestId: `task:${id}` } });
        doc.records[admissionId] = { acceptance, observation: acceptance, args, fingerprint, spawningTask: api.taskId, deadlineAt: args.deadlineAt ?? new Date(Date.now() + 86_400_000).toISOString(), attemptId: `task:${id}`, cancelRequested: false, delivered: false };
        return acceptance;
      }, context);
      await services.wakeAt(Date.now());
      return acceptance;
    }
    const args = controlSchema.parse(input);
    const document = await api.snapshot(DurableJobsDoc, api.conversationId, context);
    const records = Object.values(document?.records ?? {}).filter(record => record.acceptance.job.conversationId === String(api.conversationId));
    if (args.op === 'list') return records.slice(-100).map(record => RuntimeJobObservationSchema.parse(record.observation));
    const record = records.find(record => JSON.stringify(record.acceptance.job) === JSON.stringify(args.job));
    if (!record) throw new Error('Job handle does not belong to this conversation');
    if (args.op === 'logs') return services.controlJob({ attemptId: record.attemptId, op: 'logs' });
    if (args.op === 'cancel' && record.observation.status !== 'terminal' && record.observation.status !== 'not-started') {
      const observation = RuntimeJobObservationSchema.parse({ status: 'waiting', job: record.acceptance.job, reason: 'reconciliation', observedAt: new Date().toISOString() });
      await api.commit(async tx => { const doc = await tx.doc(DurableJobsDoc, api.conversationId); const current = Object.values(doc.records).find(value => value.attemptId === record.attemptId); if (!current) throw new Error('Job missing'); current.cancelRequested = true; if (current.observation.status !== 'terminal' && current.observation.status !== 'not-started') current.observation = observation; }, context);
      // Durable cancellation intent is retried until exit or a launch barrier is proven.
      try { await services.cancel(record.attemptId); } catch { /* Unknown is not cancelled. */ }
      await services.wakeAt(Date.now());
      return observation;
    }
    // wait returns the current bounded observation; it never occupies a foreground generation until exit.
    return RuntimeJobObservationSchema.parse(record.observation);
  };
}
