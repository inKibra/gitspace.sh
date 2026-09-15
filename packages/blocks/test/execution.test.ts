import { describe, expect, it } from 'bun:test';
import {
  collectTranscriptProjection, executionAgentId, executionIdentity, extractExecutions, TranscriptProjector,
  transcriptItemSchema, transcriptPageRequestSchema,
  type CollectedTranscriptProjection, type ExecutionBlock, type TranscriptEventInput, type TranscriptItem, type TranscriptProjectionStore,
} from '../src/index.js';

function event(ordinal: number, kind: string, payload: Record<string, unknown> = {}): TranscriptEventInput {
  return { sessionId: 'session', ordinal, kind, payload, createdAt: `2026-01-01T00:00:${String(ordinal).padStart(2, '0')}.000Z` };
}
function call(ordinal: number, tool: string, args: Record<string, unknown>, details: unknown, output = 'Complete original output'): TranscriptEventInput[] {
  const toolCallId = `call-${ordinal}`;
  return [
    event(ordinal, 'tool_execution_start', { toolCallId, toolName: tool, args }),
    event(ordinal + 1, 'tool_execution_end', { toolCallId, result: output, details }),
  ];
}
function executions(projection: CollectedTranscriptProjection): ExecutionBlock[] {
  return projection.turns.flatMap((turn) => turn.items).filter((item): item is ExecutionBlock => item.type === 'execution');
}

const daemon = { id: 'daemon-instance', name: 'web', state: 'ready', startedAt: 1000, restartCount: 0 };

describe('execution projection', () => {
  it('scopes reused bg_N jobs by explicit launch rows and never merges an ambiguous revival', () => {
    const background = { async: { type: 'bash', jobId: 'bg_5', state: 'running' } };
    const projection = collectTranscriptProjection([
      ...call(1, 'bash', { command: 'same command', async: true }, background),
      ...call(3, 'hub', { op: 'jobs' }, { jobs: [{ id: 'bg_5', type: 'bash', status: 'failed', label: 'Old run', durationMs: 10 }] }),
      ...call(5, 'hub', { op: 'wait' }, { jobs: [{ id: 'bg_5', type: 'bash', status: 'running', label: 'Ambiguous snapshot', durationMs: 1 }] }),
      ...call(7, 'bash', { command: 'same command', async: true }, background),
      ...call(9, 'hub', { op: 'wait' }, { jobs: [{ id: 'bg_5', type: 'bash', status: 'running', label: 'Current run', durationMs: 2 }] }),
      event(11, 'tool_execution_update', { toolCallId: 'call-1', partialResult: { details: background, content: [{ type: 'text', text: 'Delayed old launch update' }] } }),
      ...call(12, 'hub', { op: 'jobs' }, { jobs: [{ id: 'bg_5', type: 'bash', status: 'running', label: 'Current run', durationMs: 3 }] }),
    ]);
    const cards = executions(projection);
    expect(cards.map((card) => [card.status, card.hasFailures, card.historyCount, card.durationMs])).toEqual([
      ['failed', true, 2, 10], ['running', false, 3, 3],
    ]);
    expect(cards[0]!.executionId).not.toBe(cards[1]!.executionId);
    expect(projection.links.filter((link) => link.executionId === cards[0]!.id).map((link) => link.rowId)).toEqual(['session:tool:call-1', 'session:tool:call-3']);
    expect(projection.links.filter((link) => link.executionId === cards[1]!.id).map((link) => link.rowId)).toEqual(['session:tool:call-7', 'session:tool:call-9', 'session:tool:call-12']);
    expect(projection.turns.flatMap((turn) => turn.items).filter((item) => item.type === 'tool-call').map((item) => item.toolCallId)).toEqual(['call-5']);
  });

  it('uses exact runtime start metadata for reused IDs without an observed new launch', () => {
    const projection = collectTranscriptProjection([
      ...call(1, 'bash', { async: true }, { async: { type: 'bash', jobId: 'bg_1', state: 'running', startedAt: 1000 } }),
      ...call(3, 'hub', { op: 'jobs' }, { jobs: [{ id: 'bg_1', type: 'bash', status: 'completed', label: 'First', startedAt: 1000 }] }),
      ...call(5, 'hub', { op: 'jobs' }, { jobs: [{ id: 'bg_1', type: 'bash', status: 'running', label: 'Second', startedAt: 2000 }] }),
      event(7, 'message_end', { message: { role: 'custom', customType: 'async-result', display: true, content: 'Late first result', details: {
        jobs: [{ jobId: 'bg_1', type: 'bash', status: 'failed', startedAt: 1000 }],
      } } }),
      ...call(8, 'hub', { op: 'jobs' }, { jobs: [{ id: 'bg_1', type: 'bash', status: 'running', label: 'Second', startedAt: 2000 }] }),
    ]);
    expect(executions(projection).map((card) => [card.status, card.startedAt, card.historyCount])).toEqual([
      ['failed', '1970-01-01T00:00:01.000Z', 3], ['running', '1970-01-01T00:00:02.000Z', 2],
    ]);
  });

  it('hides only a complete single-cell Eval made entirely of structured Hub observation displays', () => {
    const jsonOutputs = [{
      text: 'Finished',
      details: { op: 'wait', jobs: [{ id: 'bg_5', type: 'bash', status: 'completed', label: 'gh run watch', durationMs: 100 }] },
    }, {
      text: 'Still running',
      details: { op: 'jobs', jobs: [{ id: 'bg_6', type: 'eval', status: 'running', label: 'Evaluate', durationMs: 20 }] },
    }];
    const output = jsonOutputs.map((value, index) => `display[${index + 1}]:\n${JSON.stringify(value, null, 2)}`).join('\n\n');
    const details = { jsonOutputs, statusEvents: [{ op: 'hub', chars: 8 }, { op: 'hub', chars: 13 }],
      cells: [{ index: 0, status: 'complete', output }] };
    const pure = collectTranscriptProjection(call(1, 'eval', {}, details, output));
    expect(executions(pure).map((card) => [card.kind, card.status, card.historyCount])).toEqual([
      ['job', 'done', 1], ['job', 'running', 1],
    ]);
    expect(pure.turns.flatMap((turn) => turn.items).some((item) => item.type === 'tool-call')).toBe(false);
    expect(pure.rows.find((row) => row.item.type === 'tool-call')!.item).toMatchObject({ result: [{ text: output }], details });
    expect(pure.links.every((link) => link.hide)).toBe(true);
    for (const mixed of [
      { ...details, cells: [{ index: 0, status: 'complete', output: `Additional stdout\n${output}` }] },
      { ...details, statusEvents: [...details.statusEvents, { op: 'read', chars: 1 }] },
      { ...details, cells: [...details.cells, { index: 1, status: 'complete', output: '' }] },
    ]) {
      const projection = collectTranscriptProjection(call(1, 'eval', {}, mixed, output));
      expect(executions(projection)).toHaveLength(2);
      expect(projection.turns.flatMap((turn) => turn.items).filter((item) => item.type === 'tool-call')).toHaveLength(1);
      expect(projection.links.every((link) => !link.hide)).toBe(true);
    }
  });

  it('updates a Bash job from a structured Eval Hub wait and preserves mixed Eval work', () => {
    const hubResult = {
      text: 'Background job is still running',
      details: { op: 'wait', jobs: [{ id: 'bg_5', type: 'bash', status: 'running', label: 'gh run watch', durationMs: 1300155 }] },
    };
    const evalDetails = {
      jsonOutputs: [hubResult],
      statusEvents: [{ op: 'hub', chars: 92 }],
      cells: [{ index: 0, status: 'complete', output: 'Independent stdout plus the displayed result',
        statusEvents: [{ op: 'hub', chars: 92 }] }],
    };
    const projection = collectTranscriptProjection([
      ...call(1, 'bash', { command: 'gh run watch', async: true }, { async: { type: 'bash', jobId: 'bg_5', state: 'running' } }),
      event(3, 'turn_end'),
      ...call(4, 'eval', { code: 'display(await tool.hub({op: \"wait\"}))' }, evalDetails),
      ...call(6, 'eval', { code: 'arbitrary displayed object, not a Hub invocation' }, {
        jsonOutputs: [{ ...hubResult, details: { op: 'jobs', jobs: [{ id: 'unrelated', type: 'task', status: 'completed' }] } }],
        statusEvents: [{ op: 'read', chars: 92 }],
      }),
    ]);
    expect(executions(projection)).toEqual([expect.objectContaining({
      kind: 'job', status: 'running', historyCount: 2, durationMs: 1300155,
    })]);
    const evalRows = projection.turns.flatMap((turn) => turn.items).filter((item) => item.type === 'tool-call' && item.tool === 'eval');
    expect(evalRows).toHaveLength(2);
    expect(evalRows[0]).toMatchObject({ details: evalDetails, result: [{ text: 'Complete original output' }] });
    expect(projection.links.find((link) => link.rowId === evalRows[0]!.id)).toMatchObject({ hide: false });
    expect(projection.links.some((link) => link.rowId === evalRows[1]!.id)).toBe(false);
  });

  it('keeps a current turn pending when an earlier turn tool finishes late', () => {
    const projection = collectTranscriptProjection([
      event(1, 'tool_execution_start', { toolCallId: 'old', toolName: 'bash', args: { command: 'first' } }),
      event(2, 'turn_end'), event(3, 'turn_start'),
      event(4, 'tool_execution_start', { toolCallId: 'current', toolName: 'read', args: { path: 'file' } }),
      event(5, 'tool_execution_end', { toolCallId: 'old', result: 'first finished', details: { async: { type: 'bash', jobId: 'first', state: 'completed' } } }),
    ]);
    expect(projection.turns.find((turn) => turn.id === 'session:turn:3')!.status).toBe('running');
    expect(projection.rows.find((row) => row.item.type === 'tool-call' && row.item.toolCallId === 'old')).toMatchObject({
      turnId: 'session:turn:1', item: { status: 'done', result: [{ text: 'first finished' }] },
    });
  });

  it('attributes restart backoff to the failed old run, without a phantom run or false failure on stop', () => {
    const projection = collectTranscriptProjection([
      ...call(1, 'hub', { op: 'start', name: 'web' }, { daemon }),
      ...call(3, 'hub', { op: 'ps' }, { daemons: [{ ...daemon, state: 'restarting', restartCount: 1, exitedAt: 1500, exitCode: 1 }] }),
      ...call(5, 'hub', { op: 'logs', name: 'web' }, { daemon: { ...daemon, startedAt: 2000, restartCount: 1 } }),
      ...call(7, 'hub', { op: 'stop', name: 'web' }, { daemon: { ...daemon, startedAt: 2000, restartCount: 1, state: 'exited', exitedAt: 2500, exitCode: 143 } }),
    ]);
    expect(executions(projection).map((card) => [card.status, card.hasFailures, card.historyCount, card.durationMs])).toEqual([
      ['failed', true, 2, 500], ['done', false, 2, 500],
    ]);
  });

  it('links multi-job waits to both stable cards while retaining every full original call', () => {
    const originalOutput = 'full log '.repeat(10_000);
    const projection = collectTranscriptProjection([
      ...call(1, 'bash', { command: 'same command', async: true }, { async: { type: 'bash', jobId: 'one', state: 'running' } }),
      ...call(3, 'bash', { command: 'same command', async: true }, { async: { type: 'bash', jobId: 'two', state: 'running' } }),
      event(5, 'turn_end'), event(6, 'turn_start'),
      ...call(7, 'hub', { op: 'wait', ids: ['one', 'two'] }, { op: 'wait', jobs: [
        { id: 'one', type: 'bash', status: 'completed', label: 'same command', durationMs: 200, resultText: 'one finished' },
        { id: 'two', type: 'bash', status: 'failed', label: 'same command', durationMs: 300, errorText: 'two failed' },
      ] }, originalOutput),
    ]);
    const cards = executions(projection);
    expect(cards.map((card) => [card.kind, card.status, card.historyCount, card.hasFailures])).toEqual([
      ['job', 'done', 2, false], ['job', 'failed', 2, true],
    ]);
    expect(cards[0]!.id).not.toBe(cards[1]!.id);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]!.items.every((item) => item.type === 'execution')).toBe(true);
    const wait = projection.rows.find((row) => row.item.type === 'tool-call' && row.item.tool === 'hub')!;
    expect(wait.item).toMatchObject({ args: { op: 'wait', ids: ['one', 'two'] }, result: [{ text: originalOutput }] });
    expect(projection.links.filter((link) => link.rowId === wait.item.id).map((link) => link.executionId)).toEqual(cards.map((card) => card.id));
    expect(projection.rows.filter((row) => row.item.type === 'execution').every((row) => row.turnId === 'session:turn:1')).toBe(true);
    expect(cards.every((card) => transcriptItemSchema.safeParse(card).success)).toBe(true);
  });

  it('deduplicates streaming, both result event forms and recovery replay without reviving completed work', () => {
    const records = new Map<string, { turnId: string; item: TranscriptItem }>();
    const links = new Map<string, Set<string>>();
    const runs = new Map<string, string>();
    const store: TranscriptProjectionStore = {
      read(id) { const row = records.get(id); return row ? structuredClone(row.item) : undefined; },
      write(turnId, item) { records.set(item.id, { turnId: records.get(item.id)?.turnId ?? turnId, item: structuredClone(item) }); },
      owner(id) { return records.get(id)?.turnId; },
      executionRun(identity, rowId) {
        for (const [executionId, members] of links) {
          if (members.has(rowId) && (executionId === identity || executionId.startsWith(`${identity}:run:`))) return executionId;
        }
        return runs.get(identity);
      },
      bindExecutionRun(identity, executionId) { runs.set(identity, executionId); },
      turn() {},
      linkExecution(executionId, rowId) {
        let members = links.get(executionId);
        if (!members) links.set(executionId, members = new Set());
        const inserted = !members.has(rowId);
        members.add(rowId);
        return inserted;
      },
    };
    const progress = { async: { jobId: 'compile', type: 'eval', state: 'running' } };
    const events = [
      event(1, 'tool_execution_start', { toolCallId: 'eval', toolName: 'eval', args: { code: 'await work()' } }),
      event(2, 'tool_execution_update', { toolCallId: 'eval', partialResult: { content: [{ type: 'text', text: 'progress' }], details: progress } }),
      event(3, 'tool_execution_end', { toolCallId: 'eval', result: 'backgrounded', details: progress }),
      event(4, 'message_end', { message: { role: 'toolResult', toolCallId: 'eval', content: [{ type: 'text', text: 'backgrounded' }], details: progress } }),
      event(5, 'turn_end'),
      event(6, 'message_end', { message: { role: 'custom', customType: 'async-result', display: true, content: 'final output', details: {
        jobs: [{ jobId: 'compile', type: 'eval', status: 'failed', label: 'Compile', durationMs: 100 }],
      } } }),
      ...call(7, 'hub', { op: 'jobs' }, { jobs: [{ id: 'compile', type: 'eval', status: 'running', label: 'Old snapshot', durationMs: 10 }] }),
      ...call(9, 'eval', { code: 'await anotherRun()' }, progress),
      event(11, 'message_end', { message: { role: 'custom', customType: 'async-result', display: true, content: 'second run output', details: {
        jobs: [{ jobId: 'compile', type: 'eval', status: 'completed', label: 'Compile again', durationMs: 200 }],
      } } }),
    ];
    for (let replay = 0; replay < 2; replay++) {
      const projector = new TranscriptProjector('session', store);
      for (const entry of events) projector.apply(entry);
      projector.flush();
    }
    const card = [...records.values()].find((row) => row.item.type === 'execution')!.item;
    expect(card).toMatchObject({ type: 'execution', status: 'failed', hasFailures: true, historyCount: 2, durationMs: 100 });
    expect(records.get(card.id)!.turnId).toBe('session:turn:1');
    expect(records.get('session:tool:eval')!.item).toMatchObject({ result: [{ text: 'backgrounded' }], args: { code: 'await work()' } });
    expect([...records.values()].filter((row) => row.item.type === 'execution').map((row) => row.item)).toEqual([
      expect.objectContaining({ status: 'failed', historyCount: 2, durationMs: 100 }),
      expect.objectContaining({ status: 'done', historyCount: 2, durationMs: 200 }),
    ]);
  });

  it('separates daemon restart generations and new instances with the same process name', () => {
    const restarted = { ...daemon, startedAt: 2000, restartCount: 1 };
    const replacement = { ...daemon, id: 'replacement-instance', startedAt: 2000 };
    const projection = collectTranscriptProjection([
      ...call(1, 'hub', { op: 'start', name: 'web' }, { op: 'start', daemon }),
      ...call(3, 'hub', { op: 'logs', name: 'web' }, { op: 'logs', daemon, cursor: 2 }, 'first run logs'),
      ...call(5, 'hub', { op: 'wait', name: 'web', for: 'exit' }, { op: 'wait', daemon: { ...daemon, state: 'exited', exitedAt: 1500, exitCode: 0 } }),
      ...call(7, 'hub', { op: 'restart', name: 'web' }, { op: 'restart', daemon: restarted }),
      ...call(9, 'hub', { op: 'ps' }, { op: 'list', daemons: [restarted] }),
      ...call(11, 'hub', { op: 'describe', name: 'web' }, { op: 'describe', daemon: restarted, spec: { name: 'web', application: 'bun' } }),
      ...call(13, 'hub', { op: 'start', name: 'web' }, { op: 'start', daemon: replacement }),
      event(15, 'message_end', { message: { role: 'custom', customType: 'launch-completion', display: true, content: 'web failed', details: {
        daemons: [{ ...replacement, state: 'failed', exitedAt: 2500, exitCode: 2 }],
      } } }),
    ]);
    expect(executions(projection).map((card) => [card.kind, card.status, card.historyCount, card.durationMs])).toEqual([
      ['process', 'done', 3, 500], ['process', 'running', 3, undefined], ['process', 'failed', 2, 500],
    ]);
    expect(new Set(executions(projection).map((card) => card.executionId)).size).toBe(3);
    expect(projection.rows.filter((row) => row.item.type === 'tool-call' && row.item.tool === 'hub')).toHaveLength(7);
  });

  it('keeps mixed waits, cancellation outcomes, messages, unrelated tools and identity-less legacy logs visible', () => {
    const job = { id: 'one', type: 'bash', status: 'running', label: 'one', durationMs: 10 };
    const projection = collectTranscriptProjection([
      ...call(1, 'hub', { op: 'wait' }, { jobs: [job], waited: { id: 'message', from: 'Peer', body: 'Independent steering' } }),
      ...call(3, 'hub', { op: 'cancel', ids: ['one', 'missing'] }, { jobs: [{ ...job, status: 'cancelled' }], cancelled: [{ id: 'one', status: 'cancelled' }, { id: 'missing', status: 'not_found' }] }),
      ...call(5, 'hub', { op: 'send', to: 'Peer', message: 'one' }, { op: 'send', receipts: [{ id: 'message', status: 'delivered' }] }),
      ...call(7, 'hub', { op: 'logs', name: 'web' }, { op: 'logs', state: 'ready', cursor: 2 }),
      ...call(9, 'read', { path: 'one' }, { jobs: [job] }),
      ...call(11, 'hub', { op: 'wait', ids: ['one', 'missing'] }, { jobs: [job] }),
      event(13, 'message_end', { message: { role: 'custom', customType: 'irc:incoming', display: true, content: '<task-result id="one" agent="scout" status="completed">unrelated text</task-result>', details: { jobs: [job] } } }),
      ...call(14, 'hub', { op: 'jobs' }, { jobs: [{ id: 'untyped', status: 'completed', label: 'Not proven an agent' }] }),
    ]);
    const visible = projection.turns.flatMap((turn) => turn.items);
    expect(visible.filter((item) => item.type === 'tool-call')).toHaveLength(8);
    expect(executions(projection)).toEqual([expect.objectContaining({ kind: 'job', status: 'cancelled', historyCount: 2 })]);
    expect(projection.links.every((link) => !link.hide)).toBe(true);
  });

  it('correlates task batches and async completions by explicit agent identity, including distinct job IDs', () => {
    const projection = collectTranscriptProjection([
      ...call(1, 'task', { tasks: [{ name: 'Scout' }, { name: 'Reviewer' }] }, {
        async: { jobId: 'Scout-job-2', type: 'task', state: 'running' }, results: [], progress: [
          { id: 'Scout', agent: 'scout', status: 'pending', assignment: 'Inspect source', durationMs: 0 },
          { id: 'Reviewer', agent: 'reviewer', status: 'running', assignment: 'Review source', durationMs: 1 },
        ],
      }),
      event(3, 'turn_end'),
      ...call(4, 'hub', { op: 'wait' }, { jobs: [
        { id: 'Scout-job-2', agentUrlId: 'Scout', type: 'task', status: 'completed', label: 'Scout', durationMs: 20 },
      ] }),
      event(6, 'message_end', { message: { role: 'custom', customType: 'async-result', content: 'Review failed with full details', display: true, details: { jobs: [
        { jobId: 'Reviewer-job-2', agentUrlId: 'Reviewer', type: 'task', status: 'failed', durationMs: 30 },
      ] } } }),
      ...call(7, 'hub', { op: 'jobs' }, { jobs: [], agents: [{ id: 'External', live: true, activity: 'Independent work', ageMs: 5 }, { id: 'Scout', live: true, ageMs: 50 }] }),
    ]);
    expect(executions(projection).map((card) => [executionAgentId(card), card.status, card.historyCount])).toEqual([
      ['Scout', 'done', 2], ['Reviewer', 'failed', 2],
    ]);
    expect(projection.turns.flatMap((turn) => turn.sideAgents).map((agent) => agent.agentId)).toEqual(['External']);
    const original = projection.rows.find((row) => row.item.type === 'tool-call' && row.item.tool === 'async-result')!;
    expect(original.item).toMatchObject({ result: [{ text: 'Review failed with full details' }] });
  });

  it('allows queued/blocked progress transitions but retains failure evidence after a settled observation', () => {
    const projection = collectTranscriptProjection([
      ...call(1, 'task', {}, { progress: [{ id: 'agent', agent: 'task', status: 'pending', durationMs: 0 }] }),
      ...call(3, 'task', {}, { progress: [{ id: 'agent', agent: 'task', status: 'running', retryState: { attempt: 1 }, durationMs: 1 }] }),
      ...call(5, 'task', {}, { progress: [{ id: 'agent', agent: 'task', status: 'running', durationMs: 2 }] }),
      ...call(7, 'hub', { op: 'jobs' }, { jobs: [{ id: 'agent', type: 'task', status: 'completed', label: 'agent', durationMs: 3, structured: { status: 'invalid', error: 'Wrong output schema' } }] }),
      ...call(9, 'hub', { op: 'jobs' }, { jobs: [{ id: 'agent', type: 'task', status: 'completed', label: 'agent', durationMs: 3 }] }),
    ]);
    expect(executions(projection)).toEqual([expect.objectContaining({ status: 'done', hasFailures: true, historyCount: 5, summary: 'Wrong output schema' })]);
    const blocked = collectTranscriptProjection([
      ...call(1, 'task', {}, { progress: [{ id: 'agent', status: 'running', retryState: { attempt: 1 } }] }),
    ]);
    expect(executions(blocked)[0]!.status).toBe('blocked');
  });

  it('uses only known structured source schemas and keeps execution history selectors optional', () => {
    expect(extractExecutions({ sessionId: 's', tool: 'read', details: { async: { jobId: 'one', type: 'bash', state: 'running' } } }).observations).toEqual([]);
    expect(extractExecutions({ sessionId: 's', tool: 'hub', details: { jobs: [{ id: 'one', type: 'task', status: 'completed', resultText: '<task-result id="actual" agent="scout" status="failed (exit 2)"><output>failure</output></task-result>' }] } }).observations[0]).toMatchObject({ executionId: executionIdentity('s', 'agent', 'actual'), hasFailures: true });
    expect(transcriptPageRequestSchema.parse({ executionId: 'execution', before: 10 })).toMatchObject({ executionId: 'execution', before: 10 });
    expect(transcriptPageRequestSchema.parse({})).not.toHaveProperty('executionId');
    expect(transcriptPageRequestSchema.safeParse({ executionId: '', before: 10 }).success).toBe(false);
    expect(transcriptPageRequestSchema.safeParse({ executionId: 'execution', before: 10, after: 20 }).success).toBe(false);
  });
});
