import { defineDoc, defineTask, InboxDoc, type Harness, type TaskId, type TaskRuntime, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord/json';
import { boundedReplay } from './documents.js';
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import { PROCESS_MACHINE_DETACHED, RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema, RuntimeProcArgumentsSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema, RuntimeToolResultSchema, receiptDigest, type RuntimeToolResult, type RuntimeJobAcceptance, type RuntimeJobObservation } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { DaemonResponseSchema, DaemonSnapshotSchema, type DaemonSnapshot } from '@gitspace/supervisor/protocol';
import type { OperationalServices } from './tasks.js';
import { ConversationLifecycleDoc, handleEvents } from './conversation-lifecycle.js';

export type JobServices = OperationalServices & {
  deliverConversationEvent(input: { conversationId: string; requestId: string; kind: 'command-completed' | 'process-exited'; text: string; payload?: JsonValue }): Promise<void>;
};

/** `foreground`: the call that started the job waits for it, so the job runs at once, and its completion is a message
 * only once the call `handedOff` the job (moved it to the background); a background start runs once its call has
 * recorded the acceptance and always reports its completion. `task`: the job's task. */
type JobRecord = { acceptance: RuntimeJobAcceptance; observation: RuntimeJobObservation; args: JsonValue; fingerprint: string; spawningTask: TaskId; deadlineAt: string; attemptId: string; cancelRequested: boolean; delivered: boolean; foreground?: boolean; handedOff?: boolean; task?: TaskId };
type JobInput = { key: string; spawningTask: TaskId };
/** `failures`: consecutive failed tries of the current retry run, for its backoff; absent before the first. */
type JobState = { phase: 'execute'; poll: number; failures?: number };
export const DurableJobsDoc = defineDoc<{ records: Record<string, JobRecord> }>({ kind: 'gitspace.durable-jobs', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ records: {} }), checkpointWhen: boundedReplay });
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
        const spawn = aborting || record.foreground ? null : await runtime.waitForTask(record.spawningTask, context);
        const cancel = aborting || record.cancelRequested;
        if (cancel) await services.cancel(record.attemptId);
        const admitted = !cancel && (record.foreground === true || spawn?.state.outcome.status === 'completed');
        const expired = Date.parse(record.deadlineAt) <= runtime.now();
        const result = await services.reconcile(record.attemptId)
          ?? (admitted && !expired ? await services.execute({ kind: 'Job', args: record.args, requestId: job.requestId, attemptId: record.attemptId, conversationId: String(runtime.conversationId), taskId: String(runtime.taskId), deadlineAt: record.deadlineAt, replay: 'unsafe', signal: runtime.signal }) : null);
        observation = result ? { status: 'terminal', job, result, completedAt: now }
          : { status: 'not-started', job, reason: cancel ? 'cancelled' : admitted ? 'deadline' : 'admission-failed', completedAt: now };
        // A delivery that fails after this starts its own run of failures.
        failures = 0;
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        // A dispatch recovers its own lost replies, so a failure the call still waits for is its answer at once, as for
        // any tool. Otherwise a failed reconciliation or dispatch is retried; after the last try the job ends
        // interrupted, its outcome unknown, and the conversation is told.
        if (record.foreground === true && record.handedOff !== true) observation = { status: 'terminal', job, result: { requestId: job.requestId, attemptId: record.attemptId, status: 'failed', error: { code: 'dispatch_failed', message: errorText(error) }, content: [] }, completedAt: now };
        else if (failures + 1 >= RETRY_ATTEMPTS) observation = { status: 'terminal', job, result: { requestId: job.requestId, attemptId: record.attemptId, status: 'interrupted', content: [{ type: 'text', text: `Its outcome could not be read after ${RETRY_ATTEMPTS} tries: ${errorText(error)}` }] }, completedAt: now };
      }
      observation = RuntimeJobObservationSchema.parse(observation);
      const settled = observation.status === 'terminal' || observation.status === 'not-started';
      const completionRequestId = `job-completion:${job.jobId}`;
      let continuationReady = true;
      // A foreground job the call is still waiting for is answered by the call, not by a message.
      const announce = !record.foreground || record.handedOff === true;
      if ((observation.status === 'terminal' || observation.status === 'not-started') && !record.delivered && announce) {
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
        // A call that handed the job off after this pass read the record is told on the next pass.
        const unannounced = current.foreground === true && current.handedOff === true && !announce;
        if (settled && continuationReady && !unannounced) { pruneFinishedJobs(doc); current.delivered = true; }
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
      // A phase sleeps durably and resumes at its checkpoint; an abort handler runs in one invocation and waits in it.
      if (!aborting) { await runtime.sleepUntil(next, { phase: 'execute', poll: runtime.now(), failures }, context); return; }
      await services.wakeAt(next);
      const elapsed = Promise.withResolvers<void>();
      runtime.setTimer(elapsed.resolve, next - runtime.now());
      await awaitWithContext(elapsed.promise, context);
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
export const ProcessExitsDoc = defineDoc<{ exits: Record<string, { daemon: JsonValue; reportedAt: number }>; checks?: number }>({ kind: 'gitspace.process-exits', version: 1, scope: 'session', initial: () => ({ exits: {} }), checkpointWhen: boundedReplay });
/** Reports no watch takes (a process started outside a watch) are dropped beyond this many, oldest first. */
const MAX_PROCESS_EXIT_REPORTS = 100;
export const processExitKey = (daemon: Pick<DaemonSnapshot, 'id' | 'restartCount'>) => `${daemon.id}:${daemon.restartCount}`;
/** Why a watched process can no longer be observed or stopped, when that is certain: its machine's supervisor answers
 * that it does not know the process (it is not running there), or the machine has left the workspace. An offline machine
 * or any other failure is not certain, and is tried again. */
function processGone(result: RuntimeToolResult, name: string): string | null {
  if (result.status !== 'failed') return null;
  if (result.error.code === PROCESS_MACHINE_DETACHED) return result.error.message;
  if (result.error.message === `Unknown process ${name}`) return `The machine's supervisor no longer knows process ${name}, so it is not running there`;
  return null;
}
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
    watch.start(async call => { if (call.kind === 'value' && (call.value.exits[key] || (call.value.checks ?? 0) !== checks)) arrived.resolve(); });
    await awaitWithContext(Promise.race([arrived.promise, watch.closed.then(end => { if (end.kind === 'listener_error' || end.kind === 'failed') throw end.error; if (end.kind !== 'stopped') throw new Error(`Process exit reports ${end.kind}`); })]), context);
  } finally { runtime.signal.removeEventListener('abort', aborted); await watch.stop(); }
}
export const ProcessWatchesDoc = defineDoc<{ tasks: Record<string, string> }>({ kind: 'gitspace.process-watches', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ tasks: {} }), checkpointWhen: boundedReplay });
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
            const gone = processGone(result, args.name);
            if (gone !== null) {
              await runtime.commit(async tx => { delete (await tx.doc(ProcessExitsDoc)).exits[key]; return { status: 'terminal', outcome: { status: 'failed', error: { message: gone } } }; }, context);
              return;
            }
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
          const gone = processGone(result, args.name);
          if (gone !== null) {
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: `Conversation stopped; ${gone}` } }), context);
            return;
          }
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
          // An abort handler runs in one invocation: it waits in it, and the wake reruns it if the object stops meanwhile.
          const next = runtime.now() + retryDelay(failures);
          await services.wakeAt(next);
          const elapsed = Promise.withResolvers<void>();
          runtime.setTimer(elapsed.resolve, next - runtime.now());
          waits.push(awaitWithContext(elapsed.promise, scoped));
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
/** How long a foreground command holds its call before it moves to the background as a job. */
export const FOREGROUND_COMMAND_MS = 60_000;
/** How long a job's command may run: its deadline on the machine. */
const JOB_LIFETIME_MS = 30 * 60_000;
/** Output lines shown when a foreground command moves to the background. */
const HANDOFF_OUTPUT_LINES = 40;
/** `foregroundMs`: how long a foreground command holds its call; tests shorten it. */
export function createJobTool(services: JobServices, abortTask: Harness['abortTask'], foregroundMs = FOREGROUND_COMMAND_MS) {
  const task = createJobTask(services);
  /** Starts the command as this call's job, or finds the job an earlier run of the call started. */
  async function admit(input: JsonValue, api: ToolExecutionApi, context: Context, foreground: boolean): Promise<RuntimeJobAcceptance> {
    const args = RuntimeBashCommandArgumentsSchema.parse(input);
    const fingerprint = JSON.stringify(args);
    const admissionId = String(api.taskId);
    const prior = (await api.snapshot(DurableJobsDoc, api.conversationId, context))?.records[admissionId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Job admission request changed');
      return prior.acceptance;
    }
    const scope = await services.jobScope(args);
    return api.commit(async tx => {
      const doc = await tx.doc(DurableJobsDoc, api.conversationId);
      const existing = doc.records[admissionId];
      if (existing) { if (existing.acceptance.job.conversationId !== String(api.conversationId) || existing.fingerprint !== fingerprint) throw new Error('Job admission request changed'); return existing.acceptance; }
      pruneFinishedJobs(doc);
      const id = await tx.createTask(task, { key: admissionId, spawningTask: api.taskId }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true });
      const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date().toISOString(), job: { ...scope, jobId: `job:${id}`, taskId: String(id), conversationId: String(api.conversationId), requestId: `task:${id}` } });
      doc.records[admissionId] = { acceptance, observation: acceptance, args, fingerprint, spawningTask: api.taskId, deadlineAt: new Date(Date.now() + JOB_LIFETIME_MS).toISOString(), attemptId: `task:${id}`, cancelRequested: false, delivered: false, task: id, ...(foreground ? { foreground } : {}) };
      return acceptance;
    }, context);
  }
  /**
   * The job's observation once it settles, `timeoutMs` passes, or a message waits in the conversation's inbox to steer
   * it, whichever is first: pi places a steer after the round, so a round waiting on a command would hold it back.
   * `steered` says the inbox ended the wait.
   */
  async function observe(jobId: string, timeoutMs: number, api: ToolExecutionApi, context: Context): Promise<{ observation: RuntimeJobObservation; steered: boolean }> {
    const watch = await api.watchDoc(DurableJobsDoc, api.conversationId, context);
    if (!watch) throw new Error('Durable command observation missing');
    const inbox = await api.watchDoc(InboxDoc, api.conversationId, context);
    let observation: RuntimeJobObservation | undefined;
    let steered = false;
    const settled = Promise.withResolvers<void>();
    const observe = (value: typeof watch.value) => {
      const current = Object.values(value?.records ?? {}).find(item => item.acceptance.job.jobId === jobId);
      if (!current) throw new Error('Durable command disappeared');
      observation = storedObservation(current.observation, current.acceptance.job);
      if (observation.status === 'terminal' || observation.status === 'not-started') settled.resolve();
    };
    const steer = (value: NonNullable<typeof inbox>['value']) => { if (value?.items.some(item => item.mode === 'steer')) { steered = true; settled.resolve(); } };
    const closed = (end: Awaited<typeof watch.closed>) => { if (end.kind === 'listener_error' || end.kind === 'failed') throw end.error; if (end.kind !== 'stopped') throw new Error(`Command observation ${end.kind}`); };
    const timer = setTimeout(settled.resolve, timeoutMs);
    try {
      observe(watch.value);
      watch.start(async call => { if (call.kind === 'value') observe(call.value); });
      if (inbox) { steer(inbox.value); inbox.start(async call => { if (call.kind === 'value') steer(call.value); }); }
      await awaitWithContext(Promise.race([settled.promise, watch.closed.then(closed), ...(inbox ? [inbox.closed.then(closed)] : [])]), context);
      if (!observation) throw new Error('Durable command observation missing');
      // A job that settled as the steer arrived is answered, not handed off.
      return { observation, steered: steered && observation.status !== 'terminal' && observation.status !== 'not-started' };
    } finally { clearTimeout(timer); await watch.stop(); await inbox?.stop(); }
  }
  /** A finished job the agent reads here is its answer: the completion message would only repeat it as a later turn. */
  async function consumeCompletion(observation: RuntimeJobObservation, api: ToolExecutionApi, context: Context) {
    if (observation.status !== 'terminal' && observation.status !== 'not-started') return;
    await api.commit(async tx => handleEvents(await tx.doc(ConversationLifecycleDoc, api.conversationId), new Set([`job-completion:${observation.job.jobId}`])), context);
  }
  async function record(job: RuntimeJobAcceptance['job'], api: ToolExecutionApi, context: Context) {
    const document = await api.snapshot(DurableJobsDoc, api.conversationId, context);
    const found = Object.values(document?.records ?? {}).find(item => item.acceptance.job.conversationId === String(api.conversationId) && JSON.stringify(item.acceptance.job) === JSON.stringify(job));
    if (!found) throw new Error(`Job handle does not belong to this conversation, or its job finished before the last ${MAX_FINISHED_JOBS} finished jobs`);
    return found;
  }
  async function cancel(found: JobRecord, api: ToolExecutionApi, context: Context): Promise<RuntimeJobObservation> {
    const observation = RuntimeJobObservationSchema.parse({ status: 'waiting', job: found.acceptance.job, reason: 'reconciliation', observedAt: new Date().toISOString() });
    await api.commit(async tx => { const doc = await tx.doc(DurableJobsDoc, api.conversationId); const current = Object.values(doc.records).find(value => value.attemptId === found.attemptId); if (!current) throw new Error('Job missing'); current.cancelRequested = true; const status = storedObservation(current.observation, current.acceptance.job).status; if (status !== 'terminal' && status !== 'not-started') current.observation = observation; }, context);
    try { await services.cancel(found.attemptId); } catch { /* The job task retries the cancellation. */ }
    return observation;
  }
  return {
    /** A background start (`background: true`) or a control (`op`) of the conversation's jobs. */
    async control(input: JsonValue, api: ToolExecutionApi, context: Context): Promise<JsonValue> {
      if (input && typeof input === 'object' && !Array.isArray(input) && input.background === true) return admit(input, api, context, false);
      const args = RuntimeBashControlArgumentsSchema.parse(input);
      if (args.op === 'list') {
        const document = await api.snapshot(DurableJobsDoc, api.conversationId, context);
        return Object.values(document?.records ?? {}).filter(item => item.acceptance.job.conversationId === String(api.conversationId)).slice(-100).map(item => storedObservation(item.observation, item.acceptance.job));
      }
      const found = await record(args.job, api, context);
      const stored = storedObservation(found.observation, found.acceptance.job);
      if (args.op === 'logs') return services.controlJob({ attemptId: found.attemptId, op: 'logs', lines: args.lines, head: args.head, cursor: args.cursor });
      const running = stored.status !== 'terminal' && stored.status !== 'not-started';
      if (args.op === 'cancel' && running) return cancel(found, api, context);
      const observation = args.op === 'wait' && running ? (await observe(found.acceptance.job.jobId, args.timeoutMs, api, context)).observation : stored;
      await consumeCompletion(observation, api, context);
      return observation;
    },
    /**
     * A foreground command: it runs as this call's job, and the call waits for it up to `foregroundMs`, or until a
     * message waits to steer the conversation. A command still running then keeps running as a background job, and the
     * call answers with its handle and its output so far; its completion arrives as a message. Stopping the call stops
     * the command.
     */
    async foreground(input: JsonValue, api: ToolExecutionApi, context: Context): Promise<RuntimeToolResult> {
      const acceptance = await admit(input, api, context, true);
      const job = acceptance.job;
      let observation: RuntimeJobObservation;
      let steered = false;
      try { ({ observation, steered } = await observe(job.jobId, foregroundMs, api, context)); }
      catch (error) {
        // A stopped call can no longer commit; aborting the job's task cancels the command and records it.
        const task = (await api.snapshot(DurableJobsDoc, api.conversationId, BACKGROUND_CONTEXT))?.records[String(api.taskId)]?.task;
        if (context.abortSignal?.aborted && task !== undefined) await abortTask(task, BACKGROUND_CONTEXT);
        throw error;
      }
      if (observation.status !== 'terminal' && observation.status !== 'not-started') {
        // Handing off and the job settling decide in one commit: a job that settled meanwhile is answered here.
        const settled = await api.commit(async tx => {
          const current = (await tx.doc(DurableJobsDoc, api.conversationId)).records[String(api.taskId)];
          if (!current) throw new Error('Durable command disappeared');
          const latest = storedObservation(current.observation, current.acceptance.job);
          if (latest.status === 'terminal' || latest.status === 'not-started') return latest;
          current.handedOff = true;
          return null;
        }, context);
        if (settled) observation = settled;
      }
      const identity = { requestId: job.requestId, attemptId: `task:${job.taskId}` };
      if (observation.status === 'terminal') return observation.result;
      if (observation.status === 'not-started') {
        const message = `The command did not start (${observation.reason})${observation.message ? `: ${observation.message}` : ''}`;
        return { ...identity, status: 'failed', content: [{ type: 'text', text: message }], error: { code: 'HOST_OPERATION_FAILED', message } };
      }
      let output = '';
      try {
        const logs = await services.controlJob({ attemptId: `task:${job.taskId}`, op: 'logs', lines: HANDOFF_OUTPUT_LINES });
        const text = logs.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
        const parsed = DaemonResponseSchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.op === 'logs') output = parsed.data.text;
      } catch { /* The handle still controls the job; its output is read with op logs. */ }
      const reason = steered ? 'A message arrived while it ran' : `Still running after ${foregroundMs / 1000} s`;
      return { ...identity, status: 'completed', content: [{ type: 'text', text: `${reason}: the command keeps running as background job ${job.jobId}. Its result arrives as a message from GitSpace when it finishes; bash { op: "wait" | "logs" | "cancel", job } waits for it, reads its output or stops it.\nJob handle: ${JSON.stringify(job)}\nOutput so far (last ${HANDOFF_OUTPUT_LINES} lines):\n${output || '(none yet)'}` }] };
    },
  };
}
