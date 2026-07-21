import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { gateStatusForPhase, parseDocSlices } from '../goal-gates.js';
import { loadWorkspaceWorkflow, validateWorkspaceWorkflow } from '../goal-workflow.js';
import { startPhaseJournal, endPhaseJournal, findOpenPhaseEntry } from '../phase-journal.js';
import { artifactsScope, ensureArtifactsRepo, ensureArtifactsMount } from '../artifacts.js';
import { readWorkspaceGoal, writeGoalRecord } from '../goal-chain.js';
import {
  addRequirement,
  appendGateWaiveEvent,
  defaultValidation,
  recordRequirementVerdict,
} from '../goal-validation.js';
import type { GoalRecord, GoalValidation } from '../../types/goals.js';

// ─── parseDocSlices (pure) ──────────────────────────────────────────────────

describe('parseDocSlices', () => {
  it('parses heading sections into slugified slice ids', () => {
    const slices = parseDocSlices('# My Goal\n\ntext\n\n## Objective\n\n## Non-goals\n\n### Edge: Cases & Stuff!\n');
    expect(slices.map((s) => s.id)).toEqual(['my-goal', 'objective', 'non-goals', 'edge-cases-stuff']);
    expect(slices.map((s) => s.level)).toEqual([1, 2, 2, 3]);
    expect(slices[0]!.heading).toBe('My Goal');
    expect(slices[1]!.line).toBe(4);
  });

  it('dedupes colliding headings with -2/-3 suffixes', () => {
    const slices = parseDocSlices('## Setup\n## Setup\n## Setup\n');
    expect(slices.map((s) => s.id)).toEqual(['setup', 'setup-2', 'setup-3']);
  });

  it('ignores # lines inside fenced code blocks', () => {
    const slices = parseDocSlices('## Real\n\n```sh\n# not a heading\n```\n\n## Also real\n');
    expect(slices.map((s) => s.id)).toEqual(['real', 'also-real']);
  });

  it('returns [] for empty or heading-less docs', () => {
    expect(parseDocSlices('')).toEqual([]);
    expect(parseDocSlices('just prose\nno headings')).toEqual([]);
  });
});

// ─── gateStatusForPhase (pure) ──────────────────────────────────────────────

function validationWith(...reqs: Array<{ title: string; phase?: string; required?: boolean; accept?: boolean }>): GoalValidation {
  let v = defaultValidation();
  for (const r of reqs) {
    const added = addRequirement(v, {
      title: r.title,
      kind: 'note',
      rubric: `must ${r.title}`,
      required: r.required,
      generation: { kind: 'manual' },
      judgment: { kind: 'llm' },
      wfPhase: r.phase,
    });
    v = added.validation;
    if (r.accept) {
      v = {
        ...v,
        requirements: { ...v.requirements, [added.requirement.id]: { ...added.requirement, status: 'accepted' } },
      };
    }
  }
  return v;
}

describe('gateStatusForPhase', () => {
  it('is trivially satisfied when no requirements are owed', () => {
    const gate = gateStatusForPhase({ validation: validationWith({ title: 'a', phase: 'other' }) }, 'build');
    expect(gate.owed).toHaveLength(0);
    expect(gate.satisfied).toBe(true);
    expect(gate.passable).toBe(true);
  });

  it('is unsatisfied while an owed required requirement is not accepted', () => {
    const gate = gateStatusForPhase({ validation: validationWith({ title: 'a', phase: 'build' }, { title: 'b', phase: 'build', accept: true }) }, 'build');
    expect(gate.owed).toHaveLength(2);
    expect(gate.unmet.map((r) => r.title)).toEqual(['a']);
    expect(gate.satisfied).toBe(false);
    expect(gate.passable).toBe(false);
  });

  it('optional owed requirements never block', () => {
    const gate = gateStatusForPhase({ validation: validationWith({ title: 'opt', phase: 'build', required: false }) }, 'build');
    expect(gate.owed).toHaveLength(1);
    expect(gate.unmet).toHaveLength(0);
    expect(gate.satisfied).toBe(true);
  });

  it('is satisfied when every owed requirement is accepted', () => {
    const gate = gateStatusForPhase({ validation: validationWith({ title: 'a', phase: 'build', accept: true }) }, 'build');
    expect(gate.satisfied).toBe(true);
  });

  it('a human waive event makes the gate passable but not satisfied', () => {
    const v = appendGateWaiveEvent(validationWith({ title: 'a', phase: 'build' }), 'build', 'demo deadline', 'human/ui');
    const gate = gateStatusForPhase({ validation: v }, 'build');
    expect(gate.satisfied).toBe(false);
    expect(gate.waived).toBe(true);
    expect(gate.passable).toBe(true);
    // The waive is phase-scoped.
    expect(gateStatusForPhase({ validation: v }, 'ship').waived).toBe(false);
  });
});

// ─── verdict (pure over goal record) ────────────────────────────────────────

function bareGoal(validation: GoalValidation): GoalRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2, id: 'g1', chainId: 'c1', title: 'G', projectName: 'demo', phase: 'code',
    doc: { bodyMarkdown: '# G', updatedAt: now }, validation, createdAt: now, updatedAt: now,
  };
}

describe('recordRequirementVerdict', () => {
  it('accept flips the requirement to accepted with a pinned green review', () => {
    let v = defaultValidation();
    const added = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must X', generation: { kind: 'manual' }, judgment: { kind: 'llm' } });
    const { goal, requirement, review } = recordRequirementVerdict(bareGoal(added.validation), added.requirement.id, 'accept', 'evidence matches rubric line 1');
    expect(requirement.status).toBe('accepted');
    expect(review.tone).toBe('green');
    expect(review.judgeType).toBe('llm');
    expect(review.rubricHash).toBeTruthy();
    const last = goal.validation.events.at(-1)!;
    expect(last.kind).toBe('review');
    expect(last.payload).toContain('review.verdict.accepted');
  });

  it('reject keeps status at review and requires notes', () => {
    let v = defaultValidation();
    const added = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must X', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    expect(() => recordRequirementVerdict(bareGoal(added.validation), added.requirement.id, 'reject', '   ')).toThrow(/notes/i);
    const { requirement, review } = recordRequirementVerdict(bareGoal(added.validation), added.requirement.id, 'reject', 'missing the hover state');
    expect(requirement.status).toBe('review');
    expect(review.tone).toBe('red');
    expect(review.judgeType).toBe('human');
  });

  it('refuses command-judged requirements (they auto-judge on review run)', () => {
    let v = defaultValidation();
    const added = addRequirement(v, {
      title: 'R', kind: 'test-output', rubric: 'exit 0',
      generation: { kind: 'command', command: 'true' },
      judgment: { kind: 'command', command: 'true', expect: { kind: 'exit-zero' } },
    });
    expect(() => recordRequirementVerdict(bareGoal(added.validation), added.requirement.id, 'accept', 'n')).toThrow(/review run/);
  });
});

// ─── Workflow load/validate + gate-blocked phase-end (workspace-backed) ────

let root: string;
let previousRoot: string | undefined;
let projectDir: string;
let workspaceDir: string;
let mount: string;

/** Write the workspace's workflow spec where one actually lives: the goal
 *  folder the workspace owns once it has a goal record, the mount root before
 *  that (docs/ARTIFACTS-FS.md "Tree layout"). The scope is resolved at call
 *  time, so gate tests write the spec AFTER writeGoalRecord. */
function writeSpec(name: string, spec: unknown): void {
  const abs = artifactsScope(workspaceDir).abs(name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof spec === 'string' ? spec : JSON.stringify(spec));
}

function makeGoal(validation: GoalRecord['validation'], bodyMarkdown = '# Goal\n\n## Rails\n\n## Validation\n'): GoalRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2, id: 'g1', chainId: 'c1', title: 'Gate goal', projectName: 'demo',
    phase: 'code', workspaceName: 'ws1',
    doc: { bodyMarkdown, updatedAt: now },
    validation, createdAt: now, updatedAt: now,
  };
}

const WORKFLOW_SPEC = {
  recipe: 'test recipe',
  phases: [
    { name: 'build', slices: ['rails'], inputs: [], nodes: [], outputs: [] },
    { name: 'ship', inputs: [], nodes: [], outputs: [] },
  ],
};

beforeEach(async () => {
  root = join(tmpdir(), `goal-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('loadWorkspaceWorkflow / validateWorkspaceWorkflow', () => {
  it('returns null without a spec and errors listing paths on multiples', () => {
    expect(loadWorkspaceWorkflow(workspaceDir)).toBeNull();
    writeSpec('a.workflow.json', WORKFLOW_SPEC);
    expect(loadWorkspaceWorkflow(workspaceDir)?.path).toBe('a.workflow.json');
    writeSpec('b.workflow.json', WORKFLOW_SPEC);
    expect(() => loadWorkspaceWorkflow(workspaceDir)).toThrow(/a\.workflow\.json, b\.workflow\.json/);
  });

  it('resolves the per-goal workflow on a mount carrying multiple goals (no throw)', () => {
    // The multi-goal landmine: once two goals roll up, main/the mount carries
    // goals/<A>/a.workflow.json AND goals/<B>/b.workflow.json. Globbing the
    // mount root would find both and throw the one-workflow error; goal-scoped
    // resolution (goals/<owned-goal-id>/) must return only the owned one.
    writeGoalRecord('demo', makeGoal(defaultValidation())); // ws1 owns goal g1
    writeSpec('a.workflow.json', WORKFLOW_SPEC); // → goals/g1/a.workflow.json
    // A neighbour goal's workflow also present on the same mount:
    const neighbour = join(mount, 'goals', 'g2', 'b.workflow.json');
    mkdirSync(dirname(neighbour), { recursive: true });
    writeFileSync(neighbour, JSON.stringify(WORKFLOW_SPEC));
    expect(() => loadWorkspaceWorkflow(workspaceDir)).not.toThrow();
    expect(loadWorkspaceWorkflow(workspaceDir)?.path).toBe('a.workflow.json');
  });

  it('reports dangling slice refs as warnings, resolved refs clean', () => {
    writeSpec('a.workflow.json', ({
      recipe: 'r',
      phases: [
        { name: 'build', slices: ['rails', 'missing-slice'], created: [{ name: 'brief', type: 'goal-slice', sliceId: 'validation' }] },
        { name: 'build' }, // duplicate name → warning
      ],
    }));
    const result = validateWorkspaceWorkflow(workspaceDir, makeGoal(defaultValidation()));
    expect(result.path).toBe('a.workflow.json');
    expect(result.docSliceIds).toEqual(['goal', 'rails', 'validation']);
    expect(result.warnings.some((w) => w.includes('missing-slice'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Duplicate phase name'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"rails"'))).toBe(false);
  });

  it('throws on an unparseable spec', () => {
    writeSpec('a.workflow.json', '{nope');
    expect(() => validateWorkspaceWorkflow(workspaceDir, null)).toThrow(/Unreadable workflow spec/);
  });
});

describe('gate-blocked phase-end', () => {
  it('blocks phase-end while an owed requirement is unmet, unblocks after verdict accept', async () => {
    let v = defaultValidation();
    const added = addRequirement(v, {
      title: 'Rails proof', kind: 'note', rubric: 'must show rails',
      generation: { kind: 'manual' }, judgment: { kind: 'llm' }, wfPhase: 'build', sliceId: 'rails',
    });
    writeGoalRecord('demo', makeGoal(added.validation));
    writeSpec('a.workflow.json', WORKFLOW_SPEC);

    await startPhaseJournal('demo', 'ws1', { phase: 'build', intent: 'build the rails' });
    let blocked: Error | null = null;
    try {
      await endPhaseJournal('demo', 'ws1', { outcome: 'done', autoCommit: false });
    } catch (e) {
      blocked = e as Error;
    }
    expect(blocked).not.toBeNull();
    expect(blocked!.message).toContain('gate is not satisfied');
    expect(blocked!.message).toContain(added.requirement.id);
    expect(blocked!.message).toContain('--revert');
    expect(blocked!.message).toContain('human');
    // Still open — the blocked end must not close the entry.
    expect(findOpenPhaseEntry(workspaceDir)?.entry.phase).toBe('build');

    // Reviewer verdict accepts against the rubric → gate satisfied → end passes.
    const goal = readWorkspaceGoal('demo', 'ws1')!;
    writeGoalRecord('demo', recordRequirementVerdict(goal, added.requirement.id, 'accept', 'rails visible per rubric').goal);
    const ended = await endPhaseJournal('demo', 'ws1', { outcome: 'rails built', autoCommit: false });
    expect(ended.entry.endedAt).toBeTruthy();
    expect(ended.entry.reverted).toBeUndefined();
    expect(findOpenPhaseEntry(workspaceDir)).toBeNull();
  });

  it('phase-end --revert closes the phase without the gate and records a gate event', async () => {
    let v = defaultValidation();
    const added = addRequirement(v, {
      title: 'Rails proof', kind: 'note', rubric: 'must show rails',
      generation: { kind: 'manual' }, judgment: { kind: 'llm' }, wfPhase: 'build',
    });
    writeGoalRecord('demo', makeGoal(added.validation));
    writeSpec('a.workflow.json', WORKFLOW_SPEC);

    await startPhaseJournal('demo', 'ws1', { phase: 'build', intent: 'build the rails' });
    const ended = await endPhaseJournal('demo', 'ws1', {
      outcome: 'reverted → plan: rubric was wrong',
      autoCommit: false,
      revert: { reason: 'rubric was wrong' },
    });
    expect(ended.entry.reverted).toEqual({ reason: 'rubric was wrong', to: 'plan' });
    expect(findOpenPhaseEntry(workspaceDir)).toBeNull();

    const goal = readWorkspaceGoal('demo', 'ws1')!;
    const gateEvents = goal.validation.events.filter((e) => e.kind === 'gate');
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]!.title).toBe('phase reverted → plan');
    expect(gateEvents[0]!.payload).toContain('gate.reverted');
    // Gate stays red.
    expect(gateStatusForPhase(goal, 'build').satisfied).toBe(false);
  });

  it('a human waive event unblocks phase-end without acceptance', async () => {
    let v = defaultValidation();
    const added = addRequirement(v, {
      title: 'Rails proof', kind: 'note', rubric: 'must show rails',
      generation: { kind: 'manual' }, judgment: { kind: 'human' }, wfPhase: 'build',
    });
    writeGoalRecord('demo', makeGoal(appendGateWaiveEvent(added.validation, 'build', 'demo cut', 'human/ui')));
    writeSpec('a.workflow.json', WORKFLOW_SPEC);

    await startPhaseJournal('demo', 'ws1', { phase: 'build', intent: 'build' });
    const ended = await endPhaseJournal('demo', 'ws1', { outcome: 'done under waive', autoCommit: false });
    expect(ended.entry.endedAt).toBeTruthy();
  });

  it('phases unknown to the workflow (or with nothing owed) end unblocked — backward compat', async () => {
    let v = defaultValidation();
    // Owed by a FREE-FORM phase name that is not in the workflow: no gate machinery.
    const added = addRequirement(v, {
      title: 'Loose end', kind: 'note', rubric: 'x',
      generation: { kind: 'manual' }, judgment: { kind: 'human' }, wfPhase: 'freeform-spike',
    });
    writeGoalRecord('demo', makeGoal(added.validation));
    writeSpec('a.workflow.json', WORKFLOW_SPEC);

    await startPhaseJournal('demo', 'ws1', { phase: 'freeform-spike', intent: 'spike' });
    const spike = await endPhaseJournal('demo', 'ws1', { outcome: 'spiked', autoCommit: false });
    expect(spike.entry.endedAt).toBeTruthy();

    // Workflow-known phase with nothing owed: trivially satisfied.
    await startPhaseJournal('demo', 'ws1', { phase: 'ship', intent: 'ship it' });
    const ship = await endPhaseJournal('demo', 'ws1', { outcome: 'shipped', autoCommit: false });
    expect(ship.entry.endedAt).toBeTruthy();
  });
});
