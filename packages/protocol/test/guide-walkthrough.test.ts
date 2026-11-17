import { describe, expect, it } from 'bun:test';
import { builtWalkthrough, walkthroughIssues, type GuideParts } from '../src/guide-walkthrough.js';
import { changeGuideAgentDraftSchema, changeGuideViewSchema, submitChangeGuideInputSchema } from '../src/inspector-contract.js';

const fence = '```';
const numbers = JSON.stringify({ root: 'block', elements: { block: { type: 'Stats', id: 'hits', props: { tiles: [{ label: 'Hits', value: 9 }] }, children: [] } }, state: {} });
const guide: GuideParts = {
  title: 'Parser v2',
  intro: `The parser reads v2.\n\n${fence}gitspace-ui\n${numbers}\n${fence}`,
  sections: [{
    id: 'parse', title: 'Parse headers', kind: 'behavior', explanation: 'Reads the version first.', why: 'v2 files carry one.',
    summary: 'The parser reads v2 headers.', diagram: `${fence}mermaid\ngraph LR\n  read --> parse\n${fence}`,
    exhibits: [{ path: 'src/parse.ts', blobId: null, note: 'The version check.', slowRead: false }], requirementIds: [],
  }],
};

/** A walkthrough whose root Sequence shows `contents` in turn. */
function walk(...contents: Record<string, unknown>[]): Record<string, unknown> {
  return { root: 'tour', elements: { tour: { type: 'Sequence', props: { title: 'Parser v2', frames: contents.map((content, index) => ({ content, say: `Frame ${index + 1}.` })) }, children: [] } } };
}

describe('Change Guide walkthrough', () => {
  it('accepts the walkthrough built for a guide written without one', () => {
    const built = builtWalkthrough(guide);
    expect(walkthroughIssues(built, guide)).toEqual([]);
  });

  it('accepts frames showing a section, a diagram, an exhibit, a block element of the guide and one element', () => {
    const written = walk(
      { ref: 'section:parse' }, { ref: 'diagram:parse' }, { ref: 'exhibit:parse:src/parse.ts' }, { ref: 'hits' },
      { type: 'Markdown', props: { content: 'That is all.' }, children: [] },
    );
    expect(walkthroughIssues(written, guide)).toEqual([]);
  });

  it('names each ref the guide does not hold, and a root that is not a Sequence', () => {
    const issues = walkthroughIssues(walk({ ref: 'section:gone' }, { ref: 'exhibit:parse:src/other.ts' }, { ref: 'section:parse' }), guide);
    expect(issues.map((issue) => issue.path)).toEqual(['/elements/tour/props/frames/0/content/ref', '/elements/tour/props/frames/1/content/ref']);
    expect(issues[0]?.message).toContain('"section:gone"');
    const card = { root: 'card', elements: { card: { type: 'Card', props: { title: 'Not a walk' }, children: [] } } };
    expect(walkthroughIssues(card, guide)).toEqual([{ path: '/root', message: expect.stringContaining('not a Sequence') }]);
    expect(walkthroughIssues('a walk', guide)).toHaveLength(1);
  });

  it('refuses a written guide whose walkthrough does not resolve, with the issue at its path; stored views still read', () => {
    const draft = { headCommit: 'a'.repeat(40), baseRef: 'main', baseCommit: 'b'.repeat(40), title: guide.title, intro: guide.intro, sections: guide.sections };
    expect(changeGuideAgentDraftSchema.parse({ ...draft, walkthrough: walk({ ref: 'section:parse' }, { ref: 'diagram:parse' }) }).walkthrough?.root).toBe('tour');
    const refused = changeGuideAgentDraftSchema.safeParse({ ...draft, walkthrough: walk({ ref: 'section:gone' }, { ref: 'diagram:parse' }) });
    expect(refused.error?.issues.map((issue) => ({ path: issue.path, message: issue.message }))).toEqual([{
      path: ['walkthrough', 'elements', 'tour', 'props', 'frames', 0, 'content', 'ref'],
      message: expect.stringContaining('walkthrough/elements/tour/props/frames/0/content/ref: no section, diagram, exhibit or block element "section:gone"'),
    }]);
    const notSequence = { root: 'card', elements: { card: { type: 'Card', props: { title: 'x' }, children: [] } } };
    expect(submitChangeGuideInputSchema.safeParse({ ...draft, projectId: 'p', spaceId: 's', expectedRevision: 0, expectedGeneration: 0, createdBy: 'agent', walkthrough: notSequence }).error?.issues[0]?.path).toEqual(['walkthrough', 'root']);
    const stored = { ...draft, projectId: 'p', spaceId: 's', revision: 1, reviewerStates: [], createdAt: '2026-11-17T00:00:00.000Z', createdBy: 'agent', walkthrough: walk({ ref: 'section:gone' }, { ref: 'diagram:parse' }) };
    expect(changeGuideViewSchema.safeParse(stored).success).toBe(true);
  });
});
