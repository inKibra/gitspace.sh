import { expect, test } from 'bun:test';
import { RuntimeSnapshotSchema, RuntimeWorkspaceStatusSchema, type RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import { agentActivity, agentCounts, conversationStatus, workspacePlanStep, workspaceStatusSummary, workspaceWaiting, type LiveAgents } from '../src/workspace-status.js';

const noMachines: Pick<RuntimeWorkspaceStatus, 'cloud' | 'machines'> = { cloud: { version: null, conflicts: [] }, machines: [] };
const main = { id: 'main', parentId: null, failure: null };
const child = { id: 'child', parentId: 'main', failure: null };

function summarize(live: LiveAgents, status = noMachines) {
  const activity = agentActivity(live);
  return { summary: workspaceStatusSummary(agentCounts(live.conversations, activity), status), statuses: Object.fromEntries([...activity].map(([id, state]) => [id, conversationStatus(state)])) };
}

test('a conversation stored as running is not green without a live task', () => {
  // The replica a reset object restores still says running; only live tasks decide.
  const stored = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 7, conversations: [{ id: 'main', parentId: null, title: 'Workspace', status: 'running', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} });
  const result = summarize({ conversations: stored.conversations.map(conversation => ({ ...conversation, failure: conversation.error ?? null })), tasks: [], questions: [] });
  expect(result.summary.primaryColor).toBe('blue');
  expect(result.summary.agents).toEqual({ green: 0, blue: 1, orange: 0, red: 0 });
  expect(result.statuses).toEqual({ main: 'idle' });
});

test('a live foreground task is green; background work alone is not', () => {
  const working = summarize({ conversations: [main, child], tasks: [{ conversationId: 'child', background: false }], questions: [] });
  expect(working.summary.primaryColor).toBe('green');
  expect(working.statuses).toEqual({ main: 'idle', child: 'running' });
  const background = summarize({ conversations: [main], tasks: [{ conversationId: 'main', background: true }], questions: [] });
  expect(background.summary.primaryColor).toBe('blue');
  expect(background.statuses).toEqual({ main: 'idle' });
});

test('a question or approval waiting on a person is orange even while its task runs', () => {
  const tasks = [{ conversationId: 'main', background: false }];
  const approval = summarize({ conversations: [main], tasks, questions: [{ conversationId: 'main', kind: 'approval', answer: null }] });
  expect(approval.summary.primaryColor).toBe('orange');
  expect(approval.statuses).toEqual({ main: 'waiting' });
  const question = summarize({ conversations: [main], tasks, questions: [{ conversationId: 'main', kind: 'ask', answer: null }] });
  expect(question.summary.primaryColor).toBe('orange');
  const answered = summarize({ conversations: [main], tasks, questions: [{ conversationId: 'main', kind: 'approval', answer: true }] });
  expect(answered.summary.primaryColor).toBe('green');
});

test('a closed question waits on no one: the workspace is not orange for it', () => {
  for (const reason of ['dismissed', 'stopped', 'expired', 'replied'] as const) {
    const closed = summarize({ conversations: [main], tasks: [], questions: [{ conversationId: 'main', kind: 'ask', answer: null, closed: { reason, at: '2026-11-13T10:00:00.000Z' } }] });
    expect(closed.summary.primaryColor).toBe('blue');
    expect(closed.statuses).toEqual({ main: 'idle' });
  }
});

test('a failed main conversation is red until a task runs again; a failed subagent reports to its parent', () => {
  const failed = { ...main, failure: 'The model request failed' };
  const red = summarize({ conversations: [failed], tasks: [], questions: [] });
  expect(red.summary.primaryColor).toBe('red');
  expect(red.statuses).toEqual({ main: 'failed' });
  expect(summarize({ conversations: [failed], tasks: [{ conversationId: 'main', background: false }], questions: [] }).summary.primaryColor).toBe('green');
  expect(summarize({ conversations: [main, { ...child, failure: 'The model request failed' }], tasks: [], questions: [] }).summary).toMatchObject({ primaryColor: 'blue', agents: { blue: 1, red: 0 } });
});

test('sync conflicts need a person; machines and sync problems are counted', () => {
  const machine = { machineId: 'desk', attachmentId: 'a', generation: 1, online: true, ready: false, setup: [], sync: { lastSyncAt: null, unsent: null, unapplied: false, problem: 'push rejected', conflicts: ['src/a.ts'] } };
  const machines = RuntimeWorkspaceStatusSchema.shape.machines.parse([machine, { ...machine, attachmentId: 'b', machineId: 'laptop', online: false, sync: { ...machine.sync, problem: null } }]);
  const result = summarize({ conversations: [main], tasks: [], questions: [] }, { cloud: { version: 'abc', conflicts: ['src/a.ts'] }, machines });
  expect(result.summary).toEqual({ primaryColor: 'orange', agents: { green: 0, blue: 1, orange: 0, red: 0 }, machines: { attached: 2, online: 1, ready: 0 }, sync: { conflicts: 1, problems: 1 } });
});

test('a workspace with two open questions and an approval reports all three, with who asks and what it waits on', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const questions = [
    { id: 'bucket', conversationId: 'main', kind: 'ask' as const, prompt: 'Which bucket should exports go to?', choices: ['archive', 'hot'], answer: null, askedAt: '2026-11-23T10:00:00.000Z' },
    { id: 'region', conversationId: 'child', kind: 'ask' as const, prompt: 'Which region?', choices: [], answer: null, askedAt: '2026-11-23T10:01:00.000Z' },
    { id: 'setup', conversationId: 'main', kind: 'lifecycle-approval' as const, prompt: 'Run materialize', choices: [], answer: null, askedAt: '2026-11-23T10:02:00.000Z',
      lifecycle: { phase: 'workspace/materialize' as const, callId: 'call-1', scripts: [{ hash, kind: 'script' as const, label: 'Materialize', phase: 'workspace/materialize' as const, fileName: 'scripts/materialize.sh', content: 'npm ci', previous: null }] } },
    { id: 'done', conversationId: 'main', kind: 'ask' as const, prompt: 'Answered already', choices: [], answer: 'yes', askedAt: '2026-11-23T09:00:00.000Z' },
  ];
  const waiting = workspaceWaiting({ rootId: 'main', agents: new Map([['child', 'researcher']]), questions, failure: null, machines: [], attachments: [], conflicts: [] });
  expect(waiting).toEqual({ more: 0, items: [
    { kind: 'ask', key: 'bucket', since: '2026-11-23T10:00:00.000Z', title: 'Which bucket should exports go to?', characters: 34, conversation: { id: 'main', agent: null }, choices: ['archive', 'hot'] },
    { kind: 'ask', key: 'region', since: '2026-11-23T10:01:00.000Z', title: 'Which region?', characters: 13, conversation: { id: 'child', agent: 'researcher' }, choices: [] },
    { kind: 'lifecycle-approval', key: 'setup', since: '2026-11-23T10:02:00.000Z', title: 'Run materialize', characters: 15, conversation: { id: 'main', agent: null }, phase: 'workspace/materialize', more: 0,
      scripts: [{ hash, label: 'Materialize', fileName: 'scripts/materialize.sh', phase: 'workspace/materialize' }] },
  ] });
});

test('a failed setup step reports its last log line, and past twenty items the rest are counted', () => {
  const machine = { machineId: 'desk', attachmentId: 'a', generation: 1, online: true, ready: false, sync: { lastSyncAt: null, unsent: null, unapplied: false, problem: null, conflicts: [] },
    setup: [{ phase: 'workspace/materialize' as const, state: 'failed' as const, runId: 'run-7', error: 'fetching certificate\nerror: certificate expired\n' }] };
  const questions = Array.from({ length: 21 }, (_, index) => ({ id: `q${index}`, conversationId: 'main', kind: 'ask' as const, prompt: `Question ${index}`, choices: [], answer: null, askedAt: `2026-11-23T10:${String(index).padStart(2, '0')}:00.000Z` }));
  const waiting = workspaceWaiting({ rootId: 'main', agents: new Map(), questions, failure: 'Provider refused', machines: RuntimeWorkspaceStatusSchema.shape.machines.parse([machine]), attachments: [{ attachmentId: 'a', updatedAt: '2026-11-23T09:00:00.000Z' }], conflicts: [] });
  expect(waiting.items).toHaveLength(20);
  expect(waiting.more).toBe(3);
  expect(waiting.items[0]).toMatchObject({ kind: 'setup-failed', machineId: 'desk', runId: 'run-7', lastLine: 'error: certificate expired', since: '2026-11-23T09:00:00.000Z' });
});

test('the plan step is the active step of the plan in effect; none without an approved plan', () => {
  const step = (id: string, status: 'pending' | 'active' | 'completed') => ({ id, title: `Step ${id}`, detail: '', where: [], requirementIds: [], status });
  expect(workspacePlanStep({ status: 'approved', steps: [step('a', 'completed'), step('b', 'active'), step('c', 'pending')] })).toEqual({ index: 2, count: 3, title: 'Step b' });
  // A revision waiting for approval leaves the approved plan in effect.
  expect(workspacePlanStep({ status: 'proposed', steps: [step('x', 'pending')], approved: { steps: [step('a', 'completed'), step('b', 'pending')] } })).toEqual({ index: 2, count: 2, title: 'Step b' });
  expect(workspacePlanStep({ status: 'proposed', steps: [step('x', 'pending')], approved: null })).toBeNull();
  expect(workspacePlanStep(undefined)).toBeNull();
});
