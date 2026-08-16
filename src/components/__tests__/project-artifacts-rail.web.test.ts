/**
 * One rail, two surfaces.
 *
 * Project home and the workspace detail rail must show project artifacts the
 * same way. They diverged once already, because each hand-rolled its own
 * branch: the picker branch gave the project-root section a "Project" header and
 * showed one goal at a time, while the flat branch showed every goal stacked and
 * no headers at all. So the same artifacts gained or lost structure depending on
 * whether a rolled-up goal happened to exist elsewhere in the listing.
 *
 * These pin the grouping both surfaces now share.
 */
import { describe, expect, it } from 'bun:test';
import { groupArtifactsByGoal, type ProjectArtifactEntry } from '../ProjectArtifactsRail.web.js';

const entry = (path: string): ProjectArtifactEntry => ({ path, size: 10, pointer: false });

describe('groupArtifactsByGoal', () => {
  it('groups by goal id parsed from the goals/<id>/ prefix', () => {
    const sections = groupArtifactsByGoal([
      entry('goals/alpha-1234/demos/a.png'),
      entry('goals/beta-5678/demos/b.png'),
      entry('goals/alpha-1234/goal.md'),
    ]);
    expect(sections.map((s) => s.goalId)).toEqual(['alpha-1234', 'beta-5678']);
  });

  it('sorts the project-root section last — it is the residue, not the headline', () => {
    const sections = groupArtifactsByGoal([
      entry('README.md'),
      entry('goals/zeta-9999/goal.md'),
      entry('goals/alpha-1111/goal.md'),
    ]);
    expect(sections.map((s) => s.goalId)).toEqual(['alpha-1111', 'zeta-9999', '']);
  });

  it('keeps a project-only listing as a single root section', () => {
    // The state an early project is in: artifacts but nothing rolled up yet.
    // This used to fall into a headerless branch on one surface only.
    const sections = groupArtifactsByGoal([entry('notes.md'), entry('reports/x.report.json')]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.goalId).toBe('');
  });

  it('splits a goal into kind groups and drops empty ones', () => {
    const sections = groupArtifactsByGoal([
      entry('goals/g-1/goal.md'),
      entry('goals/g-1/shots/one.png'),
      entry('goals/g-1/shots/two.png'),
    ]);
    const kinds = sections[0]!.kindGroups;
    expect(kinds.length).toBeGreaterThan(0);
    // Every emitted group has files — an empty kind must not render a heading.
    expect(kinds.every(([, files]) => files.length > 0)).toBe(true);
    // Every input file lands in exactly one group.
    expect(kinds.reduce((n, [, files]) => n + files.length, 0)).toBe(3);
  });

  it('returns nothing for an empty listing so the caller can show its empty state', () => {
    expect(groupArtifactsByGoal([])).toEqual([]);
  });
});
