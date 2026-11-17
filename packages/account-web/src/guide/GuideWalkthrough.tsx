// A Change Guide's walkthrough (docs/BLOCK-DOCUMENTS-DESIGN.md §6), played from the guide's header: the Sequence the
// agent wrote with the revision, or for a guide written without one, the one built from its sections
// (`builtWalkthrough`: the overview, then each section's diagram, else its first exhibit, else the section). It plays
// full-screen in the Sequence player, with speech where the workspace has a voice. A frame shows the guide at a glance
// (its title and its sections as cards coloured by kind), a section (its title, summary and diagram), a section's
// diagram, an exhibit's lines, or a block of the guide's Markdown by its id; a diagram or an exhibit is headed by its
// section.
import type { ChangeGuideSection, ChangeMap, RepositoryDiffView } from '@gitspace/protocol';
import { builtWalkthrough, firstSentence, guideMarkdown, guidePart, type GuideWalkthrough } from '@gitspace/protocol/guide-walkthrough';
import { Button } from '@gitspace/ui';
import { PlayCircle } from '@untitledui/icons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { DocumentRefs, RecordBlockDocument, SequenceStart } from '../blocks/BlockDocument.js';
import { UiBlock } from '../blocks/UiBlock.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { ExhibitDiff } from './ExhibitDiff.js';
import { SECTION_KIND } from './GuideSection.js';

/** The parts of a guide its walkthrough plays. */
export interface WalkthroughGuide {
  title: string;
  intro?: string | undefined;
  sections: readonly ChangeGuideSection[];
  map?: ChangeMap | undefined;
  walkthrough?: GuideWalkthrough | undefined;
}

/** A section's number, kind and title, above a frame showing it or a part of it. */
function SectionHeading({ section, number, large }: { section: ChangeGuideSection; number: number; large: boolean }) {
  return <header className="flex flex-col gap-1">
    <span className="flex items-center gap-1.5 text-caption text-muted-foreground"><span className="size-2 rounded-full" style={{ background: SECTION_KIND[section.kind].color }} />§{number} · {SECTION_KIND[section.kind].label}</span>
    <h2 className={`${large ? 'text-[26px] leading-tight' : 'text-title'} font-semibold text-foreground`}>{section.title}</h2>
  </header>;
}

/** The Play button, and the walkthrough playing while it is open. */
export function GuideWalkthroughButton({ guide, onLoadDiff }: { guide: WalkthroughGuide; onLoadDiff(path: string): Promise<RepositoryDiffView> }) {
  const [playing, setPlaying] = useState(false);
  const spec = useMemo(() => guide.walkthrough ?? builtWalkthrough(guide), [guide]);
  const markdown = useMemo(() => guideMarkdown(guide), [guide]);
  const drawPart = useCallback((ref: string): ReactNode | null => {
    const part = guidePart(ref, guide.sections);
    if (!part) return null;
    if (part.kind === 'overview') {
      return <section data-walkthrough-overview="" className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="flex flex-col gap-1">
          <span className="text-caption text-muted-foreground">Change Guide · {guide.sections.length} section{guide.sections.length === 1 ? '' : 's'}</span>
          <h2 className="text-[28px] font-semibold leading-tight text-foreground">{guide.title}</h2>
        </header>
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {guide.sections.map((section, index) => <li key={section.id} data-walkthrough-card={section.id}
            className="flex flex-col gap-1.5 rounded-lg bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]" style={{ borderLeft: `3px solid ${SECTION_KIND[section.kind].color}` }}>
            <span className="text-caption text-muted-foreground">§{index + 1} · {SECTION_KIND[section.kind].label}</span>
            <span className="text-body font-semibold leading-snug text-foreground">{section.title}</span>
            {section.summary ? <span className="line-clamp-3 text-caption leading-relaxed text-muted-foreground">{firstSentence(section.summary) ?? section.summary}</span> : null}
          </li>)}
        </ol>
      </section>;
    }
    const number = guide.sections.indexOf(part.section) + 1;
    if (part.kind === 'diagram') {
      return <div data-walkthrough-diagram={part.section.id} className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <SectionHeading section={part.section} number={number} large={false} />
        <GitSpaceMarkdown>{part.diagram}</GitSpaceMarkdown>
      </div>;
    }
    if (part.kind === 'exhibit') {
      return <div data-walkthrough-exhibit={`${part.section.id}:${part.exhibit.path}`} className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <SectionHeading section={part.section} number={number} large={false} />
        <ExhibitDiff exhibit={part.exhibit} onLoadDiff={onLoadDiff} review={null} />
      </div>;
    }
    return <section data-walkthrough-section={part.section.id} className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <SectionHeading section={part.section} number={number} large />
      {part.section.summary ? <div className="text-[19px] leading-relaxed text-foreground"><GitSpaceMarkdown>{part.section.summary}</GitSpaceMarkdown></div> : null}
      {part.section.diagram ? <GitSpaceMarkdown>{part.section.diagram}</GitSpaceMarkdown> : null}
    </section>;
  }, [guide.sections, guide.title, onLoadDiff]);
  const start = useMemo(() => ({ onClose: () => setPlaying(false) }), []);
  return <>
    <Button variant="secondary" size="compact" type="button" aria-label="Play the walkthrough" data-walkthrough={guide.walkthrough ? 'written' : 'built'} onClick={() => setPlaying(true)}>
      <PlayCircle width={14} height={14} />Play
    </Button>
    {playing ? <div hidden data-walkthrough-player="">
      <RecordBlockDocument markdown={markdown}><DocumentRefs.Provider value={drawPart}><SequenceStart.Provider value={start}>
        <UiBlock spec={spec} />
      </SequenceStart.Provider></DocumentRefs.Provider></RecordBlockDocument>
    </div> : null}
  </>;
}
