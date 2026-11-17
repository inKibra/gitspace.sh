// A Change Guide's walkthrough (docs/BLOCK-DOCUMENTS-DESIGN.md §6): a gitspace-ui spec whose root is a Sequence, stored
// with its revision. Besides what any Sequence frame shows, a walkthrough frame shows a part of its guide by ref:
// `section:<id>` (the section's title, summary and diagram), `diagram:<id>` (the section's diagram alone) or
// `exhibit:<section id>:<path>` (an exhibit's lines); a frame { ref: "<id>" } names a block element of the guide's
// Markdown. A guide written without a walkthrough plays one built from its sections' summaries and diagrams.
import { z } from 'zod';
import { extractBlocks, fenceSpec, isRecord, parseBlockRef, validateUiSpec, type UiBlockIssue } from './gitspace-ui.js';
import type { ChangeGuideSection } from './inspector-contract.js';

/** A spec element, typed as an opaque object so the walkthrough crosses Durable Object RPC (which refuses `unknown` and
 * whose types cannot follow recursive JSON); `walkthroughIssues` checks its shape. */
const walkthroughElementSchema: z.ZodType<object> = z.looseObject({});
/** A state value: any JSON value, typed without recursion for the same reason. */
const walkthroughStateValueSchema: z.ZodType<string | number | boolean | null | object> = z.json();

/** The walkthrough as stored: a spec { root, elements, state }; `walkthroughIssues` checks it against its guide. */
export const guideWalkthroughSchema = z.object({
  root: z.string().min(1).max(64).describe('The key of the root element: a Sequence.'),
  elements: z.record(z.string(), walkthroughElementSchema).describe('The spec\'s elements by key, each { type, props, children }; the root Sequence\'s props.frames are [{ content, say }].'),
  state: z.record(z.string(), walkthroughStateValueSchema).optional().describe('The spec\'s initial state; usually omitted.'),
}).strict();
export type GuideWalkthrough = z.infer<typeof guideWalkthroughSchema>;

/** The parts of a guide a walkthrough draws on. */
export interface GuideParts {
  title: string;
  intro?: string | undefined;
  sections: readonly ChangeGuideSection[];
}

/** A part of a guide a walkthrough frame shows by ref. */
export type GuidePart =
  | { kind: 'section'; section: ChangeGuideSection }
  | { kind: 'diagram'; section: ChangeGuideSection; diagram: string }
  | { kind: 'exhibit'; section: ChangeGuideSection; exhibit: ChangeGuideSection['exhibits'][number] };

/** The part of the guide `ref` names; null when it names none (a section id may itself hold ":"). */
export function guidePart(ref: string, sections: readonly ChangeGuideSection[]): GuidePart | null {
  if (ref.startsWith('section:')) {
    const section = sections.find((candidate) => candidate.id === ref.slice('section:'.length));
    return section ? { kind: 'section', section } : null;
  }
  if (ref.startsWith('diagram:')) {
    const section = sections.find((candidate) => candidate.id === ref.slice('diagram:'.length));
    return section?.diagram ? { kind: 'diagram', section, diagram: section.diagram } : null;
  }
  if (!ref.startsWith('exhibit:')) return null;
  for (const section of sections) {
    const prefix = `exhibit:${section.id}:`;
    if (!ref.startsWith(prefix)) continue;
    const exhibit = section.exhibits.find((candidate) => candidate.path === ref.slice(prefix.length));
    if (exhibit) return { kind: 'exhibit', section, exhibit };
  }
  return null;
}

/** Every Markdown field of the guide: its intro, and each section's prose, diagram, callouts and exhibit notes. */
export function guideMarkdown(guide: GuideParts): string[] {
  return [guide.intro, ...guide.sections.flatMap((section) => [
    section.summary, section.explanation, section.why, section.readersGuide, section.diagram,
    ...(section.callouts ?? []).map((callout) => callout.text),
    ...section.exhibits.flatMap((exhibit) => [exhibit.note, ...(exhibit.ranges ?? []).map((range) => range.note)]),
  ])].filter((markdown): markdown is string => typeof markdown === 'string' && markdown !== '');
}

/** The ids of the block elements in the guide's Markdown. */
export function guideElementIds(guide: GuideParts): Set<string> {
  const ids = new Set<string>();
  for (const markdown of guideMarkdown(guide)) {
    for (const block of extractBlocks(markdown)) {
      if (block.kind !== 'gitspace-ui' || !block.closed) continue;
      const read = fenceSpec(block.body, block.info);
      if ('issue' in read || !isRecord(read.spec) || !isRecord(read.spec.elements)) continue;
      for (const element of Object.values(read.spec.elements)) if (isRecord(element) && typeof element.id === 'string') ids.add(element.id);
    }
  }
  return ids;
}

function framesPath(key: string): string {
  return `/elements/${key.replaceAll('~', '~0').replaceAll('/', '~1')}/props/frames`;
}

/**
 * The walkthrough's issues against its guide: the checks of any block, its root a Sequence, and every frame ref naming
 * a section, a section's diagram, an exhibit or a block element of the guide. Issue paths are JSON pointers into it.
 */
export function walkthroughIssues(walkthrough: unknown, guide: GuideParts): UiBlockIssue[] {
  const parsed = guideWalkthroughSchema.safeParse(walkthrough);
  if (!parsed.success) return [{ path: '', message: 'a walkthrough is one gitspace-ui spec { "root", "elements", "state" } whose root is a Sequence' }];
  const { root, elements } = parsed.data;
  const rootElement = elements[root];
  if (!isRecord(rootElement) || rootElement.type !== 'Sequence') return [{ path: '/root', message: `the root "${root}" is not a Sequence; a walkthrough's root is a Sequence` }];
  const ids = guideElementIds(guide);
  /** Frame ref paths whose ref the guide resolves, and the issues of the ones it does not. */
  const resolved = new Set<string>();
  const unresolved: UiBlockIssue[] = [];
  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element) || element.type !== 'Sequence' || !isRecord(element.props) || !Array.isArray(element.props.frames)) continue;
    element.props.frames.forEach((frame, index) => {
      const ref = isRecord(frame) && isRecord(frame.content) ? frame.content.ref : undefined;
      if (typeof ref !== 'string') return;
      const path = `${framesPath(key)}/${index}/content/ref`;
      if (guidePart(ref, guide.sections)) { resolved.add(path); return; }
      const target = parseBlockRef(ref);
      if (target !== null && target.document === null && ids.has(target.id)) return;
      resolved.add(path);
      unresolved.push({ path, message: `no section, diagram, exhibit or block element "${ref}" in this Change Guide; a frame shows section:<id>, diagram:<id>, exhibit:<section id>:<path> or a block id` });
    });
  }
  return [...validateUiSpec(parsed.data).filter((issue) => !resolved.has(issue.path)), ...unresolved];
}

/** Markdown as one spoken line: its text without marks, links as their words, at most `max` characters. */
function spoken(markdown: string, max: number): string {
  const text = markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`#>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Frames a Sequence holds at most. */
const MAX_FRAMES = 30;
const MAX_SAY = 400;

/** The walkthrough of a guide written without one: the guide's title, then each section's title, summary and diagram
 * (`section:<id>`), saying its summary, or its title without one. */
export function builtWalkthrough(guide: GuideParts): GuideWalkthrough {
  const opening = {
    content: { type: 'Markdown', props: { content: `## ${guide.title}\n\n${guide.sections.length} section${guide.sections.length === 1 ? '' : 's'}` }, children: [] },
    say: spoken(`${guide.title}. ${guide.intro ?? ''}`, MAX_SAY) || 'The change.',
  };
  const frames = guide.sections.slice(0, MAX_FRAMES - 1).map((section, index) => ({
    content: { ref: `section:${section.id}` },
    say: spoken(`Section ${index + 1}: ${section.title}. ${section.summary ?? ''}`, MAX_SAY),
  }));
  return { root: 'walkthrough', elements: { walkthrough: { type: 'Sequence', props: { title: guide.title.slice(0, 120), frames: [opening, ...frames] }, children: [] } }, state: {} };
}
