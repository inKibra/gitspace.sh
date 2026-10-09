import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';
import { RuntimeAttachResultSchema, RuntimeExecutorReceiptSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema, RuntimeReceiptTransportSchema, RuntimeSnapshotSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema } from '@gitspace/protocol-runtime';
import { ExecutorJournal, MachineExecutor, runSupervisorCommand } from '../../runtime-machine/src/index.js';
import { machineOperationalTools } from '../../account-machine/src/runtime-operations.js';
import { startDaemonBrokerFromEnvironment } from '../../supervisor/src/broker.js';
import { daemonClientForProject } from '../../supervisor/src/client.js';
import { searchWasmModule } from './search-wasm.js';

const unexpected = (): never => { throw new Error('Execution proof unexpectedly accessed an unrelated authority'); };
const stateSchema = z.object({ jobs: z.object({ records: z.record(z.string(), z.object({ acceptance: RuntimeJobAcceptanceSchema, observation: RuntimeJobObservationSchema, delivered: z.boolean() })) }), todos: z.object({ items: z.array(z.object({ id: z.string(), status: z.string() })) }).nullable(), completions: z.array(z.string()), toolErrors: z.number().int(), toolResults: z.array(z.unknown()), holding: z.boolean(), transcript: z.array(z.unknown()), snapshot: RuntimeSnapshotSchema });

export async function runExecutionProof(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-execution-proof-'));
  const checkout = join(directory, 'checkout');
  await mkdir(checkout);
  const oldHome = process.env.GITSPACE_SUPERVISOR_HOME;
  const oldProject = process.env.GITSPACE_SUPERVISOR_PROJECT;
  process.env.GITSPACE_SUPERVISOR_HOME = join(directory, 'supervisor');
  process.env.GITSPACE_SUPERVISOR_PROJECT = checkout;
  let worker: Miniflare | undefined;
  let brokerStarted = false;
  let journal = new ExecutorJournal(join(directory, 'executor.sqlite'));
  const openExecutor = () => new MachineExecutor({ machineId: 'proof-machine', journal, runCommand: runSupervisorCommand,
    artifacts: unexpected,
    operations: machineOperationalTools({
      get environments() { return unexpected(); }, get services() { return unexpected(); }, get authority() { return unexpected(); },
      get artifacts() { return unexpected(); }, get mcp() { return unexpected(); },
      journal: () => journal,
    }),
  });
  let executor = openExecutor();
  let offline = false;
  let dropExecuteReply = true;
  let dropAcknowledgement = true;
  let dropAcknowledgementReply = false;
  let tamperOutput = false;
  let executeRequests = 0;
  try {
    await startDaemonBrokerFromEnvironment();
    brokerStarted = true;
    const built = await Bun.build({ entrypoints: [new URL('./execution-fixture.ts', import.meta.url).pathname], target: 'browser', conditions: ['workerd'], external: ['cloudflare:workers', '*.wasm'] });
    if (!built.success) throw new AggregateError(built.logs, 'Execution proof fixture build failed');
    assert.equal(built.outputs.length, 1);
    const options: ConstructorParameters<typeof Miniflare>[0] = {
      modules: [{ type: 'ESModule', path: join(directory, 'execution.js'), contents: await built.outputs[0]!.text() }, await searchWasmModule(directory)], modulesRoot: directory,
      compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { EXECUTION: { className: 'ExecutionSmoke', useSQLite: true } }, durableObjectsPersist: join(directory, 'cloud'),
      outboundService: unexpected,
      serviceBindings: { EXECUTOR: async (request: WorkerRequest) => {
        if (offline) throw new Error('Proof machine partitioned');
        const body = await request.text();
        const input = JSON.parse(body);
        if (input.op === 'ack' && dropAcknowledgement) throw new Error('Proof acknowledgement lost');
        const isExecute = new URL(request.url).pathname === '/runtime/execute';
        if (isExecute) executeRequests++;
        const response = await executor.fetch(new Request(request.url, { method: request.method, headers: [...request.headers], body }));
        if (!response.ok) console.error('EXECUTOR_PROOF_REJECT', input.attemptId ?? input.dispatch?.attemptId, await response.clone().text());
        if (input.op === 'ack' && dropAcknowledgementReply) throw new Error('Proof acknowledgement committed but HTTP response lost');
        if (isExecute && dropExecuteReply) { dropExecuteReply = false; throw new Error('Proof terminal reply lost'); }
        if (tamperOutput && response.ok) {
          const envelope = RuntimeReceiptTransportSchema.parse(await response.json());
          if (envelope.receipt.state === 'terminal' && envelope.ciphertext) envelope.ciphertext = `${envelope.ciphertext.startsWith('00') ? '01' : '00'}${envelope.ciphertext.slice(2)}`;
          return WorkerResponse.json(envelope);
        }
        return new WorkerResponse(await response.arrayBuffer(), { status: response.status, headers: [...response.headers] });
      } },
    };
    worker = new Miniflare(options);
    const request = async (path: string, body?: unknown, fails = false): Promise<unknown> => {
      assert(worker);
      const response = await fetch(new URL(path, await worker.ready), { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), signal: AbortSignal.timeout(30_000) });
      const value: unknown = await response.json();
      assert.equal(response.ok, !fails, JSON.stringify(value));
      return value;
    };
    const grant = RuntimeAttachResultSchema.parse(await request('/setup'));
    journal.installAttachment({ ...grant, rootPath: checkout, prerequisitesComplete: true });
    const root = z.object({ conversationId: z.string() }).parse(await request('/root'));
    const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, projectId: grant.attachment.projectId, workspaceId: grant.attachment.workspaceId, machineId: grant.attachment.machineId, attachmentId: grant.attachment.attachmentId, generation: grant.attachment.generation, conversationId: root.conversationId, taskId: 'receipt-task', requestId: 'receipt-request', attemptId: 'receipt-attempt', tool: 'bash', args: { command: 'printf "one\\n" >> receipt-launches; printf "receipt output\\n"' }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
    const completed = RuntimeToolResultSchema.parse(await request('/execute', dispatch));
    assert.equal(completed.status, 'completed');
    assert.equal(await readFile(join(checkout, 'receipt-launches'), 'utf8'), 'one\n');
    assert.equal(executeRequests, 1);
    assert.notEqual(journal.attempt(dispatch.attemptId)?.acknowledged, true);
    await worker.dispose();
    worker = new Miniflare(options);
    journal.close(); journal = new ExecutorJournal(join(directory, 'executor.sqlite')); executor = openExecutor();
    offline = true;
    const saved = RuntimeExecutorReceiptSchema.parse(await request('/observe', dispatch));
    assert.equal(saved.state, 'terminal', 'Cloud must retain authenticated output independently of acknowledgement/machine availability');
    offline = false; dropAcknowledgement = false;
    assert.equal(RuntimeExecutorReceiptSchema.parse(await request('/observe', dispatch)).state, 'terminal');
    assert.equal(journal.attempt(dispatch.attemptId)?.acknowledged, true);
    assert.deepEqual(await request('/execute', dispatch), completed);
    assert.equal(executeRequests, 1, 'Cold replay must not send a second launch');
    await request('/execute', { ...dispatch, taskId: 'other-task' }, true);

    const signed = (path: string, value: unknown) => {
      const body = JSON.stringify(value);
      return new Request(`http://executor${path}`, { method: 'POST', body, headers: { 'x-gitspace-execution-signature': createHmac('sha256', Buffer.from(grant.executionSecret, 'base64url')).update(body).digest('base64url') } });
    };
    const fenced = { ...dispatch, requestId: 'fenced-request', attemptId: 'fenced-attempt', args: { command: 'printf forbidden > fenced-effect' } };
    assert.equal(RuntimeExecutorReceiptSchema.parse(await request('/cancel', fenced)).state, 'fenced-not-started');
    const delayed = await executor.fetch(signed('/runtime/execute', fenced));
    assert.equal(delayed.status, 200);
    assert.equal(RuntimeReceiptTransportSchema.parse(await delayed.json()).receipt.state, 'fenced-not-started');
    assert.equal(await Bun.file(join(checkout, 'fenced-effect')).exists(), false);

    const forged = { ...dispatch, requestId: 'forged-request', attemptId: 'forged-attempt', args: { command: 'printf authenticated' } };
    await executor.execute(forged);
    tamperOutput = true;
    assert.equal(RuntimeExecutorReceiptSchema.parse(await request('/observe', forged)).state, 'unknown', 'Unauthenticated output must not settle a cloud attempt');
    tamperOutput = false;
    // Persist the original cloud claim before accepting the independently completed receipt.
    assert.equal(RuntimeToolResultSchema.parse(await request('/execute', forged)).status, 'completed');

    // The command completed but its executor died before recording the result. Observe actual supervisor evidence, not a guessed retry.
    const recovered = { ...dispatch, requestId: 'recovered-request', attemptId: 'recovered-attempt', args: { command: 'printf "one\\n" >> recovered-launches; printf recovered' } };
    journal.begin(recovered); journal.launch(recovered);
    await runSupervisorCommand({ application: '/bin/bash', args: ['-c', recovered.args.command], cwd: checkout, attemptId: recovered.attemptId, sequence: 0, deadlineAt: recovered.deadlineAt, signal: AbortSignal.timeout(20_000) });
    journal.close(); journal = new ExecutorJournal(join(directory, 'executor.sqlite')); executor = openExecutor();
    assert.equal((await executor.observe(recovered)).receipt.state, 'terminal');
    assert.equal(await readFile(join(checkout, 'recovered-launches'), 'utf8'), 'one\n');
    const coldCancel = { ...dispatch, requestId: 'cold-cancel-request', attemptId: 'cold-cancel-attempt', args: { command: 'printf one >> cold-cancel-launches; sleep 30' } };
    journal.begin(coldCancel); journal.launch(coldCancel);
    const coldCommand = runSupervisorCommand({ application: '/bin/bash', args: ['-c', coldCancel.args.command], cwd: checkout, attemptId: coldCancel.attemptId, sequence: 0, deadlineAt: coldCancel.deadlineAt, signal: AbortSignal.timeout(20_000) });
    void coldCommand.catch(() => {}); // The finally block also stops it when an assertion fails.
    const coldLaunch = Date.now() + 10_000;
    while (!await Bun.file(join(checkout, 'cold-cancel-launches')).exists() && Date.now() < coldLaunch) await Bun.sleep(25);
    assert.equal(await readFile(join(checkout, 'cold-cancel-launches'), 'utf8'), 'one');
    journal.fence(coldCancel); // Crash after durable cancel intent, before the supervisor stop.
    journal.close(); journal = new ExecutorJournal(join(directory, 'executor.sqlite')); executor = openExecutor();
    const cancelledCold = (await executor.observe(coldCancel)).receipt;
    assert.equal(cancelledCold.state, 'terminal');
    if (cancelledCold.state !== 'terminal') throw new Error('Recovered cancellation did not prove process termination');
    assert.equal(cancelledCold.result.status, 'interrupted');
    await coldCommand;
    assert.equal(await readFile(join(checkout, 'cold-cancel-launches'), 'utf8'), 'one');
    console.log('PASS signed receipt recovery, lost response/ack, forged output rejection, launch fence and positive supervisor reconciliation');

    const largeText = '\u{10400}界'.repeat(330_000);
    await writeFile(join(checkout, 'large-output'), largeText);
    const largeDispatch = { ...dispatch, requestId: 'large-request', attemptId: 'large-attempt', tool: 'read', replay: 'safe' as const, args: { path: 'large-output' } };
    const largeResult = RuntimeToolResultSchema.parse(await request('/execute', largeDispatch));
    assert.equal(largeResult.status, 'completed');
    assert.deepEqual(largeResult.content, [{ type: 'text', text: largeText }]);
    await worker.dispose(); worker = new Miniflare(options);
    offline = true;
    const largeCold = RuntimeExecutorReceiptSchema.parse(await request('/observe', largeDispatch));
    assert.equal(largeCold.state, 'terminal');
    if (largeCold.state !== 'terminal') throw new Error('Large receipt missing after cold recovery');
    assert.deepEqual(largeCold.result, largeResult);
    offline = false;
    console.log('PASS 2.31MB Unicode result and encrypted envelope across cold offline recovery');

    const receiptStorageSchema = z.object({ materialized: z.boolean(), collected: z.boolean(), tombstoneBytes: z.number(), receipts: z.number(), payloads: z.number(), terminalBytes: z.number(), historyBytes: z.number() });
    const receiptStorage = async (attemptId: string) => receiptStorageSchema.parse(await request('/receipt-storage', { attemptId }));
    const retained = await receiptStorage(largeDispatch.attemptId);
    assert.equal(retained.materialized, false);
    assert.equal(retained.receipts, 1);
    assert(retained.terminalBytes > Buffer.byteLength(largeText), 'Acknowledgement alone must not reclaim unmaterialized output');
    const gcDispatch = { ...largeDispatch, requestId: 'gc-request', attemptId: 'gc-attempt' };
    dropAcknowledgementReply = true;
    const gcResult = RuntimeToolResultSchema.parse(await request('/execute', gcDispatch));
    assert.equal(journal.attempt(gcDispatch.attemptId)?.acknowledged, true, 'Executor committed acknowledgement before the lost HTTP response');
    assert.deepEqual(await request('/reject-mismatched-result', { attemptId: gcDispatch.attemptId }), { rejected: true }, 'Materialization must match the exact executor result, not just a terminal attempt ID');
    assert.equal((await receiptStorage(gcDispatch.attemptId)).materialized, false);
    await request('/materialize', { attemptId: gcDispatch.attemptId });
    const pendingGc = await receiptStorage(gcDispatch.attemptId);
    assert.equal(pendingGc.materialized, true, 'Real committed history reference is required for collection');
    assert.equal(pendingGc.collected, false, 'Lost acknowledgement response retains receipts until retry');
    assert.equal(pendingGc.receipts, 1);
    await request('/simulate-materialization-commit-gap', { attemptId: gcDispatch.attemptId });
    assert.equal((await receiptStorage(gcDispatch.attemptId)).materialized, false, 'Fixture models the crash window after the history transaction but before materialization bookkeeping');
    await worker.dispose(); worker = new Miniflare(options);
    offline = true;
    assert.deepEqual(RuntimeExecutorReceiptSchema.parse(await request('/observe', gcDispatch)).state, 'terminal');
    assert.equal((await receiptStorage(gcDispatch.attemptId)).materialized, true, 'Cold recovery rediscovers exact committed history references without a new execution');
    assert.equal((await receiptStorage(gcDispatch.attemptId)).collected, false);
    offline = false; dropAcknowledgementReply = false;
    const collectedGc = await receiptStorage(gcDispatch.attemptId);
    assert.equal(collectedGc.collected, true);
    assert.equal(collectedGc.receipts, 0);
    assert.equal(collectedGc.payloads, 0);
    assert.equal(collectedGc.terminalBytes, 0);
    assert(collectedGc.tombstoneBytes < 4096, 'Terminal tombstone must not retain payload bytes');
    assert(collectedGc.historyBytes < pendingGc.terminalBytes / 2, 'History retains one result copy, not encrypted transport duplication');
    const launchesBeforeGcReplay = executeRequests;
    await worker.dispose(); worker = new Miniflare(options);
    offline = true;
    assert.deepEqual(await request('/execute', gcDispatch), gcResult, 'Collected attempt replays its exact durably materialized terminal result offline');
    assert.equal(executeRequests, launchesBeforeGcReplay, 'Collection and cold recovery must not relaunch execution');
    assert.equal((await receiptStorage(largeDispatch.attemptId)).materialized, false, 'Unmaterialized sibling remains retained');
    offline = false;
    console.log('PASS acknowledged receipt GC after durable history materialization, lost committed ack response, cold offline replay, bounded tombstone and unmaterialized retention');

    const state = async () => stateSchema.parse(await request('/state'));
    const until = async (predicate: (value: z.infer<typeof stateSchema>) => boolean) => {
      const deadline = Date.now() + 20_000;
      let latest;
      do {
        latest = await state();
        if (predicate(latest)) return latest;
        if (latest.snapshot.tasks.some(task => task.kind === 'pi.generation' && task.state === 'failed')) throw new Error(`Generation failed: ${JSON.stringify(await request('/task-failures'))}`);
        await Bun.sleep(25);
      } while (Date.now() < deadline);
      throw new Error(`Execution proof state timeout: ${JSON.stringify({ jobs: latest?.jobs, tasks: latest?.snapshot.tasks, toolErrors: latest?.toolErrors, lastTool: JSON.stringify(latest?.toolResults[0]).slice(0, 1500) })}`);
    };
    await request('/submit', { text: 'read large tool result', requestId: 'large-tool-materialization' });
    await until(value => value.snapshot.tasks.some(task => task.kind === 'pi.tool' && task.state === 'completed'));
    await request('/foreground-idle');
    const routedDispatch = RuntimeToolDispatchSchema.parse(await request('/tool-dispatch'));
    const routedStorage = await receiptStorage(routedDispatch.attemptId);
    assert.equal(routedStorage.collected, true, 'Ordinary routed tools materialize a bounded history reference at their real completion transaction');
    assert.equal(routedStorage.terminalBytes, 0);
    assert(routedStorage.historyBytes > 2_000_000, 'Large output survives Pi tool-content truncation without an oversized entry');
    const routedCold = RuntimeExecutorReceiptSchema.parse(await request('/observe', routedDispatch));
    assert.equal(routedCold.state, 'terminal');
    if (routedCold.state !== 'terminal') throw new Error('Materialized routed tool missing terminal evidence');
    assert.deepEqual(routedCold.result.content, [{ type: 'text', text: largeText }]);
    console.log('PASS real Pi routed-tool history transaction materializes large exact result with bounded entry details');
    await request('/submit', { text: 'run background job', requestId: 'job-admission' });
    const admitted = await until(value => Object.keys(value.jobs.records).length === 1);
    const job = Object.values(admitted.jobs.records)[0]!;
    assert.equal(job.acceptance.status, 'accepted');
    assert.notEqual(job.observation.status, 'terminal');
    assert.equal(await Bun.file(join(checkout, 'release')).exists(), false);
    await request('/submit', { text: 'foreground probe', requestId: 'foreground-probe' });
    await until(value => value.todos?.items.some(item => item.id === 'probe' && item.status === 'completed') === true);
    const waitLaunch = Date.now() + 10_000;
    while (!await Bun.file(join(checkout, 'launches')).exists() && Date.now() < waitLaunch) await Bun.sleep(25);
    assert.equal(await readFile(join(checkout, 'launches'), 'utf8'), 'launch\n');
    await request('/submit', { text: `job-control:${JSON.stringify({ op: 'logs', job: job.acceptance.job })}`, requestId: 'live-job-logs' });
    await until(value => value.toolResults.some(content => JSON.stringify(content).includes('job-live-log-marker')));
    await worker.dispose(); worker = new Miniflare(options);
    await state();
    await writeFile(join(checkout, 'release'), 'release');
    const settled = await until(value => Object.values(value.jobs.records).some(record => record.observation.status === 'terminal'));
    const final = Object.values(settled.jobs.records)[0]!;
    assert.deepEqual(final.acceptance, job.acceptance);
    assert.equal(final.observation.status, 'terminal');
    assert.equal(final.delivered, true);
    const jobStorage = await receiptStorage(`task:${job.acceptance.job.taskId}`);
    assert.equal(jobStorage.collected, true, 'Durable Job completion must reclaim its acknowledged transport receipts');
    assert.equal(jobStorage.receipts, 0);
    assert.equal(jobStorage.terminalBytes, 0);
    assert.equal(await readFile(join(checkout, 'launches'), 'utf8'), 'launch\n');
    await until(value => JSON.stringify(value.transcript).includes(`Consumed job receipt ${job.acceptance.job.jobId}`));
    await worker.dispose(); worker = new Miniflare(options);
    const cold = await state();
    assert.deepEqual(Object.values(cold.jobs.records)[0]?.observation, final.observation);
    assert.equal(cold.completions.length, 1, 'Job completion must be delivered exactly once across recovery');
    await request('/submit', { text: `job-control:${JSON.stringify({ op: 'status', job: { ...job.acceptance.job, conversationId: 'foreign' } })}`, requestId: 'wrong-job-scope' });
    await until(value => value.toolErrors > cold.toolErrors);
    await rm(join(checkout, 'release'));
    await request('/submit', { text: 'run background job', requestId: 'second-job-admission' });
    await until(value => Object.keys(value.jobs.records).length === 2);
    await request('/submit', { text: 'hold foreground', requestId: 'held-foreground' });
    await until(value => value.holding);
    await writeFile(join(checkout, 'release'), 'release');
    const queuedCompletion = await until(value => Object.values(value.jobs.records).every(record => record.delivered));
    assert.equal(queuedCompletion.holding, true, 'Job delivery must not replace an active foreground generation');
    assert.equal(queuedCompletion.completions.length, 1, 'Busy completion waits at the foreground boundary');
    await request('/release-foreground', {});
    const twice = await until(value => value.completions.length === 2);
    assert.equal(new Set(Object.values(twice.jobs.records).map(record => record.acceptance.job.jobId)).size, 2, 'Provider tool-call IDs may repeat across generations without reusing an old Job');
    assert.equal(await readFile(join(checkout, 'launches'), 'utf8'), 'launch\nlaunch\n');
    const secondJob = Object.values(twice.jobs.records).find(record => record.acceptance.job.jobId !== job.acceptance.job.jobId)!;
    await until(value => JSON.stringify(value.transcript).includes(`Consumed job receipt ${secondJob.acceptance.job.jobId}`));
    await rm(join(checkout, 'release'));
    await request('/submit', { text: 'run background job', requestId: 'cancelled-job-admission' });
    const third = await until(value => Object.keys(value.jobs.records).length === 3);
    const cancellationJob = Object.values(third.jobs.records).find(record => !record.delivered)!;
    const cancellationLaunch = Date.now() + 10_000;
    while ((await readFile(join(checkout, 'launches'), 'utf8')).split('\n').length < 4 && Date.now() < cancellationLaunch) await Bun.sleep(25);
    assert.equal(await readFile(join(checkout, 'launches'), 'utf8'), 'launch\nlaunch\nlaunch\n');
    await request('/submit', { text: `job-control:${JSON.stringify({ op: 'cancel', job: cancellationJob.acceptance.job })}`, requestId: 'cancel-running-job' });
    const cancelledState = await until(value => Object.values(value.jobs.records).every(record => record.delivered));
    const cancelled = Object.values(cancelledState.jobs.records).find(record => record.acceptance.job.jobId === cancellationJob.acceptance.job.jobId)!.observation;
    assert.equal(cancelled.status, 'terminal');
    if (cancelled.status !== 'terminal') throw new Error('Running Job cancellation did not recover a terminal receipt');
    assert.equal(cancelled.receipt.result.status, 'interrupted', JSON.stringify(cancelled.receipt.result));
    await until(value => value.snapshot.tasks.some(task => task.id === cancellationJob.acceptance.job.taskId && task.state === 'interrupted'));
    await until(value => JSON.stringify(value.transcript).includes(`Consumed job receipt ${cancellationJob.acceptance.job.jobId}`));
    await request('/submit', { text: 'run background job', requestId: 'stopped-conversation-job' });
    const fourth = await until(value => Object.keys(value.jobs.records).length === 4);
    const stoppedJob = Object.values(fourth.jobs.records).find(record => !record.delivered)!;
    const stopLaunch = Date.now() + 10_000;
    while ((await readFile(join(checkout, 'launches'), 'utf8')).split('\n').length < 5 && Date.now() < stopLaunch) await Bun.sleep(25);
    assert.equal(await readFile(join(checkout, 'launches'), 'utf8'), 'launch\nlaunch\nlaunch\nlaunch\n');
    await request('/submit', { text: 'spawn three blocked children', requestId: 'three-running-children' });
    await until(value => value.snapshot.conversations.filter(item => item.parentId !== null && item.status === 'running').length === 3);
    await until(value => ['Child1', 'Child2', 'Child3'].every(name => JSON.stringify(value.transcript).includes(`Message from ${name}`)));
    await request('/foreground-idle');
    const generationsBeforeStop = (await state()).snapshot.tasks.filter(task => task.kind === 'pi.generation').length;
    await request('/abort', {});
    const stopped = await until(value => Object.values(value.jobs.records).every(record => record.delivered) && value.snapshot.tasks.some(task => task.id === stoppedJob.acceptance.job.taskId && task.state === 'interrupted'));
    assert.equal(stopped.snapshot.tasks.filter(task => task.kind === 'pi.generation').length, generationsBeforeStop, 'Stopping the conversation must not admit a new generation');
    assert.equal(stopped.snapshot.conversations.filter(item => item.parentId !== null).length, 3);
    assert.equal(stopped.snapshot.conversations.some(item => item.status === 'running'), false, 'Stop must abort actual children, not just tracking tasks');
    assert.equal(stopped.completions.includes(stoppedJob.acceptance.job.jobId), false, 'Stopped command completion must remain queued');
    await worker.dispose(); worker = new Miniflare(options);
    const stoppedCold = await state();
    assert.equal(stoppedCold.snapshot.tasks.filter(task => task.kind === 'pi.generation').length, generationsBeforeStop, 'Cold recovery must preserve the Stop latch');
    await request('/submit', { text: 'Resume after stop', requestId: 'explicit-user-resume' });
    await until(value => value.completions.includes(stoppedJob.acceptance.job.jobId));
    console.log('PASS async bash acceptance, live logs, idle/busy completion, cold recovery, scoped controls, cancellation, three-child plus real-command Stop and explicit-user queue resume');
  } finally {
    try {
      if (brokerStarted) await (await daemonClientForProject(checkout)).request({ op: 'shutdown' });
      await worker?.dispose();
    } finally {
      journal.close();
      if (oldHome === undefined) delete process.env.GITSPACE_SUPERVISOR_HOME; else process.env.GITSPACE_SUPERVISOR_HOME = oldHome;
      if (oldProject === undefined) delete process.env.GITSPACE_SUPERVISOR_PROJECT; else process.env.GITSPACE_SUPERVISOR_PROJECT = oldProject;
      await rm(directory, { recursive: true, force: true });
    }
  }
}
