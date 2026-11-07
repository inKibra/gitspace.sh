// One walkthrough section of a Change Guide: its summary, explanation, why and callouts at a reading measure; its
// diagram (the agent's block, else the change map around the areas its files are in); its exhibits at the full width
// under a reader's guide that stays pinned while the section's code scrolls; its evidence; and, in the workspace, the
// requirements it shows (accepted here as in the Goal) and its follow-ups. Marks say who made each part.
import type { ChangeGuideSection, ChangeMap, EvidenceReference, GoalRecordView, RepositoryDiffView } from '@gitspace/protocol';
import { Badge, Button, CheckboxGroup, CheckboxItem, Select, SelectContent, SelectItem, SelectTrigger, badgeColors, useShape } from '@gitspace/ui';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, File02, GitCommit, Link03, MessageChatSquare, MessageSquare01, Terminal } from '@untitledui/icons';
import { useMemo, useState, type ReactNode } from 'react';
import type { ComposerStaging } from '../chat/staging.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { ic } from '../inspector/inspector-shared.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { Source } from './Authorship.js';
import { SectionMap } from './ChangeMap.js';
import { ExhibitDiff, type GuideReview } from './ExhibitDiff.js';
import { areasTouching } from './map-layout.js';
import { SectionChangeBadge, type GuideComparison } from './GuideRevisions.js';

const KIND: Record<ChangeGuideSection['kind'], { label: string; color: string }> = {
  decision: { label: 'Decision', color: badgeColors.violet },
  behavior: { label: 'Behavior', color: badgeColors.blue },
  risk: { label: 'Risk', color: badgeColors.amber },
  mechanical: { label: 'Mechanical', color: badgeColors.gray },
};
const CALLOUT: Record<NonNullable<ChangeGuideSection['callouts']>[number]['tone'], string> = { risk: 'Risk.', mechanical: 'Mechanical.', decision: 'Decision.' };
const EVIDENCE_ICON: Record<EvidenceReference['kind'], typeof File02> = { artifact: File02, git: GitCommit, command: Terminal, 'review-thread': MessageSquare01 };
/** Prose keeps a reading measure; code and pictures take the whole width. */
export const MEASURE = 'mx-auto w-full max-w-[46rem]';

/** What a person can do with a workspace's guide; a shared guide's reader has none of it. */
export interface GuideWorkspace {
  review: GuideReview;
  readIds: ReadonlySet<string>;
  onMarkRead(sectionId: string): void;
  /** An older revision: shown as it was, with its requirements and follow-ups disabled and nothing to mark read. */
  readOnly: boolean;
  goal: GoalRecordView | null;
  /** Accepts or reopens a requirement at once; absent where the viewer cannot. */
  onSetAcceptance?(requirementId: string, accepted: boolean): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void;
  /** The workspace's composer, where follow-ups for the agent wait; null without one. */
  staging: ComposerStaging | null;
  /** Other open workspaces of the project a follow-up may be related to, and how to relate one. */
  relate: { workspaces: readonly { id: string; name: string }[]; onRelate(workspaceId: string): Promise<void> } | null;
}

function PartHeading({ children, source }: { children: ReactNode; source?: ReactNode }) {
  return <h4 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">{children}{source}</h4>;
}

/** The evidence a section or the guide cites: opened in the Inspector, or listed on a shared guide. */
export function EvidenceLinks({ evidence, onOpen }: { evidence: readonly EvidenceReference[]; onOpen: ((reference: EvidenceReference) => void) | null }) {
  return <ul className="flex flex-wrap gap-1">{evidence.map((reference, index) => {
    const text = reference.kind === 'command' ? `${reference.label} · exit ${reference.exitCode}` : reference.label;
    return <li key={`${reference.kind}:${index}`}>
      {onOpen ? <Button variant="tertiary" size="compact" type="button" onClick={() => onOpen(reference)}>{ic(EVIDENCE_ICON[reference.kind], 14)}{text}</Button>
        : <span className="inline-flex items-center gap-1.5 px-1 text-caption text-muted-foreground">{ic(EVIDENCE_ICON[reference.kind], 14)}{text}</span>}
    </li>;
  })}</ul>;
}

function SectionRequirements({ section, goal, onSetAcceptance, readOnly }: { section: ChangeGuideSection; goal: GoalRecordView | null; onSetAcceptance: GuideWorkspace['onSetAcceptance']; readOnly: boolean }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const requirements = section.requirementIds.flatMap((id) => goal?.requirements.find((requirement) => requirement.id === id) ?? []);
  const missing = section.requirementIds.filter((id) => !requirements.some((requirement) => requirement.id === id));
  if (!section.requirementIds.length) return null;
  const toggle = (id: string, accepted: boolean): void => {
    if (!onSetAcceptance || readOnly || pending.has(id)) return;
    setPending((current) => new Set(current).add(id));
    setError(null);
    void onSetAcceptance(id, accepted).catch((cause: unknown) => setError(rpcErrorMessage(cause, 'inspector.requirement.setAcceptance'))).finally(() => setPending((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    }));
  };
  return <div className="flex flex-col gap-2">
    <PartHeading source={<Source by="agent" what="which requirements this section shows" />}>Requirements this section shows</PartHeading>
    {requirements.length ? onSetAcceptance
      ? <CheckboxGroup className={readOnly ? 'pointer-events-none w-full opacity-60' : 'w-full'} checkedIndices={new Set(requirements.flatMap((requirement, index) => requirement.status === 'accepted' ? [index] : []))}>
        {requirements.map((requirement, index) => <CheckboxItem key={requirement.id} index={index} label={requirement.title} checked={requirement.status === 'accepted'} aria-busy={pending.has(requirement.id)} aria-disabled={readOnly || undefined} onToggle={() => toggle(requirement.id, requirement.status !== 'accepted')} />)}
      </CheckboxGroup>
      : <ul className="flex flex-col gap-1">{requirements.map((requirement) => <li key={requirement.id} className="flex items-center gap-2 text-body"><Badge size="compact" variant="dot" color={requirement.status === 'accepted' ? 'green' : requirement.status === 'review' ? 'amber' : 'gray'}>{requirement.status}</Badge>{requirement.title}</li>)}</ul>
      : null}
    {missing.length ? <p className="text-caption text-muted-foreground">Not in the Goal: {missing.join(', ')}</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {onSetAcceptance && requirements.length ? <p className="flex items-center gap-1 text-caption text-muted-foreground">{readOnly ? 'Requirements are accepted on the latest revision.' : 'Only you accept a requirement; it is the same record as in the Goal.'}<Source by="gitspace" what="whether each requirement is accepted, from the Goal" /></p> : null}
  </div>;
}

function FollowUp({ text, section, number, workspace }: { text: string; section: ChangeGuideSection; number: number; workspace: GuideWorkspace }) {
  const { staging, relate, readOnly } = workspace;
  const [relating, setRelating] = useState(false);
  const [target, setTarget] = useState('');
  const [related, setRelated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = (action: string): string => `guide-follow-up:${section.id}:${action}:${text}`;
  const staged = (action: string): boolean => staging?.chips.some((chip) => chip.key === key(action)) ?? false;
  const stage = (action: 'issue' | 'message'): void => staging?.stage({
    key: key(action), kind: 'message',
    label: action === 'issue' ? `File an issue: ${text}` : `Follow up: ${text}`,
    detail: `Change Guide §${number} ${section.title}`,
    payload: { followUp: text, sectionId: section.id, action: action === 'issue' ? 'file-issue' : 'message' },
  });
  const choice = relate?.workspaces.find((candidate) => candidate.id === target) ?? relate?.workspaces[0] ?? null;
  return <li className="flex flex-col gap-1.5">
    <span className="text-body">{text}</span>
    {relating && relate && choice ? <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption text-muted-foreground">Relate this workspace to</span>
      <div className="w-64 max-w-full"><Select value={choice.id} onValueChange={setTarget} size="compact"><SelectTrigger aria-label="Workspace" /><SelectContent>{relate.workspaces.map((candidate, index) => <SelectItem key={candidate.id} value={candidate.id} index={index}>{candidate.name}</SelectItem>)}</SelectContent></Select></div>
      <Button variant="primary" size="compact" type="button" onClick={() => {
        setError(null);
        void relate.onRelate(choice.id).then(() => { setRelated(choice.name); setRelating(false); }, (cause: unknown) => setError(rpcErrorMessage(cause, 'workspace relations')));
      }}>Relate</Button>
      <Button variant="ghost" size="compact" type="button" onClick={() => setRelating(false)}>Cancel</Button>
    </div> : <div className="flex flex-wrap items-center gap-1.5">
      {staging ? <Button variant="secondary" size="compact" type="button" disabled={readOnly || staged('issue')} onClick={() => stage('issue')}><ArrowUpRight width={13} height={13} />{staged('issue') ? 'Issue in your message' : 'File an issue'}</Button> : null}
      {relate?.workspaces.length ? <Button variant="ghost" size="compact" type="button" disabled={readOnly} onClick={() => setRelating(true)}><Link03 width={13} height={13} />{related ? `Related to ${related}` : 'Relate a workspace'}</Button> : null}
      {staging ? <Button variant="ghost" size="compact" type="button" disabled={readOnly || staged('message')} onClick={() => stage('message')}><MessageChatSquare width={13} height={13} />{staged('message') ? 'In your message' : 'Message the agent'}</Button> : null}
    </div>}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </li>;
}

/** The pinned bar over a section's code: where the reader is and what to look at. */
function ReadersGuide({ section, number }: { section: ChangeGuideSection; number: number }) {
  return <div data-readers-guide className="sticky top-0 z-10 border-b border-border bg-background/95 py-2 backdrop-blur">
    <div className={`flex flex-col gap-1 ${MEASURE}`}>
      <span className="truncate text-caption font-medium text-foreground">§{number} {section.title}</span>
      {section.readersGuide ? <div className="flex items-start gap-1.5 text-caption leading-snug text-muted-foreground">
        <span className="mt-1"><Source by="agent" what="the reader's guide for this section" /></span>
        <div className="min-w-0 flex-1"><GitSpaceMarkdown>{section.readersGuide}</GitSpaceMarkdown></div>
      </div> : null}
    </div>
  </div>;
}

function SectionDiagram({ section, map }: { section: ChangeGuideSection; map: ChangeMap | undefined }) {
  const focus = useMemo(() => map ? areasTouching(map, section.exhibits.map((exhibit) => exhibit.path)) : new Set<string>(), [map, section.exhibits]);
  if (section.diagram) return <figure className="flex flex-col gap-2">
    <GitSpaceMarkdown>{section.diagram}</GitSpaceMarkdown>
    <figcaption className="flex items-center gap-1.5 text-caption text-muted-foreground"><Source by="agent" what="this diagram" />Drawn by the agent for this section.</figcaption>
  </figure>;
  if (!map || !focus.size) return null;
  const names = map.areas.filter((area) => focus.has(area.id)).map((area) => area.name);
  return <figure className="flex flex-col gap-2">
    <SectionMap map={map} focus={focus} />
    <figcaption className="flex items-center gap-1.5 text-caption text-muted-foreground"><Source by="gitspace" what="this diagram: the change map around the areas this section's files are in" />The change map around {names.join(', ')}; areas one path away are faded.</figcaption>
  </figure>;
}

export function GuideSection({ section, index, map, open, onMapNow, onToggle, onReadNext, onLoadDiff, workspace, comparison }: {
  section: ChangeGuideSection;
  index: number;
  map: ChangeMap | undefined;
  open: boolean;
  /** The step playing on the map belongs to this section. */
  onMapNow: boolean;
  onToggle(): void;
  /** Marks the section read and opens the next one; absent on a shared guide. */
  onReadNext: (() => void) | null;
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  workspace: GuideWorkspace | null;
  /** The earlier revision a reader compares the guide with; null without one. */
  comparison: GuideComparison | null;
}) {
  const shape = useShape();
  const number = index + 1;
  const read = workspace?.readIds.has(section.id) ?? false;
  const ranges = section.exhibits.reduce((sum, exhibit) => sum + (exhibit.ranges?.length ?? 0), 0);
  const paths = new Set(section.exhibits.map((exhibit) => exhibit.path));
  const threads = workspace?.review.threads.filter((thread) => thread.anchor.kind === 'line' && paths.has(thread.anchor.path)).length ?? 0;
  const kind = KIND[section.kind];
  const change = comparison?.changes.get(section.id) ?? null;
  const since = comparison?.onLoadSinceDiff && change === 'changed' ? { revision: comparison.since, onLoad: comparison.onLoadSinceDiff } : null;
  return <section id={`guide-section-${section.id}`} data-section={section.id} data-map-now={onMapNow || undefined} className="scroll-mt-2 pt-4">
    <div className={`flex items-start gap-3 border-t border-border pt-5 ${MEASURE}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className={`flex min-w-0 flex-1 items-start gap-3 text-left ${shape.item}`} style={onMapNow ? { boxShadow: `0 0 0 2px ${badgeColors.blue}`, padding: 4 } : undefined}>
        <span className="mt-0.5 w-6 shrink-0 text-right text-title font-semibold tabular-nums" style={{ color: read ? badgeColors.green : 'var(--muted-foreground)' }}>{read ? <Check width={18} height={18} className="ml-auto mt-1" aria-label="Read" /> : number}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-title font-semibold leading-snug text-foreground">{section.title}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{ background: kind.color }} />{kind.label}</span>
            {comparison && change ? <SectionChangeBadge change={change} since={comparison.since} /> : null}
            <span className="tabular-nums">· {section.exhibits.length} file{section.exhibits.length === 1 ? '' : 's'}</span>
            {ranges ? <span className="tabular-nums">· {ranges} range{ranges === 1 ? '' : 's'}</span> : null}
            {threads ? <span className="flex items-center gap-1 tabular-nums">· <MessageSquare01 width={12} height={12} />{threads} thread{threads === 1 ? '' : 's'}</span> : null}
            {onMapNow ? <span style={{ color: badgeColors.blue }}>· on the map now</span> : null}
          </span>
        </span>
        {open ? <ChevronDown width={16} height={16} className="mt-2 shrink-0 text-muted-foreground" /> : <ChevronRight width={16} height={16} className="mt-2 shrink-0 text-muted-foreground" />}
      </button>
      <span className="mt-2"><Source by="agent" what="the section: its title, kind, summary, explanation, why and callouts" /></span>
    </div>
    {open ? <div className="flex flex-col gap-6 pb-4 pt-5">
      <div className={`flex flex-col gap-4 ${MEASURE}`}>
        {section.summary ? <div className="text-body font-medium leading-relaxed text-foreground"><GitSpaceMarkdown>{section.summary}</GitSpaceMarkdown></div> : null}
        <div className="text-body leading-relaxed"><GitSpaceMarkdown>{section.explanation}</GitSpaceMarkdown></div>
        {section.why ? <div className="text-body leading-relaxed text-muted-foreground"><GitSpaceMarkdown>{`**Why.** ${section.why}`}</GitSpaceMarkdown></div> : null}
        {section.callouts?.map((callout, calloutIndex) => <div key={calloutIndex} className="border-l-2 pl-3 text-body leading-relaxed" style={{ borderColor: callout.tone === 'risk' ? badgeColors.amber : callout.tone === 'decision' ? badgeColors.violet : badgeColors.gray }}><GitSpaceMarkdown>{`**${CALLOUT[callout.tone]}** ${callout.text}`}</GitSpaceMarkdown></div>)}
        <SectionDiagram section={section} map={map} />
      </div>
      {section.exhibits.length ? <div className="flex flex-col gap-4">
        <ReadersGuide section={section} number={number} />
        {section.exhibits.map((exhibit) => <div key={exhibit.path} className="flex flex-col gap-2">
          {exhibit.note && !exhibit.ranges?.length ? <div className={`flex items-start gap-1.5 text-caption text-muted-foreground ${MEASURE}`}><span className="mt-1"><Source by="agent" what="this exhibit's note" /></span><div className="min-w-0 flex-1"><GitSpaceMarkdown>{exhibit.note}</GitSpaceMarkdown></div></div> : null}
          <ExhibitDiff exhibit={exhibit} onLoadDiff={onLoadDiff} review={workspace?.review ?? null} since={since} />
        </div>)}
      </div> : <p className={`text-caption text-muted-foreground ${MEASURE}`}>No file exhibits in this section.</p>}
      <div className={`flex flex-col gap-6 ${MEASURE}`}>
        {section.evidence?.length ? <div className="flex flex-col gap-2">
          <PartHeading source={<Source by="agent" what="which runs, commits and files prove this section" />}>Evidence</PartHeading>
          <EvidenceLinks evidence={section.evidence} onOpen={workspace ? workspace.onOpenEvidence : null} />
        </div> : null}
        {workspace ? <SectionRequirements section={section} goal={workspace.goal} onSetAcceptance={workspace.onSetAcceptance} readOnly={workspace.readOnly} /> : null}
        {workspace && section.asks?.length && (workspace.staging || workspace.relate?.workspaces.length) ? <div className="flex flex-col gap-2">
          <PartHeading source={<Source by="agent" what="this section's follow-ups" />}>Follow-ups</PartHeading>
          <ul className="flex flex-col gap-4">{section.asks.map((text) => <FollowUp key={text} text={text} section={section} number={number} workspace={workspace} />)}</ul>
        </div> : section.asks?.length ? <div className="flex flex-col gap-2">
          <PartHeading source={<Source by="agent" what="this section's follow-ups" />}>Follow-ups</PartHeading>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body">{section.asks.map((text) => <li key={text}>{text}</li>)}</ul>
        </div> : null}
        {onReadNext ? <div><button type="button" disabled={read} onClick={onReadNext} className="flex items-center gap-1.5 text-caption font-medium text-foreground hover:underline disabled:text-muted-foreground disabled:no-underline">{read ? <><Check width={13} height={13} />Read</> : 'Mark read and continue →'}</button></div> : null}
      </div>
    </div> : null}
  </section>;
}
