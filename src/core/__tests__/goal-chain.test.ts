import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import {
  addGoalNearWorkspace,
  addPlannedGoalToChain,
  applyWorkspaceGoalPhaseChange,
  archiveWorkspaceGoal,
  bindPlannedGoalForWorkspace,
  getArchivedGoalPath,
  getGoalRecord,
  getPlannedGoalPath,
  getWorkspaceGoalPath,
  listGoalChainSummaries,
  listProjectGoalKanbanItems,
  moveGoalInChain,
  previewWorkspaceGoalPhaseChange,
  readArchivedGoal,
  readWorkspaceGoal,
  setWorkspaceStatusForGoalChain,
  upsertGoalChain,
  writeArchivedGoal,
  writeGoalRecord,
  writePlannedGoal,
  writeWorkspaceGoal,
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
    // A planned goal is ALWAYS 'plan' — it hasn't started (writePlannedGoal
    // normalises the phase), so both cards read 'plan' regardless of the phase
    // the caller passed in.
    expect(items.map((item) => ({ id: item.id, status: item.status, phase: item.phase }))).toEqual([
      { id: 'schema', status: 'planned', phase: 'plan' },
      { id: 'api', status: 'planned', phase: 'plan' },
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
    // Binding a planned goal starts the workspace in 'plan' (author the spec
    // first) — the planned target phase is never inherited (see 4f76cb5).
    expect(getWorkspaceStatus('demo', 'billing-schema')).toBe('plan');
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

    // Bound workspaces start in 'plan'; advance the ancestor first so the
    // descendant is allowed to reach 'code' too.
    setWorkspaceStatusForGoalChain('demo', 'base', 'code');
    setWorkspaceStatusForGoalChain('demo', 'child', 'code');
    expect(getWorkspaceStatus('demo', 'child')).toBe('code');
    expect(() => setWorkspaceStatusForGoalChain('demo', 'child', 'review')).toThrow(/Max allowed phase is code/);
  });

  it('round-trips an archived goal record through the project-level store', () => {
    const goal = makeGoal({ id: 'schema', title: 'Billing schema', phase: 'code', workspaceName: 'billing-schema' });
    const written = writeArchivedGoal('demo', goal);
    expect(written.archivedAt).toBeTruthy();
    expect(existsSync(getArchivedGoalPath('demo', 'schema'))).toBe(true);

    const read = readArchivedGoal('demo', 'schema');
    expect(read?.id).toBe('schema');
    expect(read?.phase).toBe('code');
    expect(read?.archivedAt).toBe(written.archivedAt);
  });

  it('archives a workspace goal and keeps the chain link (id still resolves)', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true });
    upsertGoalChain('demo', {
      id: 'billing',
      title: 'Billing rollout',
      projectName: 'demo',
      goalIds: ['schema'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writeWorkspaceGoal('demo', 'billing-schema', makeGoal({ id: 'schema', title: 'Billing schema', phase: 'review', workspaceName: 'billing-schema' }));

    const archived = archiveWorkspaceGoal('demo', 'billing-schema');
    expect(archived?.id).toBe('schema');
    expect(archived?.archivedAt).toBeTruthy();
    expect(existsSync(getArchivedGoalPath('demo', 'schema'))).toBe(true);

    // Simulate the worktree (and its goal.json) being destroyed by delete.
    rmSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true, force: true });

    // Archived goals are EXCLUDED from the kanban (active-work board only)...
    const items = listProjectGoalKanbanItems('demo');
    expect(items.map((item) => item.id)).toEqual([]);

    // ...but the chain link survives: still resolvable by id (phase frozen at
    // 'review'), and present in the chain summary marked 'archived' so it stays
    // openable from the chain view.
    const resolved = getGoalRecord('demo', 'schema');
    expect(resolved?.id).toBe('schema');
    expect(resolved?.phase).toBe('review');
    expect(resolved?.archivedAt).toBeTruthy();

    const chain = listGoalChainSummaries('demo').find((c) => c.id === 'billing');
    expect(chain?.goals).toEqual([
      { id: 'schema', title: 'Billing schema', phase: 'review', status: 'archived' },
    ]);
  });

  it('getGoalRecord falls back to the archived store after the workspace is gone', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true });
    writeWorkspaceGoal('demo', 'billing-schema', makeGoal({ id: 'schema', title: 'Billing schema', phase: 'ship', workspaceName: 'billing-schema' }));
    archiveWorkspaceGoal('demo', 'billing-schema');
    rmSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true, force: true });

    const resolved = getGoalRecord('demo', 'schema');
    expect(resolved?.id).toBe('schema');
    expect(resolved?.phase).toBe('ship');
    expect(resolved?.archivedAt).toBeTruthy();
  });

  it('archiveWorkspaceGoal no-ops when the workspace has no goal', () => {
    mkdirSync(join(root, 'demo', 'workspaces', 'empty'), { recursive: true });
    expect(archiveWorkspaceGoal('demo', 'empty')).toBeNull();
    expect(existsSync(getArchivedGoalPath('demo', 'empty'))).toBe(false);
  });

  it('prefers the live workspace goal over an archived record with the same id', () => {
    writeArchivedGoal('demo', makeGoal({ id: 'schema', title: 'Stale archived', phase: 'plan', workspaceName: 'billing-schema' }));
    mkdirSync(join(root, 'demo', 'workspaces', 'billing-schema'), { recursive: true });
    writeWorkspaceGoal('demo', 'billing-schema', makeGoal({ id: 'schema', title: 'Live goal', phase: 'code', workspaceName: 'billing-schema' }));

    const resolved = getGoalRecord('demo', 'schema');
    expect(resolved?.title).toBe('Live goal');
    expect(resolved?.phase).toBe('code');
    expect(resolved?.archivedAt).toBeUndefined();
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

    // Bound workspaces start in 'plan'; advance both to 'review' (ancestor
    // first) so there is a backward move to cascade.
    setWorkspaceStatusForGoalChain('demo', 'base', 'review');
    setWorkspaceStatusForGoalChain('demo', 'child', 'review');

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

describe('chain-centric planned goal creation (workspace-free)', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `goal-chain-planned-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('creates a new chain seeded with a single planned goal', () => {
    const result = addPlannedGoalToChain('demo', { title: 'Design schema', newChainTitle: 'Billing revamp' });
    expect(result.chain.title).toBe('Billing revamp');
    expect(result.chain.goalIds).toEqual([result.goal!.id]);
    expect(result.goal!.workspaceName).toBeUndefined();
    expect(result.goal!.title).toBe('Design schema');

    const chains = listGoalChainSummaries('demo');
    expect(chains).toHaveLength(1);
    expect(chains[0]!.title).toBe('Billing revamp');
    expect(chains[0]!.goals.map((g) => g.title)).toEqual(['Design schema']);
    expect(chains[0]!.goals[0]!.phase).toBe('plan');
    expect(chains[0]!.goals[0]!.status).toBe('planned');
  });

  it('appends to an existing chain at the tail', () => {
    const first = addPlannedGoalToChain('demo', { title: 'First', newChainTitle: 'Chain A' });
    const chainId = first.chain.id;
    addPlannedGoalToChain('demo', { title: 'Second', chainId, position: { kind: 'tail' } });

    const chain = listGoalChainSummaries('demo')[0]!;
    expect(chain.goals.map((g) => g.title)).toEqual(['First', 'Second']);
  });

  it('inserts before a goal (start of chain) and after an anchor', () => {
    const first = addPlannedGoalToChain('demo', { title: 'B', newChainTitle: 'Chain A' });
    const chainId = first.chain.id;
    // Insert at start (index 0) → goes before B.
    addPlannedGoalToChain('demo', { title: 'A', chainId, position: { kind: 'index', index: 0 } });
    // Insert after the A anchor.
    const chainNow = listGoalChainSummaries('demo')[0]!;
    const aGoal = chainNow.goals.find((g) => g.title === 'A')!;
    addPlannedGoalToChain('demo', { title: 'A2', chainId, position: { kind: 'anchor', anchor: aGoal.id, side: 'after' } });

    const chain = listGoalChainSummaries('demo')[0]!;
    expect(chain.goals.map((g) => g.title)).toEqual(['A', 'A2', 'B']);
  });

  it('refuses inserting before a goal that has advanced past plan', () => {
    // A workspace-backed goal in 'code' anchors the chain head.
    mkdirSync(join(root, 'demo', 'workspaces', 'built'), { recursive: true });
    upsertGoalChain('demo', {
      id: 'chainX',
      title: 'Chain X',
      projectName: 'demo',
      goalIds: ['built'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writeWorkspaceGoal('demo', 'built', makeGoal({ id: 'built', chainId: 'chainX', title: 'Built', phase: 'code', workspaceName: 'built' }));
    setWorkspaceStatus('demo', 'built', 'code');

    // The summary reports the effective phase so the UI can filter.
    const chain = listGoalChainSummaries('demo')[0]!;
    expect(chain.goals[0]!.phase).toBe('code');

    // Inserting at index 0 (before the 'code' goal) is illegal and must throw.
    expect(() => addPlannedGoalToChain('demo', { title: 'New', chainId: 'chainX', position: { kind: 'index', index: 0 } }))
      .toThrow(/further along than plan/);
    // Inserting before the anchor is equally illegal.
    expect(() => addPlannedGoalToChain('demo', { title: 'New', chainId: 'chainX', position: { kind: 'anchor', anchor: 'built', side: 'before' } }))
      .toThrow(/further along than plan/);
    // Tail (after the 'code' goal) is legal.
    const ok = addPlannedGoalToChain('demo', { title: 'New', chainId: 'chainX', position: { kind: 'tail' } });
    expect(ok.goalIds).toEqual(['built', ok.goal!.id]);
  });

  it('rejects a missing chain and a blank title', () => {
    expect(() => addPlannedGoalToChain('demo', { title: 'X', chainId: 'nope' })).toThrow(/Chain not found/);
    expect(() => addPlannedGoalToChain('demo', { title: '   ', newChainTitle: 'Chain' })).toThrow(/Goal title is required/);
    expect(() => addPlannedGoalToChain('demo', { title: 'X', newChainTitle: '  ' })).toThrow(/Chain title is required/);
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

  it('mirrors goal.md + rubric.json into the goal folder on goal writes', async () => {
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

    // Canon lands in the goal's own disjoint folder, never at the mount root —
    // root canon is what made two workspace branches collide on roll-up
    // (docs/ARTIFACTS-FS.md "Tree layout").
    const goalDir = join(mount, 'goals', 'g1');
    expect(readFileSync(join(goalDir, 'goal.md'), 'utf-8')).toContain('# Canon goal');
    expect(existsSync(join(mount, 'goal.md'))).toBe(false);
    const rubric = JSON.parse(readFileSync(join(goalDir, 'rubric.json'), 'utf-8'));
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
