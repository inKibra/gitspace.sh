import { describe, expect, it } from 'bun:test';

import { hasBlock, validateBlock } from '../index.js';

// Round-trip validation for the goal-doc planning vocabulary + workflow block.

describe('goal-doc blocks', () => {
  it('registers the goal-doc vocabulary', () => {
    for (const t of ['intent', 'boundaries', 'anti-shortcut', 'plan', 'evidence-shape', 'workflow']) {
      expect(hasBlock(t)).toBe(true);
    }
  });

  it('validates an intent block (quote + source + why)', () => {
    const r = validateBlock({
      id: 'g1',
      type: 'intent',
      data: { quote: 'One module everyone imports.', source: 'you · kickoff', why: 'Single source of truth, **enforced**.' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.block.data as { quote: string }).quote).toContain('module');
  });

  it('validates boundaries rows and rejects a row missing its rule', () => {
    const ok = validateBlock({
      id: 'g2',
      type: 'boundaries',
      data: { items: [{ surface: 'effects/index.ts public API', rule: 'Keep names + signatures.' }] },
    });
    expect(ok.ok).toBe(true);
    const bad = validateBlock({ id: 'g2', type: 'boundaries', data: { items: [{ surface: 'x' }] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid-data');
  });

  it('validates anti-shortcut rows (shortcut + why)', () => {
    const r = validateBlock({
      id: 'g3',
      type: 'anti-shortcut',
      data: { items: [{ shortcut: 'Re-export the old impls', why: 'Duplicate logic still exists.' }] },
    });
    expect(r.ok).toBe(true);
  });

  it('validates plan steps with optional file:line refs', () => {
    const r = validateBlock({
      id: 'g4',
      type: 'plan',
      data: {
        steps: [
          { title: 'Introduce shared types', detail: 'Add `effects/types.ts`.', refs: ['src/effects/types.ts (new)'] },
          { title: 'Route the pipeline', detail: 'Replace the private import.' }, // refs optional
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it('validates evidence-shape rows and rejects an unknown kind', () => {
    const ok = validateBlock({
      id: 'g5',
      type: 'evidence-shape',
      data: { items: [{ requirement: 'Per-file impls deleted', kind: 'command', captured: 'git status shows a.ts + b.ts deleted' }] },
    });
    expect(ok.ok).toBe(true);
    const bad = validateBlock({
      id: 'g5',
      type: 'evidence-shape',
      data: { items: [{ requirement: 'x', kind: 'vibes', captured: 'y' }] },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe('invalid-data');
      expect(bad.issues.some((i) => i.includes('kind'))).toBe(true);
    }
  });
});

describe('workflow block', () => {
  const phase = {
    name: 'create data types',
    inputs: [{ name: 'goal doc', io: 'artifact' }, { name: 'effects/a.ts', io: 'source' }],
    gate: { type: 'human', label: 'human approval' },
    loop: 'reviewer returns "changes" → implementation re-runs',
    created: [{ name: 'types brief', type: 'goal-slice', from: 'goal.md §Data model · L12–28', passedTo: 'implementation agent' }],
    nodes: [
      {
        id: 'i1', role: 'implementation agent', kind: 'agent', model: 'sonnet', status: 'done',
        reads: [{ name: 'types brief', io: 'artifact' }],
        writes: [{ name: 'types.ts', io: 'source' }],
        out: 'draft types.ts',
      },
      { id: 'g1', role: 'gate', kind: 'gate', gateType: 'human', status: 'done' },
    ],
    outputs: [{ name: 'types.ts', kind: 'code', io: 'source', required: true, status: 'created' }],
  };

  it('round-trips a full workflow spec (recipe, rollup, phases, typed dataflow)', () => {
    const r = validateBlock({
      id: 'wf1',
      type: 'workflow',
      data: {
        recipe: 'review-gated implementation',
        recipePath: '.gitspace/workflows/recipes/review-gated',
        rollup: ['3 phases', '9 agents', '142k tok', '$0.84'],
        phases: [phase],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.block.data as { phases: (typeof phase)[] };
      expect(data.phases[0].nodes[0].reads?.[0].io).toBe('artifact');
      expect(data.phases[0].outputs[0].required).toBe(true);
    }
  });

  it('rejects a node with an invalid io tag on reads', () => {
    const bad = structuredClone(phase);
    bad.nodes[0].reads = [{ name: 'types brief', io: 'sideways' }];
    const r = validateBlock({ id: 'wf2', type: 'workflow', data: { recipe: 'x', phases: [bad] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-data');
  });

  it('rejects an unknown created-artifact type', () => {
    const bad = structuredClone(phase);
    bad.created = [{ name: 'thing', type: 'mystery' }] as never;
    const r = validateBlock({ id: 'wf3', type: 'workflow', data: { recipe: 'x', phases: [bad] } });
    expect(r.ok).toBe(false);
  });
});
