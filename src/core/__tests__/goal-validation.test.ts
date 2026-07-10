import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addRequirement,
  attachManualEvidence,
  defaultValidation,
  isAcceptanceStale,
  hashRubric,
  getGoalValidationDir,
  getPlannedGoalValidationDir,
  getWorkspaceGoalValidationDir,
  migrateGoalRecord,
  moveGoalValidationToWorkspace,
  recordHumanReview,
  removeRequirement,
  reorderRequirement,
  reopenRequirement,
  runGenerationCommand,
  runJudgmentCommand,
  runLlmJudgment,
  updateRequirement,
} from '../goal-validation.js';
import { writeGoalRecord, writePlannedGoal } from '../goal-chain.js';
import type { GoalRecord } from '../../types/goals.js';

const envKey = 'GITSPACE_WORKSPACE_ROOT';

function makeGoal(overrides: Partial<GoalRecord> & Pick<GoalRecord, 'id' | 'title' | 'phase'>): GoalRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    id: overrides.id,
    chainId: overrides.chainId ?? 'chain',
    title: overrides.title,
    projectName: overrides.projectName ?? 'demo',
    phase: overrides.phase,
    plannedWorkspaceName: overrides.plannedWorkspaceName,
    workspaceName: overrides.workspaceName,
    doc: overrides.doc ?? { bodyMarkdown: `# ${overrides.title}`, updatedAt: now },
    validation: overrides.validation ?? defaultValidation(),
    sourceRefs: overrides.sourceRefs,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe('goal validation core', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `goal-validation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env[envKey];
    process.env[envKey] = root;
    mkdirSync(join(root, 'demo', 'workspaces'), { recursive: true });
    writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({ name: 'demo', githubRepo: 'demo/repo', baseBranch: 'main', workspaces: [] }), 'utf-8');
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env[envKey];
    else process.env[envKey] = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('adds, updates, and removes requirements with events', () => {
    let v = defaultValidation();
    const added = addRequirement(v, {
      title: 'Screenshot showing hover state',
      kind: 'screenshot',
      rubric: 'Show the highlighted requirement.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    expect(added.requirement.status).toBe('missing');
    expect(added.validation.reqOrder).toHaveLength(1);
    expect(added.validation.events).toHaveLength(1);
    expect(added.validation.events[0].kind).toBe('contract');

    const updated = updateRequirement(added.validation, added.requirement.id, { rubric: 'Updated rubric.' });
    expect(updated.requirement.rubric).toBe('Updated rubric.');
    expect(updated.validation.events).toHaveLength(2);

    const removed = removeRequirement(updated.validation, added.requirement.id);
    expect(removed.reqOrder).toHaveLength(0);
    expect(Object.keys(removed.requirements)).toHaveLength(0);
    expect(removed.events).toHaveLength(3);
  });

  it('reorders requirements', () => {
    let v = defaultValidation();
    const a = addRequirement(v, { title: 'A', kind: 'note', rubric: 'a', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    const b = addRequirement(a.validation, { title: 'B', kind: 'note', rubric: 'b', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    const reordered = reorderRequirement(b.validation, a.requirement.id, 1);
    expect(reordered.reqOrder).toEqual([b.requirement.id, a.requirement.id]);
  });

  it('rejects bad inputs', () => {
    let v = defaultValidation();
    expect(() => addRequirement(v, { title: '', kind: 'note', rubric: 'r', generation: { kind: 'manual' }, judgment: { kind: 'human' } })).toThrow(/Title is required/);
    expect(() => addRequirement(v, { title: 't', kind: 'note', rubric: '', generation: { kind: 'manual' }, judgment: { kind: 'human' } })).toThrow(/Rubric is required/);
    expect(() => addRequirement(v, { title: 't', kind: 'note', rubric: 'r', generation: { kind: 'command', command: '' }, judgment: { kind: 'human' } })).toThrow(/Command generation/);
  });

  it('attaches manual evidence and updates status to review', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    const v0 = defaultValidation();
    const v1 = addRequirement(v0, { title: 'Note', kind: 'note', rubric: 'A short note.', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v1.validation });
    writeGoalRecord('demo', goal);
    const result = attachManualEvidence('demo', goal, v1.requirement.id, { body: 'inline note content', name: 'note.md' });
    expect(result.evidence.source).toBe('manual');
    expect(result.requirement.status).toBe('review');
    expect(result.goal.validation.requirements[v1.requirement.id].evidence).toHaveLength(1);
  });

  it('copies file evidence and records meta', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    const sourcePath = join(root, 'shot.png');
    writeFileSync(sourcePath, 'png-bytes', 'utf-8');
    const v0 = addRequirement(defaultValidation(), {
      title: 'Hover screenshot',
      kind: 'screenshot',
      rubric: 'Hover.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const result = attachManualEvidence('demo', goal, v0.requirement.id, { path: sourcePath, name: 'hover' });
    expect(result.evidence.artifactPath).toBeTruthy();
    expect(readFileSync(join(getWorkspaceGoalValidationDir('demo', 'api'), result.evidence.artifactPath!), 'utf-8')).toBe('png-bytes');
  });

  it('rejects mismatched evidence kinds', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'URL',
      kind: 'url',
      rubric: 'URL.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', plannedWorkspaceName: 'api', validation: v0.validation });
    expect(() => attachManualEvidence('demo', goal, v0.requirement.id, { body: 'not a URL' })).toThrow(/URL evidence/);
  });

  it('records human reviews requiring a note for fail/changes', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    // Move status to review by attaching evidence first
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', plannedWorkspaceName: 'api', validation: v0.validation });
    const withEvidence = attachManualEvidence('demo', goal, v0.requirement.id, { body: 'ready', name: 'n' });
    expect(() => recordHumanReview(withEvidence.goal, v0.requirement.id, 'fail', '   ')).toThrow(/note is required/);
    const passed = recordHumanReview(withEvidence.goal, v0.requirement.id, 'pass', 'looks good');
    expect(passed.requirement.status).toBe('accepted');
    expect(passed.review.tone).toBe('green');
    expect(passed.review.judgeType).toBe('human');
    expect(passed.review.score).toBeUndefined();
  });

  it('persists judgeType and score on human reviews with a score', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', plannedWorkspaceName: 'api', validation: v0.validation });
    const withEvidence = attachManualEvidence('demo', goal, v0.requirement.id, { body: 'ready', name: 'n' });
    expect(() => recordHumanReview(withEvidence.goal, v0.requirement.id, 'pass', 'ok', 150)).toThrow(/between 0 and 100/);
    const passed = recordHumanReview(withEvidence.goal, v0.requirement.id, 'pass', 'looks good', 85, 'alice');
    expect(passed.review.judgeType).toBe('human');
    expect(passed.review.score).toBe(85);
    expect(passed.review.createdBy).toBe('alice');
    const persisted = passed.goal.validation.requirements[v0.requirement.id].reviews.at(-1);
    expect(persisted?.judgeType).toBe('human');
    expect(persisted?.score).toBe(85);
  });

  it('reopens an accepted requirement', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', plannedWorkspaceName: 'api', validation: v0.validation });
    const evidence = attachManualEvidence('demo', goal, v0.requirement.id, { body: 'ready', name: 'n' });
    const passed = recordHumanReview(evidence.goal, v0.requirement.id, 'pass', 'lgtm');
    const reopened = reopenRequirement(passed.goal, v0.requirement.id);
    expect(reopened.requirement.status).toBe('review');
  });

  it('runs LLM judgment with an honest unavailable message', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note.',
      generation: { kind: 'manual' },
      judgment: { kind: 'llm', modelHint: 'claude-3.5-sonnet' },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', plannedWorkspaceName: 'api', validation: v0.validation });
    const evidence = attachManualEvidence('demo', goal, v0.requirement.id, { body: 'ready', name: 'n' });
    const judgment = runLlmJudgment(evidence.goal, v0.requirement.id);
    expect(judgment.review.tone).toBe('amber');
    expect(judgment.review.note).toMatch(/not yet implemented/);
    expect(judgment.review.judgeType).toBe('llm');
    expect(judgment.review.cites).toEqual([evidence.evidence.id]);
  });

  it('runs command generation and auto-accepts on exit-zero', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'command', command: 'printf ok' },
      judgment: { kind: 'command', command: 'printf ok', expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const result = runGenerationCommand('demo', goal, v0.requirement.id);
    expect(result.autoAccepted).toBe(true);
    expect(result.requirement.status).toBe('accepted');
    expect(result.requirement.evidence[0]?.source).toBe('command');
    const review = result.requirement.reviews.at(-1);
    expect(review?.judgeType).toBe('command');
    expect(review?.score).toBe(100);
    expect(review?.cites).toEqual([result.evidence.id]);
  });

  it('runs command judgment and records the review', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'manual' },
      judgment: { kind: 'command', command: 'sh -c "exit 0"', expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const withEvidence = attachManualEvidence('demo', goal, v0.requirement.id, { body: 'inline', name: 'n' });
    const judgment = runJudgmentCommand('demo', withEvidence.goal, v0.requirement.id);
    expect(judgment.review.tone).toBe('green');
    expect(judgment.requirement.status).toBe('accepted');
    expect(judgment.review.judgeType).toBe('command');
    expect(judgment.review.score).toBe(100);
    expect(judgment.review.cites).toEqual([withEvidence.evidence.id]);
  });

  it('records score 0 and judgeType command on failed command judgment', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'manual' },
      judgment: { kind: 'command', command: 'sh -c "exit 1"', expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const judgment = runJudgmentCommand('demo', goal, v0.requirement.id);
    expect(judgment.review.tone).toBe('red');
    expect(judgment.review.judgeType).toBe('command');
    expect(judgment.review.score).toBe(0);
  });

  it('same-run judgment (judge command == gen command) judges the latest generation run without re-executing', () => {
    const workspaceDir = join(root, 'demo', 'workspaces', 'api');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, '.gitignore'), '', 'utf-8');
    const command = 'echo run >> runs.txt';
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'command', command },
      judgment: { kind: 'command', command, expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const generated = runGenerationCommand('demo', goal, v0.requirement.id);
    expect(generated.autoAccepted).toBe(true);
    expect(readFileSync(join(workspaceDir, 'runs.txt'), 'utf-8').trim().split('\n')).toHaveLength(1);

    const judged = runJudgmentCommand('demo', generated.goal, v0.requirement.id);
    // The command did NOT run a second time — the run counter file is unchanged.
    expect(readFileSync(join(workspaceDir, 'runs.txt'), 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(judged.review.tone).toBe('green');
    expect(judged.requirement.status).toBe('accepted');
    // The review cites exactly the generation evidence it judged.
    expect(judged.review.cites).toEqual([generated.evidence.id]);
    const event = judged.goal.validation.events.at(-1);
    expect(event?.payload).toContain('mode: same-run');
    expect(event?.payload).toContain(`evidence: ${generated.evidence.id}`);
  });

  it('same-run judgment fails against a failing generation run without re-executing', () => {
    const workspaceDir = join(root, 'demo', 'workspaces', 'api');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, '.gitignore'), '', 'utf-8');
    const command = 'echo run >> runs.txt; exit 1';
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'command', command },
      judgment: { kind: 'command', command, expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const generated = runGenerationCommand('demo', goal, v0.requirement.id);
    expect(generated.autoAccepted).toBe(false);
    const judged = runJudgmentCommand('demo', generated.goal, v0.requirement.id);
    expect(readFileSync(join(workspaceDir, 'runs.txt'), 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(judged.review.tone).toBe('red');
    expect(judged.review.cites).toEqual([generated.evidence.id]);
    expect(judged.requirement.status).toBe('review');
  });

  it('same-run judgment errors clearly when no generation run exists yet', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    const command = 'printf ok';
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'command', command },
      judgment: { kind: 'command', command, expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    expect(() => runJudgmentCommand('demo', goal, v0.requirement.id)).toThrow(/No generation run to judge yet/);
  });

  it('treats a hand-edited command judgment with no command as same-run', () => {
    const workspaceDir = join(root, 'demo', 'workspaces', 'api');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, '.gitignore'), '', 'utf-8');
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'command', command: 'printf ok' },
      judgment: { kind: 'command', command: '', expect: { kind: 'stdout-contains', needle: 'ok' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const generated = runGenerationCommand('demo', goal, v0.requirement.id);
    const judged = runJudgmentCommand('demo', generated.goal, v0.requirement.id);
    expect(judged.review.tone).toBe('green');
    expect(judged.review.cites).toEqual([generated.evidence.id]);
  });

  it('rejects command judgment without a command when generation is manual', () => {
    expect(() => addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'manual' },
      judgment: { kind: 'command', command: '', expect: { kind: 'exit-zero' } },
    })).toThrow(/Command judgment requires a command/);
  });

  it('distinct judge command still re-executes on review run', () => {
    const workspaceDir = join(root, 'demo', 'workspaces', 'api');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, '.gitignore'), '', 'utf-8');
    const v0 = addRequirement(defaultValidation(), {
      title: 'Tests',
      kind: 'test-output',
      rubric: 'Suite must pass.',
      generation: { kind: 'command', command: 'echo gen >> gen-runs.txt' },
      judgment: { kind: 'command', command: 'echo judge >> judge-runs.txt', expect: { kind: 'exit-zero' } },
    });
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', workspaceName: 'api', validation: v0.validation });
    writeGoalRecord('demo', goal);
    const generated = runGenerationCommand('demo', goal, v0.requirement.id);
    const judged = runJudgmentCommand('demo', generated.goal, v0.requirement.id);
    expect(readFileSync(join(workspaceDir, 'gen-runs.txt'), 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(workspaceDir, 'judge-runs.txt'), 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(judged.review.tone).toBe('green');
    const event = judged.goal.validation.events.at(-1);
    expect(event?.payload).not.toContain('mode: same-run');
  });

  it('migrates a v1 goal record to v2', () => {
    const legacy = {
      version: 1,
      id: 'legacy',
      chainId: 'chain',
      title: 'Legacy',
      projectName: 'demo',
      phase: 'code',
      plannedWorkspaceName: 'api',
      doc: { bodyMarkdown: '# legacy', updatedAt: new Date(0).toISOString() },
      validation: {
        criteria: ['must work'],
        artifactRequirements: [
          { id: 'req-1', kind: 'image', title: 'Old screenshot', description: 'Old desc', required: true },
          { id: 'req-2', kind: 'manual-note', title: 'Old note', description: 'Old note desc' },
        ],
        judgmentPlan: { type: 'human', humanInstructions: 'Old human prompt' },
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const migrated = migrateGoalRecord(legacy);
    expect(migrated.version).toBe(2);
    expect(migrated.validation.reqOrder).toEqual(['req-1', 'req-2']);
    expect(migrated.validation.requirements['req-1'].kind).toBe('screenshot');
    expect(migrated.validation.requirements['req-1'].rubric).toBe('Old desc');
    expect(migrated.validation.requirements['req-2'].kind).toBe('note');
    expect(migrated.validation.requirements['req-2'].generation.kind).toBe('manual');
    expect(migrated.validation.requirements['req-2'].judgment.kind).toBe('human');
  });

  it('backfills judgeType on v2 reviews from who when unambiguous', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const reqId = v0.requirement.id;
    const now = new Date(0).toISOString();
    const validation = {
      ...v0.validation,
      requirements: {
        [reqId]: {
          ...v0.validation.requirements[reqId],
          reviews: [
            { id: 'rv-old-1', tone: 'green', who: 'human', note: 'lgtm', createdAt: now },
            { id: 'rv-old-2', tone: 'green', who: 'command', note: 'exit 0', createdAt: now },
            { id: 'rv-old-3', tone: 'amber', who: 'claude-3.5-sonnet', note: 'unclear', createdAt: now },
          ],
        },
      },
    };
    const goal = makeGoal({ id: 'api', title: 'API', phase: 'code', plannedWorkspaceName: 'api', validation: validation as GoalRecord['validation'] });
    const migrated = migrateGoalRecord(goal);
    const reviews = migrated.validation.requirements[reqId].reviews;
    expect(reviews[0].judgeType).toBe('human');
    expect(reviews[1].judgeType).toBe('command');
    expect(reviews[2].judgeType).toBeUndefined();
    expect(reviews[2].note).toBe('unclear');
  });

  it('moves planned validation artifacts dir to workspace on bind', () => {
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const planned = makeGoal({ id: 'planned', title: 'Planned', phase: 'plan', plannedWorkspaceName: 'api', validation: v0.validation });
    writePlannedGoal('demo', planned);
    const withEvidence = attachManualEvidence('demo', planned, v0.requirement.id, { body: 'note body' });
    expect(getGoalValidationDir('demo', withEvidence.goal)).toBe(getPlannedGoalValidationDir('demo', 'planned'));
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
    moveGoalValidationToWorkspace('demo', 'planned', 'api');
    expect(existsSync(getPlannedGoalValidationDir('demo', 'planned'))).toBe(false);
    expect(existsSync(getWorkspaceGoalValidationDir('demo', 'api'))).toBe(true);
  });
});

describe('canon pins (docs/REVIEW-GUIDE.md)', () => {
  it('human review pins the rubric hash at judgment time', () => {
    let v = defaultValidation();
    const add = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must do X', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    v = add.validation;
    const goal = makeGoal({ id: 'g1', title: 'g', phase: 'review', validation: v });
    const { review, requirement } = recordHumanReview(goal, add.requirement.id, 'pass', 'looks right');
    expect(review.rubricHash).toBe(hashRubric('must do X'));
    expect(isAcceptanceStale(requirement)).toBe(false);
  });

  it('acceptance goes stale when the rubric changes after the accepting judgment', () => {
    let v = defaultValidation();
    const add = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must do X', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    v = add.validation;
    const goal = makeGoal({ id: 'g2', title: 'g', phase: 'review', validation: v });
    const { requirement } = recordHumanReview(goal, add.requirement.id, 'pass', 'ok');
    const edited = { ...requirement, rubric: 'must do X and also Y' };
    expect(isAcceptanceStale(edited)).toBe(true);
    // legacy acceptances without a pin are never reported stale
    const legacy = { ...edited, reviews: edited.reviews.map((r) => ({ ...r, rubricHash: undefined })) };
    expect(isAcceptanceStale(legacy)).toBe(false);
  });
});
