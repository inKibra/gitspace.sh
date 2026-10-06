import { defineDoc, defineTask, type TaskId, type TaskRuntime, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import { awaitWithContext } from '@earendil-works/chord/context';
import { RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema, RuntimeProcArgumentsSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema, receiptDigest, type RuntimeToolResult, type RuntimeJobAcceptance, type RuntimeJobObservation, type RuntimeExecutorReceipt } from '@gitspace/protocol-runtime';
import { DaemonResponseSchema } from '@gitspace/supervisor/protocol';
import type { OperationalServices } from './tasks.js';

export type JobServices = OperationalServices & {
  deliverConversationEvent(input: { conversationId: string; requestId: string; kind: 'command-completed' | 'process-exited'; text: string; payload?: JsonValue }): Promise<void>;
};

type JobRecord = { acceptance: RuntimeJobAcceptance; observation: RuntimeJobObservation; args: JsonValue; fingerprint: string; spawningTask: TaskId; deadlineAt: string; attemptId: string; cancelRequested: boolean; delivered: boolean };
type JobInput = { key: string; spawningTask: TaskId };
type JobState = { phase: 'execute'; poll: number };
export const DurableJobsDoc = defineDoc<{ records: Record<string, JobRecord> }>({ kind: 'gitspace.durable-jobs', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ records: {} }) });
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
      if (settled && !record.delivered) {
        try {
          await services.deliverConversationEvent({ conversationId: String(runtime.conversationId), requestId: completionRequestId, kind: 'command-completed', text: `Background command completion:\n${JSON.stringify(observation)}`, payload: observation });
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
    const task = await tx.createTask(createProcessExitTask(services), { originAttemptId: result.attemptId, daemonId: response.daemon.id, restartCount: response.daemon.restartCount, args: { op: 'status', name: response.daemon.name, instanceId: response.daemon.id, restartCount: response.daemon.restartCount, ...(args.on === undefined ? {} : { on: args.on }), ...(args.at === undefined ? {} : { at: args.at }) } }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
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
    if (args.op === 'list') return records.slice(-100).map(record => RuntimeJobObservationSchema.parse(record.observation));
    const record = records.find(record => JSON.stringify(record.acceptance.job) === JSON.stringify(args.job));
    if (!record) throw new Error('Job handle does not belong to this conversation');
    if (args.op === 'logs') return services.controlJob({ attemptId: record.attemptId, op: 'logs', lines: args.lines, head: args.head, cursor: args.cursor });
    if (args.op === 'cancel' && record.observation.status !== 'terminal' && record.observation.status !== 'not-started') {
      const observation = RuntimeJobObservationSchema.parse({ status: 'waiting', job: record.acceptance.job, reason: 'reconciliation', observedAt: new Date().toISOString() });
      await api.commit(async tx => { const doc = await tx.doc(DurableJobsDoc, api.conversationId); const current = Object.values(doc.records).find(value => value.attemptId === record.attemptId); if (!current) throw new Error('Job missing'); current.cancelRequested = true; if (current.observation.status !== 'terminal' && current.observation.status !== 'not-started') current.observation = observation; }, context);
      // Durable cancellation intent is retried until exit or a launch barrier is proven.
      try { await services.cancel(record.attemptId); } catch { /* Unknown is not cancelled. */ }
      await services.wakeAt(Date.now());
      return observation;
    }
    if (args.op === 'wait' && record.observation.status !== 'terminal' && record.observation.status !== 'not-started') {
      const watch = await api.watchDoc(DurableJobsDoc, api.conversationId, context);
      if (!watch) throw new Error('Durable command observation missing');
      let observation: RuntimeJobObservation = record.observation;
      const settled = Promise.withResolvers<void>();
      const observe = (value: typeof watch.value) => {
        const current = Object.values(value?.records ?? {}).find(item => item.acceptance.job.jobId === record.acceptance.job.jobId);
        if (!current) throw new Error('Durable command disappeared');
        observation = current.observation;
        if (observation.status === 'terminal' || observation.status === 'not-started') settled.resolve();
      };
      const timer = setTimeout(settled.resolve, args.timeoutMs);
      try {
        observe(watch.value);
        watch.start(async value => { observe(value); });
        await awaitWithContext(Promise.race([settled.promise, watch.closed.then(end => { if (end.reason === 'listener_error') throw end.error; if (end.reason !== 'stopped') throw new Error(`Command observation ${end.reason}`); })]), context);
        return RuntimeJobObservationSchema.parse(observation);
      } finally { clearTimeout(timer); await watch.stop(); }
    }
    return RuntimeJobObservationSchema.parse(record.observation);
  };
}
