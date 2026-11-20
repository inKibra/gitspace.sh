// A Change Guide's walkthrough (docs/BLOCK-DOCUMENTS-DESIGN.md §6), played from the guide's header: the Sequence the
// agent wrote with the revision, or for a guide written without one, the one built from its sections
// (`builtWalkthrough`). It plays full-screen in the Sequence player, with speech where the workspace has a voice. A
// frame shows the guide at a glance (its sections in lanes by kind, each as wide as its share of the files, with its
// files and lines), a section (with a diagram: its title, summary and diagram; without: a card of its files and its
// callouts or why), a section's diagram, an exhibit's note and the start of its lines, or a block of the guide's
// Markdown by its id; a diagram or an exhibit is headed by its section. Lines are counted once the guide has measured
// every file of a section.
import type { ChangeGuideSection, ChangeMap, RepositoryDiffView } from '@gitspace/protocol';
import { builtWalkthrough, firstSentence, guideMarkdown, guidePart, type GuideWalkthrough } from '@gitspace/protocol/guide-walkthrough';
import { Button, StatTile } from '@gitspace/ui';
import { PlayCircle } from '@untitledui/icons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { DocumentRefs, RecordBlockDocument, SequenceStart } from '../blocks/BlockDocument.js';
import { UiBlock } from '../blocks/UiBlock.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { Counts } from './ChangeTreemap.js';
import { ExhibitDiff, GuideScrollRoot } from './ExhibitDiff.js';
import { Callout, SECTION_KIND } from './GuideSection.js';
import type { FileChange } from './iso-layout.js';

/** The parts of a guide its walkthrough plays. */
export interface WalkthroughGuide {
  title: string;
  intro?: string | undefined;
  sections: readonly ChangeGuideSection[];
  map?: ChangeMap | undefined;
  walkthrough?: GuideWalkthrough | undefined;
}

/** The player is a dialog over the page, outside the guide's scroll box: its exhibits load as they near the viewport. */
const PLAYER_SCROLL_ROOT = { current: null };
/** Callouts a section's card shows at most. */
const CARD_CALLOUTS = 3;
/** The longest `why` a section's card shows whole; a longer one shows its first sentence. */
const CARD_WHY = 280;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A section's number, kind and title, above a frame showing it or a part of it. */
function SectionHeading({ section, number, large }: { section: ChangeGuideSection; number: number; large: boolean }) {
  return <header className="flex flex-col gap-1">
    <span className="flex items-center gap-1.5 text-caption text-muted-foreground"><span className="size-2 rounded-full" style={{ background: SECTION_KIND[section.kind].color }} />§{number} · {SECTION_KIND[section.kind].label}</span>
    <h2 className={`${large ? 'text-[26px] leading-tight' : 'text-title'} font-semibold text-foreground`}>{section.title}</h2>
  </header>;
}

/** The guide at a glance: one lane per section kind, in the order the kinds first appear, holding its sections in
 * reading order; a section's tile is as wide as its share of its lane's files and shows its file count and its lines. */
function Overview({ guide, lines }: { guide: WalkthroughGuide; lines: ReadonlyMap<string, FileChange> }) {
  const files = new Set(guide.sections.flatMap((section) => section.exhibits.map((exhibit) => exhibit.path))).size;
  const kinds = [...new Set(guide.sections.map((section) => section.kind))];
  return <section data-walkthrough-overview="" className="mx-auto flex w-full max-w-5xl flex-col gap-5">
    <header className="flex flex-col gap-1">
      <span className="text-caption text-muted-foreground">Change Guide · {plural(guide.sections.length, 'section')} · {plural(files, 'file')}</span>
      <h2 className="text-[28px] font-semibold leading-tight text-foreground">{guide.title}</h2>
    </header>
    <div className="flex flex-col gap-3">
      {kinds.map((kind) => {
        const lane = guide.sections.filter((section) => section.kind === kind);
        const { color, label } = SECTION_KIND[kind];
        return <div key={kind} data-walkthrough-lane={kind} className="flex items-stretch gap-3">
          <div className="flex w-28 shrink-0 flex-col justify-center gap-0.5">
            <span className="flex items-center gap-1.5 text-body font-semibold text-foreground"><span className="size-2 rounded-full" style={{ background: color }} />{label}</span>
            <span className="text-caption tabular-nums text-muted-foreground">{plural(lane.reduce((sum, section) => sum + section.exhibits.length, 0), 'file')}</span>
          </div>
          <ol className="flex min-w-0 flex-1 flex-wrap gap-2">
            {lane.map((section) => {
              const counted = lines.get(section.id);
              return <li key={section.id} data-walkthrough-card={section.id}
                className="flex min-w-44 basis-0 flex-col gap-1 rounded-lg p-3 shadow-[inset_0_0_0_1px_var(--border)]"
                style={{ flexGrow: Math.max(1, section.exhibits.length), borderLeft: `3px solid ${color}`, background: `color-mix(in oklab, ${color} 12%, var(--surface-1))` }}>
                <span className="text-caption tabular-nums text-muted-foreground">§{guide.sections.indexOf(section) + 1} · {section.exhibits.length ? plural(section.exhibits.length, 'file') : 'no files'}</span>
                <span className="line-clamp-2 text-body font-semibold leading-snug text-foreground">{section.title}</span>
                {counted ? <span className="text-caption"><Counts change={counted} /></span> : null}
              </li>;
            })}
          </ol>
        </div>;
      })}
    </div>
  </section>;
}

/** A section without a diagram at a glance: its summary's first sentence; its files, with the lines they add and
 * remove once counted, else how many need a slow read; and its callouts, else its why. */
function SectionCard({ section, number, counted }: { section: ChangeGuideSection; number: number; counted: FileChange | undefined }) {
  const gist = firstSentence(section.summary);
  const slow = section.exhibits.filter((exhibit) => exhibit.slowRead).length;
  const why = section.why.trim();
  const reason = why.length <= CARD_WHY ? why : firstSentence(why);
  const callouts = section.callouts ?? [];
  return <section data-walkthrough-section={section.id} className="mx-auto flex w-full max-w-4xl flex-col gap-4">
    <SectionHeading section={section} number={number} large />
    {gist ? <p className="text-[17px] leading-relaxed text-foreground">{gist}</p> : null}
    {section.exhibits.length ? <div data-walkthrough-numbers="" className="grid grid-cols-3 gap-2">
      <StatTile label="Files" value={section.exhibits.length} />
      {counted ? <><StatTile label="Lines added" value={`+${counted.additions}`} /><StatTile label="Lines removed" value={`−${counted.deletions}`} /></>
        : slow ? <StatTile label="Slow reads" value={slow} detail="read line by line" /> : null}
    </div> : null}
    {callouts.length ? <div className="flex flex-col gap-2">{callouts.slice(0, CARD_CALLOUTS).map((callout, index) => <Callout key={index} callout={callout} />)}</div>
      : reason ? <div className="text-body leading-relaxed text-muted-foreground"><GitSpaceMarkdown>{`**Why.** ${reason}`}</GitSpaceMarkdown></div> : null}
  </section>;
}

/** The Play button, and the walkthrough playing while it is open. `changes`: the lines of each file the guide has
 * measured, null until they are. */
export function GuideWalkthroughButton({ guide, changes, onLoadDiff }: { guide: WalkthroughGuide; changes: ReadonlyMap<string, FileChange> | null; onLoadDiff(path: string): Promise<RepositoryDiffView> }) {
  const [playing, setPlaying] = useState(false);
  const spec = useMemo(() => guide.walkthrough ?? builtWalkthrough(guide), [guide]);
  const markdown = useMemo(() => guideMarkdown(guide), [guide]);
  // Each section's lines, once every one of its files is measured.
  const lines = useMemo(() => new Map(guide.sections.flatMap((section): [string, FileChange][] => {
    const counted = section.exhibits.reduce<FileChange | null>((sum, exhibit) => {
      const change = changes?.get(exhibit.path);
      return sum && change ? { additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions } : null;
    }, { additions: 0, deletions: 0 });
    return counted && section.exhibits.length ? [[section.id, counted]] : [];
  })), [guide.sections, changes]);
  const drawPart = useCallback((ref: string): ReactNode | null => {
    const part = guidePart(ref, guide.sections);
    if (!part) return null;
    if (part.kind === 'overview') return <Overview guide={guide} lines={lines} />;
    const number = guide.sections.indexOf(part.section) + 1;
    if (part.kind === 'diagram') {
      return <div data-walkthrough-diagram={part.section.id} className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <SectionHeading section={part.section} number={number} large={false} />
        <GitSpaceMarkdown>{part.diagram}</GitSpaceMarkdown>
      </div>;
    }
    if (part.kind === 'exhibit') {
      return <div data-walkthrough-exhibit={`${part.section.id}:${part.exhibit.path}`} className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        <SectionHeading section={part.section} number={number} large={false} />
        {part.exhibit.note ? <div className="text-body text-muted-foreground"><GitSpaceMarkdown>{part.exhibit.note}</GitSpaceMarkdown></div> : null}
        <ExhibitDiff exhibit={part.exhibit} onLoadDiff={onLoadDiff} review={null} glance />
      </div>;
    }
    if (!part.section.diagram) return <SectionCard section={part.section} number={number} counted={lines.get(part.section.id)} />;
    return <section data-walkthrough-section={part.section.id} className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <SectionHeading section={part.section} number={number} large />
      {part.section.summary ? <div className="text-[19px] leading-relaxed text-foreground"><GitSpaceMarkdown>{part.section.summary}</GitSpaceMarkdown></div> : null}
      <GitSpaceMarkdown>{part.section.diagram}</GitSpaceMarkdown>
    </section>;
  }, [guide, lines, onLoadDiff]);
  const start = useMemo(() => ({ onClose: () => setPlaying(false) }), []);
  return <>
    <Button variant="secondary" size="compact" type="button" aria-label="Play the walkthrough" data-walkthrough={guide.walkthrough ? 'written' : 'built'} onClick={() => setPlaying(true)}>
      <PlayCircle width={14} height={14} />Play
    </Button>
    {playing ? <div hidden data-walkthrough-player="">
      <RecordBlockDocument markdown={markdown}><DocumentRefs.Provider value={drawPart}><SequenceStart.Provider value={start}><GuideScrollRoot.Provider value={PLAYER_SCROLL_ROOT}>
        <UiBlock spec={spec} />
      </GuideScrollRoot.Provider></SequenceStart.Provider></DocumentRefs.Provider></RecordBlockDocument>
    </div> : null}
  </>;
}
