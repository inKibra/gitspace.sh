import { expect, test } from 'vitest';
import { emptyLifecycleState, executionHash, type LifecycleExecution, type LifecycleState } from '@gitspace/protocol-environment';
import type { ArtifactsRepositoryReader } from '@gitspace/runtime-workspace-do';
import type { RuntimeLifecycleApprovalQuestion } from '@gitspace/protocol-runtime';
import { lifecycleApprovalRequest } from '../src/lifecycle-approval-card.js';

const merged = '#!/bin/sh\nbun install\n';
const edited = '#!/bin/sh\nbun install --frozen-lockfile\n';
const current = '#!/bin/sh\nbun install --frozen-lockfile --verbose\n';
const run = { method: 'runPhase', phase: 'machine/prepare', runId: 'prepare-1' };

async function script(phase: 'machine/prepare' | 'cloud/provision', fileName: string, content: string): Promise<LifecycleExecution> {
  return { id: `${phase}:${fileName}`, kind: 'script', label: fileName, command: `.gitspace/lifecycle/${phase}/${fileName}`, hash: await executionHash({ kind: 'script', command: content }), phase, fileName, content };
}

/** The working copy's history, newest commit first: each commit's lifecycle files by path. Blobs are named by content. */
function history(commits: Record<string, string>[]): { reader: ArtifactsRepositoryReader; commit: string } {
  const person = { name: 'Person', email: 'person@example.com' };
  const reader: ArtifactsRepositoryReader = {
    async log() { return commits.map((_files, index) => ({ hash: `commit-${index}`, treeHash: `tree-${index}:`, message: '', author: person, committer: person, parents: [], authoredAt: 0, committedAt: 0 })); },
    async readTree(oid) {
      const [root = '', prefix = ''] = oid.split(':');
      const files = commits[Number(root.slice('tree-'.length))];
      if (!files) return null;
      const entries = new Map<string, ArtifactsTreeEntry>();
      for (const [path, content] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const [name = '', ...nested] = path.slice(prefix.length).split('/');
        entries.set(name, nested.length ? { name, hash: `${root}:${prefix}${name}/`, mode: '40000', type: 'tree' } : { name, hash: `blob:${content}`, mode: '100755', type: 'exec' });
      }
      return [...entries.values()];
    },
    async readBlob(oid) { return oid.startsWith('blob:') ? new Blob([oid.slice('blob:'.length)]) : null; },
    async readCommit() { return null; },
    async close() {},
  };
  return { reader, commit: 'commit-0' };
}

/** A workspace whose `10-install.sh` changed since its merged version was approved for the project, beside an approved
 * script, an interactive one, a check and a script of another phase, none of those three approved. */
async function workspace(): Promise<LifecycleState> {
  const install = await script('machine/prepare', '10-install.sh', current);
  const approved = await script('machine/prepare', '20-approved.sh', 'echo approved\n');
  const interactive = await script('machine/prepare', '30-login.sh', '# gitspace: interactive\nread token\n');
  const provision = await script('cloud/provision', '10-db.sh', 'echo db\n');
  const check: LifecycleExecution = { id: 'node', kind: 'check', label: 'Node', command: 'node --version', hash: await executionHash({ kind: 'check', command: 'node --version' }), phase: null, fileName: null, content: 'node --version' };
  return { ...emptyLifecycleState('project', 'workspace'), executions: [check, install, approved, interactive, provision], approvals: [
    { scope: 'project', executionHash: await executionHash({ kind: 'script', command: merged }), approvedBy: 'github:merged:#1340', approvedAt: '2026-11-01T00:00:00.000Z' },
    { scope: 'workspace', executionHash: approved.hash, approvedBy: 'device-1', approvedAt: '2026-11-01T00:00:00.000Z' },
  ] };
}

test('a run lists only its unapproved non-interactive scripts, each with the newest approved version of its file in history', async () => {
  const state = await workspace();
  const files = (install: string) => ({ '.gitspace/lifecycle/machine/prepare/10-install.sh': install, '.gitspace/lifecycle/machine/prepare/20-approved.sh': 'echo approved\n' });
  expect(await lifecycleApprovalRequest({ args: run, state, cards: [], history: history([files(current), files(edited), files(merged)]) })).toEqual({ phase: 'machine/prepare', scripts: [{
    hash: await executionHash({ kind: 'script', command: current }), kind: 'script', label: '10-install.sh', phase: 'machine/prepare', fileName: '10-install.sh', content: current,
    previous: { content: merged, approvedBy: 'github:merged:#1340' },
  }] });
  // Without an approved earlier version there is nothing to compare with.
  expect((await lifecycleApprovalRequest({ args: run, state, cards: [], history: history([files(current), files(edited)]) }))?.scripts[0]?.previous).toBeNull();
});

test('a version a person approved on an earlier card, never committed, is the one compared with', async () => {
  const state = await workspace();
  const shown = await script('machine/prepare', '10-install.sh', edited);
  state.approvals.push({ scope: 'workspace', executionHash: shown.hash, approvedBy: 'device-2', approvedAt: '2026-11-02T00:00:00.000Z' });
  const card: RuntimeLifecycleApprovalQuestion = { phase: 'machine/prepare', callId: 'earlier', scripts: [{ hash: shown.hash, kind: 'script', label: '10-install.sh', phase: 'machine/prepare', fileName: '10-install.sh', content: edited, previous: null }] };
  const request = await lifecycleApprovalRequest({ args: run, state, cards: [{ answer: 'not-now', lifecycle: { ...card, callId: 'declined' } }, { answer: 'workspace', lifecycle: card }], history: history([{ '.gitspace/lifecycle/machine/prepare/10-install.sh': merged }]) });
  expect(request?.scripts.map(entry => entry.previous)).toEqual([{ content: edited, approvedBy: 'device-2' }]);
});

test('checks list the profile\'s unapproved checks; a call that runs nothing, or runs only approved content, has no card', async () => {
  const state = await workspace();
  expect(await lifecycleApprovalRequest({ args: { method: 'runChecks', runId: 'checks-1' }, state, cards: [], history: null })).toEqual({ phase: 'checks', scripts: [
    { hash: state.executions[0]!.hash, kind: 'check', label: 'Node', phase: null, fileName: null, content: 'node --version', previous: null },
  ] });
  expect(await lifecycleApprovalRequest({ args: { method: 'get' }, state, cards: [], history: null })).toBeNull();
  state.approvals.push(...state.executions.map((execution): LifecycleState['approvals'][number] => ({ scope: 'workspace', executionHash: execution.hash, approvedBy: 'device-1', approvedAt: '2026-11-03T00:00:00.000Z' })));
  expect(await lifecycleApprovalRequest({ args: run, state, cards: [], history: null })).toBeNull();
});
