import { Badge, Button, Card, CardDescription, CardGroup, CardHeader, CardImage, CardMedia, CardTitle, InputField, InputGroup, ScrollArea, Tooltip, type BadgeProps } from '@gitspace/ui';
import type { ChangeGuideView, EvidenceReference, JournalEntryView } from '@gitspace/protocol';
import { Check, File02, Image01, SearchMd } from '@untitledui/icons';
import { useContext, useEffect, useMemo, useState } from 'react';
import { glyph } from '../glyph.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { type InspectorArtifactContent, type ArtifactReference, type LoadStatus, RuntimeAvailability, openWorkspaceFirst, ic, shortHash, formatDate, artifactId, Kicker, Placeholder } from './inspector-shared.js';

const FileGlyph = glyph(File02);
const ImageGlyph = glyph(Image01);
const SearchGlyph = glyph(SearchMd);
function JournalEvidence({ reference, content, status, error, onLoad, onOpen }: {
  reference: EvidenceReference;
  content: InspectorArtifactContent | null;
  status: LoadStatus;
  error: string | undefined;
  onLoad(reference: ArtifactReference): Promise<void>;
  onOpen(reference: EvidenceReference): void;
}) {
  const runtimeAvailable = useContext(RuntimeAvailability);
  useEffect(() => { if (reference.kind === 'artifact' && status === undefined) void onLoad(reference); }, [reference, status]);
  if (!runtimeAvailable && reference.kind === 'git') return <Tooltip content={openWorkspaceFirst}><div><Card size="compact"><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription>{reference.path} · {shortHash(reference.commitId)} · saved reference</CardDescription></CardHeader></Card></div></Tooltip>;
  if (reference.kind !== 'artifact') return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="truncate tabular-nums">{reference.kind === 'git' ? `${reference.path} · ${shortHash(reference.commitId)}` : reference.kind === 'command' ? `${reference.command} · exit ${reference.exitCode}` : `Review thread ${reference.threadId}`}</CardDescription></CardHeader></Card>;
  if (reference.mediaType?.startsWith('image/')) return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}>{content ? <CardImage src={content.previewUrl} alt={reference.label} /> : <CardMedia icon={ImageGlyph} />}<CardHeader><CardTitle className="truncate">{reference.label}</CardTitle>{!content ? <CardDescription>{status === 'error' ? error ?? 'Image failed to load' : `Loading ${reference.label}…`}</CardDescription> : null}</CardHeader></Card>;
  if ((reference.mediaType === 'text/markdown' || reference.url.endsWith('.md')) && content?.source) return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="line-clamp-3">{content.source.split('\n').filter(Boolean).slice(0, 4).join(' ')}</CardDescription></CardHeader></Card>;
  return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="truncate tabular-nums">{status === 'error' ? error ?? 'Artifact failed to load' : `${reference.mediaType ?? 'artifact'} · generation ${reference.generation}`}</CardDescription></CardHeader></Card>;
}

/** The newest entries shown first; "Load earlier" adds this many more. */
const PAGE = 50;
type JournalFilter = 'all' | 'decision' | 'phase' | 'narrative' | 'artifact';
const journalFilters: ReadonlyArray<{ id: JournalFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'decision', label: 'Decisions' },
  { id: 'phase', label: 'Phases' },
  { id: 'narrative', label: 'Narrative' },
  { id: 'artifact', label: 'Artifacts' },
];
const kindLabel: Record<JournalEntryView['kind'], string> = { 'phase-start': 'phase start', 'phase-end': 'phase end', narrative: 'narrative', decision: 'decision', artifact: 'artifact' };
const kindColor: Record<JournalEntryView['kind'], NonNullable<BadgeProps['color']>> = { 'phase-start': 'blue', 'phase-end': 'blue', narrative: 'gray', decision: 'violet', artifact: 'green' };
function journalMatches(entry: JournalEntryView, filter: JournalFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'phase') return entry.kind === 'phase-start' || entry.kind === 'phase-end';
  return entry.kind === filter;
}

/** The workspace's journal as one log, newest first: text search and kind filters narrow it. A decision shows the
 * conversation messages it quotes, the Change Guide section it belongs to, and the decision it replaces or that
 * replaced it. */
export function JournalSurface({ entries, guide, artifactContent, artifactLoad, artifactErrors, onLoadArtifact, onOpenEvidence, onOpenSection }: {
  entries: readonly JournalEntryView[];
  guide: ChangeGuideView | null;
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  artifactLoad: Readonly<Record<string, 'loading' | 'loaded' | 'error'>>;
  artifactErrors: Readonly<Record<string, string>>;
  onLoadArtifact(reference: ArtifactReference): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void;
  onOpenSection(sectionId: string): void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<JournalFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<string | null>(null);
  const newest = useMemo(() => [...entries].sort((left, right) => right.sequence - left.sequence), [entries]);
  const sections = useMemo(() => new Map((guide?.sections ?? []).map((section) => [section.id, section.title])), [guide]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const replacedBy = useMemo(() => {
    const replaced = new Map<string, JournalEntryView>();
    for (const entry of entries) if (entry.supersedes) replaced.set(entry.supersedes, entry);
    return replaced;
  }, [entries]);
  /** What a search reads of each entry: its words, the people and quotes it cites, and its guide section's title. */
  const searchText = useMemo(() => new Map(entries.map((entry) => [entry.id, [
    entry.title, entry.body, entry.outcome ?? '', entry.phase, ...entry.decisions,
    ...(entry.citations ?? []).flatMap((citation) => [citation.who, citation.quote]),
    entry.sectionId ? sections.get(entry.sectionId) ?? entry.sectionId : '',
  ].join('\n').toLowerCase()])), [entries, sections]);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const matching = newest.filter((entry) => journalMatches(entry, filter) && words.every((word) => searchText.get(entry.id)?.includes(word)));
  const shown = matching.slice(0, limit);
  useEffect(() => {
    if (!revealed) return;
    const frame = requestAnimationFrame(() => document.getElementById(`journal-entry-${revealed}`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [revealed]);
  /** Shows another entry: clears the search and filter and loads far enough back to include it. */
  const reveal = (id: string): void => {
    const index = newest.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    setQuery(''); setFilter('all'); setLimit((current) => Math.max(current, index + 1)); setRevealed(id);
  };
  const toggle = (id: string): void => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-col gap-2 px-4 pb-2 pt-4">
      <Kicker>Journal · the full log of this workspace</Kicker>
      <InputGroup className="w-full"><InputField index={0} label="Search the journal" labelHidden placeholder="Search the journal" icon={SearchGlyph} value={query} onChange={(value) => { setQuery(value); setLimit(PAGE); }} /></InputGroup>
      <div role="group" aria-label="Kind" className="flex flex-wrap gap-1">
        {journalFilters.map((option) => <Button key={option.id} variant="ghost" size="compact" active={filter === option.id} aria-pressed={filter === option.id} onClick={() => { setFilter(option.id); setLimit(PAGE); }}>
          {option.label}<span className="min-w-4 rounded-full bg-muted px-1 text-center text-[10.5px] leading-4 tabular-nums">{newest.filter((entry) => journalMatches(entry, option.id)).length}</span>
        </Button>)}
      </div>
      <p className="text-caption tabular-nums text-muted-foreground">{matching.length === entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : `${matching.length} of ${entries.length} entries`}{shown.length < matching.length ? ` · showing the newest ${shown.length}` : ''}</p>
    </header>
    <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-3 px-4 pb-6">
      {shown.length ? <ol aria-label="Journal entries" className="flex flex-col gap-3">{shown.map((entry) => {
        const sectionId = entry.sectionId;
        const sectionTitle = sectionId ? sections.get(sectionId) : undefined;
        const replaced = entry.kind === 'decision' ? replacedBy.get(entry.id) : undefined;
        const superseded = entry.supersedes ? byId.get(entry.supersedes) : undefined;
        const details = entry.evidence.length > 0 || entry.delta !== null;
        return <li key={entry.id} id={`journal-entry-${entry.id}`} data-journal-entry={entry.id} className={`flex min-w-0 flex-col gap-1 border-l-2 pl-2.5 ${revealed === entry.id ? 'border-[#6B97FF]' : 'border-border'}`}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
            <Badge size="compact" variant="dot" color={kindColor[entry.kind]}>{kindLabel[entry.kind]}</Badge>
            <span>{entry.phase}</span>
            {sectionId ? sectionTitle !== undefined
              ? <button type="button" className="hover:text-foreground hover:underline" onClick={() => onOpenSection(sectionId)}>§ {sectionTitle}</button>
              : <span>§ {sectionId}</span> : null}
            {replaced ? <Badge size="compact" color="gray">Superseded</Badge> : null}
            <time dateTime={entry.createdAt} className="ml-auto tabular-nums">{formatDate(entry.createdAt)}</time>
          </span>
          <span className={`text-body ${replaced ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{entry.title}</span>
          {entry.body ? <div className="min-w-0 text-body text-muted-foreground"><GitSpaceMarkdown>{entry.body}</GitSpaceMarkdown></div> : null}
          {entry.outcome ? <p className="text-body text-muted-foreground"><span className="font-medium text-foreground">Outcome · </span>{entry.outcome}</p> : null}
          {entry.decisions.length ? <ul className="flex flex-col gap-1">{entry.decisions.map((decision, index) => <li className="flex items-start gap-1.5 text-body text-muted-foreground" key={index}><span className="mt-0.5 shrink-0 text-foreground">{ic(Check, 14)}</span>{decision}</li>)}</ul> : null}
          {entry.citations?.length ? <ul aria-label="Citations" className="flex flex-col gap-1.5">{entry.citations.map((citation, index) => <li key={`${citation.messageId}:${index}`} className="flex flex-col gap-0.5 rounded-md bg-surface-1 px-2.5 py-1.5">
            <blockquote className="text-body text-foreground">“{citation.quote}”</blockquote>
            <span className="text-caption text-muted-foreground">{citation.who} · <time dateTime={citation.at} className="tabular-nums">{formatDate(citation.at)}</time></span>
          </li>)}</ul> : null}
          {entry.supersedes ? <p className="text-caption text-muted-foreground">Replaces {superseded
            ? <button type="button" className="text-foreground hover:underline" onClick={() => reveal(superseded.id)}>{superseded.title}</button>
            : <span className="font-mono">{entry.supersedes}</span>}</p> : null}
          {replaced ? <p className="text-caption text-muted-foreground">Replaced by <button type="button" className="text-foreground hover:underline" onClick={() => reveal(replaced.id)}>{replaced.title}</button></p> : null}
          {details ? <Button variant="ghost" size="compact" className="self-start" aria-expanded={expanded.has(entry.id)} onClick={() => toggle(entry.id)}>{expanded.has(entry.id) ? 'Hide details' : entry.evidence.length ? `Evidence · ${entry.evidence.length}` : 'Details'}</Button> : null}
          {details && expanded.has(entry.id) ? <div className="flex min-w-0 flex-col gap-2">
            {entry.delta ? <div className="flex flex-wrap gap-1"><Badge size="compact"><span className="tabular-nums">{entry.delta.requirementsAdvanced.length}</span>&nbsp;requirements advanced</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.evidenceAdded.length}</span>&nbsp;evidence added</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.workflowNodesChanged.length}</span>&nbsp;workflow changes</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.threadsResolved}</span>&nbsp;threads resolved</Badge></div> : null}
            {entry.evidence.length ? <CardGroup border="outlined">{entry.evidence.map((reference, index) => <JournalEvidence reference={reference} content={reference.kind === 'artifact' ? artifactContent[artifactId(reference)] ?? null : null} status={reference.kind === 'artifact' ? artifactLoad[artifactId(reference)] : undefined} error={reference.kind === 'artifact' ? artifactErrors[artifactId(reference)] : undefined} onLoad={onLoadArtifact} onOpen={onOpenEvidence} key={`${entry.id}:${index}`} />)}</CardGroup> : null}
          </div> : null}
        </li>;
      })}</ol> : <Placeholder>{entries.length ? 'Nothing in the journal matches.' : 'The journal is empty.'}</Placeholder>}
      {shown.length < matching.length ? <Button variant="secondary" size="compact" className="self-center" onClick={() => setLimit(limit + PAGE)}>Load earlier · {Math.min(PAGE, matching.length - shown.length)} of {matching.length - shown.length} more</Button> : null}
    </div></ScrollArea>
  </div>;
}
