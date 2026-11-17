import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
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

  it('builds an overview, then each section\'s diagram, else its first exhibit, else the section, saying whole short sentences', () => {
    const long = 'The parser used to read every file as version one, which silently dropped the new header fields and left the importer guessing at the encoding of each record it met';
    const parts: GuideParts = {
      title: 'Parser v2',
      intro: `${long}. It now reads v2.`,
      sections: [
        { ...guide.sections[0]!, summary: 'The parser reads v2 headers, e.g. the `version` line in parse.ts. Older files still read as v1.' },
        { id: 'cache', title: 'Cache parsed files', kind: 'risk', explanation: 'Keeps each parsed file.', why: 'Re-parsing was slow.', summary: `${long}.`, requirementIds: [],
          exhibits: [{ path: 'src/cache.ts', blobId: null, note: 'The cache.', slowRead: false }, { path: 'src/evict.ts', blobId: null, note: 'Eviction.', slowRead: false }] },
        { id: 'notes', title: 'Release notes', kind: 'mechanical', explanation: 'Notes the change.', why: 'Readers ask.', requirementIds: [], exhibits: [] },
      ],
    };
    const built = builtWalkthrough(parts);
    expect(walkthroughIssues(built, parts)).toEqual([]);
    const frames = z.object({ elements: z.object({ walkthrough: z.object({ props: z.object({ frames: z.array(z.object({ content: z.object({ ref: z.string() }), say: z.string() })) }) }) }) })
      .parse(built).elements.walkthrough.props.frames;
    expect(frames).toEqual([
      // The intro's first sentence is too long to speak whole, so it is left out.
      { content: { ref: 'overview' }, say: 'Parser v2. It has 3 sections.' },
      { content: { ref: 'diagram:parse' }, say: 'Section 1: Parse headers. The parser reads v2 headers, e.g. the version line in parse.ts.' },
      // Without a diagram, the first exhibit; a summary too long to speak whole gives way to the explanation.
      { content: { ref: 'exhibit:cache:src/cache.ts' }, say: 'Section 2: Cache parsed files. Keeps each parsed file.' },
      { content: { ref: 'section:notes' }, say: 'Section 3: Release notes. Notes the change.' },
    ]);
    for (const frame of frames) expect(frame.say).not.toMatch(/…$/u);
  });

  it('speaks only plain prose: the first prose paragraph after a list, without marks, and the title alone when there is none', () => {
    const list = '- `pr-labels.yaml` release: `always()`, no needs, `GITHUB_TOKEN`\n- the label changes start no runs';
    const parts: GuideParts = {
      title: 'Release labels',
      sections: [
        { id: 'buttons', title: 'The `preview` buttons', kind: 'behavior', explanation: 'Unused.', why: '', requirementIds: [], exhibits: [],
          summary: `${list}\n\n**Preview**, _ci_ and [verify](https://example.com/verify) are buttons; \`GITHUB_TOKEN\` marks the preview. More follows.` },
        { id: 'labels', title: 'Labels', kind: 'mechanical', explanation: 'Three labels change:\n- one\n- two', why: '', requirementIds: [], exhibits: [], summary: list },
      ],
    };
    const says = z.object({ elements: z.object({ walkthrough: z.object({ props: z.object({ frames: z.array(z.object({ say: z.string() })) }) }) }) })
      .parse(builtWalkthrough(parts)).elements.walkthrough.props.frames.map((frame) => frame.say);
    expect(says).toEqual([
      'Release labels. It has 2 sections.',
      'Section 1: The preview buttons. Preview, ci and verify are buttons; GITHUB_TOKEN marks the preview.',
      // The summary is only a list, and the explanation's prose only leads into one.
      'Section 2: Labels.',
    ]);
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
