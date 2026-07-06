import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import {
  addGoalNearWorkspace,
  applyWorkspaceGoalPhaseChange,
  bindPlannedGoalForWorkspace,
  getPlannedGoalPath,
  getWorkspaceGoalPath,
  listProjectGoalKanbanItems,
  moveGoalInChain,
  previewWorkspaceGoalPhaseChange,
  readWorkspaceGoal,
  setWorkspaceStatusForGoalChain,
  upsertGoalChain,
  writeGoalRecord,
  writePlannedGoal,
} from '../goal-chain.js';
import { getWorkspaceStatus, setWorkspaceStatus } from '../workspace-metadata.js';
import {
  addRequirement,
  attachManualEvidence,
  defaultValidation,
  getPlannedGoalValidationDir,
  getWorkspaceGoalValidationDir,
} from '../goal-validation.js';
import type { GoalRecord } from '../../types/goals.js';

function makeGoal(overrides: Partial<GoalRecord> & Pick<GoalRecord, 'id' | 'title' | 'phase'>): GoalRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    id: overrides.id,
    chainId: overrides.chainId ?? 'billing',
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

describe('goal-chain storage', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `goal-chain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;
    mkdirSync(join(root, 'demo', 'workspaces'), { recursive: true });
    writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({
      name: 'demo',
      repository: 'owner/repo',
      baseBranch: 'main',
      createdAt: new Date(0).toISOString(),
      lastAccessed: new Date(0).toISOString(),
    }), 'utf-8');
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
    else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('lists planned goals from project-local sidecar files', () => {
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['schema', 'api'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writePlannedGoal('demo', makeGoal({ id: 'schema', title: 'Billing schema', phase: 'plan', plannedWorkspaceName: 'billing-schema' }));
    writePlannedGoal('demo', makeGoal({ id: 'api', title: 'Billing API', phase: 'code', plannedWorkspaceName: 'billing-api' }));

    const items = listProjectGoalKanbanItems('demo');
    expect(items.map((item) => ({ id: item.id, status: item.status, phase: item.phase }))).toEqual([
      { id: 'schema', status: 'planned', phase: 'plan' },
      { id: 'api', status: 'planned', phase: 'code' },
    ]);
    expect(items[1]?.blockedReason).toBe('Previous goal Billing schema has no workspace yet');
  });

  it('binds a planned goal to a workspace and writes the goal record there', () => {
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['schema'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writePlannedGoal('demo', makeGoal({ id: 'schema', title: 'Billing schema', phase: 'review', plannedWorkspaceName: 'billing-schema' }));
    mkdirSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true });

    const bound = bindPlannedGoalForWorkspace('demo', 'billing-schema');
    expect(bound?.workspaceName).toBe('billing-schema');
    expect(existsSync(getPlannedGoalPath('demo', 'schema'))).toBe(false);
    expect(existsSync(getWorkspaceGoalPath('demo', 'billing-schema'))).toBe(true);
    expect(readWorkspaceGoal('demo', 'billing-schema')?.id).toBe('schema');
    expect(getWorkspaceStatus('demo', 'billing-schema')).toBe('review');
  });

  it('moves planned validation artifacts dir into workspace storage on bind', () => {
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['schema'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const v0 = addRequirement(defaultValidation(), {
      title: 'Hover',
      kind: 'screenshot',
      rubric: 'show hover',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const plannedGoal = writePlannedGoal('demo', makeGoal({ id: 'schema', title: 'Billing schema', phase: 'review', plannedWorkspaceName: 'billing-schema', validation: v0.validation }));
    const sourcePath = join(root, 'hover.png');
    writeFileSync(sourcePath, 'png-bytes', 'utf-8');
    attachManualEvidence('demo', plannedGoal, v0.requirement.id, { path: sourcePath, name: 'hover' });
    mkdirSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true });

    const bound = bindPlannedGoalForWorkspace('demo', 'billing-schema');
    expect(bound?.workspaceName).toBe('billing-schema');
    expect(existsSync(getPlannedGoalValidationDir('demo', 'schema'))).toBe(false);
    expect(existsSync(getWorkspaceGoalValidationDir('demo', 'billing-schema'))).toBe(true);
  });

  it('projects validation onto kanban items with readiness', () => {
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['api'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'A short note.',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    writePlannedGoal('demo', makeGoal({ id: 'api', title: 'Billing API', phase: 'plan', plannedWorkspaceName: 'billing-api', validation: v0.validation }));

    const items = listProjectGoalKanbanItems('demo');
    expect(items[0]?.validation?.readiness?.summary).toBe('1 required artifact missing.');
    expect(items[0]?.validation?.requirements[v0.requirement.id].title).toBe('Note');
  });

  it('keeps planned validation storage out of project git status while preserving gitignore', () => {
    execFileSync('git', ['init'], { cwd: join(root, 'demo'), stdio: 'ignore' });
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['api'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const v0 = addRequirement(defaultValidation(), {
      title: 'Note',
      kind: 'note',
      rubric: 'note',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
    });
    const plannedGoal = writePlannedGoal('demo', makeGoal({ id: 'api', title: 'Billing API', phase: 'plan', plannedWorkspaceName: 'billing-api', validation: v0.validation }));
    attachManualEvidence('demo', plannedGoal, v0.requirement.id, { body: 'inline', name: 'n' });

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: join(root, 'demo'), encoding: 'utf-8' });
    expect(status).toContain('.gitignore');
    expect(status).not.toContain('.gitspace/goals/');
  });

  it('ignores workspace-local storage through git exclude without dirtying the worktree', () => {
    const workspaceDir = join(root, 'demo', 'workspaces', 'api');
    mkdirSync(workspaceDir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: workspaceDir });
    execFileSync('git', ['config', 'user.name', 'Demo'], { cwd: workspaceDir });
    writeFileSync(join(workspaceDir, 'README.md'), 'demo\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: workspaceDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: workspaceDir, stdio: 'ignore' });

    setWorkspaceStatus('demo', 'api', 'code');

    expect(existsSync(join(workspaceDir, '.gitignore'))).toBe(false);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: workspaceDir, encoding: 'utf-8' });
    expect(status).toBe('');
  });

  it('creates a chain around an existing workspace and reorders planned goals', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    setWorkspaceStatus('demo', 'api', 'plan');

    const ui = addGoalNearWorkspace('demo', 'api', 'Billing UI', 'after');
    const schema = addGoalNearWorkspace('demo', 'api', 'Billing schema', 'before');
    moveGoalInChain('demo', ui.id, schema.id, 'before');

    const items = listProjectGoalKanbanItems('demo');
    expect(items.map((item) => item.title)).toEqual(['Billing UI', 'Billing schema', 'api']);
    expect(items.map((item) => item.status)).toEqual(['planned', 'planned', 'workspace-backed']);
  });

  it('appends repeated add-after goals after existing planned descendants', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    setWorkspaceStatus('demo', 'api', 'plan');

    addGoalNearWorkspace('demo', 'api', 'Billing API', 'after');
    addGoalNearWorkspace('demo', 'api', 'Billing UI', 'after');

    const items = listProjectGoalKanbanItems('demo');
    expect(items.map((item) => item.title)).toEqual(['api', 'Billing API', 'Billing UI']);
  });

  it('prevents chain descendants from moving further along than ancestors', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'base'), { recursive: true });
    mkdirSync(join(root, 'demo', 'workspaces', 'child'), { recursive: true });
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['base', 'child'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writePlannedGoal('demo', makeGoal({ id: 'base', title: 'Base', phase: 'code', plannedWorkspaceName: 'base' }));
    writePlannedGoal('demo', makeGoal({ id: 'child', title: 'Child', phase: 'code', plannedWorkspaceName: 'child' }));
    bindPlannedGoalForWorkspace('demo', 'base');
    bindPlannedGoalForWorkspace('demo', 'child');

    setWorkspaceStatusForGoalChain('demo', 'child', 'code');
    expect(getWorkspaceStatus('demo', 'child')).toBe('code');
    expect(() => setWorkspaceStatusForGoalChain('demo', 'child', 'review')).toThrow(/Max allowed phase is code/);
  });

  it('previews and applies descendant cascades for backward ancestor moves', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'base'), { recursive: true });
    mkdirSync(join(root, 'demo', 'workspaces', 'child'), { recursive: true });
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['base', 'child'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writePlannedGoal('demo', makeGoal({ id: 'base', title: 'Base', phase: 'review', plannedWorkspaceName: 'base' }));
    writePlannedGoal('demo', makeGoal({ id: 'child', title: 'Child', phase: 'review', plannedWorkspaceName: 'child' }));
    bindPlannedGoalForWorkspace('demo', 'base');
    bindPlannedGoalForWorkspace('demo', 'child');

    const preview = previewWorkspaceGoalPhaseChange('demo', 'base', 'plan');
    expect(preview.allowed).toBe(true);
    expect(preview.requiresCascade).toBe(true);
    expect(preview.affected).toEqual([
      { workspaceName: 'child', goalId: 'child', title: 'Child', from: 'review', to: 'plan' },
    ]);

    expect(() => applyWorkspaceGoalPhaseChange('demo', 'base', 'plan')).toThrow(/requires moving 1 descendant workspace back/);
    applyWorkspaceGoalPhaseChange('demo', 'base', 'plan', { cascade: true });
    expect(getWorkspaceStatus('demo', 'base')).toBe('plan');
    expect(getWorkspaceStatus('demo', 'child')).toBe('plan');
  });
});

describe('canon write-through (docs/REVIEW-GUIDE.md)', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `canon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;
    mkdirSync(join(root, 'demo'), { recursive: true });
    writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({ name: 'demo', repository: 'x/y' }));
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
    else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('mirrors goal.md + rubric.json to the artifacts mount on goal writes', async () => {
    const { ensureArtifactsRepo, ensureArtifactsMount } = await import('../artifacts.js');
    const { writeGoalRecord } = await import('../goal-chain.js');
    const projectDir = join(root, 'demo');
    const workspaceDir = join(projectDir, 'workspaces', 'ws1');
    mkdirSync(workspaceDir, { recursive: true });
    execFileSync('git', ['init', '-q', workspaceDir]);
    await ensureArtifactsRepo(projectDir);
    const mount = await ensureArtifactsMount(projectDir, workspaceDir, 'ws1');

    let v = defaultValidation();
    const add = addRequirement(v, { title: 'R', kind: 'note', rubric: 'must do X', generation: { kind: 'manual' }, judgment: { kind: 'human' } });
    const goal = makeGoal({ id: 'g1', title: 'Canon goal', phase: 'code', workspaceName: 'ws1', validation: add.validation });
    writeGoalRecord('demo', goal);

    expect(readFileSync(join(mount, 'goal.md'), 'utf-8')).toContain('# Canon goal');
    const rubric = JSON.parse(readFileSync(join(mount, 'rubric.json'), 'utf-8'));
    expect(rubric.requirements[0]).toMatchObject({ title: 'R', rubric: 'must do X' });

    // second identical write does not add a canon commit; a rubric edit does
    const log1 = execFileSync('git', ['-C', mount, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').length;
    writeGoalRecord('demo', goal);
    const log2 = execFileSync('git', ['-C', mount, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').length;
    expect(log2).toBe(log1);
    const edited = { ...goal, validation: { ...add.validation, requirements: { ...add.validation.requirements, [add.requirement.id]: { ...add.requirement, rubric: 'must do X and Y' } } } };
    writeGoalRecord('demo', edited);
    const log3 = execFileSync('git', ['-C', mount, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').length;
    expect(log3).toBe(log2 + 1);
  });

  it('degrades silently without an artifacts mount', () => {
    const projectDir = join(root, 'demo');
    mkdirSync(join(projectDir, 'workspaces', 'ws2'), { recursive: true });
    const goal = makeGoal({ id: 'g2', title: 'No mount', phase: 'code', workspaceName: 'ws2' });
    expect(() => writeGoalRecord('demo', goal)).not.toThrow();
    expect(existsSync(join(projectDir, 'workspaces', 'ws2', '.gitspace', 'artifacts', 'goal.md'))).toBe(false);
  });
});
