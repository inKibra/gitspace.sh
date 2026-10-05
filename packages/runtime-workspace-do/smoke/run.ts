// Local-only regression proof: bun run --cwd packages/runtime-workspace-do smoke
// Uses synthetic providers with real Pi, workerd SQLite and a private local executor/supervisor. No tenant bindings.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { z } from 'zod';
import { RuntimeSnapshotSchema, RuntimeWatchEventSchema, RuntimeSessionResultSchema, type RuntimeSessionCommand, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { runExecutionProof } from './execution.js';

const identity = { projectId: 'smoke-project', workspaceId: 'smoke-workspace' };
const directory = await mkdtemp(join(tmpdir(), 'gitspace-runtime-smoke-'));
let worker: Miniflare | undefined;
try {
  const built = await Bun.build({ entrypoints: [new URL('./fixture.ts', import.meta.url).pathname], target: 'browser', external: ['cloudflare:workers'] });
  if (!built.success) throw new AggregateError(built.logs, 'Runtime smoke fixture build failed');
  assert.equal(built.outputs.length, 1);
  const contents = await built.outputs[0]!.text();
  const options = { modules: [{ type: 'ESModule' as const, path: join(directory, 'fixture.js'), contents }], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { SMOKE: { className: 'RuntimeSmoke', useSQLite: true }, REPLICA: { className: 'ReplicaSmoke', useSQLite: true } }, durableObjectsPersist: join(directory, 'state'), outboundService: () => { throw new Error('External network forbidden in runtime smoke'); } };
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
  console.log('PASS large Unicode replica, migration, bounded replay, atomic rollback', await request('/replica-proof'));

  // No mutation races with this request: snapshot and watch registration happen in one DO call.
  const watch = await fetch(new URL('/watch-current', await worker.ready));
  assert(watch.body);
  const reader = watch.body.getReader();
  let timer: NodeJS.Timeout | undefined;
  try {
    const first = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Current-cursor watch failed to emit an initial state')), 5000); })]);
    assert(!first.done);
    const event = RuntimeWatchEventSchema.parse(JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0]!));
    assert.equal(event.type, 'snapshot');
  } finally { clearTimeout(timer); await reader.cancel(); }

  // Both public answer surfaces must restart a persisted suspended Pi task by themselves.
  for (const surface of ['session', 'answer'] as const) {
    const before = assistantReplies(RuntimeSnapshotSchema.parse(await request('/')));
    await request(`/submit?text=ask%20for%20a%20color&requestId=fallback-${surface}`);
    const pending = await until(snapshot => snapshot.questions.some(question => question.kind === 'ask' && question.answer === null));
    const question = pending.questions.find(item => item.kind === 'ask' && item.answer === null)!;
    await worker.dispose();
    worker = new Miniflare(options);
    const recovered = (await session({ type: 'control' })).control;
    assert.equal(recovered.pendingAsk?.id, question.id, 'Cold restart lost pending ask');
    if (surface === 'session') await session({ type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['blue'], customInput: null }] });
    else await request('/answer', { ...identity, questionId: question.id, answer: 'green' });
    await until(snapshot => assistantReplies(snapshot) > before && snapshot.questions.find(item => item.id === question.id)?.answer !== null);
    assert.equal((await session({ type: 'control' })).control.pendingAsk, null);
    const notices = z.array(z.object({ requestId: z.string(), message: z.string() })).parse(await request('/fallback-notices'));
    const notice = notices.filter(item => item.requestId === `fallback-${surface}`);
    assert.equal(notice.length, 1, 'Model fallback notice must survive cold tool continuation without duplication');
    assert(notice[0]!.message.includes('fixture/removed'));
  }

  await request('/session', { ...identity, command: { type: 'setApproval', approvalMode: 'yolo' }, canApprove: false }, true);
  assert.equal((await session({ type: 'control' })).control.approvalMode, 'write');
  for (const answer of [false, true]) {
    await session({ type: 'setWorkspacePhase', phase: 'plan' });
    assert.equal((await session({ type: 'control' })).control.planMode, true);
    const before = assistantReplies(RuntimeSnapshotSchema.parse(await request('/')));
    await request('/submit?text=propose%20a%20plan');
    const pending = await until(snapshot => snapshot.questions.some(item => item.kind === 'approval' && item.answer === null));
    const question = pending.questions.find(item => item.kind === 'approval' && item.answer === null)!;
    assert.equal((await session({ type: 'control' })).control.pendingAsk, null, 'Approval leaked into ask-only control');
    await request('/answer', { ...identity, questionId: question.id, answer: answer ? 'Approve' : 'Reject' }, true);
    await request('/session', { ...identity, command: { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Approve'], customInput: null }] }, canApprove: true }, true);
    assert.equal(RuntimeSnapshotSchema.parse(await request('/')).questions.find(item => item.id === question.id)?.answer, null);
    await request('/answer', { ...identity, questionId: question.id, answer });
    const completed = await until(snapshot => assistantReplies(snapshot) > before);
    assert.equal(completed.questions.find(item => item.id === question.id)?.answer, answer);
    const workspace = z.object({ phase: z.string() }).parse(completed.documents['gitspace.workspace']);
    assert.equal(workspace.phase, answer ? 'code' : 'plan');
    assert.equal((await session({ type: 'control' })).control.planMode, workspace.phase === 'plan');
  }
  console.log('PASS cold ask recovery, both answer surfaces, idle watch, approval authority and canonical phase');
  console.log('PASS browser approval binds displayed resolved preparation', await request('/browser-approval-proof'));
  console.log('PASS stable placement permits only detached-primary handoff', await request('/placement-handoff-proof'));
  console.log('PASS bounded tasks and full receipts', await request('/burst'));

  const seeded = z.object({ conversationId: z.string(), ids: z.array(z.string()), pivot: z.string(), branches: z.array(z.string()) }).parse(await request('/history-seed'));
  // Re-open so the index must survive/recover independently of live commit callbacks.
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
  console.log('PASS bounded recall, 620-entry old-history pagination, 205 sibling branches, cold index recovery');
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
  assert.equal(usageBefore.totals.input, usageBefore.totals.requests);
  assert.equal(usageBefore.totals.output, usageBefore.totals.requests);
  assert.equal(usageBefore.totals.totalTokens, usageBefore.totals.requests * 2);
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
  const definition = { type: 'saveAgentDefinition' as const, path: '.agents/agents/smoke.md', expectedRevision: null, content: '---\nname: Smoke\n---\nFollow the cloud workspace instructions.' };
  const saved = (await session(definition, seeded.conversationId)).setup!;
  assert.equal(saved.agents.find(agent => agent.path === definition.path)?.content, definition.content);
  await request('/session', { ...identity, conversationId: seeded.conversationId, command: definition }, true);
  await worker.dispose();
  worker = new Miniflare(options);
  assert.deepEqual((await session({ type: 'agentSetup' }, seeded.conversationId)).setup, saved);
  console.log('PASS bounded canonical Pi transcript paging, oversized content expansion, cold cursors and cloud usage');
} finally {
  try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
}
await runExecutionProof();
console.log('PASS runtime smoke; workerd instances and temporary storage disposed');
