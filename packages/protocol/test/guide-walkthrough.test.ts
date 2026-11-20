import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { NARRATOR_EXAMPLE, DEFAULT_SKILLS } from '../src/default-skills.js';
import { builtWalkthrough, guidePart, guideVisualGaps, walkthroughIssues, type GuideParts } from '../src/guide-walkthrough.js';
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

/** A spec's Sequence frames, each content as it is. */
function framesOf(spec: unknown): { content: Record<string, unknown>; say: string }[] {
  return z.object({ elements: z.object({ walkthrough: z.object({ props: z.object({ frames: z.array(z.object({ content: z.record(z.string(), z.unknown()), say: z.string() })) }) }) }) })
    .parse(spec).elements.walkthrough.props.frames;
}

/** What each frame of a walkthrough of `parts` draws: a part of the guide by its kind, or an element by its type. */
function frameKinds(spec: unknown, parts: GuideParts): string[] {
  return framesOf(spec).map(({ content }) => typeof content.ref === 'string' ? guidePart(content.ref, parts.sections)?.kind ?? 'unresolved' : String(content.type));
}

const blob = (digit: string): string => digit.repeat(40);
/** Shaped like a real guide that played as text: five sections, no diagram, no walkthrough, the last without
 * exhibits. */
const pruned: GuideParts = {
  title: 'Prune tests that check nothing',
  intro: 'This change deletes 29 tests and rewrites 12 against behaviour callers see.',
  sections: [
    { id: 'mechanical', kind: 'mechanical', title: 'Duplicate tests deleted', summary: 'Most of the change: 22 duplicates.', why: 'Each repeats a test that owns the behaviour.', explanation: '- Copies of the API tests.', requirementIds: [],
      callouts: [{ tone: 'mechanical', text: 'Each commit names the test that covers what it deletes.' }],
      exhibits: [{ path: 'apps/api/test/loans.test.ts', blobId: blob('1'), note: 'Gains the copies\' two assertions.', slowRead: false }, { path: 'apps/api/src/reminders.test.ts', blobId: null, note: 'Deleted.', slowRead: false }] },
    { id: 'rewrites', kind: 'behavior', title: 'Rewrites that observe behaviour', summary: 'The loan desk tests assert what callers see.', why: 'They spied on internals.', explanation: '- Observe the mailer.', requirementIds: [],
      exhibits: [
        { path: 'apps/api/src/due.test.ts', blobId: blob('2'), note: 'A fixed clock.', slowRead: true },
        { path: 'apps/api/src/desk.test.ts', blobId: blob('3'), note: 'The checkout race at the mailer.', slowRead: true, ranges: [{ start: 40, end: 72 }] },
        { path: 'apps/api/src/units.test.ts', blobId: blob('4'), note: 'A fresh module per test.', slowRead: false },
      ] },
    { id: 'dead-code', kind: 'decision', title: 'Code only tests used', summary: 'The old planner is removed.', why: 'No caller is left.', explanation: '- The planner keeps its types.', requirementIds: [],
      callouts: [{ tone: 'decision', text: 'The catalog takes a major bump.' }],
      exhibits: [{ path: 'packages/planner/src/types.ts', blobId: blob('5'), note: 'What it still exports.', slowRead: false }, { path: '.changeset/prune.md', blobId: blob('6'), note: 'Version bumps.', slowRead: true }] },
    { id: 'deploy-owner', kind: 'behavior', title: 'Worker build outputs named once', summary: 'One module names the worker outputs.', why: 'The build and the deploy agree by construction.', explanation: '- The deploy reads it.', requirementIds: [],
      callouts: [{ tone: 'risk', text: 'A staging deploy is the final proof.' }],
      exhibits: [{ path: 'apps/web/workers.ts', blobId: blob('7'), note: 'The single owner.', slowRead: false }, { path: 'deploy/inputs.ts', blobId: blob('8'), note: 'The deploy reads it.', slowRead: false }] },
    { id: 'not-done', kind: 'risk', title: 'Left alone: the sync tests', summary: 'Two source scans stay; the code shows a likely cache bug.', why: 'A rewrite needs a native harness, and no CI job runs those tests.', explanation: '- Every cache hit downloads again.', requirementIds: [], exhibits: [] },
  ],
};

describe('Change Guide walkthrough', () => {
  it('accepts the walkthrough built for a guide written without one', () => {
    const built = builtWalkthrough(guide);
    expect(walkthroughIssues(built, guide)).toEqual([]);
  });

  it('builds an overview, then each section\'s diagram, else its card and key exhibit, else its card, saying whole short sentences', () => {
    const long = 'The parser used to read every file as version one, which silently dropped the new header fields and left the importer guessing at the encoding of each record it met';
    const parts: GuideParts = {
      title: 'Parser v2',
      intro: `${long}. It now reads v2.`,
      sections: [
        { ...guide.sections[0]!, summary: 'The parser reads v2 headers, e.g. the `version` line in parse.ts. Older files still read as v1.' },
        { id: 'cache', title: 'Cache parsed files', kind: 'risk', explanation: 'Keeps each parsed file.', why: 'Re-parsing was slow.', summary: `${long}.`, requirementIds: [],
          exhibits: [{ path: 'src/cache.ts', blobId: null, note: 'The cache.', slowRead: false }, { path: 'src/evict.ts', blobId: null, note: 'Eviction, by `size`.', slowRead: false, ranges: [{ start: 1, end: 4 }] }] },
        { id: 'notes', title: 'Release notes', kind: 'mechanical', explanation: 'Notes the change.', why: 'Readers ask.', requirementIds: [], exhibits: [] },
        { id: 'one', title: 'One file', kind: 'behavior', explanation: 'Touches one file.', why: '', requirementIds: [], exhibits: [{ path: 'src/one.ts', blobId: null, note: 'The file.', slowRead: false }] },
      ],
    };
    const built = builtWalkthrough(parts);
    expect(walkthroughIssues(built, parts)).toEqual([]);
    expect(framesOf(built)).toEqual([
      // The intro's first sentence is too long to speak whole, so it is left out.
      { content: { ref: 'overview' }, say: 'Parser v2. It has 4 sections.' },
      { content: { ref: 'diagram:parse' }, say: 'Section 1: Parse headers. The parser reads v2 headers, e.g. the version line in parse.ts.' },
      // Without a diagram, its card, then its key exhibit (the one with ranges) saying its note; a summary too long to
      // speak whole gives way to the explanation.
      { content: { ref: 'section:cache' }, say: 'Section 2: Cache parsed files. Keeps each parsed file.' },
      { content: { ref: 'exhibit:cache:src/evict.ts' }, say: 'Eviction, by size.' },
      // Without exhibits either, its card.
      { content: { ref: 'section:notes' }, say: 'Section 3: Release notes. Notes the change.' },
      // With one exhibit, that exhibit alone.
      { content: { ref: 'exhibit:one:src/one.ts' }, say: 'Section 4: One file. Touches one file.' },
    ]);
  });

  it('draws a guide shaped like the real one as section cards and diffs where it played four diffs and a wall of text', () => {
    const built = builtWalkthrough(pruned);
    expect(walkthroughIssues(built, pruned)).toEqual([]);
    expect(frameKinds(built, pruned)).toEqual(['overview', 'section', 'exhibit', 'section', 'exhibit', 'section', 'exhibit', 'section', 'exhibit', 'section']);
    // The key exhibit: the first with ranges, else the first marked for a slow read, else the first.
    expect(framesOf(built).flatMap((frame) => typeof frame.content.ref === 'string' && frame.content.ref.startsWith('exhibit:') ? [frame.content.ref] : [])).toEqual([
      'exhibit:mechanical:apps/api/test/loans.test.ts', 'exhibit:rewrites:apps/api/src/desk.test.ts', 'exhibit:dead-code:.changeset/prune.md', 'exhibit:deploy-owner:apps/web/workers.ts',
    ]);
    for (const { say } of framesOf(built)) expect(say.split(/(?<=[.!?])\s+(?=[A-Z])/u).length).toBeLessThanOrEqual(2);
  });

  it('shows a section with several exhibits by its key exhibit alone, from the last section on, when the frames would pass 30', () => {
    const [section] = pruned.sections;
    const many: GuideParts = { title: 'Many', sections: Array.from({ length: 20 }, (_, index) => ({ ...section!, id: `s${index}` })) };
    const built = builtWalkthrough(many);
    expect(walkthroughIssues(built, many)).toEqual([]);
    const kinds = frameKinds(built, many);
    expect(kinds).toHaveLength(30);
    expect(kinds.filter((kind) => kind === 'section')).toHaveLength(9);
    expect(kinds.slice(-11).every((kind) => kind === 'exhibit')).toBe(true);
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

describe('What a written Change Guide lacks', () => {
  it('names each section without a diagram but a decision section without exhibits, and a missing walkthrough, saying what to add', () => {
    const decisions = { id: 'calls', title: 'Calls made', kind: 'decision' as const, explanation: '- Kept v1.', why: '', requirementIds: [], exhibits: [] };
    const gaps = guideVisualGaps({ ...pruned, sections: [...pruned.sections, decisions] });
    expect(gaps).toEqual([
      expect.stringMatching(/^Sections without a diagram: mechanical, rewrites, dead-code, deploy-owner, not-done\. Give each one diagram .*CallDiff.*StateFlow or FlowMap.*MetricDelta or Stats.*ChangeSet.*SchemaDiff/u),
      expect.stringMatching(/^No walkthrough: add one /u),
    ]);
    const drawn = pruned.sections.map((section) => ({ ...section, diagram: guide.sections[0]!.diagram }));
    expect(guideVisualGaps({ ...pruned, sections: drawn, walkthrough: walk({ ref: 'overview' }, { ref: 'diagram:rewrites' }) })).toEqual([]);
  });

  it('the narrator skill\'s worked example is a guide that puts with nothing to add, and the skill shows it', () => {
    const example = changeGuideAgentDraftSchema.parse({
      headCommit: 'a'.repeat(40), baseRef: 'main', baseCommit: 'b'.repeat(40), title: NARRATOR_EXAMPLE.title, sections: [NARRATOR_EXAMPLE.section],
      walkthrough: { root: 'tour', elements: { tour: { type: 'Sequence', props: { title: NARRATOR_EXAMPLE.title, frames: NARRATOR_EXAMPLE.frames }, children: [] } } },
    });
    expect(guideVisualGaps(example)).toEqual([]);
    expect(frameKinds({ elements: { walkthrough: example.walkthrough?.elements.tour } }, example)).toEqual(['overview', 'diagram', 'exhibit', 'MetricDelta', 'Markdown']);
    expect(DEFAULT_SKILLS['review-guide-narrator']).toContain(JSON.stringify(NARRATOR_EXAMPLE.section));
  });
});
