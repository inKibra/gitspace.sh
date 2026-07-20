import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPhaseJournal, endPhaseJournal, findOpenPhaseEntry, snapshotPhaseState, computePhaseDelta } from '../phase-journal.js';
import { ensureArtifactsRepo, ensureArtifactsMount } from '../artifacts.js';
import { writeGoalRecord } from '../goal-chain.js';
import { addRequirement, defaultValidation, recordHumanReview } from '../goal-validation.js';
import type { GoalRecord } from '../../types/goals.js';

let root: string;
let previousRoot: string | undefined;
let projectDir: string;
let workspaceDir: string;
let mount: string;

function makeGoal(validation: GoalRecord['validation']): GoalRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2, id: 'g1', chainId: 'c1', title: 'Journal goal', projectName: 'demo',
    phase: 'code', workspaceName: 'ws1',
    doc: { bodyMarkdown: '# Journal goal', updatedAt: now },
    validation, createdAt: now, updatedAt: now,
  } as GoalRecord;
}

beforeEach(async () => {
  root = join(tmpdir(), `journal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  process.env.GITSPACE_WORKSPACE_ROOT = root;
  projectDir = join(root, 'demo');
  workspaceDir = join(projectDir, 'workspaces', 'ws1');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(projectDir, '.config.json'), JSON.stringify({ name: 'demo', repository: 'x/y' }));
  execFileSync('git', ['init', '-q', workspaceDir]);
  execFileSync('git', ['-C', workspaceDir, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  await ensureArtifactsRepo(projectDir);
  mount = await ensureArtifactsMount(projectDir, workspaceDir, 'ws1');
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('phase journal', () => {
  it('round-trips a phase: snapshot, delta, auto-commit, canon pins', async () => {
    let v = defaultValidation();
    const add = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must X', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    writeGoalRecord('demo', makeGoal(add.validation));

    const started = await startPhaseJournal('demo', 'ws1', { phase: 'rails parity', intent: 'match the rails' });
    expect(started.entry.state.start.goal?.ready).toBe('0/1');
    expect(started.entry.state.start.canon.artifactsSha).toBeTruthy();
    expect(started.entry.state.start.canon.rubricHash).toBeTruthy(); // write-through mirrored rubric.json
    expect(findOpenPhaseEntry(workspaceDir)?.entry.phase).toBe('rails parity');

    // double-start is rejected
    await expect(startPhaseJournal('demo', 'ws1', { phase: 'x', intent: 'y' })).rejects.toThrow(/still open/);

    // mid-phase: code change + requirement accepted
    writeFileSync(join(workspaceDir, 'a.ts'), 'export const a = 1;\n');
    const goal = makeGoal(add.validation);
    const { goal: judged } = recordHumanReview(goal, add.requirement.id, 'pass', 'looks right');
    writeGoalRecord('demo', judged);

    const ended = await endPhaseJournal('demo', 'ws1', { outcome: 'rails match the mock\n\ndetails here', decisions: ['kept star always visible'] });
    expect(ended.entry.endedAt).toBeTruthy();
    expect(ended.entry.delta?.requirementsAdvanced).toEqual([{ id: add.requirement.id, from: 'missing', to: 'accepted' }]);
    expect(ended.entry.commits.autoCommit).toBeTruthy();
    const subject = execFileSync('git', ['-C', workspaceDir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    expect(subject).toBe('rails parity: rails match the mock');

    // journal entry is committed on the artifacts branch, inside the disjoint
    // goal folder this workspace owns (docs/ARTIFACTS-FS.md "Tree layout") —
    // never at the mount root, where two branches would collide at roll-up.
    const files = execFileSync('git', ['-C', mount, 'ls-files', 'goals'], { encoding: 'utf8' }).trim();
    expect(files.split('\n')).toContain('goals/g1/journal/01-rails-parity.json');
    expect(execFileSync('git', ['-C', mount, 'ls-files', 'journal'], { encoding: 'utf8' }).trim()).toBe('');
    const persisted = JSON.parse(readFileSync(join(mount, 'goals/g1/journal/01-rails-parity.json'), 'utf8'));
    expect(persisted.delta.requirementsAdvanced).toHaveLength(1);
    expect(findOpenPhaseEntry(workspaceDir)).toBeNull();
  });

  it('flags canon motion when the rubric changes during a phase', async () => {
    let v = defaultValidation();
    const add = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must X', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    writeGoalRecord('demo', makeGoal(add.validation));
    await startPhaseJournal('demo', 'ws1', { phase: 'p2', intent: 'i' });

    const edited = { ...add.validation, requirements: { ...add.validation.requirements, [add.requirement.id]: { ...add.requirement, rubric: 'must X and Y' } } };
    writeGoalRecord('demo', makeGoal(edited));

    const ended = await endPhaseJournal('demo', 'ws1', { outcome: 'tightened rubric', autoCommit: false });
    expect(ended.entry.delta?.canonChanged).toContain('rubric');
  });

  it('phase-end without an open phase fails; snapshot works without a goal', async () => {
    await expect(endPhaseJournal('demo', 'ws1', { outcome: 'x' })).rejects.toThrow(/No open phase/);
    rmSync(join(projectDir, 'workspaces', 'ws1', '.gitspace', 'goal'), { recursive: true, force: true });
    const snap = snapshotPhaseState('demo', 'ws1');
    expect(snap.goal?.id ?? null).toBeDefined();
    expect(computePhaseDelta(snap, snap).requirementsAdvanced).toHaveLength(0);
  });
});
