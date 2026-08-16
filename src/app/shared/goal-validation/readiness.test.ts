import { describe, expect, it } from 'bun:test';
import { computeReadiness } from './readiness.js';
import type { GoalValidation, Requirement, ReviewTone } from '../../../types/goals.js';

function requirement(overrides: Partial<Requirement> & { id: string; title: string; kind?: Requirement['kind']; status?: Requirement['status'] }): Requirement {
  return {
    id: overrides.id,
    title: overrides.title,
    kind: overrides.kind ?? 'screenshot',
    required: overrides.required ?? true,
    rubric: overrides.rubric ?? 'Acceptance criteria.',
    status: overrides.status ?? 'missing',
    generation: overrides.generation ?? { kind: 'manual' },
    judgment: overrides.judgment ?? { kind: 'human' },
    evidence: overrides.evidence ?? [],
    reviews: overrides.reviews ?? [],
  };
}

function validation(reqs: Requirement[]): GoalValidation {
  return {
    reqOrder: reqs.map((r) => r.id),
    requirements: Object.fromEntries(reqs.map((r) => [r.id, r])),
    events: [],
  };
}

function review(tone: ReviewTone, note = 'note'): Requirement['reviews'][number] {
  return { id: `rv-${tone}`, tone, who: 'human', note, createdAt: new Date(0).toISOString() };
}

describe('computeReadiness', () => {
  it('reports missing artifacts in plain language', () => {
    const out = computeReadiness(validation([
      requirement({ id: 'a', title: 'Screenshot', status: 'missing' }),
      requirement({ id: 'b', title: 'Video', kind: 'video', status: 'missing' }),
    ]));
    expect(out.status).toBe('not-ready');
    expect(out.summary).toBe('2 required artifacts missing.');
    expect(out.totals.missing).toBe(2);
  });

  it('reports attached but unjudged', () => {
    const out = computeReadiness(validation([
      requirement({ id: 'a', title: 'Screenshot', status: 'review' }),
    ]));
    expect(out.status).toBe('awaiting-review');
    expect(out.summary).toBe('1 artifact attached but not judged.');
  });

  it('reports failed reviews', () => {
    const out = computeReadiness(validation([
      requirement({ id: 'a', title: 'Screenshot', status: 'review', reviews: [review('red', 'nope')] }),
    ]));
    expect(out.status).toBe('not-ready');
    expect(out.summary).toBe('1 requirement failed review.');
  });

  it('reports ready when all required requirements are accepted', () => {
    const out = computeReadiness(validation([
      requirement({ id: 'a', title: 'Screenshot', status: 'accepted', reviews: [review('green')] }),
      requirement({ id: 'b', title: 'Video', kind: 'video', status: 'accepted', reviews: [review('green')] }),
    ]));
    expect(out.status).toBe('ready');
    expect(out.summary).toBe('Ready: all required artifacts passed judgment.');
  });

  it('ignores optional requirements in totals', () => {
    const out = computeReadiness(validation([
      requirement({ id: 'a', title: 'Screenshot', status: 'accepted', reviews: [review('green')] }),
      requirement({ id: 'b', title: 'Optional note', kind: 'note', required: false, status: 'missing' }),
    ]));
    expect(out.status).toBe('ready');
    expect(out.summary).toBe('Ready: all required artifacts passed judgment.');
    expect(out.totals.total).toBe(1);
  });

  it('handles empty contract', () => {
    const out = computeReadiness(validation([]));
    expect(out.status).toBe('not-ready');
    expect(out.summary).toBe('No required artifacts declared.');
  });
});
