import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import {
  addSpaceGoalRequirement,
  attachSpaceGoalEvidence,
  getSpaceStackStatus,
  listSpaceGoalRequirements,
  recordSpaceGoalHumanReview,
  removeSpaceGoalRequirement,
  reopenSpaceGoalRequirement,
  showSpaceGoalStatus,
  updateSpaceGoalRequirement,
} from '../space-goals.js';
import { addGoalNearWorkspace, bindPlannedGoalForWorkspace, listProjectGoalKanbanItems, readWorkspaceGoal } from '../../core/goal-chain.js';
import { isSameRunJudgment } from '../../core/goal-gates.js';

const envKey = 'GITSPACE_WORKSPACE_ROOT';

describe('space goal commands', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `space-goal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env[envKey];
    process.env[envKey] = root;
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({ name: 'demo', githubRepo: 'demo/repo', baseBranch: 'main', workspaces: [] }), 'utf-8');
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env[envKey];
    else process.env[envKey] = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('declares a requirement with rubric + generation + judgment', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Hover screenshot',
      kind: 'screenshot',
      rubric: 'Show the hover state with all chips visible.',
      gen: 'manual',
      judge: 'human',
    });
    const goal = readWorkspaceGoal('demo', 'api')!;
    const ids = goal.validation.reqOrder;
    expect(ids).toHaveLength(1);
    const requirement = goal.validation.requirements[ids[0]];
    expect(requirement).toMatchObject({
      title: 'Hover screenshot',
      kind: 'screenshot',
      rubric: 'Show the hover state with all chips visible.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
      status: 'missing',
    });
    expect(goal.validation.events.find((e) => e.kind === 'contract')).toBeTruthy();
  });

  it('defaults command-generated requirements to same-run command judgment when --judge is omitted', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Focused tests pass',
      kind: 'test-output',
      rubric: 'Exit code 0.',
      gen: 'command',
      genCommand: 'bun test src/foo.test.ts',
      expect: 'exit-zero',
    });
    const goal = readWorkspaceGoal('demo', 'api')!;
    const requirement = goal.validation.requirements[goal.validation.reqOrder[0]];
    // Same-run marker: judgment command materialized from the generation command.
    expect(requirement.generation).toEqual({ kind: 'command', command: 'bun test src/foo.test.ts' });
    expect(requirement.judgment).toEqual({ kind: 'command', command: 'bun test src/foo.test.ts', expect: { kind: 'exit-zero' } });
    expect(isSameRunJudgment(requirement)).toBe(true);
  });

  it('requires --judge for manual generation', () => {
    expect(() => addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Note', kind: 'note', rubric: 'r', gen: 'manual',
    })).toThrow(/--judge required/);
  });

  it('keeps same-run judgment pinned to the generation command on update', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Tests', kind: 'test-output', rubric: 'r', gen: 'command', genCommand: 'bun test a.ts',
    });
    updateSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      requirement: 'Tests', gen: 'command', genCommand: 'bun test b.ts',
    });
    const goal = readWorkspaceGoal('demo', 'api')!;
    const requirement = goal.validation.requirements[goal.validation.reqOrder[0]];
    expect(requirement.generation).toEqual({ kind: 'command', command: 'bun test b.ts' });
    expect(requirement.judgment).toEqual({ kind: 'command', command: 'bun test b.ts', expect: { kind: 'exit-zero' } });
    expect(isSameRunJudgment(requirement)).toBe(true);
  });

  it('keeps a distinct judge command distinct', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Budget', kind: 'test-output', rubric: 'r', gen: 'command', genCommand: 'bun run build',
      judge: 'command', judgeCommand: 'node check-size.mjs', expect: 'exit-zero',
    });
    const goal = readWorkspaceGoal('demo', 'api')!;
    const requirement = goal.validation.requirements[goal.validation.reqOrder[0]];
    expect(requirement.judgment).toEqual({ kind: 'command', command: 'node check-size.mjs', expect: { kind: 'exit-zero' } });
    expect(isSameRunJudgment(requirement)).toBe(false);
  });

  it('refuses bad requirements', () => {
    expect(() => addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Cmd', kind: 'note', rubric: 'r', gen: 'command', judge: 'human',
    })).toThrow(/--gen-command required/);
    expect(() => addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'X', kind: 'note', rubric: 'r', gen: 'manual', judge: 'command',
    })).toThrow(/--judge-command required/);
    expect(() => addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'X', kind: 'note', rubric: 'r', gen: 'manual', judge: 'command', judgeCommand: 'echo', expect: 'stdout-contains',
    })).toThrow(/--expect-needle required/);
    expect(() => addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'X', kind: 'note', rubric: 'r', gen: 'manual', judge: 'command', judgeCommand: 'echo', expect: 'output-matches',
    })).toThrow(/--expect-pattern required/);
  });

  it('lists, updates, removes, and reopens requirements', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Note A', kind: 'note', rubric: 'rubric a', gen: 'manual', judge: 'human',
    });
    expect(() => listSpaceGoalRequirements({ project: 'demo', workspace: 'api' }, { json: true })).not.toThrow();
    updateSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      requirement: 'Note A', rubric: 'rubric a v2',
    });
    let goal = readWorkspaceGoal('demo', 'api')!;
    const reqId = goal.validation.reqOrder[0];
    expect(goal.validation.requirements[reqId].rubric).toBe('rubric a v2');

    attachSpaceGoalEvidence({ project: 'demo', workspace: 'api' }, {
      requirement: 'Note A', body: 'inline note', name: 'note',
    });
    goal = readWorkspaceGoal('demo', 'api')!;
    expect(goal.validation.requirements[reqId].status).toBe('review');

    recordSpaceGoalHumanReview({ project: 'demo', workspace: 'api' }, {
      requirement: 'Note A', decision: 'pass', body: 'looks good',
    });
    goal = readWorkspaceGoal('demo', 'api')!;
    expect(goal.validation.requirements[reqId].status).toBe('accepted');

    reopenSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, { requirement: 'Note A' });
    goal = readWorkspaceGoal('demo', 'api')!;
    expect(goal.validation.requirements[reqId].status).toBe('review');

    removeSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, { requirement: 'Note A' });
    goal = readWorkspaceGoal('demo', 'api')!;
    expect(goal.validation.reqOrder).toHaveLength(0);
  });

  it('rejects attach when payload does not match requirement kind', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Screenshot', kind: 'screenshot', rubric: 'r', gen: 'manual', judge: 'human',
    });
    expect(() => attachSpaceGoalEvidence({ project: 'demo', workspace: 'api' }, {
      requirement: 'Screenshot', body: 'just inline text',
    })).toThrow(/screenshot evidence requires/);
  });

  it('rejects human review for fail without note', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Note', kind: 'note', rubric: 'r', gen: 'manual', judge: 'human',
    });
    attachSpaceGoalEvidence({ project: 'demo', workspace: 'api' }, { requirement: 'Note', body: 'ready' });
    expect(() => recordSpaceGoalHumanReview({ project: 'demo', workspace: 'api' }, {
      requirement: 'Note', decision: 'fail', body: '',
    })).toThrow(/note is required/);
  });

  it('shows plain-language readiness', () => {
    addSpaceGoalRequirement({ project: 'demo', workspace: 'api' }, {
      title: 'Note', kind: 'note', rubric: 'r', gen: 'manual', judge: 'human',
    });
    expect(() => showSpaceGoalStatus({ project: 'demo', workspace: 'api' })).not.toThrow();
    const projected = listProjectGoalKanbanItems('demo')[0];
    expect(projected?.validation?.readiness?.summary).toBe('1 required artifact missing.');
    expect(readFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), 'utf-8')).toContain('.gitspace/workspace/');
  });

  it('ignores generated workspace gitignore files when reporting stack status', () => {
    const baseDir = join(root, 'demo', 'base');
    const parentDir = join(root, 'demo', 'workspaces', 'base');
    const childDir = join(root, 'demo', 'workspaces', 'child');
    mkdirSync(baseDir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: baseDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: baseDir });
    execFileSync('git', ['config', 'user.name', 'Demo'], { cwd: baseDir });
    writeFileSync(join(baseDir, 'README.md'), 'demo\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: baseDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: baseDir, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-b', 'base', parentDir, 'main'], { cwd: baseDir, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-b', 'child', childDir, 'base'], { cwd: baseDir, stdio: 'ignore' });

    addGoalNearWorkspace('demo', 'base', 'child', 'after');
    bindPlannedGoalForWorkspace('demo', 'child');
    const generatedIgnore = '\n# gssh workspace local state\n.gitspace/workspace/\n';
    writeFileSync(join(parentDir, '.gitignore'), generatedIgnore, 'utf-8');
    writeFileSync(join(childDir, '.gitignore'), generatedIgnore, 'utf-8');

    const status = getSpaceStackStatus({ project: 'demo', workspace: 'child' });

    expect(status.status).toBe('aligned');
    expect(status.edges.map((edge) => edge.status)).toEqual(['aligned']);
  });
});
