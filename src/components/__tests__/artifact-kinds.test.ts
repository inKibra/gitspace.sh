/**
 * classifyArtifact / toGoalRelative — the UI's artifact classifier must agree
 * with the goal-keyed layout (df0a94f). The daemon lists artifacts MOUNT-relative
 * (`goals/<goal-id>/reports/x`), while the folder conventions are written
 * goal-relative, so classification reconciles onto the goal-relative basis.
 * These lock BOTH bases: goal-keyed paths AND still-flat paths must classify the
 * same, so a not-yet-migrated repo and a project-root artifact never regress.
 */
import { describe, expect, it } from 'bun:test';
import { classifyArtifact, toGoalRelative, type ArtifactKind } from '../artifact-kinds.js';

const GID = 'multi-pane-be05a1cc';

describe('toGoalRelative', () => {
  it('strips a leading goals/<id>/ segment', () => {
    expect(toGoalRelative(`goals/${GID}/reports/x.md`)).toBe('reports/x.md');
    expect(toGoalRelative(`goals/${GID}/rubric.json`)).toBe('rubric.json');
    expect(toGoalRelative(`goals/${GID}/validation/g/ev.png`)).toBe('validation/g/ev.png');
  });
  it('leaves flat / project-root paths untouched', () => {
    expect(toGoalRelative('reports/x.md')).toBe('reports/x.md');
    expect(toGoalRelative('README.md')).toBe('README.md');
    expect(toGoalRelative('goal.md')).toBe('goal.md');
  });
  it('only strips the first goals/<id>/ segment', () => {
    expect(toGoalRelative(`goals/${GID}/goals/other/x`)).toBe('goals/other/x');
  });
});

describe('classifyArtifact — goal-keyed (mount-relative) paths', () => {
  const cases: Array<[string, ArtifactKind]> = [
    [`goals/${GID}/goal.md`, 'goal'],
    [`goals/${GID}/rubric.json`, 'rubric'],
    [`goals/${GID}/parity.workflow.json`, 'workflow'],
    [`goals/${GID}/ship.dashboard.json`, 'dashboard'],
    [`goals/${GID}/apps/ops-board.gssh.html`, 'app'],
    [`goals/${GID}/data/build.data.json`, 'data'],
    [`goals/${GID}/data/raw.csv`, 'data'],
    [`goals/${GID}/reports/rollout.md`, 'report'],
    [`goals/${GID}/validation/goal-x/ev-shot.png`, 'evidence'],
    [`goals/${GID}/evidence/proof.txt`, 'evidence'],
    [`goals/${GID}/shots/frame.png`, 'evidence'],
    [`goals/${GID}/demos/clip.webm`, 'evidence'],
    [`goals/${GID}/notes/n.md`, 'note'],
    [`goals/${GID}/goal/extra.md`, 'goal'],
    [`goals/${GID}/journal/01-plan.json`, 'other'],
  ];
  for (const [path, kind] of cases) {
    it(`${path} → ${kind}`, () => expect(classifyArtifact(path)).toBe(kind));
  }
});

describe('classifyArtifact — flat paths still classify (backward-compatible)', () => {
  const cases: Array<[string, ArtifactKind]> = [
    ['goal.md', 'goal'],
    ['rubric.json', 'rubric'],
    ['plan.workflow.json', 'workflow'],
    ['x.dashboard.json', 'dashboard'],
    ['app.gssh.html', 'app'],
    ['data/build.data.json', 'data'],
    ['reports/x.md', 'report'],
    ['validation/ev.png', 'evidence'],
    ['demos/clip.webm', 'evidence'],
    ['notes/n.md', 'note'],
    ['README.md', 'other'],
  ];
  for (const [path, kind] of cases) {
    it(`${path} → ${kind}`, () => expect(classifyArtifact(path)).toBe(kind));
  }
});

describe('classifyArtifact — session scratch is never typed', () => {
  it('keeps .sessions scratch as other even with a typed extension', () => {
    expect(classifyArtifact('.sessions/sess-1/local/sneaky.dashboard.json')).toBe('other');
    expect(classifyArtifact('.sessions')).toBe('other');
  });
});
