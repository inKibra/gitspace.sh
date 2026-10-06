import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Harness, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT, withAbortSignal, awaitWithContext } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { ProcessSupervisor, DaemonRequestSchema } from '@gitspace/supervisor';
import { RuntimeProcArgumentsSchema } from '@gitspace/protocol-runtime';
import { createProcessExitTask, type JobServices } from './jobs.js';

const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };

for (const mode of ['exit', 'offline exit', 'Stop', 'Stop while unreachable', 'Stop offline restart', 'automatic restart'] as const) test(`durable process ${mode} delivers each exit once and remains settled after harness restart`, async () => {
  const stopping = mode === 'Stop' || mode === 'Stop while unreachable' || mode === 'Stop offline restart';
  const restarting = mode === 'automatic restart';
  const rootPath = await mkdtemp(join(tmpdir(), 'durable-process-event-'));
  const supervisor = new ProcessSupervisor(rootPath);
  await supervisor.recover();
  const observed = Promise.withResolvers<void>();
  const delivered: Parameters<JobServices['deliverConversationEvent']>[0][] = [];
  const unavailableStop = Promise.withResolvers<void>();
  const unavailableObservation = Promise.withResolvers<void>();
  let reachable = mode !== 'Stop while unreachable' && mode !== 'Stop offline restart' && mode !== 'offline exit';
  const stopAttempts: string[] = [];
  const services: JobServices = {
    execute: unused, reconcile: unused, cancel: unused, jobScope: unused, controlJob: unused,
    async wakeAt() { harness.resume(); },
    async observeProcess(input) {
      if (!reachable && !stopping) {
        unavailableObservation.resolve();
        throw new Error('Original process machine is unreachable');
      }
      const observation = RuntimeProcArgumentsSchema.parse(input.args);
      if (observation.op !== 'status') throw new Error('Unexpected observation');
      const args = DaemonRequestSchema.parse({ ...observation, op: 'describe' });
      const result = await supervisor.request(args);
      observed.resolve();
      return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
    async stopProcess(input) {
      stopAttempts.push(input.attemptId);
      if (!reachable) {
        unavailableStop.resolve();
        return { status: 'interrupted', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: 'Original process machine is unreachable' }] };
      }
      const result = await supervisor.request(DaemonRequestSchema.parse(input.args));
      return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
    async deliverConversationEvent(input) { delivered.push(input); },
  };
  const task = createProcessExitTask(services);
  const registry = createRegistry(); registry.install(defineExtension({ name: 'process-events', tasks: [task] }));
  const storage = await openNodeJsonlStorage(join(rootPath, 'session'), BACKGROUND_CONTEXT);
  let harness = await Harness.open(storage, { registry, models: createModels() }, BACKGROUND_CONTEXT);
  const context = withAbortSignal(AbortSignal.timeout(4000), BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(context);
    const started = await supervisor.request({ op: 'start', spec: { name: 'owned', application: stopping ? '/bin/sleep' : '/bin/sh', args: stopping ? ['30'] : ['-c', restarting ? 'if [ -e restarted ]; then exit 0; else touch restarted; exit 7; fi' : 'exit 7'], cwd: rootPath, env: {}, pty: false, persist: true, detached: false, restart: restarting ? 'on-failure' : 'no' } });
    if (started.op !== 'start') throw new Error('Unexpected start result');
    if (!stopping) await supervisor.request({ op: 'wait', name: 'owned', for: 'exit', timeoutMs: 1000 });
    if (restarting) {
      // This exercises the supervisor's real restart timer and real process exit, not a fake scheduler.
      const deadline = Date.now() + 2000;
      for (;;) {
        const current = await supervisor.request({ op: 'describe', name: 'owned' });
        if (current.op === 'describe' && current.daemon.restartCount === 1 && current.daemon.state === 'exited') break;
        if (Date.now() >= deadline) throw new Error('Automatic process restart did not complete');
        await delay(10);
      }
    }
    const id = await harness.commit(tx => tx.createTask(task, { originAttemptId: 'accepted-start', daemonId: started.daemon.id, restartCount: 0, args: { op: 'status', name: 'owned', instanceId: started.daemon.id, restartCount: 0 } }, { conversationId: root.id, ownership: { kind: 'conversation' }, background: true }), context);
    harness.resume();
    if (mode === 'offline exit') {
      await awaitWithContext(unavailableObservation.promise, context);
      await harness.close(BACKGROUND_CONTEXT);
      reachable = true;
      harness = await Harness.open(await openNodeJsonlStorage(join(rootPath, 'session'), BACKGROUND_CONTEXT), { registry, models: createModels() }, BACKGROUND_CONTEXT);
      harness.resume();
    }
    if (stopping) {
      await awaitWithContext(observed.promise, context);
      const stopped = root.abort(context, { background: true });
      if (mode === 'Stop offline restart') {
        const closedAbort = stopped.catch(() => undefined);
        await awaitWithContext(unavailableStop.promise, context);
        await harness.close(BACKGROUND_CONTEXT);
        await closedAbort;
        reachable = true;
        harness = await Harness.open(await openNodeJsonlStorage(join(rootPath, 'session'), BACKGROUND_CONTEXT), { registry, models: createModels() }, BACKGROUND_CONTEXT);
        harness.resume();
      } else {
        if (mode === 'Stop while unreachable') {
          await awaitWithContext(unavailableStop.promise, context);
          reachable = true;
          harness.resume();
        }
        await stopped;
      }
    }
    const settled = await harness.waitForTask(id, context);
    expect(settled.state.outcome.status).toBe(stopping ? 'aborted' : 'completed');
    expect(delivered).toHaveLength(restarting ? 2 : 1);
    expect(delivered[0]?.kind).toBe('process-exited');
    expect(delivered[0]?.requestId).toBe(`process-exited:${started.daemon.id}:0`);
    expect(delivered[0]?.payload).toMatchObject({ id: started.daemon.id, state: 'exited', ...(stopping ? {} : { exitCode: 7 }) });
    if (mode === 'Stop while unreachable') expect(new Set(stopAttempts).size).toBeGreaterThan(1);
    if (restarting) {
      expect(delivered[1]?.requestId).toBe(`process-exited:${started.daemon.id}:1`);
      expect(delivered[1]?.payload).toMatchObject({ id: started.daemon.id, restartCount: 1, state: 'exited', exitCode: 0 });
    }
    await harness.close(BACKGROUND_CONTEXT);
    harness = await Harness.open(await openNodeJsonlStorage(join(rootPath, 'session'), BACKGROUND_CONTEXT), { registry, models: createModels() }, BACKGROUND_CONTEXT);
    await harness.waitForTask(id, context);
    expect(delivered).toHaveLength(restarting ? 2 : 1);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await supervisor.request({ op: 'shutdown' });
    await rm(rootPath, { recursive: true, force: true });
  }
}, 8000);
