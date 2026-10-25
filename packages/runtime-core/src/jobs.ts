import { defineDoc, defineTask, type TaskId, type TaskRuntime, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import { awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import { RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema, RuntimeProcArgumentsSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema, RuntimeToolResultSchema, receiptDigest, type RuntimeToolResult, type RuntimeJobAcceptance, type RuntimeJobObservation } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { DaemonResponseSchema, DaemonSnapshotSchema, type DaemonSnapshot } from '@gitspace/supervisor/protocol';
import type { OperationalServices } from './tasks.js';
import { ConversationLifecycleDoc, handleEvents } from './conversation-lifecycle.js';

export type JobServices = OperationalServices & {
  deliverConversationEvent(input: { conversationId: string; requestId: string; kind: 'command-completed' | 'process-exited'; text: string; payload?: JsonValue }): Promise<void>;
};

type JobRecord = { acceptance: RuntimeJobAcceptance; observation: RuntimeJobObservation; args: JsonValue; fingerprint: string; spawningTask: TaskId; deadlineAt: string; attemptId: string; cancelRequested: boolean; delivered: boolean };
type JobInput = { key: string; spawningTask: TaskId };
/** `failures`: consecutive failed tries of the current retry run, for its backoff; absent before the first. */
type JobState = { phase: 'execute'; poll: number; failures?: number };
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
/** Finished jobs kept for `list` and later reads of their handles; older ones are dropped as the document is written. */
const MAX_FINISHED_JOBS = 32;
/**
 * Drops the oldest finished jobs beyond MAX_FINISHED_JOBS. A job is finished once its completion was delivered: its task
 * has ended and the conversation holds its result. Running jobs, and settled ones not delivered yet, stay.
 */
function pruneFinishedJobs(doc: { records: Record<string, JobRecord> }): void {
  const finished = Object.entries(doc.records).flatMap(([key, record]) => {
    const observation = storedObservation(record.observation, record.acceptance.job);
    return record.delivered && (observation.status === 'terminal' || observation.status === 'not-started') ? [{ key, completedAt: observation.completedAt }] : [];
  });
  if (finished.length <= MAX_FINISHED_JOBS) return;
  finished.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  for (const { key } of finished.slice(MAX_FINISHED_JOBS)) delete doc.records[key];
}
/**
 * A failed try (a job's reconciliation, dispatch or completion delivery; a process stop) is tried again after this long,
 * doubling per consecutive failure up to RETRY_MAX_MS. The count is kept in the task's checkpoint, so a reset keeps its
 * place. After RETRY_ATTEMPTS failures (about 20 minutes) a job stops trying and says so; a stop is tried again only when
 * a machine reconnects.
 */
const RETRY_FIRST_MS = 1_000, RETRY_MAX_MS = 5 * 60_000, RETRY_ATTEMPTS = 12;
const retryDelay = (failures: number) => Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function createJobTask(services: JobServices) {
  async function drive(key: string, runtime: TaskRuntime<JobInput, JobState, RuntimeJobObservation, {}>, context: Context, aborting: boolean, failures: number) {
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
        // A delivery that fails after this starts its own run of failures.
        failures = 0;
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        // A failed reconciliation or dispatch is retried; after the last try the job ends interrupted, its outcome unknown,
        // and the conversation is told.
        if (failures + 1 >= RETRY_ATTEMPTS) observation = { status: 'terminal', job, result: { requestId: job.requestId, attemptId: record.attemptId, status: 'interrupted', content: [{ type: 'text', text: `Its outcome could not be read after ${RETRY_ATTEMPTS} tries: ${errorText(error)}` }] }, completedAt: now };
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
          // A run of failed deliveries is reported when it starts and when retrying stops; the job then ends.
          const last = failures + 1 >= RETRY_ATTEMPTS;
          if (failures === 0) runtime.report(error);
          if (last) runtime.report(new Error(`Background command ${job.jobId}'s completion was not delivered after ${RETRY_ATTEMPTS} tries: ${errorText(error)}`));
          continuationReady = last;
        }
      }
      await runtime.commit(async tx => {
        const doc = await tx.doc(DurableJobsDoc, runtime.conversationId);
        const current = doc.records[key];
        current.observation = observation;
        if (aborting) current.cancelRequested = true;
        if (settled && continuationReady) { pruneFinishedJobs(doc); current.delivered = true; }
        if (!current.delivered) return { status: 'running', checkpoint: { phase: 'execute', poll: runtime.now(), failures: failures + 1 } };
        if (observation.status === 'not-started') return { status: 'terminal', outcome: observation.reason === 'cancelled'
          ? { status: 'aborted', reason: 'Cancelled before execution', result: observation }
          : { status: 'failed', error: { message: observation.message ?? `Job did not start: ${observation.reason}` }, result: observation } };
        if (observation.status === 'terminal') return { status: 'terminal', outcome: observation.result.status === 'completed'
          ? { status: 'completed', result: observation }
          : observation.result.status === 'failed'
            ? { status: 'failed', error: { message: observation.result.error.message }, result: observation }
            : { status: 'aborted', reason: 'Executor attempt interrupted', result: observation } };
        return { status: 'running', checkpoint: { phase: 'execute', poll: runtime.now(), failures: failures + 1 } };
      }, context);
      if (settled && continuationReady) return;
      failures++;
      const next = runtime.now() + retryDelay(failures);
      await services.wakeAt(next); await runtime.sleep(next, context);
    }
  }
  return defineTask<JobInput, JobState, RuntimeJobObservation>({
    name: 'gitspace.Job', version: 1, initial: () => ({ phase: 'execute', poll: 0 }),
    phases: { async execute(task, runtime, context) { await drive(task.input.key, runtime, context, false, task.state.checkpoint.failures ?? 0); } },
    async abort(task, runtime, context) { await drive(task.input.key, runtime, context, true, task.state.checkpoint.failures ?? 0); },
  });
}

type ProcessExitInput = { originAttemptId: string; daemonId: string; restartCount: number; args: JsonValue };
/** `failing`: the current run of failed observations has been reported (once, when it started). `failures`: consecutive
 * failed stop tries, for their backoff; `stopFailing`: their run has been reported. */
type ProcessExitState = { phase: 'observe'; poll: number; restartCount: number; failing?: boolean; failures?: number; stopFailing?: boolean };
/**
 * Exits machines report for the workspace's processes, by `<daemon id>:<restart count>`; each watch takes its own.
 * `checks` counts machine reconnections: each makes every watch check its machine once more, as a machine that restarted
 * lost the exit waits it held.
 */
export const ProcessExitsDoc = defineDoc<{ exits: Record<string, { daemon: JsonValue; reportedAt: number }>; checks?: number }>({ kind: 'gitspace.process-exits', version: 1, scope: 'session', initial: () => ({ exits: {} }) });
/** Reports no watch takes (a process started outside a watch) are dropped beyond this many, oldest first. */
const MAX_PROCESS_EXIT_REPORTS = 100;
export const processExitKey = (daemon: Pick<DaemonSnapshot, 'id' | 'restartCount'>) => `${daemon.id}:${daemon.restartCount}`;
/** Records a machine's report that a process exited. */
export function recordProcessExit(exits: { exits: Record<string, { daemon: JsonValue; reportedAt: number }> }, daemon: DaemonSnapshot, now: number): void {
  if (daemon.state !== 'exited' && daemon.state !== 'failed') throw new Error('Only an exited or failed process is reported');
  // Documents hold strict JSON; a snapshot's absent optional fields are `undefined`.
  exits.exits[processExitKey(daemon)] = { daemon: JSON.parse(JSON.stringify(daemon)), reportedAt: now };
  const keys = Object.entries(exits.exits).sort((left, right) => left[1].reportedAt - right[1].reportedAt).map(([key]) => key);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PROCESS_EXIT_REPORTS))) delete exits.exits[key];
}
/** Records that a machine reconnected: every process watch checks its machine once more. */
export function recordMachineReconnection(exits: { checks?: number }): void {
  exits.checks = (exits.checks ?? 0) + 1;
}
/** Waits, without a timer, until the exit under `key` is reported or a machine reconnects after `checks`: a pending timer
 * would keep the workspace object in memory for as long as the process runs. */
async function reportedExit(runtime: TaskRuntime<ProcessExitInput, ProcessExitState, JsonValue, object>, key: string, checks: number, context: Context): Promise<void> {
  const watch = await runtime.watchDoc(ProcessExitsDoc, context);
  if (!watch) throw new Error('Process exit reports missing');
  const arrived = Promise.withResolvers<void>();
  // A Stop aborts the task, not the context: the wait ends on either, as pi's own sleep does.
  const aborted = () => arrived.reject(runtime.signal.reason);
  runtime.signal.addEventListener('abort', aborted, { once: true });
  try {
    runtime.signal.throwIfAborted();
    if (watch.value?.exits[key] || (watch.value?.checks ?? 0) !== checks) return;
    watch.start(async value => { if (value?.exits[key] || (value?.checks ?? 0) !== checks) arrived.resolve(); });
    await awaitWithContext(Promise.race([arrived.promise, watch.closed.then(end => { if (end.reason === 'listener_error') throw end.error; if (end.reason !== 'stopped') throw new Error(`Process exit reports ${end.reason}`); })]), context);
  } finally { runtime.signal.removeEventListener('abort', aborted); await watch.stop(); }
}
export const ProcessWatchesDoc = defineDoc<{ tasks: Record<string, string> }>({ kind: 'gitspace.process-watches', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ tasks: {} }) });
export function createProcessExitTask(services: JobServices) {
  return defineTask<ProcessExitInput, ProcessExitState, JsonValue>({
    name: 'gitspace.ProcessExit', version: 1, initial: input => ({ phase: 'observe', poll: 0, restartCount: input.restartCount }),
    phases: { async observe(task, runtime, context) {
      let { poll, restartCount, failing = false } = task.state.checkpoint;
      const args = RuntimeProcArgumentsSchema.parse(task.input.args);
      if (args.op !== 'status') throw new Error('Process watch has no admitted status identity');
      // The machine is checked when the watch starts, when this phase runs again after a reset, and after each machine
      // reconnection; otherwise the machine's own report ends the wait.
      let check = true;
      for (;;) {
        const key = processExitKey({ id: task.input.daemonId, restartCount });
        const reports = await runtime.snapshot(ProcessExitsDoc, context);
        const checks = reports?.checks ?? 0;
        const report = reports?.exits[key];
        let exited: DaemonSnapshot | null = report ? DaemonSnapshotSchema.parse(report.daemon) : null;
        if (!exited && check) {
          check = false;
          try {
            // An observation is a read: it leaves no receipt in the transcript and no record on the machine.
            const requestId = `process-observation:${runtime.taskId}:${poll}`;
            const result = await services.observeProcess({ originAttemptId: task.input.originAttemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), requestId, attemptId: requestId, args: { ...args, restartCount } });
            if (result.status !== 'completed') throw new Error('Process observation unavailable');
            const text = result.content.find(item => item.type === 'text');
            if (!text || text.type !== 'text') throw new Error('Process observation missing');
            const response = DaemonResponseSchema.parse(JSON.parse(text.text));
            if (response.op !== 'describe' || response.daemon.id !== task.input.daemonId || response.daemon.restartCount !== restartCount) throw new Error('Process observation identity changed');
            failing = false;
            if (response.daemon.state === 'exited' || response.daemon.state === 'failed') exited = response.daemon;
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            // A machine offline for hours would otherwise file one report per check.
            if (!failing) runtime.report(error);
            failing = true;
          }
          poll++;
          // Creates the reports document the wait below watches (a watch needs it to exist).
          await runtime.commit(async tx => { await tx.doc(ProcessExitsDoc); return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount, failing } }; }, context);
        }
        if (exited) {
          if (exited.id !== task.input.daemonId || exited.restartCount !== restartCount) throw new Error('Process exit identity changed');
          await services.deliverConversationEvent({ conversationId: String(runtime.conversationId), requestId: `process-exited:${task.input.daemonId}:${restartCount}`, kind: 'process-exited', text: `Process exited:\n${JSON.stringify(exited)}`, payload: exited });
          const successor = exited.nextRestartCount;
          if (successor !== undefined && successor <= restartCount) throw new Error('Invalid process restart successor');
          if (successor !== undefined) {
            restartCount = successor;
            poll++;
            check = true;
            await runtime.commit(async tx => { delete (await tx.doc(ProcessExitsDoc)).exits[key]; return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount, failing } }; }, context);
            continue;
          }
          const result = exited;
          await runtime.commit(async tx => { delete (await tx.doc(ProcessExitsDoc)).exits[key]; return { status: 'terminal', outcome: { status: 'completed', result } }; }, context);
          return;
        }
        await reportedExit(runtime, key, checks, context);
        check = true;
      }
    } },
    async abort(task, runtime, context) {
      const args = RuntimeProcArgumentsSchema.parse(task.input.args);
      if (args.op !== 'status') throw new Error('Process watch has no admitted status identity');
      let { poll, restartCount, failures = 0, stopFailing = false } = task.state.checkpoint;
      for (;;) {
        // Read before the try, so a reconnection during it is not missed.
        const checks = (await runtime.snapshot(ProcessExitsDoc, context))?.checks ?? 0;
        try {
          const requestId = `process-stop:${runtime.taskId}:${poll}`;
          const { restartCount: _originRestart, ...launch } = args;
          const result = await services.stopProcess({ originAttemptId: task.input.originAttemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), requestId, attemptId: requestId, args: { ...launch, op: 'stop', timeoutMs: 5000 } });
          const sha256 = await receiptDigest(result);
          await runtime.commit(async tx => {
            await tx.appendEntry(runtime.conversationId, { kind: 'gitspace.executor-results', data: { results: [{ attemptId: result.attemptId, sha256 }] } });
            return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount, failures, stopFailing } };
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
                return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount, failures, stopFailing } };
              }, context);
              const text = previous.content.find(item => item.type === 'text');
              if (previous.status !== 'completed' || !text || text.type !== 'text') throw new Error('Previous process exit observation missing');
              const archived = DaemonResponseSchema.parse(JSON.parse(text.text));
              if (archived.op !== 'describe' || archived.daemon.id !== task.input.daemonId || archived.daemon.restartCount !== restartCount || (archived.daemon.state !== 'exited' && archived.daemon.state !== 'failed')) throw new Error('Previous process exit identity changed');
              exited = archived.daemon;
            }
            await services.deliverConversationEvent({ conversationId: String(runtime.conversationId), requestId: `process-exited:${task.input.daemonId}:${restartCount}`, kind: 'process-exited', text: `Process exited:\n${JSON.stringify(exited)}`, payload: exited });
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'observe', poll, restartCount: restartCount + 1, failures, stopFailing } }), context);
          }
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Conversation stopped', result: response.daemon } }), context);
          return;
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // The stop is kept until its machine confirms it; a run of failures is reported once, when it starts.
          if (!stopFailing) runtime.report(error);
          stopFailing = true;
          failures++;
        }
        poll++;
        await runtime.commit(async tx => { await tx.doc(ProcessExitsDoc); return { status: 'running', checkpoint: { phase: 'observe', poll, restartCount, failures, stopFailing } }; }, context);
        // Tries back off while the machine answers but fails; after RETRY_ATTEMPTS only a machine's reconnection (or the
        // exit's report) tries again, and a reconnection starts the backoff over.
        const settled = new AbortController();
        const scoped = withAbortSignal(context.abortSignal ? AbortSignal.any([context.abortSignal, settled.signal]) : settled.signal, context);
        const waits = [reportedExit(runtime, processExitKey({ id: task.input.daemonId, restartCount }), checks, scoped).then(() => { failures = 0; })];
        if (failures < RETRY_ATTEMPTS) {
          const next = runtime.now() + retryDelay(failures);
          await services.wakeAt(next);
          waits.push(runtime.sleep(next, scoped));
        }
        try { await Promise.race(waits); } finally { settled.abort(); await Promise.allSettled(waits); }
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
        return prior.acceptance;
      }
      const scope = await services.jobScope(args);
      const acceptance = await api.commit(async tx => {
        const doc = await tx.doc(DurableJobsDoc, api.conversationId);
        const existing = doc.records[admissionId];
        if (existing) { if (existing.acceptance.job.conversationId !== String(api.conversationId) || existing.fingerprint !== fingerprint) throw new Error('Job admission request changed'); return existing.acceptance; }
        pruneFinishedJobs(doc);
        const id = await tx.createTask(task, { key: admissionId, spawningTask: api.taskId }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
        const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date().toISOString(), job: { ...scope, jobId: `job:${id}`, taskId: String(id), conversationId: String(api.conversationId), requestId: `task:${id}` } });
        doc.records[admissionId] = { acceptance, observation: acceptance, args, fingerprint, spawningTask: api.taskId, deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), attemptId: `task:${id}`, cancelRequested: false, delivered: false };
        return acceptance;
      }, context);
      return acceptance;
    }
    const args = RuntimeBashControlArgumentsSchema.parse(input);
    const document = await api.snapshot(DurableJobsDoc, api.conversationId, context);
    const records = Object.values(document?.records ?? {}).filter(record => record.acceptance.job.conversationId === String(api.conversationId));
    if (args.op === 'list') return records.slice(-100).map(record => storedObservation(record.observation, record.acceptance.job));
    const record = records.find(record => JSON.stringify(record.acceptance.job) === JSON.stringify(args.job));
    if (!record) throw new Error(`Job handle does not belong to this conversation, or its job finished before the last ${MAX_FINISHED_JOBS} finished jobs`);
    const stored = storedObservation(record.observation, record.acceptance.job);
    // A finished job the agent reads here is its answer: the completion message would only repeat it as a later turn.
    const consumeCompletion = async (observation: RuntimeJobObservation) => {
      if (observation.status !== 'terminal' && observation.status !== 'not-started') return;
      await api.commit(async tx => handleEvents(await tx.doc(ConversationLifecycleDoc, api.conversationId), new Set([`job-completion:${observation.job.jobId}`])), context);
    };
    if (args.op === 'logs') return services.controlJob({ attemptId: record.attemptId, op: 'logs', lines: args.lines, head: args.head, cursor: args.cursor });
    if (args.op === 'cancel' && stored.status !== 'terminal' && stored.status !== 'not-started') {
      const observation = RuntimeJobObservationSchema.parse({ status: 'waiting', job: record.acceptance.job, reason: 'reconciliation', observedAt: new Date().toISOString() });
      await api.commit(async tx => { const doc = await tx.doc(DurableJobsDoc, api.conversationId); const current = Object.values(doc.records).find(value => value.attemptId === record.attemptId); if (!current) throw new Error('Job missing'); current.cancelRequested = true; const status = storedObservation(current.observation, current.acceptance.job).status; if (status !== 'terminal' && status !== 'not-started') current.observation = observation; }, context);
      try { await services.cancel(record.attemptId); } catch { /* The job task retries the cancellation. */ }
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
