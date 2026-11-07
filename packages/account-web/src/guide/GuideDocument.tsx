// A Change Guide as one calm document, the same in the Inspector and on a shared link: the title and who made what;
// the introduction and its captures; the change map with its steps; then the walkthrough, one section at a time. In
// the workspace it is also where a person reads, accepts requirements, comments on lines and routes follow-ups; a
// shared guide shows the same parts read-only.
import type { ChangeGuideSection, ChangeMap, EvidenceReference, RepositoryDiffView } from '@gitspace/protocol';
import { badgeColors, useShape } from '@gitspace/ui';
import { Image01 } from '@untitledui/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { artifactId, type ArtifactReference, type InspectorArtifactContent } from '../inspector/inspector-shared.js';
import { Source, SourceLegend } from './Authorship.js';
import { ChangeMapView } from './ChangeMap.js';
import { EvidenceLinks, GuideSection, MEASURE, type GuideWorkspace } from './GuideSection.js';

/** The parts of a guide both the workspace and a shared link read. */
export interface GuideContent {
  title: string;
  baseRef: string;
  baseCommit: string | null;
  headCommit: string;
  sections: readonly ChangeGuideSection[];
  intro?: string | undefined;
  captures?: readonly EvidenceReference[] | undefined;
  map?: ChangeMap | undefined;
}

/** How the Inspector shows a capture it can load: its preview once loaded. */
export interface GuideCaptures {
  content(reference: ArtifactReference): InspectorArtifactContent | null;
  load(reference: ArtifactReference): void;
}

function PartHeading({ id, title, source, detail }: { id: string; title: string; source: ReactNode; detail?: string }) {
  return <header id={id} className={`flex scroll-mt-2 flex-col gap-1 pb-3 pt-10 ${MEASURE}`}>
    <h2 className="flex items-center gap-1.5 text-title font-semibold text-foreground">{title}{source}</h2>
    {detail ? <p className="text-body text-muted-foreground">{detail}</p> : null}
  </header>;
}

function Capture({ reference, captures }: { reference: ArtifactReference; captures: GuideCaptures | null }) {
  const shape = useShape();
  const content = captures?.content(reference) ?? null;
  useEffect(() => { captures?.load(reference); }, [artifactId(reference)]);
  const image = content && content.mediaType?.startsWith('image/') ? content.previewUrl : null;
  return <figure className="flex min-w-0 flex-col gap-1.5">
    {image ? <img src={image} alt={reference.label} className={`w-full border border-border bg-surface-1 object-contain ${shape.container}`} />
      : <div className={`flex aspect-video w-full flex-col items-center justify-center gap-2 border border-dashed border-border bg-surface-1 p-4 text-center text-caption text-muted-foreground ${shape.container}`}>
        <Image01 width={20} height={20} />{captures ? 'Loading the capture…' : 'Captures open in the workspace.'}
      </div>}
    <figcaption className="text-caption text-foreground">{reference.label}</figcaption>
  </figure>;
}

export function GuideDocument({ guide, kicker, actions, onLoadDiff, workspace, captures, focusSection, initialOpen, onOpenChange }: {
  guide: GuideContent;
  /** The line above the title: where the guide is from. */
  kicker: ReactNode;
  /** Controls beside the header (sharing). */
  actions?: ReactNode;
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  /** The workspace's actions; null on a shared guide, which is read-only. */
  workspace: GuideWorkspace | null;
  captures: GuideCaptures | null;
  /** Opens a section and scrolls to it, once per serial. */
  focusSection?: { id: string; serial: number } | null;
  /** The sections open at first; the first section when absent. */
  initialOpen?: readonly string[];
  onOpenChange?(open: ReadonlySet<string>): void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initialOpen ?? guide.sections.slice(0, 1).map((section) => section.id)));
  useEffect(() => { onOpenChange?.(open); }, [open]);
  const [mapSection, setMapSection] = useState<string | null>(null);
  const openSection = (id: string): void => {
    setOpen((current) => current.has(id) ? current : new Set(current).add(id));
    requestAnimationFrame(() => document.getElementById(`guide-section-${id}`)?.scrollIntoView({ block: 'start' }));
  };
  useEffect(() => { if (focusSection && guide.sections.some((section) => section.id === focusSection.id)) openSection(focusSection.id); }, [focusSection?.serial]);
  const files = new Set(guide.sections.flatMap((section) => section.exhibits.map((exhibit) => exhibit.path))).size;
  const requirementIds = new Set(guide.sections.flatMap((section) => section.requirementIds));
  const accepted = workspace?.goal?.requirements.filter((requirement) => requirementIds.has(requirement.id) && requirement.status === 'accepted').length ?? 0;
  const artifacts = guide.captures?.filter((reference): reference is ArtifactReference => reference.kind === 'artifact') ?? [];
  const otherCaptures = guide.captures?.filter((reference) => reference.kind !== 'artifact') ?? [];
  return <article className="flex w-full min-w-0 flex-col px-5 pb-16 pt-4">
    <header className={`flex flex-col gap-3 ${MEASURE}`}>
      <span className="text-caption text-muted-foreground">{kicker}</span>
      <h1 className="flex flex-wrap items-center gap-x-1.5 text-[22px] font-semibold leading-snug text-foreground">{guide.title}<Source by="agent" what="the title, the introduction and the sections" /></h1>
      <p className="flex flex-wrap items-center gap-x-1.5 text-caption tabular-nums text-muted-foreground">
        <span className="font-mono">{guide.baseRef} · {guide.baseCommit ? guide.baseCommit.slice(0, 7) : '—'}…{guide.headCommit.slice(0, 7)}</span>
        <span>· {guide.sections.length} section{guide.sections.length === 1 ? '' : 's'} · {files} file{files === 1 ? '' : 's'}</span>
        <Source by="gitspace" what="the base and head commits the guide's diffs compare" />
      </p>
      {actions ? <div className="flex flex-wrap items-center gap-1">{actions}</div> : null}
      {workspace ? <div className="flex flex-col gap-1.5">
        <div className="flex gap-1" aria-hidden>{guide.sections.map((section) => <span key={section.id} className="h-1 flex-1 rounded-full" style={{ background: workspace.readIds.has(section.id) ? badgeColors.green : 'var(--border)' }} />)}</div>
        <span className="flex flex-wrap items-center gap-1 text-caption tabular-nums text-muted-foreground">
          {guide.sections.filter((section) => workspace.readIds.has(section.id)).length} of {guide.sections.length} sections read
          {requirementIds.size ? ` · ${accepted} of ${requirementIds.size} requirements accepted` : ''}
          <Source by="gitspace" what="your read progress, and the requirements accepted in the Goal" />
        </span>
      </div> : null}
      <SourceLegend />
    </header>

    {guide.intro || guide.captures?.length ? <>
      <PartHeading id="guide-intro" title="What changed" source={<Source by="agent" what="the introduction and which captures show the change" />} />
      {guide.intro ? <div className={`text-body leading-relaxed ${MEASURE}`}><GitSpaceMarkdown>{guide.intro}</GitSpaceMarkdown></div> : null}
      {artifacts.length ? <div className={`mt-4 grid gap-4 ${artifacts.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} ${MEASURE}`}>{artifacts.map((reference) => <Capture key={artifactId(reference)} reference={reference} captures={captures} />)}</div> : null}
      {otherCaptures.length ? <div className={`mt-3 ${MEASURE}`}><EvidenceLinks evidence={otherCaptures} onOpen={workspace ? workspace.onOpenEvidence : null} /></div> : null}
    </> : null}

    {guide.map?.areas.length ? <>
      <PartHeading id="guide-map" title="The change map" source={<Source by="agent" what="the map's areas, paths and steps" />}
        detail="The areas the change touches, grouped by package; paths are green when new, red when removed, grey when they stay." />
      <ChangeMapView map={guide.map} sections={guide.sections} onOpenSection={openSection} onStep={setMapSection} />
    </> : null}

    <PartHeading id="guide-walkthrough" title="Walkthrough" source={<Source by="agent" what="the order the sections are read in" />}
      detail={workspace ? 'Read the change one section at a time. Select line numbers in a diff to comment.' : 'Read the change one section at a time.'} />
    <div className="flex flex-col">
      {guide.sections.map((section, index) => <GuideSection key={section.id} section={section} index={index} map={guide.map} open={open.has(section.id)} onMapNow={mapSection === section.id}
        onToggle={() => setOpen((current) => { const next = new Set(current); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; })}
        onReadNext={workspace ? () => { workspace.onMarkRead(section.id); const next = guide.sections[index + 1]; if (next) openSection(next.id); } : null}
        onLoadDiff={onLoadDiff} workspace={workspace} />)}
    </div>
  </article>;
}
