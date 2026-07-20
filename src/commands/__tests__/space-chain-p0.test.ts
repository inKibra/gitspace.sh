import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addSpaceChainGoal,
  editSpaceGoal,
  removeSpaceChainGoal,
  setSpaceGoal,
  showSpaceGoal,
  moveSpaceChainGoal,
} from '../space-goals.js';
import {
  getGoalRecord,
  getPlannedGoalPath,
  getProjectGoalChainStatePath,
  listProjectGoalKanbanItems,
  readGoalChainState,
  readWorkspaceGoal,
} from '../../core/goal-chain.js';
import { listSpaceGoalDocSlices } from '../space-goals.js';

const envKey = 'GITSPACE_WORKSPACE_ROOT';
const ctx = { project: 'demo', workspace: 'api' };

/** Chain order by title — the surface every one of these assertions cares about. */
function chainTitles(): string[] {
  return listProjectGoalKanbanItems('demo').map((item) => item.title);
}

function plannedGoalIdByTitle(title: string): string {
  const item = listProjectGoalKanbanItems('demo').find((entry) => entry.title === title);
  if (!item) throw new Error(`No goal titled ${title}`);
  return item.id;
}

/** Byte-level snapshot of everything a chain mutation could write. */
function persistedState(): { chains: string; planned: string[] } {
  const chainsPath = getProjectGoalChainStatePath('demo');
  const plannedDir = join(chainsPath, '..', 'planned');
  return {
    chains: existsSync(chainsPath) ? readFileSync(chainsPath, 'utf-8') : '',
    planned: existsSync(plannedDir)
      ? require('fs').readdirSync(plannedDir).sort()
      : [],
  };
}

describe('space chain P0', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `space-chain-p0-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env[envKey];
    process.env[envKey] = root;
    mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'demo', '.config.json'),
      JSON.stringify({ name: 'demo', githubRepo: 'demo/repo', baseBranch: 'main', workspaces: [] }),
      'utf-8',
    );
    writeFileSync(join(root, 'demo', 'workspaces', 'api', '.gitignore'), '', 'utf-8');
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env[envKey];
    else process.env[envKey] = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  // ── insert positions ─────────────────────────────────────────────────────

  it('add --tail appends at the end of the chain', () => {
    addSpaceChainGoal(ctx, 'First', 'after');
    addSpaceChainGoal(ctx, 'Tail goal', undefined, { tail: true });
    expect(chainTitles()).toEqual(['api', 'First', 'Tail goal']);
  });

  it('add --at inserts at an absolute 0-indexed position', () => {
    addSpaceChainGoal(ctx, 'A', 'after');
    addSpaceChainGoal(ctx, 'B', 'after');
    // chain is [api, A, B]; insert at index 1 → between api and A
    addSpaceChainGoal(ctx, 'Wedged', undefined, { at: 1 });
    expect(chainTitles()).toEqual(['api', 'Wedged', 'A', 'B']);
  });

  it('add --at rejects an index past the end and suggests --tail', () => {
    expect(() => addSpaceChainGoal(ctx, 'Nope', undefined, { at: 9 })).toThrow(/--tail to append/);
  });

  it('add requires --tail or --at when no anchored position is given', () => {
    expect(() => addSpaceChainGoal(ctx, 'Nope', undefined, {})).toThrow(/needs --tail or --at/);
  });

  it('add-after anchors on an arbitrary goal via --goal, not just the active one', () => {
    addSpaceChainGoal(ctx, 'A', 'after');
    addSpaceChainGoal(ctx, 'B', 'after');
    const anchorId = plannedGoalIdByTitle('A');
    addSpaceChainGoal(ctx, 'After A', 'after', { goal: anchorId });
    expect(chainTitles()).toEqual(['api', 'A', 'After A', 'B']);
  });

  it('add-before anchors on an arbitrary goal via --goal', () => {
    addSpaceChainGoal(ctx, 'A', 'after');
    addSpaceChainGoal(ctx, 'B', 'after');
    addSpaceChainGoal(ctx, 'Before B', 'before', { goal: plannedGoalIdByTitle('B') });
    expect(chainTitles()).toEqual(['api', 'A', 'Before B', 'B']);
  });

  it('rejects an insert that would place a planned goal ahead of a goal past plan', () => {
    // The active workspace goal defaults to `code`, so nothing may precede it.
    expect(() => addSpaceChainGoal(ctx, 'Too early', undefined, { at: 0 })).toThrow(
      /further along than plan/,
    );
  });

  // ── remove ───────────────────────────────────────────────────────────────

  it('removing a PLANNED goal detaches it and deletes planned/<id>.json', () => {
    addSpaceChainGoal(ctx, 'Doomed', 'after');
    const goalId = plannedGoalIdByTitle('Doomed');
    expect(existsSync(getPlannedGoalPath('demo', goalId))).toBe(true);

    removeSpaceChainGoal(ctx, goalId);

    expect(chainTitles()).toEqual(['api']);
    expect(existsSync(getPlannedGoalPath('demo', goalId))).toBe(false);
    expect(getGoalRecord('demo', goalId)).toBeNull();
  });

  it('--detach-only removes the chain link but keeps the planned doc', () => {
    addSpaceChainGoal(ctx, 'Orphan', 'after');
    const goalId = plannedGoalIdByTitle('Orphan');

    removeSpaceChainGoal(ctx, goalId, { detachOnly: true });

    expect(chainTitles()).toEqual(['api']);
    expect(existsSync(getPlannedGoalPath('demo', goalId))).toBe(true);
  });

  it('resolves the goal with the same permissive selector as the other verbs', () => {
    addSpaceChainGoal(ctx, 'By title', 'after');
    removeSpaceChainGoal(ctx, 'By title');
    expect(chainTitles()).toEqual(['api']);
  });

  it('refuses to remove a workspace-backed goal without --force', () => {
    addSpaceChainGoal(ctx, 'Planned sibling', 'after');
    expect(() => removeSpaceChainGoal(ctx, 'api')).toThrow(/Remove the workspace first/);
    expect(chainTitles()).toEqual(['api', 'Planned sibling']);
  });

  it('--force detaches a workspace-backed goal but never deletes its goal.json', () => {
    addSpaceChainGoal(ctx, 'Planned sibling', 'after');
    removeSpaceChainGoal(ctx, 'api', { force: true });

    expect(chainTitles()).toEqual(['Planned sibling']);
    expect(readWorkspaceGoal('demo', 'api')).not.toBeNull();
  });

  it('errors on an unknown goal token', () => {
    expect(() => removeSpaceChainGoal(ctx, 'does-not-exist')).toThrow(/Goal not found/);
  });

  // ── dry-run writes nothing ───────────────────────────────────────────────

  it('--dry-run on add/remove/move leaves chains.json and planned/ byte-identical', () => {
    addSpaceChainGoal(ctx, 'Existing', 'after');
    const goalId = plannedGoalIdByTitle('Existing');
    const before = persistedState();

    addSpaceChainGoal(ctx, 'Ghost tail', undefined, { tail: true, dryRun: true });
    addSpaceChainGoal(ctx, 'Ghost anchored', 'after', { goal: goalId, dryRun: true });
    removeSpaceChainGoal(ctx, goalId, { dryRun: true });
    removeSpaceChainGoal(ctx, 'api', { force: true, dryRun: true });
    moveSpaceChainGoal(ctx, goalId, 'api', 'after', { dryRun: true });

    expect(persistedState()).toEqual(before);
    expect(chainTitles()).toEqual(['api', 'Existing']);
  });

  it('--dry-run still enforces the guards it would enforce on a real write', () => {
    addSpaceChainGoal(ctx, 'Sibling', 'after'); // materialises the active workspace goal + chain
    expect(() => removeSpaceChainGoal(ctx, 'api', { dryRun: true })).toThrow(/Remove the workspace first/);
  });

  // ── --goal on set / edit / doc / show ────────────────────────────────────

  it('goal set --goal authors a PLANNED goal body without touching the active goal', () => {
    addSpaceChainGoal(ctx, 'Planned body', 'after');
    const goalId = plannedGoalIdByTitle('Planned body');
    const activeBefore = readWorkspaceGoal('demo', 'api')!.doc.bodyMarkdown;

    setSpaceGoal(ctx, { goal: goalId, body: '# Planned body\n\n## Objective\nShip it.\n' });

    expect(getGoalRecord('demo', goalId)!.doc.bodyMarkdown).toContain('Ship it.');
    expect(readWorkspaceGoal('demo', 'api')!.doc.bodyMarkdown).toBe(activeBefore);
  });

  it('goal set without --goal still targets the active goal', () => {
    setSpaceGoal(ctx, { body: '# Active\n\nstill me\n' });
    expect(readWorkspaceGoal('demo', 'api')!.doc.bodyMarkdown).toContain('still me');
  });

  it('goal show --goal reads the planned goal', () => {
    addSpaceChainGoal(ctx, 'Shown', 'after');
    const goalId = plannedGoalIdByTitle('Shown');
    setSpaceGoal(ctx, { goal: goalId, body: '# Shown\n\nvisible\n' });

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      showSpaceGoal(ctx, { goal: goalId });
    } finally {
      console.log = originalLog;
    }
    expect(lines.join('\n')).toContain('visible');
  });

  it('goal doc slices --goal parses the planned goal doc', () => {
    addSpaceChainGoal(ctx, 'Sliced', 'after');
    const goalId = plannedGoalIdByTitle('Sliced');
    setSpaceGoal(ctx, { goal: goalId, body: '# Sliced\n\n## Objective\n\n## Non-goals\n' });

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      listSpaceGoalDocSlices(ctx, { goal: goalId });
    } finally {
      console.log = originalLog;
    }
    expect(lines.join('\n')).toContain('objective');
  });

  it('goal edit --goal writes back to the goal it opened, not the active one', () => {
    addSpaceChainGoal(ctx, 'Edited', 'after');
    const goalId = plannedGoalIdByTitle('Edited');
    const activeBefore = readWorkspaceGoal('demo', 'api')!.doc.bodyMarkdown;
    // A fake "editor" that rewrites the temp file it is handed.
    const fakeEditor = join(root, 'fake-editor.sh');
    writeFileSync(fakeEditor, '#!/bin/sh\nprintf "# Edited\\n\\nfrom editor\\n" > "$1"\n', { mode: 0o755 });

    editSpaceGoal(ctx, { goal: goalId, editor: fakeEditor });

    expect(getGoalRecord('demo', goalId)!.doc.bodyMarkdown).toContain('from editor');
    expect(readWorkspaceGoal('demo', 'api')!.doc.bodyMarkdown).toBe(activeBefore);
  });

  it('keeps the chain state file consistent with the rendered order after a remove', () => {
    addSpaceChainGoal(ctx, 'One', 'after');
    addSpaceChainGoal(ctx, 'Two', 'after');
    removeSpaceChainGoal(ctx, 'One');

    const state = readGoalChainState('demo');
    const chain = state.chains[0]!;
    expect(chain.goalIds).toHaveLength(2);
    expect(chainTitles()).toEqual(['api', 'Two']);
  });
});
