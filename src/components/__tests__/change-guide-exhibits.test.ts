/**
 * The guide must not throw away what the narrator wrote.
 *
 * A guide is a curated reading order, not a file list — that distinction lives
 * entirely in per-exhibit metadata: `note` (why this file is in front of you) and
 * `slow` (this one needs judgment, not a skim). The mapping dropped both, and
 * stamped every exhibit 'modified', so an added or renamed file was described
 * wrongly in its own header.
 *
 * `changeType` stays provisional here on purpose: git's name-status is the
 * authority and the pane overrides it at render, where the rename source is
 * known too. These pin the parts the mapping owns.
 */
import { describe, expect, it } from 'bun:test';
import { walkStepsFromGuide } from '../change-guide-steps.js';
import type { ReviewGuide, GuideSection } from '../../core/review-guide.js';

function section(over: Partial<GuideSection>): GuideSection {
  return {
    clusterId: 'c1',
    title: 'Core',
    kind: 'core',
    explanation: 'What changed and why it matters.',
    exhibits: [],
    ...over,
  };
}

function guide(sections: GuideSection[]): ReviewGuide {
  return { version: 1, headSha: 'abc123', baseRef: 'main', generatedAt: '2026-01-01T00:00:00Z', sections };
}

describe('walkStepsFromGuide', () => {
  it('carries the narrator note and slow-read mark onto the exhibit', () => {
    const steps = walkStepsFromGuide(guide([
      section({ exhibits: [{ file: 'src/a.ts', note: 'the invariant lives here', slow: true }] }),
    ]));
    expect(steps[0]?.files[0]).toMatchObject({ path: 'src/a.ts', note: 'the invariant lives here', slow: true });
  });

  it('leaves note and slow undefined when the narrator did not mark the exhibit', () => {
    const steps = walkStepsFromGuide(guide([section({ exhibits: [{ file: 'src/b.ts' }] })]));
    expect(steps[0]?.files[0]?.note).toBeUndefined();
    expect(steps[0]?.files[0]?.slow).toBeUndefined();
  });

  it('keeps each exhibit distinct rather than flattening the marks across a section', () => {
    const steps = walkStepsFromGuide(guide([
      section({ exhibits: [{ file: 'a.ts', slow: true }, { file: 'b.ts' }, { file: 'c.ts', note: 'skim' }] }),
    ]));
    expect(steps[0]?.files.map((f) => f.slow)).toEqual([true, undefined, undefined]);
    expect(steps[0]?.files.map((f) => f.note)).toEqual([undefined, undefined, 'skim']);
  });

  it('preserves section order, ids, callouts, asks and the full file manifest', () => {
    const steps = walkStepsFromGuide(guide([
      section({ clusterId: 'first', title: 'One', asks: ['is this right?'], files: ['a.ts', 'b.ts'] }),
      section({ clusterId: 'second', title: 'Two', callouts: [{ tone: 'risk', text: 'watch this' }] }),
    ]));
    expect(steps.map((s) => s.sectionId)).toEqual(['first', 'second']);
    expect(steps.map((s) => s.n)).toEqual([1, 2]);
    expect(steps[0]?.asks).toEqual(['is this right?']);
    expect(steps[0]?.allFiles).toEqual(['a.ts', 'b.ts']);
    expect(steps[1]?.callouts).toEqual([{ tone: 'risk', text: 'watch this' }]);
  });

  it('renders the explanation as markdown, not as the plain `what` line', () => {
    const steps = walkStepsFromGuide(guide([section({ explanation: '**bold** point' })]));
    expect(steps[0]?.explanationMd).toBe('**bold** point');
    // `what` belongs to the heuristic walk's generated summary; a narrated
    // section has real prose and must not show a synthesised sentence too.
    expect(steps[0]?.what).toBe('');
  });

  it('produces a section with no exhibits rather than inventing one', () => {
    const steps = walkStepsFromGuide(guide([section({ exhibits: [] })]));
    expect(steps[0]?.files).toEqual([]);
  });
});
