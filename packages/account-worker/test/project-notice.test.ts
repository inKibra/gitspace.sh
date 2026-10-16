import { expect, test } from 'vitest';
import { emptyWorkspaceStatus, type WorkspaceReport, type WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { projectNotice } from '../src/account-runtime-host.js';

const report = (primaryColor: WorkspaceStatusColor, change: Partial<WorkspaceReport> = {}): WorkspaceReport => ({
  summary: { ...emptyWorkspaceStatus, primaryColor }, phase: 'plan', waitingOn: null, failure: null, lastReply: null, lastActivityAt: null, model: null, code: null, ...change,
});

test('a started workspace announces finishing only after it worked, and never the start of work', () => {
  const watched = (color: WorkspaceStatusColor) => ({ name: 'FEAT-33', color });
  // Starting: idle before the instruction arrives, then working. Neither is news.
  expect(projectNotice(watched('dim'), report('blue'))).toBeNull();
  expect(projectNotice(watched('blue'), report('green'))).toBeNull();
  // Working, then waiting for the user: a finished turn with its reply, or the question it asked.
  expect(projectNotice(watched('green'), report('blue', { lastReply: 'Plan drafted.' }))).toBe('Workspace FEAT-33 finished its turn: Plan drafted.');
  expect(projectNotice(watched('green'), report('blue', { waitingOn: { kind: 'ask', prompt: 'Which bucket?' } }))).toBe('Workspace FEAT-33 asked: Which bucket?');
  // Approvals and failures are announced from any other state.
  expect(projectNotice(watched('blue'), report('orange', { waitingOn: { kind: 'approval', prompt: 'Approve the plan?' } }))).toBe('Workspace FEAT-33 needs approval: Approve the plan?');
  expect(projectNotice(watched('green'), report('orange'))).toBe('Workspace FEAT-33 has a sync conflict.');
  expect(projectNotice(watched('green'), report('red', { failure: 'Model request failed' }))).toBe('Workspace FEAT-33 failed: Model request failed');
});
