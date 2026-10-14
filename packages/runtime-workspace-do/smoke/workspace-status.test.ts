import { expect, test } from 'bun:test';
import { RuntimeSnapshotSchema, RuntimeWorkspaceStatusSchema, type RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import { agentActivity, agentCounts, conversationStatus, workspaceStatusSummary, type LiveAgents } from '../src/workspace-status.js';

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

test('an approval waiting on a person is orange even while its task runs; a question waits blue', () => {
  const tasks = [{ conversationId: 'main', background: false }];
  const approval = summarize({ conversations: [main], tasks, questions: [{ conversationId: 'main', kind: 'approval', answer: null }] });
  expect(approval.summary.primaryColor).toBe('orange');
  expect(approval.statuses).toEqual({ main: 'waiting' });
  const question = summarize({ conversations: [main], tasks, questions: [{ conversationId: 'main', kind: 'ask', answer: null }] });
  expect(question.summary.primaryColor).toBe('blue');
  const answered = summarize({ conversations: [main], tasks, questions: [{ conversationId: 'main', kind: 'approval', answer: true }] });
  expect(answered.summary.primaryColor).toBe('green');
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
