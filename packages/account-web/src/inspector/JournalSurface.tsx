import { Badge, Card, CardDescription, CardGroup, CardHeader, CardImage, CardMedia, CardTitle, ScrollArea, TabsSubtle, TabsSubtleItem, Tooltip, ThinkingStep, ThinkingStepDetails, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, type IconName } from '@gitspace/ui';
import type { EvidenceReference, JournalEntryView } from '@gitspace/protocol';
import { Check, File02, Image01 } from '@untitledui/icons';
import { useContext, useEffect, useMemo, useState } from 'react';
import { glyph } from '../glyph.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { type InspectorArtifactContent, type ArtifactReference, type LoadStatus, RuntimeAvailability, openWorkspaceFirst, ic, shortHash, formatDate, artifactId, Heading, Placeholder } from './inspector-shared.js';

const FileGlyph = glyph(File02);
const ImageGlyph = glyph(Image01);
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

type JournalFilter = 'all' | 'narrative' | 'decision' | 'artifact' | 'phase';
const journalFilters: ReadonlyArray<{ id: JournalFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'narrative', label: 'Narrative' },
  { id: 'decision', label: 'Decisions' },
  { id: 'artifact', label: 'Artifacts' },
  { id: 'phase', label: 'Phases' },
];
function journalMatches(entry: JournalEntryView, filter: JournalFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'phase') return entry.kind === 'phase-start' || entry.kind === 'phase-end';
  return entry.kind === filter;
}
function journalIcon(kind: JournalEntryView['kind']): IconName {
  if (kind === 'phase-start') return 'play';
  if (kind === 'phase-end') return 'check';
  if (kind === 'decision') return 'lightbulb';
  if (kind === 'artifact') return 'folder';
  return 'message-circle';
}
export function JournalSurface({ entries, artifactContent, artifactLoad, artifactErrors, onLoadArtifact, onOpenEvidence }: {
  entries: readonly JournalEntryView[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  artifactLoad: Readonly<Record<string, 'loading' | 'loaded' | 'error'>>;
  artifactErrors: Readonly<Record<string, string>>;
  onLoadArtifact(reference: ArtifactReference): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void;
}) {
  const [filter, setFilter] = useState(0);
  const visible = useMemo(() => { const active = journalFilters[filter]?.id ?? 'all'; return [...entries].reverse().filter((entry) => journalMatches(entry, active)); }, [entries, filter]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-col gap-2 px-4 pb-2 pt-4">
      <div className="flex items-start justify-between gap-3"><span className="flex min-w-0 flex-col gap-1"><Heading>Timeline</Heading><p className="text-caption text-muted-foreground">Goal decisions, phase transitions, and evidence in one chronological log.</p></span><span className="shrink-0 text-caption text-muted-foreground tabular-nums">{visible.length} of {entries.length}</span></div>
      <TabsSubtle size="compact" selectedIndex={filter} onSelect={setFilter} aria-label="Journal filter">{journalFilters.map((item, index) => <TabsSubtleItem index={index} label={item.label} key={item.id} />)}</TabsSubtle>
    </header>
    <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="px-3 pb-6">
      {visible.length ? <ThinkingSteps defaultOpen>
        <ThinkingStepsHeader>{`Timeline · ${visible.length}`}</ThinkingStepsHeader>
        <ThinkingStepsContent>{visible.map((entry, index) => {
          const phase = entry.kind === 'phase-start' || entry.kind === 'phase-end';
          const meta = [formatDate(entry.createdAt), entry.kind, entry.phase].filter(Boolean).join(' · ');
          return <ThinkingStep icon={journalIcon(entry.kind)} label={entry.title} description={meta} status="complete" isLast={index === visible.length - 1} key={entry.id}>
            {phase ? null : <ThinkingStepDetails summary="Details">
              <div className="flex min-w-0 flex-col gap-2 pt-1">
                <GitSpaceMarkdown>{entry.body}</GitSpaceMarkdown>
                {entry.outcome ? <p className="text-body text-muted-foreground"><span className="font-medium text-foreground">Outcome · </span>{entry.outcome}</p> : null}
                {entry.decisions.length ? <ul className="flex flex-col gap-1">{entry.decisions.map((decision, decisionIndex) => <li className="flex items-start gap-1.5 text-body text-muted-foreground" key={decisionIndex}><span className="mt-0.5 shrink-0 text-foreground">{ic(Check, 14)}</span>{decision}</li>)}</ul> : null}
                {entry.delta ? <div className="flex flex-wrap gap-1"><Badge size="compact"><span className="tabular-nums">{entry.delta.requirementsAdvanced.length}</span>&nbsp;requirements advanced</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.evidenceAdded.length}</span>&nbsp;evidence added</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.workflowNodesChanged.length}</span>&nbsp;workflow changes</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.threadsResolved}</span>&nbsp;threads resolved</Badge></div> : null}
                {entry.evidence.length ? <CardGroup border="outlined">{entry.evidence.map((reference, evidenceIndex) => <JournalEvidence reference={reference} content={reference.kind === 'artifact' ? artifactContent[artifactId(reference)] ?? null : null} status={reference.kind === 'artifact' ? artifactLoad[artifactId(reference)] : undefined} error={reference.kind === 'artifact' ? artifactErrors[artifactId(reference)] : undefined} onLoad={onLoadArtifact} onOpen={onOpenEvidence} key={`${entry.id}:${evidenceIndex}`} />)}</CardGroup> : null}
              </div>
            </ThinkingStepDetails>}
          </ThinkingStep>;
        })}</ThinkingStepsContent>
      </ThinkingSteps> : <Placeholder>No matching timeline entries.</Placeholder>}
    </div></ScrollArea>
  </div>;
}
