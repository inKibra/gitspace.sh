import { defineDoc, defineTask, type TaskId, type TaskRuntime, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import { awaitWithContext } from '@earendil-works/chord/context';
import { RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema, RuntimeProcArgumentsSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema, RuntimeToolResultSchema, receiptDigest, type RuntimeToolResult, type RuntimeJobAcceptance, type RuntimeJobObservation } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { DaemonResponseSchema } from '@gitspace/supervisor/protocol';
import type { OperationalServices } from './tasks.js';
import { ConversationLifecycleDoc } from './conversation-lifecycle.js';

export type JobServices = OperationalServices & {
  deliverConversationEvent(input: { conversationId: string; requestId: string; kind: 'command-completed' | 'process-exited'; text: string; payload?: JsonValue }): Promise<void>;
};

type JobRecord = { acceptance: RuntimeJobAcceptance; observation: RuntimeJobObservation; args: JsonValue; fingerprint: string; spawningTask: TaskId; deadlineAt: string; attemptId: string; cancelRequested: boolean; delivered: boolean };
type JobInput = { key: string; spawningTask: TaskId };
type JobState = { phase: 'execute'; poll: number };
export const DurableJobsDoc = defineDoc<{ records: Record<string, JobRecord> }>({ kind: 'gitspace.durable-jobs', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ records: {} }) });
const OlderObservationSchema = z.object({ status: z.string(), receipt: z.object({ result: RuntimeToolResultSchema }).optional(), completedAt: z.iso.datetime().optional() });
/** A stored observation, upgraded when it predates tool results replacing executor receipts: a finished job carried
 * its result in `receipt`, a running one was `executing`, and a prevented launch was `not-started` with `fenced`. */
function storedObservation(value: unknown, job: RuntimeJobAcceptance['job']): RuntimeJobObservation {
  const current = RuntimeJobObservationSchema.safeParse(value);
  if (current.success) return current.data;
  const older = OlderObservationSchema.safeParse(value);
  const at = older.data?.completedAt ?? new Date().toISOString();
  if (older.data?.status === 'terminal' && older.data.receipt) return { status: 'terminal', job, result: older.data.receipt.result, completedAt: at };
  if (older.data?.status === 'not-started') return { status: 'not-started', job, reason: 'admission-failed', completedAt: at, message: 'The executor prevented the launch' };
  return { status: 'waiting', job, reason: 'reconciliation', observedAt: at };
}
export function createJobTask(services: JobServices) {
  async function drive(key: string, runtime: TaskRuntime<JobInput, JobState, RuntimeJobObservation, {}>, context: Context, aborting: boolean) {
    for (;;) {
      const document = await runtime.snapshot(DurableJobsDoc, runtime.conversationId, context);
      const record = document?.records[key];
      if (!record || record.acceptance.job.taskId !== String(runtime.taskId) || record.acceptance.job.conversationId !== String(runtime.conversationId)) throw new Error('Durable job ownership mismatch');
      const job = record.acceptance.job;
      const now = new Date(runtime.now()).toISOString();
      let observation = storedObservation(record.observation, job);
      if (observation.status !== 'terminal' && observation.status !== 'not-started') try {
        const spawn = aborting ? null : await runtime.waitForTask(record.spawningTask, context);
        const cancel = aborting || record.cancelRequested;
        if (cancel) await services.cancel(record.attemptId);
        const admitted = !cancel && spawn?.state.outcome.status === 'completed';
        const expired = Date.parse(record.deadlineAt) <= runtime.now();
        const result = await services.reconcile(record.attemptId)
          ?? (admitted && !expired ? await services.execute({ kind: 'Job', args: record.args, requestId: job.requestId, attemptId: record.attemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), deadlineAt: record.deadlineAt, replay: 'unsafe', signal: runtime.signal }) : null);
        observation = result ? { status: 'terminal', job, result, completedAt: now }
          : { status: 'not-started', job, reason: cancel ? 'cancelled' : admitted ? 'deadline' : 'admission-failed', completedAt: now };
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        // A failed reconciliation or dispatch is retried; it is never a terminal job result.
      }
      observation = RuntimeJobObservationSchema.parse(observation);
      const settled = observation.status === 'terminal' || observation.status === 'not-started';
      const completionRequestId = `job-completion:${job.jobId}`;
      let continuationReady = true;
      if ((observation.status === 'terminal' || observation.status === 'not-started') && !record.delivered) {
        try {
          const text = observation.status === 'terminal'
            ? `Background command ${observation.job.jobId} ${observation.result.status}${observation.result.status === 'failed' ? ` (${observation.result.error.message})` : ''}:\n${observation.result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')}`
            : `Background command ${observation.job.jobId} did not start (${observation.reason})${observation.message ? `: ${observation.message}` : ''}`;
          await services.deliverConversationEvent({ conversationId: String(runtime.conversationId), requestId: completionRequestId, kind: 'command-completed', text, payload: observation });
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
        if (settled && continuationReady) current.delivered = true;
        if (!current.delivered) return { status: 'running', checkpoint: { phase: 'execute', poll: runtime.now() } };
        if (observation.status === 'not-started') return { status: 'terminal', outcome: observation.reason === 'cancelled'
          ? { status: 'aborted', reason: 'Cancelled before execution', result: observation }
          : { status: 'failed', error: { message: observation.message ?? `Job did not start: ${observation.reason}` }, result: observation } };
        if (observation.status === 'terminal') return { status: 'terminal', outcome: observation.result.status === 'completed'
          ? { status: 'completed', result: observation }
          : observation.result.status === 'failed'
            ? { status: 'failed', error: { message: observation.result.error.message }, result: observation }
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

type ProcessExitInput = { originAttemptId: string; daemonId: string; restartCount: number; args: JsonValue };
type ProcessExitState = { phase: 'observe'; poll: number; restartCount: number };
export const ProcessWatchesDoc = defineDoc<{ tasks: Record<string, string> }>({ kind: 'gitspace.process-watches', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ tasks: {} }) });
export function createProcessExitTask(services: JobServices) {
  return defineTask<ProcessExitInput, ProcessExitState, JsonValue>({
    name: 'gitspace.ProcessExit', version: 1, initial: input => ({ phase: 'observe', poll: 0, restartCount: input.restartCount }),
    phases: { async observe(task, runtime, context) {
      let { poll, restartCount } = task.state.checkpoint;
      const args = RuntimeProcArgumentsSchema.parse(task.input.args);
      if (args.op !== 'status') throw new Error('Process watch has no admitted status identity');
      for (;;) {
        try {
          const requestId = `process-observation:${runtime.taskId}:${poll}`;
          const result = await services.observeProcess({ originAttemptId: task.input.originAttemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), requestId, attemptId: requestId, args: { ...args, restartCount } });
          const sha256 = await receiptDigest(result);
          await runtime.commit(async tx => {
            await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.executor-results', data: { results: [{ attemptId: result.attemptId, sha256 }] } });
            return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount } };
          }, context);
          if (result.status !== 'completed') throw new Error('Process observation unavailable');
          const text = result.content.find(item => item.type === 'text');
          if (!text || text.type !== 'text') throw new Error('Process observation missing');
          const response = DaemonResponseSchema.parse(JSON.parse(text.text));
          if (response.op !== 'describe' || response.daemon.id !== task.input.daemonId || response.daemon.restartCount !== restartCount) throw new Error('Process observation identity changed');
          if (response.daemon.state === 'exited' || response.daemon.state === 'failed') {
            await services.deliverConversationEvent({ conversationId: String(runtime.conversationId), requestId: `process-exited:${task.input.daemonId}:${restartCount}`, kind: 'process-exited', text: `Process exited:\n${JSON.stringify(response.daemon)}`, payload: response.daemon });
            if (response.daemon.nextRestartCount !== undefined) {
              if (response.daemon.nextRestartCount <= restartCount) throw new Error('Invalid process restart successor');
              restartCount = response.daemon.nextRestartCount;
              poll++;
              await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'observe', poll, restartCount } }), context);
              continue;
            }
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: response.daemon } }), context);
            return;
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          runtime.report(error);
        }
        poll++;
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'observe', poll, restartCount } }), context);
        const next = runtime.now() + 5000;
        await services.wakeAt(next); await runtime.sleep(next, context);
      }
    } },
    async abort(task, runtime, context) {
      const args = RuntimeProcArgumentsSchema.parse(task.input.args);
      if (args.op !== 'status') throw new Error('Process watch has no admitted status identity');
      let { poll, restartCount } = task.state.checkpoint;
      for (;;) {
        try {
          const requestId = `process-stop:${runtime.taskId}:${poll}`;
          const { restartCount: _originRestart, ...launch } = args;
          const result = await services.stopProcess({ originAttemptId: task.input.originAttemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), requestId, attemptId: requestId, args: { ...launch, op: 'stop', timeoutMs: 5000 } });
          const sha256 = await receiptDigest(result);
          await runtime.commit(async tx => {
            await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.executor-results', data: { results: [{ attemptId: result.attemptId, sha256 }] } });
            return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount } };
          }, context);
          if (result.status !== 'completed') throw new Error('Owned process stop remains unresolved');
          const text = result.content.find(item => item.type === 'text');
          if (!text || text.type !== 'text') throw new Error('Process stop observation missing');
          const response = DaemonResponseSchema.parse(JSON.parse(text.text));
          if (response.op !== 'stop' || response.daemon.id !== task.input.daemonId || (response.daemon.state !== 'exited' && response.daemon.state !== 'failed')) throw new Error('Owned process stop is not confirmed');
          for (; restartCount <= response.daemon.restartCount; restartCount++) {
            let exited = response.daemon;
            if (restartCount !== response.daemon.restartCount) {
              const requestId = `process-stop-observation:${runtime.taskId}:${restartCount}:${poll}`;
              const previous = await services.observeProcess({ originAttemptId: task.input.originAttemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), requestId, attemptId: requestId, args: { ...args, restartCount } });
              const sha256 = await receiptDigest(previous);
              await runtime.commit(async tx => {
                await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.executor-results', data: { results: [{ attemptId: previous.attemptId, sha256 }] } });
                return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount } };
              }, context);
              const text = previous.content.find(item => item.type === 'text');
              if (previous.status !== 'completed' || !text || text.type !== 'text') throw new Error('Previous process exit observation missing');
              const archived = DaemonResponseSchema.parse(JSON.parse(text.text));
              if (archived.op !== 'describe' || archived.daemon.id !== task.input.daemonId || archived.daemon.restartCount !== restartCount || (archived.daemon.state !== 'exited' && archived.daemon.state !== 'failed')) throw new Error('Previous process exit identity changed');
              exited = archived.daemon;
            }
            await services.deliverConversationEvent({ conversationId: String(runtime.conversationId), requestId: `process-exited:${task.input.daemonId}:${restartCount}`, kind: 'process-exited', text: `Process exited:\n${JSON.stringify(exited)}`, payload: exited });
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'observe', poll, restartCount: restartCount + 1 } }), context);
          }
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Conversation stopped', result: response.daemon } }), context);
          return;
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          runtime.report(error);
        }
        poll++;
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'observe', poll, restartCount } }), context);
        const next = runtime.now() + 1000;
        await services.wakeAt(next);
        await runtime.sleep(next, context);
      }
    },
  });
}
export async function watchProcessExit(services: JobServices, input: JsonValue, result: RuntimeToolResult, api: ToolExecutionApi, context: Context): Promise<void> {
  const args = RuntimeProcArgumentsSchema.parse(input);
  if ((args.op !== 'start' && args.op !== 'restart') || result.status !== 'completed') return;
  const text = result.content.find(item => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Process start receipt missing');
  const response = DaemonResponseSchema.parse(JSON.parse(text.text));
  if (response.op !== 'start' && response.op !== 'restart') throw new Error('Process start receipt invalid');
  const identity = `${response.daemon.id}:${response.daemon.restartCount}`;
  await api.commit(async tx => {
    const watches = await tx.doc(ProcessWatchesDoc, api.conversationId);
    if (watches.tasks[identity]) return;
    const task = await tx.createTask(createProcessExitTask(services), { originAttemptId: result.attemptId, daemonId: response.daemon.id, restartCount: response.daemon.restartCount, args: { op: 'status', name: response.daemon.name, instanceId: response.daemon.id, restartCount: response.daemon.restartCount, ...(args.on === undefined ? {} : { on: args.on }) } }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
    watches.tasks[identity] = String(task);
  }, context);
  await services.wakeAt(Date.now());
}
export function createJobTool(services: JobServices) {
  const task = createJobTask(services);
  return async (input: JsonValue, api: ToolExecutionApi, context: Context): Promise<JsonValue> => {
    if (input && typeof input === 'object' && !Array.isArray(input) && input.background === true) {
      const args = RuntimeBashCommandArgumentsSchema.parse(input);
      const fingerprint = JSON.stringify(args);
      const admissionId = String(api.taskId);
      const prior = (await api.snapshot(DurableJobsDoc, api.conversationId, context))?.records[admissionId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('Job admission request changed');
        await services.wakeAt(Date.now());
        return prior.acceptance;
      }
      const scope = await services.jobScope(args);
      const acceptance = await api.commit(async tx => {
        const doc = await tx.doc(DurableJobsDoc, api.conversationId);
        const existing = doc.records[admissionId];
        if (existing) { if (existing.acceptance.job.conversationId !== String(api.conversationId) || existing.fingerprint !== fingerprint) throw new Error('Job admission request changed'); return existing.acceptance; }
        const id = await tx.createTask(task, { key: admissionId, spawningTask: api.taskId }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
        const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date().toISOString(), job: { ...scope, jobId: `job:${id}`, taskId: String(id), conversationId: String(api.conversationId), requestId: `task:${id}` } });
        doc.records[admissionId] = { acceptance, observation: acceptance, args, fingerprint, spawningTask: api.taskId, deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), attemptId: `task:${id}`, cancelRequested: false, delivered: false };
        return acceptance;
      }, context);
      await services.wakeAt(Date.now());
      return acceptance;
    }
    const args = RuntimeBashControlArgumentsSchema.parse(input);
    const document = await api.snapshot(DurableJobsDoc, api.conversationId, context);
    const records = Object.values(document?.records ?? {}).filter(record => record.acceptance.job.conversationId === String(api.conversationId));
    if (args.op === 'list') return records.slice(-100).map(record => storedObservation(record.observation, record.acceptance.job));
    const record = records.find(record => JSON.stringify(record.acceptance.job) === JSON.stringify(args.job));
    if (!record) throw new Error('Job handle does not belong to this conversation');
    const stored = storedObservation(record.observation, record.acceptance.job);
    // A finished job the agent reads here is its answer: the completion message would only repeat it as a later turn.
    const consumeCompletion = async (observation: RuntimeJobObservation) => {
      if (observation.status !== 'terminal' && observation.status !== 'not-started') return;
      await api.commit(async tx => {
        const pending = (await tx.doc(ConversationLifecycleDoc, api.conversationId)).events.find(item => item.event.requestId === `job-completion:${observation.job.jobId}`);
        if (pending && !pending.delivered) pending.consumed = true;
      }, context);
    };
    if (args.op === 'logs') return services.controlJob({ attemptId: record.attemptId, op: 'logs', lines: args.lines, head: args.head, cursor: args.cursor });
    if (args.op === 'cancel' && stored.status !== 'terminal' && stored.status !== 'not-started') {
      const observation = RuntimeJobObservationSchema.parse({ status: 'waiting', job: record.acceptance.job, reason: 'reconciliation', observedAt: new Date().toISOString() });
      await api.commit(async tx => { const doc = await tx.doc(DurableJobsDoc, api.conversationId); const current = Object.values(doc.records).find(value => value.attemptId === record.attemptId); if (!current) throw new Error('Job missing'); current.cancelRequested = true; const status = storedObservation(current.observation, current.acceptance.job).status; if (status !== 'terminal' && status !== 'not-started') current.observation = observation; }, context);
      try { await services.cancel(record.attemptId); } catch { /* The job task retries the cancellation. */ }
      await services.wakeAt(Date.now());
      return observation;
    }
    if (args.op === 'wait' && stored.status !== 'terminal' && stored.status !== 'not-started') {
      const watch = await api.watchDoc(DurableJobsDoc, api.conversationId, context);
      if (!watch) throw new Error('Durable command observation missing');
      let observation: RuntimeJobObservation = stored;
      const settled = Promise.withResolvers<void>();
      const observe = (value: typeof watch.value) => {
        const current = Object.values(value?.records ?? {}).find(item => item.acceptance.job.jobId === record.acceptance.job.jobId);
        if (!current) throw new Error('Durable command disappeared');
        observation = storedObservation(current.observation, current.acceptance.job);
        if (observation.status === 'terminal' || observation.status === 'not-started') settled.resolve();
      };
      const timer = setTimeout(settled.resolve, args.timeoutMs);
      try {
        observe(watch.value);
        watch.start(async value => { observe(value); });
        await awaitWithContext(Promise.race([settled.promise, watch.closed.then(end => { if (end.reason === 'listener_error') throw end.error; if (end.reason !== 'stopped') throw new Error(`Command observation ${end.reason}`); })]), context);
        await consumeCompletion(observation);
        return observation;
      } finally { clearTimeout(timer); await watch.stop(); }
    }
    await consumeCompletion(stored);
    return stored;
  };
}
