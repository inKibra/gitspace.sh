// Local-only regression proof: bun run --cwd packages/runtime-workspace-do smoke
// Uses synthetic providers with real Pi, workerd SQLite and a private local executor/supervisor. No tenant bindings.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { z } from 'zod';
import { RuntimeSnapshotSchema, RuntimeWatchEventSchema, RuntimeSessionResultSchema, RuntimeWorkspaceStatusSchema, type RuntimeSessionCommand, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { WorkspaceDraftSchema, WorkspaceDraftSaveResultSchema } from '@gitspace/protocol-runtime/draft';
import { searchWasmModule } from './search-wasm.js';

const identity = { projectId: 'smoke-project', workspaceId: 'smoke-workspace' };
/** Rows an alarm may read in a workspace with nothing to do: recovery and resume read live state, never history. */
const IDLE_WAKE_ROWS = 200;
/** Characters of each task result the fixture's operations return ('full durable receipt ' 1,000 times). */
const RECEIPT_CHARACTERS = 21_000;
const directory = await mkdtemp(join(tmpdir(), 'gitspace-runtime-smoke-'));
let worker: Miniflare | undefined;
try {
  // workerd supplies node:async_hooks (nodejs_compat); a browser build would replace it with an empty stand-in.
  const built = await Bun.build({ entrypoints: [new URL('./fixture.ts', import.meta.url).pathname], target: 'browser', conditions: ['workerd'], external: ['cloudflare:workers', '*.wasm'], plugins: [{ name: 'workerd-async-hooks', setup(build) { build.onResolve({ filter: /^node:async_hooks$/u }, args => ({ path: args.path, external: true })); } }] });
  if (!built.success) throw new AggregateError(built.logs, 'Runtime smoke fixture build failed');
  assert.equal(built.outputs.length, 1);
  const contents = await built.outputs[0]!.text();
  const options = { modules: [{ type: 'ESModule' as const, path: join(directory, 'fixture.js'), contents }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { SMOKE: { className: 'RuntimeSmoke', useSQLite: true }, REPLICA: { className: 'ReplicaSmoke', useSQLite: true }, RESET: { className: 'ResetMarksSmoke', useSQLite: true }, MEMORY: { className: 'MemorySmoke', useSQLite: true } }, durableObjectsPersist: join(directory, 'state'), outboundService: () => { throw new Error('External network forbidden in runtime smoke'); } };
  worker = new Miniflare(options);
  async function request(path: string, body?: unknown, expectedFailure = false): Promise<unknown> {
    assert(worker);
    const response = await fetch(new URL(path, await worker.ready), body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value: unknown = await response.json();
    if (expectedFailure) assert(!response.ok, `${path} unexpectedly accepted ${JSON.stringify(body)}`);
    else assert(response.ok, `${path}: ${JSON.stringify(value)}`);
    return value;
  }
  async function session(command: RuntimeSessionCommand, conversationId?: string, canApprove = true) {
    return RuntimeSessionResultSchema.parse(await request('/session', { ...identity, conversationId, command, canApprove }));
  }
  async function until(predicate: (snapshot: RuntimeSnapshot) => boolean) {
    const deadline = Date.now() + 30_000;
    let last: RuntimeSnapshot | undefined;
    do {
      last = RuntimeSnapshotSchema.parse(await request('/'));
      if (predicate(last)) return last;
      await Bun.sleep(20);
    } while (Date.now() < deadline);
    throw new Error(`Runtime did not progress without a manual wake: ${JSON.stringify(last)}`);
  }
  const assistantReplies = (snapshot: RuntimeSnapshot) => snapshot.conversations.flatMap(item => item.messages).filter(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.startsWith('fixture reply:'))).length;
  console.log('PASS replica stores the cursor only: migration, in-memory replay, reset after reopen, large Unicode draft', await request('/replica-proof'));

  // The memory estimate: a line as the runtime opens and one as each turn ends, each holder's bytes where its data is; a
  // turn ending within 30 s of the last estimate logs only that it was skipped. The first open also measures the
  // database's tables; an open within 24 hours of that does not.
  {
    const logged = z.array(z.looseObject({ event: z.string() })).parse(await request('/memory-estimate'));
    const tableLines = z.array(z.object({ tables: z.array(z.object({ name: z.string(), rows: z.number(), bytes: z.number(), estimated: z.boolean() })), measuredBytes: z.number(), unmeasured: z.array(z.string()) }).loose()).parse(logged.filter(line => line.event === 'workspace_database_tables'));
    assert.equal(tableLines.length, 1, `${tableLines.length} table lines for three opens within 24 hours`);
    const [tables] = tableLines;
    assert(tables);
    // 50 notes of 2,000 characters and their ids, the largest table, first.
    assert.deepEqual(tables.tables[0], { name: 'smoke_notes', rows: 50, bytes: 100_091, estimated: false });
    assert.equal(tables.measuredBytes, tables.tables.reduce((sum, table) => sum + table.bytes, 0));
    assert.deepEqual(tables.unmeasured, []);
    const lines = z.array(z.looseObject({ phase: z.string(), skipped: z.string().optional() })).parse(logged.filter(line => line.event === 'workspace_memory_estimate'));
    assert.deepEqual(lines.map(line => [line.phase, line.skipped ?? null]), [['wake', null], ['turn-end', null], ['turn-end', 'busy'], ['wake', null], ['wake', null]]);
    const tally = z.object({ queries: z.number(), rows: z.number(), bytes: z.number() });
    const reopen = z.object({ reason: z.string(), sincePreviousOpenMs: z.number().nullable(), sinceTurnEndMs: z.number().nullable() }).loose();
    const isolate = z.object({ isolate: z.object({ id: z.string(), objectsOpen: z.number(), workspaceIds: z.array(z.string()) }), isolateTotalBytes: z.number() });
    // Every line, the skipped one and the table line included, names this isolate's open runtimes.
    const isolates = z.array(isolate.loose()).parse([...tableLines, ...lines]);
    assert.equal(new Set(isolates.map(line => line.isolate.id)).size, 1, 'Lines of one isolate named different isolates');
    const estimates = lines.map(line => line.skipped === undefined ? z.looseObject({ holders: z.record(z.string(), z.number()), totalBytes: z.number(), tasks: z.number(), truncated: z.boolean(), requests: z.object({ count: z.number(), largestBytes: z.number() }), reads: z.object({ rebuild: tally, transcript: tally, other: tally, largestBytes: z.number() }), reopen: reopen.optional() }).merge(isolate).parse(line) : null);
    const [opened, conversation, , reopened, third] = estimates;
    assert(opened && conversation && reopened && third);
    // The second runtime opens beside the first; the third replaces the first, which closed. The isolate's total is the
    // latest estimate of each runtime open, the first's from its turn end.
    const smokeRuntimes = (line: typeof opened) => line.isolate.workspaceIds.filter(id => id === identity.workspaceId).length;
    assert.equal(reopened.isolate.objectsOpen, opened.isolate.objectsOpen + 1);
    assert.equal(smokeRuntimes(reopened), smokeRuntimes(opened) + 1);
    assert.equal(third.isolate.objectsOpen, reopened.isolate.objectsOpen);
    assert.equal(smokeRuntimes(third), smokeRuntimes(reopened));
    const others = reopened.isolateTotalBytes - reopened.totalBytes - conversation.totalBytes;
    assert(others >= 0, `The isolate total ${reopened.isolateTotalBytes} left out an open runtime`);
    assert.equal(third.isolateTotalBytes - third.totalBytes - reopened.totalBytes, others, 'The closed runtime still counted in the isolate total');
    for (const line of [conversation, reopened]) {
      assert.equal(line.totalBytes, Object.values(line.holders).reduce((sum, bytes) => sum + bytes, 0));
      assert.equal(line.truncated, false);
    }
    // The main conversation's view keeps its newest 256 entries: 2.56 million characters of the 3 million seeded.
    assert(conversation.holders.conversationViews! >= 2_560_000, `A large conversation's views counted ${conversation.holders.conversationViews} bytes`);
    assert(conversation.holders.taskViews! < 100_000, `Task views counted ${conversation.holders.taskViews} bytes before any task held a result`);
    // The snapshot is built from the views and shares their text, which counts once.
    assert(conversation.holders.snapshot! < 500_000, `The snapshot counted ${conversation.holders.snapshot} bytes of the views' text again`);
    assert(conversation.requests.count >= 1 && conversation.requests.largestBytes >= 3_000_000, `The turn's request counted ${conversation.requests.largestBytes} bytes`);
    // Reopened: 128 finished tasks are kept, each with a 4,096-character preview of its large result; the conversation is
    // unchanged but for the second turn.
    assert(reopened.tasks >= 128);
    assert(reopened.holders.taskViews! - conversation.holders.taskViews! >= 128 * 4096, `128 large task results added ${reopened.holders.taskViews! - conversation.holders.taskViews!} bytes to the task views`);
    assert(Math.abs(reopened.holders.conversationViews! - conversation.holders.conversationViews!) < 100_000, 'Task results were counted in the conversation views');
    // Storage reads by what asked: each rebuild during the turn reads the conversation's newest 256 entries again, and
    // pi reads all 300 (3 million characters) to build the turn's context. Opening again reads them, and the 128 task
    // results, only for the first rebuild.
    assert(conversation.reads.rebuild.bytes >= 2_560_000, `The turn's rebuilds read ${conversation.reads.rebuild.bytes} bytes`);
    assert(conversation.reads.other.bytes >= 3_000_000, `The turn's context assembly read ${conversation.reads.other.bytes} bytes`);
    assert(reopened.reads.rebuild.bytes >= 2_560_000 + 128 * RECEIPT_CHARACTERS, `The reopened runtime's rebuild read ${reopened.reads.rebuild.bytes} bytes`);
    assert(reopened.reads.other.bytes < 100_000, `Opening read ${reopened.reads.other.bytes} bytes outside the rebuild`);
    assert.deepEqual(reopened.reads.transcript, { queries: 0, rows: 0, bytes: 0 });
    // Why each runtime opened: the first had no previous open; the second follows it on the same code with nothing running.
    assert.equal(opened.reopen?.reason, 'first');
    assert.equal(reopened.reopen?.reason, 'cold-start');
    assert(reopened.reopen.sincePreviousOpenMs !== null && reopened.reopen.sincePreviousOpenMs >= 0 && reopened.reopen.sinceTurnEndMs !== null);
    console.log('PASS memory estimate lines on open and at a turn end attribute a large conversation and large task results to their holders, and storage reads to the rebuild or the turn; a burst skips; tables measured once', JSON.stringify({ ...lines[1], holders: undefined }), JSON.stringify(tables));
  }

  // A reset during the open's rebuild or the alarm's conversation recovery is reported on the next open: the stage it
  // reached and how much it held.
  const resetMarks = z.array(z.object({ step: z.string(), detail: z.string() }));
  assert.deepEqual(resetMarks.parse(await request('/reset-marks?stage=open')), [{ step: 'runtime open', detail: 'rebuilding the snapshot: reading tasks and building it from 1 conversations (0.3 MB of entries read, 0.3 MB of views)' }]);
  assert.deepEqual(resetMarks.parse(await request('/reset-marks?stage=recovery')), [{ step: 'conversation recovery', detail: '1 conversations, lifecycle documents 0.6 MB' }]);
  console.log('PASS a reset during the open or recovery names the stage and its sizes on the next open');

  const events = async (after: number) => z.array(RuntimeWatchEventSchema).parse(await request(`/events?after=${after}`));
  const current = RuntimeSnapshotSchema.parse(await request('/')).cursor;
  assert.deepEqual(await events(current), [], 'A current cursor must read no events');

  const saveDraft = async (text: string, expectedRevision: number, deviceId: string) => {
    assert(worker);
    const response = await fetch(new URL('/draft', await worker.ready), { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-device': deviceId }, body: JSON.stringify({ text, expectedRevision }) });
    assert(response.ok, await response.clone().text());
    return WorkspaceDraftSaveResultSchema.parse(await response.json());
  };
  const draftCursor = RuntimeSnapshotSchema.parse(await request('/')).cursor;
  const savedDraft = await saveDraft('Draft from device A', 0, 'device-a');
  assert.equal(savedDraft.draft.text, 'Draft from device A');
  let watchedDraft = '';
  const draftDeadline = Date.now() + 30_000;
  while (!watchedDraft.includes('Draft from device A')) {
    assert(Date.now() < draftDeadline, 'The saved draft never appeared in the events after the prior cursor');
    const read = await events(draftCursor);
    assert(read.every(event => event.type === 'delta'), 'A contiguous cursor must read only deltas');
    watchedDraft = JSON.stringify(read);
    if (!watchedDraft.includes('Draft from device A')) await Bun.sleep(20);
  }
  assert.equal(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']).deviceId, 'device-a');
  const newerDraft = await saveDraft('Newer edit from device B ' + '🚀'.repeat(40_000), savedDraft.draft.revision, 'device-b');
  await worker.dispose();
  worker = new Miniflare(options);
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), newerDraft.draft);
  await request(`/submit?text=Send%20stale%20draft&draftRevision=${savedDraft.draft.revision}`);
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), newerDraft.draft, 'A stale send erased an unseen edit from device B');
  await request('/submit?text=Programmatic%20send');
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), newerDraft.draft, 'A send without observed draft revision erased the draft');
  await request('/session', { ...identity, command: { type: 'prompt', text: 'Stale prompt', draftRevision: savedDraft.draft.revision } });
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), newerDraft.draft, 'A stale prompt erased an unseen edit');
  await request('/session', { ...identity, command: { type: 'prompt', text: 'Programmatic prompt' } });
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), newerDraft.draft, 'A prompt without an observed revision erased the draft');
  await request(`/submit?text=Send%20draft%20proof&draftRevision=${newerDraft.draft.revision}`);
  const clearedDraft = WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']);
  assert.equal(clearedDraft.text, '');
  assert(clearedDraft.revision > newerDraft.draft.revision);
  // The debounced save of the sent text can land before the send's clear: only the sender's own save of exactly that text is cleared.
  const otherDeviceDraft = await saveDraft('Racing draft', clearedDraft.revision, 'device-b');
  await request('/session', { ...identity, command: { type: 'prompt', text: 'Racing draft', draftRevision: clearedDraft.revision, draftText: 'Racing draft' } });
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), otherDeviceDraft.draft, 'A send erased the same text saved by another device');
  const differentTextDraft = await saveDraft('Typed after send', otherDeviceDraft.draft.revision, 'fixture-browser');
  await request(`/submit?text=Sent%20text&draftRevision=${otherDeviceDraft.draft.revision}&draftText=Sent%20text`);
  assert.deepEqual(WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']), differentTextDraft.draft, 'A send erased different text from the sending device');
  const inFlightDraft = await saveDraft('Sent while saving', differentTextDraft.draft.revision, 'fixture-browser');
  await request('/session', { ...identity, command: { type: 'prompt', text: 'Sent while saving', draftRevision: differentTextDraft.draft.revision, draftText: 'Sent while saving' } });
  const racedDraft = WorkspaceDraftSchema.parse(RuntimeSnapshotSchema.parse(await request('/')).documents['gitspace.draft']);
  assert.equal(racedDraft.text, '', 'A send left its own in-flight saved text in the draft');
  assert(racedDraft.revision > inFlightDraft.draft.revision);
  console.log('PASS draft watch delivery, device authorship, cold recovery, accepted-send clearing and in-flight sent-text clearing');

  // A rejected model request must tell the user why instead of leaving an empty reply.
  const summary = (snapshot: RuntimeSnapshot) => RuntimeWorkspaceStatusSchema.parse(snapshot.documents['gitspace.status']).summary;
  // pi retries an overloaded request after a backoff: until then the conversation says when, and why; the answer clears it.
  await request('/submit?text=overload%20the%20model%20once');
  const retrying = await until(snapshot => snapshot.conversations.some(item => item.retry !== undefined));
  const retry = retrying.conversations.find(item => item.retry !== undefined)?.retry;
  assert.match(retry?.error ?? '', /fixture provider overloaded/);
  assert(retry && Number.isFinite(Date.parse(retry.at)), 'A retry has no time');
  const answered = await until(snapshot => snapshot.conversations.some(item => item.messages.some(message => message.content.some(part => part.type === 'text' && part.text === 'fixture reply: overload the model once'))));
  const root = answered.conversations.find(item => item.parentId === null);
  assert(root && root.retry === undefined && root.status !== 'failed', 'A retried request that answered still shows its retry or a failure');
  console.log('PASS an overloaded model request shows when it is retried and why, until the retry answers');
  await request('/submit?text=fail%20the%20model');
  const failed = await until(snapshot => snapshot.conversations.some(item => item.status === 'failed'));
  assert.match(failed.conversations.find(item => item.status === 'failed')?.error ?? '', /fixture provider rejected the request/);
  assert.equal(summary(failed).primaryColor, 'red', 'A failed main agent is not red');
  // A failed request reports no usage, and is never read as an empty context. (The fixture's small window compacts
  // before every request, so no request has been answered since and no figure is shown.)
  assert.notEqual((await session({ type: 'control' })).control.context?.tokens, 0, 'A failed request read as an empty context');
  console.log('PASS failed model request surfaces its error, turns the workspace red and keeps the context in use');

  // The fixture model echoes the prompt, so this reply holds an invalid block: the main agent gets one notice, which
  // starts no turn.
  {
    const told = 'user: Block 1 in your last message is invalid: the Mermaid source is empty\nThe chat shows an error in place of that block. Check the failing paths against skill://gitspace-ui and send a corrected block in a new message.';
    const texts = (snapshot: RuntimeSnapshot) => snapshot.conversations.find(item => item.title === 'Workspace')!.messages.flatMap(message => message.content.flatMap(part => part.type === 'text' ? [`${message.role}: ${part.text}`] : []));
    await request(`/submit?text=${encodeURIComponent('Status:\n```mermaid\n\n```')}`);
    await until(snapshot => texts(snapshot).includes(told));
    await Bun.sleep(500);
    const settled = RuntimeSnapshotSchema.parse(await request('/'));
    assert.equal(texts(settled).filter(text => text === told).length, 1, 'The invalid block was noticed more than once');
    assert.equal(texts(settled).at(-1), told, 'The block notice started a turn');
    const mainId = settled.conversations.find(item => item.title === 'Workspace')!.id;
    const tasks = z.array(z.object({ conversationId: z.string(), state: z.string() })).parse(await request('/live-tasks'));
    assert(!tasks.some(task => task.conversationId === mainId && task.state !== 'terminal'), 'The block notice left work running');
    console.log('PASS an invalid block in the agent\'s reply is noticed once and starts no turn');
  }


  // Both public answer surfaces must restart a persisted suspended Pi task by themselves.
  for (const surface of ['session', 'answer'] as const) {
    const before = assistantReplies(RuntimeSnapshotSchema.parse(await request('/')));
    await request(`/submit?text=ask%20for%20a%20color&requestId=ask-${surface}`);
    const pending = await until(snapshot => snapshot.questions.some(question => question.kind === 'ask' && question.answer === null));
    const question = pending.questions.find(item => item.kind === 'ask' && item.answer === null)!;
    assert.equal(summary(pending).primaryColor, 'orange', 'A question for the user is not amber');
    await worker.dispose();
    worker = new Miniflare(options);
    const recovered = (await session({ type: 'control' })).control;
    assert.equal(recovered.pendingAsk?.id, question.id, 'Cold restart lost pending ask');
    if (surface === 'session') await session({ type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['blue'], customInput: null }] });
    else await request('/answer', { ...identity, questionId: question.id, answer: 'green' });
    await until(snapshot => assistantReplies(snapshot) > before && snapshot.questions.find(item => item.id === question.id)?.answer !== null);
    assert.equal((await session({ type: 'control' })).control.pendingAsk, null);
  }

  // An idle workspace holds no alarm: waiting for the user is not work, so a wake re-arms nothing and reads little. An
  // event that arrives meanwhile waits for the run to end, not for a wake.
  {
    const before = assistantReplies(RuntimeSnapshotSchema.parse(await request('/')));
    await request('/submit?text=ask%20for%20a%20color&requestId=idle-wake');
    const pending = await until(snapshot => snapshot.questions.some(question => question.kind === 'ask' && question.answer === null));
    const question = pending.questions.find(item => item.kind === 'ask' && item.answer === null)!;
    await request('/report', { ...identity, name: 'Reporter', requestId: 'idle-wake-report', outcome: 'finished', excerpt: 'Report held while the agent waits' });
    const wake = z.object({ alarm: z.number().nullable(), rowsRead: z.number() }).parse(await request('/idle-wake'));
    assert.equal(wake.alarm, null, `A wake while the workspace waits for the user left an alarm for ${wake.alarm === null ? '' : new Date(wake.alarm).toISOString()}`);
    assert(wake.rowsRead <= IDLE_WAKE_ROWS, `An idle wake read ${wake.rowsRead} rows (budget ${IDLE_WAKE_ROWS})`);
    await request('/answer', { ...identity, questionId: question.id, answer: 'blue' });
    await until(snapshot => assistantReplies(snapshot) > before && snapshot.questions.find(item => item.id === question.id)?.answer !== null);
    await until(snapshot => snapshot.conversations.flatMap(item => item.messages).some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.includes('Report held while the agent waits'))));
    console.log(`PASS an idle wake leaves no alarm and reads ${wake.rowsRead} rows (budget ${IDLE_WAKE_ROWS}); the event held meanwhile goes in when the run ends`);
  }

  for (const answer of [false, true]) {
    await session({ type: 'setWorkspacePhase', phase: 'plan' });
    assert.equal((await session({ type: 'control' })).control.planMode, true);
    const before = assistantReplies(RuntimeSnapshotSchema.parse(await request('/')));
    await request('/submit?text=propose%20a%20plan');
    const pending = await until(snapshot => snapshot.questions.some(item => item.kind === 'approval' && item.answer === null));
    const question = pending.questions.find(item => item.kind === 'approval' && item.answer === null)!;
    assert.equal(summary(pending).primaryColor, 'orange', 'A pending approval is not orange');
    assert.equal((await session({ type: 'control' })).control.pendingAsk, null, 'Approval leaked into ask-only control');
    await request('/answer', { ...identity, questionId: question.id, answer: answer ? 'Approve' : 'Reject' }, true);
    await request('/session', { ...identity, command: { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Approve'], customInput: null }] }, canApprove: true }, true);
    assert.equal(RuntimeSnapshotSchema.parse(await request('/')).questions.find(item => item.id === question.id)?.answer, null);
    const decision = { approved: answer, note: null };
    await request('/answer', { ...identity, questionId: question.id, answer: decision });
    const completed = await until(snapshot => assistantReplies(snapshot) > before);
    assert.deepEqual(completed.questions.find(item => item.id === question.id)?.answer, decision);
    const workspace = z.object({ phase: z.string() }).parse(completed.documents['gitspace.workspace']);
    assert.equal(workspace.phase, answer ? 'code' : 'plan');
    const control = (await session({ type: 'control' })).control;
    assert.equal(control.planMode, workspace.phase === 'plan');
    assert.equal(control.plan?.status, answer ? 'approved' : 'rejected');
  }
  console.log('PASS cold ask recovery, both answer surfaces, idle watch, approval authority and canonical phase');
  console.log('PASS bounded tasks and full receipts', await request('/burst'));
  const scope = z.object({ root: z.string(), child: z.string(), sibling: z.string(), grandchild: z.string() }).parse(await request('/scoped-stop-seed'));
  await until(snapshot => Object.values(scope).every(id => snapshot.questions.some(question => question.conversationId === id && question.answer === null)));
  const liveTasks = async () => z.array(z.object({ id: z.string(), conversationId: z.string(), kind: z.string(), state: z.string() })).parse(await request('/live-tasks'));
  const scopedTasks = await liveTasks();
  assert(Object.values(scope).every(id => scopedTasks.some(task => task.conversationId === id && task.state !== 'terminal')), 'Scoped Stop must start with real live tasks in all four conversations');
  assert.equal(scopedTasks.filter(task => task.kind === 'gitspace.BackgroundAgent' && task.state !== 'terminal').length, 2, 'Background ownership waiters were not live');
  await request(`/submit?conversationId=${scope.child}&text=Forbidden%20child%20message`, undefined, true);
  await request('/session', { ...identity, conversationId: scope.child, command: { type: 'prompt', text: 'Forbidden child prompt' } }, true);
  await session({ type: 'stop' }, scope.child);
  const afterChildStop = await liveTasks();
  for (const id of [scope.child, scope.grandchild]) assert(!afterChildStop.some(task => task.conversationId === id && task.state !== 'terminal'), 'Child Stop left a descendant task running');
  const stoppedSnapshot = RuntimeSnapshotSchema.parse(await request('/'));
  assert(!stoppedSnapshot.questions.some(question => [scope.child, scope.grandchild].includes(question.conversationId) && question.answer === null), 'Stopped child retained an actionable question');
  assert(stoppedSnapshot.conversations.filter(conversation => [scope.child, scope.grandchild].includes(conversation.id)).every(conversation => conversation.status === 'idle'), 'Stopped child still appears active');
  for (const id of [scope.root, scope.sibling]) assert(afterChildStop.some(task => task.conversationId === id && task.state !== 'terminal'), 'Child Stop aborted main or sibling work');
  const backgroundDeadline = Date.now() + 5000;
  while ((await liveTasks()).filter(task => task.kind === 'gitspace.BackgroundAgent' && task.state !== 'terminal').length > 1 && Date.now() < backgroundDeadline) await Bun.sleep(20);
  assert.equal((await liveTasks()).filter(task => task.kind === 'gitspace.BackgroundAgent' && task.state !== 'terminal').length, 1, 'Child Stop did not settle its background owner independently');
  for (const type of ['usage', 'agentSetup', 'control'] as const) await session({ type }, scope.child);
  const beforeInspection = await liveTasks();
  assert(!beforeInspection.some(task => [scope.child, scope.grandchild].includes(task.conversationId) && task.state !== 'terminal'), 'Inspection resumed stopped work');
  await session({ type: 'stop' }, scope.root);
  assert(!(await liveTasks()).some(task => Object.values(scope).includes(task.conversationId) && task.state !== 'terminal'), 'Main Stop failed to cascade');
  await until(snapshot => summary(snapshot).agents.green === 0);
  console.log('PASS main-only input and scoped Stop with four live Pi conversations; stopped work is not green');
  const familyUsage = (await session({ type: 'usage' }, scope.root)).usage!;
  const childUsage = await Promise.all([scope.child, scope.sibling, scope.grandchild].map(async id => (await session({ type: 'usage' }, id)).usage!));
  assert.equal(familyUsage.totalsDeep.totalTokens, familyUsage.totals.totalTokens + childUsage.reduce((sum, report) => sum + report.totals.totalTokens, 0), 'Workspace usage omitted child inference');
  assert.equal(familyUsage.childSessions, 3);
  assert(familyUsage.byAgent.some(row => row.agentId === scope.child && row.agent === 'child'), 'Usage lost persisted subagent identity');

  const seeded = z.object({ conversationId: z.string(), ids: z.array(z.string()), pivot: z.string(), branches: z.array(z.string()) }).parse(await request('/history-seed'));
  // Re-open so history reads come from Pi storage alone, independent of live commit callbacks.
  await worker.dispose();
  worker = new Miniflare(options);
  const control = (await session({ type: 'control' }, seeded.conversationId)).control;
  assert(control.history.length <= 64);
  assert(control.history.every(entry => entry.text.length <= 4096));
  assert(control.history.reduce((sum, entry) => sum + entry.text.length, 0) <= 32 * 1024);
  assert(control.history.some(entry => entry.text.startsWith('history-618 ')), 'Bounded recall lost recent prompts');
  const anchor = seeded.ids.at(-1)!;
  let page = (await session({ type: 'historyPage', request: { anchorId: anchor, direction: 'around', cursor: null } }, seeded.conversationId)).historyPage!;
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    assert(++pages < 20, 'Old-history cursor did not terminate');
    assert(page.entries.length <= 401);
    assert(new TextEncoder().encode(JSON.stringify(page)).byteLength <= 256 * 1024);
    for (const entry of page.entries) { assert(!seen.has(entry.id), 'Old-history cursor duplicated an entry'); seen.add(entry.id); assert(entry.preview.length <= 1024); }
    if (!page.beforeCursor) break;
    page = (await session({ type: 'historyPage', request: { anchorId: anchor, direction: 'before', cursor: page.beforeCursor } }, seeded.conversationId)).historyPage!;
  }
  assert(seeded.ids.every(id => seen.has(id)), 'Pagination lost old source history');
  assert(pages > 1, 'History did not require bounded pagination');
  page = (await session({ type: 'historyPage', request: { anchorId: seeded.pivot, direction: 'children', cursor: null } }, seeded.conversationId)).historyPage!;
  const children = new Set<string>();
  pages = 0;
  for (;;) {
    assert(++pages < 10, 'Branch cursor did not terminate');
    assert(page.entries.length <= 200);
    assert(new TextEncoder().encode(JSON.stringify(page)).byteLength <= 256 * 1024);
    for (const entry of page.entries) { assert.equal(entry.parentId, seeded.pivot); assert(!children.has(entry.id)); children.add(entry.id); }
    if (!page.afterCursor) break;
    page = (await session({ type: 'historyPage', request: { anchorId: seeded.pivot, direction: 'children', cursor: page.afterCursor } }, seeded.conversationId)).historyPage!;
  }
  assert(seeded.branches.every(id => children.has(id)), 'Branch pagination lost fork children');
  assert(children.has(seeded.ids[21]!));
  assert.equal(children.size, seeded.branches.length + 1);
  assert(pages > 1);
  console.log('PASS bounded recall, 620-entry old-history pagination, 205 sibling branches, cold reopen');
  let transcript = (await session({ type: 'transcriptPage', request: { generation: null, before: null, after: null, around: null } }, seeded.conversationId)).transcriptPage!;
  const latestTranscript = transcript;
  const transcriptRows = new Map(transcript.rows.map(row => [row.id, row]));
  while (transcript.hasBefore) {
    const before = transcript.rows[0]!.ordinal;
    transcript = (await session({ type: 'transcriptPage', request: { generation: transcript.generation, before, after: null, around: null } }, seeded.conversationId)).transcriptPage!;
    assert(transcript.rows.length > 0 && transcript.rows.at(-1)!.ordinal < before, 'Transcript cursor must advance without overlap');
    for (const row of transcript.rows) { assert(!transcriptRows.has(row.id)); transcriptRows.set(row.id, row); }
  }
  for (let i = 0; i < 620; i++) assert([...transcriptRows.values()].some(row => row.item.type === 'message' && row.item.text.startsWith(`history-${i} `)), `Missing paged Pi prompt ${i}`);
  const expanded = latestTranscript.rows.find(row => row.item.type === 'message' && row.item.text.startsWith('history-619 '))!;
  assert(expanded.truncated, 'Large Pi message must use bounded preview');
  let content = '', offset = 0;
  for (;;) {
    const chunk = (await session({ type: 'transcriptContent', request: { generation: latestTranscript.generation, rowId: expanded.id, offset } }, seeded.conversationId)).transcriptContent!;
    assert.equal(chunk.offset, offset);
    assert(chunk.text.length <= 256 * 1024);
    content += chunk.text;
    if (chunk.nextOffset === null) break;
    assert(chunk.nextOffset > offset); offset = chunk.nextOffset;
  }
  assert.equal(JSON.parse(content).text, `history-619 ${'x'.repeat(600000)}`);
  const usageBefore = (await session({ type: 'usage' }, seeded.conversationId)).usage!;
  assert(usageBefore.totals.requests > 0);
  // A rejected request is counted and reports no tokens.
  assert(usageBefore.totals.input > 0 && usageBefore.totals.input < usageBefore.totals.requests);
  assert.equal(usageBefore.totals.totalTokens, usageBefore.totals.input + usageBefore.totals.output);
  await worker.dispose();
  worker = new Miniflare(options);
  const coldTranscript = (await session({ type: 'transcriptPage', request: { generation: latestTranscript.generation, before: null, after: null, around: null } }, seeded.conversationId)).transcriptPage!;
  assert.deepEqual(coldTranscript, latestTranscript);
  assert.deepEqual((await session({ type: 'usage' }, seeded.conversationId)).usage, usageBefore);
  const centered = (await session({ type: 'transcriptPage', request: { generation: latestTranscript.generation, before: null, after: null, around: expanded.id } }, seeded.conversationId)).transcriptPage!;
  assert(centered.rows.some(row => row.id === expanded.id));
  const fork = await session({ type: 'navigateTree', entryId: seeded.ids[20]! }, seeded.conversationId);
  const forkTranscript = (await session({ type: 'transcriptPage', request: { generation: latestTranscript.generation, before: null, after: null, around: null } }, fork.control.sessionId)).transcriptPage!;
  assert.notEqual(forkTranscript.generation, latestTranscript.generation);
  assert(forkTranscript.rows.some(row => row.item.type === 'message' && row.item.text.startsWith('history-20 ')));
  assert(!forkTranscript.rows.some(row => row.item.type === 'message' && row.item.text.startsWith('history-21 ')));
  await request('/session', { ...identity, conversationId: fork.control.sessionId, command: { type: 'transcriptContent', request: { generation: latestTranscript.generation, rowId: expanded.id, offset: 0 } } }, true);
  await request('/enable-definitions');
  const discovered = (await session({ type: 'agentSetup' }, seeded.conversationId)).setup!;
  const repositoryAgent = discovered.agents.find(agent => agent.path === '.agents/agents/repository.md');
  assert(repositoryAgent, 'Agent setup did not discover committed repository definitions');
  assert.equal(repositoryAgent.role, 'scout');
  assert.equal(repositoryAgent.provider, 'fixture');
  assert.equal(repositoryAgent.model, 'fixture');
  const override = { type: 'saveAgentDefinition' as const, path: repositoryAgent.path, expectedRevision: repositoryAgent.revision, content: '---\nname: Repository Scout\nmodel: pi/scout\ntools: read\n---\nCloud override survives recovery.' };
  await session(override, seeded.conversationId);
  await worker.dispose(); worker = new Miniflare(options);
  assert.equal((await session({ type: 'agentSetup' }, seeded.conversationId)).setup!.agents.find(agent => agent.path === override.path)?.content, override.content);
  const definition = { type: 'saveAgentDefinition' as const, path: '.agents/agents/smoke.md', expectedRevision: null, content: '---\nname: Smoke\n---\nFollow the cloud workspace instructions.' };
  const saved = (await session(definition, seeded.conversationId)).setup!;
  assert.equal(saved.agents.find(agent => agent.path === definition.path)?.content, definition.content);
  await request('/session', { ...identity, conversationId: seeded.conversationId, command: definition }, true);
  await worker.dispose();
  worker = new Miniflare(options);
  assert.deepEqual((await session({ type: 'agentSetup' }, seeded.conversationId)).setup, saved);
  console.log('PASS bounded canonical Pi transcript paging, oversized content expansion, cold cursors and cloud usage');

  // A generation can fail before any reply exists (a step around the request threw, as after a reset): it shows why,
  // and the next turn that runs clears it.
  await request('/fail-binding');
  await request('/submit?text=bind%20fails');
  const unbound = await until(snapshot => snapshot.conversations.some(item => item.status === 'failed' && (item.error ?? '').includes('fixture inference binding failed')));
  assert.equal(summary(unbound).primaryColor, 'red', 'A generation that failed without a reply is not red');
  await request('/fail-binding?on=false');
  await request('/submit?text=recover');
  await until(snapshot => !snapshot.conversations.some(item => item.status === 'failed'));
  console.log('PASS a generation that fails without a reply surfaces its error until the next turn runs');
} finally {
  try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('PASS runtime smoke; workerd instances and temporary storage disposed');
