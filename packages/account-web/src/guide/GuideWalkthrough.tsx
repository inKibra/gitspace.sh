// A Change Guide's walkthrough (docs/BLOCK-DOCUMENTS-DESIGN.md §6), played from the guide's header: the Sequence the
// agent wrote with the revision, or for a guide written without one, the one built from its sections' summaries and
// diagrams (`builtWalkthrough`). It plays full-screen in the Sequence player, with speech where the workspace has a
// voice. A frame shows a section (its title, summary and diagram), a section's diagram, an exhibit's lines, or a block
// of the guide's Markdown by its id.
import type { ChangeGuideSection, ChangeMap, RepositoryDiffView } from '@gitspace/protocol';
import { builtWalkthrough, guideMarkdown, guidePart, type GuideWalkthrough } from '@gitspace/protocol/guide-walkthrough';
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

/** The Play button, and the walkthrough playing while it is open. */
export function GuideWalkthroughButton({ guide, onLoadDiff }: { guide: WalkthroughGuide; onLoadDiff(path: string): Promise<RepositoryDiffView> }) {
  const [playing, setPlaying] = useState(false);
  const spec = useMemo(() => guide.walkthrough ?? builtWalkthrough(guide), [guide]);
  const markdown = useMemo(() => guideMarkdown(guide), [guide]);
  const drawPart = useCallback((ref: string): ReactNode | null => {
    const part = guidePart(ref, guide.sections);
    if (!part) return null;
    if (part.kind === 'diagram') return <div className="mx-auto w-full max-w-4xl"><GitSpaceMarkdown>{part.diagram}</GitSpaceMarkdown></div>;
    if (part.kind === 'exhibit') return <div className="mx-auto w-full max-w-5xl"><ExhibitDiff exhibit={part.exhibit} onLoadDiff={onLoadDiff} review={null} /></div>;
    const number = guide.sections.indexOf(part.section) + 1;
    return <section data-walkthrough-section={part.section.id} className="mx-auto flex w-full max-w-4xl flex-col gap-3">
      <span className="flex items-center gap-1.5 text-caption text-muted-foreground"><span className="size-1.5 rounded-full" style={{ background: SECTION_KIND[part.section.kind].color }} />§{number} · {SECTION_KIND[part.section.kind].label}</span>
      <h2 className="text-title font-semibold text-foreground">{part.section.title}</h2>
      {part.section.summary ? <div className="text-body font-medium leading-relaxed"><GitSpaceMarkdown>{part.section.summary}</GitSpaceMarkdown></div> : null}
      {part.section.diagram ? <GitSpaceMarkdown>{part.section.diagram}</GitSpaceMarkdown> : null}
    </section>;
  }, [guide.sections, onLoadDiff]);
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
